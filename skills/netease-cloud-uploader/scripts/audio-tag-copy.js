const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const NodeID3 = require('node-id3')

const VORBIS_COMMENT_TYPE = 4
const PICTURE_TYPE = 6

function readUInt24BE(buffer, offset) {
  return buffer.readUIntBE(offset, 3)
}

function writeUInt24BE(value) {
  const buffer = Buffer.alloc(3)
  buffer.writeUIntBE(value, 0, 3)
  return buffer
}

function parseFlacBlocks(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'fLaC') {
    throw new Error('Not a FLAC file')
  }
  const blocks = []
  let offset = 4
  let sawLast = false
  while (!sawLast) {
    if (offset + 4 > buffer.length) throw new Error('Invalid FLAC metadata header')
    const first = buffer[offset]
    sawLast = Boolean(first & 0x80)
    const type = first & 0x7f
    const length = readUInt24BE(buffer, offset + 1)
    const dataStart = offset + 4
    const dataEnd = dataStart + length
    if (dataEnd > buffer.length) throw new Error('Invalid FLAC metadata block length')
    blocks.push({ type, data: buffer.subarray(dataStart, dataEnd) })
    offset = dataEnd
  }
  return { blocks, audioOffset: offset }
}

function parseVorbisComment(data) {
  let offset = 0
  const readField = () => {
    if (offset + 4 > data.length) throw new Error('Invalid Vorbis comment field length')
    const length = data.readUInt32LE(offset)
    offset += 4
    if (offset + length > data.length) throw new Error('Invalid Vorbis comment field')
    const value = data.subarray(offset, offset + length)
    offset += length
    return value
  }
  const vendor = readField()
  if (offset + 4 > data.length) throw new Error('Invalid Vorbis comment count')
  const count = data.readUInt32LE(offset)
  offset += 4
  const comments = []
  for (let index = 0; index < count; index += 1) {
    comments.push(readField().toString('utf8'))
  }
  return { vendor, comments }
}

function encodeVorbisComment(vendor, comments) {
  const parts = []
  const addField = (value) => {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(data.length)
    parts.push(length, data)
  }
  addField(vendor)
  const count = Buffer.alloc(4)
  count.writeUInt32LE(comments.length)
  parts.push(count)
  for (const comment of comments) addField(comment)
  return Buffer.concat(parts)
}

function updateVorbisComments(data, metadata, edits = {}) {
  const parsed = parseVorbisComment(data)
  const replacedKeys = new Set(['TITLE', 'ARTIST', 'ALBUM'])
  if (Object.hasOwn(edits, 'lyrics')) {
    for (const key of ['LYRICS', 'LYRIC', 'UNSYNCEDLYRICS', 'UNSYNCED LYRICS']) replacedKeys.add(key)
  }
  const comments = parsed.comments.filter((comment) => {
    const separator = comment.indexOf('=')
    const key = separator < 0 ? '' : comment.slice(0, separator).toUpperCase()
    return !replacedKeys.has(key)
  })
  for (const [key, value] of [['TITLE', metadata.title], ['ARTIST', metadata.artist], ['ALBUM', metadata.album]]) {
    if (String(value || '').trim()) comments.push(`${key}=${String(value).trim()}`)
  }
  if (Object.hasOwn(edits, 'lyrics')) comments.push(`LYRICS=${edits.lyrics}`)
  return encodeVorbisComment(parsed.vendor, comments)
}

function detectImage(data) {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const bitDepth = data[24]
    const colorType = data[25]
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType] || 0
    return {
      mime: 'image/png',
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
      depth: bitDepth * channels,
    }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = data[offset + 1]
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      const length = data.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > data.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return {
          mime: 'image/jpeg',
          width: data.readUInt16BE(offset + 7),
          height: data.readUInt16BE(offset + 5),
          depth: data[offset + 4] * data[offset + 9],
        }
      }
      offset += 2 + length
    }
    return { mime: 'image/jpeg', width: 0, height: 0, depth: 0 }
  }
  throw new Error('Cover must be a valid JPEG or PNG image')
}

function encodeFlacPicture(cover) {
  const mime = Buffer.from(cover.mime, 'ascii')
  const description = Buffer.alloc(0)
  const header = Buffer.alloc(4 * 8)
  let offset = 0
  header.writeUInt32BE(3, offset); offset += 4
  header.writeUInt32BE(mime.length, offset); offset += 4
  header.writeUInt32BE(description.length, offset); offset += 4
  header.writeUInt32BE(cover.width || 0, offset); offset += 4
  header.writeUInt32BE(cover.height || 0, offset); offset += 4
  header.writeUInt32BE(cover.depth || 0, offset); offset += 4
  header.writeUInt32BE(0, offset); offset += 4
  header.writeUInt32BE(cover.data.length, offset)
  return Buffer.concat([
    header.subarray(0, 8),
    mime,
    header.subarray(8, 12),
    description,
    header.subarray(12),
    cover.data,
  ])
}

