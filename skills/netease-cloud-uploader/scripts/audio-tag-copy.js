const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const VORBIS_COMMENT_TYPE = 4

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

function updateVorbisComments(data, metadata) {
  const parsed = parseVorbisComment(data)
  const replacedKeys = new Set(['TITLE', 'ARTIST', 'ALBUM'])
  const comments = parsed.comments.filter((comment) => {
    const separator = comment.indexOf('=')
    const key = separator < 0 ? '' : comment.slice(0, separator).toUpperCase()
    return !replacedKeys.has(key)
  })
  for (const [key, value] of [['TITLE', metadata.title], ['ARTIST', metadata.artist], ['ALBUM', metadata.album]]) {
    if (String(value || '').trim()) comments.push(`${key}=${String(value).trim()}`)
  }
  return encodeVorbisComment(parsed.vendor, comments)
}

function encodeFlacBlock(type, data, isLast) {
  if (data.length > 0xffffff) throw new Error('FLAC metadata block is too large')
  return Buffer.concat([
    Buffer.from([(isLast ? 0x80 : 0) | type]),
    writeUInt24BE(data.length),
    data,
  ])
}

function rewriteFlacTagsBuffer(input, metadata) {
  const { blocks, audioOffset } = parseFlacBlocks(input)
  let updated = false
  const rewritten = blocks.map((block) => {
    if (block.type !== VORBIS_COMMENT_TYPE || updated) return block
    updated = true
    return { type: block.type, data: updateVorbisComments(block.data, metadata) }
  })
  if (!updated) {
    const vendor = Buffer.from('netease-cloud-uploader', 'utf8')
    rewritten.push({ type: VORBIS_COMMENT_TYPE, data: updateVorbisComments(encodeVorbisComment(vendor, []), metadata) })
  }
  const metadataBlocks = rewritten.map((block, index) => encodeFlacBlock(block.type, block.data, index === rewritten.length - 1))
  const audioFrames = input.subarray(audioOffset)
  return Buffer.concat([Buffer.from('fLaC'), ...metadataBlocks, audioFrames])
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
  correctedCopyPath,
  createCorrectedFlacCopy,
  parseFlacBlocks,
  parseVorbisComment,
  rewriteFlacTagsBuffer,
}
