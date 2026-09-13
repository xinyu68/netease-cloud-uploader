# 登录实现与维护

本文供维护和故障诊断使用。普通上传流程只需按 `SKILL.md` 运行 `status` 和 `login`，无需先读取本文。

## 当前选择流程

1. `status` 先验证已保存会话；会话有效时不打开登录窗口
2. Windows 上的 `login` 启动随 Skill 打包的 WebView2 原生帮助程序，macOS 上启动随 Skill 打包的 WKWebView 原生帮助程序（`scripts/native/macos-arm64/NeteaseWebViewLogin`），打开网易云官方登录页
3. 用户在官方页面自行扫码、短信或密码登录；帮助程序只读取登录成功后该页面产生的 Cookie
4. 捕获到 `MUSIC_U` 后，Windows 以 DPAPI `CurrentUser` 加密保存 Cookie，macOS 以 0o600 权限的 base64 文件保存；并立即自动关闭登录窗口；成功路径不得显示需要用户确认的模态提示框
5. 帮助程序成功退出后，Node 进程通过带三次重试的 `login/status` 做服务端验证；不能仅凭本地出现 Cookie 就报告登录成功
6. 仅当原生 Runtime 不存在、初始化失败或主页面加载失败时，才按需下载固定版本 Electron 并用相同的官方页面重试

用户主动关闭窗口属于取消操作，不是原生引擎故障，不得因此下载 Electron。Electron 不在 Skill 安装阶段下载，也不写入 `PATH` 或其他系统环境变量。

## 本地状态与隐私

状态根目录为 `%LOCALAPPDATA%\netease-cloud-uploader`：

| 路径 | 用途 |
| --- | --- |
| `session.dpapi` | 当前 Windows 用户可解密的 Cookie 密文 |
| `webview2-profile` | WebView2 独立浏览器配置 |
| `runtime\electron-44.3.0` | WebView2 不可用时才下载的便携 Electron |
| `electron-profile` | Electron 独立浏览器配置 |

不得把 Cookie、手机号、短信验证码、密码或 DPAPI 解密后的内容写入 stdout、stderr、恢复文件、测试快照或回复。`logout` 会先尝试使远端会话失效，再把本地密文、`webview2-profile` 和 `electron-profile` 分别改名归档；只归档 `session.dpapi` 会让浏览器 Cookie 在下次登录时立即恢复会话，因此不能视为完全退出。排障时不要在备份前直接删除这些状态。

## 强制退出与回查

用户明确要求强制或彻底退出时：

1. 终止进程名为 `NeteaseWebViewLogin` 的专用登录帮助程序
2. 仅终止命令行包含 `%LOCALAPPDATA%\netease-cloud-uploader\webview2-profile` 或 `electron-profile` 的 `msedgewebview2.exe`/`electron.exe` 子进程；禁止按进程名结束所有 WebView2 或 Electron 实例
3. 运行 `node scripts/ncm-cloud.js logout`，确认远端结果，并确认活动凭证和浏览器配置已被归档
4. 运行 `node scripts/ncm-cloud.js status`，结果必须为 `auth_required`
5. 检查以下三个活动路径均不存在：
   - `%LOCALAPPDATA%\netease-cloud-uploader\session.dpapi`
   - `%LOCALAPPDATA%\netease-cloud-uploader\webview2-profile`
   - `%LOCALAPPDATA%\netease-cloud-uploader\electron-profile`

远端注销暂时失败时，仍要清理本地活动状态，但必须报告远端失败。任一浏览器配置无法归档，或者回查仍显示已登录，都属于退出不完整。归档目录用于故障恢复，不得在用户未要求永久清除时删除。

## WebView2 帮助程序退出码

| 退出码 | 含义 | 是否允许 Electron 兜底 |
| --- | --- | --- |
| `0` | 已读取并加密保存登录态 | 否；继续做服务端验证 |
| `10` | WebView2 Runtime 不可用或初始化失败 | 是 |
| `11` | 用户关闭登录窗口 | 否 |
| `12` | 忽略导航取消并自动重试后，用户选择切换备用登录 | 是 |
| `13` | Cookie 读取或 DPAPI 加密保存失败 | 否；先排查权限和本地状态 |

退出码语义同时受 `scripts/native/windows/WebViewLogin.cs` 与 `scripts/ncm-cloud.js` 约束，修改任一处时必须同步另一处和本文。

## 诊断步骤

先运行：

```powershell
node scripts/ncm-cloud.js login-runtime-status
node scripts/ncm-cloud.js status
```

`login-runtime-status` 只报告 WebView2 帮助程序和 Electron 缓存状态，不打开窗口、也不下载 Electron。随后按以下顺序排查：

1. 区分引擎不可用、页面网络失败、用户取消和网易服务端拒绝
2. 使用隔离的 `webview2-profile` 或 `electron-profile` 复现，不要先破坏现有凭证
3. 帮助程序返回成功后仍以 `login/status` 为准；服务端未确认就不得继续上传
4. 验证 WebView2 失败码确实属于 `10` 或 `12`，再检查 Electron 是否被按需下载
5. 不得在用户关闭窗口或 Cookie 保存失败时自动切换引擎，以免掩盖真实问题

