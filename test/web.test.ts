import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { login, PASSWORD, setup, type Ctx } from './helpers.js';

let ctx: Ctx;
before(async () => (ctx = await setup()));
after(() => ctx.close());

test('登录成功下发 HttpOnly + SameSite=Strict cookie，退出后失效', async () => {
  const r = await login(ctx.base);
  assert.equal(r.status, 200);
  const c = r.headers.get('set-cookie')!;
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  const ck = { cookie: c.split(';')[0] };
  assert.equal((await fetch(`${ctx.base}/api/me`, { headers: ck })).status, 200);
  assert.equal((await fetch(`${ctx.base}/api/logout`, { method: 'POST', headers: ck })).status, 200);
  assert.equal((await fetch(`${ctx.base}/api/me`, { headers: ck })).status, 401);
});

test('登录限流：连续失败 5 次后锁定，正确密码也返回 429', async () => {
  for (let i = 1; i <= 4; i++) assert.equal((await login(ctx.base, 'wrong')).status, 401);
  const fifth = await login(ctx.base, 'wrong');
  assert.equal(fifth.status, 401);
  const fb = await fifth.json();
  assert.match(fb.error, /锁定/);
  assert.equal(fb.code, 'login_locked');
  const locked = await login(ctx.base, PASSWORD);
  assert.equal(locked.status, 429);
  const lb = await locked.json();
  assert.equal(lb.code, 'login_throttled');
  assert.ok(lb.params.minutes >= 1);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
});

test('首页可访问并带 CSP', async () => {
  const r = await fetch(`${ctx.base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/);
  assert.match(await r.text(), /Tether Hub/);
});

test('xterm 静态资源由 hub 提供', async () => {
  for (const p of ['/xterm/xterm.js', '/xterm/xterm.css', '/xterm/addon-fit.js']) {
    const r = await fetch(`${ctx.base}${p}`);
    assert.equal(r.status, 200, p);
    assert.ok((await r.text()).length > 100);
  }
});
