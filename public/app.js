// Tether Hub Web 界面：登录、SSE 实时接收机器 / 会话状态并按主从布局渲染；远程接管终端（xterm.js，含回看历史、粘贴与贴图）；审计日志。
// 版本与更新：顶栏版本按钮 / 新版本胶囊 + 更新面板（检查、一键更新、进度日志、重启后自动刷新）。
// 机器 token：顶栏「Token」面板（列表、签发并一次性显示明文、页内二次确认吊销）。
// 网页新建会话：机器详情会话卡片头「新建会话」对话框（本地 / SSH、最近目录、恢复 Claude 对话），建好后直接接管。
// 页面：#main 机器与会话（手机上为机器列表）、#detail 机器详情（仅手机两级页面用）、#term 接管终端、#audit 审计日志。
// 界面文字一律经 t() 取词条（locales.js / i18n.js）；API 错误按错误码翻译（apiError），切换语言即时重绘（relocalize）。
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
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
};
const ic = (n, c = '') => `<svg class="ic ${c}" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;
document.querySelectorAll('[data-i]').forEach((e) => (e.outerHTML = ic(e.dataset.i)));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** 审计事件码 → 标签样式；名称与无 reason 时的说明为词条 ev.<码> / evd.<码>，reason 码的说明为 reason.<码> */
const EV = {
  update_start: 't-pri', update_done: 't-pri', update_failed: 't-err', token_create: 't-pri', token_revoke: 't-warn',
  start: 't-pri', end: '', denied: 't-err', reclaimed: 't-warn', disabled: 't-warn', exited: '', disconnected: '',
  image: 't-pri', image_failed: 't-err', close: 't-warn', close_failed: 't-err', create: 't-pri', create_failed: 't-err',
};
const isEv = (e) => Object.prototype.hasOwnProperty.call(EV, e);

// ---- 语言：localStorage tether.hub.locale（auto / 语言代码），auto 按浏览器语言列表解析 ----

function savedLocale() {
  try { return localStorage.getItem(LOCALE_KEY) || 'auto'; } catch { return 'auto'; }
}
function applyLocale() {
  const pref = savedLocale();
  LOCALE = resolveLocale(pref, navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]);
  document.documentElement.lang = LOCALE;
  translateDom(document);
  const opts = `<option value="auto">${esc(t('lang.auto'))}</option>${LOCALES.map((l) => `<option value="${l}">${esc(LOCALE_NAMES[l])}</option>`).join('')}`;
  document.querySelectorAll('.lang-sel').forEach((e) => {
    e.innerHTML = opts;
    e.value = LOCALES.includes(pref) ? pref : 'auto';
  });
  document.querySelectorAll('.lang-lbl').forEach((e) => (e.textContent = LOCALE_NAMES[LOCALE]));
}
applyLocale();
document.addEventListener('change', (e) => {
  if (!e.target.classList.contains('lang-sel')) return;
  try { localStorage.setItem(LOCALE_KEY, e.target.value); } catch {}
  relocalize();
});
window.addEventListener('languagechange', () => savedLocale() === 'auto' && relocalize());

/**
 * API 错误 → 当前语言文字。服务端回 {error, code?, params?, reason?, detail?}：
 * daemon 拒绝（带 reason）时按 rej.<code>.<reason> 取说明，未知 reason 才显示 daemon 附带的 detail；
 * 其余按 err.<code> 翻译；没有可用的码时退回服务端原文 error，再退回 fallback 词条（带状态码）。
 */
function apiError(body, status, fallback) {
  const b = body || {};
  if (b.code && b.reason !== undefined) {
    const rk = `rej.${b.code}.${b.reason}`;
    if (hasMsg(rk)) return b.reason === 'error' && b.detail ? t('common.detail', { text: t(rk), detail: b.detail }) : t(rk);
    if (b.detail) return b.detail;
  }
  if (b.code && hasMsg(`err.${b.code}`)) return t(`err.${b.code}`, { ...b.params, reason: b.reason, status });
  return b.error || t(fallback, { status });
}

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
  if (s < 60) return t('time.just_now');
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'always' });
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
  return shortTime(ms);
}
function shortTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(LOCALE, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
const fullTime = (ms) => (ms ? new Date(ms).toLocaleString(LOCALE, { hour12: false }) : '');

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

let sseKind = '';
function setSse(kind) {
  if (!kind) return;
  sseKind = kind;
  const [cls, key] = { ok: ['ok', 'sse.ok'], retry: ['warn', 'sse.retry'], err: ['err', 'sse.err'] }[kind];
  const text = t(key);
  $('sse').innerHTML = `<i class="dot ${cls}"></i><span class="lbl">${esc(text)}</span>`;
  $('sse').title = t('sse.title', { text });
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
      if (r.status === 401) return showLogin(t('common.session_expired'));
    } catch {}
    retryTimer = setTimeout(startEvents, 3000);
  };
}

// ---- 机器与会话 ----

const isWaiting = (s) => s.claude && s.claude.state === 'waiting';
const machines = () => (state ? state.machines : []);
const selected = () => machines().find((m) => m.machineId === selId);
const mName = (m) => m.name || m.machineId;
const sName = (s) => s.name || t('common.session_n', { id: s.id });
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
      <span><b>${esc(t('alert.sessions', { n: list.length }))}</b><span class="only-d">${esc(t('alert.claude_waiting'))}</span><span class="only-m">${esc(t('alert.waiting'))}</span></span>
      <span class="ac-chips">${list.map(([m, s]) => `<button class="chip" data-pick="${esc(m.machineId)}" title="${esc(s.claude.message || '')}">${esc(mName(m))} · ${esc(sName(s))}</button>`).join('')}</span>
      <span class="ac-more">${ic('chevR')}</span></div>
    <div class="ac-list">${list.map(([m, s]) => `<button class="ac-item" data-pick="${esc(m.machineId)}"><b>${esc(sName(s))}</b><span class="muted">${esc(mName(m))}</span>${ic('chevR')}</button>`).join('')}</div>`;
}

