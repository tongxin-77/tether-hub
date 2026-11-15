import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readAudit } from '../src/audit.js';
import { Client, cookie, setup, waitFor, type Ctx } from './helpers.js';

let ctx: Ctx;
let ck = '';
before(async () => {
  ctx = await setup();
  ck = await cookie(ctx.base);
});
after(() => ctx.close());

/** 带登录 cookie 与同源 Origin 的请求 */
const api = (p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  fetch(`${ctx.base}${p}`, {
    method: init.method ?? 'GET',
    headers: { cookie: ck, origin: ctx.base, 'Content-Type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const list = async () => (await (await api('/api/tokens')).json()) as any[];

test('token 接口：未登录 401', async () => {
  assert.equal((await fetch(`${ctx.base}/api/tokens`)).status, 401);
  const r = await fetch(`${ctx.base}/api/tokens`, { method: 'POST', headers: { origin: ctx.base, 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(r.status, 401);
  assert.equal((await fetch(`${ctx.base}/api/tokens/pc1/revoke`, { method: 'POST', headers: { origin: ctx.base } })).status, 401);
});

test('token 接口：跨源或无 Origin 的 POST 返回 403', async () => {
  for (const origin of ['http://evil.example', '']) {
    const headers = { origin };
    assert.equal((await api('/api/tokens', { method: 'POST', body: { name: 'x-csrf' }, headers })).status, 403);
    assert.equal((await api('/api/tokens/pc1/revoke', { method: 'POST', headers })).status, 403);
  }
  assert.ok(!(await list()).some((t) => t.name === 'x-csrf'));
  assert.equal((await list()).find((t) => t.name === 'pc1').revoked, false);
});

test('签发返回明文，列表不含 sha256；名称重复 / 非法返回 400', async () => {
  const r = await api('/api/tokens', { method: 'POST', body: { name: 'web-pc' } });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.name, 'web-pc');
  assert.match(body.token, /^th_/);

  const text = await (await api('/api/tokens')).text();
  assert.doesNotMatch(text, /sha256/);
  assert.ok(!text.includes(body.token));
  const t = JSON.parse(text).find((t: any) => t.name === 'web-pc');
  assert.deepEqual(Object.keys(t).sort(), ['createdAt', 'machines', 'name', 'revoked']);
  assert.equal(t.revoked, false);

  const dup = await api('/api/tokens', { method: 'POST', body: { name: 'web-pc' } });
  assert.equal(dup.status, 400);
  assert.match((await dup.json()).error, /已存在/);
  for (const name of ['', 'a b', 'x'.repeat(65), 1]) {
    assert.equal((await api('/api/tokens', { method: 'POST', body: { name } })).status, 400, String(name));
  }
});

test('网页吊销：状态变化、断开使用它的机器、重复吊销 409、不存在 404，并写审计', async () => {
  const { token } = await (await api('/api/tokens', { method: 'POST', body: { name: 'pc/吊销' } })).json();
  // 新 token 需等 hub 轮询到 hub.json 变化后才生效
  let c!: Client;
  await waitFor(async () => {
    c = new Client(ctx.wsUrl, token);
    return c.opened.then(() => true, () => false);
  });
  c.hello('m-web-revoke');
  await c.next('welcome');
  await waitFor(async () => (await list()).find((t) => t.name === 'pc/吊销').machines.includes('DEV-PC'));

  const path = `/api/tokens/${encodeURIComponent('pc/吊销')}/revoke`;
  assert.equal((await api(path, { method: 'POST' })).status, 200);
  assert.equal((await list()).find((t) => t.name === 'pc/吊销').revoked, true);
  assert.equal((await c.closed).code, 4001, '同进程写 hub.json 也会断开使用该 token 的机器');

  const again = await api(path, { method: 'POST' });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /已经吊销/);
  assert.equal((await api('/api/tokens/nope/revoke', { method: 'POST' })).status, 404);

  const recs = readAudit(ctx.dir, 100) as any[];
  assert.ok(recs.some((a) => a.event === 'token_create' && a.tokenName === 'pc/吊销' && a.ip));
  assert.ok(recs.some((a) => a.event === 'token_revoke' && a.tokenName === 'pc/吊销' && a.ip));
});
