import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startHub, type Hub } from '../src/server.js';
import { createToken } from '../src/store.js';

export const PASSWORD = 'test-password';

export interface Ctx {
  hub: Hub;
  dir: string;
  token: string;
  base: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function setup(opts: { helloTimeoutMs?: number; updateApi?: string; imageTimeoutMs?: number; closeTimeoutMs?: number; queryTimeoutMs?: number; createTimeoutMs?: number } = {}): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-hub-test-'));
  const token = createToken(dir, 'pc1');
  const hub = await startHub({
    port: 0, host: '127.0.0.1', adminPassword: PASSWORD, dataDir: dir,
    helloTimeoutMs: opts.helloTimeoutMs ?? 10_000, watchIntervalMs: 50, log: () => {}, updateApi: opts.updateApi, imageTimeoutMs: opts.imageTimeoutMs, closeTimeoutMs: opts.closeTimeoutMs, queryTimeoutMs: opts.queryTimeoutMs, createTimeoutMs: opts.createTimeoutMs,
  });
  return {
    hub, dir, token,
    base: `http://127.0.0.1:${hub.port}`,
    wsUrl: `ws://127.0.0.1:${hub.port}/agent`,
    async close() {
      await hub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 封装一条 daemon 连接：收集收到的消息与关闭码 */
export class Client {
  ws: WebSocket;
  messages: any[] = [];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;

  constructor(url: string, token?: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}`, ...headers } : headers });
    this.ws.on('message', (d) => this.messages.push(JSON.parse(d.toString())));
    this.opened = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('unexpected-response', (_req, r) => rej(Object.assign(new Error('unexpected'), { status: r.statusCode })));
      this.ws.once('error', rej);
    });
    this.closed = new Promise((res) => this.ws.once('close', (code, reason) => res({ code, reason: reason.toString() })));
  }

  send(msg: unknown) {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  hello(machineId = 'm-1', extra: object = {}) {
    this.send({ type: 'hello', proto: 2, machineId, machineName: 'DEV-PC', version: '0.4.0', ...extra });
  }

  async next(type: string, timeout = 3000): Promise<any> {
    let m: any;
    await waitFor(() => !!(m = this.messages.find((m) => m.type === type)), timeout);
    return m;
  }
}

export async function login(base: string, password = PASSWORD) {
  return fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

export async function cookie(base: string) {
  const r = await login(base);
  return r.headers.get('set-cookie')!.split(';')[0];
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('等待条件超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}
