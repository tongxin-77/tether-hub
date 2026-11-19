import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// public/img.js 是浏览器普通脚本，在 vm 中载入取出纯函数
const { fitSize, pickOutput } = vm.runInNewContext(
  `${fs.readFileSync(new URL('../public/img.js', import.meta.url), 'utf8')}\n;({ fitSize, pickOutput })`,
);
const MB = 1024 * 1024;

test('fitSize：长边不超过上限时不缩放，超过时等比缩到上限', () => {
  assert.deepEqual({ ...fitSize(1920, 1080, 2000) }, { w: 1920, h: 1080, scaled: false });
  assert.deepEqual({ ...fitSize(2000, 500, 2000) }, { w: 2000, h: 500, scaled: false });
  assert.deepEqual({ ...fitSize(4032, 3024, 2000) }, { w: 2000, h: 1500, scaled: true });
  assert.deepEqual({ ...fitSize(3024, 4032, 2000) }, { w: 1500, h: 2000, scaled: true });
  assert.deepEqual({ ...fitSize(10000, 1, 2000) }, { w: 2000, h: 1, scaled: true });
});

test('pickOutput：小截图 PNG 与 GIF 原样，透明图转 PNG，其余转 JPEG', () => {
  assert.equal(pickOutput('image/png', true, false, 1 * MB), '');
  assert.equal(pickOutput('image/gif', false, true, 9 * MB), '');
  assert.equal(pickOutput('image/png', false, true, 1 * MB), 'image/jpeg');
  assert.equal(pickOutput('image/png', false, false, 3 * MB), 'image/jpeg');
  assert.equal(pickOutput('image/png', true, false, 3 * MB), 'image/png');
  assert.equal(pickOutput('image/webp', true, true, 1 * MB), 'image/png');
  assert.equal(pickOutput('image/webp', false, false, 1 * MB), 'image/jpeg');
  assert.equal(pickOutput('image/jpeg', false, false, 1 * MB), 'image/jpeg');
  assert.equal(pickOutput('image/heic', false, true, 3 * MB), 'image/jpeg');
  assert.equal(pickOutput('image/avif', true, false, 1 * MB), 'image/jpeg');
});
