// "Let them discuss" in the composer bar: what the button offers in each room state, and what it is
// called. Runs the real functions from ui/app-v2.js without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const extract = (name) => {
  const start = app.search(new RegExp(`^  function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} not found`);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
};

function context() {
  const c = { t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])), discussionReason: () => 'Claude 还不能接收' };
  vm.createContext(c);
  vm.runInContext([extract('discussionInfo'), extract('discussLabel')].join('\n'), c);
  return c;
}

const candidate = (over = {}) => ({
  kind: 'discuss', anchorItemId: 'item-7', anchorCursor: 'cur-7', baseMessageId: 'msg-7', previousExchangeId: null,
  availability: { enabled: true, reason: null, baseReplyIds: { codex: 'r-1', claude: 'r-2' } }, ...over,
});
const room = (over = {}) => ({ room: { lifecycle: 'open' }, activeExchange: null, currentWork: null, discussionCandidate: candidate(), ...over });

test('the button offers a discussion only when the broker says both answers are in', () => {
  const c = context();
  assert.equal(c.discussionInfo(room()).mode, 'ready');
  assert.equal(c.discussionInfo(room({ discussionCandidate: null })).mode, 'none', 'nothing sent yet');
  assert.equal(c.discussionInfo(null).mode, 'none', 'no room open');
  const blocked = c.discussionInfo(room({ discussionCandidate: candidate({ availability: { enabled: false, reason: 'MEMBER_NOT_READY', baseReplyIds: null } }) }));
  assert.equal(blocked.mode, 'blocked');
  assert.equal(blocked.reason, 'Claude 还不能接收', 'the reason is said, not just a greyed button');
});

test('a kickoff is never offered for discussion while its work session is on', () => {
  const c = context();
  const work = { sourceHumanMessageId: 'msg-7', coordinationState: 'active' };
  assert.equal(c.discussionInfo(room({ currentWork: work })).mode, 'kickoff');
  assert.equal(c.discussionInfo(room({ currentWork: { ...work, sourceHumanMessageId: 'msg-3' } })).mode, 'ready',
    'a later message during the work can still be discussed');
  const marked = candidate({ availability: { enabled: false, reason: 'KICKOFF_MESSAGE', baseReplyIds: null } });
  assert.equal(c.discussionInfo(room({ discussionCandidate: marked })).mode, 'kickoff',
    'after the work ends the broker still marks the kickoff, and the window still explains it');
});

test('a running discussion wins over the candidate, and the button says which round', () => {
  const c = context();
  const ex = { id: 'ex-1', baseMessageId: 'msg-7', currentRound: 2, maxRounds: 3, waitingFor: ['claude'] };
  const info = c.discussionInfo(room({ activeExchange: ex, discussionCandidate: candidate({ availability: { enabled: false, reason: 'EXCHANGE_ACTIVE' } }) }));
  assert.equal(info.mode, 'active');
  assert.equal(c.discussLabel(info, null), '讨论中 · 2/3');
});

test('the label: discuss, discuss again, or a start whose result is unconfirmed', () => {
  const c = context();
  assert.equal(c.discussLabel(c.discussionInfo(room()), null), '让他们讨论');
  const again = c.discussionInfo(room({ discussionCandidate: candidate({ kind: 'again', previousExchangeId: 'ex-1' }) }));
  assert.equal(c.discussLabel(again, null), '再讨论');
  assert.equal(c.discussLabel(again, { state: 'unknown' }), '讨论待确认');
  assert.equal(c.discussLabel(again, { state: 'sending' }), '再讨论');
  const kickoff = c.discussionInfo(room({ currentWork: { sourceHumanMessageId: 'msg-7' }, discussionCandidate: candidate({ previousExchangeId: 'ex-1' }) }));
  assert.equal(c.discussLabel(kickoff, null), '让他们讨论', 'never "again" for something it will not offer');
});

