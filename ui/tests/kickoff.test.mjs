// Starting work when both agents agree: what the room shows while one confirmation waits for the
// other, and after it lapsed. Runs the real pendingKickoffView from ui/app-v2.js without a browser.
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
  const c = { t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])), AGENTS: ['codex', 'claude'], NAMES: { codex: 'Codex', claude: 'Claude' } };
  vm.createContext(c);
  vm.runInContext(extract('pendingKickoffView'), c);
  return c;
}
const pending = (state, agents) => ({ state, sourceHumanMessageId: 'message-1', planSha256: 'a'.repeat(64), planPreview: 'Plan',
  confirmations: agents.map((agent) => ({ agent, at: '2026-09-29T06:30:00Z' })) });

test('nothing pending, nothing shown', () => {
  assert.equal(context().pendingKickoffView(null), null);
});

test('one confirmation names who confirmed and who is still to confirm', () => {
  const c = context();
  const codexFirst = c.pendingKickoffView(pending('waiting_peer', ['codex']));
  assert.equal(codexFirst.title, 'Codex 确认可以开工，在等 Claude 确认');
  assert.ok(codexFirst.text.includes('标准额度') && codexFirst.text.includes('停止'), 'what both confirming does, and that it can be stopped');
  assert.equal(c.pendingKickoffView(pending('waiting_peer', ['claude'])).title, 'Claude 确认可以开工，在等 Codex 确认');
});

test('a lapsed confirmation says so quietly, and why it can lapse', () => {
  const v = context().pendingKickoffView(pending('expired', ['codex']));
  assert.equal(v.tone, 'off');
  assert.equal(v.title, '开工确认已失效');
  assert.ok(v.text.includes('新消息'));
});

test('an unknown state shows nothing rather than guessing', () => {
  assert.equal(context().pendingKickoffView(pending('started', ['codex', 'claude'])), null);
});
