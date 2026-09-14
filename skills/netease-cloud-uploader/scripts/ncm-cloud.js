#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const { default: axios } = require('axios')
process.env.DOTENV_CONFIG_QUIET = 'true'
const api = require('@neteasecloudmusicapienhanced/api')
const rawRequest = require('@neteasecloudmusicapienhanced/api/util/request')
const createOption = require('@neteasecloudmusicapienhanced/api/util/option')
const { cookieToJson } = require('@neteasecloudmusicapienhanced/api/util')
const { mergeCookieHeaders } = require('./cookie-jar')
const { sanitizeDiagnosticText } = require('./diagnostics')
const { inspectAudioMetadata } = require('./media-metadata')
const {
  audioPayloadHash,
  correctedCopyPath,
  createCorrectedFlacCopy,
  createMediaCopy,
  loadMediaEdits,
  mediaCopyPath,
  verifyMediaEdits,
} = require('./audio-tag-copy')

console.error = (...values) => {
  const message = values.map((value) => {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }).join(' ')
  process.stderr.write(`${JSON.stringify({ event: 'dependency_error', message })}\n`)
}

const stateDir = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  'netease-cloud-uploader',
)
const legacyStateDir = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  'netease-cloud-upload-mvp',
)
const credentialPath = path.join(stateDir, 'session.dpapi')
const legacyCredentialPath = path.join(legacyStateDir, 'session.dpapi')
const webViewProfileDir = path.join(stateDir, 'webview2-profile')
const electronProfileDir = path.join(stateDir, 'electron-profile')
const nativeWebViewExecutable = path.join(__dirname, 'native', 'windows-x64', 'NeteaseWebViewLogin.exe')
const nativeMacOSArchitecture = process.arch === 'arm64' || process.arch === 'x64'
  ? process.arch
  : null
const nativeMacOSExecutable = nativeMacOSArchitecture
  ? path.join(__dirname, 'native', `macos-${nativeMacOSArchitecture}`, 'NeteaseWebViewLogin')
  : null
const electronLoginScript = path.join(__dirname, 'electron-login.js')
const electronVersion = '44.3.0'
const electronRuntimeDir = path.join(stateDir, 'runtime', `electron-${electronVersion}`)
const schemaVersion = '1.0.0'
const finalEvents = new Set([
  'already_logged_in',
  'login_success',
  'logged_in',
  'logged_out',
  'login_runtime_status',
  'cloud_list',
  'cloud_raw',
  'cloud_check_v2',
  'cloud_import',
  'whale_upload_success',
  'ncmctl_upload_success',
  'upload_success',
  'match_test_success',
  'catalog_search',
  'match_inspect',
  'match_set_success',
  'unmatch_success',
  'file_info',
  'media_copy',
  'cloud_enrich_success',
  'cloud_delete_success',
  'schema',
  'dry_run',
])

function emit(event, data = {}) {
  const payload = { event, ...data }
  if (event === 'not_logged_in' || event === 'session_expired') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        code: 'auth_required',
        message: event === 'not_logged_in' ? 'Not logged in' : 'Saved session has expired',
        retryable: false,
      },
      meta: { schema_version: schemaVersion },
    })}\n`)
    return
  }
  if (finalEvents.has(event)) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      data: payload,
      meta: { schema_version: schemaVersion },
    })}\n`)
    return
  }
  process.stderr.write(`${JSON.stringify(payload)}\n`)
}

