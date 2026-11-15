# tether-hub

[Tether](https://github.com/tongxin-77/tether) 的自托管管理服务器：在一个网页里汇总多台机器上的 Tether 会话（含 Claude Code 状态），并可按需远程接管单个会话。

- **可选组件**：Tether 不配置 hub 也能完整使用。
- **零入站端口**：各机器的后台主动以 WSS 出站连接 hub。
- **默认不传终端内容**：平时只上报会话元信息；网页点「接管」后才推送该会话的画面，hub 只转发、不存储。
- **单用户、自托管**：Node.js + TypeScript，运行时依赖仅 `ws` 与 xterm.js（由 hub 本地提供，不用 CDN）。

需配合 Tether 0.4.0 及以上（协议 v2）。文档：[需求](docs/requirements.md) · [协议](docs/protocol.md) · [实现细节](docs/internals.md) · [更新日志](CHANGELOG.md)

## 快速开始

需要 Node.js 22+（推荐 24 LTS）与 pnpm。

```sh
pnpm install && pnpm build
pnpm run token create my-pc                    # 为一台机器签发 token（明文只显示一次）
HUB_TLS_CERT=certs/cert.pem HUB_TLS_KEY=certs/key.pem HUB_ADMIN_PASSWORD='强密码' pnpm start
```

浏览器打开 `https://<地址>:8443/`，用管理员密码登录。

- 证书见下文 [自签证书](#自签证书)；本机调试可不配证书：`HUB_INSECURE=1 HUB_ADMIN_PASSWORD=dev pnpm start`（明文，启动时会警告）。
- PowerShell 设置环境变量：`$env:HUB_ADMIN_PASSWORD = "强密码"`，其余同理。
- 长期运行交给 systemd / pm2 / NSSM 等；SIGINT / SIGTERM 时正常退出。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `HUB_ADMIN_PASSWORD` | — | **必填**，网页管理员密码 |
| `HUB_PORT` | `8443` | 监听端口（网页与 `/agent` 共用） |
| `HUB_HOST` | `0.0.0.0` | 监听地址 |
| `HUB_TLS_CERT` / `HUB_TLS_KEY` | — | PEM 证书与私钥，须同时设置 |
| `HUB_INSECURE` | — | `1` = 无证书时以明文监听，仅限本机 / 可信局域网 |
| `HUB_DATA_DIR` | `./data` | 数据目录（`hub.json`、`audit.jsonl`），token 命令须使用同一目录 |
| `HUB_UPDATE_CHECK` | `1` | `0` = 关闭自动检查更新（网页仍可手动检查） |
| `HUB_UPDATE_API` | GitHub Releases | 覆盖检查更新所用的 API 地址（测试用） |

## token 管理

每台机器一个 token，hub 只保存其 SHA-256。

```sh
pnpm run token create <名称>    # 签发
pnpm run token list             # 列出（名称、状态、创建时间、使用的机器）
pnpm run token revoke <名称>    # 吊销，已连接的机器约 1 秒内断开
```

> 必须写 `pnpm run token`：`pnpm token` 会调用 pnpm 自带的 npm token 命令。token 命令运行编译产物，首次使用前先 `pnpm build`。

名称唯一（含已吊销的）；轮换时先用新名称签发、客户端换上后再吊销旧的。

## 客户端配置

Tether **设置 → 管理服务器**：

| 项 | 填写 |
|----|------|
| 服务器地址 | `192.168.1.10:8443` 或 `wss://hub.example.com:8443`（不写端口时 wss 默认 443，所以默认端口 8443 要写上） |
| token | `th_` 开头的那一串 |
| 允许明文连接 | hub 以 `HUB_INSECURE=1` 运行时勾选；勾选后地址不写协议即按 `ws://` 连接 |
| 允许 hub 远程接管本机会话 | 需要在网页接管时勾选（默认关闭） |

填写后点「测试连接」验证。

## 网页功能

- **机器与会话**：左侧机器列表（在线状态、等待确认数），右侧会话表；「Claude 等待确认」顶部醒目提醒；实时更新。
- **远程接管**：点「接管」打开终端，可输入、粘贴、调整尺寸；本地可随时「收回」；多个浏览器可同时查看。
- **审计日志**：接管的开始 / 结束 / 被拒 / 收回 / 断线及 hub 更新等事件，可筛选。
- **检查更新**：顶栏显示当前版本，有新版本时提示，可在网页一键更新（见 [更新](#更新)）。
- **主题与手机**：浅 / 深色跟随系统；手机上为两级页面，接管终端全屏并带 Esc / Tab / Ctrl+C / 方向键按键条。

细节见 [实现细节](docs/internals.md)。

## 更新

hub 启动时及每 6 小时检查一次 [GitHub Releases](https://github.com/tongxin-77/tether-hub/releases)，有新版本时网页顶栏出现「有新版本」提示，点开可查看更新说明、手动检查或「立即更新」。

一键更新会下载新版本源码覆盖安装目录（保留 `data/`、`HUB_DATA_DIR`、`node_modules/`、`certs/`、`.env*`、`.git/`），执行 `pnpm install --frozen-lockfile` 与 `pnpm build`，成功后 hub 以退出码 0 退出，**需由 systemd（`Restart=always`）/ pm2 / NSSM 等进程管理器拉起新版本**；任一步失败会回滚并继续运行旧版本。需要系统有 `tar`（Windows 10+ 自带）与 pnpm；更新后需重新登录网页。

也可手动更新：`git pull && pnpm install && pnpm build` 后重启。

## 自签证书

```sh
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem \
  -days 3650 -subj "/CN=hub.lan" -addext "subjectAltName=DNS:hub.lan,IP:192.168.1.10"
```

- 把 `hub.lan` 与 IP 换成客户端实际填写的地址；Git Bash 下在命令前加 `MSYS_NO_PATHCONV=1`。
- 每台客户端机器需信任该证书：管理员运行 `certutil -addstore -f Root cert.pem`。
- 有域名时推荐 Let's Encrypt 等正式证书。

## 开发

```sh
pnpm dev             # 直接运行源码（tsx）
pnpm test            # node:test
pnpm test-client ws://127.0.0.1:8443/agent <token> [停留秒数]   # 模拟一台机器，可在网页接管其假会话
```

目录：`src/`（服务端）、`public/`（网页）、`test/`、`scripts/`、`docs/`。

## 许可证

[Apache-2.0](LICENSE)
