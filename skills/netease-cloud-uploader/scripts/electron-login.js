#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { app, BrowserWindow, session } = require('electron')

const stateDir = process.env.NCM_STATE_DIR
if (!stateDir) throw new Error('NCM_STATE_DIR is required')
const credentialPath = path.join(stateDir, 'session.dpapi')
let loginSaved = false
let checkingCookies = false
let windowClosedByApp = false

app.setName('NeteaseCloudUploaderLogin')
app.setPath('userData', path.join(stateDir, 'electron-profile'))

function protectWithDpapi(value) {
  if (process.platform !== 'win32') {
    // macOS has no DPAPI; store base64 and rely on 0o600 file permissions
    // plus the fact that only the same OS user can read it back.
    return Buffer.from(value, 'utf8').toString('base64')
  }
  const script = "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: value,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error('DPAPI credential encryption failed')
  return result.stdout.trim()
}

async function saveAuthenticatedCookies() {
  if (checkingCookies || loginSaved) return
  checkingCookies = true
  try {
    const cookies = await session.defaultSession.cookies.get({})
    const musicCookies = cookies.filter((cookie) =>
      cookie.domain === 'music.163.com' || cookie.domain.endsWith('.music.163.com'),
    )
    if (!musicCookies.some((cookie) => cookie.name === 'MUSIC_U' && cookie.value)) return

    const byName = new Map()
    for (const cookie of musicCookies) byName.set(cookie.name, cookie.value)
    const cookieHeader = [...byName.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(credentialPath, protectWithDpapi(cookieHeader), { encoding: 'utf8', mode: 0o600 })
    loginSaved = true
    // Match the native WebView2 helper: no modal confirmation on the success
    // path. Briefly reflect the outcome in the title, then close the window
    // automatically so the user does not have to click anything.
    windowClosedByApp = true
    for (const win of BrowserWindow.getAllWindows()) win.setTitle('登录成功，登录态已保存，正在关闭…')
    setTimeout(() => app.exit(0), 600)
  } catch {
    windowClosedByApp = true
    app.exit(13)
  } finally {
    checkingCookies = false
  }
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: '网易云音乐登录（兼容模式）',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) win.loadURL(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-finish-load', saveAuthenticatedCookies)
  win.webContents.on('did-navigate', saveAuthenticatedCookies)
  win.webContents.on('did-navigate-in-page', saveAuthenticatedCookies)
  win.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame && !loginSaved) {
      windowClosedByApp = true
      app.exit(12)
    }
  })
  win.on('closed', () => {
    if (!windowClosedByApp && !loginSaved) app.exit(11)
  })
  setInterval(saveAuthenticatedCookies, 1000)
  win.loadURL('https://music.163.com/#/login').catch(() => {
    windowClosedByApp = true
    app.exit(12)
  })
}).catch(() => app.exit(10))
