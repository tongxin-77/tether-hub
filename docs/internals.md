# 实现细节

> 面向维护者与想了解内部行为的读者；部署与使用见 [README](../README.md)，daemon ↔ hub 协议见 [protocol.md](protocol.md)。

## Web 界面

- 主从布局：左侧机器列表（可按名称 / token 搜索；在线 / 离线、版本、等待确认数），右侧机器信息与会话表（名称、命令、cwd、远程主机、状态、Claude 状态、开始 / 最后活动时间）。手机上为「机器列表 → 机器详情」两级页面。
- 浅 / 深色主题，默认跟随系统，可在顶栏切换（记在浏览器本地）。
- Claude 处于「等待确认」的会话高亮显示，顶部汇总提醒可一键跳到对应机器；有这类会话的机器排在最前，浏览器标签标题显示等待数。
- 通过 SSE（`/api/events`）实时更新，断线自动重连，顶栏显示连接状态；登录失效时回到登录页。
- 登录会话为内存中的随机 token，cookie 为 HttpOnly + SameSite=Strict（https 下加 Secure），有效期 7 天，hub 重启后需重新登录。
- 登录失败限流：同一 IP 连续失败 5 次锁定 5 分钟。限流按 TCP 对端地址计算，放在反向代理后面时所有请求会共用代理的地址。

## 远程接管

- 前提：客户端设置中开启「允许 hub 远程接管本机会话」（默认关闭；关闭时网页显示「本机未允许接管」）。
- 在线机器的未退出会话旁有「接管」按钮，点击后打开全屏终端页（xterm.js）：先显示屏幕快照，再接实时输出；键入、粘贴（支持多行）会发送到会话，窗口尺寸变化会同步 resize。有选区时 Ctrl+C 复制，Ctrl+V 粘贴。手机上点终端唤起软键盘，单指滑动滚动历史（全屏程序中发送方向键），底部按键条提供 Esc / Tab / Ctrl（一次性粘滞）/ 方向键 / 粘贴 / 图片。
- 触屏点选选项：Claude Code 等弹出编号选项列表（`❯ 1. Yes` / `2. …` / `3. No`）时，轻点某一项（含其折行或缩进续行）即从当前选中项发 ↑ / ↓（遵循应用光标键模式）移到该项再发回车，不依赖数字键；被点行短暂高亮，不弹出键盘。只在点按时检测：视口内编号从 1 连续、至少 2 项、恰一项带 `❯` / `>` 标记，取最靠下的一组；滚离底部、接管未生效、滑动或按停惯性的触摸不处理；点在其他位置保持原行为。桌面鼠标点击不变。
- 回看历史（Tether 0.5.0+，能力 `history`）：接管时先写入 Tether 保存的历史（最多 3000 行），再写快照，可向上滚动查看接管前的输出；xterm scrollback 为 10000 行。全屏程序（备用屏）中滑动仍按全屏程序规则发方向键 / 滚轮。
- 粘贴键：安全上下文（https 或 localhost）下直接读剪贴板（`clipboard.read()`，只有图片时走贴图，否则 `term.paste` 文本）；明文 http、无权限或读取失败时打开粘贴弹层，手动粘贴后发送（同样走 `term.paste`：换行转回车，程序开启括号粘贴模式时自动包裹）。
- 贴图（Tether 0.5.0+，能力 `image`，仅本地会话）：「图片」键选择图片（手机上由系统给出相册 / 拍照），或在终端里 Ctrl+V 粘贴只含图片的剪贴板（截图）；上传后 Tether 保存为临时文件并把路径输入到会话（不回车），终端顶部提示「已插入图片路径」或失败原因。机器的 Tether 不支持、SSH 会话时「图片」键置灰，点按提示原因。剪贴板同时有文本与图片时（如从 Office 复制）按文本粘贴。
- 同一会话可在多个浏览器同时打开，hub 只向 daemon 发一次接管（新加入的浏览器会再发一次 `attach` 取得新快照），最后一个浏览器关闭时 hub 发 `detach`，daemon 停止推送。
- 结束原因显示在终端上方：已被本地收回 / 本机未允许接管 / 会话已退出 / 机器离线 / 连接已断开，终端转为只读。结束后不会自动重新接管；被本地收回、机器离线或连接中断时可点「重新接管」。关闭终端页即断开接管。

### 浏览器终端 WebSocket

`/api/term?machine=<machineId>&session=<sessionId>`，需管理员登录 cookie，且 `Origin` 须与 `Host` 同源，否则以 401 / 403 拒绝升级。文本帧 JSON，终端数据均为 base64 原样透传：

