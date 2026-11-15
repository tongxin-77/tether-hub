# tether-hub

[Tether](https://github.com/tongxin-77/tether) 的自托管管理服务器：在一个网页里汇总多台机器上的 Tether 会话（含 Claude Code 状态），后续版本将支持按需远程接管单个会话。

> 状态：v0.1.0，实现机器接入（H-1.x）与会话汇总（H-2.x）。远程接管（H-3）与审计（H-4）尚未实现。

- hub 为可选组件：Tether 客户端不配置 hub 时可完全独立使用。
- 客户端零入站端口：由各机器的 `tetherd` 主动以 WSS 出站连接 hub。
- 不传输、不存储任何终端内容，只有会话元信息。
- 技术栈：Node.js LTS + TypeScript，唯一运行时依赖为 `ws`。

文档：[需求](docs/requirements.md) · [daemon ↔ hub 协议 v1](docs/protocol.md)

## 部署

需要 Node.js 22 及以上（推荐 24 LTS）与 pnpm。

```sh
git clone <本仓库> tether-hub && cd tether-hub
pnpm install
pnpm build

# 1. 准备证书（见下文「自签证书」），签发 token
pnpm token create dev-pc

# 2. 启动
HUB_TLS_CERT=certs/cert.pem HUB_TLS_KEY=certs/key.pem HUB_ADMIN_PASSWORD='换成强密码' pnpm start
```

Windows PowerShell 下设置环境变量：

```powershell
$env:HUB_TLS_CERT = "certs\cert.pem"; $env:HUB_TLS_KEY = "certs\key.pem"; $env:HUB_ADMIN_PASSWORD = "换成强密码"
pnpm start
```

启动后浏览器打开 `https://<地址>:8443/`，用管理员密码登录。长期运行可交给 systemd / pm2 / NSSM 等进程管理器；`Ctrl+C`（SIGINT）或 SIGTERM 会写回机器最后在线时间后退出。

本机调试可以不配证书，以明文运行（启动时会打印醒目警告）：

```sh
HUB_INSECURE=1 HUB_ADMIN_PASSWORD=dev pnpm start      # 或 pnpm dev（tsx 直接运行源码）
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HUB_PORT` | `8443` | 监听端口（Web 界面与 `/agent` 共用） |
| `HUB_HOST` | `0.0.0.0` | 监听地址 |
| `HUB_TLS_CERT` / `HUB_TLS_KEY` | — | PEM 证书与私钥路径，须同时设置；设置后使用 https / wss |
| `HUB_INSECURE` | — | 设为 `1` 时允许在没有证书的情况下以明文 http / ws 监听，仅限本机或可信局域网调试。证书与此项都没有时 hub 拒绝启动 |
| `HUB_ADMIN_PASSWORD` | — | **必填**，Web 管理员密码 |
| `HUB_DATA_DIR` | `./data` | 数据目录，存放 `hub.json`。token CLI 也读这个变量，两者须一致 |

## token 管理

每台机器一个 token，hub 只保存 token 的 SHA-256。

```sh
pnpm token create <名称>   # 签发新 token，明文只显示这一次
pnpm token list            # 列出 token：名称、状态、创建时间、使用它的机器
pnpm token revoke <名称>   # 吊销
```

- 名称唯一（包括已吊销的）。轮换时用新名称签发，客户端换上新 token 后再吊销旧的。
- **吊销即时生效**：运行中的 hub 每秒检查一次 `hub.json` 是否变化（`fs.watchFile`），发现 token 被吊销后，立即以 `revoked`（关闭码 4001）断开使用它的连接，之后该 token 握手返回 401。CLI 不需要和 hub 通信，只需和 hub 使用同一个 `HUB_DATA_DIR`。
- 新签发的 token 同样在约 1 秒内对运行中的 hub 生效，无需重启。
- `pnpm token` 运行的是编译产物，首次使用前先 `pnpm build`。

## 数据

`data/hub.json` 保存 token（名称、SHA-256、创建时间、是否已吊销）与机器档案（machineId、名称、版本、token 名、最后在线时间）。hub 与 CLI 读改写时用 `hub.json.lock` 互斥，并先写临时文件再 rename，保证文件始终完整。会话列表只在内存中，hub 重启后由客户端重连时重新上报。

## 自签证书

局域网 / 个人使用可以用 openssl 一行生成自签证书（把 `hub.lan` 和 IP 换成客户端实际填写的地址）：

```sh
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 3650 -subj "/CN=hub.lan" -addext "subjectAltName=DNS:hub.lan,IP:192.168.1.10"
```

> Git Bash 下需在命令前加 `MSYS_NO_PATHCONV=1`，否则 `-subj "/CN=…"` 会被改写成 Windows 路径。

自签证书需要让客户端机器信任：在每台 Windows 机器上把 `cert.pem` 导入「受信任的根证书颁发机构」（管理员权限运行 `certutil -addstore -f Root cert.pem`）。有域名时更推荐用 Let's Encrypt 等正式证书。

## 客户端配置

在 Tether 设置 → 管理服务器中：

- **服务器地址**：`<IP 或域名>:<端口>`，如 `192.168.1.10:8443`；也可填完整 URL `wss://hub.example.com:8443`。客户端自动连接 `/agent` 路径，地址里不用写。未写端口时 wss 默认 443，所以使用默认 `HUB_PORT=8443` 时必须写上端口。
- **token**：`pnpm token create` 打印的那一串（`th_` 开头）。
- hub 以 `HUB_INSECURE=1` 明文运行时，客户端须勾选「允许明文连接（仅限局域网调试）」并填写 `ws://` 地址。

填写后可点「测试连接」验证。

## Web 界面

- 按机器分组列出会话：机器名、在线 / 离线、最后在线时间、版本；会话的名称、cwd、远程主机、状态、Claude 状态、最后活动时间。
- Claude 处于「等待确认」的会话高亮显示，有这类会话的机器排在最前，浏览器标签标题显示等待数。
- 通过 SSE（`/api/events`）实时更新，断线自动重连；登录失效时回到登录页。
- 登录会话为内存中的随机 token，cookie 为 HttpOnly + SameSite=Strict（https 下加 Secure），有效期 7 天，hub 重启后需重新登录。
- 登录失败限流：同一 IP 连续失败 5 次锁定 5 分钟。限流按 TCP 对端地址计算，放在反向代理后面时所有请求会共用代理的地址。

## 安全要点

- WebSocket `/agent` 用 `Authorization: Bearer <token>` 认证，失败返回 HTTP 401 且不升级。
- 单条消息上限 1 MB（超出以 1009 关闭）；连接后 10 s 内未收到合法 hello 以 `bad_hello`（4003）关闭。
- hub 每 25 s 发送 ping，一个周期内未收到 pong 的连接被断开。
- Web API 全部要求登录；页面带 CSP（只允许同源脚本 / 样式）。

## 开发

```sh
pnpm build          # tsc
pnpm test           # node:test（通过 tsx 运行）
pnpm dev            # 直接运行源码
pnpm test-client ws://127.0.0.1:8443/agent <token> [停留秒数]   # 模拟 daemon 走一遍 hello / sessions 流程
```

目录：`src/`（`main.ts` 入口、`server.ts` 组装、`agents.ts` daemon 连接、`web.ts` Web API 与 SSE、`store.ts` 持久化、`token-cli.ts` token 命令行）、`public/`（单页界面）、`test/`、`scripts/test-client.ts`。

## 许可证

[Apache-2.0](LICENSE)
