// Tether Hub Web 界面：登录、SSE 实时接收机器 / 会话状态并按主从布局渲染；远程接管终端（xterm.js，含回看历史、粘贴与贴图）；审计日志。
// 版本与更新：顶栏版本按钮 / 新版本胶囊 + 更新面板（检查、一键更新、进度日志、重启后自动刷新）。
// 机器 token：顶栏「Token」面板（列表、签发并一次性显示明文、页内二次确认吊销）。
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
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3"/><path d="m16 7 3 3"/><path d="m19 4 2 2"/>',
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
  token_create: ['签发 token', 't-pri', '网页签发 token'],
  token_revoke: ['吊销 token', 't-warn', '网页吊销 token'],
  start: ['开始接管', 't-pri', '网页端开始接管'],
  end: ['结束接管', '', '最后一个网页端关闭终端'],
  denied: ['拒绝接管', 't-err', '接管被拒绝'],
  reclaimed: ['本地收回', 't-warn', '本机用户收回控制'],
  disabled: ['接管被关闭', 't-warn', '本机关闭了允许接管'],
  exited: ['会话退出', '', '会话进程已退出'],
  disconnected: ['连接断开', '', '机器连接断开，接管结束'],
  image: ['贴图', 't-pri', '网页上传图片，路径已输入到会话'],
  image_failed: ['贴图失败', 't-err', '贴图失败'],
  close: ['关闭会话', 't-warn', '网页关闭了远端会话'],
  close_failed: ['关闭失败', 't-err', '网页关闭会话失败'],
};
const REASON = {
  reclaimed: '已被本地收回', disabled: '本机未允许接管', exited: '会话已退出', offline: '机器离线',
  not_found: '会话不存在或已退出', probe: '探测连接不支持接管',
  // 贴图失败（image_failed）
  not_taken_over: '会话未被 hub 接管', unsupported: '仅本地会话支持贴图', too_large: '图片过大', bad_type: '文件内容与图片类型不符',
  io: '本机保存图片失败', timeout: '等待本机回复超时', ended: '上传期间接管结束', disconnected: '等待期间机器断开',
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
let ctrlOn = false; // 按键条粘滞 Ctrl
let touch = null; // 终端区单指滑动 / 惯性状态
/** 网页关闭会话：正在二次确认 / 请求中的会话（machineId/sessionId），以及最近一次失败 {key, text} */
let closeAsk = null;
let closeBusy = null;
let closeErr = null;
/** 机器详情顶部的一次性提示（如「会话已关闭」），几秒后消失 */
let notice = '';
let noticeTimer = 0;

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
  closeTok();
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
  if (termRef) syncImgBtn();
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
    : '还没有机器接入。<br>在顶栏「Token」中签发 token，<br>并在 Tether 客户端设置中填写服务器地址与 token。'}</div>`;
}

function claudeTag(c) {
  if (!c) return '<span class="muted">—</span>';
  switch (c.state) {
    case 'waiting': return `<span class="tag t-warn">${ic('alert', 'ic-sm')}等待确认</span>`;
    case 'thinking': return '<span class="tag"><i class="dot info"></i>思考中</span>';
    case 'background': return `<span class="tag"><i class="dot pur"></i>后台运行中${c.count ? ` ×${c.count}` : ''}</span>`;
    case 'done': return '<span class="tag">已完成</span>';
    case 'idle': return '<span class="tag">空闲</span>';
    default: return `<span class="tag">${esc(c.state)}</span>`;
  }
}
const stCell = (st) => ({
  running: '<span class="st"><i class="dot ok"></i>运行中</span>',
  waiting: '<span class="st" title="有新结果或提醒，会话里还没有操作过"><i class="dot"></i>待查看</span>',
  exited: '<span class="st muted"><i class="dot"></i>已退出</span>',
})[st] || `<span class="st">${esc(st)}</span>`;

function takeBtn(m, s) {
  if (s.status === 'exited') return '<button class="btn btn-sm" disabled title="会话已退出">接管</button>';
  if (!m.online) return '<button class="btn btn-sm" disabled title="机器离线">接管</button>';
  return `<button class="btn btn-sm${isWaiting(s) ? ' btn-primary' : ''}" data-take="${esc(m.machineId)}" data-sid="${s.id}">接管</button>`;
}

/** 运行中会话的「关闭」：页内二次确认；机器离线或 Tether 不支持时置灰并说明原因 */
function closeBtn(m, s) {
  if (s.status === 'exited') return '';
  const key = `${m.machineId}/${s.id}`;
  const err = closeErr && closeErr.key === key ? `<div class="cl-err">${esc(closeErr.text)}</div>` : '';
  const why = !m.online ? '机器离线' : !(m.caps || []).includes('close') ? '网页关闭会话需 Tether 0.5.0+' : '';
  if (why) return `<button class="btn btn-sm" disabled title="${why}">关闭</button>`;
  if (closeBusy === key) return '<button class="btn btn-sm" disabled>关闭中…</button>';
  const attrs = `data-m="${esc(m.machineId)}" data-sid="${s.id}"`;
  if (closeAsk === key) {
    return `<span class="cl-ask"><span class="cl-q">结束该会话进程？</span><button class="btn btn-sm" data-close-cancel>取消</button><button class="btn btn-sm btn-primary" data-close-ok ${attrs}>确认关闭</button></span>${err}`;
  }
  return `<button class="btn btn-sm" data-close ${attrs} title="结束该会话（本机需允许 hub 远程接管）">关闭</button>${err}`;
}

async function closeSession(machineId, sid) {
  const key = `${machineId}/${sid}`;
  closeAsk = null;
  closeErr = null;
  closeBusy = key;
  renderDetail();
  let text = '';
  try {
    const r = await fetch(`/api/session/close?machine=${encodeURIComponent(machineId)}&session=${sid}`, { method: 'POST' });
    if (r.status === 401) return showLogin('登录已失效，请重新登录');
    if (!r.ok) text = (await r.json().catch(() => ({}))).error || `关闭失败（${r.status}）`;
  } catch {
    text = '无法连接服务器';
  } finally {
    closeBusy = null;
  }
  // 成功后会话退出由 Tether 通过会话列表上报，页面随 SSE 更新
  if (text) closeErr = { key, text };
  renderDetail();
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
  $('detail').innerHTML = `${notice ? `<div class="banner def notice">${ic('info')}<div><span class="bt">${esc(notice)}</span></div></div>` : ''}
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
          <td class="r"><div class="acts">${takeBtn(m, s)}${closeBtn(m, s)}</div></td></tr>`).join('')}
        </tbody></table></div>
      <div class="scards">${ss.map((s) => `<div class="scard ${rowCls(s)}">
        <div class="sc"><div class="r1"><span class="sname">${esc(sName(s))}</span>${s.claude ? claudeTag(s.claude) : ''}</div>
        <div class="r2">${esc(s.cwd)} › ${esc(s.command)}</div>${msg(s)}
        <div class="r3">${stCell(s.status)}<span>${ago(s.lastActivityAt)}</span>${s.host ? `<span class="mono">${esc(s.host)}</span>` : ''}</div></div>
        <div class="acts">${takeBtn(m, s)}${closeBtn(m, s)}</div></div>`).join('')}</div>`
      : `<div class="empty">${m.online ? '该机器暂无会话' : '离线，暂无会话信息'}</div>`}
    </div>`;
}

function showNotice(text) {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    renderDetail();
  }, 5000);
  renderDetail();
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
  syncImgBtn();
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
    cursorBlink: true, scrollback: 10000, theme: termTheme(),
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
  t.onData((d) => {
    // 粘滞 Ctrl 只作用于下一个可打印字符（方向键、Esc 等以控制字符开头，不受影响）
    if (ctrlOn && d.charCodeAt(0) >= 0x20 && d.charCodeAt(0) !== 0x7f) {
      d = ctrlChar(d[0]) + d.slice(1);
      setCtrl(false);
    }
    if (!QUERY_REPLY.test(d)) send({ type: 'input', data: toB64(utf8.encode(d)) });
  });
  t.onBinary((d) => send({ type: 'input', data: btoa(d) }));
  // 滚离底部时显示「回到底部」；上翻期间有新输出 xterm 不会跳回，回到底部后恢复跟随
  const syncBottom = () => { const b = t.buffer.active; $('t-bottom').hidden = b.viewportY >= b.baseY; };
  t.onScroll(syncBottom);
  t.buffer.onBufferChange(syncBottom);
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
      // 先按快照尺寸写入避免错行，再适配窗口并把新尺寸发给 daemon；
      // history（Tether 0.5.0+）先写入：历史行 + rows 个换行把它们推进 scrollback，备用屏时末尾为 ?1049h，快照随后写入当前屏
      sizing = true;
      t.reset();
      if (msg.cols > 0 && msg.rows > 0) t.resize(msg.cols, msg.rows);
      if (msg.history) t.write(fromB64(msg.history));
      t.write(fromB64(msg.data), () => {
        sizing = false;
        ready = true;
        fit.fit();
        syncBottom();
        if ($('t-size')) $('t-size').textContent = `${t.cols} × ${t.rows}`;
      });
      setTermState('active');
      t.focus();
    } else if (msg.type === 'output') {
      t.write(fromB64(msg.data));
    } else if (msg.type === 'detached' && msg.reason === 'session_closed') {
      // 会话被网页关闭（随后从会话列表消失）：关闭终端页，回到机器页提示
      ended = true;
      showNotice(`会话「${ref.name}」已关闭`);
      leaveTerm();
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
  touch = null;
  $('t-bottom').hidden = true;
  setCtrl(false);
  toast('');
  closePaste();
}

/** 离开终端页即断开接管 */
function closeTerm() {
  const was = !!termWs;
  disposeTerm();
  termRef = null;
  if (was) loadAudit();
}

// 手机按键条：方向键在应用光标键模式（DECCKM）下发 ESC O x；按下时不抢焦点，软键盘保持弹出
// Ctrl 为一次性粘滞键：按下高亮，下一个输入字符转为控制字符后自动取消，再按一下取消；Ctrl+方向键发 CSI 1;5 x
const KEYS = { esc: '\x1b', tab: '\t' };
const ARROW = { up: 'A', down: 'B', right: 'C', left: 'D' };
/** 方向键序列：遵循应用光标键模式（DECCKM） */
const arrow = (k) => `${term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['}${ARROW[k]}`;
function setCtrl(on) {
  ctrlOn = on;
  const b = $('keys').querySelector('[data-key="ctrl"]');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}
/** Ctrl+字母 / @ [ \ ] ^ _ 转 C0 控制字符，Ctrl+空格 = NUL，Ctrl+? = DEL；其他字符原样 */
function ctrlChar(ch) {
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  const c = ch.toUpperCase().charCodeAt(0);
  return c >= 0x40 && c <= 0x5f ? String.fromCharCode(c & 0x1f) : ch;
}
$('keys').addEventListener('mousedown', (e) => e.preventDefault());
$('keys').addEventListener('click', (e) => {
  const b = e.target.closest('[data-key]');
  if (!b || !term) return;
  const k = b.dataset.key;
  if (k === 'ctrl') return setCtrl(!ctrlOn);
  if (k === 'paste') return pasteKey();
  if (k === 'image') return imgBlock() ? toast(imgBlock(), 'err', 4000) : $('img-file').click();
  let seq = KEYS[k];
  if (ARROW[k] && ctrlOn) {
    seq = `\x1b[1;5${ARROW[k]}`;
    setCtrl(false);
  } else if (ARROW[k]) seq = arrow(k);
  term.input(seq, true);
});

// 粘贴与贴图：「粘贴」键在 https（安全上下文）下直接读剪贴板，否则打开粘贴弹层手动粘贴；
// 剪贴板只有图片（没有文本）时按贴图处理：POST /api/term/image，由 Tether 保存为临时文件并把路径输入到会话（需 Tether 0.5.0+，仅本地会话）
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMG = 10 * 1024 * 1024;
let imgBusy = false;
let toastTimer = 0;

/** 当前接管的会话不能贴图的原因；可以时返回空串 */
function imgBlock() {
  const m = termRef && machines().find((x) => x.machineId === termRef.machineId);
  const s = m && m.sessions.find((x) => x.id === termRef.sessionId);
  if (!m || !m.online) return '机器离线';
  if (!(m.caps || []).includes('image')) return '贴图需 Tether 0.5.0+';
  if (s && s.host) return 'SSH 会话不支持贴图，仅本地会话可用';
  return '';
}
function syncImgBtn() {
  const b = $('keys').querySelector('[data-key="image"]');
  const why = imgBlock();
  b.classList.toggle('off', !!why);
  b.title = why || '选择图片上传，路径输入到会话';
}

/** 终端顶部提示条；ms 为 0 时一直显示，text 为空即隐藏 */
function toast(text, kind = '', ms = 0) {
  const el = $('t-toast');
  clearTimeout(toastTimer);
  el.textContent = text;
  el.className = `t-toast ${kind}`;
  el.hidden = !text;
  if (ms) toastTimer = setTimeout(() => (el.hidden = true), ms);
}

async function sendImage(blob) {
  const why = imgBlock();
  if (why) return toast(why, 'err', 4000);
  if (imgBusy) return toast('上一张图片还在上传', 'err', 3000);
  if (!IMG_TYPES.includes(blob.type)) return toast('仅支持 PNG / JPEG / GIF / WebP 图片', 'err', 4000);
  if (blob.size > MAX_IMG) return toast('图片过大（上限 10 MB）', 'err', 4000);
  const ref = termRef;
  imgBusy = true;
  toast('正在上传图片…');
  let ok = false;
  let msg;
  try {
    const r = await fetch(`/api/term/image?machine=${encodeURIComponent(ref.machineId)}&session=${ref.sessionId}`, {
      method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
    });
    if (r.status === 401) {
      imgBusy = false;
      return showLogin('登录已失效，请重新登录');
    }
    const body = await r.json().catch(() => ({}));
    ok = r.ok;
    msg = ok ? '已插入图片路径' : body.error || `上传失败（${r.status}）`;
  } catch {
    msg = '上传失败：无法连接服务器';
  }
  imgBusy = false;
  if (termRef === ref) toast(msg, ok ? 'ok' : 'err', ok ? 2500 : 5000);
}

async function pasteKey() {
  setCtrl(false);
  if (window.isSecureContext && navigator.clipboard) {
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        const text = items.find((i) => i.types.includes('text/plain'));
        if (text) return term && term.paste(await (await text.getType('text/plain')).text());
        for (const i of items) {
          const type = i.types.find((t) => t.startsWith('image/'));
          if (type) return sendImage(await i.getType(type));
        }
        return toast('剪贴板为空', '', 2500);
      }
      return term && term.paste(await navigator.clipboard.readText());
    } catch {} // 未授权或不支持：退回弹层
  }
  $('paste-text').value = '';
  $('paste').hidden = false;
  $('paste-text').focus();
}
const closePaste = () => ($('paste').hidden = true);
$('paste-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('paste-text').value;
  closePaste();
  if (!term || !v) return;
  setCtrl(false);
  term.paste(v); // 与键盘粘贴相同：换行转回车，程序开启括号粘贴模式时自动包裹
});
$('paste-close').addEventListener('click', closePaste);
$('paste-cancel').addEventListener('click', closePaste);
$('paste').addEventListener('click', (e) => e.target === $('paste') && closePaste());
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('paste').hidden && closePaste());
$('img-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) sendImage(f);
});
// 桌面 Ctrl+V 贴截图：捕获阶段先于 xterm 拦下只含图片的剪贴板；带文本的粘贴照常交给 xterm
$('term-box').addEventListener('paste', (e) => {
  const items = [...(e.clipboardData ? e.clipboardData.items : [])];
  const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!term || !img || items.some((i) => i.type === 'text/plain')) return;
  e.preventDefault();
  e.stopPropagation();
  sendImage(img.getAsFile());
}, true);

