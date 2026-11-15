// daemon 连接管理与远程接管：协议见 docs/protocol.md（v2）。

import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AuditRec } from './audit.js';
import { findToken, type MachineRec, type TokenRec } from './store.js';

export const PROTO = 2;
export const MAX_MESSAGE = 1024 * 1024;

export interface ClaudeState {
  state: string;
  message?: string;
  count?: number;
  at?: number;
}

export interface SessionInfo {
  id: number;
  name: string;
  cwd: string;
  command: string;
  status: string;
  startedAt: number;
  lastActivityAt: number;
  host?: string | null;
  hostId?: string;
  claude?: ClaudeState;
}

export interface Machine {
  machineId: string;
  name: string;
  version: string;
  tokenName: string;
  online: boolean;
  lastSeen: number;
  sessions: SessionInfo[];
}

/** 查看某会话的一个浏览器（由 Web 层实现），收到的消息格式见 README「浏览器终端 WebSocket」 */
export interface Viewer {
  ip: string;
  send(msg: object): void;
  /** 接管结束后关闭浏览器连接 */
  end(): void;
}

export interface ViewerHandle {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  leave(): void;
}

/** 一条 daemon 连接上某会话的接管，多个浏览器共用 */
interface Takeover {
  sessionId: number;
  viewers: Set<Viewer>;
  /** 已收到快照、可接收实时输出的浏览器 */
  ready: Set<Viewer>;
  /** daemon 已回 attached */
  active: boolean;
  /** 最近一次发起接管的浏览器 IP */
  ip: string;
}

interface Conn {
  ws: WebSocket;
  machineId: string;
  tokenHash: string;
  alive: boolean;
  takeovers: Map<number, Takeover>;
}

export interface AgentOptions {
  hubVersion: string;
  helloTimeoutMs: number;
  pingIntervalMs: number;
  /** 当前 token 列表（由 hub.json 加载） */
  tokens: () => TokenRec[];
  /** 机器档案变化（上线 / 下线）时调用，用于持久化 */
  persist: () => void;
  /** 记录一条接管审计 */
  audit: (rec: AuditRec) => void;
  log: (msg: string) => void;
}

const SESSION_KEYS = ['id', 'name', 'cwd', 'command', 'status', 'startedAt', 'lastActivityAt', 'host', 'hostId', 'claude'] as const;

/** 字符串且字符数（按 Unicode 码点计）在 [min, max] 内 */
const str = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && [...v].length >= min && [...v].length <= max;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 只保留 SessionInfo 中已知字段 */
function pickSession(s: Record<string, unknown>): SessionInfo {
  const out: Record<string, unknown> = {};
  for (const k of SESSION_KEYS) if (k in s) out[k] = s[k];
  return out as unknown as SessionInfo;
}

export class Agents extends EventEmitter {
  readonly machines = new Map<string, Machine>();
  /** machineId → 当前有效连接 */
  private conns = new Map<string, Conn>();
  /** 所有连接（含尚未 hello 的） */
  private all = new Set<Conn>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  private pingTimer: NodeJS.Timeout;

  constructor(private opt: AgentOptions, saved: MachineRec[]) {
    super();
    for (const m of saved) this.machines.set(m.machineId, { ...m, online: false, sessions: [] });
    this.pingTimer = setInterval(() => this.ping(), opt.pingIntervalMs);
  }

  /** 供持久化使用的机器档案 */
  records(): MachineRec[] {
    return [...this.machines.values()].map(({ machineId, name, version, tokenName, lastSeen }) => ({
      machineId, name, version, tokenName, lastSeen,
    }));
  }

