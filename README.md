# tether-hub

[Tether](https://github.com/tongxin-77/tether) 的自托管管理服务器：在一个网页里汇总多台机器上的 Tether 会话（含 Claude Code 状态），并可按需远程接管单个会话。

> 状态：第二阶段，**尚未开始**。

- hub 为可选组件：Tether 客户端不配置 hub 时可完全独立使用。
- 客户端零入站端口：由各机器的 `tetherd` 主动以 WSS 出站连接 hub。
- 技术栈（计划）：Node.js LTS + TypeScript，Web 端使用 xterm.js。

需求文档：[docs/requirements.md](docs/requirements.md)

## 许可证

[Apache-2.0](LICENSE)
