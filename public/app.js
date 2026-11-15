// Tether Hub Web 界面：登录、SSE 实时接收机器 / 会话状态并按主从布局渲染；远程接管终端（xterm.js）；审计日志。
// 版本与更新：顶栏版本按钮 / 新版本胶囊 + 更新面板（检查、一键更新、进度日志、重启后自动刷新）。
// 页面：#main 机器与会话（手机上为机器列表）、#detail 机器详情（仅手机两级页面用）、#term 接管终端、#audit 审计日志。
'use strict';

const $ = (id) => document.getElementById(id);
const isM = () => matchMedia('(max-width:768px)').matches;

const IC = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  alertC: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>', chevL: '<path d="m15 18-6-6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  up: '<circle cx="12" cy="12" r="9"/><path d="m8 12 4-4 4 4"/><path d="M12 16V8"/>',
};
const ic = (n, c = '') => `<svg class="ic ${c}" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;
document.querySelectorAll('[data-i]').forEach((e) => (e.outerHTML = ic(e.dataset.i)));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** 审计事件：标签文字、样式、无 reason 时的说明 */
const EV = {
  update_start: ['开始更新', 't-pri', 'hub 开始一键更新'],
  update_done: ['更新完成', 't-pri', 'hub 更新完成并重启'],
  update_failed: ['更新失败', 't-err', 'hub 更新失败，已回滚'],
  start: ['开始接管', 't-pri', '网页端开始接管'],
  end: ['结束接管', '', '最后一个网页端关闭终端'],
  denied: ['拒绝接管', 't-err', '接管被拒绝'],
  reclaimed: ['本地收回', 't-warn', '本机用户收回控制'],
  disabled: ['接管被关闭', 't-warn', '本机关闭了允许接管'],
  exited: ['会话退出', '', '会话进程已退出'],
  disconnected: ['连接断开', '', '机器连接断开，接管结束'],
};
const REASON = {
  reclaimed: '已被本地收回', disabled: '本机未允许接管', exited: '会话已退出', offline: '机器离线',
  not_found: '会话不存在或已退出', probe: '探测连接不支持接管',
};

let state = null;
let es = null;
let retryTimer = 0;
let authed = false;
let view = 'main';
let selId = null;
let term = null;
let termWs = null;
let termRef = null;
let termRo = null;

// ---- 工具 ----

function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return shortTime(ms);
}
const pad = (n) => String(n).padStart(2, '0');
function shortTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fullTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');

// ---- 主题：默认跟随系统，手动切换后记住 ----

const darkMq = matchMedia('(prefers-color-scheme: dark)');
function savedTheme() {
  try { return localStorage.getItem('hub-theme'); } catch { return null; }
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme-btn').innerHTML = ic(t === 'dark' ? 'sun' : 'moon');
  if (term) term.options.theme = termTheme();
}
applyTheme(savedTheme() || (darkMq.matches ? 'dark' : 'light'));
darkMq.addEventListener('change', (e) => savedTheme() || applyTheme(e.matches ? 'dark' : 'light'));
$('theme-btn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('hub-theme', t); } catch {}
  applyTheme(t);
});

// 软键盘弹出时用 visualViewport 高度约束布局，终端与按键条始终在键盘上方
if (window.visualViewport) {
  const fitVv = () => document.documentElement.style.setProperty('--vvh', `${visualViewport.height}px`);
  visualViewport.addEventListener('resize', fitVv);
  fitVv();
}

// ---- 登录 / 实时连接 ----

function showView(v) {
  for (const id of ['v-login', 'v-shell', 'v-term']) $(id).classList.toggle('on', id === `v-${v}`);
}

function showLogin(msg) {
  authed = false;
  stopEvents();
  closeTerm();
  showView('login');
  $('upd').hidden = true;
  $('login-error').textContent = msg || '';
  $('password').focus();
}

function showMain() {
  authed = true;
  startEvents();
  route();
}

function stopEvents() {
  clearTimeout(retryTimer);
  if (es) es.close();
  es = null;
}

function setSse(kind) {
  const [cls, text] = { ok: ['ok', '实时连接正常'], retry: ['warn', '正在重新连接…'], err: ['err', '实时连接已断开'] }[kind];
  $('sse').innerHTML = `<i class="dot ${cls}"></i><span class="lbl">${text}</span>`;
  $('sse').title = `实时推送（SSE）：${text}`;
}

// EventSource 遇到网络中断会自动重连；若被服务器以非 200 拒绝（如登录失效）则彻底关闭，此时自行判断是否需要重新登录
function startEvents() {
  stopEvents();
  setSse('retry');
  es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    setSse('ok');
    render();
  });
  es.addEventListener('update', (e) => {
    upd = JSON.parse(e.data);
    renderUpdate();
  });
  es.onerror = async () => {
    if (es.readyState !== EventSource.CLOSED) return setSse('retry');
    setSse('err');
    try {
      const r = await fetch('/api/me');
      if (r.status === 401) return showLogin('登录已失效，请重新登录');
    } catch {}
    retryTimer = setTimeout(startEvents, 3000);
  };
}

// ---- 机器与会话 ----

const isWaiting = (s) => s.claude && s.claude.state === 'waiting';
const machines = () => (state ? state.machines : []);
const selected = () => machines().find((m) => m.machineId === selId);
const mName = (m) => m.name || m.machineId;
const sName = (s) => s.name || `会话 ${s.id}`;
const live = (m) => m.sessions.filter((s) => s.status !== 'exited').length;

function render() {
  const list = machines();
  if (!selected() && list.length) selId = list[0].machineId;
  const waiting = list.reduce((n, m) => n + m.sessions.filter(isWaiting).length, 0);
  document.title = waiting ? `(${waiting}) Tether Hub` : 'Tether Hub';
  renderAlert();
  renderMachines();
  renderDetail();
}

function renderAlert() {
  const list = [];
  for (const m of machines()) for (const s of m.sessions) if (isWaiting(s)) list.push([m, s]);
  const box = $('alert');
  box.hidden = !list.length || view === 'audit' || (view === 'detail' && isM());
  if (!list.length) return box.classList.remove('open');
  box.innerHTML = `<div class="ac-head" data-toggle>${ic('alert')}
      <span><b>${list.length} 个会话</b><span class="only-d">中 Claude 正在</span>等待确认</span>
      <span class="ac-chips">${list.map(([m, s]) => `<button class="chip" data-pick="${esc(m.machineId)}" title="${esc(s.claude.message || '')}">${esc(mName(m))} · ${esc(sName(s))}</button>`).join('')}</span>
      <span class="ac-more">${ic('chevR')}</span></div>
    <div class="ac-list">${list.map(([m, s]) => `<button class="ac-item" data-pick="${esc(m.machineId)}"><b>${esc(sName(s))}</b><span class="muted">${esc(mName(m))}</span>${ic('chevR')}</button>`).join('')}</div>`;
}

function renderMachines() {
  const all = machines();
  const kw = $('m-search').value.trim().toLowerCase();
  $('m-stat').textContent = state ? `${all.filter((m) => m.online).length} 在线 / 共 ${all.length} 台` : '';
  const rows = all.filter((m) => !kw || `${m.name} ${m.machineId} ${m.tokenName}`.toLowerCase().includes(kw));
  $('m-list').innerHTML = rows.map((m) => {
    const n = m.sessions.filter(isWaiting).length;
    return `<div class="mitem${m.machineId === selId ? ' sel' : ''}${m.online ? '' : ' off'}" data-pick="${esc(m.machineId)}">
      <i class="dot${m.online ? ' ok' : ''}"></i>
      <div class="mm"><div class="mname"><span class="n">${esc(mName(m))}</span><span class="v">v${esc(m.version || '?')}</span></div>
      <div class="msub" title="${esc(fullTime(m.lastSeen))}">${m.online ? `在线 · ${live(m)} 个活动会话` : `离线 · 最后在线 ${ago(m.lastSeen)}`}</div></div>
      ${n ? `<span class="cnt" title="${n} 个会话等待确认">${n}</span>` : ''}
      <span class="chev only-m">${ic('chevR')}</span></div>`;
  }).join('') || `<div class="empty">${!state ? '加载中…' : all.length ? '没有匹配的机器'
    : '还没有机器接入。<br>用 <code>pnpm token create &lt;名称&gt;</code> 签发 token，<br>并在 Tether 客户端设置中填写服务器地址与 token。'}</div>`;
}

function claudeTag(c) {
  if (!c) return '<span class="muted">—</span>';
  switch (c.state) {
    case 'waiting': return `<span class="tag t-warn">${ic('alert', 'ic-sm')}等待确认</span>`;
    case 'thinking': return '<span class="tag"><i class="dot info"></i>思考中</span>';
    case 'background': return `<span class="tag"><i class="dot pur"></i>子代理运行中${c.count ? ` ×${c.count}` : ''}</span>`;
    case 'done': return '<span class="tag">已完成</span>';
    case 'idle': return '<span class="tag">空闲</span>';
    default: return `<span class="tag">${esc(c.state)}</span>`;
  }
}
const stCell = (st) => ({
  running: '<span class="st"><i class="dot ok"></i>运行中</span>',
  waiting: '<span class="st"><i class="dot"></i>等待中</span>',
  exited: '<span class="st muted"><i class="dot"></i>已退出</span>',
})[st] || `<span class="st">${esc(st)}</span>`;

function takeBtn(m, s) {
  if (s.status === 'exited') return '<button class="btn btn-sm" disabled title="会话已退出">接管</button>';
  if (!m.online) return '<button class="btn btn-sm" disabled title="机器离线">接管</button>';
  return `<button class="btn btn-sm${isWaiting(s) ? ' btn-primary' : ''}" data-take="${esc(m.machineId)}" data-sid="${s.id}">接管</button>`;
}

function renderDetail() {
  const m = selected();
  if (!m) {
    $('detail').innerHTML = state ? '<div class="empty">选择左侧机器查看详情</div>' : '';
    return;
  }
  const n = m.sessions.filter(isWaiting).length;
  const ss = m.sessions;
  const rowCls = (s) => `${isWaiting(s) ? 'need' : ''}${s.status === 'exited' ? ' exited' : ''}`;
  const msg = (s) => (isWaiting(s) && s.claude.message ? `<div class="smsg">${esc(s.claude.message)}</div>` : '');
  const tip = (s) => esc(`${s.host ? `远程主机：${s.host}\n` : ''}目录：${s.cwd || ''}\n命令：${s.command || ''}`);
  const seen = m.online ? `上线于 ${ago(m.lastSeen)}` : ago(m.lastSeen);
  $('detail').innerHTML = `
    <div class="dhead">
      <button class="back" data-back aria-label="返回">${ic('chevL')}</button>
      <h2>${esc(mName(m))}</h2>
      ${m.online ? '<span class="tag t-pri"><i class="dot ok"></i>在线</span>' : '<span class="tag"><i class="dot"></i>离线</span>'}
      ${n ? `<span class="tag t-warn">${ic('alert', 'ic-sm')}${n} 个等待确认</span>` : ''}
      <span class="right only-d" title="${esc(fullTime(m.lastSeen))}">${m.online ? seen : `最后在线：${seen}`}</span>
    </div>
    <div class="card"><div class="card-head"><h3>机器信息</h3></div><div class="card-body">
      <div class="desc">
        <div class="di"><div class="dl">机器名称</div><div class="dv" title="${esc(m.machineId)}">${esc(mName(m))}</div></div>
        <div class="di"><div class="dl">连接状态</div><div class="dv">${m.online ? '<span class="st"><i class="dot ok"></i>在线</span>' : '<span class="st"><i class="dot"></i>离线</span>'}</div></div>
        <div class="di"><div class="dl">Tether 版本</div><div class="dv">${esc(m.version || '?')}</div></div>
        <div class="di"><div class="dl">${m.online ? '本次上线' : '最后在线'}</div><div class="dv" title="${esc(fullTime(m.lastSeen))}">${ago(m.lastSeen)}</div></div>
        <div class="di"><div class="dl">Token 名称</div><div class="dv mono">${esc(m.tokenName)}</div></div>
        <div class="di"><div class="dl">会话</div><div class="dv">${live(m)} 活动 / ${ss.length} 总计</div></div>
      </div></div></div>
    <div class="card"><div class="card-head"><h3>会话</h3><div class="extra">${m.online ? '列表实时更新' : '离线，显示最后已知状态'}</div></div>
      ${ss.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>名称 / 命令</th><th>工作目录</th><th>状态</th><th>Claude</th><th>SSH 主机</th><th>开始 / 最后活动</th><th class="r">操作</th></tr></thead><tbody>
        ${ss.map((s) => `<tr class="${rowCls(s)}">
          <td><div class="sname">${esc(sName(s))}</div><div class="scmd">${esc(s.command)}</div>${msg(s)}</td>
          <td><div class="cwd" title="${tip(s)}">${esc(s.cwd)}</div></td>
          <td>${stCell(s.status)}</td><td>${claudeTag(s.claude)}</td>
          <td class="mono scmd">${s.host ? esc(s.host) : '<span class="muted">—</span>'}</td>
          <td class="tm" title="最后活动：${esc(fullTime(s.lastActivityAt))}"><div>${shortTime(s.startedAt)}</div><div>${ago(s.lastActivityAt)}</div></td>
          <td class="r">${takeBtn(m, s)}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="scards">${ss.map((s) => `<div class="scard ${rowCls(s)}">
        <div class="sc"><div class="r1"><span class="sname">${esc(sName(s))}</span>${s.claude ? claudeTag(s.claude) : ''}</div>
        <div class="r2">${esc(s.cwd)} › ${esc(s.command)}</div>${msg(s)}
        <div class="r3">${stCell(s.status)}<span>${ago(s.lastActivityAt)}</span>${s.host ? `<span class="mono">${esc(s.host)}</span>` : ''}</div></div>
        ${takeBtn(m, s)}</div>`).join('')}</div>`
      : `<div class="empty">${m.online ? '该机器暂无会话' : '离线，暂无会话信息'}</div>`}
    </div>`;
}

function pick(id) {
  selId = id;
  $('alert').classList.remove('open');
  renderMachines();
  renderDetail();
  location.hash = isM() ? '#detail' : '#main';
}

// ---- 路由 ----

function route() {
  if (!authed) return;
  const h = location.hash.slice(1);
  let v = ['main', 'detail', 'term', 'audit'].includes(h) ? h : 'main';
  if ((v === 'term' && !termRef) || (v === 'detail' && state && !selected())) {
    v = 'main';
    history.replaceState(null, '', '#main');
  }
  view = v;
  if (v !== 'term') closeTerm();
  showView(v === 'term' ? 'term' : 'shell');
  $('p-main').classList.toggle('on', v !== 'audit');
  $('p-audit').classList.toggle('on', v === 'audit');
  $('nav-main').classList.toggle('on', v !== 'audit');
  $('nav-audit').classList.toggle('on', v === 'audit');
  $('p-main').classList.toggle('show-detail', v === 'detail');
  renderAlert();
  if (v === 'term' && !termWs) connectTerm();
  if (v === 'audit') loadAudit();
}
window.addEventListener('hashchange', route);

// ---- 远程接管终端：浏览器 ↔ hub 的 /api/term WebSocket，内容为 base64 透传 ----

/** 整段都是终端查询应答：CPR / DSR、DA1 / DA2、DECRQM、OSC 颜色等、DCS（DECRQSS、XTVERSION） */
const QUERY_REPLY = /^(?:\x1b\[\d+;\d+R|\x1b\[\d*n|\x1b\[[?>][\d;]*c|\x1b\[\??[\d;]+\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\x5c)|\x1bP[^\x1b]*\x1b\x5c)+$/;
/** 结束原因：样式、标签、横幅标题、说明、可否重新接管 */
const END = {
  reclaimed: ['warn', '已被本地收回', '本机已收回控制', '本机用户在 Tether 中恢复了操作，网页端输入已停止。', true],
  disabled: ['err', '接管被关闭', '本机关闭了远程接管', '该机器在 Tether 设置中取消了「允许 hub 远程接管本机会话」。'],
  denied: ['err', '未允许接管', '本机未允许远程接管', '请在该机器 Tether 设置「管理服务器」中勾选「允许 hub 远程接管本机会话」。'],
  exited: ['def', '会话已退出', '会话已退出', '进程已结束，以下为最后输出。'],
  offline: ['err', '机器离线', '机器离线', '与该机器的连接已断开，恢复后需重新接管。', true],
  not_found: ['err', '会话不存在', '会话不存在或已退出', '该会话已不在机器的会话列表中。'],
  probe: ['err', '不支持接管', '探测连接不支持接管', '该机器当前为测试连接。'],
  closed: ['err', '连接已断开', '连接已断开', '与 hub 的终端连接中断。', true],
};

const utf8 = new TextEncoder();
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** xterm 配色取自 CSS 变量，与页面主题一致 */
function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    background: v('--t-bg'), foreground: v('--t-fg'), cursor: v('--t-car'), cursorAccent: v('--t-bg'),
    selectionBackground: v('--t-sel'), red: v('--t-red'), green: v('--t-green'), yellow: v('--t-yel'),
    blue: v('--t-blue'), magenta: v('--t-pur'), cyan: v('--t-cyan'), brightBlack: v('--t-dim'),
  };
}

function setTermState(kind, reason) {
  const ended = kind === 'ended';
  $('term-wrap').classList.toggle('ro', ended);
  $('keys').classList.toggle('dis', kind !== 'active');
  $('t-banner').innerHTML = '';
  if (kind === 'connecting') {
    $('t-tag').innerHTML = '<span class="tag"><i class="dot info"></i>连接中…</span>';
    $('t-foot').innerHTML = '';
  } else if (kind === 'active') {
    $('t-tag').innerHTML = '<span class="tag t-pri"><i class="dot ok"></i>接管中</span>';
    $('t-foot').innerHTML = `<span>键盘输入直接发送到远程会话</span><span id="t-size">${term.cols} × ${term.rows}</span><span class="end">本机可随时在 Tether 中收回控制</span>`;
  } else {
    const [cls, tag, title, desc, retry] = END[reason] || ['err', `已结束（${reason}）`, '接管已结束', `原因：${reason}`];
    $('t-tag').innerHTML = `<span class="tag ${cls === 'def' ? '' : `t-${cls}`}">${esc(tag)}</span>`;
    $('t-banner').innerHTML = `<div class="banner ${cls}">${ic(cls === 'def' ? 'info' : cls === 'err' ? 'alertC' : 'alert')}
      <div><span class="bt">${esc(title)}</span> <span class="bd">${esc(desc)}</span></div>
      ${retry ? '<div class="act"><button class="btn btn-sm btn-primary" data-retake>重新接管</button></div>' : ''}</div>`;
    $('t-foot').innerHTML = '<span>只读 · 不再向远程发送输入</span>';
  }
}

function openTerm(machineId, sessionId) {
  const m = machines().find((x) => x.machineId === machineId);
  const s = m && m.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  termRef = { machineId, sessionId, machine: mName(m), name: sName(s), cwd: s.cwd || '' };
  if (location.hash === '#term') connectTerm();
  else location.hash = '#term';
}

function connectTerm() {
  disposeTerm();
  const ref = termRef;
  $('t-name').textContent = ref.name;
  $('t-sub').textContent = `${ref.machine} · ${ref.cwd}`;
  setTermState('connecting');

  const t = (term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace', fontSize: isM() ? 12 : 14,
    cursorBlink: true, scrollback: 5000, theme: termTheme(),
  }));
  const fit = new FitAddon.FitAddon();
  t.loadAddon(fit);
  t.open($('term-box'));
  fit.fit();
  // Ctrl+C 有选区时复制、Ctrl+V 粘贴：交给浏览器默认行为，由 xterm 的 copy / paste 事件处理（多行粘贴、括号粘贴模式）
  t.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.shiftKey
    && ((e.key === 'c' && t.hasSelection()) || e.key === 'v')));

  const ws = (termWs = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/term?machine=${encodeURIComponent(ref.machineId)}&session=${ref.sessionId}`));
  let ready = false;
  let ended = false;
  let sizing = false;
  const send = (msg) => ready && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  // xterm 对终端查询的自动应答（光标位置、设备属性、模式、颜色、DCS）不转发：
  // 本地 GUI 或 daemon 已负责应答，多个查看者都回复会在 PTY 中出现重复应答乱码
  t.onData((d) => { if (!QUERY_REPLY.test(d)) send({ type: 'input', data: toB64(utf8.encode(d)) }); });
  t.onBinary((d) => send({ type: 'input', data: btoa(d) }));
  t.onResize(({ cols, rows }) => {
    send({ type: 'resize', cols, rows });
    if ($('t-size')) $('t-size').textContent = `${cols} × ${rows}`;
  });
  // 容器尺寸变化（窗口缩放、软键盘弹出、横幅出现）即重新适配；写入快照期间保持快照尺寸
  termRo = new ResizeObserver(() => sizing || fit.fit());
  termRo.observe($('term-box'));

  const end = (reason) => {
    ended = true;
    ready = false;
    t.options.disableStdin = true;
    setTermState('ended', reason);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') {
      // 先按快照尺寸写入避免错行，再适配窗口并把新尺寸发给 daemon
      sizing = true;
      t.reset();
      if (msg.cols > 0 && msg.rows > 0) t.resize(msg.cols, msg.rows);
      t.write(fromB64(msg.data), () => {
        sizing = false;
        ready = true;
        fit.fit();
        if ($('t-size')) $('t-size').textContent = `${t.cols} × ${t.rows}`;
      });
      setTermState('active');
      t.focus();
    } else if (msg.type === 'output') {
      t.write(fromB64(msg.data));
    } else if (msg.type === 'detached' || msg.type === 'denied') {
      end(msg.type === 'denied' && msg.reason === 'disabled' ? 'denied' : msg.reason);
    }
  };
  ws.onclose = () => {
    if (!ended) end('closed');
  };
}