function fail(message, details) {
  const text = String(message || details?.message || details?.msg || 'Unknown error')
  const authError = /not logged in|session has expired|login failed/i.test(text)
  const validationError = /usage:|not a file|safety check failed|missing|required|metadata conflict/i.test(text)
  const code = authError ? 'auth_required' : validationError ? 'validation_error' : 'runtime_error'
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code,
      message: text,
      retryable: !validationError && !authError,
      ...(details ? { details } : {}),
    },
    meta: { schema_version: schemaVersion },
  })}\n`)
  process.exitCode = authError ? 2 : validationError ? 3 : 1
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true })
}

function runDpapi(mode, value) {
  const protect = mode === 'protect'
  if (process.platform !== 'win32') {
    // macOS and other platforms: no DPAPI. The credential file is written
    // with 0o600 permissions and only ever read back by the same user.
    return protect
      ? Buffer.from(value, 'utf8').toString('base64')
      : Buffer.from(value, 'base64').toString('utf8')
  }

  const script = protect
    ? "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)"
    : "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($p)"

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: value, encoding: 'utf8', windowsHide: true },
  )
  if (result.status !== 0) {
    throw new Error(`DPAPI ${mode} failed: ${String(result.stderr).trim()}`)
  }
  return result.stdout.trim()
}

function loadCookie() {
  const resolvedPath = fs.existsSync(credentialPath)
    ? credentialPath
    : fs.existsSync(legacyCredentialPath) ? legacyCredentialPath : null
  if (!resolvedPath) return null
  return runDpapi('unprotect', fs.readFileSync(resolvedPath, 'utf8'))
}

function responseBody(response) {
  return response && response.body ? response.body : response
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function withRetry(operation, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      emit('request_retry', { attempt, code: error?.body?.code || error?.code || null })
      await sleep(1000 * attempt)
    }
  }
  throw lastError
}

function requestWeapi(cookie, route, data, domain) {
  const query = { cookie: cookieToJson(cookie), domain }
  return rawRequest(route, data, createOption(query, 'weapi'))
}

function extractProfile(response) {
  const body = responseBody(response) || {}
  return body.data?.profile || body.profile || body.account || null
}

async function verifyCookie(cookie) {
  const response = await withRetry(() => api.login_status({ cookie, timestamp: Date.now() }))
  const profile = extractProfile(response)
  return { response, profile }
}

async function login() {
  const savedCookie = loadCookie()
  if (savedCookie) {
    try {
      const { profile } = await verifyCookie(savedCookie)
      if (profile?.userId) {
        emit('already_logged_in', { nickname: profile.nickname, userId: profile.userId })
        return
      }
    } catch (_) {
      // Continue to interactive login when the saved session is invalid.
    }
  }

  // Native browser login (packaged helper): WebView2 on Windows, WKWebView on macOS.
  // Electron remains the fallback. On other platforms Electron is used directly.
  const isWindows = process.platform === 'win32'
  const isMacOS = process.platform === 'darwin'
  const nativeExecutable = isWindows ? nativeWebViewExecutable : isMacOS ? nativeMacOSExecutable : null
  const nativeAvailable = Boolean(nativeExecutable && fs.existsSync(nativeExecutable))
  const forceElectron = process.env.NCM_LOGIN_FORCE_ELECTRON === '1'

  if (!nativeAvailable || forceElectron) {
    emit('login_fallback', {
      from: isWindows ? 'webview2' : isMacOS ? 'wkwebview' : 'none',
      to: 'electron',
      reason: forceElectron
        ? 'Electron fallback was explicitly forced for diagnostics'
        : !isWindows && !isMacOS
          ? `Native browser login is not packaged for ${process.platform}; using Electron`
          : `The packaged ${isWindows ? 'WebView2' : 'WKWebView'} login helper is missing; using Electron`,
    })
  } else {
    const nativeResult = isWindows ? runNativeWebViewLogin() : runNativeMacOSLogin()
    if (nativeResult.status === 0) return finishBrowserLogin(isWindows ? 'webview2' : 'wkwebview')
    if (nativeResult.status === 11) throw new Error('Login window was closed before authentication completed')
    emit('login_fallback', {
      from: isWindows ? 'webview2' : 'wkwebview',
      to: 'electron',
      reason: nativeResult.reason,
      ...(nativeResult.diagnostic ? { diagnostic: nativeResult.diagnostic } : {}),
    })
  }

  ensureElectronRuntime()
  const electronResult = runElectronLogin()
  if (electronResult.status === 0) return finishBrowserLogin('electron')
  if (electronResult.status === 11) throw new Error('Login window was closed before authentication completed')
  throw new Error(`Electron login failed to start or load the official login page (exit ${electronResult.status ?? 'unknown'})`)
}

function electronExecutablePath() {
  if (process.platform === 'win32') {
    return path.join(electronRuntimeDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
  if (process.platform === 'darwin') {
    return path.join(electronRuntimeDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return path.join(electronRuntimeDir, 'node_modules', 'electron', 'dist', 'electron')
}

function runNativeWebViewLogin() {
  if (!fs.existsSync(nativeWebViewExecutable)) {
    return { status: null, reason: 'The packaged WebView2 login helper is missing' }
  }
  emit('login_engine_start', { engine: 'webview2' })
  const result = spawnSync(nativeWebViewExecutable, [], {
    encoding: 'utf8',
    windowsHide: false,
    maxBuffer: 1024 * 1024,
  })
  const reasons = {
    10: 'WebView2 Runtime is unavailable or initialization failed',
    12: 'The official login page failed to load in WebView2',
    13: 'WebView2 could not read or encrypt the authenticated session',
  }
  const diagnostic = sanitizeDiagnosticText([
    result.error?.message,
    result.stderr,
  ].filter(Boolean).join('\n'))
  return {
    status: result.status,
    reason: result.error?.message || reasons[result.status] || `WebView2 helper exited with code ${result.status ?? 'unknown'}`,
    ...(diagnostic ? { diagnostic } : {}),
  }
}

function runNativeMacOSLogin() {
  if (!nativeMacOSExecutable || !fs.existsSync(nativeMacOSExecutable)) {
    return { status: null, reason: 'The packaged WKWebView login helper is missing' }
  }
  emit('login_engine_start', { engine: 'wkwebview' })
  const credentialMtimeBefore = credentialModifiedAt()
  const result = spawnSync(nativeMacOSExecutable, [], {
    encoding: 'utf8',
    env: { ...process.env, NCM_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  })
  const reasons = {
    10: 'WKWebView is unavailable or initialization failed',
    12: 'The official login page failed to load in WKWebView',
    13: 'WKWebView could not read or save the authenticated session',
  }
  const diagnostic = sanitizeDiagnosticText([
    result.error?.message,
    result.stderr,
  ].filter(Boolean).join('\n'))
  let status = result.status
  // 兼容修复前随仓库发布的 arm64 帮助程序：旧程序使用 terminate(_:)，
  // 导航失败或用户关闭窗口时也可能返回 0。未写入新凭证时，根据诊断恢复退出语义。
  if (status === 0 && credentialMtimeBefore === credentialModifiedAt()) {
    status = diagnostic.includes('wkwebview_navigation_failed') ? 12 : 11
  }
  return {
    status,
    reason: result.error?.message || reasons[status] || `WKWebView helper exited with code ${status ?? 'unknown'}`,
    ...(diagnostic ? { diagnostic } : {}),
  }
}

function credentialModifiedAt() {
  try {
    return fs.statSync(credentialPath).mtimeMs
  } catch {
    return null
  }
}

function ensureElectronRuntime() {
  const executable = electronExecutablePath()
  if (fs.existsSync(executable)) return

  ensureStateDir()
  fs.mkdirSync(electronRuntimeDir, { recursive: true })
  emit('electron_runtime_download', {
    version: electronVersion,
    destination: electronRuntimeDir,
    message: 'WebView2 is unavailable; downloading the portable Electron fallback',
  })
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npmEnv = { ...process.env }
  if (process.platform !== 'win32' && !npmEnv.ELECTRON_MIRROR) {
    // electron's postinstall downloads its binary from GitHub, which is
    // unreliable from mainland-China networks. Default to the npmmirror
    // binary mirror unless the caller already chose one explicitly.
    npmEnv.ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
  }
  const result = spawnSync(npmCommand, [
    'install',
    '--prefix', electronRuntimeDir,
    '--no-package-lock',
    '--no-save',
    '--no-audit',
    '--no-fund',
    `electron@${electronVersion}`,
  ], {
    encoding: 'utf8',
    env: npmEnv,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0 || !fs.existsSync(executable)) {
    const diagnostic = sanitizeDiagnosticText([
      result.error?.message,
      result.stderr,
      result.stdout,
    ].filter(Boolean).join('\n'))
    emit('electron_runtime_download_failed', {
      exitCode: result.status,
      ...(diagnostic ? { diagnostic } : {}),
    })
    throw new Error(`Electron fallback download failed (exit ${result.status ?? 'unknown'})${diagnostic ? `: ${diagnostic}` : ''}`)
  }
  emit('electron_runtime_ready', { version: electronVersion, executable })
}

function runElectronLogin() {
  emit('login_engine_start', { engine: 'electron', version: electronVersion })
  const result = spawnSync(electronExecutablePath(), [electronLoginScript], {
    encoding: 'utf8',
    windowsHide: false,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, NCM_STATE_DIR: stateDir },
  })
  return { status: result.status, reason: result.error?.message || '' }
}

async function finishBrowserLogin(method) {
  const cookie = loadCookie()
  if (!cookie || !cookieToJson(cookie).MUSIC_U) {
    throw new Error(`${method} login closed without returning an authenticated session`)
  }
  const { profile } = await verifyCookie(cookie)
  if (!profile?.userId) throw new Error(`${method} returned a session, but login/status did not confirm an account`)
  emit('login_success', {
    nickname: profile.nickname,
    userId: profile.userId,
    credentialPath,
    method,
  })
}

function loginRuntimeStatus() {
  const isWindows = process.platform === 'win32'
  const isMacOS = process.platform === 'darwin'
  const nativeExecutable = isWindows ? nativeWebViewExecutable : isMacOS ? nativeMacOSExecutable : null
  const nativeEngine = isWindows ? 'webview2' : isMacOS ? 'wkwebview' : 'unavailable'
  emit('login_runtime_status', {
    platform: process.platform,
    nativeEngine,
    nativeHelperPackaged: Boolean(nativeExecutable && fs.existsSync(nativeExecutable)),
    electronFallbackVersion: electronVersion,
    electronFallbackCached: fs.existsSync(electronExecutablePath()),
    electronRuntimeDir,
  })
}

async function status() {
  const cookie = loadCookie()
  if (!cookie) {
    emit('not_logged_in')
    process.exitCode = 2
    return
  }
  const { profile } = await verifyCookie(cookie)
  if (!profile?.userId) {
    emit('session_expired')
    process.exitCode = 2
    return
  }
  emit('logged_in', { nickname: profile.nickname, userId: profile.userId })
}

async function logout() {
  const cookie = loadCookie()
  let remoteCode = null
  let remoteError = null
  if (cookie) {
    try {
      const response = await withRetry(() => api.logout({
        cookie,
        timestamp: Date.now(),
      }))
      remoteCode = Number(responseBody(response)?.code) || null
    } catch (error) {
      remoteError = error.message
      emit('logout_remote_failed', { message: remoteError })
    }
  }

  const timestamp = Date.now()
  const credentialBackups = []
  for (const sourcePath of [credentialPath, legacyCredentialPath]) {
    if (!fs.existsSync(sourcePath)) continue
    const backupPath = `${sourcePath}.logged-out-${timestamp}.bak`
    fs.renameSync(sourcePath, backupPath)
    credentialBackups.push(backupPath)
  }

  const browserProfileBackups = []
  const profileArchiveErrors = []
  for (const sourcePath of [webViewProfileDir, electronProfileDir]) {
    if (!fs.existsSync(sourcePath)) continue
    const backupPath = `${sourcePath}.logged-out-${timestamp}.bak`
    try {
      fs.renameSync(sourcePath, backupPath)
      browserProfileBackups.push(backupPath)
    } catch (error) {
      profileArchiveErrors.push({ path: sourcePath, message: error.message })
      emit('logout_profile_archive_failed', { path: sourcePath, message: error.message })
    }
  }

  if (profileArchiveErrors.length > 0) {
    throw new Error(`Logout incomplete: browser login profiles could not be archived: ${profileArchiveErrors.map((item) => item.path).join(', ')}`)
  }

  emit('logged_out', {
    remoteCode,
    remoteError,
    localCredentialsRemoved: credentialBackups.length,
    credentialBackups,
    browserProfilesRemoved: browserProfileBackups.length,
    browserProfileBackups,
  })
}

async function cloudList(keyword = '') {
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')
  const response = await api.user_cloud({
    cookie,
    limit: 200,
    offset: 0,
    timestamp: Date.now(),
  })
  const body = responseBody(response) || {}
  const normalizedKeyword = keyword.trim().toLowerCase()
  const songs = (body.data || [])
    .filter((item) => {
      if (!normalizedKeyword) return true
      return [item.songName, item.fileName, item.simpleSong?.name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedKeyword))
    })
    .map((item) => summarizeCloudRecord(item))
  emit('cloud_list', { count: songs.length, songs })
}

async function cloudCheckV2(fileArgument, songIdArgument) {
  if (!fileArgument) throw new Error('Usage: node scripts/ncm-cloud.js cloud-check-v2 <audio-file>')
  const filePath = path.resolve(fileArgument)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')
  const md5 = await hashFile(filePath)
  const { metadata } = await inspectAudioMetadata(filePath)
  const bitrate = Math.round(metadata.format.bitrate || 999000)
  const response = await requestWeapi(
    cookie,
    '/api/cloud/upload/check/v2',
    {
      uploadType: 0,
      songs: JSON.stringify([{
        md5,
        fileSize: stat.size,
        bitrate,
        ...(songIdArgument ? { songId: songIdArgument } : {}),
      }]),
    },
    'https://interface.music.163.com',
  )
  emit('cloud_check_v2', { file: filePath, response: responseBody(response) })
}

async function cloudImport(fileArgument, songIdArgument, metadataOverrides = {}) {
  if (!fileArgument || !songIdArgument) {
    throw new Error('Usage: node scripts/ncm-cloud.js cloud-import <audio-file> <netease-song-id>')
  }
  const filePath = path.resolve(fileArgument)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')

  const { metadata, plan } = await inspectAudioMetadata(filePath, metadataOverrides)
  const md5 = await hashFile(filePath)
  const song = plan.title
  const artist = plan.artist || '未知艺术家'
  const album = plan.album || '未知专辑'
  assertMetadataPlanReady(plan)
  if (plan.metadataRewriteRequired) {
    throw new Error('Metadata rewrite required: cloud-import would reuse the original embedded tags. Use upload so the Skill can create and upload a corrected FLAC copy')
  }
  const bitrate = Math.round(metadata.format.bitrate || 999000)
  const fileType = path.extname(filePath).slice(1).toLowerCase() || 'mp3'

  emit('upload_metadata_plan', plan)
  const response = await api.cloud_import({
    cookie,
    md5,
    id: songIdArgument,
    bitrate,
    fileSize: stat.size,
    artist,
    album,
    song,
    fileType,
    timestamp: Date.now(),
  })
  const body = responseBody(response) || {}
  if (![200, 201].includes(Number(body.code))) {
    throw new Error(`Cloud import failed: ${JSON.stringify(body)}`)
  }
  const expectedRecord = { md5, fileSize: stat.size, title: song }
  const record = await waitForUploadedRecord(cookie, expectedRecord)
  verifyUploadedRecord(record, expectedRecord)
  emit('cloud_import', {
    file: filePath,
    response: body,
    record,
    embeddedMediaFallback: plan.embeddedMediaFallback,
  })
}

async function whaleUpload(fileArgument, songIdArgument) {
  if (!fileArgument || !songIdArgument) {
    throw new Error('Usage: node scripts/ncm-cloud.js whale-upload <audio-file> <netease-song-id>')
  }
  const filePath = path.resolve(fileArgument)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')

  const filename = path.basename(filePath)
  const md5 = await hashFile(filePath)
  const bucket = 'jd-musicrep-privatecloud-audio-public'
  const allocResponse = await withRetry(() => requestWeapi(
    cookie,
    '/api/nos/token/whalealloc',
    {
      bizKey: crypto.randomBytes(4).toString('hex'),
      filename,
      bucket,
      md5,
      type: 'audio',
      fileSize: stat.size,
    },
    'https://music.163.com',
  ))
  const allocBody = responseBody(allocResponse) || {}
  const allocation = allocBody.data || allocBody.result
  if (Number(allocBody.code) !== 200 || !allocation?.token || !allocation?.objectKey) {
    throw new Error(`Whale token allocation failed: ${JSON.stringify(allocBody)}`)
  }

  const actualBucket = allocation.bucket || bucket
  emit('whale_token_ready', {
    bucket: actualBucket,
    hasObjectKey: Boolean(allocation.objectKey),
    hasResourceId: Boolean(allocation.resourceId),
  })

  const lbsResponse = await withRetry(() => axios.get(
    `https://wanproxy.127.net/lbs?version=1.0&bucketname=${encodeURIComponent(actualBucket)}`,
    { timeout: 10000, proxy: false },
  ))
  const uploadHost = lbsResponse.data?.upload?.[0]
  if (!uploadHost) throw new Error('NetEase NOS did not return an upload host')
  const objectPath = allocation.objectKey.split('/').map(encodeURIComponent).join('/')
  const uploadUrl = `${uploadHost}/${actualBucket}/${objectPath}?offset=0&complete=true&version=1.0`
  const uploadResponse = await withRetry(() => axios({
    method: 'post',
    url: uploadUrl,
    headers: {
      'x-nos-token': allocation.token,
      'Content-MD5': md5,
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(stat.size),
    },
    data: fs.createReadStream(filePath),
    maxContentLength: Number.POSITIVE_INFINITY,
    maxBodyLength: Number.POSITIVE_INFINITY,
    timeout: 10 * 60 * 1000,
    proxy: false,
  }))
  emit('whale_binary_complete', {
    offset: uploadResponse.data?.offset ?? null,
    errCode: uploadResponse.data?.errCode || uploadResponse.data?.err_code || null,
    hasContext: Boolean(uploadResponse.data?.context),
  })

  const metadataModule = await import('music-metadata')
  const metadata = await metadataModule.parseFile(filePath)
  const song = metadata.common.title || path.parse(filename).name
  const artist = metadata.common.artist || '未知艺术家'
  const album = metadata.common.album || '未知专辑'
  const bitrate = Math.round(metadata.format.bitrate || 999000)
  const ext = path.extname(filename).toLowerCase() || '.mp3'
  const checkResponse = await withRetry(() => requestWeapi(
    cookie,
    '/api/cloud/upload/check',
    {
      bitrate: String(bitrate),
      ext,
      length: String(stat.size),
      md5,
      songId: '0',
      version: '1',
    },
    'https://interface.music.163.com',
  ))
  const checkBody = responseBody(checkResponse) || {}
  if (Number(checkBody.code) !== 200 || !checkBody.songId) {
    throw new Error(`Legacy upload check failed: ${JSON.stringify(checkBody)}`)
  }

  const infoResponse = await withRetry(() => requestWeapi(
    cookie,
    '/api/upload/cloud/info/v2',
    {
      md5,
      songid: checkBody.songId,
      filename,
      song,
      album,
      artist,
      bitrate: String(bitrate),
      resourceId: allocation.resourceId,
    },
    'https://music.163.com',
  ))
  const infoBody = responseBody(infoResponse) || {}
  if (Number(infoBody.code) !== 200 || !infoBody.songId) {
    throw new Error(`Whale cloud metadata failed: ${JSON.stringify(infoBody)}`)
  }

  const cloudSongId = String(infoBody.songId)
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const statusResponse = await withRetry(() => requestWeapi(
      cookie,
      '/api/v1/cloud/music/status',
      { songIds: JSON.stringify([Number(cloudSongId)]) },
      'https://music.163.com',
    ))
    const statusBody = responseBody(statusResponse) || {}
    const conversion = statusBody.statuses?.[cloudSongId]
    const conversionStatus = conversion?.status
    emit('whale_conversion_status', {
      attempt,
      status: conversionStatus ?? null,
      waitTime: conversion?.waitTime ?? null,
    })
    if (Number(conversionStatus) === 9) break
    if (Number(conversionStatus) !== 1) {
      throw new Error(`Unexpected whale cloud conversion status: ${JSON.stringify(conversion)}`)
    }
    if (attempt === 12) {
      throw new Error(`Whale cloud conversion did not complete: ${JSON.stringify(conversion)}`)
    }
    await sleep(5000)
  }

  const publishResponse = await withRetry(() => requestWeapi(
    cookie,
    '/api/cloud/pub/v2',
    { songid: cloudSongId },
    'https://interface.music.163.com',
  ))
  const publishBody = responseBody(publishResponse) || {}
  if (![200, 201].includes(Number(publishBody.code))) {
    throw new Error(`Whale cloud publish failed: ${JSON.stringify(publishBody)}`)
  }
  emit('whale_upload_success', {
    file: filePath,
    songId: cloudSongId,
    code: publishBody.code,
  })
}

