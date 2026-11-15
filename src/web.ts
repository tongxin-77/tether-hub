// Web 界面与 Web API：管理员密码登录（内存会话 + HttpOnly cookie），SSE 推送机器 / 会话 / 更新状态变化，/api/term 终端接管 WebSocket 与贴图上传，网页关闭会话，机器 token 管理。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { IMAGE_TYPES, MAX_IMAGE, MAX_MESSAGE, reject, type Agents, type Machine } from './agents.js';
import { appendAudit, readAudit, type TokenAuditRec } from './audit.js';
import { createToken, readData, revokeToken } from './store.js';
import type { Updater } from './update.js';

const COOKIE = 'hub_session';
const SESSION_TTL = 7 * 24 * 3600_000;
export const MAX_FAILS = 5;
export const LOCK_MS = 5 * 60_000;

/** 路径相对于 publicDir；xterm 由 node_modules 提供 */
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/xterm/xterm.js': ['../node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  '/xterm/xterm.css': ['../node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/xterm/addon-fit.js': ['../node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};

export interface WebOptions {
  adminPassword: string;
  secure: boolean;
  publicDir: string;
  /** 数据目录（HUB_DATA_DIR）：审计日志与 hub.json */
  dataDir: string;
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
  /** 终端 WebSocket → 上个心跳周期内是否收到 pong */
  private terms = new Map<WebSocket, boolean>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  private pwHash: Buffer;
  private pushTimer?: NodeJS.Timeout;
  private beat: NodeJS.Timeout;

  constructor(private opt: WebOptions, private agents: Agents, private updater: Updater) {
    this.pwHash = sha256(opt.adminPassword);
    updater.on('change', () => this.send(this.updateEvent()));
    agents.on('change', () => {
      // 合并短时间内的多次变化
      this.pushTimer ??= setTimeout(() => {
        this.pushTimer = undefined;
        this.push();
      }, 100);
    });
    this.beat = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
      for (const [ws, alive] of this.terms) {
        if (!alive) ws.terminate();
        else {
          this.terms.set(ws, false);
          ws.ping();
        }
      }
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
      if (route === 'GET /api/audit') {
        const n = Number(url.searchParams.get('limit') ?? 100);
        return json(res, 200, readAudit(this.opt.dataDir, Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 100));
      }
      if (route === 'GET /api/update') return json(res, 200, this.updateStatus());
      if (req.method === 'POST' && (url.pathname.startsWith('/api/update/') || url.pathname.startsWith('/api/tokens') || url.pathname === '/api/term/image' || url.pathname === '/api/session/close') && !sameOrigin(req)) {
        return json(res, 403, { error: '来源不允许' });
      }
      if (route === 'POST /api/term/image') return await this.image(req, res, url);
      if (route === 'POST /api/session/close') return await this.closeSession(req, res, url);
      if (route === 'POST /api/update/check') {
        void this.updater.check();
        return json(res, 202, this.updateStatus());
      }
      if (route === 'POST /api/update/apply') {
        if (!this.updater.canApply) return json(res, 409, { error: '没有可安装的新版本，或更新正在进行' });
        void this.updater.apply();
        return json(res, 202, this.updateStatus());
      }
      if (route === 'GET /api/tokens') return this.listTokens(res);
      if (route === 'POST /api/tokens') return await this.createToken(req, res);
      const rv = /^\/api\/tokens\/([^/]+)\/revoke$/.exec(url.pathname);
      if (req.method === 'POST' && rv) return this.revokeToken(req, res, rv[1]);
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
      // xterm.js 运行时插入 <style>，样式需允许 inline；脚本仍只允许同源
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(fs.readFileSync(path.join(this.opt.publicDir, file)));
  }

  /** /api/term?machine=…&session=…：须同源且已登录，否则不升级 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
    if (!this.authed(req)) return reject(socket, 401, 'Unauthorized');
    const url = new URL(req.url ?? '/', 'http://x');
    const machine = url.searchParams.get('machine') ?? '';
    const session = Number(url.searchParams.get('session') ?? '');
    if (!machine || !Number.isInteger(session) || session < 0) return reject(socket, 400, 'Bad Request');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onTerm(ws, machine, session, req.socket.remoteAddress ?? ''));
  }

  private onTerm(ws: WebSocket, machine: string, session: number, ip: string) {
    this.terms.set(ws, true);
    ws.on('pong', () => this.terms.set(ws, true));
    ws.on('error', () => {});
    const h = this.agents.join(machine, session, {
      ip,
      send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      end: () => ws.close(1000),
    });
    ws.on('message', (data, isBinary) => {
      let msg: any;
      try {
        msg = isBinary ? undefined : JSON.parse(data.toString());
      } catch {}
      if (msg?.type === 'input' && typeof msg.data === 'string') h?.input(msg.data);
      else if (msg?.type === 'resize' && size(msg.cols) && size(msg.rows)) h?.resize(msg.cols, msg.rows);
    });
    ws.on('close', () => {
      this.terms.delete(ws);
      h?.leave();
    });
  }

  /** POST /api/term/image?machine=…&session=…：请求体为原始图片，转给 daemon 保存后把路径输入到会话 */
  private async image(req: IncomingMessage, res: ServerResponse, url: URL) {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(mime)) return json(res, 415, { error: '仅支持 PNG / JPEG / GIF / WebP 图片' });
    const machine = url.searchParams.get('machine') ?? '';
    const session = Number(url.searchParams.get('session') ?? '');
    if (!machine || !Number.isInteger(session) || session < 0) return json(res, 400, { error: '参数错误' });
    // 先看 Content-Length，再在读取时累计限制（分块传输没有 Content-Length）。
    // 回 413 后未读完的请求体由 Node 丢弃，连接保持，客户端能正常收到响应（提前断开会让浏览器只看到网络错误）
    const tooLarge = { error: '图片过大（上限 10 MB）' };
    if (Number(req.headers['content-length'] ?? 0) > MAX_IMAGE) return json(res, 413, tooLarge);
    const data = await readBuf(req, MAX_IMAGE);
    if (!data) return json(res, 413, tooLarge);
    if (!data.length) return json(res, 400, { error: '图片为空' });
    const r = await this.agents.uploadImage(machine, session, mime, data, req.socket.remoteAddress ?? '');
    if (r.ok) return json(res, 200, { path: r.path });
    json(res, r.status, r.reason ? { error: r.error, reason: r.reason } : { error: r.error });
  }

  /** POST /api/session/close?machine=…&session=…：请 daemon 关闭该会话（不要求正被接管） */
  private async closeSession(req: IncomingMessage, res: ServerResponse, url: URL) {
    const machine = url.searchParams.get('machine') ?? '';
    const session = Number(url.searchParams.get('session') ?? '');
    if (!machine || !Number.isInteger(session) || session < 0) return json(res, 400, { error: '参数错误' });
    const r = await this.agents.closeSession(machine, session, req.socket.remoteAddress ?? '');
    if (r.ok) return json(res, 200, { ok: true });
    json(res, r.status, r.reason ? { error: r.error, reason: r.reason } : { error: r.error });
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

  /** token 列表：不含 sha256，附使用该 token 的机器名 */
  private listTokens(res: ServerResponse) {
    const { tokens, machines } = readData(this.opt.dataDir);
    json(res, 200, tokens.map((t) => ({
      name: t.name, revoked: t.revoked, createdAt: t.createdAt,
      machines: machines.filter((m) => m.tokenName === t.name).map((m) => m.name || m.machineId),
    })));
  }

  private async createToken(req: IncomingMessage, res: ServerResponse) {
    if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: '需要 JSON' });
    let name: unknown;
    try {
      name = JSON.parse(await readBody(req, 4096))?.name;
    } catch {
      return json(res, 400, { error: '请求格式错误' });
    }
    if (typeof name !== 'string') return json(res, 400, { error: '缺少名称' });
    let token: string;
    try {
      token = createToken(this.opt.dataDir, name);
    } catch (e) {
      // 文件系统错误交给外层按 500 处理；其余为名称非法 / 重复
      if ((e as NodeJS.ErrnoException).code) throw e;
      return json(res, 400, { error: (e as Error).message });
    }
    this.audit({ time: new Date().toISOString(), event: 'token_create', tokenName: name, ip: req.socket.remoteAddress ?? '' });
    json(res, 201, { name, token });
  }

  /** 吊销后 server.ts 的 hub.json 轮询会断开使用该 token 的机器 */
  private revokeToken(req: IncomingMessage, res: ServerResponse, raw: string) {
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      return json(res, 400, { error: '名称格式错误' });
    }
    try {
      revokeToken(this.opt.dataDir, name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code) throw e;
      const exists = readData(this.opt.dataDir).tokens.some((t) => t.name === name);
      return json(res, exists ? 409 : 404, { error: (e as Error).message });
    }
    this.audit({ time: new Date().toISOString(), event: 'token_revoke', tokenName: name, ip: req.socket.remoteAddress ?? '' });
    json(res, 200, { ok: true });
  }

  private audit(rec: TokenAuditRec) {
    try {
      appendAudit(this.opt.dataDir, rec);
    } catch (e) {
      this.opt.log(`写入审计日志失败：${(e as Error).message}`);
    }
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
    res.write(this.updateEvent());
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  private push() {
    if (this.clients.size) this.send(`event: state\ndata: ${JSON.stringify(snapshot(this.agents, this.opt.hubVersion))}\n\n`);
  }

  private send(data: string) {
    for (const res of this.clients) res.write(data);
  }

  /** 更新状态，附进行中的接管数（前端据此二次确认） */
  private updateStatus() {
    return { ...this.updater.status(), takeovers: this.agents.takeoverCount() };
  }

  private updateEvent() {
    return `event: update\ndata: ${JSON.stringify(this.updateStatus())}\n\n`;
  }

  close() {
    clearInterval(this.beat);
    clearTimeout(this.pushTimer);
    for (const res of this.clients) res.end();
    this.clients.clear();
    for (const ws of this.terms.keys()) ws.terminate();
    this.wss.close();
  }
}

/** Origin 须与 Host 同源（终端 WebSocket 与更新 / token 类 POST 的 CSRF 防护） */
function sameOrigin(req: IncomingMessage) {
  try {
    return new URL(req.headers.origin ?? '').host === req.headers.host;
  } catch {
    return false;
  }
}

const size = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000;

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

/** 读取原始请求体；超过 limit 时立即返回 null，剩余部分继续读取并丢弃（不断开连接，以便客户端收到 413） */
function readBuf(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const onData = (c: Buffer) => {
      size += c.length;
      if (size <= limit) return chunks.push(c);
      req.off('data', onData);
      req.resume();
      resolve(null);
    };
    req.on('data', onData);
    req.on('end', () => resolve(size <= limit ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
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
