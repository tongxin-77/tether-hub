import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readAudit } from '../src/audit.js';
import { Client, cookie, setup, waitFor, type Ctx } from './helpers.js';

let ctx: Ctx;
let ck: string;
before(async () => {
  ctx = await setup();
  ck = await cookie(ctx.base);
});
after(() => ctx.close());

const termUrl = (machine: string, session: number | string) =>
  `ws://127.0.0.1:${ctx.hub.port}/api/term?machine=${encodeURIComponent(machine)}&session=${session}`;

/** 浏览器端：带登录 cookie 与同源 Origin */
async function browser(machine: string, session: number, headers: Record<string, string> = {}) {
  const b = new Client(termUrl(machine, session), undefined, { cookie: ck, origin: ctx.base, ...headers });
  await b.opened;
  return b;
}

/** 在线的模拟 daemon，已上报一个会话 */
async function daemon(machineId: string, sessionId = 3) {
  const d = new Client(ctx.wsUrl, ctx.token);
  await d.opened;
  d.hello(machineId);
  await d.next('welcome');
  const now = Date.now();
  d.send({ type: 'sessions', sessions: [{ id: sessionId, name: 'pwsh', cwd: 'C:\\', command: 'pwsh', status: 'running', startedAt: now, lastActivityAt: now }] });
  await waitFor(() => ctx.hub.agents.machines.get(machineId)?.sessions.length === 1);
  return d;
}

const all = (c: Client, type: string) => c.messages.filter((m) => m.type === type);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const audit = (machineId: string) => readAudit(ctx.dir, 1000).filter((a) => a.machineId === machineId).reverse();

test('终端 WebSocket：未登录 401，跨源 403，参数错误 400', async () => {
  const reject = async (url: string, headers: Record<string, string>, status: number) =>
    assert.rejects(new Client(url, undefined, headers).opened, (e: any) => e.status === status);
  await reject(termUrl('m', 1), { origin: ctx.base }, 401);
  await reject(termUrl('m', 1), { cookie: ck, origin: 'http://evil.example' }, 403);
  await reject(termUrl('m', 1), { cookie: ck }, 403);
  await reject(termUrl('m', 'x'), { cookie: ck, origin: ctx.base }, 400);
});

test('接管：attach → 快照 → 输出转发 → 输入 / resize 下发 → 多浏览器复用 → 最后一个离开发 detach，并记审计', async () => {
  const d = await daemon('m-flow');
  const b1 = await browser('m-flow', 3);
  assert.deepEqual(await d.next('attach'), { type: 'attach', sessionId: 3 });

  // attached 之前的输入不下发
  b1.send({ type: 'input', data: 'eA==' });
  d.send({ type: 'attached', sessionId: 3, cols: 80, rows: 24, snapshot: 'U05BUDE=' });
  assert.deepEqual(await b1.next('snapshot'), { type: 'snapshot', cols: 80, rows: 24, data: 'U05BUDE=' });
  d.send({ type: 'output', sessionId: 3, data: 'b3V0MQ==' });
  assert.deepEqual(await b1.next('output'), { type: 'output', data: 'b3V0MQ==' });

  b1.send({ type: 'input', data: 'bHMK' });
  assert.deepEqual(await d.next('input'), { type: 'input', sessionId: 3, data: 'bHMK' });
  b1.send({ type: 'resize', cols: 0, rows: 30 });
  b1.send({ type: 'resize', cols: 120, rows: 30 });
  assert.deepEqual(await d.next('resize'), { type: 'resize', sessionId: 3, cols: 120, rows: 30 });
  assert.equal(all(d, 'input').length, 1);
  assert.equal(all(d, 'resize').length, 1, '超范围的 resize 不下发');

  // 第二个浏览器：再发一次 attach，新快照只给它
  const b2 = await browser('m-flow', 3);
  await waitFor(() => all(d, 'attach').length === 2);
  d.send({ type: 'attached', sessionId: 3, cols: 120, rows: 30, snapshot: 'U05BUDI=' });
  assert.equal((await b2.next('snapshot')).data, 'U05BUDI=');
  d.send({ type: 'output', sessionId: 3, data: 'b3V0Mg==' });
  await waitFor(() => all(b1, 'output').length === 2 && all(b2, 'output').length === 1);
  assert.equal(all(b1, 'snapshot').length, 1, '已在查看的浏览器不重复收快照');

  b1.ws.close();
  await b1.closed;
  await sleep(100);
  assert.equal(all(d, 'detach').length, 0, '还有浏览器在看时不发 detach');
  b2.ws.close();
  assert.deepEqual(await d.next('detach'), { type: 'detach', sessionId: 3 });

  await waitFor(() => audit('m-flow').length === 2);
  const [start, end] = audit('m-flow');
  assert.equal(start.event, 'start');
  assert.equal(start.machineName, 'DEV-PC');
  assert.equal(start.sessionId, 3);
  assert.equal(start.sessionName, 'pwsh');
  assert.equal(start.ip, '127.0.0.1');
  assert.match(start.time, /^\d{4}-\d\d-\d\dT/);
  assert.equal(end.event, 'end');
  assert.equal(end.ip, '127.0.0.1');

  const api = await (await fetch(`${ctx.base}/api/audit?limit=2`, { headers: { cookie: ck } })).json();
  assert.deepEqual(api.map((a: any) => a.event), ['end', 'start'], '新的在前');
  assert.equal((await fetch(`${ctx.base}/api/audit`)).status, 401);

  d.ws.close();
  await d.closed;
});

