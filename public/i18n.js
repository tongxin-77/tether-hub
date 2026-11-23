// 网页界面国际化：语言解析（回退链）、t() 取词条与插值、按语言选取更新说明段落、把 data-i18n 系列属性应用到页面。
// 普通脚本（非模块），在 locales.js 之后、app.js 之前载入，顶层声明与 app.js 共享；纯函数在测试中用 vm 载入本文件。
'use strict';

/** 支持的语言：zh-CN 为源语言 / 最终兜底，en 为第二兜底 */
const LOCALES = ['zh-CN', 'en', 'zh-TW', 'ja'];
/** 语言选择框中的名称（不翻译） */
const LOCALE_NAMES = { 'zh-CN': '简体中文', en: 'English', 'zh-TW': '繁體中文', ja: '日本語' };
/** localStorage 键：auto（跟随浏览器）或 LOCALES 之一 */
const LOCALE_KEY = 'tether.hub.locale';
/** 当前生效的语言 */
let LOCALE = 'zh-CN';

/** 单个语言标签 → 支持的语言；不认识返回 null。zh-Hant / 港澳台 → zh-TW，其余中文 → zh-CN */
function matchLocale(tag) {
  const s = String(tag || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s) return null;
  const exact = LOCALES.find((l) => l.toLowerCase() === s);
  if (exact) return exact;
  const [lang, ...rest] = s.split('-');
  if (lang === 'zh') {
    if (rest.includes('hans')) return 'zh-CN';
    return rest.some((p) => p === 'hant' || p === 'hk' || p === 'mo' || p === 'tw') ? 'zh-TW' : 'zh-CN';
  }
  if (lang === 'ja') return 'ja';
  if (lang === 'en') return 'en';
  return null;
}

/** 用户设置（auto 或语言代码）+ 浏览器语言列表 → 生效语言：设置优先，其次按列表顺序匹配，都不认识时用 en */
function resolveLocale(pref, langs) {
  if (LOCALES.includes(pref)) return pref;
  for (const l of langs || []) {
    const m = matchLocale(l);
    if (m) return m;
  }
  return 'en';
}

function lookup(loc, key) {
  const d = MESSAGES[loc];
  return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

/** 按 当前语言 → en → zh-CN 查找；n 为数字时取复数形式（en 有 _one，其余语言只有 _other） */
function message(key, n, loc = LOCALE) {
  for (const l of [loc, 'en', 'zh-CN']) {
    let v;
    if (typeof n === 'number') {
      if (l === 'en' && n === 1) v = lookup(l, `${key}_one`);
      if (v === undefined) v = lookup(l, `${key}_other`);
    }
    if (v === undefined) v = lookup(l, key);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** 取词条并替换 {name} 占位符；params.n 为数字时按复数选词；缺失时返回键名 */
function t(key, params) {
  const s = message(key, params && params.n);
  if (s === undefined) return key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
}
const hasMsg = (key) => message(key) !== undefined;

/**
 * 更新说明按语言选段：说明以 <!-- lang:zh-CN --> / <!-- lang:en --> 分段（release workflow 拼接）；
 * zh-CN / zh-TW 取中文段，en / ja 取英文段，缺失时取另一段；没有标记的旧格式整段返回。
 */
function pickNotes(text, locale) {
  const s = String(text || '');
  const re = /<!--\s*lang:([A-Za-z-]+)\s*-->/g;
  const marks = [...s.matchAll(re)];
  if (!marks.length) return s.trim();
  const parts = {};
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : s.length;
    parts[m[1]] = s.slice(m.index + m[0].length, end).trim().replace(/(^|\n)-{3,}$/, '').trim(); // 段间分隔线
  });
  const order = locale === 'zh-CN' || locale === 'zh-TW' ? ['zh-CN', 'en'] : ['en', 'zh-CN'];
  for (const l of order) if (parts[l]) return parts[l];
  return Object.values(parts).find(Boolean) || '';
}

/** 把 data-i18n（文本）、data-i18n-title、data-i18n-aria（aria-label）、data-i18n-ph（placeholder）应用到 root 下的元素 */
function translateDom(root) {
  for (const [attr, set] of [
    ['i18n', (e, v) => (e.textContent = v)],
    ['i18nTitle', (e, v) => (e.title = v)],
    ['i18nAria', (e, v) => e.setAttribute('aria-label', v)],
    ['i18nPh', (e, v) => (e.placeholder = v)],
  ]) {
    const sel = `[data-${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
    root.querySelectorAll(sel).forEach((e) => set(e, t(e.dataset[attr])));
  }
}