async function ncmctlUpload(fileArgument) {
  if (!fileArgument) throw new Error('Usage: node scripts/ncm-cloud.js ncmctl-upload <audio-file>')
  const filePath = path.resolve(fileArgument)
  if (!fs.statSync(filePath).isFile()) throw new Error(`Not a file: ${filePath}`)

  const cookie = loadCookie()
  if (!cookie?.includes('MUSIC_U=')) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')
  const ncmctlPath = 'C:\\Users\\1\\AppData\\Local\\Temp\\ncmctl-v0.8.0\\ncmctl.exe'
  if (!fs.existsSync(ncmctlPath)) throw new Error(`ncmctl executable not found: ${ncmctlPath}`)

  ensureStateDir()
  const temporaryRoot = fs.mkdtempSync(path.join(stateDir, 'ncmctl-'))
  const temporaryHome = path.join(temporaryRoot, 'home')
  const temporaryCookie = path.join(temporaryRoot, 'cookie.txt')
  fs.mkdirSync(temporaryHome, { recursive: true })
  fs.writeFileSync(temporaryCookie, cookie, { encoding: 'utf8', mode: 0o600 })

  try {
    const loginResult = spawnSync(
      ncmctlPath,
      ['--home', temporaryHome, 'login', 'cookie', '--file', temporaryCookie],
      { encoding: 'utf8', windowsHide: true },
    )
    process.stdout.write(loginResult.stdout || '')
    process.stderr.write(loginResult.stderr || '')
    if (loginResult.status !== 0) throw new Error(`ncmctl login failed with exit code ${loginResult.status}`)

    fs.rmSync(temporaryCookie, { force: true })
    emit('ncmctl_upload_start', { file: filePath })
    const uploadResult = spawnSync(
      ncmctlPath,
      ['--home', temporaryHome, 'cloud', '--parallel', '1', filePath],
      { encoding: 'utf8', windowsHide: true },
    )
    process.stdout.write(uploadResult.stdout || '')
    process.stderr.write(uploadResult.stderr || '')
    const combinedOutput = `${uploadResult.stdout || ''}\n${uploadResult.stderr || ''}`
    if (uploadResult.status !== 0 || /failed:\s*[1-9]/i.test(combinedOutput)) {
      throw new Error(`ncmctl upload failed with exit code ${uploadResult.status}`)
    }
    emit('ncmctl_upload_success', { file: filePath })
  } finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot)
    const resolvedStateDir = path.resolve(stateDir)
    if (resolvedTemporaryRoot.startsWith(`${resolvedStateDir}${path.sep}`)) {
      fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true })
    }
  }
}

