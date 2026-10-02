// The resume line: for a seated member with an exact unanswered delivery (the broker's recoveryHint),
// what the person pastes into that member's original session. Runs the real resumeLine from
// ui/app-v2.js without a browser.
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

function context() {
  const c = { t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])) };
  vm.createContext(c);
  vm.runInContext([extract('withWaitRule'), extract('resumeLine')].join('\n'), c);
  return c;
}
const member = (agent) => ({
  agent, binding: { id: `binding-${agent}` },
  recoveryHint: { helperPath: 'D:\\ThreadCrew\\chat.mjs', runtimeDir: 'D:\\ThreadCrew\\runtime', roomId: 'room-1',
    bindingId: `binding-${agent}`, nativeSessionId: `native-${agent}` },
});

test('the resume line runs the read-only helper for that exact seat, on a line of its own', () => {
  const c = context();
  const lines = c.resumeLine(member('codex'), 'blog-engine').split('\n');
  assert.equal(lines[1], 'node "D:\\ThreadCrew\\chat.mjs" resume --room room-1 --as codex --binding binding-codex --runtime-dir "D:\\ThreadCrew\\runtime"');
  assert.ok(!lines[1].includes('blog-engine'), 'the room name stays out of the command');
});

test('the agent checks its own session ID before running it, and answers as the protocol says', () => {
  const c = context();
  const text = c.resumeLine(member('claude'), 'blog-engine');
  const [first, , last] = text.split('\n');
  assert.ok(first.includes('blog-engine') && first.includes('native-claude'));
  assert.ok(first.indexOf('native-claude') < text.indexOf('node '), 'check the ID, then run');
  assert.ok(last.includes('协议'));
});

test('without a runtime folder in the hint, the flag is left out rather than left empty', () => {
  const c = context();
  const m = member('codex');
  delete m.recoveryHint.runtimeDir;
  assert.ok(!c.resumeLine(m, 'x').includes('--runtime-dir'));
});
