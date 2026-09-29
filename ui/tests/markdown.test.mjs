// Tests for ui/markdown.js. Run: node --test ui/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../markdown.js', import.meta.url), 'utf8');
const sandbox = { window: {}, URL };
vm.runInNewContext(code, sandbox);
const md = sandbox.window.AgentChatMarkdown;
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects from the vm realm have foreign prototypes
const parse = (s) => plain(md.parse(s));
const inline = (s) => plain(md.parseInline(s));

// A fake h() that builds plain trees, so rendering can be checked without a DOM.
const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: kids.flat(Infinity).filter((k) => k != null && k !== false) });
const render = (s, opts) => plain(md.render(md.parse(s), h, opts));
const tags = (tree) => {
  const out = [];
  const walk = (n) => { if (n && typeof n === 'object') { out.push(n.tag); n.kids.forEach(walk); } };
  [].concat(tree).forEach(walk);
  return out;
};
const text = (tree) => [].concat(tree).map((n) => (typeof n === 'string' ? n : n.tag === 'br' ? '\n' : text(n.kids))).join('');

test('headings need a space, so chat markers like #长 stay text', () => {
  assert.deepEqual(parse('# 标题').map((b) => b.type), ['heading']);
  assert.deepEqual(parse('#长 回复').map((b) => b.type), ['paragraph']);
  assert.deepEqual(parse('#').map((b) => b.type), ['paragraph']);
  assert.equal(parse('### 三级 ###')[0].inline[0].text, '三级');
});

test('raw HTML is kept as text and never becomes an element', () => {
  const s = '<script>alert(1)</script> <img src=x onerror=alert(1)> <b>bold</b>';
  const tree = render(s);
  assert.deepEqual(tags(tree), ['p']);
  assert.equal(text(tree), s);
});

test('only http and https links become anchors', () => {
  assert.deepEqual(inline('[ok](https://example.com/a)').map((n) => n.type), ['link']);
  assert.equal(inline('[ok](https://example.com/a)')[0].href, 'https://example.com/a');
  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](file:///C:/a)', '[x](vbscript:msgbox)']) {
    assert.ok(inline(bad).every((n) => n.type !== 'link'), bad);
  }
  const tree = render('see [docs](https://example.com)');
  const a = tree[0].kids.find((k) => k.tag === 'a');
  assert.equal(a.attrs.rel, 'noopener noreferrer nofollow');
  assert.equal(a.attrs.target, '_blank');
});

test('bare URLs link without trailing punctuation, including Chinese punctuation', () => {
  const nodes = inline('见 https://example.com/x?a=1。然后 (https://example.com/y) 以及 https://example.com/z.');
  const links = nodes.filter((n) => n.type === 'link').map((n) => n.children[0].text);
  assert.deepEqual(links, ['https://example.com/x?a=1', 'https://example.com/y', 'https://example.com/z']);
  assert.ok(inline('xhttps://example.com').every((n) => n.type !== 'link'));
});

test('emphasis, strong, strike and code spans', () => {
  const n = inline('**粗** *斜* ~~删~~ `a**b**`');
  assert.deepEqual(n.filter((x) => x.type !== 'text').map((x) => x.type), ['strong', 'em', 'del', 'code']);
  assert.equal(n.find((x) => x.type === 'code').text, 'a**b**');
  assert.deepEqual(inline('snake_case_name and a_b_c').map((x) => x.type), ['text']);
  assert.deepEqual(inline('2 * 3 * 4').map((x) => x.type), ['text']);
  assert.deepEqual(inline('**未闭合').map((x) => x.type), ['text']);
  assert.equal(inline('\\*不是强调\\*')[0].text, '*不是强调*');
  assert.equal(inline('``有 ` 的代码``')[0].text, '有 ` 的代码');
});

test('fenced code keeps its text, and an unclosed fence runs to the end', () => {
  const b = parse('前\n```js\nconst a = "<b>";\n  indented\n```\n后');
  assert.deepEqual(b.map((x) => x.type), ['paragraph', 'code', 'paragraph']);
  assert.equal(b[1].lang, 'js');
  assert.equal(b[1].text, 'const a = "<b>";\n  indented');
  const cut = parse('说明\n```\nline 1\nline 2');
  assert.equal(cut[1].type, 'code');
  assert.equal(cut[1].closed, false);
  assert.equal(cut[1].text, 'line 1\nline 2');
  assert.equal(parse('~~~\n```\n~~~')[0].text, '```');
  const copied = [];
  const tree = render('```\nx\n```', { onCopyCode: (t) => copied.push(t) });
  assert.ok(tags(tree).includes('button'));
});

