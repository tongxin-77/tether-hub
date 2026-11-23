import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// public/locales.js + i18n.js 是浏览器普通脚本，在 vm 中载入取出词条与纯函数
const read = (f: string) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const ctx = vm.createContext({});
const { MESSAGES, LOCALES, resolveLocale, matchLocale, pickNotes, t, setLoc } = vm.runInContext(
  `${read('locales.js')}\n${read('i18n.js')}\n;({ MESSAGES, LOCALES, resolveLocale, matchLocale, pickNotes, t, setLoc: (l) => (LOCALE = l) })`,
  ctx,
) as {
  MESSAGES: Record<string, Record<string, string>>;
  LOCALES: string[];
  resolveLocale: (pref: string, langs: string[]) => string;
  matchLocale: (tag: string) => string | null;
  pickNotes: (text: string, locale: string) => string;
  t: (key: string, params?: Record<string, unknown>) => string;
  setLoc: (l: string) => void;
};

const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
/** 去掉 en 独有的 _one 复数形式后的键集合 */
const baseKeys = (d: Record<string, string>) => Object.keys(d).filter((k) => !k.endsWith('_one')).sort();

test('四种语言齐全，键集合与 zh-CN 一致（缺键 / 多键都报错）', () => {
  assert.deepEqual([...LOCALES].sort(), Object.keys(MESSAGES).sort());
  const ref = baseKeys(MESSAGES['zh-CN']);
  for (const loc of LOCALES) {
    const keys = baseKeys(MESSAGES[loc]);
    const missing = ref.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !ref.includes(k));
    assert.deepEqual({ loc, missing, extra }, { loc, missing: [], extra: [] });
  }
});

test('_one 只出现在 en，且有对应的 _other', () => {
  for (const loc of LOCALES) {
    for (const k of Object.keys(MESSAGES[loc]).filter((k) => k.endsWith('_one'))) {
      assert.equal(loc, 'en', `${loc} 不应有 ${k}`);
      assert.ok(`${k.slice(0, -4)}_other` in MESSAGES.en, `${k} 缺少 _other`);
    }
  }
});

test('各语言插值占位符与 zh-CN 一致，词条非空', () => {
  const zh = MESSAGES['zh-CN'];
  for (const loc of LOCALES) {
    for (const [k, v] of Object.entries(MESSAGES[loc])) {
      assert.ok(typeof v === 'string' && v.trim(), `${loc} ${k} 为空`);
      const src = zh[k.endsWith('_one') ? `${k.slice(0, -4)}_other` : k];
      assert.deepEqual(placeholders(v), placeholders(src), `${loc} ${k} 占位符不一致`);
    }
  }
});

test('页面与脚本里引用的静态键都存在', () => {
  const zh = MESSAGES['zh-CN'];
  const has = (k: string) => k in zh || `${k}_other` in zh;
  const used = [
    ...[...read('index.html').matchAll(/data-i18n(?:-\w+)?="([\w.]+)"/g)].map((m) => m[1]),
    ...[...read('app.js').matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]),
  ];
  assert.ok(used.length > 100);
  assert.deepEqual(used.filter((k) => !has(k)), []);
});

test('服务端返回的错误码都有词条', () => {
  const src = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const zh = MESSAGES['zh-CN'];
  const grab = (s: string, re: RegExp) => [...s.matchAll(re)].map((m) => m[1]);
  const api = [
    ...grab(src('web.ts'), /fail\(res, \d+, '(\w+)'/g),
    ...grab(src('agents.ts'), /code: '(\w+)'/g),
    ...grab(src('store.ts'), /nameError\([^\n]*, '(\w+)'/g),
  ];
  const upd = [...grab(src('update.ts'), /codedError\([^\n]*?, '([\w.]+)'/g), 'check', 'check.timeout', 'apply', 'no_package'];
  assert.ok(api.length > 30 && upd.length > 8);
  assert.deepEqual(api.filter((c) => !(`err.${c}` in zh)), []);
  assert.deepEqual(upd.filter((c) => !(`upd.err.${c}` in zh)), []);
});

test('matchLocale / resolveLocale：精确 → 同语种 → 非中文一律 en', () => {
  assert.equal(matchLocale('zh-CN'), 'zh-CN');
  assert.equal(matchLocale('zh'), 'zh-CN');
  assert.equal(matchLocale('zh-SG'), 'zh-CN');
  assert.equal(matchLocale('zh-Hans-HK'), 'zh-CN');
  assert.equal(matchLocale('zh-TW'), 'zh-TW');
  assert.equal(matchLocale('zh-HK'), 'zh-TW');
  assert.equal(matchLocale('zh-MO'), 'zh-TW');
  assert.equal(matchLocale('zh-Hant'), 'zh-TW');
  assert.equal(matchLocale('zh_hant_sg'), 'zh-TW');
  assert.equal(matchLocale('ja-JP'), 'ja');
  assert.equal(matchLocale('en-GB'), 'en');
  assert.equal(matchLocale('fr-FR'), null);
  assert.equal(resolveLocale('auto', ['fr-FR', 'de']), 'en');
  assert.equal(resolveLocale('auto', []), 'en');
  assert.equal(resolveLocale('auto', ['fr', 'ja-JP', 'en']), 'ja');
  assert.equal(resolveLocale('auto', ['zh-HK']), 'zh-TW');
  assert.equal(resolveLocale('ja', ['zh-CN']), 'ja');
  assert.equal(resolveLocale('xx', ['zh-CN']), 'zh-CN');
});

test('t：插值、复数（en 有 _one）、缺键按 en → zh-CN 回退、未知键返回键名', () => {
  setLoc('en');
  assert.equal(t('nc.messages', { n: 1 }), '1 message');
  assert.equal(t('nc.messages', { n: 3 }), '3 messages');
  assert.equal(t('nc.machine', { name: 'pc' }), 'Machine: pc');
  setLoc('ja');
  assert.equal(t('nc.messages', { n: 1 }), '1 件のメッセージ');
  setLoc('zh-CN');
  assert.equal(t('nc.messages', { n: 1 }), '1 条消息');
  assert.equal(t('no.such.key'), 'no.such.key');
  // 缺键回退：临时删掉 ja 与 en 的词条
  const { ja, en } = MESSAGES;
  const [jv, ev] = [ja['common.close'], en['common.close']];
  try {
    delete ja['common.close'];
    setLoc('ja');
    assert.equal(t('common.close'), 'Close');
    delete en['common.close'];
    assert.equal(t('common.close'), '关闭');
  } finally {
    ja['common.close'] = jv;
    en['common.close'] = ev;
    setLoc('zh-CN');
  }
});

test('pickNotes：按语言选段，缺段取另一段，无标记整段返回', () => {
  const notes = '<!-- lang:zh-CN -->\n### 新增\n\n- 中文\n\n---\n\n<!-- lang:en -->\n### Added\n\n- English\n';
  assert.equal(pickNotes(notes, 'zh-CN'), '### 新增\n\n- 中文');
  assert.equal(pickNotes(notes, 'zh-TW'), '### 新增\n\n- 中文');
  assert.equal(pickNotes(notes, 'en'), '### Added\n\n- English');
  assert.equal(pickNotes(notes, 'ja'), '### Added\n\n- English');
  assert.equal(pickNotes('<!-- lang:zh-CN -->\n只有中文', 'en'), '只有中文');
  assert.equal(pickNotes('  旧格式说明\n', 'en'), '旧格式说明');
  assert.equal(pickNotes('', 'en'), '');
});
