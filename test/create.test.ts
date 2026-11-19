import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readAudit } from '../src/audit.js';
import { Client, cookie, setup, waitFor, type Ctx } from './helpers.js';

// 能力 create（协议第 8.5 节）：取新建选项、列 Claude 历史对话、网页新建会话

let ctx: Ctx;
let ck: string;
before(async () => {
  ctx = await setup({ queryTimeoutMs: 300, createTimeoutMs: 300 });
  ck = await cookie(ctx.base);
});
after(() => ctx.close());

const all = (c: Client, type: string) => c.messages.filter((m) => m.type === type);
const audit = (machineId: string) => readAudit(ctx.dir, 1000).filter((a: any) => a.machineId === machineId).reverse() as any[];

async function daemon(machineId: string, caps = ['history', 'image', 'close', 'create']) {
  const d = new Client(ctx.wsUrl, ctx.token);
  await d.opened;
  d.hello(machineId, { caps });
  await d.next('welcome');
  await waitFor(() => !!ctx.hub.agents.machines.get(machineId)?.online);
  return d;
}

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${ctx.base}${path}`, { headers: { cookie: ck, ...headers } });
function create(machine: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${ctx.base}/api/session/create?machine=${encodeURIComponent(machine)}`, {
    method: 'POST', headers: { cookie: ck, origin: ctx.base, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('未登录 401、跨源 403、离线 / 无 create 能力 409（不向 daemon 发请求）', async () => {
  assert.equal((await get('/api/create-options?machine=m-x', { cookie: '' })).status, 401);
  assert.equal((await get('/api/claude-history?machine=m-x&cwd=C%3A%5C', { cookie: '' })).status, 401);
  assert.equal((await create('m-x', { target: { kind: 'local' } }, { cookie: '' })).status, 401);
  assert.equal((await create('m-x', { target: { kind: 'local' } }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await get('/api/create-options?machine=m-offline')).status, 409);
  assert.equal((await create('m-offline', { target: { kind: 'local' } })).status, 409);

  const d = await daemon('m-nocreate', ['history', 'image', 'close']);
  assert.deepEqual(ctx.hub.agents.machines.get('m-nocreate')!.caps.includes('create'), false);
  for (const r of [
    await get('/api/create-options?machine=m-nocreate'),
    await get('/api/claude-history?machine=m-nocreate&cwd=C%3A%5C'),
    await create('m-nocreate', { target: { kind: 'local' } }),
  ]) {
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /不支持网页新建会话/);
  }
  assert.equal(d.messages.filter((m) => ['createOptions', 'claudeHistory', 'create'].includes(m.type)).length, 0);
  d.ws.close();
  await d.closed;
});

test('请求校验：缺 machine / cwd 400、非 JSON 415、请求体非法 400', async () => {
  const d = await daemon('m-val');
  assert.equal((await get('/api/create-options')).status, 400);
  assert.equal((await get('/api/claude-history?machine=m-val')).status, 400);
  assert.equal((await get(`/api/claude-history?machine=m-val&cwd=${'a'.repeat(1025)}`)).status, 400);
  assert.equal((await create('', { target: { kind: 'local' } })).status, 400);
  assert.equal((await create('m-val', { target: { kind: 'local' } }, { 'content-type': 'text/plain' })).status, 415);
  for (const body of [
    '{bad', null, {}, { target: 'local' }, { target: { kind: 'x' } }, { target: { kind: 'remote' } }, { target: { kind: 'remote', hostId: '' } },
    { target: { kind: 'local', cwd: 1 } }, { target: { kind: 'local', cwd: 'a'.repeat(1025) } },
    { target: { kind: 'remote', hostId: 'h1' }, resume: { id: 'u1' } }, // resume 仅本地
    { target: { kind: 'local' }, resume: { id: '' } }, { target: { kind: 'local' }, resume: { id: 'u1', bypass: 'yes' } },
    { target: { kind: 'local' }, cols: 120 }, { target: { kind: 'local' }, cols: 0, rows: 30 }, { target: { kind: 'local' }, cols: 120, rows: 1001 },
  ]) {
    assert.equal((await create('m-val', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(all(d, 'create').length, 0);
  d.ws.close();
  await d.closed;
});

test('createOptions：requestId 往返，回复只保留已知字段', async () => {
  const d = await daemon('m-opt');
  const res = get('/api/create-options?machine=m-opt');
  const q = await d.next('createOptions');
  assert.deepEqual(Object.keys(q).sort(), ['requestId', 'type']);
  assert.ok(typeof q.requestId === 'string' && q.requestId.length >= 16);
  // requestId 或 type 不符的忽略
  d.send({ type: 'createOptionsResult', requestId: 'other', ok: true, home: 'X' });
  d.send({ type: 'claudeHistoryResult', requestId: q.requestId, ok: true, items: [] });
  d.send({
    type: 'createOptionsResult', requestId: q.requestId, ok: true, home: 'C:\\Users\\x', extra: 1,
    recent: [{ kind: 'local', cwd: 'C:\\a', junk: 1 }, { kind: 'remote', hostId: 'h1', host: 'dev', cwd: '/srv' }, { kind: 'x', cwd: 'y' }, 'bad'],
    hosts: [{ id: 'h1', name: 'dev', secret: 'p' }, { name: 'no-id' }],
  });
  const r = await res;
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    home: 'C:\\Users\\x',
    recent: [{ kind: 'local', cwd: 'C:\\a' }, { kind: 'remote', hostId: 'h1', host: 'dev', cwd: '/srv' }],
    hosts: [{ id: 'h1', name: 'dev' }],
  });
  d.ws.close();
  await d.closed;
});

test('claudeHistory：带 cwd 往返；ok:false 422 + 中文原因（附 message）；超时 504', async () => {
  const d = await daemon('m-hist');
  const res = get(`/api/claude-history?machine=m-hist&cwd=${encodeURIComponent('C:\\work\\a')}`);
  const q = await d.next('claudeHistory');
  assert.equal(q.cwd, 'C:\\work\\a');
  const item = { id: 'u1', title: '修复登录', mtime: 1731800000000, messages: 12, permissionMode: 'acceptEdits', bypass: false, open: true };
  d.send({ type: 'claudeHistoryResult', requestId: q.requestId, ok: true, items: [{ ...item, path: 'x' }, { title: 'no id' }] });
  const r = await res;
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { items: [item] });

  const res2 = get('/api/claude-history?machine=m-hist&cwd=D%3A%5C');
  await waitFor(() => all(d, 'claudeHistory').length === 2);
  d.send({ type: 'claudeHistoryResult', requestId: all(d, 'claudeHistory')[1].requestId, ok: false, reason: 'error', message: '读取失败' });
  const r2 = await res2;
  assert.equal(r2.status, 422);
  assert.deepEqual(await r2.json(), { error: '本机操作失败：读取失败', reason: 'error' });

  assert.equal((await get('/api/create-options?machine=m-hist')).status, 504);
  d.ws.close();
  await d.closed;
});

test('create：转发已知字段，createResult ok → 200 sessionId，审计 create', async () => {
  const d = await daemon('m-create');
  const body = { target: { kind: 'local', cwd: 'C:\\work\\a', junk: 1 }, resume: { id: 'u1', permissionMode: 'acceptEdits', bypass: false, x: 1 }, cols: 100, rows: 30, extra: 1 };
  const res = create('m-create', body);
  const c = await d.next('create');
  assert.deepEqual({ ...c, requestId: undefined }, {
    type: 'create', requestId: undefined, target: { kind: 'local', cwd: 'C:\\work\\a' },
    resume: { id: 'u1', permissionMode: 'acceptEdits', bypass: false }, cols: 100, rows: 30,
  });
  // 成功前 daemon 已上报会话
  const now = Date.now();
  d.send({ type: 'sessions', sessions: [{ id: 7, name: 'claude', cwd: 'C:\\work\\a', command: 'claude', status: 'running', startedAt: now, lastActivityAt: now }] });
  d.send({ type: 'createResult', requestId: c.requestId, ok: true, sessionId: 7 });
  const r = await res;
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { sessionId: 7 });
  await waitFor(() => audit('m-create').some((a) => a.event === 'create'));
  const rec = audit('m-create').find((a) => a.event === 'create');
  assert.equal(rec.sessionId, 7);
  assert.equal(rec.sessionName, 'claude');
  assert.equal(rec.ip, '127.0.0.1');
  assert.match(rec.target, /^local C:\\work\\a/);

  // SSH：cwd 省略；cols / rows 省略时不带
  const res2 = create('m-create', { target: { kind: 'remote', hostId: 'h1', cwd: '' } });
  await waitFor(() => all(d, 'create').length === 2);
  const c2 = all(d, 'create')[1];
  assert.deepEqual(c2.target, { kind: 'remote', hostId: 'h1' });
  assert.equal('cols' in c2 || 'resume' in c2, false);
  d.send({ type: 'createResult', requestId: c2.requestId, ok: true, sessionId: 8 });
  assert.equal((await res2).status, 200);
  d.ws.close();
  await d.closed;
});

test('create：ok:false 422（auth_required 附 message / disabled / not_found）；超时 504；等待中断线 409，均记 create_failed', async () => {
  const d = await daemon('m-cf');
  const reply = async (body: object, msg: object) => {
    const n = all(d, 'create').length;
    const res = create('m-cf', body);
    await waitFor(() => all(d, 'create').length === n + 1);
    d.send({ type: 'createResult', requestId: all(d, 'create')[n].requestId, ...msg });
    return res;
  };
  const r1 = await reply({ target: { kind: 'remote', hostId: 'h1' } }, { ok: false, reason: 'auth_required', message: '需要密码，请先在桌面端连接一次或配置密钥' });
  assert.equal(r1.status, 422);
  const b1 = await r1.json();
  assert.equal(b1.reason, 'auth_required');
  assert.match(b1.error, /需要密码，请先在桌面端连接一次或配置密钥/);
  const r2 = await reply({ target: { kind: 'local' } }, { ok: false, reason: 'disabled' });
  assert.deepEqual(await r2.json(), { error: '本机未允许 hub 远程接管（新建会话复用该开关）', reason: 'disabled' });
  const r3 = await reply({ target: { kind: 'remote', hostId: 'gone' } }, { ok: false, reason: 'not_found' });
  assert.match((await r3.json()).error, /主机不存在/);
  const r4 = await reply({ target: { kind: 'local' } }, { ok: false, reason: 'weird' });
  assert.equal((await r4.json()).error, '操作失败（weird）');

  assert.equal((await create('m-cf', { target: { kind: 'local' } })).status, 504);

  const n = all(d, 'create').length;
  const res = create('m-cf', { target: { kind: 'local' } });
  await waitFor(() => all(d, 'create').length === n + 1);
  d.ws.close();
  assert.equal((await res).status, 409);

  await waitFor(() => audit('m-cf').filter((a) => a.event === 'create_failed').length === 6);
  const failed = audit('m-cf').filter((a) => a.event === 'create_failed');
  assert.deepEqual(failed.map((a) => a.reason), ['auth_required', 'disabled', 'not_found', 'weird', 'timeout', 'disconnected']);
  assert.ok(failed.every((a) => a.sessionId === undefined && typeof a.target === 'string' && a.ip === '127.0.0.1'));
  assert.equal(failed[0].target, 'ssh h1 ~');
});

test('等待中断线：createOptions / claudeHistory 也结束（409）', async () => {
  const d = await daemon('m-disc');
  const r1 = get('/api/create-options?machine=m-disc');
  const r2 = get('/api/claude-history?machine=m-disc&cwd=C%3A%5C');
  await d.next('createOptions');
  await d.next('claudeHistory');
  d.ws.close();
  assert.equal((await r1).status, 409);
  assert.equal((await r2).status, 409);
});
