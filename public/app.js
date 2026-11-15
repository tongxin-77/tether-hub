// Tether Hub Web 界面：登录、SSE 实时接收机器 / 会话状态并渲染；远程接管终端（xterm.js）；接管审计列表。
'use strict';

const $ = (id) => document.getElementById(id);
const STATUS = { running: '运行中', waiting: '等待中', exited: '已退出' };
const CLAUDE = { idle: 'Claude', thinking: '思考中', waiting: '等待确认', background: '子代理运行中', done: '已完成' };
const END_REASON = {
  reclaimed: '已被本地收回', disabled: '本机未允许接管', exited: '会话已退出', offline: '机器离线',
  not_found: '会话不存在或已退出', probe: '探测连接不支持接管',
};
const AUDIT = {
  start: '开始接管', denied: '接管被拒绝', end: '结束接管', reclaimed: '被本地收回',
  disabled: '本机关闭接管', exited: '会话退出', disconnected: '机器断线',
};

let state = null;
let es = null;
let retryTimer = 0;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function fullTime(ms) {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '';
}

function showLogin(msg) {
  stopEvents();
  $('main').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = msg || '';
  $('password').focus();
}

function showMain() {
  $('login').hidden = true;
  $('main').hidden = false;
  startEvents();
  loadAudit();
}

function stopEvents() {
  clearTimeout(retryTimer);
  if (es) es.close();
  es = null;
}

// EventSource 遇到网络中断会自动重连；若被服务器以非 200 拒绝（如登录失效）则彻底关闭，此时自行判断是否需要重新登录
function startEvents() {
  stopEvents();
  es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    $('conn').className = 'conn ok';
    $('conn').title = '实时连接正常';
    render();
  });
  es.onerror = async () => {
    $('conn').className = 'conn bad';
    $('conn').title = '实时连接已断开，正在重连…';
    if (es.readyState !== EventSource.CLOSED) return;
    try {
      const r = await fetch('/api/me');
      if (r.status === 401) return showLogin('登录已失效，请重新登录');
    } catch {}
    retryTimer = setTimeout(startEvents, 3000);
  };
}

function render() {
  const root = $('machines');
  root.replaceChildren();
  const machines = state ? state.machines : [];
  const online = machines.filter((m) => m.online).length;
  const sessions = machines.reduce((n, m) => n + m.sessions.length, 0);
  const waiting = machines.reduce((n, m) => n + m.sessions.filter(isWaiting).length, 0);

  const sum = $('summary');
  sum.replaceChildren(`${machines.length} 台机器（${online} 在线） · ${sessions} 个会话`);
  if (waiting) {
    sum.append(' · ');
    sum.append(el('b', '', `${waiting} 个等待确认`));
  }
  if (state) document.title = waiting ? `(${waiting}) Tether Hub` : 'Tether Hub';

  if (!machines.length) {
    root.append(el('div', 'card empty', '还没有机器接入。用 pnpm token create <名称> 签发 token，并在 Tether 客户端设置中填写服务器地址与 token。'));
    return;
  }
  for (const m of machines) root.append(renderMachine(m));
}

const isWaiting = (s) => s.claude && s.claude.state === 'waiting';

function renderMachine(m) {
  const waiting = m.sessions.filter(isWaiting).length;
  const card = el('section', `card machine${waiting ? ' attn' : ''}${m.online ? '' : ' offline'}`);
  const head = el('div', 'm-head');
  head.append(el('span', 'm-name', m.name || m.machineId));
  head.append(el('span', `pill ${m.online ? 'on' : 'off'}`, m.online ? '在线' : '离线'));
  if (waiting) head.append(el('span', 'pill warn', `${waiting} 个等待确认`));
  const meta = el('div', 'm-meta');
  const seen = el('span', '', m.online ? `上线于 ${ago(m.lastSeen)}` : `最后在线 ${ago(m.lastSeen)}`);
  seen.title = fullTime(m.lastSeen);
  meta.append(seen, el('span', '', `Tether ${m.version || '?'}`), el('span', '', `token ${m.tokenName}`));
  head.append(meta);
  card.append(head);

  if (!m.sessions.length) {
    card.append(el('div', 'no-sessions', m.online ? '没有会话' : '离线，暂无会话信息'));
    return card;
  }
  const list = el('ul', 'sessions');
  for (const s of m.sessions) list.append(renderSession(m, s));
  card.append(list);
  return card;
}