test('本地收回：浏览器收到 detached(reclaimed) 后被关闭，不再发 detach', async () => {
  const d = await daemon('m-reclaim');
  const b = await browser('m-reclaim', 3);
  await d.next('attach');
  d.send({ type: 'attached', sessionId: 3, cols: 80, rows: 24, snapshot: '' });
  await b.next('snapshot');
  d.send({ type: 'detached', sessionId: 3, reason: 'reclaimed' });
  assert.deepEqual(await b.next('detached'), { type: 'detached', reason: 'reclaimed' });
  assert.equal((await b.closed).code, 1000);
  await sleep(100);
  assert.equal(all(d, 'detach').length, 0);
  assert.deepEqual(audit('m-reclaim').map((a) => a.event), ['start', 'reclaimed']);
  d.ws.close();
  await d.closed;
});

test('本机未允许接管：浏览器收到 denied(disabled)，审计记 denied', async () => {
  const d = await daemon('m-deny');
  const b = await browser('m-deny', 3);
  await d.next('attach');
  d.send({ type: 'attachDenied', sessionId: 3, reason: 'disabled' });
  assert.deepEqual(await b.next('denied'), { type: 'denied', reason: 'disabled' });
  await b.closed;
  const [rec] = audit('m-deny');
  assert.equal(rec.event, 'denied');
  assert.equal(rec.reason, 'disabled');
  d.ws.close();
  await d.closed;
});

test('机器离线：接管离线机器立即收到 offline；接管中断线 / 被替换时通知浏览器并记审计', async () => {
  const off = await browser('m-none', 1);
  assert.deepEqual(await off.next('detached'), { type: 'detached', reason: 'offline' });
  await off.closed;

  const d = await daemon('m-drop');
  const b = await browser('m-drop', 3);
  await d.next('attach');
  d.send({ type: 'attached', sessionId: 3, cols: 80, rows: 24, snapshot: '' });
  await b.next('snapshot');
  d.ws.close();
  assert.deepEqual(await b.next('detached'), { type: 'detached', reason: 'offline' });
  await b.closed;
  await waitFor(() => audit('m-drop').length === 2);
  assert.equal(audit('m-drop')[1].event, 'disconnected');

  const d1 = await daemon('m-repl');
  const b1 = await browser('m-repl', 3);
  await d1.next('attach');
  const d2 = await daemon('m-repl');
  assert.deepEqual(await b1.next('detached'), { type: 'detached', reason: 'offline' });
  assert.equal((await d1.closed).code, 4004);
  await sleep(100);
  assert.equal(all(d2, 'attach').length, 0, '新连接上不会自动重新接管');
  d2.ws.close();
  await d2.closed;
});