test('lists: nesting, ordered start, lazy continuation, loose vs tight', () => {
  const b = parse('- a\n  - a1\n  - a2\n- b\n继续 b');
  assert.equal(b.length, 1);
  assert.equal(b[0].items.length, 2);
  assert.equal(b[0].tight, true);
  assert.equal(b[0].items[0].children[1].type, 'list');
  assert.equal(text(md.render(md.parse('- b\n继续 b'), h)).includes('继续 b'), true);
  const o = parse('3. 三\n4. 四');
  assert.equal(o[0].ordered, true);
  assert.equal(o[0].start, 3);
  assert.equal(render('3. 三')[0].attrs.start, '3');
  assert.equal(parse('1. 一\n\n2. 二')[0].tight, false);
  const mixed = parse('1. **标题**\n   - 细节\n2. 下一条');
  assert.equal(mixed[0].items.length, 2);
  assert.equal(mixed[0].items[0].children[1].type, 'list');
  assert.deepEqual(parse('- a\n\n段落').map((x) => x.type), ['list', 'paragraph']);
  assert.deepEqual(parse('- a\n1. b').map((x) => x.type), ['list', 'list']);
});

test('tables: alignment, ragged rows, header-only preview, escaped pipes', () => {
  const t = parse('| 名 | 值 | 备注 |\n|:--|--:|:-:|\n| a | 1 |\n| b | 2 | x | extra |\n\n后')[0];
  assert.equal(t.type, 'table');
  assert.deepEqual(t.align, ['left', 'right', 'center']);
  assert.equal(t.rows.length, 2);
  assert.ok(t.rows.every((r) => r.length === 3));
  const head = parse('| a | b |\n|---|---|');
  assert.equal(head[0].type, 'table');
  assert.equal(head[0].rows.length, 0);
  assert.equal(parse('| a \\| b | c |\n|---|---|')[0].header[0][0].text, 'a | b');
  assert.equal(parse('a | b\n--|--')[0].type, 'table');
  assert.deepEqual(parse('只是 | 一条竖线').map((x) => x.type), ['paragraph']);
  assert.deepEqual(parse('| a | b |\n|---|').map((x) => x.type), ['paragraph']);
  const tree = render('| a |\n|---|\n| 1 |');
  assert.ok(tags(tree).includes('table'));
  assert.equal(tree[0].attrs.class, 'md-table-wrap');
});

test('quotes, rules and paragraphs with hard line breaks', () => {
  const b = parse('> 引用一\n> 引用二\n懒惰续行\n\n---\n第一行\n第二行');
  assert.deepEqual(b.map((x) => x.type), ['quote', 'hr', 'paragraph']);
  assert.equal(text(render('第一行\n第二行')), '第一行\n第二行');
  assert.deepEqual(parse('- - -').map((x) => x.type), ['hr']);
});

test('CRLF and tabs are normalised', () => {
  const b = parse('- a\r\n\t- b\r\n');
  assert.equal(b[0].items[0].children[1].type, 'list');
});

test('huge or malformed input stays fast and does not overflow the stack', () => {
  const cases = [
    'x'.repeat(200000),
    '*'.repeat(100000),
    '**a '.repeat(20000),
    '_'.repeat(50000) + 'a',
    '['.repeat(20000) + ']('.repeat(20000),
    '`'.repeat(30000),
    '>'.repeat(5000) + ' deep',
    Array.from({ length: 3000 }, (_, i) => `${' '.repeat(i % 40)}- item ${i}`).join('\n'),
    Array.from({ length: 2000 }, () => '| a | b |').join('\n'),
  ];
  for (const s of cases) {
    const t0 = Date.now();
    const tree = render(s);
    assert.ok(Array.isArray(tree));
    assert.ok(Date.now() - t0 < 2000, `slow input: ${s.slice(0, 20)}…`);
  }
});

test('a preview cut mid-way still renders', () => {
  const full = '## 方案\n\n| 项 | 说明 |\n|---|---|\n| A | 一 |\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\n- 一\n- 二';
  for (let n = 1; n <= full.length; n++) {
    assert.doesNotThrow(() => render(full.slice(0, n)), `cut at ${n}`);
  }
});
