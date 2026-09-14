const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { mergeCookieHeaders } = require('../scripts/cookie-jar')
const { sanitizeDiagnosticText } = require('../scripts/diagnostics')
const { buildMetadataPlan, isPlaceholderTitle } = require('../scripts/media-metadata')
const { parseFlacBlocks, parseVorbisComment, rewriteFlacTagsBuffer } = require('../scripts/audio-tag-copy')

const projectRoot = path.resolve(__dirname, '..')
const cliPath = path.join(projectRoot, 'scripts', 'ncm-cloud.js')

function run(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...options.env },
  })
}

function parseSingleEnvelope(result) {
  const stdout = result.stdout.trim()
  assert.ok(stdout, `expected stdout JSON; stderr=${result.stderr}`)
  return JSON.parse(stdout)
}

test('help returns a versioned JSON command schema', () => {
  const result = run(['help'])
  assert.equal(result.status, 0)
  const envelope = parseSingleEnvelope(result)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.meta.schema_version, '1.0.0')
  assert.ok(envelope.data.commands['match-set'])
})

test('schema progressively discloses one command', () => {
  const result = run(['schema', 'catalog-search'])
  assert.equal(result.status, 0)
  const envelope = parseSingleEnvelope(result)
  assert.deepEqual(Object.keys(envelope.data.commands), ['catalog-search'])
})

test('login runtime status is read-only and does not install Electron', () => {
  const result = run(['login-runtime-status'])
  assert.equal(result.status, 0)
  const envelope = parseSingleEnvelope(result)
  assert.equal(envelope.ok, true)
  const expectedEngine = process.platform === 'win32'
    ? 'webview2'
    : process.platform === 'darwin' ? 'wkwebview' : 'unavailable'
  assert.equal(envelope.data.nativeEngine, expectedEngine)
  if (process.platform === 'win32') {
    assert.equal(envelope.data.nativeHelperPackaged, true)
  } else if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    assert.equal(envelope.data.nativeHelperPackaged, false)
  } else {
    const helper = path.join(projectRoot, 'scripts', 'native', `macos-${process.arch}`, 'NeteaseWebViewLogin')
    assert.equal(envelope.data.nativeHelperPackaged, fs.existsSync(helper))
  }
  assert.equal(typeof envelope.data.electronFallbackCached, 'boolean')
})

test('generic embedded track titles fall back to the meaningful filename', () => {
  const plan = buildMetadataPlan(path.join('Music', '爱琴海 - 周杰伦.flac'), {
    title: 'track 07',
    artist: '周杰伦',
    album: '太阳之子',
  })
  assert.equal(isPlaceholderTitle('track 07'), true)
  assert.equal(plan.title, '爱琴海')
  assert.equal(plan.titleSource, 'filename_placeholder_fallback')
  assert.equal(plan.placeholderTitle, true)
})

test('meaningful title conflicts are reported without silently overwriting tags', () => {
  const plan = buildMetadataPlan(path.join('Music', '文件名歌曲 - 歌手.mp3'), {
    title: '标签歌曲',
    artist: '歌手',
  })
  assert.equal(plan.title, '标签歌曲')
  assert.equal(plan.titleConflict, true)
})

test('embedded cover and timed lyrics form a complete unmatched-playback fallback', () => {
  const plan = buildMetadataPlan(path.join('Music', '歌曲 - 歌手.mp3'), {
    title: '歌曲',
    artist: '歌手',
    picture: [{ format: 'image/webp', data: Buffer.alloc(12) }],
    lyrics: [{ text: '[00:01.00]第一句' }],
  })
  assert.deepEqual(plan.embeddedCover, {
    present: true,
    count: 1,
    formats: ['image/webp'],
    bytes: 12,
  })
  assert.equal(plan.embeddedLyrics.timed, true)
  assert.equal(plan.embeddedMediaFallback, 'complete')
})

test('explicit metadata override wins over embedded and filename titles', () => {
  const plan = buildMetadataPlan(path.join('Music', 'track 07.flac'), { title: 'track 07' }, { title: '爱琴海' })
  assert.equal(plan.title, '爱琴海')
  assert.equal(plan.titleSource, 'override')
  assert.equal(plan.metadataRewriteRequired, true)
})

test('prepared-copy suffix does not create a false title conflict', () => {
  const plan = buildMetadataPlan(path.join('Music', '西西里 - 周杰伦 (云盘标签修正-deadbeef).flac'), {
    title: '西西里',
    artist: '周杰伦',
    album: '太阳之子',
  })
  assert.equal(plan.filenameTitle, '西西里')
  assert.equal(plan.titleConflict, false)
  assert.equal(plan.metadataRewriteRequired, false)
})

