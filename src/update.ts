// 检查更新与一键更新：查询 GitHub Releases 最新版本；apply 下载源码包覆盖安装目录、重新安装依赖并构建，
// 成功后退出进程，由进程管理器（systemd / pm2 / NSSM）拉起新版本；失败则回滚并继续以旧版本运行。
// 安装版（安装目录有 install.json）改为下载对应平台的更新包，校验 SHA256SUMS 后整体替换应用文件。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UpdateAuditRec } from './audit.js';

export const DEFAULT_UPDATE_API = 'https://api.github.com/repos/tongxin-77/tether-hub/releases/latest';
const CHECK_INTERVAL = 6 * 3600_000;
const UA = 'tether-hub';
/** 每步输出保留的末尾行数 / 日志总行数上限 */
const TAIL = 20;
const MAX_LINES = 300;
/** 安装目录中不覆盖的顶层项（另加 .env* 与位于安装目录内的数据目录）；dist 构建前单独清空 */
const KEEP = new Set(['data', 'node_modules', 'certs', '.git', 'dist']);
/** 安装版更新的暂存目录（位于安装目录内，保证与安装目录同盘、可直接改名），启动时清理 */
const STAGE = '.update';

/** 安装版标记：打包脚本写入安装目录的 install.json；源码部署时不存在 */
export interface InstallInfo {
  /** 平台，如 win-x64 */
  platform: string;
}

export function readInstall(dir: string): InstallInfo | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8'));
    return typeof j?.platform === 'string' ? { platform: j.platform } : undefined;
  } catch {
    return undefined;
  }
}

/** 更新包（Release 资产）文件名，与 scripts/package.ts 一致 */
export const packageName = (version: string, platform: string) =>
  `tether-hub-${version}-${platform}.${platform.startsWith('win-') ? 'zip' : 'tar.gz'}`;

export type UpdateState = 'idle' | 'checking' | 'available' | 'updating' | 'done' | 'failed';

export interface UpdateStatus {
  current: string;
  latest?: string;
  notes?: string;
  url?: string;
  publishedAt?: string;
  checkedAt?: string;
  error?: string;
  state: UpdateState;
  log?: string;
}

/** 解析 vX.Y.Z / X.Y.Z；预发布等其他格式返回 undefined */
export function parseVersion(v: string): number[] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : undefined;
}

/** a 是否比 b 新；任一无法解析时为 false */
export function isNewer(a: string, b: string) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** 外部步骤，测试中可替换；失败时抛出的 Error 可带 output（命令输出） */
export interface UpdateSteps {
  download(url: string, file: string): Promise<void>;
  extract(file: string, dir: string): Promise<string>;
  run(cmd: string, cwd: string): Promise<string>;
}

