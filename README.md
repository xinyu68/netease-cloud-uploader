# Codex 网易云音乐云盘上传 Skill

将本地音频上传到用户自己的网易云音乐云盘，并在上传后核对云盘记录、公开曲库匹配和文件信息。匹配缺失或错误时，可以搜索候选歌曲，让用户选择后纠正关联。

当前正式登录实现支持 Windows：优先使用系统 WebView2 打开网易云官方登录页；WebView2 缺失或不可用时，首次登录才按需下载固定版本的便携 Electron。安装 Skill 本身不会下载 Electron，也不会修改系统环境变量。macOS 的 WKWebView 登录尚未实现。

## 让 Codex 安装

直接对 Codex 说：

> 从 https://github.com/xinyu68/netease-cloud-uploader/tree/main/skills/netease-cloud-uploader 安装这个 Skill

Codex 会通过标准 Skill 安装器把它安装为 `netease-cloud-uploader`。安装完成后，从下一轮对话开始使用。

## 使用命令安装

Windows PowerShell：

```powershell
python "$env:USERPROFILE\.codex\skills\.system\skill-installer\scripts\install-skill-from-github.py" --repo xinyu68/netease-cloud-uploader --path skills/netease-cloud-uploader
```

安装器只复制 Skill 文件，不会在安装阶段登录网易云或下载 Electron。首次实际使用时，如果尚未安装 Node 依赖，Skill 会在自身目录运行 `scripts/bootstrap.ps1`；需要 Node.js 20 或更高版本。

## 使用示例

安装后的新一轮对话中，可以对 Codex 说：

> 把 `D:\Music\歌曲.flac` 上传到我的网易云音乐云盘

未登录时会打开网易云官方登录页面，由用户自行扫码、短信或密码登录。Skill 不要求用户一开始手动提供 Cookie；只有两种浏览器登录引擎都失败后，才会把手动导入作为兜底选择。

还可以主动纠正曲库关联：

> 把云盘里的《歌曲名》纠正为网易云歌曲 ID 123456

目标不明确时，Skill 会列出候选供用户选择；写入后会回查结果，并在失败时尝试恢复原关联。

## 更新

已安装的 Skill 不会随 GitHub 仓库自动更新。需要更新时，可让 Codex 从同一 GitHub 地址重新安装最新版本。标准安装器不会覆盖已有同名目录，因此更新前应先备份需要保留的本地状态，再移除旧的 Skill 目录。

登录凭证不保存在 Skill 目录或 GitHub 仓库中。Windows 登录态使用当前用户的 DPAPI 加密，存放在 `%LOCALAPPDATA%\netease-cloud-uploader\session.dpapi`。

## 使用范围

本项目是非官方工具，只用于管理用户自己的网易云音乐云盘，不包含音乐文件、账号凭证或网易云官方代码。底层接口可能变化，上传和匹配操作均以写入后的实际回查结果为准。
