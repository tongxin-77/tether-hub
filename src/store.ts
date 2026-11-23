// hub.json 持久化：token（只存 SHA-256）与机器档案。
// hub 进程与 token CLI 都会读改写同一个文件，用锁文件互斥，写入时先写临时文件再 rename 保证原子性。

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface TokenRec {
  name: string;
  sha256: string;
  /** Unix 毫秒时间戳 */
  createdAt: number;
  revoked: boolean;
}

export interface MachineRec {
  machineId: string;
  name: string;
  version: string;
  tokenName: string;
  /** 最后在线时间，Unix 毫秒时间戳 */
  lastSeen: number;
}

export interface HubData {
  tokens: TokenRec[];
  machines: MachineRec[];
}

export const dataFile = (dir: string) => path.join(dir, 'hub.json');

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function readData(dir: string): HubData {
  let text: string;
  try {
    text = fs.readFileSync(dataFile(dir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { tokens: [], machines: [] };
    throw e;
  }
  const d = JSON.parse(text) as Partial<HubData>;
  return { tokens: d.tokens ?? [], machines: d.machines ?? [] };
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 同步重试：Windows 上目标文件被其他进程短暂打开时 rename 会报 EPERM / EBUSY */
function retry<T>(fn: () => T): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      sleep(25);
    }
  }
}

function writeData(dir: string, data: HubData) {
  const file = dataFile(dir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...data }, null, 2) + '\n', { mode: 0o600 });
  retry(() => fs.renameSync(tmp, file));
}

/** 加锁读改写；锁超过 10 s 视为残留（进程崩溃）并清除 */
export function updateData(dir: string, fn: (d: HubData) => void): HubData {
  fs.mkdirSync(dir, { recursive: true });
  const lock = dataFile(dir) + '.lock';
  for (let i = 0; ; i++) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true });
      } catch {}
      if (i >= 200) throw new Error(`无法获取锁 ${lock}`);
      sleep(25);
    }
  }
  try {
    const d = readData(dir);
    fn(d);
    writeData(dir, d);
    return d;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

const NAME_RE = /^[^\s\x00-\x1f]{1,64}$/u;

/** 名称非法 / 重复等业务错误：message 为中文原文（命令行输出），errCode / params 供网页按语言显示 */
const nameError = (message: string, errCode: string, name?: string) =>
  Object.assign(new Error(message), { errCode, params: name === undefined ? {} : { name } });

/** 签发 token，返回明文（只此一次） */
export function createToken(dir: string, name: string): string {
  if (!NAME_RE.test(name)) throw nameError('名称须为 1~64 个非空白字符', 'token_name_invalid');
  const token = 'th_' + randomBytes(32).toString('base64url');
  updateData(dir, (d) => {
    if (d.tokens.some((t) => t.name === name)) throw nameError(`名称「${name}」已存在（含已吊销的），请换一个`, 'token_exists', name);
    d.tokens.push({ name, sha256: hashToken(token), createdAt: Date.now(), revoked: false });
  });
  return token;
}

export function revokeToken(dir: string, name: string) {
  updateData(dir, (d) => {
    const t = d.tokens.find((t) => t.name === name);
    if (!t) throw nameError(`没有名为「${name}」的 token`, 'token_not_found', name);
    if (t.revoked) throw nameError(`token「${name}」已经吊销过了`, 'token_already_revoked', name);
    t.revoked = true;
  });
}

/** 校验明文 token，返回有效 token 的记录 */
export function findToken(tokens: TokenRec[], token: string): TokenRec | undefined {
  const h = hashToken(token);
  return tokens.find((t) => !t.revoked && t.sha256 === h);
}