const defaultSteps: UpdateSteps = {
  async download(url, file) {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(300_000) });
    if (!r.ok) throw new Error(`下载失败：HTTP ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  },
  // 以相对路径调用系统 tar：GNU tar 会把 C:\… 中的冒号当作远程主机；zip 用 Windows 自带的 bsdtar 解压
  extract: (file, dir) => file.endsWith('.zip')
    ? exec(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', dir], path.dirname(file))
    : exec('tar', ['-xzf', path.basename(file), '-C', path.relative(path.dirname(file), dir)], path.dirname(file)),
  // 经 shell 执行，Windows 下才能找到 pnpm.cmd
  run: (cmd, cwd) => exec(cmd, [], cwd, true),
};

function exec(cmd: string, args: string[], cwd: string, shell = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell, windowsHide: true });
    let out = '';
    const add = (d: Buffer) => (out = (out + d.toString()).slice(-20_000));
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    p.on('error', (e) => reject(Object.assign(e, { output: out })));
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(Object.assign(new Error(`${[cmd, ...args].join(' ')} 失败（退出码 ${code}）`), { output: out })));
  });
}

export interface UpdaterOptions {
  current: string;
  /** hub 安装目录（package.json 所在目录） */
  installDir: string;
  dataDir: string;
  api: string;
  /** 启动时与每 6 小时自动检查 */
  auto: boolean;
  log: (msg: string) => void;
  audit: (rec: UpdateAuditRec) => void;
  /** 更新成功约 1 秒后调用，通常为退出进程 */
  restart: () => void;
  steps?: Partial<UpdateSteps>;
  restartDelayMs?: number;
}

export class Updater extends EventEmitter {
  private st: UpdateStatus;
  private lines: string[] = [];
  private tarball?: string;
  /** 安装版：更新包与 SHA256SUMS 的下载地址 */
  private pkg?: { url: string; sums: string };
  private install?: InstallInfo;
  private checking?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private steps: UpdateSteps;
  /** 数据目录位于安装目录内时的顶层名，覆盖时跳过 */
  private dataTop?: string;

  constructor(private opt: UpdaterOptions) {
    super();
    this.st = { current: opt.current, state: 'idle' };
    this.steps = { ...defaultSteps, ...opt.steps };
    const rel = path.relative(opt.installDir, opt.dataDir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) this.dataTop = rel.split(path.sep)[0];
    this.install = readInstall(opt.installDir);
    // 上次安装版更新留下的旧文件（运行中的 node.exe 当时无法删除）
    if (this.install) {
      try {
        fs.rmSync(path.join(opt.installDir, STAGE), { recursive: true, force: true });
      } catch (e) {
        opt.log(`清理 ${STAGE} 失败：${(e as Error).message}`);
      }
    }
    if (opt.auto) {
      void this.check();
      this.timer = setInterval(() => void this.check(), CHECK_INTERVAL);
      this.timer.unref();
    }
  }

  status(): UpdateStatus {
    return { ...this.st, log: this.lines.length ? this.lines.join('\n') : undefined };
  }

  get canApply() {
    return (this.st.state === 'available' || this.st.state === 'failed') && !!(this.install ? this.pkg : this.tarball)
      && isNewer(this.st.latest ?? '', this.st.current);
  }

  private set(p: Partial<UpdateStatus>) {
    Object.assign(this.st, p);
    this.emit('change');
  }

  private note(...lines: string[]) {
    this.lines.push(...lines);
    this.lines.splice(0, this.lines.length - MAX_LINES);
    this.emit('change');
  }

  private tail(out: string) {
    const ls = out.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    if (ls.length) this.note(...ls.slice(-TAIL));
  }

  /** 检查失败只记录原因，不影响 hub；更新进行中 / 已完成时忽略 */
  check(): Promise<void> {
    if (this.st.state === 'updating' || this.st.state === 'done') return Promise.resolve();
    return (this.checking ??= this.doCheck().finally(() => (this.checking = undefined)));
  }

  private async doCheck() {
    const before = this.canApply ? 'available' : 'idle';
    this.set({ state: 'checking' });
    try {
      const r = await fetch(this.opt.api, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? `GitHub API 限流（HTTP ${r.status}），请稍后再试` : `HTTP ${r.status}`);
      const rel = await r.json();
      const tag = String(rel?.tag_name ?? '');
      if (rel.draft || rel.prerelease || !parseVersion(tag)) throw new Error(`最新发布的版本号无法识别：${tag || '（空）'}`);
      if (typeof rel.tarball_url !== 'string') throw new Error('发布信息缺少 tarball_url');
      this.tarball = rel.tarball_url;
      const newer = isNewer(tag, this.st.current);
      let error: string | undefined;
      if (this.install) {
        const name = packageName(tag.replace(/^v/, ''), this.install.platform);
        const url = (n: string) => (Array.isArray(rel.assets) ? rel.assets : []).find((a: any) => a?.name === n)?.browser_download_url;
        const [pkg, sums] = [url(name), url('SHA256SUMS')];
        this.pkg = typeof pkg === 'string' && typeof sums === 'string' ? { url: pkg, sums } : undefined;
        if (newer && !this.pkg) error = `${tag} 未提供更新包 ${name} 或 SHA256SUMS，无法一键更新，请到发布页下载安装包`;
      }
      this.set({
        state: newer ? 'available' : 'idle',
        latest: tag, notes: String(rel.body ?? ''), url: String(rel.html_url ?? ''), publishedAt: rel.published_at,
        checkedAt: new Date().toISOString(), error,
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const msg = err.name === 'TimeoutError' ? '请求超时' : err.cause?.code ?? err.cause?.message ?? err.message;
      this.opt.log(`检查更新失败：${msg}`);
      this.set({ state: before, checkedAt: new Date().toISOString(), error: `检查更新失败：${msg}` });
    }
  }

  private keep(rel: string) {
    const top = rel.split(/[\\/]/)[0];
    return KEEP.has(top) || top.startsWith('.env') || top === this.dataTop;
  }

  /** 一键更新；调用方须先确认 canApply。任一步失败则回滚并置 failed */
  async apply() {
    if (!this.canApply) return;
    const from = this.st.current;
    const to = this.st.latest!.replace(/^v/, '');

    this.lines = [];
    this.set({ state: 'updating', error: undefined });
    this.opt.log(`开始更新 ${from} → ${to}`);
    this.opt.audit({ time: new Date().toISOString(), event: 'update_start', from, to });
    try {
      await (this.install ? this.applyPackage(to, this.install.platform) : this.applySource(to));
    } catch (e) {
      const reason = (e as Error).message;
      this.opt.log(`更新失败：${reason}`);
      this.opt.audit({ time: new Date().toISOString(), event: 'update_failed', from, to, reason });
      this.set({ state: 'failed', error: `更新失败：${reason}` });
      return;
    }

    this.note('✔ 更新完成，正在重启');
    this.opt.log(`更新完成 ${from} → ${to}，即将退出以重启`);
    this.opt.audit({ time: new Date().toISOString(), event: 'update_done', from, to });
    this.set({ state: 'done' });
    setTimeout(() => this.opt.restart(), this.opt.restartDelayMs ?? 1000);
  }

  /** 执行一步：记录标题与输出末尾 */
  private async step(title: string, fn: () => Promise<string | void>) {
    this.note(`▶ ${title}`);
    try {
      const out = await fn();
      if (out) this.tail(out);
    } catch (e) {
      this.tail((e as { output?: string }).output ?? '');
      throw e;
    }
  }

  /** 源码部署：下载源码包覆盖安装目录，重新安装依赖并构建；失败回滚后抛出 */
  private async applySource(to: string) {
    const dir = this.opt.installDir;
    const dist = path.join(dir, 'dist');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-hub-update-'));
    const backup = path.join(tmp, 'backup');
    /** 已备份（被覆盖）与新增的文件，相对安装目录 */
    const backed: string[] = [];
    const added: string[] = [];
    let distSaved = false;
    let installed = false;

    try {
      const file = path.join(tmp, 'src.tar.gz');
      const x = path.join(tmp, 'x');
      await this.step(`下载 v${to}`, () => this.steps.download(this.tarball!, file));
      await this.step('解压', () => (fs.mkdirSync(x), this.steps.extract(file, x)));
      const tops = fs.readdirSync(x, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (tops.length !== 1) throw new Error('源码包结构异常：应只有一个顶层目录');
      const src = path.join(x, tops[0].name);
      await this.step('覆盖安装目录', async () => {
        for (const f of listFiles(src).filter((f) => !this.keep(f))) {
          const dest = path.join(dir, f);
          if (fs.existsSync(dest)) {
            copy(dest, path.join(backup, f));
            backed.push(f);
          } else added.push(f);
          copy(path.join(src, f), dest);
        }
        if (fs.existsSync(dist)) {
          fs.cpSync(dist, path.join(tmp, 'dist'), { recursive: true });
          distSaved = true;
        }
        fs.rmSync(dist, { recursive: true, force: true });
        return `覆盖 ${backed.length} 个文件，新增 ${added.length} 个，已清空 dist/`;
      });
      installed = true;
      await this.step('pnpm install --frozen-lockfile', () => this.steps.run('pnpm install --frozen-lockfile', dir));
      await this.step('pnpm build', () => this.steps.run('pnpm build', dir));
    } catch (e) {
      this.note(`✖ ${(e as Error).message}`);
      if (backed.length || added.length || distSaved) {
        this.note('↺ 回滚');
        try {
          for (const f of added) fs.rmSync(path.join(dir, f), { force: true });
          for (const f of backed) copy(path.join(backup, f), path.join(dir, f));
          if (distSaved) {
            fs.rmSync(dist, { recursive: true, force: true });
            fs.cpSync(path.join(tmp, 'dist'), dist, { recursive: true });
          }
          // 依赖可能已按新 lockfile 安装，按旧 lockfile 恢复（输出不记入日志，免得淹没失败原因）
          if (installed) await this.steps.run('pnpm install --frozen-lockfile', dir);
          this.note('已回滚，继续以当前版本运行');
        } catch (e2) {
          this.tail((e2 as { output?: string }).output ?? '');
          this.note(`回滚出错：${(e2 as Error).message}`);
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /**
   * 安装版：下载本平台更新包并按 SHA256SUMS 校验，解压到安装目录内的 .update/（同盘才能改名），
   * 把包内每个顶层项与安装目录中的同名项对调（运行中的 node.exe 不能覆盖或删除，但可以改名），
   * 再用新 node 对 dist/main.js 做语法检查；失败按相反顺序换回后抛出。
   * 旧文件留在 .update/old，下次启动时清理；包外的文件（服务配置、卸载程序等）不受影响。
   */
  private async applyPackage(to: string, platform: string) {
    const dir = this.opt.installDir;
    const stage = path.join(dir, STAGE);
    const old = path.join(stage, 'old');
    const name = packageName(to, platform);
    /** 已移入 old 的旧项与已换入的新项（顶层名） */
    const moved: string[] = [];
    const placed: string[] = [];
    let src = '';

    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(old, { recursive: true });
    try {
      const file = path.join(stage, name);
      const x = path.join(stage, 'x');
      await this.step(`下载 ${name}`, () => this.steps.download(this.pkg!.url, file));
      await this.step('校验 SHA256', async () => {
        const sums = path.join(stage, 'SHA256SUMS');
        await this.steps.download(this.pkg!.sums, sums);
        const want = fs.readFileSync(sums, 'utf8').split(/\r?\n/)
          .map((l) => /^([0-9a-f]{64}) [ *]?(.+)$/i.exec(l.trim())).find((m) => m?.[2] === name)?.[1].toLowerCase();
        if (!want) throw new Error(`SHA256SUMS 中没有 ${name}`);
        const got = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (got !== want) throw new Error(`${name} 的 SHA256 不匹配：期望 ${want}，实际 ${got}`);
        return `${got}  ${name}`;
      });
      await this.step('解压', () => (fs.mkdirSync(x), this.steps.extract(file, x)));
      const tops = fs.readdirSync(x, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (tops.length !== 1) throw new Error('更新包结构异常：应只有一个顶层目录');
      src = path.join(x, tops[0].name);
      if (readInstall(src)?.platform !== platform) throw new Error(`更新包结构异常：缺少 install.json 或平台不是 ${platform}`);
      await this.step('替换应用文件', async () => {
        for (const e of fs.readdirSync(src)) {
          if (e === STAGE) continue;
          if (fs.existsSync(path.join(dir, e))) {
            fs.renameSync(path.join(dir, e), path.join(old, e));
            moved.push(e);
          }
          fs.renameSync(path.join(src, e), path.join(dir, e));
          placed.push(e);
        }
        return `已替换：${placed.join(', ')}`;
      });
      const node = path.join(dir, platform.startsWith('win-') ? 'node.exe' : 'node');
      await this.step('检查新版本', () => this.steps.run(`"${node}" --check "${path.join(dir, 'dist', 'main.js')}"`, dir));
    } catch (e) {
      this.note(`✖ ${(e as Error).message}`);
      if (moved.length || placed.length) {
        this.note('↺ 回滚');
        try {
          for (const e of placed.reverse()) fs.renameSync(path.join(dir, e), path.join(src, e));
          for (const e of moved) fs.renameSync(path.join(old, e), path.join(dir, e));
          this.note('已回滚，继续以当前版本运行');
        } catch (e2) {
          this.note(`回滚出错：${(e2 as Error).message}`);
        }
      }
      try {
        fs.rmSync(stage, { recursive: true, force: true });
      } catch {
        // 留待下次启动时清理
      }
      throw e;
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

/** 目录下全部普通文件，相对路径 */
function listFiles(dir: string) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
}

function copy(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
