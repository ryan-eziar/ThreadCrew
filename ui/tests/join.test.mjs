// The join line a card copies: an empty seat carries its own join version, so copying both lines at
// once works whichever agent joins first. Runs the real joinLine from ui/app-v2.js without a browser.
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

const ROOM = { id: 'room-1', name: 'blog-engine', gate: { segmentId: 'segment-9', version: 4 } };
function context() {
  const c = { t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])), control: () => ({ room: ROOM }) };
  vm.createContext(c);
  vm.runInContext([extract('withWaitRule'), extract('joinLine')].join('\n'), c);
  return c;
}
const hint = (extra = {}) => ({
  helperPath: 'D:\\ThreadCrew\\chat.mjs', runtimeDir: 'D:\\ThreadCrew\\runtime', protocolPath: 'D:\\ThreadCrew\\docs\\AGENT_PROTOCOL.md',
  expectedGate: { segmentId: 'segment-9', version: 4 }, expectedBindingId: null, ...extra,
});
const command = (line) => line.match(/运行 (node .*?)。进群后/)[1];

test('an empty seat carries its own join version next to the room gate', () => {
  const c = context();
  const line = c.joinLine({ agent: 'claude', binding: null, joinHint: hint({ expectedJoinVersion: 2 }) });
  assert.equal(command(line), 'node "D:\\ThreadCrew\\chat.mjs" join --room room-1 --as claude --session <你当前原生会话的 ID> '
    + '--expected-binding null --gate-segment segment-9 --gate-version 4 --join-version 2 --runtime-dir "D:\\ThreadCrew\\runtime"');
});

test('each seat uses its own version: copying both lines at once gives each agent its own', () => {
  const c = context();
  const claude = command(c.joinLine({ agent: 'claude', binding: null, joinHint: hint({ expectedJoinVersion: 1 }) }));
  const codex = command(c.joinLine({ agent: 'codex', binding: null, joinHint: hint({ expectedJoinVersion: 3 }) }));
  assert.ok(claude.includes('--as claude') && claude.includes('--join-version 1'));
  assert.ok(codex.includes('--as codex') && codex.includes('--join-version 3'));
});

test('a broker without join versions keeps the strict gate line unchanged', () => {
  const c = context();
  const line = command(c.joinLine({ agent: 'codex', binding: null, joinHint: hint() }));
  assert.ok(!line.includes('--join-version'));
  assert.ok(line.includes('--gate-segment segment-9 --gate-version 4'));
});

test('replacing an existing seat never uses the empty-seat version', () => {
  const c = context();
  const line = command(c.joinLine({ agent: 'claude', binding: { id: 'binding-old' },
    joinHint: hint({ expectedBindingId: 'binding-old', expectedJoinVersion: 5 }) }));
  assert.ok(line.includes('--expected-binding binding-old'));
  assert.ok(!line.includes('--join-version'), 'replacement keeps the strict gate alone');
});

test('only a positive whole number is passed on as a join version', () => {
  const c = context();
  for (const bad of [0, -1, 1.5, '2', null]) {
    const line = command(c.joinLine({ agent: 'claude', binding: null, joinHint: hint({ expectedJoinVersion: bad }) }));
    assert.ok(!line.includes('--join-version'), String(bad));
  }
});