function parseFlacPicture(data) {
  let offset = 4
  if (data.length < 32) throw new Error('Invalid FLAC picture block')
  const mimeLength = data.readUInt32BE(offset); offset += 4 + mimeLength
  if (offset + 4 > data.length) throw new Error('Invalid FLAC picture MIME field')
  const descriptionLength = data.readUInt32BE(offset); offset += 4 + descriptionLength
  if (offset + 20 > data.length) throw new Error('Invalid FLAC picture properties')
  offset += 16
  const imageLength = data.readUInt32BE(offset); offset += 4
  if (offset + imageLength > data.length) throw new Error('Invalid FLAC picture data')
  return data.subarray(offset, offset + imageLength)
}

function encodeFlacBlock(type, data, isLast) {
  if (data.length > 0xffffff) throw new Error('FLAC metadata block is too large')
  return Buffer.concat([
    Buffer.from([(isLast ? 0x80 : 0) | type]),
    writeUInt24BE(data.length),
    data,
  ])
}

function rewriteFlacTagsBuffer(input, metadata, edits = {}) {
  const { blocks, audioOffset } = parseFlacBlocks(input)
  let updated = false
  let rewritten = blocks.map((block) => {
    if (block.type !== VORBIS_COMMENT_TYPE || updated) return block
    updated = true
    return { type: block.type, data: updateVorbisComments(block.data, metadata, edits) }
  })
  if (!updated) {
    const vendor = Buffer.from('netease-cloud-uploader', 'utf8')
    rewritten.push({ type: VORBIS_COMMENT_TYPE, data: updateVorbisComments(encodeVorbisComment(vendor, []), metadata, edits) })
  }
  if (edits.cover) {
    rewritten = rewritten.filter((block) => block.type !== PICTURE_TYPE)
    const commentIndex = rewritten.findIndex((block) => block.type === VORBIS_COMMENT_TYPE)
    rewritten.splice(commentIndex + 1, 0, { type: PICTURE_TYPE, data: encodeFlacPicture(edits.cover) })
  }
  const metadataBlocks = rewritten.map((block, index) => encodeFlacBlock(block.type, block.data, index === rewritten.length - 1))
  const audioFrames = input.subarray(audioOffset)
  return Buffer.concat([Buffer.from('fLaC'), ...metadataBlocks, audioFrames])
}

function mp3AudioPayload(buffer) {
  let start = 0
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    const size = ((buffer[6] & 0x7f) << 21)
      | ((buffer[7] & 0x7f) << 14)
      | ((buffer[8] & 0x7f) << 7)
      | (buffer[9] & 0x7f)
    start = 10 + size + (buffer[5] & 0x10 ? 10 : 0)
  }
  let end = buffer.length
  if (end - start >= 128 && buffer.subarray(end - 128, end - 125).toString('ascii') === 'TAG') end -= 128
  return buffer.subarray(start, end)
}

function audioPayloadHash(filePath) {
  const input = fs.readFileSync(filePath)
  const extension = path.extname(filePath).toLowerCase()
  const payload = extension === '.flac'
    ? input.subarray(parseFlacBlocks(input).audioOffset)
    : extension === '.mp3' ? mp3AudioPayload(input) : null
  if (!payload) throw new Error('Media editing currently supports FLAC and MP3 only')
  return crypto.createHash('sha256').update(payload).digest('hex')
}

function loadMediaEdits({ coverPath = '', lyricsPath = '' }) {
  const edits = {}
  if (coverPath) {
    const resolved = path.resolve(coverPath)
    const data = fs.readFileSync(resolved)
    if (data.length === 0 || data.length > 20 * 1024 * 1024) throw new Error('Cover image must be between 1 byte and 20 MB')
    edits.cover = { path: resolved, data, ...detectImage(data) }
  }
  if (lyricsPath) {
    const resolved = path.resolve(lyricsPath)
    const data = fs.readFileSync(resolved)
    if (data.length === 0 || data.length > 2 * 1024 * 1024) throw new Error('Lyrics file must be between 1 byte and 2 MB')
    const text = data.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
    if (!text) throw new Error('Lyrics file is empty')
    edits.lyrics = text
    edits.lyricsPath = resolved
  }
  if (!edits.cover && !Object.hasOwn(edits, 'lyrics')) throw new Error('At least one of --cover=<image> or --lyrics=<lrc> is required')
  return edits
}

