# daemon ↔ hub 协议（v2）

> v1：机器接入（H-1.1 ~ H-1.5）与会话汇总（H-2.1 ~ H-2.3）。v2 增加远程接管（H-3，见第 6 节）与接管审计（H-4.1，见第 7 节）。
> v1 未发布，hub 与客户端都只支持 `proto: 2`。
> 需求见 [requirements.md](requirements.md)。hub 与客户端各自实现，以本文档为准；改动协议须同时改本文档并递增 `proto`。

## 1. 连接

- 地址：客户端设置中填写 **服务器地址**，形如 `192.168.1.10:8443`、`hub.example.com` 或完整 URL `wss://hub.example.com:8443`。
  - 未写协议时默认 `wss://`；客户端勾选「允许明文连接」时默认 `ws://`。未写端口时 wss 用 443、ws 用 80。
  - 客户端连接路径固定为 `/agent`，即 `wss://<host>:<port>/agent`。
- **TLS**：默认只允许 `wss://`。`ws://` 明文仅在客户端勾选「允许明文连接（仅限局域网调试）」时可用；hub 未配置证书时须显式开启 `HUB_INSECURE=1` 才以明文监听。
- **认证**：WebSocket 握手请求带 HTTP 头 `Authorization: Bearer <token>`。token 无效时 hub 以 HTTP 401 拒绝握手（不升级）。
- **心跳**：hub 每 25 s 发 WebSocket ping 帧，一个周期内未收到 pong 即断开该连接；客户端 60 s 内未收到任何帧（含 ping）即判定断线。客户端回 pong 由 WebSocket 库自动完成。
- **重连**：客户端断线后指数退避重连：1 s、2 s、4 s … 上限 60 s，加 ±20% 抖动；连接成功并收到 `welcome` 后退避归零。401、`proto_unsupported`、`replaced` 时不自动重连，状态显示失败原因，等用户修改设置或手动重新启用（`replaced` 通常意味着两台机器的 `machine-id` 相同，例如克隆的虚拟机；自动重连会导致两边互相顶替）。

## 2. 消息

文本帧，每帧一个 JSON 对象，`type` 区分。字段 camelCase。

### 2.1 上行（daemon → hub）

**hello**（连接建立后第一条，必须）

```json
{ "type": "hello", "proto": 2, "machineId": "9f1c…", "machineName": "DEV-PC", "version": "0.4.0", "probe": false }
```

- `machineId`：稳定机器 ID。daemon 首次需要时生成 UUID v4，保存在 `%APPDATA%\tether\machine-id`（dev 构建为 `tether-dev`），之后不变。
- `machineName`：`COMPUTERNAME` 环境变量。
- `version`：Tether 版本。
- `probe`（可选，默认 `false`）：`true` 表示这是「测试连接」的探测连接。hub 照常校验并回 `welcome`，但**不登记、不替换**同一 `machineId` 的常驻连接，也不更新机器档案；探测连接随后由客户端关闭，hub 收到 `sessions` 时忽略。
- 字段约束：`proto` 必须是数字（缺失或非数字按 `bad_hello`）；`machineId` 1–64 字符，`machineName`、`version` 不超过 256 字符，超出按 `bad_hello`。

**sessions**（收到 `welcome` 后立即发一次；之后在本地 GUI 侧栏刷新会话列表的同一时机发送全量，500 ms 防抖；单纯的终端输出（只改变 `lastActivityAt`）不触发上报，见 H-2.2）

```json
{ "type": "sessions", "sessions": [ /* proto::SessionInfo 原样序列化 */ ] }
```

`SessionInfo` 即本地管道协议中的结构（`id`、`name`、`cwd`、`command`、`status`、`startedAt`、`lastActivityAt`、`host`、`hostId`、`claude`），不含任何终端内容。

### 2.2 下行（hub → daemon）

**welcome**（hub 校验 hello 通过后回复）

```json
{ "type": "welcome", "proto": 2, "hubVersion": "0.1.0" }
```

**error**（随后 hub 关闭连接）

```json
{ "type": "error", "code": "proto_unsupported", "message": "hub 仅支持协议 2" }
```

| code | 含义 | 关闭码 |
|------|------|--------|
| `proto_unsupported` | `proto` 不兼容 | 4002 |
| `bad_hello` | 首条消息不是合法 hello，或 10 s 内未收到 hello | 4003 |
| `replaced` | 同一 `machineId` 有新连接，旧连接被替换 | 4004 |
| `revoked` | 所用 token 已被吊销 | 4001 |

未知 `type` 的消息双方都忽略，便于独立升级。

## 3. 测试连接（客户端设置）

