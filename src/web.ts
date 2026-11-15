// Web 界面与 Web API：管理员密码登录（内存会话 + HttpOnly cookie），SSE 推送机器 / 会话变化。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Agents, Machine } from './agents.js';

const COOKIE = 'hub_session';
const SESSION_TTL = 7 * 24 * 3600_000;
export const MAX_FAILS = 5;
export const LOCK_MS = 5 * 60_000;

const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

export interface WebOptions {
  adminPassword: string;
  secure: boolean;
  publicDir: string;
  hubVersion: string;
  log: (msg: string) => void;
}

const isWaiting = (m: Machine) => m.sessions.some((s) => s.claude?.state === 'waiting');

/** 机器排序：有会话等待确认的在前，其次在线，再按名称；会话中等待确认的在前 */
export function snapshot(agents: Agents, hubVersion: string) {
  const machines = [...agents.machines.values()]
    .map((m) => ({
      ...m,
      sessions: [...m.sessions].sort((a, b) => Number(b.claude?.state === 'waiting') - Number(a.claude?.state === 'waiting')),
    }))
    .sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return { hubVersion, machines };
}

export class Web {
  private sessions = new Map<string, number>();
  private fails = new Map<string, { count: number; until: number }>();
  private clients = new Set<ServerResponse>();
  private pwHash: Buffer;
  private pushTimer?: NodeJS.Timeout;
  private beat: NodeJS.Timeout;

  constructor(private opt: WebOptions, private agents: Agents) {
    this.pwHash = sha256(opt.adminPassword);
    agents.on('change', () => {
      // 合并短时间内的多次变化
      this.pushTimer ??= setTimeout(() => {
        this.pushTimer = undefined;
        this.push();
      }, 100);
    });
    this.beat = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 20_000);
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url ?? '/', 'http://x');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) return this.serveStatic(res, url.pathname);
      if (route === 'POST /api/login') return await this.login(req, res);
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: '不存在' });
      if (!this.authed(req)) return json(res, 401, { error: '未登录' });
      if (route === 'POST /api/logout') return this.logout(req, res);
      if (route === 'GET /api/me') return json(res, 200, { ok: true });
      if (route === 'GET /api/state') return json(res, 200, snapshot(this.agents, this.opt.hubVersion));
      if (route === 'GET /api/events') return this.events(req, res);
      return json(res, 404, { error: '不存在' });
    } catch (e) {
      this.opt.log(`请求出错 ${route}：${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: '服务器错误' });
      else res.end();
    }
  }

  private serveStatic(res: ServerResponse, p: string) {
    const [file, type] = STATIC[p];
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(fs.readFileSync(path.join(this.opt.publicDir, file)));
  }

  private authed(req: IncomingMessage) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const exp = sid ? this.sessions.get(sid) : undefined;
    if (!exp) return false;
    if (exp < Date.now()) {
      this.sessions.delete(sid!);
      return false;
    }
    return true;
  }

  private async login(req: IncomingMessage, res: ServerResponse) {
    const ip = req.socket.remoteAddress ?? '';
    const now = Date.now();
    const f = this.fails.get(ip);
    if (f && f.until > now) {
      res.setHeader('Retry-After', String(Math.ceil((f.until - now) / 1000)));
      return json(res, 429, { error: `尝试次数过多，请 ${Math.ceil((f.until - now) / 60000)} 分钟后再试` });
    }
    if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: '需要 JSON' });
    let password = '';
    try {
      const body = JSON.parse(await readBody(req, 4096));
      if (typeof body?.password === 'string') password = body.password;
    } catch {
      return json(res, 400, { error: '请求格式错误' });
    }
    if (!timingSafeEqual(sha256(password), this.pwHash)) {
      const count = (f?.count ?? 0) + 1;
      const locked = count >= MAX_FAILS;
      this.fails.set(ip, { count: locked ? 0 : count, until: locked ? now + LOCK_MS : 0 });
      this.opt.log(`登录失败：${ip}（${locked ? '已锁定 5 分钟' : `第 ${count} 次`}）`);
      return json(res, 401, { error: locked ? '密码错误次数过多，已锁定 5 分钟' : '密码错误' });
    }
    this.fails.delete(ip);
    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sid, now + SESSION_TTL);
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${this.opt.secure ? '; Secure' : ''}`);
    json(res, 200, { ok: true });
  }

  private logout(req: IncomingMessage, res: ServerResponse) {
    this.sessions.delete(parseCookies(req.headers.cookie)[COOKIE]);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.opt.secure ? '; Secure' : ''}`);
    json(res, 200, { ok: true });
  }

  private events(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(snapshot(this.agents, this.opt.hubVersion))}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  private push() {
    if (!this.clients.size) return;
    const data = `event: state\ndata: ${JSON.stringify(snapshot(this.agents, this.opt.hubVersion))}\n\n`;
    for (const res of this.clients) res.write(data);
  }

  close() {
    clearInterval(this.beat);
    clearTimeout(this.pushTimer);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

function sha256(s: string) {
  return createHash('sha256').update(s, 'utf8').digest();
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
