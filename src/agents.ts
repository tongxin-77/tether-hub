// daemon 连接管理与远程接管：协议见 docs/protocol.md（v2）。

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AuditRec, CreateAuditRec } from './audit.js';
import { findToken, type MachineRec, type TokenRec } from './store.js';

export const PROTO = 2;
/** 浏览器终端 WebSocket（/api/term）单条消息上限 */
export const MAX_MESSAGE = 1024 * 1024;
/** daemon 连接（/agent）单条消息上限：attached 可带最多约 1 MB 原始字节的历史（base64 后更大） */
export const MAX_AGENT_MESSAGE = 4 * 1024 * 1024;
/** hub 支持的能力位（协议 v2 能力位协商），随 welcome 下发；双方都声明的才使用 */
export const HUB_CAPS = ['history', 'image', 'close', 'create'];
/** 贴图：允许的类型、单张上限、分块大小（原始字节）、等待 daemon 回复的默认超时 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE = 10 * 1024 * 1024;
const IMAGE_CHUNK = 256 * 1024;
const IMAGE_TIMEOUT = 60_000;
/** 分块发送时 WebSocket 缓冲超过该值就等待，避免大图占满内存、拖慢同一连接上的终端输出 */
const IMAGE_BUFFERED = 1024 * 1024;
/** 网页关闭会话：等待 daemon 回 closeResult 的默认超时 */
const CLOSE_TIMEOUT = 10_000;
/** closeResult 失败原因 → 中文说明（API 的 error 字段与日志；网页按 code + reason 自行翻译） */
const CLOSE_REASON: Record<string, string> = {
  disabled: '本机未允许 hub 远程接管（关闭会话复用该开关）',
  not_found: '会话不存在或已退出',
};
/** 网页新建会话：取选项 / 列 Claude 历史对话、新建的默认超时（远程连接较慢） */
const QUERY_TIMEOUT = 10_000;
const CREATE_TIMEOUT = 30_000;
/** createOptionsResult / claudeHistoryResult / createResult 失败原因 → 中文说明（同上） */
const CREATE_REASON: Record<string, string> = {
  disabled: '本机未允许 hub 远程接管（新建会话复用该开关）',
  not_found: 'SSH 主机不存在',
  auth_required: 'SSH 需要输入密码或确认主机指纹',
  error: '本机操作失败',
};
/** daemon 回 imageFailed 的原因 → 中文说明（同上） */
const IMAGE_REASON: Record<string, string> = {
  disabled: '本机未允许接管',
  not_taken_over: '该会话未被 hub 接管',
  unsupported: '仅本地会话支持贴图（SSH 等远程会话不支持）',
  too_large: '图片过大（上限 10 MB）',
  bad_type: '文件内容与图片类型不符',
  io: '本机保存图片失败',
};

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
  /** 本次连接 hello 声明且 hub 也支持的能力位（离线时为空） */
  caps: string[];
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

/** 一次进行中的贴图上传，等待 daemon 回 imageSaved / imageFailed */
interface Upload {
  sessionId: number;
  timer?: NodeJS.Timeout;
  /** 结束上传（只生效一次）：写审计并返回结果 */
  done: (r: ImageResult, auditReason?: string) => void;
}

/** uploadImage 的结果：成功为保存路径；失败附 HTTP 状态码与中文原因 */
export type ImageResult = { ok: true; path: string } | Failure;

interface Conn {
  ws: WebSocket;
  machineId: string;
  tokenHash: string;
  alive: boolean;
  takeovers: Map<number, Takeover>;
  /** hello 声明且 hub 也支持的能力位 */
  caps: Set<string>;
  /** uploadId → 进行中的贴图 */
  uploads: Map<string, Upload>;
  /** requestId → 等待 closeResult 的关闭请求 */
  closes: Map<string, Closing>;
  /** requestId → 等待 *Result 的 create 能力请求（createOptions / claudeHistory / create） */
  requests: Map<string, Pending>;
}

/** 网页关闭会话的结果：成功，或附 HTTP 状态码与中文原因 */
export type CloseResult = { ok: true } | Failure;

interface Closing {
  sessionId: number;
  /** 结束请求（只生效一次）：写审计并返回结果 */
  done: (r: CloseResult, auditReason?: string) => void;
}

/** create 能力请求的失败：附 HTTP 状态码与中文原因（reason 为 daemon 回的原因） */
/** 失败：error 为中文说明（兼容字段），code 为网页翻译用的错误码；daemon 拒绝时带 reason 与 daemon 附带的 detail */
export type Failure = { ok: false; status: number; error: string; code: string; reason?: string; detail?: string };
type Reply = { ok: true; msg: Record<string, unknown> } | Failure;