| 方向 | 消息 |
|------|------|
| 下行 | `{"type":"snapshot","cols":120,"rows":30,"data":"<base64>","history":"<base64>"}` 接管成功时的屏幕快照（每个浏览器一次）；`history` 仅 daemon 带了时才有，浏览器按 reset → resize → 写 history → 写 data 的顺序处理 |
| 下行 | `{"type":"output","data":"<base64>"}` 实时输出 |
| 下行 | `{"type":"detached","reason":"reclaimed\|disabled\|exited\|offline\|session_closed"}` 接管结束，随后 hub 关闭连接；`session_closed` 表示会话被网页关闭（daemon 回 `detached(exited)` 时该会话有进行中的关闭请求） |
| 下行 | `{"type":"denied","reason":"disabled\|not_found\|probe"}` 接管被拒，随后 hub 关闭连接 |
| 上行 | `{"type":"input","data":"<base64>"}`、`{"type":"resize","cols":120,"rows":30}`（1–1000），收到快照前发送的会被忽略 |

机器状态（`/api/state`、SSE `state`）中每台机器带 `caps`：本次连接 hello 声明且 hub 也支持的能力（离线时为空），前端据此决定贴图键是否可用。

### 网页关闭会话

机器详情中运行中的会话旁有「关闭」按钮，页内二次确认后调用 `POST /api/session/close?machine=<machineId>&session=<sessionId>`（需登录且同源）：成功 200 `{"ok":true}`，该会话随后从 Tether 上报的会话列表中消失；正在查看该会话终端的浏览器关闭终端页，回到机器页并提示「会话「名称」已关闭」；机器离线或 Tether 无 `close` 能力 409；daemon 回 `ok:false` 时 422 `{"error":"…","reason":"disabled|not_found"}`；10 s 未回复 504；等待中断线 409。无 `close` 能力或离线时按钮置灰并说明原因；hub 不知道本机是否允许接管，未允许时由 422 的原因提示。实现见 `Web.closeSession` 与 `Agents.closeSession`。

### 网页新建会话

机器详情会话卡片头的「新建会话」按钮（机器离线或 Tether 无 `create` 能力时置灰并说明原因）打开对话框：本地 / SSH、目录（可从最近目录选，留空 = 用户目录）、本地时可勾选「恢复 Claude 对话」按目录列出历史对话。接口（均需登录，POST 需同源）：

- `GET /api/create-options?machine=<machineId>` → 200 `{"home":"…","recent":[…],"hosts":[…]}`。
- `GET /api/claude-history?machine=<machineId>&cwd=<目录>` → 200 `{"items":[…]}`；`cwd` 必填（网页留空时传 `home`）。
- `POST /api/session/create?machine=<machineId>`，JSON 请求体 `{"target":{…},"resume"?:{…},"cols"?:n,"rows"?:n}`（格式见协议第 8.5 节；只转发已知字段，`resume` 仅 `local`）→ 200 `{"sessionId":7}`。

错误码与关闭会话一致：参数 / 请求体错误 400、非 JSON 415、机器离线或无 `create` 能力 409、daemon 回 `ok:false` 时 422 `{"error":"…","reason":"…"}`、超时 504（10 s / 10 s / 30 s）、等待中断线 409。新建成功后网页等该会话经 SSE 出现在列表中（最多 10 s）再直接打开终端接管。实现见 `Web.createSession` 等与 `Agents.createSession` / `createOptions` / `claudeHistory`。

### 贴图接口

`POST /api/term/image?machine=<machineId>&session=<sessionId>`，请求体为原始图片，需登录且 `Origin` 与 `Host` 同源。实现见 `Web.image` 与 `Agents.uploadImage`。

| 状态 | 情况 |
|------|------|
| 200 `{"path":"…"}` | daemon 回 `imageSaved`，路径已输入到会话 |
| 400 | 参数错误或请求体为空 |
| 401 / 403 | 未登录 / 跨源 |
| 413 | 超过 10 MB（先看 `Content-Length`，再边读边限） |
| 415 | `Content-Type` 不是 `image/png`、`image/jpeg`、`image/gif`、`image/webp` |
| 409 | 机器离线、该机器 Tether 无 `image` 能力（需 0.5.0+）、该会话没有生效的接管，或等待期间接管结束 / 断线 |
| 422 `{"error":"…","reason":"…"}` | daemon 回 `imageFailed`，`reason` 见协议 8.3，`error` 为中文说明 |
| 504 | 60 s 内 daemon 未回复 |

