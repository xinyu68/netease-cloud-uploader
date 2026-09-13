---
name: netease-cloud-uploader
description: 上传本地音频到用户自己的网易云音乐云盘，检查秒传或完整上传结果，并搜索、选择、纠正或取消公开曲库关联。适用于网易云云盘上传和歌曲匹配管理；不用于下载歌曲、绕过付费或访问限制
---

# 网易云音乐云盘上传

通过 `scripts/ncm-cloud.js` 执行确定性的登录检查、上传、曲库搜索和匹配纠正。底层使用网易客户端内部接口，接口可能变化；每次写操作后都回查实际状态，不把 HTTP 成功等同于业务成功。

## 准备运行环境

在 Skill 根目录运行命令。若 `node_modules` 不存在，先安装依赖并做语法检查：

- macOS / Linux：`bash scripts/bootstrap.sh`（安装依赖 + `npm run check`）
- Windows：`powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1`

macOS 上登录优先使用随 Skill 打包的 WKWebView 原生帮助程序（`scripts/native/macos-arm64/NeteaseWebViewLogin`，系统 WebKit，零运行时下载）；仅当原生帮助程序缺失、初始化失败或主页面加载失败时，才走 Electron 兜底。Electron 二进制在国内网络下首装时默认走 npmmirror 镜像拉取，通常无需手动干预。

所有命令的 stdout 是单个 JSON envelope；进度事件写入 stderr。先用 `node scripts/ncm-cloud.js schema <command>` 查询具体命令契约。

## 鉴权

先运行 `node scripts/ncm-cloud.js status`。Windows 上登录态由 DPAPI 加密保存；macOS 及其他平台无 DPAPI，退化为 0o600 权限的 base64 文件，仅同一 OS 用户可读。脚本和回复中不得打印 Cookie。

只有在用户要求登录或上传任务确实需要重新登录时，才运行 `login`。Windows 上默认登录先实际启动系统 WebView2 并打开网易云官方登录页；仅当 WebView2 缺失、初始化失败或主页面加载失败时，才按需下载固定版本的便携 Electron 到用户本地状态目录并自动重试。macOS 上未打包 WebView2 原生帮助程序，`login` 直接走 Electron 兜底：弹出 Electron 窗口打开网易云官方登录页，用户扫码或密码登录后保存会话。Electron 不在 Skill 安装阶段下载，不修改 `PATH` 或其他系统环境变量。用户主动关闭登录窗口时停止，不得将其解释为引擎故障并下载 Electron。国内网络下 Electron 二进制首装可能拉取失败，可用 npmmirror 手动下载（见 [references/authentication.md](references/authentication.md) 的 macOS 支持小节）。

需要诊断时运行 `login-runtime-status`；该命令不打开窗口，也不下载 Electron。不要替用户扫描、输入密码或转移登录凭据。

> 已废弃：旧 `login-qr` / `login-client-qr` 二维码接口被网易风控拦截（状态 8821），Windows 与 macOS 均不可用，已从本 Skill 移除，不要再使用。

只有用户明确要求退出当前 Skill 会话时才运行 `logout`。它会尝试让远端会话失效，并将本地 DPAPI 凭证、WebView2 配置和 Electron 登录配置改名归档。只有活动凭证及两种浏览器配置均已移出原路径，才能报告完全退出。

用户要求“强制退出”或“彻底退出”时，先终止 `NeteaseWebViewLogin`，以及命令行明确包含本 Skill 的 `webview2-profile` 或 `electron-profile` 路径的浏览器子进程；不得结束其他 WebView2 或 Electron 应用。随后运行 `logout`，再运行 `status`，并检查 `session.dpapi`、`webview2-profile`、`electron-profile` 三个活动路径均不存在。任一检查失败都应报告退出不完整，不得报告成功。具体命令和回查项见 [references/authentication.md](references/authentication.md)。

不得一开始就要求用户提供 Cookie。只有 WebView2 和 Electron 官方页面登录均无法建立会话，并已清楚报告自动登录失败原因时，才可以询问用户是否愿意采用手动 Cookie 导入兜底；用户未明确同意时不得索取或处理 Cookie。

## 维护与诊断

- 登录窗口、引擎选择、凭证保存、退出码或原生帮助程序异常：先读 [references/authentication.md](references/authentication.md)
- 网易接口变化、升级依赖或借鉴其他开源实现：先读 [references/upstream-projects.md](references/upstream-projects.md)
- 曲库候选选择和可信度判断：读 [references/matching.md](references/matching.md)
- 写操作、标识符、恢复记录和回滚语义：读 [references/operations.md](references/operations.md)

不要在普通上传任务中预加载维护文档。只有对应步骤异常、需要修复 Skill 或需要修改上游依赖时再读取，以免将历史实验误当成当前执行路径。

## 上传工作流

1. 用 `file-info <file>` 读取 MD5、时长、标题、歌手和专辑
2. 用 `catalog-search <keywords>` 搜索公开曲库候选
3. 按 [references/matching.md](references/matching.md) 判断是否唯一可信；不确定时向用户展示编号候选并等待选择
4. 有目标曲库 ID 时，先用 `cloud-check-v2 <file> <catalogId>` 检查是否可导入
5. 可复用时执行 `cloud-import <file> <catalogId> --yes`；否则执行 `upload <file> --yes`
6. 上传完成后用返回的原始音频 ID 执行 `match-inspect`；必要时用 `cloud-list <keyword>` 定位记录
7. 自动匹配正确则完成；未匹配或错误匹配时，按纠正工作流处理

用户明确要求上传该文件即授权本次上传，可在确定绝对文件路径后传 `--yes`。对写操作可先运行 `--dry-run` 核对目标。不要因为搜索到同名歌曲就推断文件一定能秒传：曲库匹配和 MD5 内容复用是两个独立判断。

## 纠正匹配

用户可以通过云盘歌曲名称、`pcId`、原始音频 ID 或当前歌曲 ID 指定来源，通过网易歌曲 ID、歌曲链接或“歌名 + 歌手”指定目标。

- 目标明确：先 `match-inspect`，再运行 `match-set <cloudRecordId> <catalogIdOrUrl> --dry-run`；确认目标与用户指令一致后运行同命令并传 `--yes`
- 目标不确定：运行 `catalog-search`，展示歌名、歌手、专辑、时长、版本和 ID；用户选择前不得修改关联
- 用户主动要求取消关联：运行 `unmatch <cloudRecordId> --dry-run`，核对后以 `--yes` 执行

`match-set` 会保存不含 Cookie 的恢复记录，已匹配歌曲会先解除旧关联，再关联目标，并按稳定 `pcId` 回查。失败时自动恢复原关联。详细标识符和恢复语义见 [references/operations.md](references/operations.md)。

## 完成条件

仅在以下条件全部满足时报告完成：

- 上传或导入返回成功
- 云盘列表能够找到对应记录
- MD5 或文件大小与上传前一致
- 匹配状态和公开曲库 ID 符合用户选择

若接口返回登录失效、候选歧义、版权/区域限制或恢复失败，停止继续写操作，保留恢复文件路径并清楚说明需要用户处理的事项。