interface Pending {
  /** 期待的回复类型 */
  result: string;
  /** 结束请求（只生效一次） */
  done: (r: Reply, auditReason?: string) => void;
}

/** 新建会话的目标与可选参数（由 Web 层校验后原样转给 daemon） */
export interface CreateRequest {
  target: { kind: 'local'; cwd?: string } | { kind: 'remote'; hostId: string; cwd?: string };
  resume?: { id: string; permissionMode?: string; bypass?: boolean };
  cols?: number;
  rows?: number;
}

export type CreateOptions = { ok: true; home: string; recent: Record<string, unknown>[]; hosts: Record<string, unknown>[] };
export type ClaudeHistory = { ok: true; items: Record<string, unknown>[] };

export interface AgentOptions {
  hubVersion: string;
  helloTimeoutMs: number;
  pingIntervalMs: number;
  /** 当前 token 列表（由 hub.json 加载） */
  tokens: () => TokenRec[];
  /** 机器档案变化（上线 / 下线）时调用，用于持久化 */
  persist: () => void;
  /** 记录一条接管审计 */
  audit: (rec: AuditRec | CreateAuditRec) => void;
  log: (msg: string) => void;
  /** 贴图等待 daemon 回复的超时（默认 60 s，测试可缩短） */
  imageTimeoutMs?: number;
  /** 关闭会话等待 daemon 回复的超时（默认 10 s，测试可缩短） */
  closeTimeoutMs?: number;
  /** 新建会话：取选项 / 列 Claude 历史对话等待 daemon 回复的超时（默认 10 s）与新建的超时（默认 30 s），测试可缩短 */
  queryTimeoutMs?: number;
  createTimeoutMs?: number;
}

const SESSION_KEYS = ['id', 'name', 'cwd', 'command', 'status', 'startedAt', 'lastActivityAt', 'host', 'hostId', 'claude'] as const;

/** 字符串且字符数（按 Unicode 码点计）在 [min, max] 内 */
const str = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && [...v].length >= min && [...v].length <= max;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** hello.caps：字符串数组且不超过 16 项，否则（含缺省）按空集；只保留 hub 也支持的 */
function parseCaps(v: unknown): Set<string> {
  if (!Array.isArray(v) || v.length > 16 || !v.every((c) => str(c, 1, 64))) return new Set();
  return new Set(v.filter((c) => HUB_CAPS.includes(c)));
}

