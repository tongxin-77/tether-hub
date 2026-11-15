// token 管理命令行：pnpm token create <名称> | list | revoke <名称>

import path from 'node:path';
import { createToken, readData, revokeToken } from './store.js';

const dir = path.resolve(process.env.HUB_DATA_DIR || './data');
const [cmd, name] = process.argv.slice(2);
const fmt = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

try {
  if (cmd === 'create' && name) {
    const token = createToken(dir, name);
    console.log(`已创建 token「${name}」。请立即复制，之后无法再次查看：\n\n${token}\n`);
  } else if (cmd === 'list') {
    const { tokens, machines } = readData(dir);
    if (!tokens.length) console.log('（暂无 token）');
    for (const t of tokens) {
      const used = machines.filter((m) => m.tokenName === t.name).map((m) => m.name);
      console.log(`${t.name}\t${t.revoked ? '已吊销' : '有效'}\t创建于 ${fmt(t.createdAt)}${used.length ? `\t机器：${used.join(', ')}` : ''}`);
    }
  } else if (cmd === 'revoke' && name) {
    revokeToken(dir, name);
    console.log(`已吊销 token「${name}」。运行中的 hub 会在约 1 秒内断开使用它的机器。`);
  } else {
    console.log('用法：\n  pnpm token create <名称>   签发新 token（只显示一次）\n  pnpm token list            列出 token\n  pnpm token revoke <名称>   吊销 token');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`错误：${(e as Error).message}`);
  process.exit(1);
}
