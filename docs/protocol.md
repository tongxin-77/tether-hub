# daemon ↔ hub 协议（v2）

> v1：机器接入（H-1.1 ~ H-1.5）与会话汇总（H-2.1 ~ H-2.3）。v2 增加远程接管（H-3，见第 6 节）与接管审计（H-4.1，见第 7 节）；之后通过能力位（第 8 节）增加接管回看历史、贴图与网页关闭会话（hub 0.4.0 / Tether 0.5.0），`proto` 仍为 2。
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
- `caps`（可选，见第 8 节）：客户端支持的能力名数组，如 `["history","image","close"]`。
- 字段约束：`proto` 必须是数字（缺失或非数字按 `bad_hello`）；`machineId` 1–64 字符，`machineName`、`version` 不超过 256 字符，超出按 `bad_hello`。`caps` 不是字符串数组或超过 16 项时按空集处理，不断开。

**sessions**（收到 `welcome` 后立即发一次；之后在本地 GUI 侧栏刷新会话列表的同一时机发送全量，500 ms 防抖；单纯的终端输出（只改变 `lastActivityAt`）不触发上报，见 H-2.2）

```json
{ "type": "sessions", "sessions": [ /* proto::SessionInfo 原样序列化 */ ] }
```

`SessionInfo` 即本地管道协议中的结构（`id`、`name`、`cwd`、`command`、`status`、`startedAt`、`lastActivityAt`、`host`、`hostId`、`claude`），不含任何终端内容。

### 2.2 下行（hub → daemon）

**welcome**（hub 校验 hello 通过后回复）

```json
{ "type": "welcome", "proto": 2, "hubVersion": "0.4.0", "caps": ["history", "image", "close", "create"] }
```

`caps`：hub 支持的能力名（第 8 节），旧 hub 不带。

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
- hub 连接断开时 daemon 结束该连接上的全部接管（无需发消息）；会话退出或被本地关闭时 daemon 发 `detached`（`reason: "exited"`）。
- 终端查询（CPR、DA 等）的应答仍由本地 GUI 或 daemon 负责；hub 网页端的 xterm 不把自动应答作为 `input` 发送，避免多个查看者重复应答。
- 探测连接（`probe: true`）上 hub 不发 `attach`，daemon 收到也拒绝。

### 6.2 下行（hub → daemon）

```json
{ "type": "attach", "sessionId": 3 }
{ "type": "input", "sessionId": 3, "data": "bHMK" }
{ "type": "resize", "sessionId": 3, "cols": 120, "rows": 30 }
{ "type": "detach", "sessionId": 3 }
```

- `sessionId` 即 `SessionInfo.id`。
- `input.data`：base64 编码的原始字节（注意本地管道 `Input` 的 `data` 是明文字符串，编码不同）。
- 未处于接管中的会话收到 `input` / `resize` / `detach` 一律忽略。`cols`、`rows` 取 1–1000，超出忽略。

### 6.3 上行（daemon → hub）

```json
{ "type": "attached", "sessionId": 3, "cols": 120, "rows": 30, "snapshot": "<base64>", "history": "<base64>" }
{ "type": "attachDenied", "sessionId": 3, "reason": "disabled" }
{ "type": "output", "sessionId": 3, "data": "<base64>" }
{ "type": "detached", "sessionId": 3, "reason": "reclaimed" }
```

- `attached`：接管成功。`snapshot` 为 vt100 `state_formatted()` 的 base64（与本地管道 `Snapshot` 相同），`cols`/`rows` 为当前终端尺寸。之后该会话的每块 PTY 输出都以 `output` 推送（base64，与本地管道 `Output` 相同）。`history` 可选，仅双方都有能力 `history` 时带（见 8.2）。
- `attachDenied.reason`：`disabled`（本机未允许接管）/ `not_found`（会话不存在或已退出）/ `probe`（探测连接）。重复 `attach` 已接管的会话时按成功处理，重新发一次 `attached`（含新快照）。
- `detached.reason`：`reclaimed`（本地收回）/ `disabled`（本地关闭了允许接管）/ `exited`（会话已退出）。hub 主动 `detach` 的不回 `detached`。

## 7. 接管审计（v2，hub 侧）

hub 将接管事件逐行追加到 `HUB_DATA_DIR/audit.jsonl`，每行一个 JSON：

```json
{ "time": "2026-11-15T13:50:00.000Z", "event": "start", "machineId": "…", "machineName": "DEV-PC", "sessionId": 3, "sessionName": "pwsh", "ip": "192.168.1.20" }
```

`event`：`start`（浏览器发起接管且 daemon 回 `attached`）/ `denied`（附 `reason`）/ `end`（hub 侧结束：最后一个浏览器离开）/ `reclaimed`（本地收回）/ `disabled` / `exited` / `disconnected`（机器断线导致结束）。`ip` 为发起或最后离开的浏览器来源 IP（有则记）。Web 界面可查看最近的审计记录。

