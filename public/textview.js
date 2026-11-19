// 文本视图：把终端缓冲区转成纯文本（app.js 的 openTv 使用），手机上可长按选择复制、系统滚动长截图。
// 普通脚本（非模块），顶层声明与 app.js 共享；bufferText 为纯函数，测试在 Node 中用 vm 载入本文件。
'use strict';

/** xterm 缓冲区（length、getLine(y) → {isWrapped, translateToString(trim)}）转纯文本：自动折行的续行拼回上一行，去掉末尾空行 */
function bufferText(buf) {
  const out = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    // 下一行是续行时不裁掉行尾空白，否则折行处的空格会丢失
    const next = buf.getLine(y + 1);
    const s = line.translateToString(!(next && next.isWrapped));
    if (line.isWrapped && out.length) out[out.length - 1] += s;
    else out.push(s);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\n');
}