function disposeTerm() {
  if (termWs) {
    termWs.onclose = null;
    termWs.close();
    termWs = null;
  }
  if (termRo) termRo.disconnect();
  termRo = null;
  if (term) term.dispose();
  term = null;
}

/** 离开终端页即断开接管 */
function closeTerm() {
  const was = !!termWs;
  disposeTerm();
  termRef = null;
  if (was) loadAudit();
}

// 手机按键条：方向键在应用光标键模式（DECCKM）下发 ESC O x；按下时不抢焦点，软键盘保持弹出
const KEYS = { esc: '\x1b', tab: '\t', ctrlc: '\x03' };
const ARROW = { up: 'A', down: 'B', right: 'C', left: 'D' };
$('keys').addEventListener('mousedown', (e) => e.preventDefault());
$('keys').addEventListener('click', (e) => {
  const b = e.target.closest('[data-key]');
  if (!b || !term) return;
  const k = b.dataset.key;
  const seq = ARROW[k] ? `${term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['}${ARROW[k]}` : KEYS[k];
  term.input(seq, true);
});
$('term-wrap').addEventListener('click', () => term && term.focus());
const leaveTerm = () => (location.hash = isM() && selected() ? '#detail' : '#main');
$('t-close').addEventListener('click', leaveTerm);
$('t-close-m').addEventListener('click', leaveTerm);
$('t-banner').addEventListener('click', (e) => e.target.closest('[data-retake]') && connectTerm());

