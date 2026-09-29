// Small ThreadCrew page rules and helpers, run on the real code in ui/ without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const extract = (name) => {
  const start = app.search(new RegExp(`^  function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} not found`);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
};
const constant = (name) => {
  const start = app.indexOf(`  const ${name} = `);
  assert.notEqual(start, -1, `${name} not found`);
  return app.slice(start, app.indexOf(';\n', start) + 2);
};

function helpers() {
  const c = { t: (zh) => zh, Date };
  vm.createContext(c);
  vm.runInContext([constant('UPLOAD_TYPES'), 'this.UPLOAD_TYPES = UPLOAD_TYPES;', extract('mediaTypeFor'), extract('formatBytes'), extract('uploadName')].join('\n'), c);
  return c;
}

test('every re-fill of an element goes through fill(), which drops null children', () => {
  const direct = app.split('\n').filter((line) => line.includes('.replaceChildren(') && !line.includes('const fill = '));
  assert.deepEqual(direct, [], 'use fill(el, ...) instead of el.replaceChildren(...)');
});

test('an upload gets the media type the broker expects for its extension, whatever the browser says', () => {
  const c = helpers();
  const cases = { 'a.PNG': 'image/png', 'b.jpg': 'image/jpeg', 'c.jpeg': 'image/jpeg', 'd.webp': 'image/webp', 'e.pdf': 'application/pdf',
    'f.txt': 'text/plain', 'g.log': 'text/plain', 'h.md': 'text/markdown', 'i.csv': 'text/csv', 'j.json': 'application/json' };
  for (const [name, type] of Object.entries(cases)) assert.equal(c.mediaTypeFor(name), type, name);
  for (const name of ['tool.exe', 'page.html', 'image.svg', 'noext', '']) assert.equal(c.mediaTypeFor(name), null, name);
});

test('sizes read like people write them', () => {
  const c = helpers();
  assert.equal(c.formatBytes(19), '19 B');
  assert.equal(c.formatBytes(6348), '6.2 KB');
  assert.equal(c.formatBytes(512000), '500 KB');
  assert.equal(c.formatBytes(10 * 1024 * 1024), '10.0 MB');
});

test('a pasted screenshot gets a dated name; names the broker refuses are cleaned', () => {
  const c = helpers();
  assert.match(c.uploadName({ name: 'image.png' }, true), /^截图-\d{8}-\d{6}\.png$/);
  assert.equal(c.uploadName({ name: 'image.png' }, false), 'image.png');
  assert.equal(c.uploadName({ name: 'a:b/c\\d.txt' }, false), 'a_b_c_d.txt');
});

test('a download keeps the UTF-8 file name from Content-Disposition', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(new URL('../source-v2.js', import.meta.url), 'utf8'), { window });
  const name = window.AgentChatSourceV2.dispositionName;
  assert.equal(name(`attachment; filename="threadcrew-export.md"; filename*=UTF-8''${encodeURIComponent('BAS 复核（联调）-2026-09-28.md')}`), 'BAS 复核（联调）-2026-09-28.md');
  assert.equal(name('attachment; filename="plain.txt"'), 'plain.txt');
  assert.equal(name(null), null);
});

test('a window whose files are missing from the package says so instead of staying blank', () => {
  const boot = fs.readFileSync(new URL('../boot.js', import.meta.url), 'utf8');
  const scripts = [];
  let body = null;
  const el = (tag) => ({ tag, style: {}, textContent: '', set src(v) { this._src = v; }, get src() { return this._src; } });
  const document = {
    documentElement: { classList: { add() {} } },
    head: { append: (s) => scripts.push(s) },
    body: { replaceChildren: (...kids) => { body = kids; } },
    createElement: el,
  };
  vm.runInNewContext(boot, { window: { __AGENT_CHAT__: { apiVersion: 'agent-chat.window.v1' } }, document });
  assert.deepEqual(scripts.map((s) => s.src), ['live-source.js', 'app.js']);
  scripts[0].onerror();
  scripts[1].onerror();
  assert.equal(body.length, 1, 'one message, once');
  assert.match(body[0].textContent, /cannot load/);
  const v2 = [];
  vm.runInNewContext(boot, { window: { __AGENT_CHAT__: { apiVersion: 'agent-chat.window.v2' } }, document: { ...document, head: { append: (s) => v2.push(s.src) } } });
  assert.deepEqual(v2, ['source-v2.js', 'app-v2.js']);
});
