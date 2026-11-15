import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { readAudit } from '../src/audit.js';
import { HUB_VERSION } from '../src/server.js';
import { Client, cookie, setup, waitFor, type Ctx } from './helpers.js';

// 协议 v2 能力位（history / image / close）：welcome 带 caps、attached.history 转发、贴图接口、网页关闭会话

let ctx: Ctx;
let ck: string;
before(async () => {
  ctx = await setup({ imageTimeoutMs: 300, closeTimeoutMs: 300 });
  ck = await cookie(ctx.base);
});
after(() => ctx.close());

const termUrl = (machine: string, session: number) =>
  `ws://127.0.0.1:${ctx.hub.port}/api/term?machine=${encodeURIComponent(machine)}&session=${session}`;
const all = (c: Client, type: string) => c.messages.filter((m) => m.type === type);
const audit = (machineId: string) => readAudit(ctx.dir, 1000).filter((a) => a.machineId === machineId).reverse();

/** 在线的模拟 daemon，已上报会话 3 */
async function daemon(machineId: string, hello: object = { caps: ['history', 'image', 'close'] }) {
  const d = new Client(ctx.wsUrl, ctx.token);
  await d.opened;
  d.hello(machineId, hello);
  await d.next('welcome');
  const now = Date.now();
  d.send({ type: 'sessions', sessions: [{ id: 3, name: 'pwsh', cwd: 'C:\\', command: 'pwsh', status: 'running', startedAt: now, lastActivityAt: now }] });
  await waitFor(() => ctx.hub.agents.machines.get(machineId)?.sessions.length === 1);
  return d;
}

/** daemon + 一个已拿到快照的浏览器（接管生效） */
async function taken(machineId: string, hello?: object) {
  const d = await daemon(machineId, hello);
  const b = new Client(termUrl(machineId, 3), undefined, { cookie: ck, origin: ctx.base });
  await b.opened;
  await d.next('attach');
  d.send({ type: 'attached', sessionId: 3, cols: 80, rows: 24, snapshot: '' });
  await b.next('snapshot');
  return { d, b };
}

function upload(machine: string, body: Buffer, headers: Record<string, string> = {}, session = 3) {
  return fetch(`${ctx.base}/api/term/image?machine=${encodeURIComponent(machine)}&session=${session}`, {
    method: 'POST', body, headers: { cookie: ck, origin: ctx.base, 'content-type': 'image/png', ...headers },
  });
}

test('welcome 带 hub 能力位；hello 的 caps 存入机器状态（只保留 hub 支持的）', async () => {
  const d = await daemon('m-caps', { caps: ['image', 'future-x', 'history'] });
  assert.deepEqual(d.messages.find((m) => m.type === 'welcome'), { type: 'welcome', proto: 2, hubVersion: HUB_VERSION, caps: ['history', 'image', 'close'] });
  assert.deepEqual(ctx.hub.agents.machines.get('m-caps')!.caps.sort(), ['history', 'image']);
  const st = await (await fetch(`${ctx.base}/api/state`, { headers: { cookie: ck } })).json();
  assert.deepEqual(st.machines.find((m: any) => m.machineId === 'm-caps').caps.sort(), ['history', 'image']);
  d.ws.close();
  await d.closed;
  await waitFor(() => !ctx.hub.agents.machines.get('m-caps')!.online);
  assert.deepEqual(ctx.hub.agents.machines.get('m-caps')!.caps, [], '离线后清空');
});

test('hello 无 caps / caps 非法 → caps 为空集，照常工作', async () => {
  for (const [id, hello] of [['m-old', {}], ['m-bad1', { caps: 'image' }], ['m-bad2', { caps: ['image', 1] }], ['m-bad3', { caps: Array(17).fill('image') }]] as const) {
    const { d, b } = await taken(id, hello);
    assert.deepEqual(ctx.hub.agents.machines.get(id)!.caps, [], id);
    b.send({ type: 'input', data: 'bHMK' });
    assert.equal((await d.next('input')).data, 'bHMK');
    d.ws.close();
    await d.closed;
  }
});