async function upload(fileArgument, metadataOverrides = {}, outputOptions = {}) {
  if (!fileArgument) throw new Error('Usage: node scripts/ncm-cloud.js upload <audio-file>')
  const filePath = path.resolve(fileArgument)
  const originalStat = fs.statSync(filePath)
  if (!originalStat.isFile()) throw new Error(`Not a file: ${filePath}`)

  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')
  const { profile } = await verifyCookie(cookie)
  if (!profile?.userId) throw new Error('Saved session has expired. Run login again')

  emit('upload_start', {
    file: filePath,
    size: originalStat.size,
    account: profile.nickname,
  })

  const fileName = path.basename(filePath)
  const inspected = await inspectAudioMetadata(filePath, metadataOverrides)
  const plan = inspected.plan
  const song = plan.title
  const artist = plan.artist || '未知艺术家'
  const album = plan.album || '未知专辑'
  assertMetadataPlanReady(plan)
  let uploadPath = filePath
  let preparedCopy = null
  if (plan.metadataRewriteRequired) {
    const extension = path.extname(filePath).toLowerCase()
    if (!['.flac', '.mp3'].includes(extension)) {
      throw new Error('Metadata rewrite required, but automatic lossless tag correction currently supports FLAC and MP3 only')
    }
    const metadata = { title: song, artist, album }
    const destination = extension === '.flac'
      ? correctedCopyPath(filePath, metadata)
      : mediaCopyPath(filePath, metadata, {})
    if (fs.existsSync(destination)) {
      uploadPath = destination
    } else {
      uploadPath = extension === '.flac'
        ? createCorrectedFlacCopy(filePath, metadata, destination)
        : createMediaCopy(filePath, metadata, {}, destination)
    }
    const prepared = await inspectAudioMetadata(uploadPath)
    const durationDelta = Math.abs((prepared.metadata.format.duration || 0) - (inspected.metadata.format.duration || 0))
    const preservedCover = prepared.plan.embeddedCover.count === plan.embeddedCover.count
      && prepared.plan.embeddedCover.bytes === plan.embeddedCover.bytes
    const preservedLyrics = prepared.plan.embeddedLyrics.count === plan.embeddedLyrics.count
    if (prepared.plan.title !== song
      || prepared.plan.artist !== artist
      || prepared.plan.album !== album
      || prepared.plan.metadataRewriteRequired
      || prepared.plan.titleConflict
      || durationDelta > 0.01
      || !preservedCover
      || !preservedLyrics) {
      throw new Error(`Corrected copy verification failed: ${uploadPath}`)
    }
    preparedCopy = uploadPath
    emit('upload_metadata_copy_ready', { originalFile: filePath, preparedFile: uploadPath, title: song, artist, album })
  }
  const stat = fs.statSync(uploadPath)
  const md5 = await hashFile(uploadPath)
  const bitrate = 999000
  const ext = path.extname(fileName).toLowerCase() || '.mp3'

  emit('upload_metadata_plan', plan)
  const checkResponse = await withRetry(() => requestWeapi(
    cookie,
    '/api/cloud/upload/check',
    {
      bitrate: String(bitrate),
      ext,
      length: String(stat.size),
      md5,
      songId: '0',
      version: '1',
    },
    'https://interface.music.163.com',
  ))
  const checkBody = responseBody(checkResponse) || {}
  if (Number(checkBody.code) !== 200 || !checkBody.songId) {
    throw new Error(`Upload check failed: ${JSON.stringify(checkBody)}`)
  }

  const allocResponse = await withRetry(() => requestWeapi(
    cookie,
    '/api/nos/token/alloc',
    {
      bucket: '',
      ext,
      filename: fileName,
      local: 'false',
      nos_product: '3',
      type: 'audio',
      md5,
    },
    'https://music.163.com',
  ))
  const allocBody = responseBody(allocResponse) || {}
  const allocation = allocBody.result
  if (Number(allocBody.code) !== 200 || !allocation?.resourceId || !allocation?.objectKey) {
    throw new Error(`Upload token allocation failed: ${JSON.stringify(allocBody)}`)
  }

  emit('upload_token_ready', { needUpload: Boolean(checkBody.needUpload) })
  if (checkBody.needUpload) {
    const lbsResponse = await withRetry(() => axios.get(
      `https://wanproxy.127.net/lbs?version=1.0&bucketname=${encodeURIComponent(allocation.bucket)}`,
      { timeout: 10000, proxy: false },
    ))
    const uploadHost = lbsResponse.data?.upload?.[0]
    if (!uploadHost) throw new Error('NetEase NOS did not return an upload host')
    const objectPath = allocation.objectKey.split('/').map(encodeURIComponent).join('/')
    const uploadUrl = `${uploadHost}/${allocation.bucket}/${objectPath}?offset=0&complete=true&version=1.0`
    const nosResponse = await withRetry(() => axios({
      method: 'post',
      url: uploadUrl,
      headers: {
        'x-nos-token': allocation.token,
        'Content-MD5': md5,
        'Content-Type': ext === '.flac' ? 'audio/flac' : 'audio/mpeg',
        'Content-Length': String(stat.size),
      },
      data: fs.createReadStream(uploadPath),
      maxContentLength: Number.POSITIVE_INFINITY,
      maxBodyLength: Number.POSITIVE_INFINITY,
      timeout: 10 * 60 * 1000,
      proxy: false,
    }))
    emit('upload_binary_complete', {
      offset: nosResponse.data?.offset ?? null,
      errCode: nosResponse.data?.errCode || nosResponse.data?.err_code || null,
      hasContext: Boolean(nosResponse.data?.context),
    })
  }

  const infoResponse = await withRetry(() => requestWeapi(
    cookie,
    '/api/upload/cloud/info/v2',
    {
      md5,
      songid: checkBody.songId,
      filename: fileName,
      song,
      album,
      artist,
      bitrate: String(bitrate),
      resourceId: allocation.resourceId,
    },
    'https://music.163.com',
  ))
  const infoBody = responseBody(infoResponse) || {}
  if (Number(infoBody.code) !== 200 || !infoBody.songId) {
    throw new Error(`Cloud metadata failed: ${JSON.stringify(infoBody)}`)
  }

  const songId = String(infoBody.songId)
  const conversionAttempts = 10
  for (let attempt = 1; attempt <= conversionAttempts; attempt += 1) {
    const statusResponse = await withRetry(() => requestWeapi(
      cookie,
      '/api/v1/cloud/music/status',
      { songIds: JSON.stringify([Number(songId)]) },
      'https://music.163.com',
    ))
    const statusBody = responseBody(statusResponse) || {}
    const conversion = statusBody.statuses?.[songId]
    const conversionStatus = conversion?.status
    emit('upload_conversion_status', {
      attempt,
      status: conversionStatus ?? null,
      waitTime: conversion?.waitTime ?? null,
    })
    if (Number(conversionStatus) === 9) break
    if (Number(conversionStatus) !== 1) {
      throw new Error(`Unexpected cloud conversion status: ${JSON.stringify(conversion)}`)
    }
    if (attempt === conversionAttempts) {
      throw new Error(`Cloud audio conversion did not complete: ${JSON.stringify(conversion)}`)
    }
    await sleep(30000)
  }

  const publishResponse = await withRetry(() => requestWeapi(
    cookie,
    '/api/cloud/pub/v2',
    { songid: songId },
    'https://interface.music.163.com',
  ))
  const publishBody = responseBody(publishResponse) || {}
  if (![200, 201].includes(Number(publishBody.code))) {
    throw new Error(`Cloud publish failed: ${JSON.stringify(publishBody)}`)
  }
  const expectedRecord = { md5, fileSize: stat.size, title: song }
  const record = await waitForUploadedRecord(cookie, expectedRecord, songId)
  verifyUploadedRecord(record, expectedRecord)
  const result = {
    file: uploadPath,
    originalFile: filePath,
    preparedCopy,
    songId,
    code: publishBody.code,
    record,
    embeddedMediaFallback: plan.embeddedMediaFallback,
    ...(outputOptions.data || {}),
  }
  emit(outputOptions.event || 'upload_success', result)
  return result
}

