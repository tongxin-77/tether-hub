import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { UpdateAuditRec } from '../src/audit.js';
import { HUB_VERSION } from '../src/server.js';
import { isNewer, parseVersion, Updater, type UpdaterOptions, type UpdateSteps } from '../src/update.js';
import { cookie, setup, waitFor } from './helpers.js';

// 模拟 Releases API：响应由各测试设置
let release: { status: number; body: unknown } = { status: 200, body: {} };
let api = '';
const mock = http.createServer((_req, res) => {
  res.writeHead(release.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(release.body));
});
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/releases/latest`;
});
after(() => mock.close());

const rel = (tag: string, extra: object = {}) => ({
  status: 200,
  body: { tag_name: tag, body: '# 说明\n<script>x</script>', html_url: 'https://example.com/r', tarball_url: 'https://example.com/t.tgz', published_at: '2026-11-15T00:00:00Z', ...extra },
});

function updater(o: Partial<UpdaterOptions> = {}) {
  const audits: UpdateAuditRec[] = [];
  let restarted = 0;
  const u = new Updater({
    current: '0.1.0', installDir: '.', dataDir: './data', api, auto: false, log: () => {},
    audit: (r) => audits.push(r), restart: () => restarted++, restartDelayMs: 0, ...o,
  });
  return { u, audits, restarted: () => restarted };
}

test('版本比较只认 vX.Y.Z', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('0.10.0'), [0, 10, 0]);
  assert.equal(parseVersion('v1.2.3-beta.1'), undefined);
  assert.equal(parseVersion('v1.2'), undefined);
  assert.ok(isNewer('v0.10.0', '0.9.9'));
  assert.ok(isNewer('v1.0.0', '0.99.99'));
  assert.ok(!isNewer('v0.1.0', '0.1.0'));
  assert.ok(!isNewer('v0.0.9', '0.1.0'));
  assert.ok(!isNewer('v9.0.0-rc.1', '0.1.0'));
});

test('检查更新：有新版本 / 已最新 / 预发布 / 限流 / 网络错误', async () => {
  const { u } = updater();
  release = rel('v0.2.0');
  await u.check();
  let s = u.status();
  assert.equal(s.state, 'available');
  assert.equal(s.latest, 'v0.2.0');
  assert.equal(s.url, 'https://example.com/r');
  assert.match(s.notes!, /说明/);
  assert.ok(s.checkedAt && !s.error);
  assert.ok(u.canApply);

  // 失败不丢失已知的新版本
  release = { status: 403, body: { message: 'rate limit' } };
  await u.check();
  s = u.status();
  assert.equal(s.state, 'available');
  assert.match(s.error!, /限流/);

  release = rel('v0.1.0');
  await u.check();
  assert.equal(u.status().state, 'idle');
  assert.ok(!u.canApply);

  release = rel('v0.3.0', { prerelease: true });
  await u.check();
  assert.equal(u.status().state, 'idle');
  assert.match(u.status().error!, /无法识别/);

  const down = updater({ api: 'http://127.0.0.1:1/x' }).u;
  await down.check();
  assert.equal(down.status().state, 'idle');
  assert.match(down.status().error!, /检查更新失败/);
});

test('更新接口：需登录、POST 校验同源、无新版本时拒绝 apply，状态经 SSE 推送', async () => {
  release = rel(`v${HUB_VERSION}`);
  const ctx = await setup({ updateApi: api });
  try {
    assert.equal((await fetch(`${ctx.base}/api/update`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/update/check`, { method: 'POST' })).status, 401);
    const ck = await cookie(ctx.base);
    const origin = ctx.base;
    const get = async () => (await fetch(`${ctx.base}/api/update`, { headers: { cookie: ck } })).json();
    const s0 = await get();
    assert.equal(s0.current, HUB_VERSION);
    assert.equal(s0.state, 'idle');
    assert.equal(s0.takeovers, 0);

    assert.equal((await fetch(`${ctx.base}/api/update/check`, { method: 'POST', headers: { cookie: ck } })).status, 403);
    assert.equal((await fetch(`${ctx.base}/api/update/check`, { method: 'POST', headers: { cookie: ck, origin: 'http://evil.example' } })).status, 403);
    assert.equal((await fetch(`${ctx.base}/api/update/check`, { method: 'POST', headers: { cookie: ck, origin } })).status, 202);
    await waitFor(async () => (await get()).checkedAt !== undefined);
    assert.equal((await get()).latest, `v${HUB_VERSION}`);
    assert.equal((await fetch(`${ctx.base}/api/update/apply`, { method: 'POST', headers: { cookie: ck, origin } })).status, 409);

    const ac = new AbortController();
    const r = await fetch(`${ctx.base}/api/events`, { headers: { cookie: ck }, signal: ac.signal });
    const reader = r.body!.getReader();
    let text = '';
    while (!text.includes('event: update')) text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
  } finally {
    await ctx.close();
  }
});

// ---- apply：覆盖 / 保留 / 回滚（tar、pnpm 以注入函数模拟） ----

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const read = (file: string) => fs.readFileSync(file, 'utf8');

