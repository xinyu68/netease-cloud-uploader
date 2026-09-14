# Codex 网易云音乐云盘上传 Skill

将本地音频上传到用户自己的网易云音乐云盘，并在上传后核对云盘记录、公开曲库匹配和文件信息。匹配缺失或错误时，可以搜索候选歌曲，让用户选择后纠正关联；确实没有可信曲库候选时，还可以按用户要求修改未匹配歌曲的内嵌封面或歌词。

当前正式登录实现支持 Windows 和 macOS：Windows 优先使用系统 WebView2，Apple Silicon Mac 优先使用随 Skill 打包的 WKWebView 帮助程序，原生引擎缺失或不可用时才按需下载固定版本的便携 Electron。Intel Mac 在对应原生帮助程序未打包时自动使用 Electron。安装 Skill 本身不会下载 Electron，也不会修改系统环境变量。

## 让 Codex 安装

直接对 Codex 说：

> 从 https://github.com/xinyu68/netease-cloud-uploader/tree/main/skills/netease-cloud-uploader 安装这个 Skill

Codex 会通过标准 Skill 安装器把它安装为 `netease-cloud-uploader`。安装完成后，从下一轮对话开始使用。

## 使用命令安装

Windows PowerShell：

```powershell
python "$env:USERPROFILE\.codex\skills\.system\skill-installer\scripts\install-skill-from-github.py" --repo xinyu68/netease-cloud-uploader --path skills/netease-cloud-uploader
```

安装器只复制 Skill 文件，不会在安装阶段登录网易云或下载 Electron。首次实际使用时，如果尚未安装 Node 依赖，Skill 会在自身目录运行 Windows 的 `scripts/bootstrap.ps1` 或 macOS/Linux 的 `scripts/bootstrap.sh`；需要 Node.js 20 或更高版本。

## 使用示例

安装后的新一轮对话中，可以对 Codex 说：

> 把 `D:\Music\歌曲.flac` 上传到我的网易云音乐云盘

未登录时会打开网易云官方登录页面，由用户自行扫码、短信或密码登录。Skill 不要求用户一开始手动提供 Cookie；只有两种浏览器登录引擎都失败后，才会把手动导入作为兜底选择。

还可以主动纠正曲库关联：

> 把云盘里的《歌曲名》纠正为网易云歌曲 ID 123456

目标不明确时，Skill 会列出候选供用户选择；写入后会回查结果，并在失败时尝试恢复原关联。

对于无法正确关联公开曲库的歌曲，可以按需修改封面或歌词：

> 云盘里的《歌曲名》没有对应曲库歌曲。使用本地原文件 `D:\Music\歌曲.flac`，把封面改成 `D:\Music\cover.jpg`

> 云盘里的《歌曲名》没有对应曲库歌曲。使用本地原文件 `D:\Music\歌曲.mp3`，把歌词改成 `D:\Music\歌曲.lrc`

也可以同时修改两项：

> 使用本地原文件 `D:\Music\歌曲.flac`，把云盘里的《歌曲名》封面改成 `D:\Music\cover.png`，歌词改成 `D:\Music\歌曲.lrc`

Skill 会先检查是否能正确关联网易公开曲库；能关联时优先纠正关联，不修改音频文件。只有确认没有可信曲库候选后，才会生成 FLAC 或 MP3 修正副本，验证音频内容和时长没有变化，再完整上传。支持 JPEG/PNG 封面和普通文本或带时间轴的 LRC 歌词。

修改时不会覆盖本地原文件，也不会自动删除旧云盘记录。新记录验证无误后，可以再明确要求：

> 新记录检查没问题，删除刚才被替换的旧云盘记录

删除需要单独确认；最初的封面或歌词修改请求不会被当作删除授权。如果只想检查生成的文件而不上传，也可以说：

> 给 `D:\Music\歌曲.flac` 生成一个替换封面和歌词的副本，只检查文件，不要上传网易云

## 更新

已安装的 Skill 不会随 GitHub 仓库自动更新。需要更新时，可让 Codex 从同一 GitHub 地址重新安装最新版本。标准安装器不会覆盖已有同名目录，因此更新前应先备份需要保留的本地状态，再移除旧的 Skill 目录。

登录凭证不保存在 Skill 目录或 GitHub 仓库中。Windows 登录态使用当前用户的 DPAPI 加密，存放在 `%LOCALAPPDATA%\netease-cloud-uploader\session.dpapi`；macOS/Linux 使用仅当前 OS 用户可读的 0o600 base64 文件，存放在 `~/netease-cloud-uploader/session.dpapi`。

## 使用范围

本项目是非官方工具，只用于管理用户自己的网易云音乐云盘，不包含音乐文件、账号凭证或网易云官方代码。底层接口可能变化，上传和匹配操作均以写入后的实际回查结果为准。
