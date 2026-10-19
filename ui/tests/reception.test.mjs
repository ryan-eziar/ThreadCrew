// 0.3.7: Claude's receiving period in its member panel. Runs the real functions from ui/app-v2.js
// without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const i18n = fs.readFileSync(new URL('../i18n.js', import.meta.url), 'utf8');
const extract = (name) => {
  const start = app.search(new RegExp(`^  function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} not found`);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
};
function context() {
  const c = { t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])), fmtTime: (iso) => `at ${iso}` };
  vm.createContext(c);
  vm.runInContext([extract('memberView'), extract('receptionHint')].join('\n'), c);
  return c;
}
const reception = (mode) => ({ mode, seconds: { '10h': 36000, '24h': 86400, unlimited: null }[mode], unlimited: mode === 'unlimited', options: ['10h', '24h', 'unlimited'] });
const claude = (mode, waitState = 'armed') => ({ agent: 'claude', route: 'claude-pull', state: 'ready', reception: reception(mode),
  wait: { state: waitState, deadlineAt: mode === 'unlimited' ? '9999-12-31T23:59:59.999Z' : '2026-10-19T10:00:00.000Z' } });

test('standing by shows the deadline, or "no time limit" instead of a year-9999 date', () => {
  const c = context();
  assert.equal(c.memberView(claude('10h')).text, '待命至 at 2026-10-19T10:00:00.000Z');
  assert.equal(c.memberView(claude('unlimited')).text, '待命（不限时）');
  assert.equal(c.memberView(claude('unlimited')).short, '待命');
  assert.equal(c.memberView({ agent: 'claude', route: 'claude-pull', state: 'ready', wait: { state: 'armed', deadlineAt: 'D' } }).text, '待命至 at D',
    'a broker without reception still shows its deadline');
  const finiteLease = { ...claude('unlimited'), wait: { state: 'armed', deadlineAt: '2026-10-19T10:00:00.000Z' } };
  assert.equal(c.memberView(finiteLease).text, '待命至 at 2026-10-19T10:00:00.000Z', 'the deadline decides, not the room choice');
});

test('an expired lease shows its real deadline even after switching to "until I stop it"', () => {
  assert.match(app, /rows\.push\(\[t\('待命期限'\), String\(m\.wait\.deadlineAt\)\.startsWith\('9999-'\) \? t\('不限时'\) : fmtTime\(m\.wait\.deadlineAt\)\]\)/);
  assert.doesNotMatch(app, /m\.reception && m\.reception\.unlimited \? t\('不限时'\)/);
});

test('the hint says what each choice means, and that "until I stop it" keeps using Claude usage', () => {
  const c = context();
  assert.match(c.receptionHint(claude('10h')), /^它最后一次回复后 10 小时内/);
  assert.match(c.receptionHint(claude('24h')), /^它最后一次回复后 24 小时内/);
  const forever = c.receptionHint(claude('unlimited'));
  assert.ok(forever.includes('每 2 小时醒一次') && forever.includes('消耗 Claude 用量'));
  assert.equal(c.receptionHint(claude('24h', 'expired')), '期限已过：改了之后，还要用重连口令接上一次。');
  assert.equal(c.receptionHint({ agent: 'claude' }), null);
});

test('the panel offers the broker\'s choices, and the timeline names the new one', () => {
  assert.match(app, /segmented\(t\('接收期限'\), r\.options\.map/);
  assert.match(app, /roomPath\('\/members\/claude\/reception'\), \{ operationId: uuid\(\), mode \}/);
  assert.match(app, /case 'reception_changed':/);
  for (const zh of ['10 小时', '24 小时', '直到我停止', '待命（不限时）', '不限时', '接收期限', 'Claude 的接收期限改为「{0}」',
    '期限已过：改了之后，还要用重连口令接上一次。', '它最后一次回复后 {0} 小时内都能收到消息，每回复一次就重新计算；超过之后要用重连口令接上。']) {
    assert.ok(i18n.includes(`'${zh}':`), zh);
  }
});