test('attached.history 原样转发到浏览器 snapshot；2 MB 的 attached 不会被断开', async () => {
  const d = await daemon('m-hist');
  const b = new Client(termUrl('m-hist', 3), undefined, { cookie: ck, origin: ctx.base });
  await b.opened;
  await d.next('attach');
  const history = Buffer.alloc(1536 * 1024, 'h').toString('base64'); // 约 2 MB base64
  d.send({ type: 'attached', sessionId: 3, cols: 120, rows: 30, snapshot: 'U05BUA==', history });
  const snap = await b.next('snapshot', 5000);
  assert.equal(snap.history, history);
  assert.equal(snap.data, 'U05BUA==');
  d.send({ type: 'output', sessionId: 3, data: 'b3V0' });
  assert.equal((await b.next('output')).data, 'b3V0');
  assert.equal(d.ws.readyState, d.ws.OPEN);

  // 没有 history 字段时 snapshot 也不带
  const b2 = new Client(termUrl('m-hist', 3), undefined, { cookie: ck, origin: ctx.base });
  await b2.opened;
  await waitFor(() => all(d, 'attach').length === 2);
  d.send({ type: 'attached', sessionId: 3, cols: 120, rows: 30, snapshot: 'U05BUA==' });
  assert.equal('history' in (await b2.next('snapshot')), false);
  d.ws.close();
  await d.closed;
});

test('超过 4 MB 的 daemon 消息仍被拒绝', async () => {
  const d = await daemon('m-huge');
  d.send('x'.repeat(4 * 1024 * 1024 + 1));
  assert.equal((await d.closed).code, 1009);
});