function renderMachines() {
  const all = machines();
  const kw = $('m-search').value.trim().toLowerCase();
  $('m-stat').textContent = state ? t('machines.stat', { online: all.filter((m) => m.online).length, total: all.length }) : '';
  const rows = all.filter((m) => !kw || `${m.name} ${m.machineId} ${m.tokenName}`.toLowerCase().includes(kw));
  $('m-list').innerHTML = rows.map((m) => {
    const n = m.sessions.filter(isWaiting).length;
    return `<div class="mitem${m.machineId === selId ? ' sel' : ''}${m.online ? '' : ' off'}" data-pick="${esc(m.machineId)}">
      <i class="dot${m.online ? ' ok' : ''}"></i>
      <div class="mm"><div class="mname"><span class="n">${esc(mName(m))}</span><span class="v">v${esc(m.version || '?')}</span></div>
      <div class="msub" title="${esc(fullTime(m.lastSeen))}">${esc(m.online ? t('machines.online_sessions', { n: live(m) }) : t('machines.offline_since', { ago: ago(m.lastSeen) }))}</div></div>
      ${n ? `<span class="cnt" title="${esc(t('machines.waiting_title', { n }))}">${n}</span>` : ''}
      <span class="chev only-m">${ic('chevR')}</span></div>`;
  }).join('') || `<div class="empty">${!state ? esc(t('common.loading')) : all.length ? esc(t('machines.no_match'))
    : t('machines.empty').split('\n').map(esc).join('<br>')}</div>`;
}

function claudeTag(c) {
  if (!c) return '<span class="muted">—</span>';
  switch (c.state) {
    case 'waiting': return `<span class="tag t-warn">${ic('alert', 'ic-sm')}${esc(t('claude.waiting'))}</span>`;
    case 'thinking': return `<span class="tag"><i class="dot info"></i>${esc(t('claude.thinking'))}</span>`;
    case 'background': return `<span class="tag"><i class="dot pur"></i>${esc(t('claude.background'))}${c.count ? ` ×${c.count}` : ''}</span>`;
    case 'done': return `<span class="tag">${esc(t('claude.done'))}</span>`;
    case 'idle': return `<span class="tag">${esc(t('claude.idle'))}</span>`;
    default: return `<span class="tag">${esc(c.state)}</span>`;
  }
}
const stCell = (st) => ({
  running: () => `<span class="st"><i class="dot ok"></i>${esc(t('status.running'))}</span>`,
  waiting: () => `<span class="st" title="${esc(t('status.waiting_title'))}"><i class="dot"></i>${esc(t('status.waiting'))}</span>`,
  exited: () => `<span class="st muted"><i class="dot"></i>${esc(t('status.exited'))}</span>`,
}[st] || (() => `<span class="st">${esc(st)}</span>`))();

function takeBtn(m, s) {
  const take = esc(t('act.take'));
  if (s.status === 'exited') return `<button class="btn btn-sm" disabled title="${esc(t('act.session_exited'))}">${take}</button>`;
  if (!m.online) return `<button class="btn btn-sm" disabled title="${esc(t('act.machine_offline'))}">${take}</button>`;
  return `<button class="btn btn-sm${isWaiting(s) ? ' btn-primary' : ''}" data-take="${esc(m.machineId)}" data-sid="${s.id}">${take}</button>`;
}

/** 运行中会话的「关闭」：页内二次确认；机器离线或 Tether 不支持时置灰并说明原因 */
function closeBtn(m, s) {
  if (s.status === 'exited') return '';
  const key = `${m.machineId}/${s.id}`;
  const err = closeErr && closeErr.key === key ? `<div class="cl-err">${esc(closeErr.text)}</div>` : '';
  const why = !m.online ? t('act.machine_offline') : !(m.caps || []).includes('close') ? t('act.close_needs') : '';
  const close = esc(t('common.close'));
  if (why) return `<button class="btn btn-sm" disabled title="${esc(why)}">${close}</button>`;
  if (closeBusy === key) return `<button class="btn btn-sm" disabled>${esc(t('act.closing'))}</button>`;
  const attrs = `data-m="${esc(m.machineId)}" data-sid="${s.id}"`;
  if (closeAsk === key) {
    return `<span class="cl-ask"><span class="cl-q">${esc(t('act.close_ask'))}</span><button class="btn btn-sm" data-close-cancel>${esc(t('common.cancel'))}</button><button class="btn btn-sm btn-primary" data-close-ok ${attrs}>${esc(t('act.close_ok'))}</button></span>${err}`;
  }
  return `<button class="btn btn-sm" data-close ${attrs} title="${esc(t('act.close_title'))}">${close}</button>${err}`;
}

