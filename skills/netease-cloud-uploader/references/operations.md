# 命令和状态语义

## 常用命令

```powershell
node scripts/ncm-cloud.js status
node scripts/ncm-cloud.js login
node scripts/ncm-cloud.js logout
node scripts/ncm-cloud.js file-info "D:\Music\song.mp3"
node scripts/ncm-cloud.js catalog-search "歌名 歌手" 10
node scripts/ncm-cloud.js cloud-list "歌名"
node scripts/ncm-cloud.js cloud-download <cloudRecordId> "D:\目标目录" --yes
node scripts/ncm-cloud.js match-inspect <cloudRecordId>
node scripts/ncm-cloud.js cloud-check-v2 "D:\Music\song.mp3" <catalogId>
node scripts/ncm-cloud.js upload "D:\Music\song.mp3" --dry-run
node scripts/ncm-cloud.js upload "D:\Music\song.mp3" --yes
node scripts/ncm-cloud.js upload "D:\Music\song.mp3" --title="正确标题" --yes
node scripts/ncm-cloud.js media-copy "D:\Music\song.flac" --cover="D:\Music\cover.jpg" --lyrics="D:\Music\song.lrc" --yes
node scripts/ncm-cloud.js cloud-enrich <cloudRecordId> "D:\Music\song.flac" --lyrics="D:\Music\song.lrc" --catalog-unavailable --yes
node scripts/ncm-cloud.js cloud-delete <oldCloudRecordId> --yes
node scripts/ncm-cloud.js match-set <cloudRecordId> <catalogId> --dry-run
node scripts/ncm-cloud.js match-set <cloudRecordId> <catalogId> --yes
node scripts/ncm-cloud.js unmatch <cloudRecordId> --yes
```

`login` 默认使用系统 WebView2 打开网易云官方登录页，只在 WebView2 缺失、初始化失败或主页面加载失败时按需使用 Electron。两种引擎都必须在捕获 Cookie 后通过 `login/status` 回查。`login-qr` 和 `login-client-qr` 仅保留为旧接口诊断命令；登录实现细节见 [authentication.md](authentication.md)。

## 三类歌曲 ID

- `pcId`：个人云盘记录的稳定标识；匹配和解除期间不变，优先用于持续定位记录
- `originalAudioSongId`：上传生成的原始音频歌曲 ID；未匹配状态下通常成为 `simpleSong.id`
- 公开曲库 ID：匹配状态下的 `simpleSong.id`，指向网易公开歌曲

纠正接口的来源 `songId` 随状态变化：已匹配时使用当前公开曲库 ID 解除；解除后使用原始音频歌曲 ID 重新匹配。不得把 `pcId` 直接作为接口的 `songId`。

## 纠正事务

`match-set` 执行以下事务：

1. 按任一已知标识找到记录并保存 `pcId`、原关联、MD5 和大小
2. 校验目标公开歌曲确实存在
3. 已匹配时先解除旧关联并按 `pcId` 回查 `unmatched`
4. 使用解除后返回的记录歌曲 ID 关联目标
5. 按 `pcId` 回查 `matched` 和目标 ID
6. 校验 MD5 与大小未改变
7. 任一步失败时恢复步骤 1 的原状态

用户尚未选择目标时不得先解除旧关联。恢复失败属于高优先级异常：停止所有后续写操作，并向用户提供备份 JSON 路径、原曲库 ID 和当前回查结果。

## 上传状态

完整上传过程中，云端转换状态 `1` 表示仍在处理，状态 `9` 表示可发布。状态 `9` 不是失败。长时间上传和转换进度以 stderr JSON 事件输出。

`cloud-check-v2` 返回项的 `upload` 值按当前接口解释：`1` 表示可调用 `cloud-import` 导入，`0` 表示相同内容已在用户云盘，应先用 `cloud-list` 找到现有记录并纠正关联，其他值视为不可导入并报告。即使曲库中存在目标歌曲，MD5 不同仍可能需要完整上传。

上传前以 `file-info` 的有效标题为准。内嵌标题是 `track 07`、`unknown track`、`未知曲目` 等占位值时，脚本自动采用文件名推断标题；有意义的标题与文件名冲突时必须先由用户确认，再用 `--title=<标题>` 显式覆盖。`metadataRewriteRequired=true` 的 FLAC 或 MP3 必须用 `upload`：脚本会生成不覆盖原文件的标签修正副本，并上传和回查该副本。此时 `cloud-import` 会拒绝执行，避免秒传复用错误内嵌标签。上传或导入后按实际上传文件的 MD5 定位记录，并校验标题、MD5 和大小。

内嵌封面和歌词可以改善未匹配歌曲的播放体验，但不会产生公开曲库 ID、评论或歌曲主页。若同 MD5 已被网易服务端保存为错误标题，秒传可能继续复用旧元数据；修复需要生成标签正确且 MD5 不同的副本，完整上传并回查成功后，才能在用户授权下删除旧记录。

封面或歌词修复同样产生新 MD5。`cloud-enrich` 只接受未匹配记录，并要求 `--catalog-unavailable` 表示调用方已经排除可信曲库候选；它不会自动删除旧记录。新记录在网易客户端显示无误且用户单独确认后，才用旧记录的稳定 `pcId` 执行 `cloud-delete`。删除接口使用原始音频歌曲 ID，脚本按 `pcId` 回查记录确实消失。

## 云盘原文件下载

`cloud-download` 必须先通过当前账号的 `user_cloud` 列表把 `pcId`、原始音频 ID 或当前记录 ID 解析为私有云盘记录，再使用原始音频 ID 申请下载链接。不得把未出现在当前账号云盘列表中的公开歌曲 ID 当作下载目标。

下载先写入最终路径同目录的 `.part-*` 临时文件，计算实际字节数和 MD5；只有两者均与 `privateCloud.fileSize` 和 `privateCloud.md5` 相等时才改名。目标文件已存在时停止，不覆盖、不自动改名。失败或发现转码内容时删除临时文件。输出可包含端点类型、音质级别、格式和校验结果，但不得包含 Cookie 或有时效的签名 URL。

## 退出码

- `0`：成功
- `1`：网络、接口或运行时错误
- `2`：未登录或登录失效
- `3`：参数错误或缺少写操作确认
