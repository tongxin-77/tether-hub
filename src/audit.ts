// 审计：接管、贴图与网页关闭会话事件（协议第 7、8 节）、hub 自身更新事件与网页 token 管理事件，逐行追加到 HUB_DATA_DIR/audit.jsonl。

import fs from 'node:fs';
import path from 'node:path';

export interface AuditRec {
  time: string;
  event: 'start' | 'denied' | 'end' | 'reclaimed' | 'disabled' | 'exited' | 'disconnected' | 'image' | 'image_failed' | 'close' | 'close_failed';
  machineId: string;
  machineName: string;
  sessionId: number;
  sessionName: string;
  ip?: string;
  reason?: string;
  /** 贴图（image / image_failed）：图片字节数与类型；不记保存路径、不存图片 */
  bytes?: number;
  mime?: string;
}

/** hub 一键更新事件 */
export interface UpdateAuditRec {
  time: string;
  event: 'update_start' | 'update_done' | 'update_failed';
  from: string;
  to: string;
  reason?: string;
}

/** 网页签发 / 吊销 token（命令行操作不记录） */
export interface TokenAuditRec {
  time: string;
  event: 'token_create' | 'token_revoke';
  tokenName: string;
  ip: string;
}

export const auditFile = (dir: string) => path.join(dir, 'audit.jsonl');

export function appendAudit(dir: string, rec: AuditRec | UpdateAuditRec | TokenAuditRec) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(auditFile(dir), JSON.stringify(rec) + '\n', { mode: 0o600 });
}

/** 最近 n 条，新的在前 */
export function readAudit(dir: string, n: number): (AuditRec | UpdateAuditRec | TokenAuditRec)[] {
  let text: string;
  try {
    text = fs.readFileSync(auditFile(dir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: (AuditRec | UpdateAuditRec | TokenAuditRec)[] = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    if (!lines[i]) continue;
    try {
      out.push(JSON.parse(lines[i]));
    } catch {}
  }
  return out;
}