test('FLAC tag rewrite preserves picture metadata and audio frames', () => {
  const field = (value) => {
    const data = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(data.length)
    return Buffer.concat([length, data])
  }
  const vendor = field('test-vendor')
  const comments = ['TITLE=track 02', 'ARTIST=周杰伦', 'ALBUM=太阳之子', 'LYRICS=[00:01.00]歌词']
  const count = Buffer.alloc(4)
  count.writeUInt32LE(comments.length)
  const vorbis = Buffer.concat([vendor, count, ...comments.map(field)])
  const block = (type, data, last = false) => {
    const header = Buffer.alloc(4)
    header[0] = (last ? 0x80 : 0) | type
    header.writeUIntBE(data.length, 1, 3)
    return Buffer.concat([header, data])
  }
  const picture = Buffer.from('picture-data')
  const audio = Buffer.from('audio-frame-data')
  const input = Buffer.concat([
    Buffer.from('fLaC'),
    block(0, Buffer.alloc(34)),
    block(4, vorbis),
    block(6, picture, true),
    audio,
  ])
  const output = rewriteFlacTagsBuffer(input, { title: '西西里', artist: '周杰伦', album: '太阳之子' })
  const parsed = parseFlacBlocks(output)
  const rewrittenComments = parseVorbisComment(parsed.blocks.find((item) => item.type === 4).data).comments
  assert.ok(rewrittenComments.includes('TITLE=西西里'))
  assert.ok(!rewrittenComments.includes('TITLE=track 02'))
  assert.ok(rewrittenComments.includes('LYRICS=[00:01.00]歌词'))
  assert.deepEqual(parsed.blocks.find((item) => item.type === 6).data, picture)
  assert.deepEqual(output.subarray(parsed.audioOffset), audio)
})

test('macOS build script maps Intel architecture to the Node x64 directory', () => {
  const buildScript = fs.readFileSync(path.join(projectRoot, 'scripts', 'native', 'build.sh'), 'utf8')
  assert.match(buildScript, /x86_64\)[\s\S]*NODE_ARCH="x64"/)
  assert.match(buildScript, /macos-\$\{NODE_ARCH\}/)
  assert.match(buildScript, /apple-macosx12\.0/)
})

test('mutations require explicit confirmation', () => {
  const result = run(['match-set', '3435156672', '1973665667'])
  assert.equal(result.status, 3)
  const envelope = parseSingleEnvelope(result)
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'confirmation_required')
})

test('dry-run does not require authentication or mutate remote state', () => {
  const result = run(['match-set', '3435156672', '1973665667', '--dry-run'])
  assert.equal(result.status, 0)
  const envelope = parseSingleEnvelope(result)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.data.dryRun, true)
})

test('web QR cookie context is merged without Set-Cookie attributes', () => {
  const cookie = mergeCookieHeaders(
    ['NMTID=initial; Path=/; HttpOnly', '_ntes_nuid=device; Path=/'],
    'NMTID=updated; MUSIC_U=session-token; Max-Age=100; Path=/',
  )
  assert.equal(cookie, 'NMTID=updated; _ntes_nuid=device; MUSIC_U=session-token')
})

test('login diagnostics redact credentials and retain useful failure details', () => {
  const diagnostic = sanitizeDiagnosticText([
    'request https://user:secret@example.test/download failed',
    'MUSIC_U=private-session; token=private-token',
    'npm ERR! connect ETIMEDOUT 203.0.113.1:443',
  ].join('\n'))

  assert.equal(diagnostic.includes('secret'), false)
  assert.equal(diagnostic.includes('private-session'), false)
  assert.equal(diagnostic.includes('private-token'), false)
  assert.match(diagnostic, /ETIMEDOUT/)
})

test('logout archives browser profiles so the next login starts clean', () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-logout-test-'))
  const stateDir = path.join(localAppData, 'netease-cloud-uploader')
  const webViewProfile = path.join(stateDir, 'webview2-profile')
  const electronProfile = path.join(stateDir, 'electron-profile')
  try {
    fs.mkdirSync(webViewProfile, { recursive: true })
    fs.mkdirSync(electronProfile, { recursive: true })
    fs.writeFileSync(path.join(webViewProfile, 'cookie-state'), 'test-only')
    fs.writeFileSync(path.join(electronProfile, 'cookie-state'), 'test-only')

    const result = run(['logout'], { env: { LOCALAPPDATA: localAppData } })
    assert.equal(result.status, 0)
    const envelope = parseSingleEnvelope(result)
    assert.equal(envelope.ok, true)
    assert.equal(envelope.data.browserProfilesRemoved, 2)
    assert.equal(fs.existsSync(webViewProfile), false)
    assert.equal(fs.existsSync(electronProfile), false)
    for (const backupPath of envelope.data.browserProfileBackups) {
      assert.equal(fs.existsSync(backupPath), true)
    }
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true })
  }
})
