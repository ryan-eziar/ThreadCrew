// Reconnecting a member of the open room: who is offered it, what the copied line says, and when the
// window tells the person. Runs the real functions from ui/app-v2.js without a browser.
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

const hint = (agent) => ({
  roomId: 'room-1', roomName: 'blog-engine', agent, helperPath: 'D:\\ThreadCrew\\chat.mjs', runtimeDir: 'D:\\ThreadCrew\\runtime',
  protocolPath: 'D:\\ThreadCrew\\docs\\AGENT_PROTOCOL.md', expectedBindingId: `binding-${agent}`, expectedGate: { segmentId: 'segment-9', version: 4 },
  expectedNativeSessionId: `native-${agent}`, reconnect: true, renew: agent === 'claude',
});
// A member as the broker projects it: reconnectHint only in the three reconnect states.
const member = (agent, state, bindingId = `binding-${agent}`) => ({
  agent, state, binding: { id: bindingId, nativeSessionId: `native-${agent}` },
  reconnectHint: ['unarmed', 'expired', 'disconnected'].includes(state) ? hint(agent) : null,
});

function context(extra = {}) {
  const c = { t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])), NAMES: { codex: 'Codex', claude: 'Claude' }, ...extra };
  vm.createContext(c);
  vm.runInContext([constant('RECONNECT_STATES'), constant('RECONNECT_GRACE_MS'), extract('needsReconnect'), extract('reconnectLine'), extract('offlineDue')].join('\n'), c);
  return c;
}

test('reconnecting is offered only with the broker’s hint, for a seated member that cannot receive', () => {
  const c = context();
  for (const state of ['unarmed', 'expired', 'disconnected']) assert.equal(c.needsReconnect(member('claude', state)), true, state);
  for (const state of ['ready', 'busy', 'notified', 'recovery_required']) assert.equal(c.needsReconnect(member('claude', state)), false, state);
  assert.equal(c.needsReconnect({ ...member('claude', 'unarmed'), reconnectHint: null }), false,
    'no hint (a stopped room, or a broker without --reconnect): no reconnect line');
  assert.equal(c.needsReconnect({ agent: 'claude', state: 'unarmed', reconnectHint: hint('claude') }), false, 'no seat: that is joining');
});

test('the reconnect line is built from the hint and asks the agent to check its own session first', () => {
  const c = context();
  const claude = c.reconnectLine(member('claude', 'expired'));
  const command = claude.split('\n')[1];
  assert.equal(command, 'node "D:\\ThreadCrew\\chat.mjs" join --room room-1 --as claude --session <你当前原生会话的 ID> '
    + '--expected-binding binding-claude --gate-segment segment-9 --gate-version 4 --runtime-dir "D:\\ThreadCrew\\runtime" --reconnect --renew');
  assert.ok(!command.includes('blog-engine'), 'the room name stays out of the command');
  assert.ok(claude.split('\n')[0].includes('native-claude'), 'the original native session ID is in the sentence to check against');
  assert.ok(claude.indexOf('AGENT_PROTOCOL.md') < claude.indexOf('native-claude'), 'read the protocol, then check the ID');
  const codex = c.reconnectLine(member('codex', 'disconnected'));
  assert.ok(codex.includes(' --reconnect') && !codex.includes('--renew'), 'renew only where the hint says (Claude’s lease)');
});

function clockContext() {
  const calls = { flash: [], notices: [], timers: 0 };
  const st = { offline: new Map(), currentRoomId: 'room-1', offlineTimer: null };
  const c = context({
    st, Date,
    flash: (text) => calls.flash.push(text),
    showNotice: (n) => calls.notices.push(n),
    render: () => {},
    setTimeout: () => { calls.timers += 1; return calls.timers; },
    clearTimeout: () => {},
  });
  return { c, calls, st };
}
const KEY = 'instance-1:room-1:binding-claude';
const T0 = 1_000_000;

test('nothing is decided before the room’s snapshot is current', () => {
  const { c, st } = clockContext();
  assert.equal(c.offlineDue(KEY, member('claude', 'unarmed'), false, T0), false);
  assert.equal(st.offline.size, 0, 'a stale cached snapshot is not the first observation');
});

test('unavailable in the first current snapshot: shown at once, however slow the load, and not notified', () => {
  const { c, calls } = clockContext();
  assert.equal(c.offlineDue(KEY, member('claude', 'unarmed'), true, T0 + 25_000), true);
  assert.equal(calls.notices.length, 0, 'the person is looking at the room already');
});

test('ready first and unavailable two seconds later: the full grace period, then one notification', () => {
  const { c, calls } = clockContext();
  assert.equal(c.offlineDue(KEY, member('claude', 'ready'), true, T0), false);
  assert.equal(c.offlineDue(KEY, member('claude', 'unarmed'), true, T0 + 2_000), false);
  assert.equal(calls.timers, 1, 'a re-render waits for the end of the grace period');
  assert.equal(c.offlineDue(KEY, member('claude', 'unarmed'), true, T0 + 46_000), false);
  assert.equal(c.offlineDue(KEY, member('claude', 'unarmed'), true, T0 + 47_500), true);
  assert.equal(c.offlineDue(KEY, member('claude', 'unarmed'), true, T0 + 50_000), true);
  assert.equal(calls.notices.length, 1, 'one notification per drop');
  assert.equal(calls.notices[0].kind, 'reconnect');
});

test('the gap between two turns never warns', () => {
  const { c, calls } = clockContext();
  c.offlineDue(KEY, member('claude', 'ready'), true, T0);
  assert.equal(c.offlineDue(KEY, member('claude', 'unarmed'), true, T0 + 1_000), false);
  assert.equal(c.offlineDue(KEY, member('claude', 'ready'), true, T0 + 9_000), false);
  assert.deepEqual(calls.flash, [], 'nothing was shown, so nothing to announce');
  assert.equal(calls.notices.length, 0);
});

test('only the same seat receiving again says it is back, once', () => {
  const { c, calls } = clockContext();
  c.offlineDue(KEY, member('claude', 'unarmed'), true, T0);
  assert.equal(c.offlineDue(KEY, member('claude', 'ready'), true, T0 + 60_000), false);
  assert.equal(c.offlineDue(KEY, member('claude', 'ready'), true, T0 + 61_000), false);
  assert.deepEqual(calls.flash, ['Claude 已重新连上。']);
});

test('a warning that goes away without reception goes quietly', () => {
  for (const after of [{ ...member('claude', 'unarmed'), reconnectHint: null }, member('claude', 'busy'), member('claude', 'recovery_required')]) {
    const { c, calls } = clockContext();
    c.offlineDue(KEY, member('claude', 'unarmed'), true, T0);
    assert.equal(c.offlineDue(KEY, after, true, T0 + 5_000), false);
    assert.deepEqual(calls.flash, [], `${after.state}${after.reconnectHint ? '' : ' without a hint (stopped room)'}`);
  }
});

test('a new broker instance or binding is a new seat with its own observation', () => {
  const { c, st } = clockContext();
  c.offlineDue(KEY, member('claude', 'ready'), true, T0);
  assert.equal(c.offlineDue('instance-2:room-1:binding-claude', member('claude', 'unarmed'), true, T0 + 1_000), true,
    'first seen unavailable on the restarted broker: at once');
  assert.equal(c.offlineDue('instance-1:room-1:binding-new', member('claude', 'unarmed', 'binding-new'), true, T0 + 1_000), true);
  assert.equal(st.offline.get(KEY).since, null, 'the old seat’s record is untouched');
});