$('term-wrap').addEventListener('click', () => term && term.focus());
$('t-bottom').addEventListener('mousedown', (e) => e.preventDefault());
$('t-bottom').addEventListener('click', (e) => {
  e.stopPropagation(); // 不触发上面的聚焦，避免手机上点按钮弹出键盘
  if (term) term.scrollToBottom();
});

// 触屏单指上下滑动（xterm 6 自身不处理触摸滚动）：
// 普通缓冲区滚动历史，松手后带惯性；全屏程序（备用缓冲区）没有历史，逐行派发滚轮事件交给 xterm 处理——
// 程序开了鼠标跟踪就按其协议发滚轮序列，否则发 ↑ ↓（遵循 DECCKM），与桌面端滚轮行为一致。
// 轻点不拦截，仍由 xterm 的 mousedown 聚焦并弹出键盘
function touchScroll(px) {
  const screen = term.element.querySelector('.xterm-screen');
  touch.acc += px / (screen.clientHeight / term.rows);
  const n = Math.trunc(touch.acc);
  if (!n) return;
  touch.acc -= n;
  if (term.buffer.active.type === 'normal') return term.scrollLines(-n);
  for (let i = 0; i < Math.abs(n); i++) {
    term.element.dispatchEvent(new WheelEvent('wheel', {
      deltaY: n > 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: touch.x, clientY: touch.cy, bubbles: true, cancelable: true,
    }));
  }
}
const tbox = $('term-box');
tbox.addEventListener('touchstart', (e) => {
  touch = null;
  if (!term || e.touches.length !== 1) return;
  const p = e.touches[0];
  // stop：这次触摸是为了按停惯性滚动，不当作轻点
  touch = { x: p.clientX, y0: p.clientY, cy: p.clientY, t: e.timeStamp, v: 0, acc: 0, moving: false, stop: performance.now() - coastAt < 100 };
}, { passive: true });
tbox.addEventListener('touchmove', (e) => {
  if (!touch || !term || e.touches.length !== 1) return;
  const p = e.touches[0];
  if (!touch.moving && Math.abs(p.clientY - touch.y0) < 8) return;
  touch.moving = true;
  e.preventDefault();
  const dy = p.clientY - touch.cy;
  const dt = e.timeStamp - touch.t;
  if (dt > 0) touch.v = 0.8 * (dy / dt) + 0.2 * touch.v; // px/ms，平滑
  touch.cy = p.clientY;
  touch.t = e.timeStamp;
  touchScroll(dy);
}, { passive: false });
tbox.addEventListener('touchend', (e) => {
  const s = touch;
  // 轻点选项行：不让后续的兼容鼠标事件聚焦终端（避免弹出键盘遮挡）
  if (s && !s.moving && !s.stop && term && tapOption(e.changedTouches[0])) return e.preventDefault();
  // 惯性只用于滚动历史；停顿后再松手（> 80ms 无移动）不甩出去
  if (!s || !s.moving || !term || term.buffer.active.type !== 'normal' || e.timeStamp - s.t > 80) return;
  let v = s.v;
  let last = performance.now();
  const step = (now) => {
    if (touch !== s || !term) return; // 新的触摸或终端已关闭即停止
    v *= Math.pow(0.95, (now - last) / 16);
    if (Math.abs(v) < 0.05) return;
    touchScroll(v * (now - last));
    last = coastAt = now;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});
tbox.addEventListener('touchcancel', () => (touch = null));

// 触屏轻点 Claude Code 等程序弹出的编号选项（❯ 1. Yes / 2. … / 3. No）：从当前选中项用 ↑ / ↓ 移到被点项再发回车，
// 不依赖数字键直接选择；点在其他位置保持原行为（聚焦、弹键盘）。桌面鼠标点击不处理
let coastAt = 0; // 惯性滚动最近一帧的时间
const OPT_RE = /^\s*([❯>]\s*)?(\d+)\.\s+(?=\S)/;
/** 视口内最靠下的一组编号选项 [{n, sel, start, end}]（buffer 绝对行号；折行或缩进到选项文字列的续行算该项）；编号从 1 连续、至少 2 项、恰一项带选中标记，否则 null */
function findOptions() {
  const b = term.buffer.active;
  let best = null;
  let run = null;
  for (let y = b.viewportY; y < b.viewportY + term.rows; y++) {
    const line = b.getLine(y);
    if (!line) break;
    const text = line.translateToString(true);
    const cur = run && run[run.length - 1];
    const m = line.isWrapped ? null : OPT_RE.exec(text);
    if (m) {
      const it = { n: Number(m[2]), sel: !!m[1], start: y, end: y, col: m[0].length };
      if (cur && it.n === cur.n + 1) run.push(it);
      else run = it.n === 1 ? [it] : null;
    } else if (cur && (line.isWrapped || (text.trim() && text.length - text.trimStart().length >= cur.col))) {
      cur.end = y;
      continue;
    } else run = null;
    if (run && run.length >= 2 && run.filter((o) => o.sel).length === 1) best = run;
  }
  return best && best.filter((o) => o.sel).length === 1 ? best : null;
}
/** 轻点落在选项行上则发送选择并返回 true */
function tapOption(p) {
  const b = term.buffer.active;
  // 滚离底部时视口里可能是历史中的旧列表；接管未生效时不处理
  if (!p || b.viewportY !== b.baseY || $('keys').classList.contains('dis')) return false;
  const rect = term.element.querySelector('.xterm-screen').getBoundingClientRect();
  const h = rect.height / term.rows;
  const row = Math.floor((p.clientY - rect.top) / h);
  if (p.clientX < rect.left || p.clientX > rect.right || row < 0 || row >= term.rows) return false;
  const opts = findOptions();
  const y = b.viewportY + row;
  const target = opts && opts.find((o) => y >= o.start && y <= o.end);
  if (!target) return false;
  const d = target.n - opts.find((o) => o.sel).n;
  setCtrl(false);
  term.input(arrow(d > 0 ? 'down' : 'up').repeat(Math.abs(d)) + '\r', true);
  // 短暂高亮被点的选项（叠加层，不改终端内容）
  const wrap = $('term-wrap').getBoundingClientRect();
  const hit = document.createElement('div');
  hit.className = 't-hit';
  hit.style.cssText = `left:${rect.left - wrap.left}px;width:${rect.width}px;top:${rect.top - wrap.top + (target.start - b.viewportY) * h}px;height:${(target.end - target.start + 1) * h}px`;
  $('term-wrap').appendChild(hit);
  setTimeout(() => hit.remove(), 500);
  return true;
}
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
  const desc = (a) => esc(a.event === 'image' ? `${a.mime || ''} · ${Math.max(1, Math.round((a.bytes || 0) / 1024))} KB`
    : a.to ? `${a.from} → ${a.to}${a.reason ? `：${a.reason}` : ''}`
    : a.tokenName ? `${EV[a.event] ? EV[a.event][2] : ''}「${a.tokenName}」`
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
      <span class="bd">${late ? '请到服务器上检查 hub 是否在运行：安装版查看服务 tether-hub 及 %ProgramData%\\tether-hub\\logs；源码部署需配置 systemd / pm2 / NSSM 等进程管理器。' : 'hub 恢复后页面将自动刷新，需重新登录。'}</span></div></div>` : ''}
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

// ---- 机器 token：明文只在签发后显示一次，关闭面板即丢弃 ----

let tokRows = null;
/** 刚签发的 {name, token} */
let tokNew = null;
/** 正在二次确认吊销的 token 名称 */
let tokAsk = null;

/** 调用 token 接口，返回 [状态码, 响应体]；登录失效时回到登录页，无返回值 */
async function tokApi(url, body) {
  try {
    const r = await fetch(url, body === undefined ? undefined
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) return showLogin('登录已失效，请重新登录');
    return [r.status, await r.json().catch(() => ({}))];
  } catch {
    return [0, { error: '无法连接服务器' }];
  }
}

async function loadTokens() {
  const res = await tokApi('/api/tokens');
  if (!res) return;
  if (res[0] === 200) tokRows = res[1];
  else $('tok-err').textContent = res[1].error || `加载失败（${res[0]}）`;
  renderTokens();
}

function renderTokens() {
  $('tok-new').innerHTML = tokNew ? `<div class="banner def">${ic('info')}<div>
      <span class="bt">已签发「${esc(tokNew.name)}」</span> <span class="bd">明文只显示这一次，关闭面板后无法再次查看，请立即复制到 Tether 客户端。</span>
      <div class="tok-copy"><input class="input mono" id="tok-plain" readonly value="${esc(tokNew.token)}" aria-label="token 明文"><button class="btn btn-sm btn-primary" data-tok-copy>复制</button></div>
      <div class="tok-tip" id="tok-tip"></div></div></div>` : '';
  const acts = (t) => (t.revoked ? '' : tokAsk === t.name
    ? `<div class="tok-acts"><button class="btn btn-sm" data-tok-cancel>取消</button><button class="btn btn-sm btn-primary" data-tok-revoke="${esc(t.name)}">确认吊销</button></div>`
    : `<div class="tok-acts"><button class="btn btn-sm" data-tok-ask="${esc(t.name)}">吊销</button></div>`);
  $('tok-list').innerHTML = (tokRows || []).map((t) => `<div class="tok-row${t.revoked ? ' off' : ''}">
      <div class="tok-main"><div class="tok-r1"><span class="mono tok-n">${esc(t.name)}</span>${t.revoked ? '<span class="tag">已吊销</span>' : '<span class="tag t-pri"><i class="dot ok"></i>有效</span>'}</div>
      <div class="tok-r2"><span title="${esc(fullTime(t.createdAt))}">创建于 ${shortTime(t.createdAt)}</span><span>${t.machines.length ? `机器：${esc(t.machines.join('、'))}` : '暂无机器使用'}</span></div>
      ${tokAsk === t.name ? '<div class="tok-ask">吊销后，使用它的机器约 1 秒内断开，且无法恢复。</div>' : ''}</div>
      ${acts(t)}</div>`).join('') || `<div class="empty">${tokRows ? '还没有 token，在上方输入名称签发' : '加载中…'}</div>`;
}

async function revokeTok(name) {
  const res = await tokApi(`/api/tokens/${encodeURIComponent(name)}/revoke`, {});
  if (!res) return;
  tokAsk = null;
  if (res[0] !== 200) $('tok-err').textContent = res[1].error || `吊销失败（${res[0]}）`;
  loadTokens();
}

/** 明文 http（非 localhost）下没有 clipboard API：退回选中文本 + execCommand，仍失败则提示手动复制 */
async function copyTok() {
  const box = $('tok-plain');
  let ok = false;
  try {
    await navigator.clipboard.writeText(box.value);
    ok = true;
  } catch {
    box.focus();
    box.setSelectionRange(0, box.value.length);
    try { ok = document.execCommand('copy'); } catch {}
  }
  $('tok-tip').textContent = ok ? '已复制到剪贴板' : '无法自动复制，已选中文本，请手动复制（Ctrl+C / 长按）';
}

function closeTok() {
  $('tok').hidden = true;
  tokNew = null;
  tokAsk = null;
  $('tok-err').textContent = '';
}
$('tok-btn').addEventListener('click', () => {
  $('tok').hidden = false;
  $('tok-err').textContent = '';
  renderTokens();
  loadTokens();
  if (!isM()) $('tok-name').focus();
});
$('tok-close').addEventListener('click', closeTok);
$('tok-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('tok-err').textContent = '';
  const res = await tokApi('/api/tokens', { name: $('tok-name').value.trim() });
  if (!res) return;
  if (res[0] !== 201) return ($('tok-err').textContent = res[1].error || `签发失败（${res[0]}）`);
  tokNew = res[1];
  tokAsk = null;
  $('tok-name').value = '';
  loadTokens();
});
$('tok').addEventListener('click', (e) => {
  if (e.target === $('tok')) return closeTok();
  if (e.target.id === 'tok-plain') return e.target.setSelectionRange(0, e.target.value.length);
  if (e.target.closest('[data-tok-copy]')) return copyTok();
  const ask = e.target.closest('[data-tok-ask]');
  if (ask || e.target.closest('[data-tok-cancel]')) {
    tokAsk = ask ? ask.dataset.tokAsk : null;
    return renderTokens();
  }
  const rv = e.target.closest('[data-tok-revoke]');
  if (rv) {
    rv.disabled = true;
    revokeTok(rv.dataset.tokRevoke);
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('tok').hidden && closeTok());

// ---- 事件绑定 ----

$('m-search').addEventListener('input', renderMachines);
document.addEventListener('click', (e) => {
  const take = e.target.closest('[data-take]');
  if (take) return openTerm(take.dataset.take, Number(take.dataset.sid));
  const cl = e.target.closest('[data-close]');
  if (cl) {
    closeAsk = `${cl.dataset.m}/${cl.dataset.sid}`;
    closeErr = null;
    return renderDetail();
  }
  if (e.target.closest('[data-close-cancel]')) {
    closeAsk = null;
    return renderDetail();
  }
  const ok = e.target.closest('[data-close-ok]');
  if (ok) return closeSession(ok.dataset.m, Number(ok.dataset.sid));
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
