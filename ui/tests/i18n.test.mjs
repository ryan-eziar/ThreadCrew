// Every t('…') key used by the window has an English text with the same placeholders,
// and names such as Codex and Claude are never translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

function loadI18n(lang) {
  const storage = new Map(lang ? [['agentchat.lang', lang]] : []);
  const window = {
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, v) },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { reload() {} },
  };
  const document = { documentElement: { lang: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } } };
  vm.runInNewContext(read('i18n.js'), { window, document });
  return { i18n: window.AgentChatI18n, document };
}

function usedKeys(source) {
  const keys = new Set();
  const re = /\bt\('((?:[^'\\]|\\.)*)'/g;
  for (let m = re.exec(source); m; m = re.exec(source)) keys.add(m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'"));
  return keys;
}
const placeholders = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');

test('every UI key has English text with the same placeholders', () => {
  const { i18n } = loadI18n('en');
  const keys = new Set([...usedKeys(read('app-v2.js')), ...usedKeys(read('markdown.js'))]);
  assert.ok(keys.size > 300, `expected the whole window to be covered, found ${keys.size} keys`);
  const missing = [...keys].filter((k) => !Object.prototype.hasOwnProperty.call(i18n.EN, k));
  assert.deepEqual(missing, [], 'keys without English text');
  const mismatched = [...keys].filter((k) => placeholders(k) !== placeholders(i18n.EN[k]));
  assert.deepEqual(mismatched, [], 'placeholders differ between Chinese and English');
});

test('English text keeps the product names in English and has no Chinese left', () => {
  const { i18n } = loadI18n('en');
  const cjk = /[　-〿一-鿿＀-￯]/;
  const leftovers = Object.entries(i18n.EN).filter(([, en]) => cjk.test(en)).map(([zh]) => zh);
  assert.deepEqual(leftovers, []);
  for (const [zh, en] of Object.entries(i18n.EN)) {
    for (const name of ['Codex', 'Claude', 'Ryan']) {
      if (zh.includes(name)) assert.ok(en.includes(name), `“${zh}” lost the name ${name}`);
    }
  }
});

test('English unless Chinese was chosen; t() fills placeholders and falls back to the Chinese key', () => {
  const first = loadI18n(null);
  assert.equal(first.i18n.lang, 'en', 'no saved choice: English');
  assert.equal(first.document.documentElement.lang, 'en');
  assert.equal(loadI18n('fr').i18n.lang, 'en', 'an unknown saved value: English');
  const zh = loadI18n('zh');
  assert.equal(zh.i18n.lang, 'zh', 'an explicit Chinese choice is kept');
  assert.equal(zh.i18n.t('发给 {0}', 'Codex、Claude'), '发给 Codex、Claude');
  assert.equal(zh.document.documentElement.lang, 'zh-CN');
  const en = loadI18n('en');
  assert.equal(en.i18n.t('发给 {0}', 'Codex, Claude'), 'To Codex, Claude');
  assert.equal(en.i18n.t('第 {0}/{1} 轮', 2, 3), 'Round 2/3');
  assert.equal(en.i18n.t('还没翻译的文字'), '还没翻译的文字');
  assert.equal(en.document.documentElement.lang, 'en');
  assert.equal(en.document.documentElement.attrs['data-theme'], 'light');
});