hub 按 256 KB 分块发 `imageChunk`，每块等写入 socket，WebSocket 发送缓冲超过 1 MB 时暂停，避免大图拖慢同一连接上的终端输出。

## 检查更新与一键更新

实现在 `src/update.ts`（`Updater`），由 `server.ts` 创建并交给 `Web`。

- **检查**：`GET HUB_UPDATE_API`（默认 `https://api.github.com/repos/tongxin-77/tether-hub/releases/latest`，15 s 超时），只认 `vX.Y.Z` 形式的 `tag_name`，草稿 / 预发布 / 其他格式视为无法识别；与 `package.json` 的 `version` 按语义化版本比较。启动时与每 6 小时自动检查（`HUB_UPDATE_CHECK=0` 关闭），失败（网络、限流 403 / 429、超时）只记录 `error`，保留已知的新版本，不影响 hub。
- **接口**（均需登录；POST 另要求 `Origin` 与 `Host` 同源，否则 403）：
  - `GET /api/update` → `{current, latest?, notes?, url?, publishedAt?, checkedAt?, error?, state, log?, takeovers}`；`state` 为 `idle | checking | available | updating | done | failed`，`takeovers` 为进行中的接管数（前端据此二次确认）。
  - `POST /api/update/check` → 202，异步检查。
  - `POST /api/update/apply` → 202；仅当 `state` 为 `available` / `failed` 且最新版本更高时可用，否则 409（同一时间只允许一个更新）。
  - 状态变化通过 SSE `/api/events` 的 `update` 事件推送（连接建立时也推送一次）。
- **apply 步骤**（任一步失败即停止）：
  1. 下载 `tarball_url`（跟随重定向）到系统临时目录下的 `tether-hub-update-*`；
  2. 系统 `tar -xzf` 解压（以相对路径调用，避免 GNU tar 把 `C:` 当作远程主机），要求恰好一个顶层目录；
  3. 把顶层目录内的文件逐个覆盖到安装目录（`package.json` 所在目录），跳过顶层的 `data/`、`node_modules/`、`certs/`、`.git/`、`dist/`、`.env*` 及位于安装目录内的 `HUB_DATA_DIR`；被覆盖的文件先备份到临时目录，并记录新增的文件；随后备份并清空 `dist/`；
  4. `pnpm install --frozen-lockfile`、`pnpm build`（经 shell 执行，Windows 下可找到 `pnpm.cmd`）；
  5. 成功：`state=done`，约 1 秒后调用 `onUpdated`（`main.ts` 中为正常关闭后 `exit(0)`），由进程管理器拉起新版本。
- **失败回滚**：删除新增文件、恢复备份文件与 `dist/`，若已执行过 `pnpm install` 则按旧 lockfile 再装一次；`state=failed`，`error` 为原因，hub 继续以旧版本运行，可重试。新版本中已删除的旧文件不会被清理（不影响运行）。
- **安装版**（安装目录有 `install.json`，内容 `{"platform":"win-x64"}`，见下节）：检查时还要求 Release 资产中有 `tether-hub-<版本>-<平台>.zip`（Linux 以后为 `.tar.gz`）与 `SHA256SUMS`，缺少时 `state` 仍为 `available` 但不可 apply，`error` 提示到发布页下载安装包。apply 步骤：
  1. 清空并创建安装目录内的 `.update/`（与安装目录同盘，后续才能改名）；下载更新包与 `SHA256SUMS`，SHA256 不符即失败；
  2. 解压（zip 用 `%SystemRoot%\System32\tar.exe`），要求恰好一个顶层目录且其中 `install.json` 的平台与本机一致；
  3. 对包内每个顶层项（`node.exe`、`dist`、`public`、`node_modules`、`package.json` 等）：先把安装目录中的同名项改名移入 `.update/old/`，再把新项改名移入安装目录。运行中的 `node.exe` 不能覆盖或删除，但可以改名；包外的文件（WinSW 及其 XML、卸载程序）不动；
  4. 用新的 `node.exe --check dist/main.js` 检查能否运行；
  5. 失败时按相反顺序换回并删除 `.update/`；成功时旧文件留在 `.update/old/`，下次启动由 `Updater` 删除。
  - 成功后 `main.ts` 以退出码 1 退出：WinSW 2.x 在子进程以 0 退出时向 SCM 报告正常停止，不会重启；非 0 退出则触发服务的失败重启（5 秒后）。
