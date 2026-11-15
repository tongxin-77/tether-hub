# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.2.0] - 2026-11-15

### 新增

- 检查更新：启动时与每 6 小时查询 GitHub Releases 最新版本（`HUB_UPDATE_CHECK=0` 关闭自动检查，`HUB_UPDATE_API` 可覆盖地址），网页顶栏显示当前版本，有新版本时提示并可查看更新说明、手动检查。
- 网页一键更新：下载新版本源码覆盖安装目录（保留数据、依赖、证书、`.env*`、`.git`），`pnpm install --frozen-lockfile` + `pnpm build` 后退出，由进程管理器拉起新版本；失败自动回滚并继续运行旧版本；进度与日志实时显示，有接管进行中时二次确认；更新事件写入审计日志。

## [0.1.0] - 2026-11-15

首个版本，配合 Tether 0.4.0 及以上（daemon ↔ hub 协议 v2）。

### 新增

- 机器接入：Tether 后台以 WebSocket（默认 wss，`HUB_INSECURE=1` 时允许明文）出站连接 hub，每台机器一个 token，hub 只保存 token 的 SHA-256；命令行 `pnpm run token create | list | revoke` 签发 / 列出 / 吊销，吊销即时断开对应机器。
- 会话汇总：实时汇总各机器的会话列表（名称、目录、命令、状态、Claude 状态等，不含终端内容），离线后保留最近一次列表并标记离线。
- 远程接管：机器在 Tether 设置中允许后，可在网页中打开会话的终端（xterm.js）查看并输入；多个浏览器共用同一接管；本地可随时收回。
- 审计：接管的开始、结束、被拒、本地收回、断线等事件写入 `audit.jsonl`，网页可筛选查看。
- Web 管理界面：管理员密码登录（限流），主从布局（机器列表 + 会话详情），「Claude 等待确认」醒目提醒，浅色 / 深色主题，适配手机（两级页面、全屏终端与按键条）。

[未发布]: https://github.com/tongxin-77/tether-hub/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.2.0
[0.1.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.1.0