async function main() {
  const argv = process.argv.slice(2)
  const flags = new Set(argv.filter((value) => value.startsWith('--')))
  const positional = argv.filter((value) => !value.startsWith('--'))
  const [command, argument, secondArgument] = positional
  const mutationOptions = {
    yes: flags.has('--yes'),
    dryRun: flags.has('--dry-run'),
  }
  const metadataOverrides = parseMetadataOverrides(argv)
  const mediaOptions = parseMediaOptions(argv)
  if (!command || command === 'help' || command === '--help') return commandSchema()
  if (command === 'schema') return commandSchema(argument)
  if (command === 'login') return login()
  if (command === 'login-runtime-status') return loginRuntimeStatus()
  if (command === 'status') return status()
  if (command === 'logout') return logout()
  if (command === 'file-info') return fileInfo(argument)
  if (command === 'catalog-search') return catalogSearch(argument, secondArgument)
  if (command === 'cloud-list') return cloudList(argument || '')
  if (command === 'cloud-raw') return cloudRaw(argument || '')
  if (command === 'match-inspect') return matchInspect(argument)
  if (command === 'match-set') return matchSet(argument, secondArgument, mutationOptions)
  if (command === 'unmatch') return unmatchCloudSong(argument, mutationOptions)
  if (command === 'match-test') {
    if (!await allowMutation('match-test', { cloudSongId: argument, expectedCatalogSongId: secondArgument }, mutationOptions)) return
    return cloudMatchTest(argument, secondArgument)
  }
  if (command === 'cloud-check-v2') return cloudCheckV2(argument, secondArgument)
  if (command === 'cloud-import') {
    if (!await allowMutation('cloud-import', { file: argument, catalogSongId: secondArgument, metadataOverrides }, mutationOptions)) return
    return cloudImport(argument, secondArgument, metadataOverrides)
  }
  if (command === 'media-copy') {
    if (!await allowMutation('media-copy', { file: argument, mediaOptions, metadataOverrides }, mutationOptions)) return
    return mediaCopy(argument, mediaOptions, metadataOverrides)
  }
  if (command === 'cloud-enrich') {
    if (!mediaOptions.catalogUnavailable) throw new Error('cloud-enrich requires --catalog-unavailable after catalog matching has been ruled out')
    if (!await allowMutation('cloud-enrich', { cloudRecordId: argument, file: secondArgument, mediaOptions, metadataOverrides }, mutationOptions)) return
    return cloudEnrich(argument, secondArgument, mediaOptions, metadataOverrides)
  }
  if (command === 'cloud-delete') {
    if (!await allowMutation('cloud-delete', { cloudRecordId: argument }, mutationOptions)) return
    return cloudDelete(argument)
  }
  if (command === 'upload') {
    if (!await allowMutation('upload', { file: argument, metadataOverrides }, mutationOptions)) return
    return upload(argument, metadataOverrides)
  }
  throw new Error(`Unknown command: ${command}. Run: node scripts/ncm-cloud.js help`)
}

main().catch((error) => fail(error.message, error.body || error.response?.data))

async function cloudRaw(keyword = '') {
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')
  const response = await api.user_cloud({
    cookie,
    limit: 200,
    offset: 0,
    timestamp: Date.now(),
  })
  const body = responseBody(response) || {}
  const normalizedKeyword = keyword.trim().toLowerCase()
  const songs = (body.data || []).filter((item) => {
    if (!normalizedKeyword) return true
    return [item.songName, item.fileName, item.simpleSong?.name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedKeyword))
  })
  emit('cloud_raw', { count: songs.length, songs })
}

function summarizeCloudRecord(item) {
  const privateCloud = item.privateCloud || item.simpleSong?.privilege?.pc || {}
  const originalAudioSongId = privateCloud.originalAudioSongId || item.simpleSong?.s_id || null
  return {
    pcId: privateCloud.id == null
      ? (item.pcId == null ? null : String(item.pcId))
      : String(privateCloud.id),
    originalAudioSongId: originalAudioSongId == null ? null : String(originalAudioSongId),
    recordSongId: item.simpleSong?.id == null ? null : String(item.simpleSong.id),
    catalogSongId: privateCloud.songId == null
      ? (item.simpleSong?.id == null ? null : String(item.simpleSong.id))
      : String(privateCloud.songId),
    matchType: item.matchType || null,
    songName: item.songName || item.simpleSong?.name || '',
    artist: item.artist || item.simpleSong?.ar?.map((artist) => artist.name).join('/') || '',
    album: item.album || item.simpleSong?.al?.name || '',
    fileName: item.fileName || privateCloud.fileName || '',
    fileSize: item.fileSize || privateCloud.fileSize || null,
    md5: privateCloud.md5 || null,
  }
}

function parseMetadataOverrides(argv) {
  const values = {}
  for (const key of ['title', 'artist', 'album']) {
    const prefix = `--${key}=`
    const flag = argv.find((value) => value.startsWith(prefix))
    if (flag) values[key] = flag.slice(prefix.length).trim()
  }
  return values
}

function parseMediaOptions(argv) {
  const value = (name) => {
    const prefix = `--${name}=`
    const flag = argv.find((item) => item.startsWith(prefix))
    return flag ? flag.slice(prefix.length).trim() : ''
  }
  return {
    coverPath: value('cover'),
    lyricsPath: value('lyrics'),
    catalogUnavailable: argv.includes('--catalog-unavailable'),
  }
}

