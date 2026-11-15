// 入口：从环境变量读取配置并启动 hub。

import fs from 'node:fs';
import path from 'node:path';
import { HUB_VERSION, startHub } from './server.js';

function die(msg: string): never {
  console.error(`启动失败：${msg}`);
  process.exit(1);
}

const env = process.env;
const port = Number(env.HUB_PORT ?? 8443);
if (!Number.isInteger(port) || port < 0 || port > 65535) die(`HUB_PORT 无效：${env.HUB_PORT}`);
const host = env.HUB_HOST || '0.0.0.0';
const adminPassword = env.HUB_ADMIN_PASSWORD;
if (!adminPassword) die('未设置 HUB_ADMIN_PASSWORD（Web 管理员密码，必填）');
const dataDir = path.resolve(env.HUB_DATA_DIR || './data');

let tls: { cert: Buffer; key: Buffer } | undefined;
if (env.HUB_TLS_CERT || env.HUB_TLS_KEY) {
  if (!env.HUB_TLS_CERT || !env.HUB_TLS_KEY) die('HUB_TLS_CERT 与 HUB_TLS_KEY 须同时设置');
  try {
    tls = { cert: fs.readFileSync(env.HUB_TLS_CERT), key: fs.readFileSync(env.HUB_TLS_KEY) };
  } catch (e) {
    die(`读取证书失败：${(e as Error).message}`);
  }
} else if (env.HUB_INSECURE !== '1') {
  die('未配置 TLS 证书。请设置 HUB_TLS_CERT / HUB_TLS_KEY；仅在局域网调试时可设置 HUB_INSECURE=1 以明文监听');
}

if (!tls) {
  console.warn('');
  console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.warn('!!  警告：HUB_INSECURE=1，以明文 HTTP / ws:// 监听，未加密！            !!');
  console.warn('!!  token 与管理员密码可被窃听，仅限本机或可信局域网调试使用。          !!');
  console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.warn('');
}

const hub = await startHub({ port, host, tls, adminPassword, dataDir }).catch((e: Error) => die(e.message));
const scheme = tls ? 'https' : 'http';
console.log(`tether-hub ${HUB_VERSION} 已启动：${scheme}://${host}:${hub.port}/（daemon 连接 ${tls ? 'wss' : 'ws'}://<地址>:${hub.port}/agent），数据目录 ${dataDir}`);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log('正在关闭…');
    await hub.close();
    process.exit(0);
  });
}