/** 会话卡片头的「新建会话」：机器离线或 Tether 不支持时置灰并说明原因 */
function newBtn(m) {
  const why = !m.online ? t('act.machine_offline') : !(m.caps || []).includes('create') ? t('act.new_needs') : '';
  if (why) return `<button class="btn btn-sm" disabled title="${esc(why)}">${esc(t('act.new'))}</button>`;
  return `<button class="btn btn-sm btn-primary" data-new="${esc(m.machineId)}" title="${esc(t('act.new_title'))}">${esc(t('act.new'))}</button>`;
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
    if (r.status === 401) return showLogin(t('common.session_expired'));
    if (!r.ok) text = apiError(await r.json().catch(() => ({})), r.status, 'act.close_failed');
  } catch {
    text = t('common.no_server');
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
    $('detail').innerHTML = state ? `<div class="empty">${esc(t('detail.pick'))}</div>` : '';
    return;
  }
  const n = m.sessions.filter(isWaiting).length;
  const ss = m.sessions;
  const rowCls = (s) => `${isWaiting(s) ? 'need' : ''}${s.status === 'exited' ? ' exited' : ''}`;
  const msg = (s) => (isWaiting(s) && s.claude.message ? `<div class="smsg">${esc(s.claude.message)}</div>` : '');
  const tip = (s) => esc(`${s.host ? `${t('detail.tip_host', { host: s.host })}\n` : ''}${t('detail.tip_cwd', { cwd: s.cwd || '' })}\n${t('detail.tip_cmd', { cmd: s.command || '' })}`);
  const seen = m.online ? t('detail.online_since', { ago: ago(m.lastSeen) }) : ago(m.lastSeen);
  const onTag = (cls) => (m.online ? `<span class="${cls}"><i class="dot ok"></i>${esc(t('common.online'))}</span>` : `<span class="${cls}"><i class="dot"></i>${esc(t('common.offline'))}</span>`);
  $('detail').innerHTML = `${notice ? `<div class="banner def notice">${ic('info')}<div><span class="bt">${esc(notice)}</span></div></div>` : ''}
    <div class="dhead">
      <button class="back" data-back aria-label="${esc(t('detail.back'))}">${ic('chevL')}</button>
      <h2>${esc(mName(m))}</h2>
      ${onTag(m.online ? 'tag t-pri' : 'tag')}
      ${n ? `<span class="tag t-warn">${ic('alert', 'ic-sm')}${esc(t('detail.waiting_n', { n }))}</span>` : ''}
      <span class="right only-d" title="${esc(fullTime(m.lastSeen))}">${esc(m.online ? seen : t('detail.last_seen', { ago: seen }))}</span>
    </div>
    <div class="card"><div class="card-head"><h3>${esc(t('detail.info'))}</h3></div><div class="card-body">
      <div class="desc">
        <div class="di"><div class="dl">${esc(t('detail.name'))}</div><div class="dv" title="${esc(m.machineId)}">${esc(mName(m))}</div></div>
        <div class="di"><div class="dl">${esc(t('detail.conn'))}</div><div class="dv">${onTag('st')}</div></div>
        <div class="di"><div class="dl">${esc(t('detail.version'))}</div><div class="dv">${esc(m.version || '?')}</div></div>
        <div class="di"><div class="dl">${esc(t(m.online ? 'detail.this_online' : 'detail.last_online'))}</div><div class="dv" title="${esc(fullTime(m.lastSeen))}">${esc(ago(m.lastSeen))}</div></div>
        <div class="di"><div class="dl">${esc(t('detail.token'))}</div><div class="dv mono">${esc(m.tokenName)}</div></div>
        <div class="di"><div class="dl">${esc(t('detail.sessions'))}</div><div class="dv">${esc(t('detail.sessions_val', { live: live(m), total: ss.length }))}</div></div>
      </div></div></div>
    <div class="card"><div class="card-head"><h3>${esc(t('detail.sessions'))}</h3><div class="extra">${esc(t(m.online ? 'detail.live_updates' : 'detail.offline_hint'))}${newBtn(m)}</div></div>
      ${ss.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>${esc(t('detail.th_name'))}</th><th>${esc(t('detail.th_cwd'))}</th><th>${esc(t('detail.th_status'))}</th><th>Claude</th><th>${esc(t('detail.th_host'))}</th><th>${esc(t('detail.th_time'))}</th><th class="r">${esc(t('detail.th_actions'))}</th></tr></thead><tbody>
        ${ss.map((s) => `<tr class="${rowCls(s)}">
          <td><div class="sname">${esc(sName(s))}</div><div class="scmd">${esc(s.command)}</div>${msg(s)}</td>
          <td><div class="cwd" title="${tip(s)}">${esc(s.cwd)}</div></td>
          <td>${stCell(s.status)}</td><td>${claudeTag(s.claude)}</td>
          <td class="mono scmd">${s.host ? esc(s.host) : '<span class="muted">—</span>'}</td>
          <td class="tm" title="${esc(t('detail.last_activity', { time: fullTime(s.lastActivityAt) }))}"><div>${esc(shortTime(s.startedAt))}</div><div>${esc(ago(s.lastActivityAt))}</div></td>
          <td class="r"><div class="acts">${takeBtn(m, s)}${closeBtn(m, s)}</div></td></tr>`).join('')}
        </tbody></table></div>
      <div class="scards">${ss.map((s) => `<div class="scard ${rowCls(s)}">
        <div class="sc"><div class="r1"><span class="sname">${esc(sName(s))}</span>${s.claude ? claudeTag(s.claude) : ''}</div>
        <div class="r2">${esc(s.cwd)} › ${esc(s.command)}</div>${msg(s)}
        <div class="r3">${stCell(s.status)}<span>${esc(ago(s.lastActivityAt))}</span>${s.host ? `<span class="mono">${esc(s.host)}</span>` : ''}</div></div>
        <div class="acts">${takeBtn(m, s)}${closeBtn(m, s)}</div></div>`).join('')}</div>`
      : `<div class="empty">${esc(t(m.online ? 'detail.no_sessions' : 'detail.offline_no_sessions'))}</div>`}
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
/** 结束原因：样式、可否重新接管；标签 / 横幅标题 / 说明为词条 end.<原因>.tag / title / desc */
const END = {
  reclaimed: ['warn', true], disabled: ['err'], denied: ['err'], exited: ['def'],
  offline: ['err', true], not_found: ['err'], probe: ['err'], closed: ['err', true],
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

/** 当前终端状态，切换语言时据此重绘 */
let termKind = '';
let termReason = '';
function setTermState(kind, reason) {
  termKind = kind;
  termReason = reason;
  const ended = kind === 'ended';
  $('term-wrap').classList.toggle('ro', ended);
  $('keys').classList.toggle('dis', kind !== 'active');
  syncImgBtn();
  $('t-banner').innerHTML = '';
  if (kind === 'connecting') {
    $('t-tag').innerHTML = `<span class="tag"><i class="dot info"></i>${esc(t('term.connecting'))}</span>`;
    $('t-foot').innerHTML = '';
  } else if (kind === 'active') {
    $('t-tag').innerHTML = `<span class="tag t-pri"><i class="dot ok"></i>${esc(t('term.active'))}</span>`;
    $('t-foot').innerHTML = `<span>${esc(t('term.foot_input'))}</span><span id="t-size">${term.cols} × ${term.rows}</span><span class="end">${esc(t('term.foot_reclaim'))}</span>`;
  } else {
    const known = END[reason];
    const [cls, retry] = known || ['err'];
    const tag = known ? t(`end.${reason}.tag`) : t('term.ended_tag', { reason });
    const title = known ? t(`end.${reason}.title`) : t('term.ended_title');
    const desc = known ? t(`end.${reason}.desc`) : t('term.ended_desc', { reason });
    $('t-tag').innerHTML = `<span class="tag ${cls === 'def' ? '' : `t-${cls}`}">${esc(tag)}</span>`;
    $('t-banner').innerHTML = `<div class="banner ${cls}">${ic(cls === 'def' ? 'info' : cls === 'err' ? 'alertC' : 'alert')}
      <div><span class="bt">${esc(title)}</span> <span class="bd">${esc(desc)}</span></div>
      ${retry ? `<div class="act"><button class="btn btn-sm btn-primary" data-retake>${esc(t('term.retake'))}</button></div>` : ''}</div>`;
    $('t-foot').innerHTML = `<span>${esc(t('term.readonly'))}</span>`;
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

  const xt = (term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace', fontSize: isM() ? 12 : 14,
    cursorBlink: true, scrollback: 10000, theme: termTheme(),
  }));
  const fit = new FitAddon.FitAddon();
  xt.loadAddon(fit);
  xt.open($('term-box'));
  fit.fit();
  // Ctrl+C 有选区时复制、Ctrl+V 粘贴：交给浏览器默认行为，由 xterm 的 copy / paste 事件处理（多行粘贴、括号粘贴模式）
  xt.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.shiftKey
    && ((e.key === 'c' && xt.hasSelection()) || e.key === 'v')));

  const ws = (termWs = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/term?machine=${encodeURIComponent(ref.machineId)}&session=${ref.sessionId}`));
  let ready = false;
  let ended = false;
  let sizing = false;
  const send = (msg) => ready && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  // xterm 对终端查询的自动应答（光标位置、设备属性、模式、颜色、DCS）不转发：
  // 本地 GUI 或 daemon 已负责应答，多个查看者都回复会在 PTY 中出现重复应答乱码
  xt.onData((d) => {
    // 粘滞 Ctrl 只作用于下一个可打印字符（方向键、Esc 等以控制字符开头，不受影响）
    if (ctrlOn && d.charCodeAt(0) >= 0x20 && d.charCodeAt(0) !== 0x7f) {
      d = ctrlChar(d[0]) + d.slice(1);
      setCtrl(false);
    }
    if (!QUERY_REPLY.test(d)) send({ type: 'input', data: toB64(utf8.encode(d)) });
  });
  xt.onBinary((d) => send({ type: 'input', data: btoa(d) }));
  // 滚离底部时显示「回到底部」；上翻期间有新输出 xterm 不会跳回，回到底部后恢复跟随
  const syncBottom = () => { const b = xt.buffer.active; $('t-bottom').hidden = b.viewportY >= b.baseY; };
  xt.onScroll(syncBottom);
  xt.buffer.onBufferChange(syncBottom);
  xt.onResize(({ cols, rows }) => {
    send({ type: 'resize', cols, rows });
    if ($('t-size')) $('t-size').textContent = `${cols} × ${rows}`;
  });
  // 容器尺寸变化（窗口缩放、软键盘弹出、横幅出现）即重新适配；写入快照期间保持快照尺寸
  termRo = new ResizeObserver(() => sizing || fit.fit());
  termRo.observe($('term-box'));

  const end = (reason) => {
    ended = true;
    ready = false;
    xt.options.disableStdin = true;
    setTermState('ended', reason);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') {
      // 先按快照尺寸写入避免错行，再适配窗口并把新尺寸发给 daemon；
      // history（Tether 0.5.0+）先写入：历史行 + rows 个换行把它们推进 scrollback，备用屏时末尾为 ?1049h，快照随后写入当前屏
      sizing = true;
      xt.reset();
      if (msg.cols > 0 && msg.rows > 0) xt.resize(msg.cols, msg.rows);
      if (msg.history) xt.write(fromB64(msg.history));
      xt.write(fromB64(msg.data), () => {
        sizing = false;
        ready = true;
        fit.fit();
        syncBottom();
        if ($('t-size')) $('t-size').textContent = `${xt.cols} × ${xt.rows}`;
      });
      setTermState('active');
      xt.focus();
    } else if (msg.type === 'output') {
      xt.write(fromB64(msg.data));
    } else if (msg.type === 'detached' && msg.reason === 'session_closed') {
      // 会话被网页关闭（随后从会话列表消失）：关闭终端页，回到机器页提示
      ended = true;
      showNotice(t('detail.closed_notice', { name: ref.name }));
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
  closeTv();
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
// 上传前由 img.js 的 prepareImage 缩放 / 重编码；IMG_TYPES、MAX_IMG 也在 img.js
let imgBusy = false;
let toastTimer = 0;

/** 当前接管的会话不能贴图的原因；可以时返回空串 */
function imgBlock() {
  const m = termRef && machines().find((x) => x.machineId === termRef.machineId);
  const s = m && m.sessions.find((x) => x.id === termRef.sessionId);
  if (!m || !m.online) return t('act.machine_offline');
  if (!(m.caps || []).includes('image')) return t('img.needs');
  if (s && s.host) return t('img.ssh');
  return '';
}
function syncImgBtn() {
  const b = $('keys').querySelector('[data-key="image"]');
  const why = imgBlock();
  b.classList.toggle('off', !!why);
  b.title = why || t('img.btn_title');
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

/** 上传一张图片；成功返回 true */
async function sendImage(file) {
  const why = imgBlock();
  if (why) return toast(why, 'err', 4000);
  if (imgBusy) return toast(t('img.busy'), 'err', 3000);
  const ref = termRef;
  imgBusy = true;
  toast(t('img.processing'));
  let blob;
  try {
    blob = await prepareImage(file);
  } catch (e) {
    imgBusy = false;
    return toast(e.code ? t(`img.${e.code}`) : e.message, 'err', 4000);
  }
  if (blob.size > MAX_IMG) {
    imgBusy = false;
    return toast(t('img.too_large'), 'err', 4000);
  }
  toast(t('img.uploading', { kb: Math.ceil(blob.size / 1024) }));
  let ok = false;
  let msg;
  try {
    const r = await fetch(`/api/term/image?machine=${encodeURIComponent(ref.machineId)}&session=${ref.sessionId}`, {
      method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
    });
    if (r.status === 401) {
      imgBusy = false;
      return showLogin(t('common.session_expired'));
    }
    const body = await r.json().catch(() => ({}));
    ok = r.ok;
    msg = ok ? t('img.inserted') : apiError(body, r.status, 'img.upload_failed');
  } catch {
    msg = t('img.upload_no_server');
  }
  imgBusy = false;
  if (termRef === ref) toast(msg, ok ? 'ok' : 'err', ok ? 2500 : 5000);
  return ok;
}

/** 粘贴事件中只有图片（没有文本）时返回该图片文件 */
function pastedImage(e) {
  const items = [...(e.clipboardData ? e.clipboardData.items : [])];
  const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  return img && !items.some((i) => i.type === 'text/plain') ? img.getAsFile() : null;
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
        return toast(t('img.clipboard_empty'), '', 2500);
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
// 弹层里长按粘贴图片（手机上读不到剪贴板时的贴图入口）
$('paste-text').addEventListener('paste', (e) => {
  const img = pastedImage(e);
  if (!term || !img) return;
  e.preventDefault();
  closePaste();
  setCtrl(false);
  sendImage(img);
});
// 可多选：逐张串行上传，失败或切换了会话即停止
$('img-file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const ref = termRef;
  for (const f of files) if (termRef !== ref || !(await sendImage(f))) break;
});
// 桌面 Ctrl+V 贴截图：捕获阶段先于 xterm 拦下只含图片的剪贴板；带文本的粘贴照常交给 xterm
$('term-box').addEventListener('paste', (e) => {
  const img = pastedImage(e);
  if (!term || !img) return;
  e.preventDefault();
  e.stopPropagation();
  sendImage(img);
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

// 文本视图（手机）：xterm 不支持触摸选区、内部滚动也截不到长截图，故把缓冲区快照为纯文本（textview.js 的 bufferText）放进 <pre>，
// html 加 tv-on 后隐藏 #app 并解除 html/body 的固定高度，由文档本身滚动；打开后不随新输出刷新，离开终端（disposeTerm）时关闭
let tvTimer = 0;
function openTv() {
  if (!term) return;
  term.blur(); // 收起软键盘
  $('tv-pre').textContent = bufferText(term.buffer.active);
  $('tv-tip').textContent = '';
  document.documentElement.classList.add('tv-on');
  scrollTo(0, document.documentElement.scrollHeight); // 定位到最新输出
}
function closeTv() {
  if (!document.documentElement.classList.contains('tv-on')) return;
  clearTimeout(tvTimer);
  document.documentElement.classList.remove('tv-on');
  $('tv-pre').textContent = '';
  scrollTo(0, 0);
}
/** 复制全部：明文 http 下没有 clipboard API，退回选中全文 + execCommand，仍失败则保留选区提示手动复制 */
async function copyTv() {
  const pre = $('tv-pre');
  let ok = false;
  try {
    await navigator.clipboard.writeText(pre.textContent);
    ok = true;
  } catch {
    const r = document.createRange();
    r.selectNodeContents(pre);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    try { ok = document.execCommand('copy'); } catch {}
  }
  clearTimeout(tvTimer);
  $('tv-tip').textContent = ok ? t('common.copied') : t('tv.copy_failed');
  if (ok) tvTimer = setTimeout(() => ($('tv-tip').textContent = ''), 2500);
}
$('t-text').addEventListener('click', openTv);
$('tv-close').addEventListener('click', closeTv);
$('tv-copy').addEventListener('click', copyTv);
$('t-banner').addEventListener('click', (e) => e.target.closest('[data-retake]') && connectTerm());

// ---- 网页新建会话 ----

/** 对话框状态：机器、选项 {home, recent, hosts}、Claude 历史 {cwd, items, err}、选中的对话 id、请求阶段（'' / create / open） */
let nc = null;
const ncKind = () => document.querySelector('input[name="nc-kind"]:checked').value;
/** 恢复对话时实际使用的目录：留空 = 用户目录 */
const ncCwd = () => $('nc-cwd').value.trim() || (nc.opts && nc.opts.home) || '';

/** 返回 [状态码, JSON]；登录失效转登录页并返回 null；网络错误状态码为 0 */
async function ncFetch(url, init) {
  try {
    const r = await fetch(url, init);
    if (r.status === 401) {
      closeNc();
      showLogin(t('common.session_expired'));
      return null;
    }
    return [r.status, await r.json().catch(() => ({}))];
  } catch {
    return [0, { error: t('common.no_server') }];
  }
}

function openNc(machineId) {
  const m = machines().find((x) => x.machineId === machineId);
  if (!m) return;
  nc = { machineId, opts: null, hist: null, pick: null, busy: '' };
  $('nc-sub').textContent = t('nc.machine', { name: mName(m) });
  document.querySelector('input[name="nc-kind"][value="local"]').checked = true;
  $('nc-cwd').value = '';
  $('nc-resume').checked = false;
  $('nc-recent').innerHTML = `<option value="">${esc(t('nc.recent'))}</option>`;
  $('nc-host').innerHTML = '';
  $('nc-err').textContent = '';
  $('nc').hidden = false;
  renderNc();
  loadNcOpts();
}

function closeNc() {
  $('nc').hidden = true;
  nc = null;
}

async function loadNcOpts() {
  const cur = nc;
  const res = await ncFetch(`/api/create-options?machine=${encodeURIComponent(cur.machineId)}`);
  if (!res || nc !== cur) return;
  if (res[0] !== 200) $('nc-err').textContent = apiError(res[1], res[0], 'nc.opts_failed');
  cur.opts = res[0] === 200 ? res[1] : { home: '', recent: [], hosts: [] };
  fillNcOpts();
  ncChanged();
}

/** 最近目录与 SSH 主机下拉（切换语言时也重填，保留所选主机） */
function fillNcOpts() {
  const o = nc.opts;
  if (!o) return;
  const host = $('nc-host').value;
  $('nc-recent').innerHTML = `<option value="">${esc(t(o.recent.length ? 'nc.recent' : 'nc.no_recent'))}</option>`
    + o.recent.map((r, i) => `<option value="${i}">${esc(r.kind === 'remote' ? `${r.host || r.hostId}：${r.cwd}` : r.cwd)}</option>`).join('');
  $('nc-host').innerHTML = o.hosts.map((h) => `<option value="${esc(h.id)}">${esc(h.name || h.id)}</option>`).join('')
    || `<option value="">${esc(t('nc.no_hosts'))}</option>`;
  if (host && o.hosts.some((h) => h.id === host)) $('nc-host').value = host;
}

/** 类型 / 目录 / 勾选变化：恢复对话时按当前目录拉取历史 */
function ncChanged() {
  if (!nc) return;
  if (ncKind() === 'local' && $('nc-resume').checked && nc.opts) loadNcHist();
  renderNc();
}

async function loadNcHist() {
  const cwd = ncCwd();
  if (nc.hist && nc.hist.cwd === cwd && !nc.hist.err) return;
  const cur = nc;
  cur.hist = { cwd, items: null, err: '' };
  cur.pick = null;
  if (!cwd) {
    cur.hist.err = t('nc.need_dir');
    return;
  }
  const res = await ncFetch(`/api/claude-history?machine=${encodeURIComponent(cur.machineId)}&cwd=${encodeURIComponent(cwd)}`);
  if (!res || nc !== cur || cur.hist.cwd !== cwd) return;
  if (res[0] === 200) cur.hist.items = res[1].items || [];
  else cur.hist.err = apiError(res[1], res[0], 'nc.hist_failed');
  renderNc();
}

function renderNc() {
  if (!nc) return;
  const local = ncKind() === 'local';
  const o = nc.opts;
  $('nc-host-row').hidden = local;
  $('nc-resume-row').hidden = !local;
  $('nc-cwd').placeholder = !local ? t('nc.ph_remote') : !o ? t('common.loading') : o.home ? t('nc.ph_home', { home: o.home }) : t('nc.ph_home_plain');
  $('nc-ok').disabled = !!nc.busy;
  $('nc-ok').textContent = t(nc.busy === 'create' ? 'nc.creating' : nc.busy === 'open' ? 'nc.opening' : 'nc.create');
  const box = $('nc-hist');
  box.hidden = !local || !$('nc-resume').checked;
  if (box.hidden) return;
  const h = nc.hist;
  box.innerHTML = !h || (!h.items && !h.err) ? `<div class="empty">${esc(t('common.loading'))}</div>`
    : h.err ? `<div class="err-tip">${esc(h.err)}</div>`
    : !h.items.length ? `<div class="empty">${esc(t('nc.no_hist'))}<br><span class="mono">${esc(h.cwd)}</span></div>`
    : h.items.map((it) => `<button type="button" class="nc-item${nc.pick === it.id ? ' on' : ''}" data-hid="${esc(it.id)}">
        <span class="nc-t" title="${esc(it.title || it.id)}">${esc(it.title || it.id)}</span>
        <span class="nc-m"><span title="${esc(fullTime(it.mtime))}">${esc(ago(it.mtime))}</span>${typeof it.messages === 'number' ? `<span>${esc(t('nc.messages', { n: it.messages }))}</span>` : ''}${it.open ? `<span class="tag t-warn">${esc(t('nc.opened'))}</span>` : ''}</span></button>`).join('');
}

async function submitNc() {
  const cur = nc;
  if (!cur || cur.busy) return;
  const err = (t) => ($('nc-err').textContent = t);
  const local = ncKind() === 'local';
  const cwd = $('nc-cwd').value.trim();
  const target = local ? { kind: 'local' } : { kind: 'remote', hostId: $('nc-host').value };
  if (cwd) target.cwd = cwd;
  if (!local && !target.hostId) return err(t('nc.pick_host'));
  const body = { target };
  if (local && $('nc-resume').checked) {
    const it = cur.hist && cur.hist.cwd === ncCwd() && cur.hist.items && cur.hist.items.find((x) => x.id === cur.pick);
    if (!it) return err(t('nc.pick_hist'));
    body.resume = { id: it.id, bypass: !!it.bypass, ...(typeof it.permissionMode === 'string' ? { permissionMode: it.permissionMode } : {}) };
  }
  // 不带 cols / rows：daemon 按 120×32 建，接管后终端按网页实际尺寸 resize
  err('');
  cur.busy = 'create';
  renderNc();
  const res = await ncFetch(`/api/session/create?machine=${encodeURIComponent(cur.machineId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res || nc !== cur) return;
  if (res[0] !== 200) {
    cur.busy = '';
    err(apiError(res[1], res[0], 'nc.create_failed'));
    return renderNc();
  }
  // daemon 回复前已上报会话列表，等它经 SSE 到达后再接管
  const sid = res[1].sessionId;
  cur.busy = 'open';
  renderNc();
  const has = () => machines().some((m) => m.machineId === cur.machineId && m.sessions.some((s) => s.id === sid));
  for (const end = Date.now() + 10_000; !has() && Date.now() < end && nc === cur;) await new Promise((r) => setTimeout(r, 200));
  if (nc !== cur) return;
  if (!has()) {
    cur.busy = '';
    err(t('nc.not_listed', { id: sid }));
    return renderNc();
  }
  closeNc();
  openTerm(cur.machineId, sid);
}

$('nc-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitNc();
});
$('nc-close').addEventListener('click', closeNc);
$('nc-cancel').addEventListener('click', closeNc);
document.querySelectorAll('input[name="nc-kind"]').forEach((r) => r.addEventListener('change', () => {
  $('nc-err').textContent = '';
  ncChanged();
}));
$('nc-cwd').addEventListener('change', ncChanged);
$('nc-resume').addEventListener('change', ncChanged);
$('nc-recent').addEventListener('change', () => {
  const r = nc && nc.opts && nc.opts.recent[Number($('nc-recent').value)];
  $('nc-recent').value = '';
  if (!r) return;
  document.querySelector(`input[name="nc-kind"][value="${r.kind === 'remote' ? 'remote' : 'local'}"]`).checked = true;
  if (r.kind === 'remote') $('nc-host').value = r.hostId;
  $('nc-cwd').value = r.cwd;
  ncChanged();
});
$('nc').addEventListener('click', (e) => {
  if (e.target === $('nc')) return closeNc();
  const it = e.target.closest('[data-hid]');
  if (it && nc) {
    nc.pick = nc.pick === it.dataset.hid ? null : it.dataset.hid;
    $('nc-err').textContent = '';
    renderNc();
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('nc').hidden && closeNc());

// ---- 审计日志 ----

const PAGE = 20;
/** 更新事件没有机器字段，归为 hub */
const aMachine = (a) => a.machineName || a.machineId || 'hub';
let auditRows = [];
let auditPage = 0;

async function loadAudit() {
  try {
    const r = await fetch('/api/audit?limit=500');
    if (r.status === 401) return showLogin(t('common.session_expired'));
    if (!r.ok) return;
    auditRows = await r.json();
  } catch {
    return;
  }
  fillAuditFilters();
  renderAudit();
}

/** 事件 / 机器筛选下拉与条数（切换语言时也重填，保留所选项） */
function fillAuditFilters() {
  const ev = $('f-ev');
  const curEv = ev.value;
  ev.innerHTML = `<option value="">${esc(t('audit.all_events'))}</option>${Object.keys(EV).map((k) => `<option value="${k}">${k} · ${esc(t(`ev.${k}`))}</option>`).join('')}`;
  ev.value = curEv;
  const sel = $('f-m');
  const cur = sel.value;
  const names = [...new Set(auditRows.map(aMachine))].sort();
  sel.innerHTML = `<option value="">${esc(t('audit.all_machines'))}</option>${names.map((n) => `<option>${esc(n)}</option>`).join('')}`;
  sel.value = names.includes(cur) ? cur : '';
  $('a-count').textContent = auditRows.length ? t('audit.recent', { n: auditRows.length }) : '';
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
  const tag = (e) => `<span class="tag ${isEv(e) ? EV[e] : ''}"><span class="ev">${esc(e)}</span>${isEv(e) ? esc(t(`ev.${e}`)) : ''}</span>`;
  // 存储的是事件码与原始字段，按当前语言渲染；update_failed 的 reason 为 hub 记录的原文
  const evDesc = (e) => (isEv(e) ? t(`evd.${e}`) : '');
  const reason = (r) => (hasMsg(`reason.${r}`) ? t(`reason.${r}`) : r);
  const withReason = (text, r) => (r ? t('common.detail', { text, detail: r }) : text);
  const target = (s) => String(s).replace(/（恢复 Claude 对话 ([^）]*)）$/, (_, id) => t('audit.resume', { id }));
  const desc = (a) => esc(a.event === 'image' ? `${a.mime || ''} · ${Math.max(1, Math.round((a.bytes || 0) / 1024))} KB`
    : a.to ? withReason(`${a.from} → ${a.to}`, a.reason)
    : a.tokenName ? t('audit.token_desc', { desc: evDesc(a.event), name: a.tokenName })
    : a.target ? withReason(target(a.target), a.reason && (a.reason === 'not_found' ? t('reason.ssh_host_missing') : reason(a.reason)))
    : a.reason ? reason(a.reason) : evDesc(a.event));
  const sessName = (a) => esc(a.sessionName || t('common.session'));
  const sess = (a) => (a.sessionId === undefined ? '<span class="muted">—</span>' : `${sessName(a)} <span class="muted">#${a.sessionId}</span>`);
  const time = (a) => fullTime(Date.parse(a.time));
  $('a-body').innerHTML = shown.map((a) => `<tr><td class="tm">${esc(time(a))}</td><td>${tag(a.event)}</td>
    <td>${esc(aMachine(a))}</td><td>${sess(a)}</td>
    <td class="mono scmd">${esc(a.ip || '—')}</td><td class="muted">${desc(a)}</td></tr>`).join('')
    || `<tr><td colspan="6" class="empty">${esc(t(auditRows.length ? 'audit.no_match' : 'audit.empty'))}</td></tr>`;
  $('a-list').innerHTML = shown.map((a) => `<div class="arow"><div class="a1">${tag(a.event)}<span class="tm">${esc(time(a))}</span></div>
    <div class="a2">${esc(aMachine(a))}${a.sessionId === undefined ? '' : ` · ${sessName(a)} #${a.sessionId}`}<span class="mono">${esc(a.ip || '')}</span></div>
    <div class="a3">${desc(a)}</div></div>`).join('')
    || `<div class="empty">${esc(t(auditRows.length ? 'audit.no_match' : 'audit.empty'))}</div>`;
  $('a-total').textContent = t('audit.total', { n: rows.length });
  // 页码最多显示 5 个，以当前页为中心
  const from = Math.max(0, Math.min(auditPage - 2, pages - 5));
  const nums = [];
  for (let i = from; i < Math.min(pages, from + 5); i++) nums.push(`<button data-page="${i}" class="${i === auditPage ? 'on' : ''}">${i + 1}</button>`);
  $('a-pages').innerHTML = `<button data-page="${auditPage - 1}" aria-label="${esc(t('audit.prev'))}"${auditPage ? '' : ' disabled'}>${ic('chevL')}</button>${nums.join('')}`
    + `<button data-page="${auditPage + 1}" aria-label="${esc(t('audit.next'))}"${auditPage < pages - 1 ? '' : ' disabled'}>${ic('chevR')}</button>`;
}

fillAuditFilters();
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
  const lbl = st === 'updating' ? t('upd.updating') : st === 'done' ? t('upd.restarting') : newer ? t('upd.new_version', { v: upd.latest }) : `v${upd.current}`;
  b.innerHTML = `${ic('up')}<span class="lbl">${esc(lbl)}</span>`;
  b.title = newer ? t('upd.new_title', { v: upd.latest }) : t('upd.cur_title', { v: upd.current });
  if (st === 'done') {
    $('upd').hidden = false;
    watchRestart();
  }
  if ($('upd').hidden) return;

  const busy = st === 'checking' || st === 'updating';
  const tag = {
    checking: () => `<span class="tag"><i class="dot info"></i>${esc(t('upd.checking'))}</span>`,
    updating: () => `<span class="tag t-pri"><i class="dot info"></i>${esc(t('upd.updating'))}</span>`,
    done: () => `<span class="tag t-pri"><i class="dot ok"></i>${esc(t('upd.done'))}</span>`,
    failed: () => `<span class="tag t-err">${esc(t('upd.failed'))}</span>`,
  }[st]?.() || (newer ? `<span class="tag t-pri"><i class="dot ok"></i>${esc(t('upd.has_new'))}</span>` : upd.latest ? `<span class="tag">${esc(t('upd.up_to_date'))}</span>` : '');
  // 服务端附错误码时按语言显示，否则显示原文
  const error = upd.errorCode && hasMsg(`upd.err.${upd.errorCode}`) ? t(`upd.err.${upd.errorCode}`, upd.errorParams || {}) : upd.error;
  const notes = newer ? pickNotes(upd.notes, LOCALE) : '';
  const url = /^https?:\/\//.test(upd.url || '') ? upd.url : '';
  const late = restartAt && Date.now() - restartAt > RESTART_HINT_MS;
  const checked = upd.checkedAt ? Date.parse(upd.checkedAt) : 0;
  $('upd-body').innerHTML = `
    <div class="desc">
      <div class="di"><div class="dl">${esc(t('upd.current'))}</div><div class="dv">v${esc(upd.current)}</div></div>
      <div class="di"><div class="dl">${esc(t('upd.latest'))}</div><div class="dv">${upd.latest ? esc(upd.latest) : '—'}</div></div>
      <div class="di"><div class="dl">${esc(t('upd.last_check'))}</div><div class="dv" title="${esc(fullTime(checked))}">${esc(ago(checked))}</div></div>
    </div>
    <div class="upd-st">${tag}${url && upd.latest ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t('upd.release_page'))}${ic('chevR', 'ic-sm')}</a>` : ''}</div>
    ${error ? `<div class="banner">${ic('alertC')}<div><span class="bd">${esc(error)}</span></div></div>` : ''}
    ${st === 'done' ? `<div class="banner def">${ic('info')}<div><span class="bt">${esc(t(late ? 'upd.late_title' : 'upd.restart_title'))}</span>
      <span class="bd">${esc(t(late ? 'upd.late_desc' : 'upd.restart_desc'))}</span></div></div>` : ''}
    ${notes ? `<div class="upd-sec">${esc(t('upd.notes'))}</div><div class="upd-notes">${esc(notes)}</div>` : ''}
    ${upd.log ? `<div class="upd-sec">${esc(t('upd.log'))}</div><pre class="upd-log" id="upd-log">${esc(upd.log)}</pre>` : ''}
    ${st === 'done' ? '' : `<div class="upd-acts">
      <button class="btn" data-upd="check"${busy ? ' disabled' : ''}>${ic('reset')}${esc(t('upd.check'))}</button>
      ${newer ? `<button class="btn btn-primary" data-upd="apply"${busy ? ' disabled' : ''}>${esc(t(st === 'failed' ? 'upd.retry' : 'upd.apply'))}</button>` : ''}
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
    const msg = n ? t('upd.confirm_takeovers', { n, v: upd.latest }) : t('upd.confirm', { v: upd.latest });
    if (!confirm(msg)) return;
  }
  try {
    const r = await fetch(`/api/update/${kind}`, { method: 'POST' });
    if (r.status === 401) return showLogin(t('common.session_expired'));
    const body = await r.json().catch(() => ({}));
    if (!r.ok) alert(apiError(body, r.status, 'upd.op_failed'));
  } catch {
    alert(t('common.no_server'));
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
    if (r.status === 401) return showLogin(t('common.session_expired'));
    return [r.status, await r.json().catch(() => ({}))];
  } catch {
    return [0, { error: t('common.no_server') }];
  }
}

async function loadTokens() {
  const res = await tokApi('/api/tokens');
  if (!res) return;
  if (res[0] === 200) tokRows = res[1];
  else $('tok-err').textContent = apiError(res[1], res[0], 'tok.load_failed');
  renderTokens();
}

function renderTokens() {
  $('tok-new').innerHTML = tokNew ? `<div class="banner def">${ic('info')}<div>
      <span class="bt">${esc(t('tok.issued', { name: tokNew.name }))}</span> <span class="bd">${esc(t('tok.once'))}</span>
      <div class="tok-copy"><input class="input mono" id="tok-plain" readonly value="${esc(tokNew.token)}" aria-label="${esc(t('tok.plain_aria'))}"><button class="btn btn-sm btn-primary" data-tok-copy>${esc(t('tok.copy'))}</button></div>
      <div class="tok-tip" id="tok-tip"></div></div></div>` : '';
  const acts = (tk) => (tk.revoked ? '' : tokAsk === tk.name
    ? `<div class="tok-acts"><button class="btn btn-sm" data-tok-cancel>${esc(t('common.cancel'))}</button><button class="btn btn-sm btn-primary" data-tok-revoke="${esc(tk.name)}">${esc(t('tok.revoke_ok'))}</button></div>`
    : `<div class="tok-acts"><button class="btn btn-sm" data-tok-ask="${esc(tk.name)}">${esc(t('tok.revoke'))}</button></div>`);
  $('tok-list').innerHTML = (tokRows || []).map((tk) => `<div class="tok-row${tk.revoked ? ' off' : ''}">
      <div class="tok-main"><div class="tok-r1"><span class="mono tok-n">${esc(tk.name)}</span>${tk.revoked ? `<span class="tag">${esc(t('tok.revoked'))}</span>` : `<span class="tag t-pri"><i class="dot ok"></i>${esc(t('tok.valid'))}</span>`}</div>
      <div class="tok-r2"><span title="${esc(fullTime(tk.createdAt))}">${esc(t('tok.created', { time: shortTime(tk.createdAt) }))}</span><span>${esc(tk.machines.length ? t('tok.machines', { list: tk.machines.join(t('common.list_sep')) }) : t('tok.no_machines'))}</span></div>
      ${tokAsk === tk.name ? `<div class="tok-ask">${esc(t('tok.revoke_warn'))}</div>` : ''}</div>
      ${acts(tk)}</div>`).join('') || `<div class="empty">${esc(t(tokRows ? 'tok.empty' : 'common.loading'))}</div>`;
}

async function revokeTok(name) {
  const res = await tokApi(`/api/tokens/${encodeURIComponent(name)}/revoke`, {});
  if (!res) return;
  tokAsk = null;
  if (res[0] !== 200) $('tok-err').textContent = apiError(res[1], res[0], 'tok.revoke_failed');
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
  $('tok-tip').textContent = ok ? t('tok.copied') : t('tok.copy_failed');
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
  if (res[0] !== 201) return ($('tok-err').textContent = apiError(res[1], res[0], 'tok.issue_failed'));
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
  const nw = e.target.closest('[data-new]');
  if (nw) return openNc(nw.dataset.new);
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
    if (!r.ok) return showLogin(apiError(body, r.status, 'login.failed'));
    $('password').value = '';
    showMain();
  } catch {
    showLogin(t('common.no_server'));
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

/** 切换语言：重新翻译静态文字，重绘各动态区域（已显示的一次性提示 / 错误保持原文，下次操作即用新语言） */
function relocalize() {
  applyLocale();
  setSse(sseKind);
  render();
  renderUpdate();
  fillAuditFilters();
  renderAudit();
  renderTokens();
  if (nc) {
    $('nc-sub').textContent = t('nc.machine', { name: mName(machines().find((x) => x.machineId === nc.machineId) || { machineId: nc.machineId }) });
    fillNcOpts();
    renderNc();
  }
  if (term && termKind) setTermState(termKind, termReason);
}

fetch('/api/me')
  .then((r) => (r.ok ? showMain() : showLogin()))
  .catch(() => showLogin(t('common.no_server')));
