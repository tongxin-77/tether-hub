import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// public/textview.js 是浏览器普通脚本，在 vm 中载入取出纯函数
const { bufferText } = vm.runInNewContext(
  `${fs.readFileSync(new URL('../public/textview.js', import.meta.url), 'utf8')}\n;({ bufferText })`,
);

/** 模拟 xterm 缓冲区：每项为 [文本, isWrapped]，文本按 cols 补空格模拟整行单元格 */
function fakeBuf(rows: [string, boolean][], cols = 10) {
  const lines = rows.map(([s, isWrapped]) => ({
    isWrapped,
    translateToString: (trim: boolean) => (trim ? s.replace(/\s+$/, '') : s.padEnd(cols)),
  }));
  return { length: lines.length, getLine: (y: number) => lines[y] };
}

test('bufferText：续行拼接到上一行，不插换行，折行处空格保留', () => {
  const buf = fakeBuf([['$ echo hel', false], ['lo world  ', true], ['next', false]]);
  assert.equal(bufferText(buf), '$ echo hello world\nnext');
  // 恰好在行尾空格处折行
  assert.equal(bufferText(fakeBuf([['aaaa bbbb ', false], ['cccc', true]])), 'aaaa bbbb cccc');
});

test('bufferText：去掉末尾空行，保留中间空行与行尾裁剪', () => {
  const buf = fakeBuf([['a   ', false], ['', false], ['b', false], ['', false], ['   ', false]]);
  assert.equal(bufferText(buf), 'a\n\nb');
});

test('bufferText：空缓冲区与全空行返回空串', () => {
  assert.equal(bufferText(fakeBuf([])), '');
  assert.equal(bufferText(fakeBuf([['', false], ['  ', false]])), '');
});
