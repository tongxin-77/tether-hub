// 接管审计：逐行追加到 HUB_DATA_DIR/audit.jsonl（协议第 7 节）。

import fs from 'node:fs';
import path from 'node:path';

export interface AuditRec {
  time: string;
  event: 'start' | 'denied' | 'end' | 'reclaimed' | 'disabled' | 'exited' | 'disconnected';
  machineId: string;
  machineName: string;
  sessionId: number;
  sessionName: string;
  ip?: string;
  reason?: string;
}

export const auditFile = (dir: string) => path.join(dir, 'audit.jsonl');

export function appendAudit(dir: string, rec: AuditRec) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(auditFile(dir), JSON.stringify(rec) + '\n', { mode: 0o600 });
}

/** 最近 n 条，新的在前 */
export function readAudit(dir: string, n: number): AuditRec[] {
  let text: string;
  try {
    text = fs.readFileSync(auditFile(dir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: AuditRec[] = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    if (!lines[i]) continue;
    try {
      out.push(JSON.parse(lines[i]));
    } catch {}
  }
  return out;
}