  /** HTTP upgrade：先校验 Bearer token，失败返回 401 且不升级 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/agent') return reject(socket, 404, 'Not Found');
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const rec = m ? findToken(this.opt.tokens(), m[1]) : undefined;
    if (!rec) {
      this.opt.log(`拒绝握手（token 无效）：${req.socket.remoteAddress}`);
      return reject(socket, 401, 'Unauthorized');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, rec, req.socket.remoteAddress ?? ''));
  }

  private onConnection(ws: WebSocket, token: TokenRec, addr: string) {
    const conn: Conn = { ws, machineId: '', tokenHash: token.sha256, alive: true, takeovers: new Map() };
    this.all.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('error', (e) => this.opt.log(`连接错误（${addr}）：${e.message}`));
    const timer = setTimeout(() => fail(ws, 'bad_hello', '10 s 内未收到 hello', 4003), this.opt.helloTimeoutMs);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      let msg: unknown;
      try {
        msg = isBinary ? undefined : JSON.parse(data.toString());
      } catch {}

      if (!conn.machineId) {
        clearTimeout(timer);
        if (isObj(msg) && msg.type === 'hello' && typeof msg.proto === 'number' && msg.proto !== PROTO) {
          return fail(ws, 'proto_unsupported', `hub 仅支持协议 ${PROTO}`, 4002);
        }
        if (!isObj(msg) || msg.type !== 'hello' || msg.proto !== PROTO || !str(msg.machineId, 1, 64)
          || !str(msg.machineName, 0, 256) || !str(msg.version, 0, 256)
          || (msg.probe !== undefined && typeof msg.probe !== 'boolean')) {
          return fail(ws, 'bad_hello', '首条消息不是合法的 hello', 4003);
        }
        conn.machineId = msg.machineId;
        if (msg.probe) {
          // 探测连接（客户端「测试连接」）：只回 welcome，不登记 / 不替换常驻连接、不更新档案；
          // 它不在 conns 中，之后的 sessions 与关闭都会被下方的「是否当前连接」检查忽略
          send(ws, { type: 'welcome', proto: PROTO, hubVersion: this.opt.hubVersion });
          this.opt.log(`探测连接：${msg.machineName}（${msg.machineId}，token ${token.name}，${addr}）`);
          return;
        }
        this.online(conn, msg.machineName, msg.version, token.name, addr);
        return;
      }

      if (!isObj(msg) || this.conns.get(conn.machineId) !== conn) return;
      if (msg.type === 'sessions' && Array.isArray(msg.sessions)) {
        const m = this.machines.get(conn.machineId);
        if (!m) return;
        m.sessions = msg.sessions.filter(isObj).map(pickSession);
        this.emit('change');
        return;
      }
      const t = typeof msg.sessionId === 'number' ? conn.takeovers.get(msg.sessionId) : undefined;
      if (!t) return;
      if (msg.type === 'attached' && typeof msg.snapshot === 'string') {
        if (!t.active) {
          t.active = true;
          this.audit(conn, t.sessionId, 'start', { ip: t.ip });
        }
        // 每次 attached 都带新快照：只发给还没拿到快照的浏览器
        for (const v of t.viewers) {
          if (t.ready.has(v)) continue;
          v.send({ type: 'snapshot', cols: msg.cols, rows: msg.rows, data: msg.snapshot });
          t.ready.add(v);
        }
      } else if (msg.type === 'attachDenied') {
        this.finish(conn, t, { type: 'denied', reason: String(msg.reason) });
        this.audit(conn, t.sessionId, 'denied', { ip: t.ip, reason: String(msg.reason) });
      } else if (msg.type === 'output' && typeof msg.data === 'string') {
        for (const v of t.ready) v.send({ type: 'output', data: msg.data });
      } else if (msg.type === 'detached') {
        this.finish(conn, t, { type: 'detached', reason: String(msg.reason) });
        this.audit(conn, t.sessionId, String(msg.reason) as AuditRec['event']);
      }
      // 其他类型按协议忽略
    });

    ws.on('close', () => {
      clearTimeout(timer);
      this.all.delete(conn);
      if (!conn.machineId || this.conns.get(conn.machineId) !== conn) return;
      this.conns.delete(conn.machineId);
      this.endAll(conn);
      const m = this.machines.get(conn.machineId);
      if (m) {
        m.online = false;
        m.lastSeen = Date.now();
      }
      this.opt.log(`机器下线：${m?.name}（${conn.machineId}）`);
      this.opt.persist();
      this.emit('change');
    });
  }

  private online(conn: Conn, name: string, version: string, tokenName: string, addr: string) {
    const old = this.conns.get(conn.machineId);
    this.conns.set(conn.machineId, conn);
    if (old) {
      this.endAll(old);
      fail(old.ws, 'replaced', '同一机器有新连接，旧连接被替换', 4004);
    }

    const prev = this.machines.get(conn.machineId);
    this.machines.set(conn.machineId, {
      machineId: conn.machineId, name, version, tokenName,
      online: true, lastSeen: Date.now(), sessions: prev?.sessions ?? [],
    });
    send(conn.ws, { type: 'welcome', proto: PROTO, hubVersion: this.opt.hubVersion });
    this.opt.log(`机器上线：${name}（${conn.machineId}，${version}，token ${tokenName}，${addr}）`);
    this.opt.persist();
    this.emit('change');
  }

  /**
   * 浏览器加入某会话的接管：同一会话复用一个接管，每次加入都发一次 attach，
   * 由 daemon 回新快照给新加入的浏览器。机器离线时直接通知并关闭，返回 undefined。
   */
  join(machineId: string, sessionId: number, v: Viewer): ViewerHandle | undefined {
    const conn = this.conns.get(machineId);
    if (!conn) {
      v.send({ type: 'detached', reason: 'offline' });
      v.end();
      return;
    }
    let t = conn.takeovers.get(sessionId);
    if (!t) conn.takeovers.set(sessionId, (t = { sessionId, viewers: new Set(), ready: new Set(), active: false, ip: v.ip }));
    t.viewers.add(v);
    t.ip = v.ip;
    send(conn.ws, { type: 'attach', sessionId });
    const live = () => conn.takeovers.get(sessionId) === t && t.active;
    return {
      input: (data) => {
        if (live()) send(conn.ws, { type: 'input', sessionId, data });
      },
      resize: (cols, rows) => {
        if (live()) send(conn.ws, { type: 'resize', sessionId, cols, rows });
      },
      leave: () => {
        if (conn.takeovers.get(sessionId) !== t || !t.viewers.delete(v)) return;
        t.ready.delete(v);
        if (t.viewers.size) return;
        // 最后一个浏览器离开；尚未 attached 时也发 detach，daemon 会按顺序先处理 attach 再 detach
        conn.takeovers.delete(sessionId);
        send(conn.ws, { type: 'detach', sessionId });
        if (t.active) this.audit(conn, sessionId, 'end', { ip: v.ip });
      },
    };
  }

