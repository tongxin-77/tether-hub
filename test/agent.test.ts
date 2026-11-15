import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { HUB_VERSION } from '../src/server.js';
import { createToken, readData, revokeToken } from '../src/store.js';
import { Client, cookie, setup, waitFor, type Ctx } from './helpers.js';

let ctx: Ctx;
before(async () => (ctx = await setup({ helloTimeoutMs: 300 })));
after(() => ctx.close());

const is401 = (e: any) => e.status === 401;

test('握手：无 token / 错误 token 返回 401 且不升级', async () => {
  for (const token of [undefined, 'th_wrong']) {
    const c = new Client(ctx.wsUrl, token);
    await assert.rejects(c.opened, is401);
  }
});

test('握手被拒后客户端 RST 断开不会导致 hub 崩溃', async () => {
  for (const path of ['/agent', '/other']) {
    const sock = net.connect(Number(new URL(ctx.base).port), '127.0.0.1');
    sock.on('error', () => {});
    sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    await new Promise((r) => sock.once('data', r));
    sock.resetAndDestroy();
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${ctx.base}/`)).status, 200);
});

test('hello → welcome，机器上线并持久化', async () => {
  const c = new Client(ctx.wsUrl, ctx.token);
  await c.opened;
  c.hello('m-welcome');
  const w = await c.next('welcome');
  assert.deepEqual(w, { type: 'welcome', proto: 2, hubVersion: HUB_VERSION, caps: ['history', 'image', 'close'] });
  const m = ctx.hub.agents.machines.get('m-welcome')!;
  assert.equal(m.online, true);
  assert.equal(m.tokenName, 'pc1');
  assert.ok(readData(ctx.dir).machines.some((r) => r.machineId === 'm-welcome' && r.name === 'DEV-PC'));
  c.ws.close();
  await c.closed;
  await waitFor(() => !ctx.hub.agents.machines.get('m-welcome')!.online);
});

test('proto 不兼容 → proto_unsupported，关闭码 4002', async () => {
  const c = new Client(ctx.wsUrl, ctx.token);
  await c.opened;
  c.hello('m-proto', { proto: 1 });
  assert.equal((await c.next('error')).code, 'proto_unsupported');
  assert.equal((await c.closed).code, 4002);
});

test('首条消息不是合法 hello → bad_hello，关闭码 4003', async () => {
  for (const first of [{ type: 'sessions', sessions: [] }, 'not json', { type: 'hello', proto: 2 }, { type: 'hello', machineId: 'x', machineName: 'x', version: 'x' }]) {
    const c = new Client(ctx.wsUrl, ctx.token);
    await c.opened;
    c.send(first);
    assert.equal((await c.next('error')).code, 'bad_hello');
    assert.equal((await c.closed).code, 4003);
  }
});

test('hello 字段超长 → bad_hello，边界长度可通过', async () => {
  const hello = (machineId: string, machineName: string, version: string, proto: unknown = 2) =>
    ({ type: 'hello', proto, machineId, machineName, version });
  for (const bad of [
    hello('', 'n', 'v'),
    hello('a'.repeat(65), 'n', 'v'),
    hello('m-long', 'n'.repeat(257), 'v'),
    hello('m-long', 'n', 'v'.repeat(257)),
    hello('m-long', 'n', 'v', '2'),
  ]) {
    const c = new Client(ctx.wsUrl, ctx.token);
    await c.opened;
    c.send(bad);
    assert.equal((await c.next('error')).code, 'bad_hello');
    assert.equal((await c.closed).code, 4003);
  }
  // 按字符计数：64 个汉字 / 256 个汉字仍合法
  const ok = new Client(ctx.wsUrl, ctx.token);
  await ok.opened;
  ok.send(hello('机'.repeat(64), '名'.repeat(256), 'v'.repeat(256)));
  await ok.next('welcome');
  ok.ws.close();
  await ok.closed;
});

test('probe 不是布尔值 → bad_hello', async () => {
  for (const probe of ['true', 1, null]) {
    const c = new Client(ctx.wsUrl, ctx.token);
    await c.opened;
    c.hello('m-probe-bad', { probe });
    assert.equal((await c.next('error')).code, 'bad_hello');
    assert.equal((await c.closed).code, 4003);
  }
});

test('probe 连接：回 welcome，但常驻连接不收到 replaced、Web 状态与机器档案不变', async () => {
  const ck = await cookie(ctx.base);
  const state = async () => (await fetch(`${ctx.base}/api/state`, { headers: { cookie: ck } })).json();

  // 常驻连接在线并已上报会话
  const main = new Client(ctx.wsUrl, ctx.token);
  await main.opened;
  main.hello('m-probe', { machineName: 'MAIN-PC', version: '0.4.0' });
  await main.next('welcome');
  const now = Date.now();
  main.send({ type: 'sessions', sessions: [{ id: 1, name: 's1', cwd: 'C:\\', command: 'pwsh', status: 'running', startedAt: now, lastActivityAt: now }] });
  await waitFor(() => ctx.hub.agents.machines.get('m-probe')?.sessions.length === 1);
  const before = JSON.stringify((await state()).machines.find((m: any) => m.machineId === 'm-probe'));
  const recBefore = JSON.stringify(readData(ctx.dir).machines.find((r) => r.machineId === 'm-probe'));

  // 同一 machineId 的探测连接，名称 / 版本不同，还多发一条 sessions
  const probe = new Client(ctx.wsUrl, ctx.token);
  await probe.opened;
  probe.hello('m-probe', { machineName: 'PROBE-NAME', version: '9.9.9', probe: true });
  assert.deepEqual(await probe.next('welcome'), { type: 'welcome', proto: 2, hubVersion: HUB_VERSION, caps: ['history', 'image', 'close'] });
  probe.send({ type: 'sessions', sessions: [] });
  await new Promise((r) => setTimeout(r, 150));
  probe.ws.close();
  assert.equal((await probe.closed).code, 1005);
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(main.messages.some((m) => m.type === 'error'), false, '常驻连接不应收到 replaced');
  assert.equal(main.ws.readyState, main.ws.OPEN);
  assert.equal(JSON.stringify((await state()).machines.find((m: any) => m.machineId === 'm-probe')), before, 'Web 状态不变');
  assert.equal(JSON.stringify(readData(ctx.dir).machines.find((r) => r.machineId === 'm-probe')), recBefore, '机器档案不变');

  // 机器从未上线过时，probe 也不会登记新机器
  const p2 = new Client(ctx.wsUrl, ctx.token);
  await p2.opened;
  p2.hello('m-probe-new', { probe: true });
  await p2.next('welcome');
  p2.ws.close();
  await p2.closed;
  assert.equal(ctx.hub.agents.machines.has('m-probe-new'), false);
  assert.equal(readData(ctx.dir).machines.some((r) => r.machineId === 'm-probe-new'), false);

  main.ws.close();
  await main.closed;
});

test('hello 超时 → bad_hello，关闭码 4003', async () => {
  const c = new Client(ctx.wsUrl, ctx.token);
  await c.opened;
  const t0 = Date.now();
  assert.equal((await c.next('error')).code, 'bad_hello');
  assert.equal((await c.closed).code, 4003);
  assert.ok(Date.now() - t0 >= 250);
});

test('同一 machineId 重连：旧连接收到 replaced（4004），新连接保持在线', async () => {
  const a = new Client(ctx.wsUrl, ctx.token);
  await a.opened;
  a.hello('m-dup');
  await a.next('welcome');
  const b = new Client(ctx.wsUrl, ctx.token);
  await b.opened;
  b.hello('m-dup');
  await b.next('welcome');
  assert.equal((await a.next('error')).code, 'replaced');
  assert.equal((await a.closed).code, 4004);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctx.hub.agents.machines.get('m-dup')!.online, true, '旧连接关闭不应把机器标为离线');
  b.ws.close();
  await b.closed;
});

test('超过 4 MB 的消息被拒绝', async () => {
  const c = new Client(ctx.wsUrl, ctx.token);
  await c.opened;
  c.hello('m-big');
  await c.next('welcome');
  c.send('x'.repeat(4 * 1024 * 1024 + 1));
  assert.equal((await c.closed).code, 1009);
});

test('sessions 上报后 Web API 可查到并通过 SSE 推送；等待确认的机器排在前面', async () => {
  const ck = await cookie(ctx.base);
  const sse = await fetch(`${ctx.base}/api/events`, { headers: { cookie: ck } });
  assert.equal(sse.status, 200);
  const reader = sse.body!.getReader();

  const c = new Client(ctx.wsUrl, ctx.token);
  await c.opened;
  c.hello('m-sess', { machineName: 'ZZZ-PC' });
  await c.next('welcome');
  const now = Date.now();
  c.send({
    type: 'sessions',
    sessions: [
      { id: 1, name: 'shell', cwd: 'C:\\work', command: 'pwsh', status: 'running', startedAt: now, lastActivityAt: now, host: null },
      {
        id: 2, name: 'claude', cwd: '/srv', command: 'ssh', status: 'waiting', startedAt: now, lastActivityAt: now,
        host: 'build-box', hostId: 'h1', claude: { state: 'waiting', message: '需要权限', at: now }, extra: 'dropped',
      },
    ],
  });

  const state = async () => (await fetch(`${ctx.base}/api/state`, { headers: { cookie: ck } })).json();
  await waitFor(async () => (await state()).machines.find((m: any) => m.machineId === 'm-sess')?.sessions.length === 2);
  const m = (await state()).machines[0];
  assert.equal(m.machineId, 'm-sess', '有等待确认会话的机器排第一');
  assert.equal(m.name, 'ZZZ-PC');
  assert.equal(m.sessions[0].id, 2, '等待确认的会话排第一');
  assert.equal(m.sessions[0].host, 'build-box');
  assert.equal(m.sessions[0].claude.state, 'waiting');
  assert.equal(m.sessions[0].extra, undefined, '未知字段不透传');

  let text = '';
  const dec = new TextDecoder();
  while (!text.includes('需要权限')) text += dec.decode((await reader.read()).value);
  await reader.cancel();

  assert.equal((await fetch(`${ctx.base}/api/state`)).status, 401, '未登录不可访问');
  assert.equal((await fetch(`${ctx.base}/api/events`)).status, 401);

  c.ws.close();
  await c.closed;
  await waitFor(() => !ctx.hub.agents.machines.get('m-sess')!.online);
  assert.equal(ctx.hub.agents.machines.get('m-sess')!.sessions.length, 2, '离线后保留会话列表');
});

test('吊销 token 后在线连接以 revoked（4001）断开，之后握手 401', async () => {
  const token = createToken(ctx.dir, 'pc-revoke');
  const c = await waitConnect(token);
  c.hello('m-revoke');
  await c.next('welcome');
  const keep = new Client(ctx.wsUrl, ctx.token);
  await keep.opened;
  keep.hello('m-keep');
  await keep.next('welcome');

  revokeToken(ctx.dir, 'pc-revoke');
  assert.equal((await c.next('error')).code, 'revoked');
  assert.equal((await c.closed).code, 4001);
  assert.equal(keep.ws.readyState, keep.ws.OPEN, '其他 token 的连接不受影响');

  await assert.rejects(new Client(ctx.wsUrl, token).opened, is401);
  keep.ws.close();
  await keep.closed;
});

/** 新签发的 token 需等 hub 轮询到 hub.json 变化后才生效 */
async function waitConnect(token: string) {
  for (let i = 0; ; i++) {
    const c = new Client(ctx.wsUrl, token);
    try {
      await c.opened;
      return c;
    } catch (e) {
      if (i > 50 || !is401(e)) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