async function buildMediaCopy(fileArgument, mediaOptions, metadataOverrides = {}) {
  if (!fileArgument) throw new Error('Usage: node scripts/ncm-cloud.js media-copy <audio-file> --cover=<image> and/or --lyrics=<lrc> --yes')
  const filePath = path.resolve(fileArgument)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
  const inspected = await inspectAudioMetadata(filePath, metadataOverrides)
  const plan = inspected.plan
  assertMetadataPlanReady(plan)
  const metadata = {
    title: plan.title,
    artist: plan.artist || '未知艺术家',
    album: plan.album || '未知专辑',
  }
  const edits = loadMediaEdits(mediaOptions)
  const destination = mediaCopyPath(filePath, metadata, edits)
  if (!fs.existsSync(destination)) createMediaCopy(filePath, metadata, edits, destination)
  const prepared = await inspectAudioMetadata(destination)
  const durationDelta = Math.abs((prepared.metadata.format.duration || 0) - (inspected.metadata.format.duration || 0))
  const audioUnchanged = audioPayloadHash(filePath) === audioPayloadHash(destination)
  const { coverApplied, lyricsApplied } = verifyMediaEdits(destination, edits)
  if (prepared.plan.title !== metadata.title
    || prepared.plan.artist !== metadata.artist
    || prepared.plan.album !== metadata.album
    || prepared.plan.titleConflict
    || durationDelta > 0.01
    || !audioUnchanged
    || !coverApplied
    || !lyricsApplied) {
    throw new Error(`Media copy verification failed: ${destination}`)
  }
  return {
    originalFile: filePath,
    preparedFile: destination,
    originalMd5: await hashFile(filePath),
    preparedMd5: await hashFile(destination),
    audioPayloadSha256: audioPayloadHash(destination),
    audioUnchanged,
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    coverChanged: Boolean(edits.cover),
    lyricsChanged: Object.hasOwn(edits, 'lyrics'),
    lyricsTimed: Object.hasOwn(edits, 'lyrics') && /\[(?:\d{1,3}:)?\d{1,2}[.:]\d{2,3}\]/.test(edits.lyrics),
  }
}

async function mediaCopy(fileArgument, mediaOptions, metadataOverrides = {}) {
  const result = await buildMediaCopy(fileArgument, mediaOptions, metadataOverrides)
  emit('media_copy', result)
  return result
}

async function cloudEnrich(cloudRecordIdArgument, fileArgument, mediaOptions, metadataOverrides = {}) {
  if (!cloudRecordIdArgument || !fileArgument) {
    throw new Error('Usage: node scripts/ncm-cloud.js cloud-enrich <cloudRecordId> <local-audio-file> --cover=<image> and/or --lyrics=<lrc> --catalog-unavailable --yes')
  }
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')
  const sourceItem = await findCloudRecord(cookie, cloudRecordIdArgument)
  if (!sourceItem) throw new Error(`Cloud record not found: ${cloudRecordIdArgument}`)
  const sourceRecord = summarizeCloudRecord(sourceItem)
  const sourceIsMatched = sourceRecord.matchType === 'matched'
    || (sourceRecord.catalogSongId && sourceRecord.originalAudioSongId && sourceRecord.catalogSongId !== sourceRecord.originalAudioSongId)
  if (sourceIsMatched) {
    throw new Error(`Cloud record ${sourceRecord.pcId} is catalog matched. Correct or remove that association before embedded-media enrichment`)
  }
  const localMd5 = await hashFile(path.resolve(fileArgument))
  if (sourceRecord.md5 && sourceRecord.md5 !== localMd5) {
    throw new Error(`Local file MD5 ${localMd5} does not match cloud record MD5 ${sourceRecord.md5}`)
  }
  const prepared = await buildMediaCopy(fileArgument, mediaOptions, metadataOverrides)
  return upload(prepared.preparedFile, {}, {
    event: 'cloud_enrich_success',
    data: {
      enrichment: prepared,
      sourceCloudRecord: sourceRecord,
      oldCloudRecordPreserved: true,
    },
  })
}

async function cloudDelete(cloudRecordIdArgument) {
  if (!cloudRecordIdArgument) throw new Error('Usage: node scripts/ncm-cloud.js cloud-delete <cloudRecordId> --yes')
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')
  const sourceItem = await findCloudRecord(cookie, cloudRecordIdArgument)
  if (!sourceItem) throw new Error(`Cloud record not found: ${cloudRecordIdArgument}`)
  const sourceRecord = summarizeCloudRecord(sourceItem)
  const deleteSongId = sourceRecord.originalAudioSongId || sourceRecord.recordSongId
  if (!deleteSongId) throw new Error(`Cloud record ${sourceRecord.pcId} has no deletable song ID`)
  const response = await api.user_cloud_del({ cookie, id: deleteSongId, timestamp: Date.now() })
  const body = responseBody(response) || {}
  if (Number(body.code) !== 200) throw new Error(`Cloud delete failed: ${JSON.stringify(body)}`)
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const remaining = await findCloudRecord(cookie, sourceRecord.pcId)
    if (!remaining) {
      emit('cloud_delete_success', { deleted: sourceRecord })
      return
    }
    await sleep(2000)
  }
  throw new Error(`Cloud delete returned success but record ${sourceRecord.pcId} is still present`)
}

function assertMetadataPlanReady(plan) {
  if (plan.titleConflict && plan.titleSource !== 'override') {
    throw new Error(`Metadata conflict: embedded title "${plan.embeddedTitle}" differs from filename title "${plan.filenameTitle}". Confirm the intended title and pass --title=<title>`)
  }
}

async function findCloudRecordByMd5(cookie, md5) {
  const pageSize = 200
  for (let offset = 0; offset < 2000; offset += pageSize) {
    const response = await withRetry(() => api.user_cloud({
      cookie,
      limit: pageSize,
      offset,
      timestamp: Date.now(),
    }))
    const body = responseBody(response) || {}
    const data = body.data || []
    const match = data.find((item) => summarizeCloudRecord(item).md5 === md5)
    if (match) return match
    if (!body.hasMore || data.length < pageSize) break
  }
  return null
}

function uploadedRecordMismatches(record, expected) {
  const mismatches = []
  if (record.md5 !== expected.md5) mismatches.push(`MD5 ${record.md5 || 'missing'}`)
  if (Number(record.fileSize) !== Number(expected.fileSize)) mismatches.push(`size ${record.fileSize || 'missing'}`)
  if (String(record.songName || '').trim() !== String(expected.title || '').trim()) {
    mismatches.push(`title "${record.songName || ''}" instead of "${expected.title || ''}"`)
  }
  return mismatches
}

async function waitForUploadedRecord(cookie, expected, cloudSongId = null) {
  let latest = null
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      latest = cloudSongId
        ? await findCloudRecord(cookie, cloudSongId)
        : await findCloudRecordByMd5(cookie, expected.md5)
    } catch (_) {
      latest = await findCloudRecordByMd5(cookie, expected.md5)
    }
    if (latest) {
      const summary = summarizeCloudRecord(latest)
      if (uploadedRecordMismatches(summary, expected).length === 0) return summary
    }
    await sleep(2000)
  }
  if (latest) return summarizeCloudRecord(latest)
  throw new Error(`Cloud write completed but no record appeared for MD5 ${expected.md5}`)
}

function verifyUploadedRecord(record, expected) {
  const mismatches = uploadedRecordMismatches(record, expected)
  if (mismatches.length > 0) {
    throw new Error(`Cloud write completed but metadata verification failed for pcId ${record.pcId || 'unknown'}: ${mismatches.join(', ')}`)
  }
}

async function findCloudRecord(cookie, cloudRecordId) {
  const targetId = String(cloudRecordId)
  const pageSize = 200
  for (let offset = 0; offset < 2000; offset += pageSize) {
    const response = await withRetry(() => api.user_cloud({
      cookie,
      limit: pageSize,
      offset,
      timestamp: Date.now(),
    }))
    const body = responseBody(response) || {}
    const data = body.data || []
    const match = data.find((item) => {
      const summary = summarizeCloudRecord(item)
      return summary.originalAudioSongId === targetId || summary.pcId === targetId || summary.recordSongId === targetId
    })
    if (match) return match
    if (!body.hasMore || data.length < pageSize) break
  }
  throw new Error(`Cloud song not found by originalAudioSongId or pcId: ${targetId}`)
}