贴图（第 8.3 节）另记 `image`（成功，附 `bytes`、`mime`、`ip`）与 `image_failed`（附 `reason`：daemon 回的原因，或 hub 侧的 `timeout` / `ended`），不记保存路径、不存图片。网页关闭会话（第 8.4 节）记 `close`（成功）与 `close_failed`（附 `reason`：daemon 回的原因，或 hub 侧的 `timeout` / `disconnected`）。网页新建会话（第 8.5 节）记 `create`（成功，附新会话 `sessionId` / `sessionName`、目标摘要 `target`、`ip`）与 `create_failed`（附 `target`、`ip`、`reason`：daemon 回的原因，或 hub 侧的 `timeout` / `disconnected`；无 `sessionId`）。

## 8. 能力位（v2）

### 8.1 协商

- `hello.caps` 与 `welcome.caps` 均为字符串数组，可缺省（= 空集），未知能力名忽略。`proto` 保持 2。
- 双方只使用两边都声明的能力。当前能力名：`history`、`image`、`close`、`create`。
- 旧 hub（`welcome` 无 `caps`）→ Tether 不发 history、不期待图片；新 hub + 旧 Tether（`hello` 无 `caps`）→ hub 记为空集，网页无历史、贴图按钮置灰提示「需 Tether 0.5.0+」。两种情况都不断开。
- hub 的 `/agent` 单条消息上限为 4 MB（浏览器 `/api/term` 仍为 1 MB）。

### 8.2 历史 history

- `attached` 增加可选字段 `history`（base64），仅双方都有 `history` 时才带。
- 解码后是可直接写入 xterm 的字节流：
  1. 历史各行（每行 SGR 着色、行首自带属性复位；行间 `\r\n`；自动折行的行与下一行之间不插 `\r\n`）；
  2. 接着 `rows` 个 `\r\n`，把历史全部推入 scrollback；
  3. 若会话当前在备用屏，末尾追加 `\x1b[?1049h`。
- 会话尚无历史时仍可带 `history`：可能为空串，或备用屏时仅 `\x1b[?1049h`，此时不追加 `rows` 个 `\r\n`。hub 与浏览器须接受空串。
- 浏览器顺序：reset → resize(cols, rows) → write(history) → write(snapshot)。hub 把 `history` 原样放进给浏览器的 `snapshot` 消息。
- 上限：Tether 每会话环形缓冲 ≤ 5000 行且 ≤ 2 MB；`attached` 发送最近 ≤ 3000 行且原始字节 ≤ 1 MB，从最旧端截断。备用屏产生的行不进历史；遇到 `\x1b[3J` 清空历史（需处理跨块）。

### 8.3 贴图 image（仅本地会话）

浏览器把图片上传到 hub（`POST /api/term/image`，见 [internals.md](internals.md)），hub 分块转给 daemon，daemon 保存为临时文件后把路径作为输入写入该会话。

下行（hub → daemon），每块原始 ≤ 256 KB，base64：

```json
{ "type": "imageBegin", "sessionId": 3, "uploadId": "<随机串>", "mime": "image/png", "size": 834211 }
{ "type": "imageChunk", "sessionId": 3, "uploadId": "…", "data": "<base64>" }
{ "type": "imageEnd", "sessionId": 3, "uploadId": "…" }
```

上行（daemon → hub）：

```json
{ "type": "imageSaved", "sessionId": 3, "uploadId": "…", "path": "C:\\Users\\a\\AppData\\Local\\Temp\\tether-img\\<uuid>.png" }
{ "type": "imageFailed", "sessionId": 3, "uploadId": "…", "reason": "unsupported" }
```

- `mime` ∈ `image/png`、`image/jpeg`、`image/gif`、`image/webp`。
- daemon 可在 `imageBegin` 时提前校验并立即回 `imageFailed`（早于 `imageEnd`），此后该 `uploadId` 的 chunk / end 被忽略；hub 收到即结束该上传并停止发送剩余分块。`imageChunk` 的 base64 无法解码时 daemon 回 `io`。
- `imageFailed.reason`：`disabled`（本机未允许接管）/ `not_taken_over`（会话未被 hub 接管）/ `unsupported`（SSH 等非本地会话）/ `too_large`（累计 > 10 MB 或与 `size` 不符）/ `bad_type`（文件头 magic 不是声明的类型）/ `io`（写文件失败）。
- daemon：组装上传（单个上传 60 s 超时、累计 > 10 MB 丢弃；detach / 断线清理）；保存到 `%TEMP%\tether-img\<uuid>.<ext>`（create_new）；启动时及每小时删除超过 24 h 的文件；然后把路径作为输入写入该会话：路径含空格时 Windows 用双引号包裹；会话处于 bracketed paste 模式时包 `\e[200~…\e[201~`；不追加回车。
- daemon 侧上传超过 60 s 未完成则静默丢弃，由 hub 的 60 s 超时返回 504。
- hub：等待回复 60 s 超时；接管结束或断线时放弃等待；未知 `reason` 显示为「贴图失败（<reason>）」。