test('贴图接口：未登录 401、跨源 403、类型 415、过大 413、无能力 / 无接管 / 离线 409', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  assert.equal((await upload('m-x', png, { cookie: '' })).status, 401);
  assert.equal((await upload('m-x', png, { origin: 'http://evil.example' })).status, 403);
  const r415 = await upload('m-x', png, { 'content-type': 'text/plain' });
  assert.equal(r415.status, 415);
  assert.match((await r415.json()).error, /PNG/);
  assert.equal((await upload('m-x', Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);

  // 不带 Content-Length（分块传输）时边读边限
  const chunked = await new Promise<number>((resolve) => {
    const u = new URL(`${ctx.base}/api/term/image?machine=m-x&session=3`);
    const req = http.request(u, { method: 'POST', headers: { cookie: ck, origin: ctx.base, 'content-type': 'image/png', 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', () => {}); // 服务器回 413 后关闭连接，后续写入出错属预期
    const block = Buffer.alloc(1024 * 1024);
    void (async () => {
      for (let i = 0; i < 12 && !req.destroyed; i++) if (!req.write(block)) await new Promise((r) => req.once('drain', r));
      req.end();
    })();
  });
  assert.equal(chunked, 413);

  assert.equal((await upload('m-offline', png)).status, 409);
  const old = await taken('m-nocap', {});
  const r = await upload('m-nocap', png);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /0\.5\.0/);
  old.d.ws.close();
  await old.d.closed;

  const d = await daemon('m-notaken');
  assert.equal((await upload('m-notaken', png)).status, 409, '没有生效的接管');
  assert.equal(all(d, 'imageBegin').length, 0);
  d.ws.close();
  await d.closed;
});

test('贴图：分块发送、拼回一致，imageSaved → 200 + path，并记审计', async () => {
  const { d, b } = await taken('m-img');
  const img = Buffer.alloc(600 * 1024);
  for (let i = 0; i < img.length; i++) img[i] = (i * 7) & 0xff;
  const res = upload('m-img', img, { 'content-type': 'image/png; charset=binary' });
  const begin = await d.next('imageBegin');
  assert.deepEqual({ ...begin, uploadId: undefined }, { type: 'imageBegin', sessionId: 3, uploadId: undefined, mime: 'image/png', size: img.length });
  assert.ok(typeof begin.uploadId === 'string' && begin.uploadId.length >= 16);
  await d.next('imageEnd');
  const chunks = all(d, 'imageChunk');
  assert.equal(chunks.length, 3, '256 KB 一块');
  assert.ok(chunks.every((c) => c.uploadId === begin.uploadId && c.sessionId === 3));
  assert.ok(Buffer.from(chunks[0].data, 'base64').length === 256 * 1024);
  assert.ok(Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64'))).equals(img));

  // uploadId 或 sessionId 不符的回复忽略
  d.send({ type: 'imageSaved', sessionId: 3, uploadId: 'other', path: 'X' });
  d.send({ type: 'imageSaved', sessionId: 4, uploadId: begin.uploadId, path: 'X' });
  d.send({ type: 'imageSaved', sessionId: 3, uploadId: begin.uploadId, path: 'C:\\Temp\\tether-img\\a.png' });
  const r = await res;
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { path: 'C:\\Temp\\tether-img\\a.png' });

  await waitFor(() => audit('m-img').some((a) => a.event === 'image'));
  const rec = audit('m-img').find((a) => a.event === 'image')! as any;
  assert.equal(rec.bytes, img.length);
  assert.equal(rec.mime, 'image/png');
  assert.equal(rec.ip, '127.0.0.1');
  assert.equal(rec.sessionName, 'pwsh');
  assert.equal('path' in rec, false, '审计不记路径');
  b.ws.close();
  d.ws.close();
  await d.closed;
});

test('贴图：imageFailed → 422 + 中文原因，审计 image_failed', async () => {
  const { d } = await taken('m-imgf');
  const res = upload('m-imgf', Buffer.from('not a png'));
  const begin = await d.next('imageBegin');
  d.send({ type: 'imageFailed', sessionId: 3, uploadId: begin.uploadId, reason: 'unsupported' });
  const r = await res;
  assert.equal(r.status, 422);
  const body = await r.json();
  assert.equal(body.reason, 'unsupported');
  assert.match(body.error, /本地会话/);
  await waitFor(() => audit('m-imgf').some((a) => a.event === 'image_failed'));
  assert.equal(audit('m-imgf').find((a) => a.event === 'image_failed')!.reason, 'unsupported');
  d.ws.close();
  await d.closed;
});

test('贴图：daemon 不回复 → 504（超时可注入）', async () => {
  const { d } = await taken('m-imgt');
  const r = await upload('m-imgt', Buffer.from('x'));
  assert.equal(r.status, 504);
  await waitFor(() => audit('m-imgt').some((a) => a.event === 'image_failed' && a.reason === 'timeout'));
  d.ws.close();
  await d.closed;
});

test('贴图：等待期间接管结束（本地收回 / 断线）→ 挂起的上传结束', async () => {
  const { d } = await taken('m-imge');
  const res = upload('m-imge', Buffer.from('x'));
  await d.next('imageEnd');
  d.send({ type: 'detached', sessionId: 3, reason: 'reclaimed' });
  const r = await res;
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /接管已结束/);

  const t2 = await taken('m-imge2');
  const res2 = upload('m-imge2', Buffer.from('x'));
  await t2.d.next('imageEnd');
  t2.d.ws.close();
  assert.equal((await res2).status, 409);
  await waitFor(() => audit('m-imge2').some((a) => a.event === 'image_failed' && a.reason === 'ended'));
  d.ws.close();
  await d.closed;
});

function closeReq(machine: string, headers: Record<string, string> = {}, session = 3) {
  return fetch(`${ctx.base}/api/session/close?machine=${encodeURIComponent(machine)}&session=${session}`, {
    method: 'POST', headers: { cookie: ck, origin: ctx.base, ...headers },
  });
}

test('关闭会话：未登录 401、跨源 403、离线 / 无 close 能力 409、参数错误 400', async () => {
  assert.equal((await closeReq('m-x', { cookie: '' })).status, 401);
  assert.equal((await closeReq('m-x', { origin: 'http://evil.example' })).status, 403);
  assert.equal((await closeReq('m-x', {}, -1)).status, 400);
  assert.equal((await closeReq('m-offline')).status, 409);
  const d = await daemon('m-close-old', { caps: ['history', 'image'] });
  const r = await closeReq('m-close-old');
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /0\.5\.0/);
  assert.equal(all(d, 'close').length, 0);
  d.ws.close();
  await d.closed;
});

test('关闭会话：不要求接管；closeResult ok → 200 并记审计 close', async () => {
  const d = await daemon('m-close');
  const res = closeReq('m-close');
  const c = await d.next('close');
  assert.deepEqual({ ...c, requestId: undefined }, { type: 'close', sessionId: 3, requestId: undefined });
  assert.ok(typeof c.requestId === 'string' && c.requestId.length >= 16);
  // requestId / sessionId 不符的忽略
  d.send({ type: 'closeResult', sessionId: 3, requestId: 'other', ok: true });
  d.send({ type: 'closeResult', sessionId: 4, requestId: c.requestId, ok: true });
  d.send({ type: 'closeResult', sessionId: 3, requestId: c.requestId, ok: true });
  const r = await res;
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  await waitFor(() => audit('m-close').some((a) => a.event === 'close'));
  const rec = audit('m-close').find((a) => a.event === 'close')!;
  assert.equal(rec.sessionName, 'pwsh');
  assert.equal(rec.ip, '127.0.0.1');
  d.ws.close();
  await d.closed;
});

test('关闭会话：ok:false → 422 + 中文原因；超时 504；等待中断线 409，均记 close_failed', async () => {
  const d = await daemon('m-closef');
  const res = closeReq('m-closef');
  const c = await d.next('close');
  d.send({ type: 'closeResult', sessionId: 3, requestId: c.requestId, ok: false, reason: 'disabled' });
  const r = await res;
  assert.equal(r.status, 422);
  const body = await r.json();
  assert.equal(body.reason, 'disabled');
  assert.match(body.error, /允许/);

  assert.equal((await closeReq('m-closef')).status, 504);

  const res3 = closeReq('m-closef');
  await waitFor(() => all(d, 'close').length === 3);
  d.ws.close();
  assert.equal((await res3).status, 409);
  await waitFor(() => audit('m-closef').filter((a) => a.event === 'close_failed').length === 3);
  assert.deepEqual(audit('m-closef').filter((a) => a.event === 'close_failed').map((a) => a.reason), ['disabled', 'timeout', 'disconnected']);
});

test('关闭正被接管的会话：daemon 先 detached(exited) 再 closeResult，浏览器收到 session_closed，审计 exited 与 close 各一条', async () => {
  const { d, b } = await taken('m-closet');
  const res = closeReq('m-closet');
  const c = await d.next('close');
  d.send({ type: 'detached', sessionId: 3, reason: 'exited' });
  d.send({ type: 'closeResult', sessionId: 3, requestId: c.requestId, ok: true });
  d.send({ type: 'sessions', sessions: [] }); // 关闭后会话从列表中消失
  assert.equal((await res).status, 200);
  assert.deepEqual(await b.next('detached'), { type: 'detached', reason: 'session_closed' });
  await b.closed;
  await waitFor(() => audit('m-closet').some((a) => a.event === 'close'));
  assert.deepEqual(audit('m-closet').map((a) => a.event), ['start', 'exited', 'close']);
  assert.equal(audit('m-closet').find((a) => a.event === 'close')!.sessionName, 'pwsh', '会话已从列表消失时仍记名称');
  assert.equal(all(d, 'detach').length, 0);
  d.ws.close();
  await d.closed;
});

test('attached.history 为空串时原样转发', async () => {
  const d = await daemon('m-hist0');
  const b = new Client(termUrl('m-hist0', 3), undefined, { cookie: ck, origin: ctx.base });
  await b.opened;
  await d.next('attach');
  d.send({ type: 'attached', sessionId: 3, cols: 80, rows: 24, snapshot: 'U05BUA==', history: '' });
  const snap = await b.next('snapshot');
  assert.equal(snap.history, '');
  d.ws.close();
  await d.closed;
});

test('贴图：daemon 在 imageBegin 后立即回 imageFailed → 422，hub 停止发送剩余分块且不发 imageEnd', async () => {
  const { d } = await taken('m-imgearly');
  // 收到 imageBegin 就回失败（早于 imageEnd）
  d.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'imageBegin') d.send({ type: 'imageFailed', sessionId: 3, uploadId: m.uploadId, reason: 'bad_type' });
  });
  const r = await upload('m-imgearly', Buffer.alloc(10 * 1024 * 1024)); // 40 块
  assert.equal(r.status, 422);
  assert.equal((await r.json()).reason, 'bad_type');
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(all(d, 'imageChunk').length < 40, `已停止发送剩余分块（收到 ${all(d, 'imageChunk').length} 块）`);
  assert.equal(all(d, 'imageEnd').length, 0);
  await waitFor(() => audit('m-imgearly').some((a) => a.event === 'image_failed' && a.reason === 'bad_type'));
  d.ws.close();
  await d.closed;
});

test('贴图：未知 reason 显示「贴图失败（reason）」', async () => {
  const { d } = await taken('m-imgunk');
  const res = upload('m-imgunk', Buffer.from('x'));
  const begin = await d.next('imageBegin');
  d.send({ type: 'imageFailed', sessionId: 3, uploadId: begin.uploadId, reason: 'weird' });
  const r = await res;
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, '贴图失败（weird）');
  d.ws.close();
  await d.closed;
});