- **日志**：`log` 保留每步标题与命令输出末尾 20 行（总计最多 300 行），供网页显示。
- **审计**：`update_start` / `update_done` / `update_failed` 写入 `audit.jsonl`，字段 `{time, event, from, to, reason?}`。
- **网页**：顶栏按钮显示当前版本，有新版本时变为「有新版本 vX」胶囊（手机上为带红点的图标）；面板显示版本、更新说明（转义后按纯文本显示，保留换行）、发布页链接、检查 / 更新按钮、日志与失败原因。更新完成后面板显示「正在重启…」并每 1.5 s 探测 `/api/me`：旧进程断开后再次连通，或返回 401（新进程中登录会话已失效）即刷新页面；90 s 未恢复则提示可能未配置进程管理器。

## 安装包（Windows）

打包脚本 `scripts/package.ts`（`pnpm build && pnpm package [平台]`，默认 `win-x64`）按平台参数表组装，产物在 `build/out/`：

1. 复制 `dist`、`public`、`package.json`、`LICENSE`，在暂存目录中 `pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted` 得到不含符号链接的生产依赖；写入 `install.json` 与 `tether-hub-token.cmd`；
2. 下载固定版本的官方 Node（`NODE_VERSION`，压缩包 SHA256 写死在脚本中，取自 nodejs.org 的 `SHASUMS256.txt`），只取 `node.exe`；
3. 打成更新包 `tether-hub-<版本>-win-x64.zip`（Windows 自带 bsdtar），顶层目录 `tether-hub-<版本>-win-x64/`；
4. 找到 ISCC（环境变量 `ISCC`、`Program Files (x86)\Inno Setup 6`、`%LOCALAPPDATA%\Programs\Inno Setup 6` 或 PATH）时，下载固定版本并校验 SHA256 的 WinSW 2.12.0（`WinSW-x64.exe`，MIT）与 Inno Setup 简体中文语言文件，用 `packaging/windows/tether-hub.iss` 编译 `tether-hub-<版本>-win-x64-setup.exe`；
5. 为 `build/out/` 下的文件生成 `SHA256SUMS`。下载缓存在 `build/cache/`。

安装程序（Inno Setup 6.5+，需管理员）：

- 程序装到 `{app}`（默认 `C:\Program Files\tether-hub`）：更新包内容 + `tether-hub-service.exe`（WinSW）+ 安装时生成的 `tether-hub-service.xml`（不含密码）。
- `%ProgramData%\tether-hub` 去掉继承权限，只授予 SYSTEM 与 Administrators 完全控制；其中 `config.env` 为服务的环境变量（`HUB_ADMIN_PASSWORD`、`HUB_PORT`、`HUB_DATA_DIR`、`HUB_TLS_CERT` / `HUB_TLS_KEY` 或 `HUB_INSECURE=1`），值按 Node `--env-file` 规则加单引号（含单引号时依次改用反引号、双引号；三种都含的密码会被拒绝）。
- 服务 `tether-hub`（LocalSystem）：`node.exe --env-file=<config.env> dist\main.js`，工作目录为 `%ProgramData%\tether-hub`，开机自动启动，异常退出 5 秒后重启（1 小时重置失败计数），停止时最多等 15 秒，日志在 `logs\`（按 10 MB 滚动，保留 8 个）。
- 防火墙：入站规则「Tether Hub」放行 TCP 端口；升级时按 `config.env` 中的端口重建。
- 升级（`config.env` 已存在）：跳过配置页；安装前 `stopwait` 停止服务，删除旧的 `dist`、`public`、`node_modules`、`.update` 后复制新文件，重写服务 XML，再启动服务。
- 卸载：停止并删除服务、删除防火墙规则与程序目录；交互卸载时询问是否删除 `%ProgramData%\tether-hub`（默认否），静默卸载保留。
- 开始菜单：「打开管理网页」（`http(s)://localhost:<端口>/`）、「Token 命令行」（`tether-hub-token.cmd`：以 `--env-file` 读取 `config.env` 中的 `HUB_DATA_DIR` 后运行 `dist\token-cli.js`；不是管理员时，无参数打开会请求以管理员身份另开窗口）。

发布（`.github/workflows/release.yml`，推送 `v*` tag 触发）：