async function setCloudMatch(cookie, userId, originalAudioSongId, catalogSongId) {
  const response = await withRetry(() => api.cloud_match({
    cookie,
    uid: String(userId),
    sid: String(originalAudioSongId),
    asid: String(catalogSongId),
    timestamp: Date.now(),
  }))
  const body = responseBody(response) || {}
  if (Number(body.code) !== 200) {
    throw new Error(`Cloud match failed: ${JSON.stringify(body)}`)
  }
  return body
}

async function waitForCloudMatch(cookie, cloudRecordId, predicate, label) {
  let latest = null
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    latest = summarizeCloudRecord(await findCloudRecord(cookie, cloudRecordId))
    emit('match_test_poll', { label, attempt, record: latest })
    if (predicate(latest)) return latest
    if (attempt < 10) await sleep(2000)
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`)
}

async function cloudMatchTest(originalAudioSongIdArgument, expectedCatalogSongIdArgument) {
  if (!originalAudioSongIdArgument) {
    throw new Error('Usage: node scripts/ncm-cloud.js match-test <original-audio-song-id> [expected-catalog-song-id]')
  }
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run: node scripts/ncm-cloud.js login')
  const { profile } = await verifyCookie(cookie)
  if (!profile?.userId) throw new Error('Saved session has expired. Run login again')

  const originalAudioSongId = String(originalAudioSongIdArgument)
  const before = summarizeCloudRecord(await findCloudRecord(cookie, originalAudioSongId))
  if (!before.pcId || !before.recordSongId) throw new Error('The selected cloud song has no stable record identifier')
  if (!before.catalogSongId) throw new Error('The selected cloud song has no restorable catalog song ID')
  if (expectedCatalogSongIdArgument && before.catalogSongId !== String(expectedCatalogSongIdArgument)) {
    throw new Error(`Safety check failed: current catalog ID is ${before.catalogSongId}, expected ${expectedCatalogSongIdArgument}`)
  }

  ensureStateDir()
  const backupPath = path.join(stateDir, `match-test-${originalAudioSongId}-${Date.now()}.json`)
  fs.writeFileSync(backupPath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    userId: String(profile.userId),
    before,
  }, null, 2)}\n`, 'utf8')
  emit('match_test_backup', { path: backupPath, before })

  let testError = null
  let unmatched = null
  let restored = null
  try {
    const unmatchResponse = await setCloudMatch(cookie, profile.userId, before.recordSongId, 0)
    emit('match_test_unmatch_requested', { response: unmatchResponse })
    unmatched = await waitForCloudMatch(
      cookie,
      before.pcId,
      (record) => record.matchType !== 'matched' || record.catalogSongId !== before.catalogSongId,
      'unmatched state',
    )
  } catch (error) {
    testError = error
    emit('match_test_error_before_restore', { message: error.message })
  } finally {
    let restoreError = null
    try {
      const restoreResponse = await setCloudMatch(
        cookie,
        profile.userId,
        unmatched?.recordSongId || before.recordSongId,
        before.catalogSongId,
      )
      emit('match_test_restore_requested', { response: restoreResponse })
      restored = await waitForCloudMatch(
        cookie,
        before.pcId,
        (record) => record.catalogSongId === before.catalogSongId && record.matchType === 'matched',
        'restored state',
      )
    } catch (error) {
      restoreError = error
    }
    if (restoreError) {
      throw new Error(`RESTORE FAILED. Original catalog ID was ${before.catalogSongId}. ${restoreError.message}`)
    }
  }

  if (testError) throw testError
  const audioUnchanged = before.md5 === restored.md5 && before.fileSize === restored.fileSize
  if (!audioUnchanged) throw new Error('Cloud association was restored, but audio identity changed unexpectedly')
  emit('match_test_success', {
    originalAudioSongId,
    originalCatalogSongId: before.catalogSongId,
    unmatchedVerified: Boolean(unmatched),
    restored: true,
    audioUnchanged,
    backupPath,
  })
}

