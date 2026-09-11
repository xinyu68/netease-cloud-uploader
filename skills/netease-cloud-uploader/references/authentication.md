# 登录实现与维护

本文供维护和故障诊断使用。普通上传流程只需按 `SKILL.md` 运行 `status` 和 `login`，无需先读取本文。

## 当前选择流程

1. `status` 先验证已保存会话；会话有效时不打开登录窗口
2. Windows 上的 `login` 启动随 Skill 打包的 WebView2 原生帮助程序，打开网易云官方登录页
3. 用户在官方页面自行扫码、短信或密码登录；帮助程序只读取登录成功后该页面产生的 Cookie
4. 捕获到 `MUSIC_U` 后，以 Windows DPAPI `CurrentUser` 加密保存 Cookie
5. 帮助程序成功退出后，Node 进程必须再调用 `login/status` 做服务端验证；不能仅凭本地出现 Cookie 就报告登录成功
6. 仅当 WebView2 Runtime 不存在、初始化失败或主页面加载失败时，才按需下载固定版本 Electron 并用相同的官方页面流程重试

用户主动关闭窗口属于取消操作，不是 WebView2 故障，不得因此下载 Electron。Electron 不在 Skill 安装阶段下载，也不写入 `PATH` 或其他系统环境变量。

当前正式实现仅支持 Windows。macOS 的预期实现是系统 WKWebView，但尚未打包和验证；维护者不得据此宣称 Skill 已兼容 macOS。

## 本地状态与隐私

状态根目录为 `%LOCALAPPDATA%\netease-cloud-uploader`：

| 路径 | 用途 |
| --- | --- |
| `session.dpapi` | 当前 Windows 用户可解密的 Cookie 密文 |
| `webview2-profile` | WebView2 独立浏览器配置 |
| `runtime\electron-44.3.0` | WebView2 不可用时才下载的便携 Electron |
| `electron-profile` | Electron 独立浏览器配置 |

不得把 Cookie、手机号、短信验证码、密码或 DPAPI 解密后的内容写入 stdout、stderr、恢复文件、测试快照或回复。`logout` 会先尝试使远端会话失效，再把本地密文、`webview2-profile` 和 `electron-profile` 分别改名归档；只归档 `session.dpapi` 会让浏览器 Cookie 在下次登录时立即恢复会话，因此不能视为完全退出。排障时不要在备份前直接删除这些状态。

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

旧命令 `login-qr` 和 `login-client-qr` 仅保留作接口诊断，不应恢复为默认登录路径。

## 已验证现象

- 官方登录页在 WebView2 内能够完成登录，随后 `login/status` 能确认会话
- 纯 Web 二维码曾在扫码确认后从状态 `802` 转为接口错误 `8821`
- 客户端二维码实验未观察到扫码状态，最终过期
- 短信接口能够发送并校验验证码，但最终登录曾返回 `10004` 风控错误

这些现象只解释当前架构选择，不是网易接口的永久保证。短信登录不能作为当前生产兜底；接口行为变化时应重新做最小验证。

## 重建 Windows 帮助程序

正式包已经包含编译产物，用户机器不需要 Visual Studio、C# 编译器或 WebView2 SDK。维护者只有在修改 `scripts/native/windows/WebViewLogin.cs` 后才需要重建：

1. 获取 Microsoft WebView2 SDK `1.0.4191.47`
2. 用 Windows C# 编译器引用 `System.Windows.Forms`、`System.Security`、`Microsoft.Web.WebView2.Core.dll` 和 `Microsoft.Web.WebView2.WinForms.dll`
3. 将 `NeteaseWebViewLogin.exe`、上述两个托管 DLL 和对应 x64 的 `WebView2Loader.dll` 放入 `scripts/native/windows-x64`
4. 在有 WebView2 和无 WebView2 的隔离环境分别验证退出码、Electron 懒下载及服务端会话回查

升级 SDK 时要记录精确版本，并确认四个运行文件来自同一兼容版本。不要让构建依赖进入用户安装流程。