/** 安装目录（旧版本）与模拟的源码包内容 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-hub-apply-'));
  const dir = path.join(root, 'hub');
  for (const [f, t] of Object.entries({
    'package.json': 'old', 'src/main.ts': 'old', 'only-old.txt': 'old', 'dist/main.js': 'old',
    'data/hub.json': 'keep', 'mydata/audit.jsonl': 'keep', 'node_modules/x/index.js': 'keep', 'certs/key.pem': 'keep',
    '.env': 'keep', '.env.local': 'keep', '.git/HEAD': 'keep',
  })) write(path.join(dir, f), t);
  const pkg: Record<string, string> = {
    'package.json': 'new', 'src/main.ts': 'new', 'src/update.ts': 'new', 'public/app.js': 'new',
    'data/hub.json': 'pkg', 'mydata/audit.jsonl': 'pkg', 'node_modules/x/index.js': 'pkg', 'certs/key.pem': 'pkg',
    '.env': 'pkg', '.env.local': 'pkg', '.git/HEAD': 'pkg', 'dist/main.js': 'pkg',
  };
  const runs: string[] = [];
  const steps = (failAt?: string): UpdateSteps => ({
    async download(url, file) {
      assert.equal(url, 'https://example.com/t.tgz');
      fs.writeFileSync(file, 'tgz');
    },
    async extract(_file, x) {
      for (const [f, t] of Object.entries(pkg)) write(path.join(x, 'owner-repo-abc123', f), t);
      return '';
    },
    async run(cmd, cwd) {
      assert.equal(cwd, dir);
      runs.push(cmd);
      if (cmd === 'pnpm build') {
        assert.ok(!fs.existsSync(path.join(dir, 'dist')), '构建前应清空 dist');
        if (failAt === 'build') throw Object.assign(new Error('pnpm build 失败（退出码 2）'), { output: 'line1\nerror TS2304: 找不到名称\n' });
        write(path.join(dir, 'dist/main.js'), 'built');
      }
      return `${cmd} ok\n`;
    },
  });
  return { root, dir, runs, steps };
}

const kept = (dir: string) => {
  for (const f of ['data/hub.json', 'mydata/audit.jsonl', 'node_modules/x/index.js', 'certs/key.pem', '.env', '.env.local', '.git/HEAD'])
    assert.equal(read(path.join(dir, f)), 'keep', f);
};

test('apply 成功：覆盖源码、保留数据 / 依赖 / 证书 / .env / .git，重建 dist 后重启', async () => {
  const fx = fixture();
  try {
    const { u, audits, restarted } = updater({ installDir: fx.dir, dataDir: path.join(fx.dir, 'mydata'), steps: fx.steps() });
    release = rel('v0.2.0');
    await u.check();
    await u.apply();
    const s = u.status();
    assert.equal(s.state, 'done', s.log);
    assert.equal(read(path.join(fx.dir, 'src/main.ts')), 'new');
    assert.equal(read(path.join(fx.dir, 'src/update.ts')), 'new');
    assert.equal(read(path.join(fx.dir, 'public/app.js')), 'new');
    assert.equal(read(path.join(fx.dir, 'only-old.txt')), 'old');
    assert.equal(read(path.join(fx.dir, 'dist/main.js')), 'built');
    kept(fx.dir);
    assert.deepEqual(fx.runs, ['pnpm install --frozen-lockfile', 'pnpm build']);
    assert.match(s.log!, /更新完成/);
    assert.deepEqual(audits.map((a) => [a.event, a.from, a.to]), [['update_start', '0.1.0', '0.2.0'], ['update_done', '0.1.0', '0.2.0']]);
    await waitFor(() => restarted() === 1);
    assert.ok(!u.canApply);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('apply 失败：回滚覆盖与新增的文件、恢复 dist，按旧 lockfile 重装依赖，不重启', async () => {
  const fx = fixture();
  try {
    const { u, audits, restarted } = updater({ installDir: fx.dir, steps: fx.steps('build') });
    release = rel('v0.2.0');
    await u.check();
    await u.apply();
    const s = u.status();
    assert.equal(s.state, 'failed');
    assert.match(s.error!, /pnpm build 失败/);
    assert.match(s.log!, /error TS2304/);
    assert.match(s.log!, /已回滚/);
    assert.equal(read(path.join(fx.dir, 'package.json')), 'old');
    assert.equal(read(path.join(fx.dir, 'src/main.ts')), 'old');
    assert.ok(!fs.existsSync(path.join(fx.dir, 'src/update.ts')));
    assert.ok(!fs.existsSync(path.join(fx.dir, 'public/app.js')));
    assert.equal(read(path.join(fx.dir, 'dist/main.js')), 'old');
    // 数据目录为默认 data/，mydata/ 不在保留名单内，被覆盖后同样回滚
    assert.equal(read(path.join(fx.dir, 'mydata/audit.jsonl')), 'keep');
    kept(fx.dir);
    assert.deepEqual(fx.runs, ['pnpm install --frozen-lockfile', 'pnpm build', 'pnpm install --frozen-lockfile']);
    assert.deepEqual(audits.map((a) => a.event), ['update_start', 'update_failed']);
    assert.match(audits[1].reason!, /pnpm build/);
    assert.equal(restarted(), 0);
    assert.ok(u.canApply, '失败后可重试');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
