const path = require('path')
const fs = require('fs')

function clean(value) {
  return String(value || '').trim()
}

function normalize(value) {
  return clean(value)
    .normalize('NFKC')
    .replace(/[\s_.·•]+/g, '')
    .toLowerCase()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isPlaceholderTitle(value) {
  const title = clean(value)
  if (!title) return false
  return /^(?:(?:track|audio|song|title)[\s_.-]*0*\d+|(?:unknown|untitled)(?:[\s_.-]*(?:track|song|title))?[\s_.-]*0*\d*|未知(?:曲目|歌曲|标题)[\s_.-]*0*\d*)$/i.test(title)
}

function inferTitleFromFilename(filePath, artist = '') {
  let title = path.parse(filePath).name
    .replace(/\s*\(云盘(?:标签|媒体)修正-[0-9a-f]{8}\)\s*$/i, '')
    .trim()
  const artistName = clean(artist)
  if (artistName) {
    title = title.replace(new RegExp(`\\s*[-–—]\\s*${escapeRegExp(artistName)}\\s*$`, 'i'), '').trim()
  }
  return title
}

function lyricText(entry) {
  if (typeof entry === 'string') return entry
  return clean(entry?.text)
}

function hasTimeline(value) {
  return /\[(?:\d{1,3}:)?\d{1,2}[.:]\d{2,3}\]/.test(value)
}

function buildMetadataPlan(filePath, common = {}, overrides = {}) {
  const embeddedTitle = clean(common.title)
  const embeddedArtist = clean(common.artist)
  const embeddedAlbum = clean(common.album)
  const artist = clean(overrides.artist) || embeddedArtist
  const album = clean(overrides.album) || embeddedAlbum
  const filenameTitle = inferTitleFromFilename(filePath, artist)
  const placeholderTitle = isPlaceholderTitle(embeddedTitle)
  const overriddenTitle = clean(overrides.title)
  const title = overriddenTitle || (placeholderTitle ? filenameTitle : embeddedTitle || filenameTitle)
  const titleSource = overriddenTitle
    ? 'override'
    : placeholderTitle ? 'filename_placeholder_fallback' : embeddedTitle ? 'embedded' : 'filename'
  const titleConflict = Boolean(
    embeddedTitle
    && filenameTitle
    && !placeholderTitle
    && normalize(embeddedTitle) !== normalize(filenameTitle),
  )

  const pictures = Array.isArray(common.picture) ? common.picture : []
  const lyrics = (Array.isArray(common.lyrics) ? common.lyrics : [])
    .map(lyricText)
    .filter(Boolean)
  const coverBytes = pictures.reduce((total, picture) => total + (picture?.data?.length || 0), 0)
  const embeddedCover = {
    present: pictures.length > 0,
    count: pictures.length,
    formats: [...new Set(pictures.map((picture) => clean(picture?.format)).filter(Boolean))],
    bytes: coverBytes,
  }
  const embeddedLyrics = {
    present: lyrics.length > 0,
    count: lyrics.length,
    timed: lyrics.some(hasTimeline),
  }
  const embeddedMediaFallback = embeddedCover.present && embeddedLyrics.present
    ? 'complete'
    : embeddedCover.present || embeddedLyrics.present ? 'partial' : 'none'
  const metadataRewriteRequired = title !== embeddedTitle
    || artist !== embeddedArtist
    || album !== embeddedAlbum

  return {
    title,
    artist,
    album,
    embeddedTitle,
    embeddedArtist,
    embeddedAlbum,
    filenameTitle,
    titleSource,
    placeholderTitle,
    titleConflict,
    embeddedCover,
    embeddedLyrics,
    embeddedMediaFallback,
    metadataRewriteRequired,
  }
}

async function inspectAudioMetadata(filePath, overrides = {}) {
  const metadataModule = await import('music-metadata')
  const metadata = await metadataModule.parseFile(filePath)
  const plan = buildMetadataPlan(filePath, metadata.common, overrides)
  if (path.extname(filePath).toLowerCase() === '.flac') {
    const { parseFlacBlocks, parseVorbisComment } = require('./audio-tag-copy')
    const input = fs.readFileSync(filePath)
    const comment = parseFlacBlocks(input).blocks.find((block) => block.type === 4)
    if (comment) {
      const rawLyrics = parseVorbisComment(comment.data).comments
        .filter((value) => /^(?:LYRICS|LYRIC|UNSYNCEDLYRICS|UNSYNCED LYRICS)=/i.test(value))
        .map((value) => value.slice(value.indexOf('=') + 1))
      if (rawLyrics.length > 0) {
        plan.embeddedLyrics.present = true
        plan.embeddedLyrics.count = rawLyrics.length
        plan.embeddedLyrics.timed = rawLyrics.some(hasTimeline)
      }
    }
  }
  return {
    metadata,
    plan,
  }
}

module.exports = {
  buildMetadataPlan,
  inferTitleFromFilename,
  inspectAudioMetadata,
  isPlaceholderTitle,
}