- `windows` job（`windows-2025`）：校验 tag 与 `package.json` 版本一致 → `pnpm install --frozen-lockfile`、`build`、`test` → 安装固定版本的 Inno Setup（校验 SHA256）→ `pnpm package win-x64` → 冒烟测试：静默安装（明文、端口 8443）、等待服务启动、curl 首页与登录、token 命令行；不带参数再装一次验证升级保留配置；静默卸载并确认服务与防火墙规则已删除、配置保留 → 上传 zip 与 setup.exe 为 artifact。
- `release` job：汇总各平台 artifact，生成 `SHA256SUMS`；Release 已存在则上传 / 覆盖资产，不存在则以 `CHANGELOG.md` 中该版本段为说明创建。
- 以后加 linux-x64：在 `scripts/package.ts` 的平台表中加一项（Node 的 `linux-x64.tar.xz`、systemd 单元等），新增一个构建 job 调用 `pnpm package linux-x64` 并加入 `release` 的 `needs`；`Updater` 对非 `win-` 平台已按 `.tar.gz` 处理。

## 机器 token 管理

网页顶栏「Token」面板，复用 `store.ts` 的 `createToken` / `revokeToken` / `readData`，与命令行读写同一个 `hub.json`。网页吊销后由 `server.ts` 对 `hub.json` 的轮询（同进程写入同样触发）约 1 秒内断开使用该 token 的机器。

- **接口**（均需登录；POST 另要求 `Origin` 与 `Host` 同源，否则 403）：
  - `GET /api/tokens` → `[{name, revoked, createdAt, machines}]`，`machines` 为使用该 token 的机器名，不返回 SHA-256。
  - `POST /api/tokens`，body `{"name":"..."}` → 201 `{name, token}`（明文只此一次）；名称非法或重复（含已吊销的）400。
  - `POST /api/tokens/<URL 编码的名称>/revoke` → 200；不存在 404，已吊销 409。
- **审计**：`token_create` / `token_revoke` 写入 `audit.jsonl`，字段 `{time, event, tokenName, ip}`；命令行操作不记录。

## 接管审计

hub 按协议第 7 节把接管事件追加到 `HUB_DATA_DIR/audit.jsonl`：`start`（开始）、`denied`（被拒，附 `reason`）、`end`（最后一个浏览器离开）、`reclaimed`（本地收回）、`disabled`（本地关闭允许接管）、`exited`（会话退出）、`disconnected`（机器断线），以及贴图 `image`（附 `bytes`、`mime`）/ `image_failed`（附 `reason`：daemon 回的原因，或 `timeout` 超时、`ended` 等待期间接管结束；接口直接返回 409 / 413 / 415 的不记），以及网页关闭会话 `close` / `close_failed`（附 `reason`：`disabled`、`not_found`，或 `timeout` 超时、`disconnected` 等待中断线），以及网页新建会话 `create` / `create_failed`（附目标摘要 `target`；失败附 `reason`，无 `sessionId`）。不记图片路径、不存图片。网页「审计日志」页显示最近 500 条，可按事件、机器、关键字（会话名称 / 来源 IP）筛选；`GET /api/audit?limit=N`（需登录，默认 100，上限 1000）返回最近 N 条，新的在前。

## 数据

`data/hub.json` 保存 token（名称、SHA-256、创建时间、是否已吊销）与机器档案（machineId、名称、版本、token 名、最后在线时间）。hub 与 CLI 读改写时用 `hub.json.lock` 互斥，并先写临时文件再 rename，保证文件始终完整。会话列表只在内存中，hub 重启后由客户端重连时重新上报。

`data/audit.jsonl` 为审计日志，每行一个 JSON（接管、贴图与关闭会话事件：时间、事件、机器、会话、来源 IP，贴图另有字节数、类型，失败事件附原因；更新事件：时间、事件、原版本、目标版本、失败原因；token 事件：时间、事件、token 名称、来源 IP），只追加不清理，需要时自行归档。

## 安全要点

- WebSocket `/agent` 用 `Authorization: Bearer <token>` 认证，失败返回 HTTP 401 且不升级。
- 单条消息上限：`/agent` 4 MB（`attached` 可带历史），浏览器 `/api/term` 1 MB，超出以 1009 关闭；贴图上传请求体上限 10 MB；连接后 10 s 内未收到合法 hello 以 `bad_hello`（4003）关闭。
- hub 每 25 s 发送 ping，一个周期内未收到 pong 的连接被断开。
- Web API 与终端 WebSocket 全部要求登录，终端 WebSocket 另校验 Origin 同源；页面带 CSP（只允许同源脚本；xterm.js 运行时会插入 `<style>`，样式允许 inline）。
