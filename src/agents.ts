// daemon 连接管理：协议见 docs/protocol.md（v1）。

import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { findToken, type MachineRec, type TokenRec } from './store.js';

export const PROTO = 1;
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

interface Conn {
  ws: WebSocket;
  machineId: string;
  tokenHash: string;
  alive: boolean;
}

export interface AgentOptions {
  hubVersion: string;
  helloTimeoutMs: number;
  pingIntervalMs: number;
  /** 当前 token 列表（由 hub.json 加载） */
  tokens: () => TokenRec[];
  /** 机器档案变化（上线 / 下线）时调用，用于持久化 */
  persist: () => void;
  log: (msg: string) => void;
}

const SESSION_KEYS = ['id', 'name', 'cwd', 'command', 'status', 'startedAt', 'lastActivityAt', 'host', 'hostId', 'claude'] as const;

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
    const conn: Conn = { ws, machineId: '', tokenHash: token.sha256, alive: true };
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
        if (!isObj(msg) || msg.type !== 'hello' || msg.proto !== PROTO || typeof msg.machineId !== 'string' || !msg.machineId
          || typeof msg.machineName !== 'string' || typeof msg.version !== 'string') {
          return fail(ws, 'bad_hello', '首条消息不是合法的 hello', 4003);
        }
        conn.machineId = msg.machineId;
        this.online(conn, msg.machineName, msg.version, token.name, addr);
        return;
      }

      if (!isObj(msg)) return;
      if (msg.type === 'sessions' && Array.isArray(msg.sessions)) {
        const m = this.machines.get(conn.machineId);
        if (!m || this.conns.get(conn.machineId) !== conn) return;
        m.sessions = msg.sessions.filter(isObj).map(pickSession);
        this.emit('change');
      }
      // 其他类型按协议忽略
    });

    ws.on('close', () => {
      clearTimeout(timer);
      this.all.delete(conn);
      if (!conn.machineId || this.conns.get(conn.machineId) !== conn) return;
      this.conns.delete(conn.machineId);
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
    if (old) fail(old.ws, 'replaced', '同一机器有新连接，旧连接被替换', 4004);

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

function reject(socket: Duplex, status: number, text: string) {
  // 客户端可能在收到响应后直接 RST，必须吞掉 socket 错误，否则进程会因未处理的 error 事件崩溃
  socket.on('error', () => {});
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
