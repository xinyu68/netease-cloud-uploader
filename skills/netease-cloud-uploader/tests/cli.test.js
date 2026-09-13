const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { mergeCookieHeaders } = require('../scripts/cookie-jar')
const { sanitizeDiagnosticText } = require('../scripts/diagnostics')

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
  const expectedEngine = process.platform === 'win32' ? 'webview2' : 'wkwebview'
  assert.equal(envelope.data.nativeEngine, expectedEngine)
  assert.equal(envelope.data.nativeHelperPackaged, true)
  assert.equal(typeof envelope.data.electronFallbackCached, 'boolean')
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
