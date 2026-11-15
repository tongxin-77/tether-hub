// Tether Hub Web 界面：登录、SSE 实时接收机器 / 会话状态并渲染。
'use strict';

const $ = (id) => document.getElementById(id);
const STATUS = { running: '运行中', waiting: '等待中', exited: '已退出' };
const CLAUDE = { idle: 'Claude', thinking: '思考中', waiting: '等待确认', background: '子代理运行中', done: '已完成' };

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
  for (const s of m.sessions) list.append(renderSession(s));
  card.append(list);
  return card;
}

function renderSession(s) {
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
  showLogin();
});

// 相对时间每 30 s 刷新一次
setInterval(() => state && !$('main').hidden && render(), 30_000);

fetch('/api/me')
  .then((r) => (r.ok ? showMain() : showLogin()))
  .catch(() => showLogin('无法连接服务器'));
