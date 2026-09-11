# 上游项目与依赖关系

最后复核日期：2026-09-12。

本文用于定位接口变化和选择修复来源。除明确标为“直接依赖”的项目外，其余仓库都是实现或行为参考，不代表复制了其代码，也不是 Skill 的运行依赖。

## 项目索引

| 项目 | 关系 | 主要参考点 | 当前集成状态 |
| --- | --- | --- | --- |
| [NeteaseCloudMusicApiBackup](https://github.com/xinyu68/NeteaseCloudMusicApiBackup) | 实现参考 | API 路由、加密请求、云盘上传与曲库匹配 | 未直接依赖；排查底层接口时对照 |
| [netease-cloud-uploader](https://github.com/llaurora/netease-cloud-uploader) | 产品与流程参考 | Web 云盘管理、上传编排和交互方式 | 未直接依赖 |
| [CloudMusicUploadHelper](https://github.com/CareCoder/CloudMusicUploadHelper) | 行为参考 | 完整上传链路和音频元数据处理 | 未直接依赖 |
| [NeteaseMusicCloudManager](https://github.com/zdxiaoda/NeteaseMusicCloudManager) | 行为参考 | 云盘记录管理、匹配及纠正流程 | 未直接依赖 |
| [Netease-Cloud-Music-Web-Player](https://github.com/feng-yifan/Netease-Cloud-Music-Web-Player) | 登录参考 | 浏览器官方页面登录和 Cookie 会话思路 | 未直接依赖；单独使用它不能解决已观察到的 API 二维码风控 |
| [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) | **直接依赖** | API 模块、请求加密和底层网络封装 | `package.json` 固定到提交 `b7bf2b527c5c0b2e67515f1573a4aa40f3b556fa` |
| [ncmctl / netease-cloud-music](https://github.com/chaunsin/netease-cloud-music) | 诊断对照 | Go 版上传流程、短信接口路径和加密方式 | 未随 Skill 分发；曾用 `v0.8.0` 二进制做最小验证 |

`api-enhanced` 的 [PR #201](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/pull/201) 涉及登录修复，包括移动端短信、浏览器 Cookie 和安全验证方向。它是未合并变更的研究线索，不能直接替换当前固定依赖；采用前必须逐项复核代码、接口行为和安全边界。

## 版本锚点

| 组件 | 版本或提交 | 用途 |
| --- | --- | --- |
| `@neteasecloudmusicapienhanced/api` | `b7bf2b527c5c0b2e67515f1573a4aa40f3b556fa` | 当前 API 直接依赖 |
| Microsoft WebView2 SDK | `1.0.4191.47` | Windows 原生登录帮助程序的编译时依赖 |
| Electron | `44.3.0` | WebView2 不可用时的按需运行时兜底 |

版本锚点必须与 `package.json`、`scripts/ncm-cloud.js` 和原生编译产物保持一致。不要把直接依赖改成浮动分支或上游 `HEAD`。

## 从上游采纳修复的规则

1. 先确定问题层级：登录页面、Cookie 上下文、接口路径、加密方式、上传分片、曲库匹配或结果回查
2. 阅读目标仓库的 `LICENSE` 并确认与本项目用途兼容后，才能复制或改编代码；本文的链接不是许可证兼容性批准
3. 记录采纳来源的精确 commit 或 tag，不以仓库当前默认分支作为可复现依据
4. 对比请求域名、`weapi`/`eapi` 加密、设备与 Cookie 上下文，不能只复制 endpoint 字符串
5. 做最小范围修改，并运行语法检查、自动测试、登录状态回查及至少一次真实上传验证
6. 上游均为非官方实现，网易接口和风控可能随时变化；HTTP 200 或本地 Cookie 存在都不能代替业务结果回查

当前短信实验曾参考 `ncmctl` 的 `weapi/sms/captcha/sent` 与 `eapi/w/login/cellphone` 路径：发送和验证码校验可用，但最终登录返回过 `10004`。因此该实现只能用于诊断比较，不能作为 WebView2/Electron 的正式替代。