/** 数组中满足 ok 的对象只保留已知字段（daemon 回复转给浏览器前过滤） */
function pickAll(v: unknown, keys: readonly string[], ok: (o: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((o): o is Record<string, unknown> => isObj(o) && ok(o)).map((o) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])));
}

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
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AGENT_MESSAGE });
  private pingTimer: NodeJS.Timeout;

  constructor(private opt: AgentOptions, saved: MachineRec[]) {
    super();
    for (const m of saved) this.machines.set(m.machineId, { ...m, online: false, sessions: [], caps: [] });
    this.pingTimer = setInterval(() => this.ping(), opt.pingIntervalMs);
  }

  /** 供持久化使用的机器档案 */
  records(): MachineRec[] {
    return [...this.machines.values()].map(({ machineId, name, version, tokenName, lastSeen }) => ({
      machineId, name, version, tokenName, lastSeen,
    }));
  }

  /** 进行中的接管数 */
  takeoverCount() {
    let n = 0;
    for (const c of this.conns.values()) n += c.takeovers.size;
    return n;
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
    const conn: Conn = { ws, machineId: '', tokenHash: token.sha256, alive: true, takeovers: new Map(), caps: new Set(), uploads: new Map(), closes: new Map(), requests: new Map() };
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
        conn.caps = parseCaps(msg.caps);
        if (msg.probe) {
          // 探测连接（客户端「测试连接」）：只回 welcome，不登记 / 不替换常驻连接、不更新档案；
          // 它不在 conns 中，之后的 sessions 与关闭都会被下方的「是否当前连接」检查忽略
          send(ws, { type: 'welcome', proto: PROTO, hubVersion: this.opt.hubVersion, caps: HUB_CAPS });
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
      if (msg.type === 'closeResult' && typeof msg.requestId === 'string') {
        const c = conn.closes.get(msg.requestId);
        if (!c || c.sessionId !== msg.sessionId) return;
        if (msg.ok === true) return c.done({ ok: true });
        const reason = String(msg.reason);
        return c.done({ ok: false, status: 422, error: CLOSE_REASON[reason] ?? `关闭失败（${reason}）`, code: 'close_rejected', reason }, reason);
      }
      if (typeof msg.requestId === 'string' && conn.requests.get(msg.requestId)?.result === msg.type) {
        const p = conn.requests.get(msg.requestId)!;
        if (msg.ok === true) return p.done({ ok: true, msg });
        const reason = String(msg.reason);
        // daemon 附的 message（如 auth_required 的可读说明）接在原因后面；disabled 的说明与原因重复，不接
        const detail = reason !== 'disabled' && typeof msg.message === 'string' ? msg.message.slice(0, 500) : '';
        const text = CREATE_REASON[reason] ?? `操作失败（${reason}）`;
        return p.done({ ok: false, status: 422, error: detail ? `${text}：${detail}` : text, code: 'create_rejected', reason, ...(detail ? { detail } : {}) }, reason);
      }
      if ((msg.type === 'imageSaved' || msg.type === 'imageFailed') && typeof msg.uploadId === 'string') {
        const u = conn.uploads.get(msg.uploadId);
        if (!u || u.sessionId !== msg.sessionId) return;
        if (msg.type === 'imageSaved' && typeof msg.path === 'string') return u.done({ ok: true, path: msg.path });
        const reason = String(msg.reason);
        return u.done({ ok: false, status: 422, error: IMAGE_REASON[reason] ?? `贴图失败（${reason}）`, code: 'image_rejected', reason }, reason);
      }
      const t = typeof msg.sessionId === 'number' ? conn.takeovers.get(msg.sessionId) : undefined;
      if (!t) return;
      if (msg.type === 'attached' && typeof msg.snapshot === 'string') {
        if (!t.active) {
          t.active = true;
          this.audit(conn, t.sessionId, 'start', { ip: t.ip });
        }
        // 每次 attached 都带新快照：只发给还没拿到快照的浏览器；history（能力 history）原样转发
        const history = typeof msg.history === 'string' ? { history: msg.history } : {};
        for (const v of t.viewers) {
          if (t.ready.has(v)) continue;
          v.send({ type: 'snapshot', cols: msg.cols, rows: msg.rows, data: msg.snapshot, ...history });
          t.ready.add(v);
        }
      } else if (msg.type === 'attachDenied') {
        this.finish(conn, t, { type: 'denied', reason: String(msg.reason) });
        this.audit(conn, t.sessionId, 'denied', { ip: t.ip, reason: String(msg.reason) });
      } else if (msg.type === 'output' && typeof msg.data === 'string') {
        for (const v of t.ready) v.send({ type: 'output', data: msg.data });
      } else if (msg.type === 'detached') {
        // 网页关闭会话时 daemon 先回 detached(exited) 再回 closeResult：告诉浏览器是被网页关闭的（审计仍记 exited，close 另记）
        const closing = msg.reason === 'exited' && [...conn.closes.values()].some((c) => c.sessionId === t.sessionId);
        this.finish(conn, t, { type: 'detached', reason: closing ? 'session_closed' : String(msg.reason) });
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
        m.caps = [];
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
      online: true, lastSeen: Date.now(), sessions: prev?.sessions ?? [], caps: [...conn.caps],
    });
    send(conn.ws, { type: 'welcome', proto: PROTO, hubVersion: this.opt.hubVersion, caps: HUB_CAPS });
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
        this.failUploads(conn, sessionId);
        send(conn.ws, { type: 'detach', sessionId });
        if (t.active) this.audit(conn, sessionId, 'end', { ip: v.ip });
      },
    };
  }

  /** 结束一个接管：通知并关闭所有浏览器 */
  private finish(conn: Conn, t: Takeover, msg: object) {
    conn.takeovers.delete(t.sessionId);
    this.failUploads(conn, t.sessionId);
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
    this.failUploads(conn);
    for (const c of [...conn.closes.values()]) c.done({ ok: false, status: 409, error: '机器已断开', code: 'machine_disconnected' }, 'disconnected');
    for (const p of [...conn.requests.values()]) p.done({ ok: false, status: 409, error: '机器已断开', code: 'machine_disconnected' }, 'disconnected');
  }

  /**
   * 贴图：把图片分块发给 daemon（imageBegin → imageChunk… → imageEnd），等它回 imageSaved / imageFailed。
   * 要求机器在线、双方都有 image 能力、该会话有生效的接管；接管结束 / 断线（409）、超时（504）都会结束等待。
   */
  async uploadImage(machineId: string, sessionId: number, mime: string, data: Buffer, ip: string): Promise<ImageResult> {
    const conn = this.conns.get(machineId);
    if (!conn) return { ok: false, status: 409, error: '机器离线', code: 'machine_offline' };
    if (!conn.caps.has('image')) return { ok: false, status: 409, error: '该机器的 Tether 不支持贴图（需 Tether 0.5.0+）', code: 'image_unsupported' };
    if (!conn.takeovers.get(sessionId)?.active) return { ok: false, status: 409, error: '该会话没有生效的接管', code: 'no_takeover' };

    const uploadId = randomUUID();
    let settled = false;
    const result = new Promise<ImageResult>((resolve) => {
      const u: Upload = {
        sessionId,
        done: (r, auditReason) => {
          if (settled) return;
          settled = true;
          clearTimeout(u.timer);
          conn.uploads.delete(uploadId);
          if (r.ok) this.audit(conn, sessionId, 'image', { ip, bytes: data.length, mime });
          else this.audit(conn, sessionId, 'image_failed', { ip, bytes: data.length, mime, reason: auditReason });
          resolve(r);
        },
      };
      u.timer = setTimeout(() => u.done({ ok: false, status: 504, error: '等待本机保存图片超时', code: 'image_timeout' }, 'timeout'), this.opt.imageTimeoutMs ?? IMAGE_TIMEOUT);
      conn.uploads.set(uploadId, u);
    });

    // 每块等写入 socket，缓冲积压时暂停，避免一次性把整张图塞进发送缓冲
    const ws = conn.ws;
    await sendWait(ws, { type: 'imageBegin', sessionId, uploadId, mime, size: data.length });
    for (let off = 0; off < data.length && !settled; off += IMAGE_CHUNK) {
      while (ws.bufferedAmount > IMAGE_BUFFERED && ws.readyState === ws.OPEN && !settled) await new Promise((r) => setTimeout(r, 20));
      await sendWait(ws, { type: 'imageChunk', sessionId, uploadId, data: data.subarray(off, off + IMAGE_CHUNK).toString('base64') });
    }
    if (!settled) await sendWait(ws, { type: 'imageEnd', sessionId, uploadId });
    return result;
  }

  /**
   * 网页关闭远端会话：发 close，等 daemon 回 closeResult。不要求该会话正被接管；
   * 会话退出由 daemon 照常通过 sessions 上报，接管（如有）按现有 detached 逻辑结束。
   */
  closeSession(machineId: string, sessionId: number, ip: string): Promise<CloseResult> {
    const conn = this.conns.get(machineId);
    if (!conn) return Promise.resolve({ ok: false, status: 409, error: '机器离线', code: 'machine_offline' });
    if (!conn.caps.has('close')) return Promise.resolve({ ok: false, status: 409, error: '该机器的 Tether 不支持网页关闭会话（需 Tether 0.5.0+）', code: 'close_unsupported' });
    const requestId = randomUUID();
    // 会话名称在发出前记下：成功后会话可能很快从列表中移除
    const sessionName = this.machines.get(machineId)?.sessions.find((s) => s.id === sessionId)?.name ?? '';
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const c: Closing = {
        sessionId,
        done: (r, auditReason) => {
          if (conn.closes.get(requestId) !== c) return;
          conn.closes.delete(requestId);
          clearTimeout(timer);
          this.audit(conn, sessionId, r.ok ? 'close' : 'close_failed', { ip, sessionName, ...(r.ok ? {} : { reason: auditReason }) });
          resolve(r);
        },
      };
      conn.closes.set(requestId, c);
      timer = setTimeout(() => c.done({ ok: false, status: 504, error: '等待本机关闭会话超时', code: 'close_timeout' }, 'timeout'), this.opt.closeTimeoutMs ?? CLOSE_TIMEOUT);
      send(conn.ws, { type: 'close', sessionId, requestId });
    });
  }

  /** 网页新建会话：取最近目录、SSH 主机列表与用户目录 */
  async createOptions(machineId: string): Promise<CreateOptions | Failure> {
    const conn = this.createConn(machineId);
    if ('ok' in conn) return conn;
    const r = await this.request(conn, { type: 'createOptions' }, 'createOptionsResult', this.opt.queryTimeoutMs ?? QUERY_TIMEOUT);
    if (!r.ok) return r;
    return {
      ok: true,
      home: typeof r.msg.home === 'string' ? r.msg.home : '',
      recent: pickAll(r.msg.recent, ['kind', 'cwd', 'hostId', 'host'], (o) => (o.kind === 'local' || o.kind === 'remote') && typeof o.cwd === 'string'),
      hosts: pickAll(r.msg.hosts, ['id', 'name'], (o) => typeof o.id === 'string'),
    };
  }

  /** 网页新建会话：列出本地目录 cwd 下的 Claude 历史对话 */
  async claudeHistory(machineId: string, cwd: string): Promise<ClaudeHistory | Failure> {
    const conn = this.createConn(machineId);
    if ('ok' in conn) return conn;
    const r = await this.request(conn, { type: 'claudeHistory', cwd }, 'claudeHistoryResult', this.opt.queryTimeoutMs ?? QUERY_TIMEOUT);
    if (!r.ok) return r;
    return { ok: true, items: pickAll(r.msg.items, ['id', 'title', 'mtime', 'messages', 'permissionMode', 'bypass', 'open'], (o) => typeof o.id === 'string') };
  }

  /** 网页新建会话：发 create，等 daemon 回 createResult（成功前 daemon 已上报 sessions）；记审计 create / create_failed */
  async createSession(machineId: string, req: CreateRequest, ip: string): Promise<{ ok: true; sessionId: number } | Failure> {
    const conn = this.createConn(machineId);
    if ('ok' in conn) return conn;
    const t = req.target;
    const target = `${t.kind === 'remote' ? `ssh ${t.hostId}` : 'local'} ${t.cwd || '~'}${req.resume ? `（恢复 Claude 对话 ${req.resume.id}）` : ''}`;
    const r = await this.request(conn, { type: 'create', ...req }, 'createResult', this.opt.createTimeoutMs ?? CREATE_TIMEOUT, (r, auditReason) => {
      const m = this.machines.get(conn.machineId);
      const sessionId = r.ok && Number.isInteger(r.msg.sessionId) ? (r.msg.sessionId as number) : undefined;
      const rec: CreateAuditRec = {
        time: new Date().toISOString(), event: r.ok ? 'create' : 'create_failed', machineId: conn.machineId, machineName: m?.name ?? '',
        ...(sessionId === undefined ? {} : { sessionId, sessionName: m?.sessions.find((s) => s.id === sessionId)?.name ?? '' }),
        target, ip, ...(r.ok ? {} : { reason: auditReason }),
      };
      this.opt.log(`接管审计：${rec.event} ${rec.machineName}（${rec.machineId}）${target}${rec.reason ? `，${rec.reason}` : ''}，${ip}`);
      this.opt.audit(rec);
    });
    if (!r.ok) return r;
    const id = r.msg.sessionId;
    if (!Number.isInteger(id) || (id as number) < 0) return { ok: false, status: 502, error: '本机回复格式错误', code: 'bad_reply' };
    return { ok: true, sessionId: id as number };
  }

  /** create 能力请求的前置检查：机器在线且双方都有 create 能力 */
  private createConn(machineId: string): Conn | Failure {
    const conn = this.conns.get(machineId);
    if (!conn) return { ok: false, status: 409, error: '机器离线', code: 'machine_offline' };
    if (!conn.caps.has('create')) return { ok: false, status: 409, error: '该机器的 Tether 不支持网页新建会话（请更新 Tether）', code: 'create_unsupported' };
    return conn;
  }

  /** 发出带 requestId 的请求，等 daemon 回 result 类型的消息；超时 504、断线 409 */
  private request(conn: Conn, msg: Record<string, unknown>, result: string, timeoutMs: number, onDone?: (r: Reply, auditReason?: string) => void): Promise<Reply> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const p: Pending = {
        result,
        done: (r, auditReason) => {
          if (conn.requests.get(requestId) !== p) return;
          conn.requests.delete(requestId);
          clearTimeout(timer);
          onDone?.(r, auditReason);
          resolve(r);
        },
      };
      conn.requests.set(requestId, p);
      timer = setTimeout(() => p.done({ ok: false, status: 504, error: '等待本机回复超时', code: 'reply_timeout' }, 'timeout'), timeoutMs);
      send(conn.ws, { ...msg, requestId });
    });
  }

  /** 接管结束 / 断线：结束该会话（不指定则该连接全部）挂起的贴图 */
  private failUploads(conn: Conn, sessionId?: number) {
    for (const u of [...conn.uploads.values()]) {
      if (sessionId === undefined || u.sessionId === sessionId) u.done({ ok: false, status: 409, error: '接管已结束', code: 'takeover_ended' }, 'ended');
    }
  }

  private audit(conn: Conn, sessionId: number, event: AuditRec['event'], extra: { ip?: string; reason?: string; bytes?: number; mime?: string; sessionName?: string } = {}) {
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

/** 发送并等数据写入 socket（连接已关闭或发送出错时也返回） */
function sendWait(ws: WebSocket, msg: object) {
  return new Promise<void>((resolve) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg), () => resolve());
    else resolve();
  });
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
