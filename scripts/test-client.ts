// 模拟 daemon 的测试客户端：握手 → hello → welcome → 上报会话 → 切换为等待确认 → 关闭。
// 用法：pnpm test-client <ws(s)://地址:端口/agent> <token> [停留秒数，默认 3]
// 自签证书调试时可设 NODE_TLS_REJECT_UNAUTHORIZED=0。

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const [url, token, stay = '3'] = process.argv.slice(2);
if (!url || !token) {
  console.log('用法：pnpm test-client <ws(s)://地址:端口/agent> <token> [停留秒数]');
  process.exit(1);
}

const t0 = Date.now();
const log = (m: string) => console.log(`[+${Date.now() - t0} ms] ${m}`);
const now = Date.now();
const sessions = [
  { id: 1, name: 'PowerShell', cwd: 'C:\\workspace\\tether', command: 'pwsh.exe', status: 'running', startedAt: now, lastActivityAt: now, host: null },
  {
    id: 2, name: 'claude 重构', cwd: '/home/dev/app', command: 'ssh', status: 'running', startedAt: now, lastActivityAt: now,
    host: 'build-box', hostId: 'h1', claude: { state: 'thinking', at: now },
  },
];

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
ws.on('unexpected-response', (_req, res) => {
  log(`握手失败：HTTP ${res.statusCode}`);
  process.exit(2);
});
ws.on('error', (e) => log(`连接错误：${e.message}`));
ws.on('ping', () => log('收到 ping'));
ws.on('open', () => {
  log('已连接，发送 hello');
  ws.send(JSON.stringify({ type: 'hello', proto: 1, machineId: randomUUID(), machineName: 'TEST-CLIENT', version: '0.0.0-test' }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  log(`收到 ${JSON.stringify(msg)}`);
  if (msg.type !== 'welcome') return;
  ws.send(JSON.stringify({ type: 'sessions', sessions }));
  log(`已上报 ${sessions.length} 个会话`);
  setTimeout(() => {
    sessions[1].claude = { state: 'waiting', message: 'Claude 需要你的许可才能使用 Bash', at: Date.now() } as any;
    sessions[1].lastActivityAt = Date.now();
    ws.send(JSON.stringify({ type: 'sessions', sessions }));
    log('会话 2 切换为等待确认');
  }, 500);
  setTimeout(() => ws.close(1000), Number(stay) * 1000);
});
ws.on('close', (code, reason) => {
  log(`连接关闭：${code} ${reason}`);
  process.exit(code === 1000 || code === 1005 ? 0 : 3);
});
