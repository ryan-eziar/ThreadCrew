// 0.3.3: Claude Code stops a background command after 2 hours at most, so every line pasted into a
// Claude session says to rearm the wait without asking; and a work session can be given more time
// within the broker's caps. Runs the real functions from ui/app-v2.js without a browser.
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
  return app.slice(start, app.indexOf(';', start) + 1);
};

const ROOM = { id: 'room-1', name: 'blog-engine', gate: { segmentId: 'segment-9', version: 4 } };
function context() {
  const c = {
    t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])),
    control: () => ({ room: ROOM }),
    reasonText: (code) => `reason:${code}`,
    fmtTime: (iso) => `at ${iso}`,
  };
  vm.createContext(c);
  vm.runInContext([constant('TIME_STEPS_H'), extract('withWaitRule'), extract('joinLine'), extract('reconnectLine'),
    extract('resumeLine'), extract('addableSeconds'), extract('addTimeHint'), extract('budgetChangeText')].join('\n'), c);
  return c;
}
const paths = { helperPath: 'D:\\ThreadCrew\\chat.mjs', runtimeDir: 'D:\\ThreadCrew\\runtime' };
const seat = (agent) => ({
  agent, binding: { id: `binding-${agent}` },
  joinHint: { ...paths, expectedGate: ROOM.gate, expectedBindingId: `binding-${agent}` },
  reconnectHint: { ...paths, roomId: 'room-1', roomName: 'blog-engine', expectedBindingId: `binding-${agent}`,
    expectedNativeSessionId: `native-${agent}`, expectedGate: ROOM.gate, renew: true },
  recoveryHint: { ...paths, roomId: 'room-1', bindingId: `binding-${agent}`, nativeSessionId: `native-${agent}` },
});
const lines = (c, m) => ({ join: c.joinLine(m), reconnect: c.reconnectLine(m), resume: c.resumeLine(m, 'blog-engine') });

test('every line pasted into a Claude session ends with the rearm rule, on a line of its own', () => {
  const c = context();
  for (const [kind, text] of Object.entries(lines(c, seat('claude')))) {
    const last = text.split('\n').at(-1);
    assert.ok(last.startsWith('收消息用一个后台等待'), `${kind}: ${last}`);
    assert.ok(last.includes('7200000') && last.includes('不用问我'), kind);
    assert.ok(last.includes('我自己停掉的等待也不要重挂'), `${kind}: a wait the person stopped stays stopped`);
    for (const end of ['TIMEOUT', 'BINDING_INVALID', 'ROOM_ARCHIVED']) assert.ok(last.includes(end), `${kind} names ${end}`);
    assert.ok(!text.split('\n').slice(0, -1).some((l) => l.includes('收消息用一个后台等待')), `${kind}: said once`);
  }
});

test("Codex's lines are unchanged: it has no background wait to rearm", () => {
  const c = context();
  for (const [kind, text] of Object.entries(lines(c, seat('codex')))) {
    assert.ok(!text.includes('后台等待') && !text.includes('7200000'), kind);
  }
});

test('the command stays on its own line, untouched by the rule', () => {
  const c = context();
  const reconnect = c.reconnectLine(seat('claude')).split('\n');
  assert.ok(reconnect[1].startsWith('node "D:\\ThreadCrew\\chat.mjs" join ') && reconnect[1].endsWith('--reconnect --renew'));
});

const work = (timeBudget, addTime = { enabled: true }) => ({ timeBudget, actions: { addTime } });
const budget = (limitSeconds) => ({ limitSeconds, remainingSeconds: 1000, maxSeconds: 86400, maxAddSeconds: 36000 });

test('time can be added up to one add cap and the whole-length cap, whichever is smaller', () => {
  const c = context();
  assert.equal(c.addableSeconds(work(budget(36000))), 36000);
  assert.equal(c.addableSeconds(work(budget(72000))), 14400);
  assert.equal(c.addableSeconds(work(budget(86400))), 0);
});

test('nothing can be added when the broker says no, or knows no time budget', () => {
  const c = context();
  assert.equal(c.addableSeconds(work(budget(36000), { enabled: false, reason: 'WORK_NOT_ACTIVE' })), 0);
  assert.equal(c.addableSeconds(work(undefined)), 0);
  assert.equal(c.addableSeconds({ timeBudget: budget(3600), actions: {} }), 0);
});