async function allowMutation(command, wouldRequest, options) {
  if (options.dryRun) {
    emit('dry_run', { dryRun: true, command, wouldRequest })
    return false
  }
  if (options.yes) return true
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: 'confirmation_required',
      message: `The ${command} command changes NetEase Cloud Music state. Pass --yes after the user confirms the exact target.`,
      retryable: false,
    },
    meta: { schema_version: schemaVersion },
  })}\n`)
  process.exitCode = 3
  return false
}

function commandSchema(method = '') {
  const commands = {
    login: { mutation: 'auth', params: [], description: 'Open the official NetEase login page in a browser window (packaged WebView2 helper on Windows, packaged WKWebView helper on macOS, Electron fallback on Windows/macOS and anywhere else) and save the authenticated session' },
    'login-runtime-status': { mutation: 'read', params: [], description: 'Report packaged native helper and cached Electron fallback status without opening a login window' },
    status: { mutation: 'read', params: [], description: 'Check the saved login session' },
    logout: { mutation: 'auth', params: [], description: 'Invalidate the current Skill session and archive its encrypted local credential' },
    'file-info': { mutation: 'read', params: ['file'], description: 'Read audio identity and embedded metadata' },
    'media-copy': { mutation: 'local-write', confirmation: '--yes', dryRun: true, params: ['file'], options: ['--cover=<jpeg-or-png>', '--lyrics=<lrc>', '--title=<title>', '--artist=<artist>', '--album=<album>'], description: 'Create and verify a FLAC or MP3 copy with changed embedded cover and/or lyrics without uploading it' },
    'catalog-search': { mutation: 'read', params: ['keywords', 'limit?'], description: 'Search public NetEase catalog candidates' },
    'cloud-list': { mutation: 'read', params: ['keyword?'], description: 'List compact personal cloud-drive records' },
    'match-inspect': { mutation: 'read', params: ['cloudRecordId'], description: 'Inspect one cloud record by pcId, original audio ID, or current song ID' },
    'cloud-check-v2': { mutation: 'read', params: ['file', 'catalogSongId?'], description: 'Check whether the file can be imported without binary upload' },
    'cloud-import': { mutation: 'write', confirmation: '--yes', dryRun: true, params: ['file', 'catalogSongId'], description: 'Import only when embedded metadata needs no rewrite, then verify the resulting cloud record' },
    upload: { mutation: 'write', confirmation: '--yes', dryRun: true, params: ['file'], options: ['--title=<title>', '--artist=<artist>', '--album=<album>'], description: 'Create a corrected FLAC or MP3 copy when needed, upload audio bytes, and verify the resulting cloud record' },
    'cloud-enrich': { mutation: 'write', confirmation: '--yes', dryRun: true, params: ['cloudRecordId', 'localAudioFile'], options: ['--cover=<jpeg-or-png>', '--lyrics=<lrc>', '--catalog-unavailable', '--title=<title>', '--artist=<artist>', '--album=<album>'], description: 'For an unmatched record with no viable catalog match, create and upload a verified embedded-media replacement while preserving the old record' },
    'cloud-delete': { mutation: 'destructive-write', confirmation: '--yes', dryRun: true, params: ['cloudRecordId'], description: 'Delete one exact cloud record and verify its removal; use only after the user separately confirms the replacement' },
    'match-set': { mutation: 'write', confirmation: '--yes', dryRun: true, params: ['cloudRecordId', 'catalogSongIdOrUrl'], description: 'Transactionally correct a cloud record association and verify it' },
    unmatch: { mutation: 'write', confirmation: '--yes', dryRun: true, params: ['cloudRecordId'], description: 'Remove the current public-catalog association' },
  }
  const selected = method ? commands[method] : null
  if (method && !selected) throw new Error(`Unknown schema method: ${method}`)
  emit('schema', {
    schemaVersion,
    method: method || null,
    commands: selected ? { [method]: selected } : commands,
    exitCodes: { success: 0, runtime: 1, auth: 2, validation: 3 },
  })
}

async function fileInfo(fileArgument) {
  if (!fileArgument) throw new Error('Usage: node scripts/ncm-cloud.js file-info <audio-file>')
  const filePath = path.resolve(fileArgument)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
  const { metadata, plan } = await inspectAudioMetadata(filePath)
  emit('file_info', {
    file: filePath,
    size: stat.size,
    md5: await hashFile(filePath),
    format: metadata.format.container || path.extname(filePath).slice(1).toLowerCase(),
    bitrate: Math.round(metadata.format.bitrate || 0),
    durationMs: Math.round((metadata.format.duration || 0) * 1000),
    title: plan.title,
    artist: plan.artist,
    album: plan.album,
    embeddedTitle: plan.embeddedTitle,
    embeddedArtist: plan.embeddedArtist,
    embeddedAlbum: plan.embeddedAlbum,
    filenameTitle: plan.filenameTitle,
    titleSource: plan.titleSource,
    placeholderTitle: plan.placeholderTitle,
    titleConflict: plan.titleConflict,
    embeddedCover: plan.embeddedCover,
    embeddedLyrics: plan.embeddedLyrics,
    embeddedMediaFallback: plan.embeddedMediaFallback,
    metadataRewriteRequired: plan.metadataRewriteRequired,
  })
}

async function catalogSearch(keywordArgument, limitArgument = '10') {
  const keywords = String(keywordArgument || '').trim()
  if (!keywords) throw new Error('Usage: node scripts/ncm-cloud.js catalog-search <keywords> [limit]')
  const limit = Number(limitArgument || 10)
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
    throw new Error('catalog-search limit must be an integer from 1 to 30')
  }
  const cookie = loadCookie()
  const response = await withRetry(() => api.cloudsearch({
    ...(cookie ? { cookie } : {}),
    keywords,
    type: 1,
    limit,
    offset: 0,
    timestamp: Date.now(),
  }))
  const body = responseBody(response) || {}
  const songs = (body.result?.songs || []).slice(0, limit).map((song) => ({
    id: String(song.id),
    name: song.name || '',
    artists: (song.ar || song.artists || []).map((artist) => artist.name).join('/'),
    album: song.al?.name || song.album?.name || '',
    durationMs: song.dt || song.duration || 0,
    aliases: song.alia || song.alias || [],
    fee: song.fee ?? null,
  }))
  emit('catalog_search', { keywords, count: songs.length, songs })
}

function parseSongId(value) {
  const text = String(value || '').trim()
  if (/^[1-9]\d*$/.test(text)) return text
  const match = text.match(/[?&]id=(\d+)/) || text.match(/\/song\/(\d+)/)
  if (match) return match[1]
  throw new Error('Target must be a NetEase song ID or a music.163.com song URL containing an id')
}

async function getCatalogSong(cookie, songId) {
  const response = await withRetry(() => api.song_detail({
    cookie,
    ids: String(songId),
    timestamp: Date.now(),
  }))
  const body = responseBody(response) || {}
  const song = body.songs?.[0]
  if (!song || String(song.id) !== String(songId)) {
    throw new Error(`NetEase catalog song does not exist or is unavailable: ${songId}`)
  }
  return {
    id: String(song.id),
    name: song.name || '',
    artists: (song.ar || []).map((artist) => artist.name).join('/'),
    album: song.al?.name || '',
    durationMs: song.dt || 0,
    aliases: song.alia || [],
  }
}

async function matchInspect(cloudRecordIdArgument) {
  if (!cloudRecordIdArgument) {
    throw new Error('Usage: node scripts/ncm-cloud.js match-inspect <cloud-record-id>')
  }
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run login first')
  const record = summarizeCloudRecord(await findCloudRecord(cookie, cloudRecordIdArgument))
  emit('match_inspect', { record })
}

async function restoreCloudAssociation(cookie, userId, original) {
  let current = summarizeCloudRecord(await findCloudRecord(cookie, original.pcId))
  if (original.matchType === 'matched') {
    if (current.matchType === 'matched' && current.recordSongId !== original.catalogSongId) {
      await setCloudMatch(cookie, userId, current.recordSongId, 0)
      current = await waitForCloudMatch(cookie, original.pcId, (record) => record.matchType !== 'matched', 'rollback unmatch')
    }
    if (current.matchType !== 'matched' || current.recordSongId !== original.catalogSongId) {
      await setCloudMatch(cookie, userId, current.recordSongId, original.catalogSongId)
      current = await waitForCloudMatch(
        cookie,
        original.pcId,
        (record) => record.matchType === 'matched' && record.recordSongId === original.catalogSongId,
        'rollback restore',
      )
    }
  } else if (current.matchType === 'matched') {
    await setCloudMatch(cookie, userId, current.recordSongId, 0)
    current = await waitForCloudMatch(cookie, original.pcId, (record) => record.matchType !== 'matched', 'rollback to unmatched')
  }
  return current
}

async function matchSet(cloudRecordIdArgument, catalogSongIdArgument, options) {
  if (!cloudRecordIdArgument || !catalogSongIdArgument) {
    throw new Error('Usage: node scripts/ncm-cloud.js match-set <cloud-record-id> <catalog-song-id-or-url> [--dry-run|--yes]')
  }
  const targetSongId = parseSongId(catalogSongIdArgument)
  if (!await allowMutation('match-set', { cloudRecordId: cloudRecordIdArgument, targetCatalogSongId: targetSongId }, options)) return
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run login first')
  const { profile } = await withRetry(() => verifyCookie(cookie))
  if (!profile?.userId) throw new Error('Saved session has expired. Run login again')
  const target = await getCatalogSong(cookie, targetSongId)
  const before = summarizeCloudRecord(await findCloudRecord(cookie, cloudRecordIdArgument))
  if (!before.pcId || !before.recordSongId) throw new Error('The selected cloud song has no stable record identifier')
  if (before.matchType === 'matched' && before.recordSongId === targetSongId) {
    emit('match_set_success', { changed: false, before, after: before, target })
    return
  }

  ensureStateDir()
  const backupPath = path.join(stateDir, `match-backup-${before.pcId}-${Date.now()}.json`)
  fs.writeFileSync(backupPath, `${JSON.stringify({ createdAt: new Date().toISOString(), userId: String(profile.userId), before, target }, null, 2)}\n`, 'utf8')
  emit('match_backup', { path: backupPath, before, target })

  let changed = false
  try {
    let source = before
    if (before.matchType === 'matched') {
      await setCloudMatch(cookie, profile.userId, before.recordSongId, 0)
      changed = true
      source = await waitForCloudMatch(cookie, before.pcId, (record) => record.matchType !== 'matched', 'pre-correction unmatch')
    }
    await setCloudMatch(cookie, profile.userId, source.recordSongId, targetSongId)
    changed = true
    const after = await waitForCloudMatch(
      cookie,
      before.pcId,
      (record) => record.matchType === 'matched' && record.recordSongId === targetSongId,
      'corrected match',
    )
    if (before.md5 !== after.md5 || before.fileSize !== after.fileSize) {
      throw new Error('Association changed, but audio identity changed unexpectedly')
    }
    emit('match_set_success', { changed: true, before, after, target, audioUnchanged: true, backupPath })
  } catch (error) {
    if (changed) {
      emit('match_rollback_start', { pcId: before.pcId, originalCatalogSongId: before.catalogSongId })
      try {
        const restored = await restoreCloudAssociation(cookie, profile.userId, before)
        emit('match_rollback_complete', { restored })
      } catch (restoreError) {
        throw new Error(`CORRECTION FAILED AND ROLLBACK FAILED. Backup: ${backupPath}. ${restoreError.message}`)
      }
    }
    throw error
  }
}

async function unmatchCloudSong(cloudRecordIdArgument, options) {
  if (!cloudRecordIdArgument) {
    throw new Error('Usage: node scripts/ncm-cloud.js unmatch <cloud-record-id> [--dry-run|--yes]')
  }
  if (!await allowMutation('unmatch', { cloudRecordId: cloudRecordIdArgument }, options)) return
  const cookie = loadCookie()
  if (!cookie) throw new Error('Not logged in. Run login first')
  const { profile } = await withRetry(() => verifyCookie(cookie))
  if (!profile?.userId) throw new Error('Saved session has expired. Run login again')
  const before = summarizeCloudRecord(await findCloudRecord(cookie, cloudRecordIdArgument))
  if (before.matchType !== 'matched') {
    emit('unmatch_success', { changed: false, before, after: before })
    return
  }
  await setCloudMatch(cookie, profile.userId, before.recordSongId, 0)
  const after = await waitForCloudMatch(cookie, before.pcId, (record) => record.matchType !== 'matched', 'unmatched state')
  emit('unmatch_success', { changed: true, before, after })
}