  /** 结束一个接管：通知并关闭所有浏览器 */
  private finish(conn: Conn, t: Takeover, msg: object) {
    conn.takeovers.delete(t.sessionId);
    for (const v of t.viewers) {
      v.send(msg);
      v.end();
    }
  }

  /** 机器断线 / 被替换：结束该连接上的全部接管 */
  private endAll(conn: Conn) {
    for (const t of [...conn.takeovers.values()]) {
      this.finish(conn, t, { type: 'detached', reason: 'offline' });
      if (t.active) this.audit(conn, t.sessionId, 'disconnected');
    }
  }

  private audit(conn: Conn, sessionId: number, event: AuditRec['event'], extra: { ip?: string; reason?: string } = {}) {
    const m = this.machines.get(conn.machineId);
    const rec: AuditRec = {
      time: new Date().toISOString(), event, machineId: conn.machineId, machineName: m?.name ?? '',
      sessionId, sessionName: m?.sessions.find((s) => s.id === sessionId)?.name ?? '', ...extra,
    };
    this.opt.log(`接管审计：${event} ${rec.machineName}（${rec.machineId}）会话 ${sessionId}${extra.reason ? `，${extra.reason}` : ''}${extra.ip ? `，${extra.ip}` : ''}`);
    this.opt.audit(rec);
  }

  /** token 列表变化后调用：断开所用 token 已吊销 / 已删除的连接（包括尚未 hello 的） */
  checkRevoked() {
    const valid = new Set(this.opt.tokens().filter((t) => !t.revoked).map((t) => t.sha256));
    for (const c of this.all) {
      if (valid.has(c.tokenHash) || c.ws.readyState !== c.ws.OPEN) continue;
      this.opt.log(`token 已吊销，断开：${c.machineId || '(未 hello)'}`);
      fail(c.ws, 'revoked', '所用 token 已被吊销', 4001);
    }
  }

  private ping() {
    for (const c of this.all) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  close() {
    clearInterval(this.pingTimer);
    for (const c of this.all) c.ws.terminate();
    this.all.clear();
    const now = Date.now();
    for (const m of this.machines.values()) if (m.online) {
      m.online = false;
      m.lastSeen = now;
    }
    this.conns.clear();
    this.wss.close();
  }
}

function send(ws: WebSocket, msg: object) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function fail(ws: WebSocket, code: string, message: string, closeCode: number) {
  send(ws, { type: 'error', code, message });
  ws.close(closeCode, code);
}

export function reject(socket: Duplex, status: number, text: string) {
  // 客户端可能在收到响应后直接 RST，必须吞掉 socket 错误，否则进程会因未处理的 error 事件崩溃
  socket.on('error', () => {});
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