function mediaCopyPath(filePath, metadata, edits) {
  const parsed = path.parse(filePath)
  const identity = crypto.createHash('sha256')
    .update(fs.readFileSync(filePath))
    .update([metadata.title, metadata.artist, metadata.album].join('\0'))
  if (edits.cover) identity.update(edits.cover.data)
  if (Object.hasOwn(edits, 'lyrics')) identity.update(edits.lyrics)
  return path.join(parsed.dir, `${parsed.name} (云盘媒体修正-${identity.digest('hex').slice(0, 8)})${parsed.ext}`)
}

function createMediaCopy(filePath, metadata, edits, outputPath = mediaCopyPath(filePath, metadata, edits)) {
  const input = fs.readFileSync(filePath)
  const extension = path.extname(filePath).toLowerCase()
  let rewritten
  if (extension === '.flac') {
    rewritten = rewriteFlacTagsBuffer(input, metadata, edits)
  } else if (extension === '.mp3') {
    const tags = { title: metadata.title, artist: metadata.artist, album: metadata.album }
    if (edits.cover) {
      tags.image = {
        mime: edits.cover.mime,
        type: { id: 3, name: 'front cover' },
        description: '',
        imageBuffer: edits.cover.data,
      }
    }
    if (Object.hasOwn(edits, 'lyrics')) tags.unsynchronisedLyrics = { language: 'eng', text: edits.lyrics }
    rewritten = NodeID3.update(tags, input)
    if (!Buffer.isBuffer(rewritten)) throw new Error('MP3 tag update failed')
  } else {
    throw new Error('Media editing currently supports FLAC and MP3 only')
  }
  const destination = path.resolve(outputPath)
  if (destination === path.resolve(filePath)) throw new Error('Media copy must not overwrite the original file')
  fs.writeFileSync(destination, rewritten, { flag: 'wx' })
  return destination
}

function verifyMediaEdits(filePath, edits) {
  const input = fs.readFileSync(filePath)
  const extension = path.extname(filePath).toLowerCase()
  let coverApplied = !edits.cover
  let lyricsApplied = !Object.hasOwn(edits, 'lyrics')
  if (extension === '.flac') {
    const { blocks } = parseFlacBlocks(input)
    if (edits.cover) {
      coverApplied = blocks
        .filter((block) => block.type === PICTURE_TYPE)
        .some((block) => parseFlacPicture(block.data).equals(edits.cover.data))
    }
    if (Object.hasOwn(edits, 'lyrics')) {
      const comment = blocks.find((block) => block.type === VORBIS_COMMENT_TYPE)
      const lyrics = comment ? parseVorbisComment(comment.data).comments.filter((value) => /^LYRICS=/i.test(value)) : []
      lyricsApplied = lyrics.some((value) => value.slice(value.indexOf('=') + 1).replace(/\r\n/g, '\n').trim() === edits.lyrics)
    }
  } else if (extension === '.mp3') {
    const tags = NodeID3.read(input)
    if (edits.cover) coverApplied = Boolean(tags.image?.imageBuffer?.equals(edits.cover.data))
    if (Object.hasOwn(edits, 'lyrics')) {
      lyricsApplied = String(tags.unsynchronisedLyrics?.text || '').replace(/\r\n/g, '\n').trim() === edits.lyrics
    }
  } else {
    throw new Error('Media editing currently supports FLAC and MP3 only')
  }
  return { coverApplied, lyricsApplied }
}

function correctedCopyPath(filePath, metadata) {
  const parsed = path.parse(filePath)
  const identity = crypto.createHash('sha256')
    .update([metadata.title, metadata.artist, metadata.album].join('\0'))
    .digest('hex')
    .slice(0, 8)
  return path.join(parsed.dir, `${parsed.name} (云盘标签修正-${identity})${parsed.ext}`)
}

function createCorrectedFlacCopy(filePath, metadata, outputPath = correctedCopyPath(filePath, metadata)) {
  const input = fs.readFileSync(filePath)
  const rewritten = rewriteFlacTagsBuffer(input, metadata)
  const destination = path.resolve(outputPath)
  if (destination === path.resolve(filePath)) throw new Error('Corrected metadata copy must not overwrite the original file')
  fs.writeFileSync(destination, rewritten, { flag: 'wx' })
  return destination
}

module.exports = {
  audioPayloadHash,
  correctedCopyPath,
  createCorrectedFlacCopy,
  createMediaCopy,
  detectImage,
  loadMediaEdits,
  mediaCopyPath,
  mp3AudioPayload,
  parseFlacBlocks,
  parseFlacPicture,
  parseVorbisComment,
  rewriteFlacTagsBuffer,
  verifyMediaEdits,
}