### 8.4 网页关闭会话 close

```json
{ "type": "close", "sessionId": 3, "requestId": "<随机串>" }
{ "type": "closeResult", "sessionId": 3, "requestId": "…", "ok": true }
{ "type": "closeResult", "sessionId": 3, "requestId": "…", "ok": false, "reason": "disabled" }
```

- `close` 为 hub → daemon，`closeResult` 为 daemon → hub。
- `reason`：`disabled`（本机未开启「允许 hub 远程接管本机会话」，复用该开关，不新增设置）/ `not_found`（会话不存在或已退出）。
- 不要求该会话正被接管。daemon 用与本地 UI「关闭会话」相同的路径结束会话（本地会话结束进程树、SSH 会话关闭通道），之后照常通过 `sessions` 上报（该会话从列表中消失，与本地 UI 关闭一致）；若正被接管，先发 `detached`（`reason: "exited"`）再发 `closeResult`。hub 对此 `detached` 照常记审计 `exited`，并告知浏览器 `session_closed`；`closeResult` 另记 `close`。
- hub：等待回复 10 s 超时；断线时放弃等待。

### 8.5 网页新建会话 create

网页在某台在线机器上新建会话：本地会话（可选目录）、SSH 会话（选主机，可选目录）、恢复 Claude 历史对话（仅本地）。建好后网页直接接管该会话；桌面端侧栏出现新会话但不切换过去。以下三组消息都属于能力 `create`，均为 hub → daemon 请求、daemon → hub 回复，以 `requestId`（hub 生成的随机串）关联。权限复用「允许 hub 远程接管本机会话」开关，关闭时一律回 `ok: false, reason: "disabled"`。

**1. 取新建选项**

```json
{ "type": "createOptions", "requestId": "<随机串>" }
{ "type": "createOptionsResult", "requestId": "…", "ok": true,
  "home": "C:\\Users\\x",
  "recent": [{ "kind": "local", "cwd": "C:\\work\\a" }, { "kind": "remote", "hostId": "h1", "host": "dev", "cwd": "/srv" }],
  "hosts": [{ "id": "h1", "name": "dev" }] }
{ "type": "createOptionsResult", "requestId": "…", "ok": false, "reason": "disabled" }
```

- `home`：本机用户目录（网页作为目录占位提示）。
- `recent`：最近目录（最多 20 条，新的在前）；`remote` 项带 `hostId` 与 `host`（显示名），对应主机已不存在的不列出。
- `hosts`：已配置的 SSH 主机 id 与显示名。

**2. 列出 Claude 历史对话（仅本地目录）**

```json
{ "type": "claudeHistory", "requestId": "…", "cwd": "C:\\work\\a" }
{ "type": "claudeHistoryResult", "requestId": "…", "ok": true,
  "items": [{ "id": "<uuid>", "title": "…", "mtime": 1731800000000, "messages": 12, "permissionMode": "acceptEdits", "bypass": false, "open": false }] }
```

- 数据与桌面端「恢复 Claude 对话…」相同；`open` 为已有会话正在运行该对话。最多 50 条，按 `mtime`（毫秒）新到旧。
- 失败：`ok: false` + `reason`（`disabled` / `error`）+ 可选 `message`。

**3. 新建**

```json
{ "type": "create", "requestId": "…", "target": { "kind": "local", "cwd": "C:\\work\\a" },
  "resume": { "id": "<uuid>", "permissionMode": "acceptEdits", "bypass": false }, "cols": 120, "rows": 32 }
{ "type": "createResult", "requestId": "…", "ok": true, "sessionId": 7 }
{ "type": "createResult", "requestId": "…", "ok": false, "reason": "auth_required", "message": "需要密码，请先在桌面端连接一次或配置密钥" }
```

- `target`：`{ "kind": "local", "cwd"?: string }` 或 `{ "kind": "remote", "hostId": string, "cwd"?: string }`；`cwd` 缺省或空 = 用户目录（远程为登录目录）。
- `resume` 仅 `local` 有效，可省略。`cols` / `rows`（1–1000）可省略，daemon 默认 120×32；hub 网页当前不带，接管后按网页终端实际尺寸 `resize`。
- `reason`：`disabled` / `not_found`（`hostId` 不存在）/ `auth_required`（SSH 需要密码 / 口令 / 确认主机指纹：hub 发起的新建不弹任何提示，直接失败，`message` 给出可读说明）/ `error`（其他失败，`message` 说明）。
- 成功回复前 daemon 已通过 `sessions` 上报新会话，但不让桌面端切换到它。

hub：
- `createOptions` / `claudeHistory` 等待回复 10 s 超时，`create` 30 s 超时（远程连接较慢）；断线时放弃等待。按 `requestId` 与回复 `type` 匹配，不符的回复忽略。
- 转给浏览器前只保留上述已知字段；未知 `reason` 显示为「操作失败（<reason>）」，有 `message` 时接在原因后显示。