test('the discuss button sits in the composer bar right before Kick off; the timeline bar is gone', () => {
  const bar = app.slice(app.indexOf("h('div', { class: 'composer-bar' }"), app.indexOf("h('span', { class: 'bar-spacer' })"));
  assert.ok(bar.indexOf("id: 'discuss-toggle'") > 0 && bar.indexOf("id: 'discuss-toggle'") < bar.indexOf("id: 'work-toggle'"));
  assert.ok(!/renderDiscussion\(/.test(app), 'no discussion bar inside the conversation');
  assert.ok(!/^\.discuss \{/m.test(css), 'the old bar styles are gone');
});

// ---- Discuss first, then kick off with one chosen reply ----------------------------------------------

const fn = (name) => {
  const start = app.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} not found`);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
};
const arrow = (name) => {
  const start = app.indexOf(`  const ${name} = `);
  assert.notEqual(start, -1, `${name} not found`);
  return app.slice(start, app.indexOf('\n  };', start) + 5);
};

function kickoffContext({ draft = '', blocker = null, full = 'unused' } = {}) {
  const input = { value: draft, focus() {}, setSelectionRange() {}, scrollTop: 40 };
  const objective = { value: '' };
  const calls = { confirm: 0, fetched: 0, flash: [] };
  const c = {
    t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])),
    NAMES: { codex: 'Codex', claude: 'Claude' },
    st: { currentRoomId: 'room-1', expanded: new Map(), composer: { work: false } },
    control: () => ({ room: { id: 'room-1', lifecycle: 'open' } }),
    workBlocker: () => blocker,
    fullText: async () => { calls.fetched += 1; return { ok: true, text: full }; },
    $: (id) => (id === 'input' ? input : objective),
    askConfirm: async () => { calls.confirm += 1; return true; },
    onInput() {}, flash: (text, tone = 'info') => calls.flash.push([text, tone]),
    fmtTime: () => '11:03', codePoints: (s) => [...s].length,
  };
  vm.createContext(c);
  vm.runInContext([arrow('snippet'), fn('planObjective'), fn('kickoffWith')].join('\n'), c);
  return { c, input, objective, calls };
}
const reply = (content) => ({ agent: 'claude', committedAt: '2026-09-29T11:03:00Z', content });

test('Kick off with this plan puts the reply’s full text in the composer, in work mode, and sends nothing', async () => {
  const plan = '## Export in the window language\n\n1. Add ?lang to the export\n2. Keep the conversation as written\n' + 'detail '.repeat(400);
  const k = kickoffContext({ full: plan });
  await k.c.kickoffWith({ id: 'item-9', attachments: [] }, reply({ previewText: plan.slice(0, 80), truncated: true, attachmentId: 'att-1', format: 'markdown' }));
  assert.equal(k.calls.fetched, 1, 'a truncated preview is never used as the scope');
  assert.equal(k.input.value, `按 Claude 在 11:03 的这份方案开工：\n\n${plan}`, 'the whole reply, as written');
  assert.equal(k.objective.value, 'Export in the window language', 'the goal is its first line, cleaned');
  assert.equal(k.c.st.composer.work, true);
  assert.equal(k.calls.confirm, 0, 'an empty composer is simply filled');
});

test('a draft is replaced only after asking; a blocked room or an oversized reply changes nothing', async () => {
  const withDraft = kickoffContext({ draft: 'my own notes' });
  await withDraft.c.kickoffWith({ id: 'item-9' }, reply({ previewText: 'Plan A', truncated: false }));
  assert.equal(withDraft.calls.confirm, 1);
  assert.equal(withDraft.input.value, '按 Claude 在 11:03 的这份方案开工：\n\nPlan A');

  const blocked = kickoffContext({ draft: 'keep me', blocker: '本群已有进行中的任务：X' });
  await blocked.c.kickoffWith({ id: 'item-9' }, reply({ previewText: 'Plan B', truncated: false }));
  assert.equal(blocked.input.value, 'keep me');
  assert.equal(blocked.c.st.composer.work, false);
  assert.deepEqual(blocked.calls.flash, [['不能开工：本群已有进行中的任务：X', 'warn']]);

  const long = kickoffContext();
  await long.c.kickoffWith({ id: 'item-9' }, reply({ previewText: 'x'.repeat(32001), truncated: false }));
  assert.equal(long.input.value, '');
  assert.equal(long.calls.flash[0][1], 'warn');
});

test('a plan without a usable first line gets a plain goal', () => {
  const { c } = kickoffContext();
  assert.equal(c.planObjective('---\n\n**Goal:** add the export language\nmore', 'codex'), 'Goal: add the export language');
  assert.equal(c.planObjective('```\n```\n', 'claude'), '按 Claude 的方案执行');
});

test('opening the discuss popover focuses Start discussion, or Close when it cannot start', () => {
  const focused = [];
  const button = (name) => ({ focus: () => focused.push(name) });
  const run = (startEnabled, info = { mode: 'ready', cand: { baseMessageId: 'msg-7' } }) => {
    focused.length = 0;
    const pop = { querySelector: (sel) => (sel === '.dp-foot .primary:not(:disabled)' ? (startEnabled ? button('start') : null) : sel === '.dp-close' ? button('close') : null) };
    const c = {
      st: { composer: { discussOpen: false, discussTarget: null } },
      discussionInfo: () => info, control: () => ({}), renderComposer() {},
      $: (id) => (id === 'discuss-pop' ? pop : button(id)),
    };
    vm.createContext(c);
    vm.runInContext(fn('setDiscussOpen'), c);
    c.setDiscussOpen(true);
    const opened = [...focused];
    c.setDiscussOpen(false, true);
    return { opened, closed: focused.slice(opened.length), target: c.st.composer.discussTarget };
  };
  assert.deepEqual(run(true).opened, ['start'], 'ready: Enter starts the discussion');
  assert.deepEqual(run(false, { mode: 'blocked', cand: { baseMessageId: 'msg-7' } }).opened, ['close'], 'nothing to start: Close, so Enter or Esc just closes');
  assert.deepEqual(run(true).closed, ['discuss-toggle'], 'closing with the keyboard returns focus to the button');
});
