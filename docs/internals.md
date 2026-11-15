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
- 在线机器的未退出会话旁有「接管」按钮，点击后打开全屏终端页（xterm.js）：先显示屏幕快照，再接实时输出；键入、粘贴（支持多行）会发送到会话，窗口尺寸变化会同步 resize。有选区时 Ctrl+C 复制，Ctrl+V 粘贴。手机上点终端唤起软键盘，底部按键条提供 Esc / Tab / Ctrl+C / 方向键。
- 同一会话可在多个浏览器同时打开，hub 只向 daemon 发一次接管（新加入的浏览器会再发一次 `attach` 取得新快照），最后一个浏览器关闭时 hub 发 `detach`，daemon 停止推送。
- 结束原因显示在终端上方：已被本地收回 / 本机未允许接管 / 会话已退出 / 机器离线 / 连接已断开，终端转为只读。结束后不会自动重新接管；被本地收回、机器离线或连接中断时可点「重新接管」。关闭终端页即断开接管。

### 浏览器终端 WebSocket

`/api/term?machine=<machineId>&session=<sessionId>`，需管理员登录 cookie，且 `Origin` 须与 `Host` 同源，否则以 401 / 403 拒绝升级。文本帧 JSON，终端数据均为 base64 原样透传：

| 方向 | 消息 |
|------|------|
| 下行 | `{"type":"snapshot","cols":120,"rows":30,"data":"<base64>"}` 接管成功时的屏幕快照（每个浏览器一次） |
| 下行 | `{"type":"output","data":"<base64>"}` 实时输出 |
| 下行 | `{"type":"detached","reason":"reclaimed\|disabled\|exited\|offline"}` 接管结束，随后 hub 关闭连接 |
| 下行 | `{"type":"denied","reason":"disabled\|not_found\|probe"}` 接管被拒，随后 hub 关闭连接 |
| 上行 | `{"type":"input","data":"<base64>"}`、`{"type":"resize","cols":120,"rows":30}`（1–1000），收到快照前发送的会被忽略 |

## 接管审计

hub 按协议第 7 节把接管事件追加到 `HUB_DATA_DIR/audit.jsonl`：`start`（开始）、`denied`（被拒，附 `reason`）、`end`（最后一个浏览器离开）、`reclaimed`（本地收回）、`disabled`（本地关闭允许接管）、`exited`（会话退出）、`disconnected`（机器断线）。网页「审计日志」页显示最近 500 条，可按事件、机器、关键字（会话名称 / 来源 IP）筛选；`GET /api/audit?limit=N`（需登录，默认 100，上限 1000）返回最近 N 条，新的在前。

## 数据

`data/hub.json` 保存 token（名称、SHA-256、创建时间、是否已吊销）与机器档案（machineId、名称、版本、token 名、最后在线时间）。hub 与 CLI 读改写时用 `hub.json.lock` 互斥，并先写临时文件再 rename，保证文件始终完整。会话列表只在内存中，hub 重启后由客户端重连时重新上报。

`data/audit.jsonl` 为接管审计日志，每行一个 JSON（时间、事件、机器、会话、来源 IP），只追加不清理，需要时自行归档。

## 安全要点

- WebSocket `/agent` 用 `Authorization: Bearer <token>` 认证，失败返回 HTTP 401 且不升级。
- 单条消息上限 1 MB（超出以 1009 关闭）；连接后 10 s 内未收到合法 hello 以 `bad_hello`（4003）关闭。
- hub 每 25 s 发送 ping，一个周期内未收到 pong 的连接被断开。
- Web API 与终端 WebSocket 全部要求登录，终端 WebSocket 另校验 Origin 同源；页面带 CSP（只允许同源脚本；xterm.js 运行时会插入 `<style>`，样式允许 inline）。