WebView2 的 `OperationCanceled` 常由重定向或前端路由替换旧导航引起，不得当成页面加载失败。其他导航错误先自动重试两次，仍失败时在窗口内显示 `WebErrorStatus`；只有用户在该提示中选择取消，才以退出码 `12` 进入 Electron 兜底。Electron 安装失败时应输出经过脱敏和截断的 npm 错误尾部，禁止只报告笼统的退出码。

旧二维码命令 `login-qr` 与 `login-client-qr` 已移除：其 Web/客户端二维码接口被网易风控拦截（状态 `8821`），Windows 与 macOS 均无法完成扫码登录，不再保留。

## 已验证现象

- 官方登录页在 WebView2（Windows）与 Electron（Windows/macOS）内均能完成登录，随后 `login/status` 能确认会话
- 纯 Web 二维码曾在扫码确认后从状态 `802` 转为接口错误 `8821`；客户端二维码未观察到扫码状态，最终过期。据此判断二维码接口已被网易风控彻底拦截，故移除 `login-qr` / `login-client-qr`，登录统一走浏览器窗口（WebView2/Electron）
- 短信接口能够发送并校验验证码，但最终登录曾返回 `10004` 风控错误

这些现象只解释当前架构选择，不是网易接口的永久保证。短信登录不能作为当前生产兜底；接口行为变化时应重新做最小验证。

## macOS 支持

macOS 上 `login` 优先使用随 Skill 打包的 WKWebView 原生帮助程序（系统 WebKit，无额外运行时下载）；仅当帮助程序缺失或返回退出码 `10`/`12` 时，才走 Electron 兜底。凭证无 DPAPI，退化为 0o600 权限的 base64 文件。代码实现：

- `scripts/native/macos/LoginWindow.swift`：WKWebView 登录帮助程序，退出码语义与 Windows WebView2 帮助程序一致。
- `scripts/native/build.sh`：在 macOS 上编译，产物输出到 `scripts/native/macos-arm64/`（按 `uname -m` 决定目录名）。
- `scripts/ncm-cloud.js` 的 `runDpapi()`：非 win32 平台以 base64 存取 Cookie（不再抛异常），Windows 仍走 DPAPI。
- `login()`：Windows 用 `runNativeWebViewLogin()`，macOS 用 `runNativeMacOSLogin()`（通过 `process.arch` 选择 `macos-arm64` 或 `macos-x64` 二进制）；`NCM_LOGIN_FORCE_ELECTRON=1` 可强制 Electron。

Electron 二进制（`electron@44.3.0`）仅在 WKWebView 兜底场景需要下载；国内网络下 npm 的 GitHub 直连 fetch 会失败，`ensureElectronRuntime()` 已默认设置 npmmirror 镜像（`ELECTRON_MIRROR`）。手动拉取（arch 取 `arm64`/`x64`，本机 `uname -m` 决定）：

```bash
cd <stateDir>/runtime/electron-44.3.0/node_modules/electron
curl -sL -o electron.zip "https://registry.npmmirror.com/-/binary/electron/44.3.0/electron-v44.3.0-darwin-arm64.zip"
unzip -q -o electron.zip -d dist && rm electron.zip
echo "Electron.app/Contents/MacOS/Electron" > path.txt
node -e 'console.log(require("./index.js"))'   # 应打印 .../dist/Electron.app/Contents/MacOS/Electron
```

完成后 `node scripts/ncm-cloud.js login-runtime-status` 的 `nativeHelperPackaged` 应为 `true`（WKWebView 已打包）；若进入 Electron 兜底，`electronFallbackCached` 应为 `true`。凭证与浏览器配置存于 `~/netease-cloud-uploader/`（macOS 无 `LOCALAPPDATA`，`stateDir` 落在用户主目录）。若担心 base64 明文存储，可改用手动 Cookie 导入兜底。

## 重建 Windows 帮助程序

正式包已经包含编译产物，用户机器不需要 Visual Studio、C# 编译器或 WebView2 SDK。维护者只有在修改 `scripts/native/windows/WebViewLogin.cs` 后才需要重建：

1. 获取 Microsoft WebView2 SDK `1.0.4191.47`
2. 用 Windows C# 编译器引用 `System.Windows.Forms`、`System.Security`、`Microsoft.Web.WebView2.Core.dll` 和 `Microsoft.Web.WebView2.WinForms.dll`
3. 将 `NeteaseWebViewLogin.exe`、上述两个托管 DLL 和对应 x64 的 `WebView2Loader.dll` 放入 `scripts/native/windows-x64`
4. 在有 WebView2 和无 WebView2 的隔离环境分别验证退出码、Electron 懒下载及服务端会话回查

升级 SDK 时要记录精确版本，并确认四个运行文件来自同一兼容版本。不要让构建依赖进入用户安装流程。

## 重建 macOS 帮助程序

正式包已包含 `scripts/native/macos-arm64/NeteaseWebViewLogin` 编译产物，用户机器不需要 Xcode。维护者只有在修改 `scripts/native/macos/LoginWindow.swift` 后才需要重建：

```bash
bash scripts/native/build.sh
```

需要 Xcode Command Line Tools（`swiftc`）。产物按本机架构输出到 `scripts/native/macos-arm64/` 或 `scripts/native/macos-x64/`。`ncm-cloud.js` 通过 `process.arch` 选择目录，因此 arm64 用户提交 `macos-arm64`、x64 用户提交 `macos-x64` 即可；跨架构 fat binary 暂不支持。