test('the hint says why: the broker reason, or the whole-length cap', () => {
  const c = context();
  assert.equal(c.addTimeHint(work(budget(36000))), null);
  assert.equal(c.addTimeHint(work(budget(36000), { enabled: false, reason: 'WORK_NOT_ACTIVE' })), 'reason:WORK_NOT_ACTIVE');
  assert.equal(c.addTimeHint(work(budget(36000), { enabled: false })), '现在不能延长');
  assert.equal(c.addTimeHint(work(budget(84000))), '剩下可加的时间不到 1 小时（一项任务总共最多 24 小时）');
  assert.equal(c.addTimeHint(work(budget(86400))), '已到 24 小时的总时长上限');
  assert.equal(c.addTimeHint(work(budget(86400), { enabled: false, reason: 'WORK_TIME_LIMIT' })), '已到 24 小时的总时长上限');
  assert.equal(c.addTimeHint(work(undefined)), null);
});

test('every new window string has an English translation', () => {
  const source = fs.readFileSync(new URL('../i18n.js', import.meta.url), 'utf8');
  for (const zh of ['时间余量', '时间：{0}，到 {1} 结束', '再给 {0} 小时', '延长 {0} 小时', '，到 {0} 结束', '现在不能延长',
    '已到 {0} 小时的总时长上限']) {
    assert.ok(source.includes(`'${zh}':`), zh);
  }
  assert.ok(source.includes("'收消息用一个后台等待，"), 'the rearm rule');
  for (const zh of ['剩下可加的时间不到 1 小时（一项任务总共最多 {0} 小时）', '+{0} 条请求', '+{0} 次唤醒', '+{0} 小时', '+{0} 分钟', '协作额度已调整：{0}']) {
    assert.ok(source.includes(`'${zh}':`), zh);
  }
});

test('the timeline says what one "+" added, and the new end for more time', () => {
  const c = context();
  assert.equal(c.budgetChangeText({ addRequests: 0, addWakes: 0, addSeconds: 7200, expiresAt: 'E' }), '协作额度已调整：+2 小时，到 at E 结束');
  assert.equal(c.budgetChangeText({ addRequests: 12, addWakes: 0, addSeconds: 0, expiresAt: 'E' }), '协作额度已调整：+12 条请求');
  assert.equal(c.budgetChangeText({ addRequests: 0, addWakes: 24, addSeconds: 1800, expiresAt: 'E' }), '协作额度已调整：+24 次唤醒、+30 分钟，到 at E 结束');
  assert.equal(c.budgetChangeText({}), '协作额度已调整', 'an event from before 0.3.3');
});

test("a Claude wait the helper just ended (rearming, up to 30 s) still reads as standing by, not as a dropped wait", () => {
  const c = { t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])), fmtTime: (iso) => `at ${iso}` };
  vm.createContext(c);
  vm.runInContext(extract('memberView'), c);
  const claude = (state, wait) => ({ agent: 'claude', route: 'claude-pull', state, wait });
  const deadlineAt = '2026-10-03T06:00:00Z';
  for (const waitState of ['armed', 'rearming']) {
    assert.equal(c.memberView(claude('ready', { state: waitState, deadlineAt })).short, '待命', waitState);
    assert.equal(c.memberView(claude('busy', { state: waitState, deadlineAt })).text, '工作中 · 收件已接通', waitState);
  }
  assert.equal(c.memberView(claude('ready', { state: 'not_armed', deadlineAt })).text, '已连接');
});

test('a member busy with work raises the reconnect banner only when its wait has expired', () => {
  const c = {};
  vm.createContext(c);
  vm.runInContext([constant('RECONNECT_STATES'), extract('needsReconnect')].join('\n'), c);
  const hint = { helperPath: 'x' };
  const m = (state, waitState, reconnectHint = hint) => ({ binding: { id: 'b' }, state, wait: { state: waitState }, reconnectHint });
  assert.equal(c.needsReconnect(m('busy', 'expired')), true);
  assert.equal(c.needsReconnect(m('busy', 'unarmed')), false, 'mid-turn without a wait is normal while working');
  assert.equal(c.needsReconnect(m('unarmed', 'unarmed')), true);
  assert.equal(c.needsReconnect(m('busy', 'expired', null)), false, 'never without a line to give');
  assert.equal(c.needsReconnect(m('ready', 'rearming', null)), false);
});
