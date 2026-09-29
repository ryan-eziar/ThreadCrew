// Updates in the window: which line the notice bar shows for the broker's UpdateState, what the install
// screen says in each phase, and what counts as still pending. Runs the real functions from
// ui/app-v2.js without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const extract = (name) => {
  const start = app.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} not found`);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
};
const constant = (name) => {
  const start = app.indexOf(`  const ${name} = `);
  assert.notEqual(start, -1, `${name} not found`);
  return app.slice(start, app.indexOf(';\n', start) + 2);
};

function context(extra = {}) {
  const c = {
    t: (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => String(args[k])),
    updateErrorText: (code) => `E:${code}`,
    NAMES: { codex: 'Codex', claude: 'Claude' },
    st: { updates: null },
    ...extra,
  };
  vm.createContext(c);
  vm.runInContext([constant('INSTALL_ACTIVE'), constant('INSTALL_DONE'), constant('UNCERTAIN_UPDATE'), constant('QUIT_COUNTS'), constant('busyCounts'), constant('isBusy'),
    constant('FIRST_CHECK_WAITS'), extract('followFirstCheck'), extract('busyRoomText'), extract('updateBanner'), extract('installView')].join('\n')
    + '\nthis.busyCounts = busyCounts; this.isBusy = isBusy; this.QUIT_COUNTS = QUIT_COUNTS;', c);
  return c;
}

const state = (extra = {}) => ({
  installedVersion: '0.2.2', latestVersion: '0.2.3', checkState: 'available', checkedAt: '2026-10-01T00:00:00Z',
  autoCheckUpdates: true, releaseUrl: 'https://github.com/ryan-eziar/ThreadCrew/releases/tag/v0.2.3', releaseNotes: 'Notes',
  installSupported: true, installUnsupportedReason: null, errorCode: null, install: null, ...extra,
});
const job = (st, extra = {}) => ({ operationId: 'op-1', version: '0.2.3', state: st, startedAt: 'x', updatedAt: 'y', errorCode: null, ...extra });

test('the notice bar offers an available release until "later" for that version', () => {
  const c = context();
  assert.equal(c.updateBanner(null, null, null), null, 'nothing before the first answer');
  assert.deepEqual({ ...c.updateBanner(state(), null, null) }, { kind: 'available', version: '0.2.3' });
  assert.equal(c.updateBanner(state(), null, '0.2.3'), null, 'said "later" to this version');
  assert.equal(c.updateBanner(state(), null, '0.2.2').kind, 'available', '"later" to an older version does not hide a newer one');
  for (const checkState of ['idle', 'checking', 'current', 'error']) assert.equal(c.updateBanner(state({ checkState }), null, null), null, checkState);
});

test('an install outcome is shown once, until acknowledged, before any release offer', () => {
  const c = context();
  for (const outcome of ['completed', 'failed', 'rolled_back']) {
    const u = state({ checkState: 'current', latestVersion: '0.2.3', installedVersion: outcome === 'completed' ? '0.2.3' : '0.2.2', install: job(outcome) });
    assert.equal(c.updateBanner(u, null, null).kind, outcome);
    assert.equal(c.updateBanner(u, 'op-1', null), null, `${outcome} acknowledged`);
    assert.equal(c.updateBanner(u, 'op-other', null).kind, outcome, 'another operation’s acknowledgement does not count');
  }
  const failedButNewer = state({ install: job('failed') });
  assert.equal(c.updateBanner(failedButNewer, 'op-1', null).kind, 'available', 'after acknowledging a failure, the release is offered again');
});

test('while an install runs, the notice bar says nothing: the install screen does', () => {
  const c = context();
  for (const running of ['downloading', 'verifying', 'stopping', 'installing', 'restarting']) {
    assert.equal(c.updateBanner(state({ install: job(running) }), null, null), null, running);
  }
});

const follow = (phase, extra = {}) => ({ operationId: 'op-1', version: '0.2.3', phase, own: true, lost: false, errorCode: null, ...extra });

test('each running phase shows the steps; a lost connection is "restarting", never "updated"', () => {
  const c = context();
  for (const phase of ['requesting', 'downloading', 'verifying', 'stopping', 'installing', 'restarting']) {
    const v = c.installView(follow(phase));
    assert.equal(v.busy, true, phase);
    assert.equal(v.steps, true, phase);
    assert.equal(v.actions.length, 0, `${phase}: nothing to click while it runs`);
    assert.ok(v.title.includes('0.2.3'));
  }
  const lost = c.installView(follow('restarting', { lost: true }));
  assert.ok(lost.lines.some((l) => l && l.includes('重新启动')) && lost.lines.some((l) => l && l.includes('快捷方式')));
  assert.ok(!lost.title.includes('已更新'), 'no claim of success without the new service’s answer');
  assert.ok(c.installView(follow('downloading', { own: false })).lines.some((l) => l && l.includes('另一个窗口')));
});

test('final phases say what happened and offer only what makes sense', () => {
  const c = context();
  const keys = (v) => [...v.actions.map(([k]) => k)]; // an array of this realm, for deepEqual
  assert.deepEqual(keys(c.installView(follow('completed'))), ['reload']);
  const failed = c.installView(follow('failed', { errorCode: 'UPDATE_CHECKSUM_FAILED' }));
  assert.deepEqual(keys(failed), ['back'], 'the old version still runs: back to it');
  assert.ok(failed.lines.some((l) => l && l.includes('E:UPDATE_CHECKSUM_FAILED')));
  for (const errorCode of ['UPDATE_ROLLBACK_FAILED', 'UPDATE_INTERRUPTED']) {
    const uncertain = c.installView(follow('failed', { errorCode }));
    assert.ok(!uncertain.lines.some((l) => l && l.includes('还在用原来的版本')), `${errorCode}: never claims the old version runs`);
    assert.ok(uncertain.lines.some((l) => l && l.includes('快捷方式')), `${errorCode}: says to reopen from the shortcut`);
    assert.deepEqual(keys(uncertain), ['reload']);
  }
  assert.deepEqual(keys(c.installView(follow('rolled_back'))), ['reload'], 'a restarted service: reload');
  assert.deepEqual(keys(c.installView(follow('restarted'))), ['reload']);
  assert.deepEqual(keys(c.installView(follow('not_started'))), ['back', 'retry'], 'the request never arrived: nothing changed');
  assert.deepEqual(keys(c.installView(follow('unknown'))), ['reload']);
});

test('the update preview names the busy rooms and what is pending in each', () => {
  const c = context();
  assert.equal(c.isBusy(null), false);
  assert.equal(c.isBusy({ counts: {}, rooms: [] }), false);
  assert.equal(c.isBusy({ counts: { queuedDeliveries: 1 }, rooms: [] }), true, 'the counts alone still say busy');
  const room = { roomId: 'room-1', roomName: 'blog-engine', agents: ['codex', 'claude'], unresolvedDeliveries: 2, queuedDeliveries: 0, activeWork: true };
  assert.equal(c.isBusy({ counts: {}, rooms: [room] }), true);
  assert.equal(c.busyRoomText(room), '「blog-engine」 · 2 份等回复 · 有进行中的协作任务', 'members are not named as the busy ones');
  assert.equal(c.busyRoomText({ roomId: 'room-2', agents: [], unresolvedDeliveries: 0, queuedDeliveries: 3, activeWork: false }),
    '「room-2」 · 3 份排队', 'no name: the ID; nothing empty is listed');
  assert.equal(c.busyRoomText({ roomId: 'room-3', roomName: 'x', agents: ['codex'], unresolvedDeliveries: 0, queuedDeliveries: 0, pendingWorkRequests: 2, activeWork: false }),
    '「x」 · 2 个协作请求没完成');
  assert.equal(c.busyRoomText({ roomId: 'room-4', roomName: 'y', agents: [], unresolvedDeliveries: 0, queuedDeliveries: 0, activeWork: false }),
    '「y」 · 还有没完成的事', 'busy for a reason not counted here: still said, never an empty line');
});

test('after loading, the page follows the broker’s first check with a few cached reads until it settles', async () => {
  const states = [state({ checkState: 'checking', latestVersion: null }), state({ checkState: 'available' })];
  const waits = [];
  const c = context();
  c.st.updates = state({ checkState: 'idle', latestVersion: null });
  let reads = 0;
  await c.followFirstCheck(async () => { c.st.updates = states[reads++]; }, async (ms) => { waits.push(ms); });
  assert.equal(reads, 2, 'idle → checking → available, then no more reads');
  assert.deepEqual(waits, [3000, 5000]);
});

test('with automatic checks off, or a settled state, nothing more is read; a check that never settles stops', async () => {
  for (const u of [state({ checkState: 'idle', autoCheckUpdates: false }), state({ checkState: 'current' }), state({ checkState: 'error' }), null]) {
    const c = context();
    c.st.updates = u;
    let reads = 0;
    await c.followFirstCheck(async () => { reads += 1; }, async () => {});
    assert.equal(reads, 0, JSON.stringify(u && [u.checkState, u.autoCheckUpdates]));
  }
  const c = context();
  c.st.updates = state({ checkState: 'checking' });
  let reads = 0;
  await c.followFirstCheck(async () => { reads += 1; }, async () => {});
  assert.equal(reads, 4, 'bounded: four cached reads over about half a minute, then it stops');
});

test('pending work comes from the Quit preview’s counts, only where there is some', () => {
  const c = context();
  assert.deepEqual([...c.busyCounts(null)], []);
  assert.deepEqual([...c.busyCounts({ counts: {} })], []);
  const busy = c.busyCounts({ counts: { activeWorkRooms: 1, queuedDeliveries: 0, uncertainDeliveries: 2 } }).map(([k]) => k);
  assert.deepEqual([...busy], ['activeWorkRooms', 'uncertainDeliveries']);
});
