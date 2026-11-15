# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-11-15

### 新增

- 网页管理机器 token：顶栏「Token」面板列出 token（名称、状态、创建时间、使用的机器），可签发（明文只显示一次，带复制按钮，明文 http 下退回手动复制）与吊销（页内二次确认，使用它的机器约 1 秒内断开）；签发 / 吊销写入审计日志（`token_create` / `token_revoke`）。
- Windows 安装包：Release 提供 `tether-hub-<版本>-win-x64-setup.exe`，自带 Node 运行时，安装为开机自启、崩溃自动重启的 Windows 服务（WinSW），向导中设置管理员密码、端口与 TLS 证书（或明确选择明文），自动添加防火墙规则；配置与数据在 `%ProgramData%\tether-hub`（仅管理员可访问），升级保留配置，卸载默认保留数据；支持静默安装参数。开始菜单提供「打开管理网页」与「Token 命令行」。
- 安装版的网页一键更新改为下载本平台更新包（`tether-hub-<版本>-win-x64.zip`），按 Release 中的 `SHA256SUMS` 校验后替换程序文件，失败自动换回；源码部署的更新方式不变。
- 发布流程：推送 `v*` tag 后由 GitHub Actions 构建、测试、打包，在 runner 上做静默安装 / 升级 / 卸载冒烟测试，再把安装程序、更新包与 `SHA256SUMS` 上传到对应 Release。
- 手机远程接管终端：单指滑动滚动历史（带惯性），全屏程序中滑动发送方向键或滚轮；滚离底部时显示「回到底部」按钮，期间新输出不再强制跳回；触屏设备显示 Esc / Tab / Ctrl / 方向键快捷键栏，Ctrl 为一次性粘滞键（替代原「Ctrl+C」键）。

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

[0.3.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.3.0
[0.2.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.2.0
[0.1.0]: https://github.com/tongxin-77/tether-hub/releases/tag/v0.1.0
