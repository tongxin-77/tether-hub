// 打包安装版：把构建产物、生产依赖与固定版本的 Node 运行时组装成更新包（Windows 为 zip），
// Windows 下找到 Inno Setup 的 ISCC 时再编译安装程序；产物与 SHA256SUMS 输出到 build/out/。
// 用法：pnpm build && pnpm package [平台]（默认 win-x64）。ISCC 位置可用环境变量 ISCC 指定。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageName } from '../src/update.js';

const NODE_VERSION = '24.22.3';
/** 安装器用到的第三方文件：固定版本并校验 SHA256 */
const WINSW = {
  url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
  sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
};
const ZH_ISL = {
  url: 'https://raw.githubusercontent.com/jrsoftware/issrc/is-6_7_3/Files/Languages/Unofficial/ChineseSimplified.isl',
  sha256: '7d544b9bb1d142cfa11f2e5d3cc8abe2e55f8e066c5124e3772675aa236e1278',
};

/**
 * 平台参数。nodeSha256 取自 https://nodejs.org/dist/v<NODE_VERSION>/SHASUMS256.txt。
 * 以后加 linux-x64：node-v…-linux-x64.tar.xz（node 在 bin/node）、更新包 tar.gz、systemd 单元文件放进 files。
 */
const PLATFORMS: Record<string, { nodeArchive: string; nodeSha256: string; nodeBin: string; bin: string; files: string[] }> = {
  'win-x64': {
    nodeArchive: `node-v${NODE_VERSION}-win-x64.zip`,
    nodeSha256: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
    nodeBin: `node-v${NODE_VERSION}-win-x64/node.exe`,
    bin: 'node.exe',
    files: ['packaging/windows/tether-hub-token.cmd'],
  },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2] ?? 'win-x64';
const plat = PLATFORMS[platform];
if (!plat) die(`不支持的平台：${platform}（可用：${Object.keys(PLATFORMS).join(', ')}）`);
const version: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!fs.existsSync(path.join(root, 'dist', 'main.js'))) die('缺少 dist/，请先 pnpm build');

const build = path.join(root, 'build');
const cache = path.join(build, 'cache');
const out = path.join(build, 'out');
const name = `tether-hub-${version}-${platform}`;
const stage = path.join(build, 'stage', name);
for (const d of [out, path.dirname(stage)]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(out, { recursive: true });

// 1. 应用文件与生产依赖（hoisted：普通目录，不含符号链接，便于压缩与替换）
for (const f of ['dist', 'public', 'package.json', 'pnpm-lock.yaml', 'LICENSE']) fs.cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--config.node-linker=hoisted'], stage, true);
fs.rmSync(path.join(stage, 'pnpm-lock.yaml'));
for (const f of plat.files) fs.copyFileSync(path.join(root, f), path.join(stage, path.basename(f)));
fs.writeFileSync(path.join(stage, 'install.json'), `${JSON.stringify({ platform })}\n`);

// 2. Node 运行时
const nodeArchive = await fetchVerified(`https://nodejs.org/dist/v${NODE_VERSION}/${plat.nodeArchive}`, plat.nodeSha256, plat.nodeArchive);
if (!fs.existsSync(path.join(cache, plat.nodeBin))) run(tar(), ['-xf', nodeArchive, '-C', cache, plat.nodeBin], cache);
fs.copyFileSync(path.join(cache, plat.nodeBin), path.join(stage, plat.bin));

// 3. 更新包
const pkg = path.join(out, packageName(version, platform));
if (pkg.endsWith('.zip')) run(tar(), ['-a', '-cf', pkg, '-C', path.dirname(stage), name], build);
else run('tar', ['-czf', pkg, '-C', path.dirname(stage), name], build);

// 4. 安装程序（仅 Windows，需要 ISCC）
if (platform.startsWith('win-')) {
  const iscc = findIscc();
  if (!iscc) console.warn('未找到 Inno Setup（ISCC.exe），跳过安装程序；可设置环境变量 ISCC 指定位置');
  else {
    const winsw = await fetchVerified(WINSW.url, WINSW.sha256, 'WinSW-x64-2.12.0.exe');
    const isl = await fetchVerified(ZH_ISL.url, ZH_ISL.sha256, 'ChineseSimplified-6.7.3.isl');
    run(iscc, [
      '/Q', `/DAppVersion=${version}`, `/DPayloadDir=${stage}`, `/DWinSW=${winsw}`, `/DZhIsl=${isl}`,
      `/DOutputDir=${out}`, `/DOutputBaseFilename=${name}-setup`, path.join(root, 'packaging', 'windows', 'tether-hub.iss'),
    ], root);
  }
}

// 5. SHA256SUMS
const sums = fs.readdirSync(out).sort().map((f) => `${sha256(path.join(out, f))}  ${f}`);
fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(`\n产物（${path.relative(root, out)}）：\n${sums.join('\n')}`);

function die(msg: string): never {
  console.error(`打包失败：${msg}`);
  process.exit(1);
}

function run(cmd: string, args: string[], cwd: string, shell = false) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  // shell 仅用于 pnpm（Windows 下为 pnpm.cmd），其参数不含空格
  const r = shell ? spawnSync([cmd, ...args].join(' '), { cwd, stdio: 'inherit', shell }) : spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) die(`${cmd} 失败（${r.error?.message ?? `退出码 ${r.status}`}）`);
}

/** Windows 自带的 bsdtar 能读写 zip；Git Bash 的 GNU tar 不能 */
function tar() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

function sha256(file: string) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 下载到 build/cache（已缓存且校验通过则复用），SHA256 不符即失败 */
async function fetchVerified(url: string, want: string, file: string) {
  const dest = path.join(cache, file);
  if (fs.existsSync(dest) && sha256(dest) === want) return dest;
  console.log(`下载 ${url}`);
  const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) die(`下载 ${url} 失败：HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== want) die(`${file} 的 SHA256 不匹配：期望 ${want}，实际 ${got}`);
  fs.writeFileSync(dest, buf);
  return dest;
}

function findIscc() {
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  const cands = [process.env.ISCC, path.join(pf86, 'Inno Setup 6', 'ISCC.exe'), path.join(local, 'Programs', 'Inno Setup 6', 'ISCC.exe')];
  const found = cands.find((c) => c && fs.existsSync(c));
  if (found) return found;
  const w = spawnSync('where', ['ISCC.exe'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.split(/\r?\n/)[0].trim() : undefined;
}
