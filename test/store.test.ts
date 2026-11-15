import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createToken, dataFile, findToken, hashToken, readData, revokeToken } from '../src/store.js';

test('token 签发、校验、吊销', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-hub-store-'));
  try {
    const t = createToken(dir, 'pc1');
    assert.match(t, /^th_[A-Za-z0-9_-]{43}$/);
    const raw = fs.readFileSync(dataFile(dir), 'utf8');
    assert.ok(!raw.includes(t), 'hub.json 不应包含明文 token');
    assert.ok(raw.includes(hashToken(t)));

    assert.equal(findToken(readData(dir).tokens, t)?.name, 'pc1');
    assert.equal(findToken(readData(dir).tokens, t + 'x'), undefined);
    assert.throws(() => createToken(dir, 'pc1'), /已存在/);
    assert.throws(() => createToken(dir, 'a b'), /名称/);

    revokeToken(dir, 'pc1');
    assert.equal(findToken(readData(dir).tokens, t), undefined);
    assert.equal(readData(dir).tokens[0].revoked, true);
    assert.throws(() => revokeToken(dir, 'pc1'), /已经吊销/);
    assert.throws(() => revokeToken(dir, 'nope'), /没有/);
    assert.deepEqual(fs.readdirSync(dir), ['hub.json'], '不应残留临时文件或锁文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