客户端「测试连接」用当前填写的地址 / token / 明文开关新建一条独立连接：握手 → 发 hello（`probe: true`）→ 等 welcome（总超时 10 s）→ 立即关闭，不发 sessions，不影响已有的常驻连接。结果按阶段区分：地址无效、DNS 解析失败、TCP 连接失败 / 超时、TLS 失败（证书不受信任等）、认证失败（401）、协议不兼容、超时未收到 welcome、成功（耗时 ms，附 hubVersion）。

## 4. 状态

客户端显示的 hub 连接状态：`disabled`（未启用）/ `connecting`（连接中 / 退避等待中）/ `connected` / `failed`（附原因；401 与协议不兼容时停在此状态）。

## 5. hub 侧

- token：由 hub 管理员用命令行签发 / 列出 / 吊销；每台机器一个 token，hub 只保存 token 的 SHA-256。吊销后已连接的机器立即以 `revoked` 断开。
- 机器：以 `machineId` 识别，记录名称、版本、所用 token 名、在线状态、最后在线时间、最近一次上报的会话列表（仅内存，离线后保留列表并标记为离线）。
- Web 界面与 Web API 需管理员登录，与机器 token 分离。

## 6. 远程接管（v2）

### 6.1 规则

- 客户端设置「允许 hub 远程接管本机会话」（`Config.hub.allowTakeover`，**默认关闭**）。关闭时一律拒绝接管；接管期间关闭开关，立即结束本机所有接管（`detached`，`reason: "disabled"`）。
- 接管前链路上没有任何终端内容。hub 发 `attach` 后 daemon 才开始推送：先屏幕快照，再实时输出。
- 一个会话在一条 hub 连接上最多一个接管。hub 侧多个浏览器查看同一会话时由 hub 复用这一个接管（引用计数），最后一个浏览器离开时 hub 发 `detach`。
- 接管期间 hub 的 `input` / `resize` 与本地 GUI 的输入 / resize 同等对待，尺寸以最后一次 resize 为准。
- 本地 GUI 对被接管的会话显示「hub 接管中」标识与「收回」按钮；收回即结束该接管（`detached`，`reason: "reclaimed"`），hub 网页显示「已被本地收回」，不自动重新接管，用户可在网页再次手动接管。
- hub 连接断开时 daemon 结束该连接上的全部接管（无需发消息）；会话退出时 daemon 发 `detached`（`reason: "exited"`）。
- 探测连接（`probe: true`）上 hub 不发 `attach`，daemon 收到也拒绝。

### 6.2 下行（hub → daemon）

```json
{ "type": "attach", "sessionId": 3 }
{ "type": "input", "sessionId": 3, "data": "bHMK" }
{ "type": "resize", "sessionId": 3, "cols": 120, "rows": 30 }
{ "type": "detach", "sessionId": 3 }
```

- `sessionId` 即 `SessionInfo.id`。
- `input.data`：base64 编码的原始字节（与本地管道 `Input` 的 `data` 相同编码）。
- 未处于接管中的会话收到 `input` / `resize` / `detach` 一律忽略。`cols`、`rows` 取 1–1000，超出忽略。

### 6.3 上行（daemon → hub）

```json
{ "type": "attached", "sessionId": 3, "cols": 120, "rows": 30, "snapshot": "<base64>" }
{ "type": "attachDenied", "sessionId": 3, "reason": "disabled" }
{ "type": "output", "sessionId": 3, "data": "<base64>" }
{ "type": "detached", "sessionId": 3, "reason": "reclaimed" }
```

- `attached`：接管成功。`snapshot` 为 vt100 `state_formatted()` 的 base64（与本地管道 `Snapshot` 相同），`cols`/`rows` 为当前终端尺寸。之后该会话的每块 PTY 输出都以 `output` 推送（base64，与本地管道 `Output` 相同）。
- `attachDenied.reason`：`disabled`（本机未允许接管）/ `not_found`（会话不存在或已退出）/ `probe`（探测连接）。重复 `attach` 已接管的会话时按成功处理，重新发一次 `attached`（含新快照）。
- `detached.reason`：`reclaimed`（本地收回）/ `disabled`（本地关闭了允许接管）/ `exited`（会话已退出）。hub 主动 `detach` 的不回 `detached`。

## 7. 接管审计（v2，hub 侧）

hub 将接管事件逐行追加到 `HUB_DATA_DIR/audit.jsonl`，每行一个 JSON：

```json
{ "time": "2026-11-15T13:50:00.000Z", "event": "start", "machineId": "…", "machineName": "DEV-PC", "sessionId": 3, "sessionName": "pwsh", "ip": "192.168.1.20" }
```

`event`：`start`（浏览器发起接管且 daemon 回 `attached`）/ `denied`（附 `reason`）/ `end`（hub 侧结束：最后一个浏览器离开）/ `reclaimed`（本地收回）/ `disabled` / `exited` / `disconnected`（机器断线导致结束）。`ip` 为发起或最后离开的浏览器来源 IP（有则记）。Web 界面可查看最近的审计记录。