// ---- 审计日志 ----

const PAGE = 20;
/** 更新事件没有机器字段，归为 hub */
const aMachine = (a) => a.machineName || a.machineId || 'hub';
let auditRows = [];
let auditPage = 0;

async function loadAudit() {
  try {
    const r = await fetch('/api/audit?limit=500');
    if (r.status === 401) return showLogin('登录已失效，请重新登录');
    if (!r.ok) return;
    auditRows = await r.json();
  } catch {
    return;
  }
  const sel = $('f-m');
  const cur = sel.value;
  const names = [...new Set(auditRows.map(aMachine))].sort();
  sel.innerHTML = '<option value="">全部机器</option>' + names.map((n) => `<option>${esc(n)}</option>`).join('');
  sel.value = names.includes(cur) ? cur : '';
  $('a-count').textContent = `最近 ${auditRows.length} 条`;
  renderAudit();
}

function renderAudit() {
  const ev = $('f-ev').value;
  const mm = $('f-m').value;
  const kw = $('f-kw').value.trim().toLowerCase();
  const rows = auditRows.filter((a) => (!ev || a.event === ev) && (!mm || aMachine(a) === mm)
    && (!kw || `${a.sessionName} #${a.sessionId} ${a.ip || ''}`.toLowerCase().includes(kw)));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  auditPage = Math.min(auditPage, pages - 1);
  const shown = rows.slice(auditPage * PAGE, (auditPage + 1) * PAGE);
  const tag = (e) => `<span class="tag ${EV[e] ? EV[e][1] : ''}"><span class="ev">${esc(e)}</span>${EV[e] ? EV[e][0] : ''}</span>`;
  const desc = (a) => esc(a.to ? `${a.from} → ${a.to}${a.reason ? `：${a.reason}` : ''}`
    : a.reason ? REASON[a.reason] || a.reason : EV[a.event] ? EV[a.event][2] : '');
  const sess = (a) => (a.sessionId === undefined ? '<span class="muted">—</span>' : `${esc(a.sessionName || '会话')} <span class="muted">#${a.sessionId}</span>`);
  const time = (a) => fullTime(Date.parse(a.time));
  $('a-body').innerHTML = shown.map((a) => `<tr><td class="tm">${esc(time(a))}</td><td>${tag(a.event)}</td>
    <td>${esc(aMachine(a))}</td><td>${sess(a)}</td>
    <td class="mono scmd">${esc(a.ip || '—')}</td><td class="muted">${desc(a)}</td></tr>`).join('')
    || `<tr><td colspan="6" class="empty">${auditRows.length ? '没有符合条件的记录' : '暂无接管记录'}</td></tr>`;
  $('a-list').innerHTML = shown.map((a) => `<div class="arow"><div class="a1">${tag(a.event)}<span class="tm">${esc(time(a))}</span></div>
    <div class="a2">${esc(aMachine(a))}${a.sessionId === undefined ? '' : ` · ${esc(a.sessionName || '会话')} #${a.sessionId}`}<span class="mono">${esc(a.ip || '')}</span></div>
    <div class="a3">${desc(a)}</div></div>`).join('')
    || `<div class="empty">${auditRows.length ? '没有符合条件的记录' : '暂无接管记录'}</div>`;
  $('a-total').textContent = `共 ${rows.length} 条`;
  // 页码最多显示 5 个，以当前页为中心
  const from = Math.max(0, Math.min(auditPage - 2, pages - 5));
  const nums = [];
  for (let i = from; i < Math.min(pages, from + 5); i++) nums.push(`<button data-page="${i}" class="${i === auditPage ? 'on' : ''}">${i + 1}</button>`);
  $('a-pages').innerHTML = `<button data-page="${auditPage - 1}" aria-label="上一页"${auditPage ? '' : ' disabled'}>${ic('chevL')}</button>${nums.join('')}`
    + `<button data-page="${auditPage + 1}" aria-label="下一页"${auditPage < pages - 1 ? '' : ' disabled'}>${ic('chevR')}</button>`;
}

$('f-ev').innerHTML += Object.entries(EV).map(([k, v]) => `<option value="${k}">${k} · ${v[0]}</option>`).join('');
const refilter = () => { auditPage = 0; renderAudit(); };
$('f-ev').addEventListener('change', refilter);
$('f-m').addEventListener('change', refilter);
$('f-kw').addEventListener('input', refilter);
$('f-reset').addEventListener('click', () => {
  $('f-ev').value = '';
  $('f-m').value = '';
  $('f-kw').value = '';
  refilter();
});
$('a-refresh').addEventListener('click', loadAudit);
$('a-pages').addEventListener('click', (e) => {
  const b = e.target.closest('[data-page]');
  if (!b || b.disabled) return;
  auditPage = Number(b.dataset.page);
  renderAudit();
});

// ---- 版本与更新：状态由 SSE update 事件推送 ----

let upd = null;
/** 更新完成、等待 hub 重启的开始时间 */
let restartAt = 0;
const RESTART_HINT_MS = 90_000;

function verNewer(a, b) {
  const p = (v) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v || '') || []).slice(1).map(Number);
  const x = p(a);
  const y = p(b);
  if (x.length < 3 || y.length < 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function renderUpdate() {
  if (!upd) return;
  const newer = verNewer(upd.latest, upd.current);
  const st = upd.state;
  const b = $('upd-btn');
  b.hidden = false;
  b.classList.toggle('new', newer || st === 'updating' || st === 'done');
  const lbl = st === 'updating' ? '正在更新…' : st === 'done' ? '正在重启…' : newer ? `有新版本 ${upd.latest}` : `v${upd.current}`;
  b.innerHTML = `${ic('up')}<span class="lbl">${esc(lbl)}</span>`;
  b.title = newer ? `有新版本 ${upd.latest}，点击查看` : `当前版本 v${upd.current}，点击检查更新`;
  if (st === 'done') {
    $('upd').hidden = false;
    watchRestart();
  }
  if ($('upd').hidden) return;

  const busy = st === 'checking' || st === 'updating';
  const tag = {
    checking: '<span class="tag"><i class="dot info"></i>正在检查…</span>',
    updating: '<span class="tag t-pri"><i class="dot info"></i>正在更新…</span>',
    done: '<span class="tag t-pri"><i class="dot ok"></i>更新完成</span>',
    failed: '<span class="tag t-err">更新失败</span>',
  }[st] || (newer ? '<span class="tag t-pri"><i class="dot ok"></i>有新版本</span>' : upd.latest ? '<span class="tag">已是最新版本</span>' : '');
  const url = /^https?:\/\//.test(upd.url || '') ? upd.url : '';
  const late = restartAt && Date.now() - restartAt > RESTART_HINT_MS;
  const checked = upd.checkedAt ? Date.parse(upd.checkedAt) : 0;
  $('upd-body').innerHTML = `
    <div class="desc">
      <div class="di"><div class="dl">当前版本</div><div class="dv">v${esc(upd.current)}</div></div>
      <div class="di"><div class="dl">最新版本</div><div class="dv">${upd.latest ? esc(upd.latest) : '—'}</div></div>
      <div class="di"><div class="dl">上次检查</div><div class="dv" title="${esc(fullTime(checked))}">${ago(checked)}</div></div>
    </div>
    <div class="upd-st">${tag}${url && upd.latest ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">发布页${ic('chevR', 'ic-sm')}</a>` : ''}</div>
    ${upd.error ? `<div class="banner">${ic('alertC')}<div><span class="bd">${esc(upd.error)}</span></div></div>` : ''}
    ${st === 'done' ? `<div class="banner def">${ic('info')}<div><span class="bt">${late ? 'hub 长时间未恢复' : '更新完成，正在重启…'}</span>
      <span class="bd">${late ? 'hub 可能未配置进程管理器（systemd / pm2 / NSSM），请到服务器上手动启动。' : 'hub 恢复后页面将自动刷新，需重新登录。'}</span></div></div>` : ''}
    ${newer && upd.notes ? `<div class="upd-sec">更新说明</div><div class="upd-notes">${esc(upd.notes)}</div>` : ''}
    ${upd.log ? `<div class="upd-sec">更新日志</div><pre class="upd-log" id="upd-log">${esc(upd.log)}</pre>` : ''}
    ${st === 'done' ? '' : `<div class="upd-acts">
      <button class="btn" data-upd="check"${busy ? ' disabled' : ''}>${ic('reset')}检查更新</button>
      ${newer ? `<button class="btn btn-primary" data-upd="apply"${busy ? ' disabled' : ''}>${st === 'failed' ? '重试更新' : '立即更新'}</button>` : ''}
    </div>`}`;
  const log = $('upd-log');
  if (log) log.scrollTop = log.scrollHeight;
}

/** 等待 hub 重启：旧进程退出后再次连通（或新进程因登录会话失效返回 401）即刷新页面 */
function watchRestart() {
  if (restartAt) return;
  restartAt = Date.now();
  let down = false;
  const tick = async () => {
    try {
      const r = await fetch('/api/me', { cache: 'no-store' });
      if (down || r.status === 401) return location.reload();
    } catch {
      down = true;
    }
    if (Date.now() - restartAt > RESTART_HINT_MS) renderUpdate();
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1500);
}

async function updAction(kind) {
  if (kind === 'apply') {
    let n = upd.takeovers || 0;
    try {
      n = (await (await fetch('/api/update')).json()).takeovers || 0;
    } catch {}
    const msg = n ? `当前有 ${n} 个会话正在被远程接管，更新完成后 hub 会重启，接管将中断。\n\n确定更新到 ${upd.latest}？`
      : `将更新到 ${upd.latest}，完成后 hub 会自动重启。确定继续？`;
    if (!confirm(msg)) return;
  }
  try {
    const r = await fetch(`/api/update/${kind}`, { method: 'POST' });
    if (r.status === 401) return showLogin('登录已失效，请重新登录');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) alert(body.error || `操作失败（${r.status}）`);
  } catch {
    alert('无法连接服务器');
  }
}

/** 等待重启期间面板保持打开 */
const closeUpd = () => upd && upd.state !== 'done' && ($('upd').hidden = true);
$('upd-btn').addEventListener('click', () => {
  $('upd').hidden = false;
  renderUpdate();
});
$('upd-close').addEventListener('click', closeUpd);
$('upd').addEventListener('click', (e) => {
  if (e.target === $('upd')) return closeUpd();
  const b = e.target.closest('[data-upd]');
  if (b && !b.disabled) updAction(b.dataset.upd);
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('upd').hidden && closeUpd());

// ---- 事件绑定 ----

$('m-search').addEventListener('input', renderMachines);
document.addEventListener('click', (e) => {
  const take = e.target.closest('[data-take]');
  if (take) return openTerm(take.dataset.take, Number(take.dataset.sid));
  const p = e.target.closest('[data-pick]');
  if (p) return pick(p.dataset.pick);
  if (e.target.closest('[data-back]')) return (location.hash = '#main');
  if (e.target.closest('[data-toggle]') && isM()) $('alert').classList.toggle('open');
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return showLogin(body.error || `登录失败（${r.status}）`);
    $('password').value = '';
    showMain();
  } catch {
    showLogin('无法连接服务器');
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  state = null;
  render();
  showLogin();
});

// 相对时间每 30 s 刷新一次
setInterval(() => state && authed && render(), 30_000);

fetch('/api/me')
  .then((r) => (r.ok ? showMain() : showLogin()))
  .catch(() => showLogin('无法连接服务器'));
