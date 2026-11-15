// 组装 hub：HTTP(S) 服务器 + /agent WebSocket + Web 界面（含 /api/term），并监听 hub.json 变化以响应 token 吊销。

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agents } from './agents.js';
import { appendAudit } from './audit.js';
import { dataFile, readData, updateData, type TokenRec } from './store.js';
import { Web } from './web.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HUB_VERSION: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

export interface HubOptions {
  port: number;
  host: string;
  tls?: { cert: Buffer; key: Buffer };
  adminPassword: string;
  dataDir: string;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  /** 轮询 hub.json 的间隔 */
  watchIntervalMs?: number;
  log?: (msg: string) => void;
}

export interface Hub {
  port: number;
  agents: Agents;
  close(): Promise<void>;
}

export async function startHub(opt: HubOptions): Promise<Hub> {
  const log = opt.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${m}`));
  const dir = opt.dataDir;
  const initial = readData(dir);
  let tokens: TokenRec[] = initial.tokens;

  const persist = () => {
    try {
      updateData(dir, (d) => {
        d.machines = agents.records();
        tokens = d.tokens;
      });
    } catch (e) {
      log(`写入 hub.json 失败：${(e as Error).message}`);
    }
  };

  const agents = new Agents(
    {
      hubVersion: HUB_VERSION,
      helloTimeoutMs: opt.helloTimeoutMs ?? 10_000,
      pingIntervalMs: opt.pingIntervalMs ?? 25_000,
      tokens: () => tokens,
      persist,
      audit: (rec) => {
        try {
          appendAudit(dir, rec);
        } catch (e) {
          log(`写入审计日志失败：${(e as Error).message}`);
        }
      },
      log,
    },
    initial.machines,
  );
  const web = new Web(
    { adminPassword: opt.adminPassword, secure: !!opt.tls, publicDir: path.join(root, 'public'), dataDir: dir, hubVersion: HUB_VERSION, log },
    agents,
  );

  // token CLI 改写 hub.json 后重新加载 token，并断开已吊销 token 的连接
  const file = dataFile(dir);
  const onFile = () => {
    try {
      tokens = readData(dir).tokens;
      agents.checkRevoked();
    } catch (e) {
      log(`读取 hub.json 失败：${(e as Error).message}`);
    }
  };
  fs.watchFile(file, { interval: opt.watchIntervalMs ?? 1000 }, onFile);

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void web.handle(req, res);
  const server = opt.tls ? https.createServer({ cert: opt.tls.cert, key: opt.tls.key }, handler) : http.createServer(handler);
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === '/api/term') web.handleUpgrade(req, socket, head);
    else agents.handleUpgrade(req, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opt.port, opt.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    agents,
    async close() {
      fs.unwatchFile(file, onFile);
      web.close();
      agents.close();
      persist();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