function renderSession(m, s) {
  const li = el('li', `session${isWaiting(s) ? ' waiting' : ''}`);
  const name = el('div', 's-name');
  name.append(el('span', '', s.name || `会话 ${s.id}`));
  li.append(name);

  const side = el('div', 's-side');
  const pills = el('div', 'pills');
  if (s.claude) {
    const label = CLAUDE[s.claude.state] || s.claude.state;
    const text = s.claude.state === 'background' && s.claude.count ? `${label} ×${s.claude.count}` : label;
    pills.append(el('span', `pill cl cl-${s.claude.state}`, text));
  }
  pills.append(el('span', `pill st-${s.status}`, STATUS[s.status] || s.status));
  if (m.online && s.status !== 'exited') {
    const btn = el('button', 'ghost small', '接管');
    btn.addEventListener('click', () => openTerm(m, s));
    pills.append(btn);
  }
  const t = el('span', 's-time', ago(s.lastActivityAt));
  t.title = `最后活动：${fullTime(s.lastActivityAt)}`;
  side.append(pills, t);
  li.append(side);

  const detail = el('div', 's-detail', `${s.host ? `${s.host} · ` : ''}${s.cwd || ''}`);
  detail.title = `${s.host ? `远程主机：${s.host}\n` : ''}目录：${s.cwd || ''}\n命令：${s.command || ''}`;
  li.append(detail);
  if (isWaiting(s) && s.claude.message) li.append(el('div', 's-msg', s.claude.message));
  return li;
}

// ---- 远程接管终端：浏览器 ↔ hub 的 /api/term WebSocket，内容为 base64 透传 ----

let term = null;
let termWs = null;
let onWinResize = null;

const utf8 = new TextEncoder();
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function setTermStatus(text, ended) {
  $('term-status').textContent = text;
  $('term-status').className = `term-status${ended ? ' ended' : ''}`;
}

function openTerm(m, s) {
  closeTerm();
  $('term-title').textContent = `${m.name || m.machineId} · ${s.name || `会话 ${s.id}`}`;
  setTermStatus('连接中…');
  $('term').hidden = false;

  const t = (term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 14, cursorBlink: true, scrollback: 5000 }));
  const fit = new FitAddon.FitAddon();
  t.loadAddon(fit);
  t.open($('term-box'));
  fit.fit();
  // Ctrl+C 有选区时复制、Ctrl+V 粘贴：交给浏览器默认行为，由 xterm 的 copy / paste 事件处理（多行粘贴、括号粘贴模式）
  t.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.shiftKey
    && ((e.key === 'c' && t.hasSelection()) || e.key === 'v')));

  const ws = (termWs = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/term?machine=${encodeURIComponent(m.machineId)}&session=${s.id}`));
  let ready = false;
  let ended = false;
  const send = (msg) => ready && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  t.onData((d) => send({ type: 'input', data: toB64(utf8.encode(d)) }));
  t.onBinary((d) => send({ type: 'input', data: btoa(d) }));
  t.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
  onWinResize = () => fit.fit();
  window.addEventListener('resize', onWinResize);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') {
      // 先按快照尺寸写入避免错行，再适配窗口并把新尺寸发给 daemon
      t.reset();
      if (msg.cols > 0 && msg.rows > 0) t.resize(msg.cols, msg.rows);
      t.write(fromB64(msg.data), () => {
        ready = true;
        fit.fit();
      });
      setTermStatus('接管中');
      t.focus();
    } else if (msg.type === 'output') {
      t.write(fromB64(msg.data));
    } else if (msg.type === 'detached' || msg.type === 'denied') {
      ended = true;
      ready = false;
      setTermStatus(END_REASON[msg.reason] || `已结束（${msg.reason}）`, true);
      loadAudit();
    }
  };
  ws.onclose = () => {
    ready = false;
    if (!ended) setTermStatus('连接已断开', true);
  };
}

function closeTerm() {
  if (termWs) {
    termWs.onclose = null;
    termWs.close();
    termWs = null;
  }
  if (term) term.dispose();
  term = null;
  if (onWinResize) window.removeEventListener('resize', onWinResize);
  onWinResize = null;
  if (!$('term').hidden) {
    $('term').hidden = true;
    loadAudit();
  }
}

// ---- 接管审计 ----

async function loadAudit() {
  let rows;
  try {
    const r = await fetch('/api/audit?limit=50');
    if (!r.ok) return;
    rows = await r.json();
  } catch {
    return;
  }
  const body = $('audit');
  body.replaceChildren();
  if (!rows.length) {
    const td = el('td', 'audit-empty', '暂无接管记录');
    td.colSpan = 5;
    const tr = el('tr');
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const a of rows) {
    const tr = el('tr', `ev-${a.event}`);
    const what = AUDIT[a.event] || a.event;
    tr.append(
      el('td', 'a-time', fullTime(Date.parse(a.time))),
      el('td', 'a-event', a.reason ? `${what}（${END_REASON[a.reason] || a.reason}）` : what),
      el('td', '', a.machineName || a.machineId),
      el('td', '', `${a.sessionName || '会话'} #${a.sessionId}`),
      el('td', 'a-ip', a.ip || ''),
    );
    body.append(tr);
  }
}

$('term-close').addEventListener('click', closeTerm);
$('audit-refresh').addEventListener('click', loadAudit);

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
  closeTerm();
  showLogin();
});

// 相对时间每 30 s 刷新一次
setInterval(() => state && !$('main').hidden && render(), 30_000);

fetch('/api/me')
  .then((r) => (r.ok ? showMain() : showLogin()))
  .catch(() => showLogin('无法连接服务器'));
