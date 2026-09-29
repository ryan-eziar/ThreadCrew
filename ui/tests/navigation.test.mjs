// Navigation state in the v2 window, run on the real functions from ui/app-v2.js in a VM against
// a fake broker whose pages are cut by count (standing in for the 256 KB cap), so page ends fall
// anywhere. No browser, no network, no model. After Codex's review probe
// (work/review-navigation-races.mjs), with its cases kept and more added.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const NAMES = ['sortEntries', 'applyPage', 'extendPage', 'mergeEntry', 'setWindowToEnd', 'fillForward', 'trimHead',
  'recoverBefore', 'olderPage', 'fetchOlder', 'jumpToStart', 'trimCache', 'loadNewer', 'backToLatest', 'reloadView',
  'refreshRoom', 'resyncRoom', 'readerPosition', 'landAt', 'applyRoomDelta', 'onScroll', 'olderStep', 'newerStep'];
const extract = (name) => {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} not found`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
const code = NAMES.map(extract).join('\n');
const constant = (name) => Number(source.match(new RegExp(`const ${name} = (\\d+);`))[1]);

const item = (order) => ({ id: `i${order}`, order, version: 1, kind: 'message' });
const span = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => item(a + i));
const orders = (v) => v.sorted.map((e) => e.order);
const contiguous = (list, from, to) => list.length === to - from + 1 && list.every((n, i) => n === from + i);

// A broker with `total` entries and pages of `size` entries. `gate(kind)` may return a promise to
// hold a call; `fail(kind)` may return an error result for it.
function broker(total, size, { gate = () => null, fail = () => null } = {}) {
  const page = (a, b, extra = {}) => ({
    items: span(a, b), firstOrder: a, lastOrder: b,
    nextBeforeCursor: a > 1 ? `before:${a}` : null, nextAfterCursor: b < total ? `after:${b}` : null, ...extra,
  });
  const latest = () => page(Math.max(1, total - size + 1), total);
  const hold = async (kind) => { const g = gate(kind); if (g) await g; };
  return {
    calls: [],
    streams: [],  // room streams opened: { cursor, handlers, closed }
    catalogs: [], // catalog streams opened
    roomStream(roomId, cursor, handlers) {
      const stream = { cursor, handlers, closed: false };
      this.streams.push(stream);
      return { close() { stream.closed = true; } };
    },
    catalogStream(cursor, handlers) {
      const stream = { cursor, handlers, closed: false };
      this.catalogs.push(stream);
      return { close() { stream.closed = true; } };
    },
    async view() {
      this.calls.push('view');
      await hold('view');
      const f = fail('view');
      if (f) return f;
      return { ok: true, status: 200, result: { page: latest(), control: { serverTime: new Date().toISOString() }, revision: 2, eventCursor: 'fresh' } };
    },
    async timeline(roomId, q) {
      this.calls.push(JSON.stringify(q));
      await hold(q.around ? 'around' : 'timeline');
      const f = fail(q.around ? 'around' : 'timeline');
      if (f) return f;
      if (q.before) { const o = Number(q.before.split(':')[1]); return { ok: true, result: page(Math.max(1, o - size), o - 1) }; }
      if (q.after) { const o = Number(q.after.split(':')[1]); return { ok: true, result: page(o + 1, Math.min(total, o + size)) }; }
      if (q.around) {
        const t = Number(String(q.around).slice(1));
        if (!(t >= 1 && t <= total)) return { ok: false, status: 404, error: { code: 'NOT_FOUND' } };
        const a = Math.max(1, t - Math.floor(size / 2));
        return { ok: true, result: page(a, Math.min(total, a + size - 1), { targetItemId: `i${t}` }) };
      }
      return { ok: true, result: latest() };
    },
  };
}

// The window's state around one open room showing the latest page of `total` entries. The room
// and catalog streams are stubs unless `options.real` names them (connectRoom, connectCatalog).
function room(total, size, options = {}) {
  const src = broker(total, size, options);
  const first = Math.max(1, total - size + 1);
  const v = {
    roomId: 'r', control: {}, entries: new Map(span(first, total).map((e) => [e.id, e])), sorted: span(first, total),
    revision: 1, eventCursor: 'old', nextBeforeCursor: first > 1 ? `before:${first}` : null, nextAfterCursor: null,
    detached: false, win: { start: 0, end: total - first + 1 }, newCount: 0, stick: true, cache: new Map(),
    loading: false, headTrimmed: false, epoch: 1, resyncing: false,
  };
  const timeline = { scrollTop: 321, querySelector: () => null, getBoundingClientRect: () => ({ top: 0 }) };
  const c = {
    Map, Date, Math, Number, String, Boolean, JSON, Infinity, Promise,
    CACHE: constant('CACHE'), WINDOW: constant('WINDOW'), BACKOFF_S: [1, 2, 4, 8, 15],
    v, src, timeline, navGen: 0, landGen: 0, landing: null, roomStream: { close() { c.closed += 1; } }, roomStreamGen: 0,
    clockOffset: 0, closed: 0, connected: 0, slept: 0, anchor: null,
    st: { currentRoomId: 'r', openGen: 1, jumping: false, conn: { room: 'live', catalog: 'live' }, catalog: { rooms: new Map(), cursor: 'cat' }, views: new Map() },
    catalogStream: null, loadCatalog: async () => true, applyCatalogDelta() {}, resyncCatalog() {},
    document: { visibilityState: 'visible' }, CSS: { escape: (x) => x },
    $: () => timeline, render() {}, updateJumps() {}, updateRailActive() {}, flash() {}, errorText: (x) => x,
    forgetEntries() {}, attentionChanged() {}, schedulePosition() {}, scheduleReadPosition() {},
    setTimeout: () => 0, clearTimeout() {}, // the reconnect re-renders are not part of navigation
    exiting: () => false, applyShutdown() {}, // quitting is covered in exit.test.mjs
  };
  c.view = () => c.v;
  c.anchorInfo = () => c.anchor;
  c.connectRoom = () => { c.connected += 1; };
  c.sleep = async () => { c.slept += 1; };
  c.beginNav = () => { c.navGen += 1; c.landGen += 1; return c.landGen; };
  vm.createContext(c);
  vm.runInContext(options.real ? NAMES.concat(options.real).map(extract).join('\n') : code, c);
  return c;
}

// Read down to the live tail the way a reader does: the view sits at the bottom and each scroll event
// goes through the window's own handler (window steps, then pages loaded).
async function scrollToTail(c) {
  Object.assign(c.timeline, { scrollTop: 1000, scrollHeight: 1100, clientHeight: 100 });
  for (let n = 0; n < 400 && (c.v.detached || c.v.win.end < c.v.sorted.length); n++) {
    c.onScroll();
    for (let k = 0; k < 50 && (k === 0 || c.v.loading); k++) await new Promise((r) => setTimeout(r, 0));
  }
}

const deferred = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };

for (const [total, size] of [[300, 37], [520, 37], [600, 37], [700, 37], [700, 100], [1234, 41]]) {
  test(`jump to start, then scroll down: ${total} entries in pages of ${size}`, async () => {
    const c = room(total, size);
    await c.jumpToStart(c.v);
    const start = orders(c.v);
    assert.ok(contiguous(start, 1, start.length), 'the cache is the first run of entries');
    assert.equal(start.length, Math.min(total, c.CACHE));
    assert.equal(c.v.detached, start.length < total);
    assert.equal(c.timeline.scrollTop, 0);
    assert.equal(c.st.jumping, false);
    await scrollToTail(c);
    assert.ok(contiguous(orders(c.v), 1, total), 'scrolling down reaches the end with nothing skipped');
    assert.equal(c.v.detached, false);
  });
}

test('paging back past the cap, then down again: no entries skipped', async () => {
  const c = room(900, 37);
  for (let n = 0; n < 30 && c.v.nextBeforeCursor; n++) await c.fetchOlder(c.v);
  assert.equal(c.v.sorted[0].order, 1);
  assert.equal(c.v.detached, true);
  assert.ok(c.v.sorted.length <= c.CACHE);
  await scrollToTail(c);
  assert.ok(contiguous(orders(c.v), 1, 900));
});

test('a cut cache reads on through the page around its last entry (Codex #8.2)', async () => {
  const c = room(700, 37);
  await c.jumpToStart(c.v);
  assert.ok(contiguous(orders(c.v), 1, 500));
  assert.equal(c.v.nextAfterCursor, null);
  c.src.calls.length = 0;
  await c.loadNewer(c.v);
  assert.deepEqual(c.src.calls, [JSON.stringify({ around: 'i500' })], 'no cursor is made up');
  assert.ok(contiguous(orders(c.v), 1, 518));
  assert.equal(c.v.nextAfterCursor, 'after:518');
});

test('reading far up while the room keeps talking: nothing is skipped on the way down', async () => {
  const c = room(850, 37);
  c.v.sorted = span(1, 800);
  c.v.entries = new Map(c.v.sorted.map((e) => [e.id, e]));
  Object.assign(c.v, { nextBeforeCursor: null, nextAfterCursor: null, detached: false, stick: false, win: { start: 0, end: 300 } });
  for (let o = 801; o <= 850; o++) {
    c.applyRoomDelta(c.v, { roomId: 'r', fromRevision: o - 800, toRevision: o - 799, eventCursor: `e${o}`, upsertEntries: [item(o)] });
  }
  assert.equal(c.v.detached, true);
  assert.equal(c.v.newCount, 50);
  assert.equal(c.v.sorted.at(-1).order, 800);
  await scrollToTail(c);
  assert.ok(contiguous(orders(c.v), 1, 850));
  assert.equal(c.v.detached, false);
});

test('a cut cache whose last entry left the history goes back to the latest', async () => {
  const c = room(700, 37, { fail: (kind) => (kind === 'around' ? { ok: false, status: 404, error: { code: 'NOT_FOUND' } } : null) });
  await c.jumpToStart(c.v);
  await c.loadNewer(c.v);
  assert.ok(contiguous(orders(c.v), 664, 700));
  assert.equal(c.v.detached, false);
});

test('a walk to the start cancelled by a newer jump leaves the cache as it was', async () => {
  const hold = deferred();
  const c = room(300, 37, { gate: (kind) => (kind === 'timeline' ? hold.promise : null) });
  const before = JSON.stringify(c.v.sorted);
  const walk = c.jumpToStart(c.v);
  c.beginNav();
  hold.release();
  await walk;
  assert.equal(JSON.stringify(c.v.sorted), before);
  assert.equal(c.timeline.scrollTop, 321);
  assert.equal(c.st.jumping, false);
});

test('an explicit reload cancelled on return applies nothing', async () => {
  const c = room(300, 37);
  assert.equal(await c.reloadView(c.v, () => false), false);
  assert.equal(c.v.revision, 1);
});

test('resync while following the latest: stays at the latest and reconnects', async () => {
  const c = room(300, 37);
  await c.resyncRoom(c.v);
  assert.equal(c.v.stick, true);
  assert.equal(c.v.revision, 2);
  assert.equal(c.v.win.end, c.v.sorted.length);
  assert.equal(c.connected, 1);
  assert.equal(c.closed, 1);
});

test('a jump made during a resync is kept (Codex #8.1)', async () => {
  const hold = deferred();
  const c = room(300, 37, { gate: (kind) => (kind === 'view' ? hold.promise : null) });
  const resync = c.resyncRoom(c.v);
  // The reader jumps to entry 280 (in the cached latest page) while the view is loading.
  c.beginNav();
  c.v.stick = false;
  c.anchor = { id: 'i280', offset: 24 };
  hold.release();
  await resync;
  const at = c.v.sorted.findIndex((e) => e.id === 'i280');
  assert.ok(at >= c.v.win.start && at < c.v.win.end, 'the jump target is in the rendered window');
  assert.equal(c.v.stick, false);
  assert.equal(c.v.revision, 2, 'the fresh data was applied');
  assert.equal(c.connected, 1, 'the stream is reconnected');
});

test('a reader up in the history is refreshed around their entry', async () => {
  const hold = deferred();
  const c = room(300, 37, { gate: (kind) => (kind === 'view' ? hold.promise : null) });
  const resync = c.resyncRoom(c.v);
  c.beginNav();
  c.v.stick = false;
  c.anchor = { id: 'i120', offset: 40 };
  hold.release();
  await resync;
  assert.ok(c.v.entries.has('i120'));
  const at = c.v.sorted.findIndex((e) => e.id === 'i120');
  assert.ok(at >= c.v.win.start && at < c.v.win.end);
  assert.equal(c.v.detached, true);
  assert.ok(contiguous(orders(c.v), c.v.sorted[0].order, c.v.sorted.at(-1).order));
  assert.equal(c.connected, 1);
});

test('a second jump while the refresh fetches the first one wins', async () => {
  const hold = deferred();
  let arounds = 0;
  const c = room(300, 37, { gate: (kind) => (kind === 'around' && ++arounds === 1 ? hold.promise : null) });
  c.v.stick = false;
  c.anchor = { id: 'i120', offset: 0 };
  const resync = c.resyncRoom(c.v);
  await new Promise((r) => setTimeout(r, 0));
  c.beginNav();
  c.anchor = { id: 'i40', offset: 0 };
  hold.release();
  await resync;
  const at = c.v.sorted.findIndex((e) => e.id === 'i40');
  assert.ok(at >= c.v.win.start && at < c.v.win.end);
  assert.equal(c.connected, 1);
});

test('a rail jump still landing counts as being at its target', async () => {
  const c = room(300, 37);
  c.v.stick = false;
  c.anchor = { id: 'i299', offset: 0 };
  c.landing = { roomId: 'r', id: 'i100', land: c.beginNav() };
  await c.resyncRoom(c.v);
  const at = c.v.sorted.findIndex((e) => e.id === 'i100');
  assert.ok(at >= c.v.win.start && at < c.v.win.end);
});

test('a failed resync retries with backoff and then reconnects', async () => {
  let failures = 1;
  const c = room(300, 37, { fail: (kind) => (kind === 'view' && failures-- > 0 ? { ok: false, status: 0, error: { code: 'NETWORK' } } : null) });
  await c.resyncRoom(c.v);
  assert.equal(c.slept, 1);
  assert.equal(c.v.revision, 2);
  assert.equal(c.connected, 1);
  assert.equal(c.v.resyncing, false);
});

test('a refused credential stops the resync without a retry loop', async () => {
  const c = room(300, 37, { fail: (kind) => (kind === 'view' ? { ok: false, status: 401, error: { code: 'UNAUTHORIZED' } } : null) });
  await c.resyncRoom(c.v);
  assert.equal(c.st.conn.room, 'auth');
  assert.equal(c.slept, 0);
  assert.equal(c.connected, 0);
});

test('a reader whose entry is gone from the history lands at the latest', async () => {
  const c = room(300, 37);
  c.v.stick = false;
  c.anchor = { id: 'i999', offset: 0 };
  await c.resyncRoom(c.v);
  assert.equal(c.v.stick, true);
  assert.equal(c.v.sorted.at(-1).order, 300);
  assert.equal(c.connected, 1);
});

test('only one resync runs at a time', async () => {
  const hold = deferred();
  const c = room(300, 37, { gate: (kind) => (kind === 'view' ? hold.promise : null) });
  const first = c.resyncRoom(c.v);
  const second = c.resyncRoom(c.v);
  hold.release();
  await Promise.all([first, second]);
  assert.equal(c.src.calls.filter((x) => x === 'view').length, 1);
  assert.equal(c.connected, 1);
});

test('only resyncRoom refreshes a room, so no delta can land in the middle of a refresh (Codex #9)', () => {
  const everywhere = source.match(/\brefreshRoom\(/g).length - 1; // less the definition
  assert.equal(everywhere, extract('resyncRoom').match(/\brefreshRoom\(/g).length);
});

test('the catalog back while the room stream is live: one resync, the old stream ignored, resumed from the fresh view (Codex #9)', async () => {
  const hold = deferred();
  const c = room(300, 37, { real: ['connectRoom', 'connectCatalog'], gate: (kind) => (kind === 'view' ? hold.promise : null) });
  c.roomStream = null;
  c.connectRoom(c.v);
  const live = c.src.streams.at(-1);
  live.handlers.onOpen();
  assert.equal(c.st.conn.room, 'live');
  c.connectCatalog();
  const recovered = c.src.catalogs.at(-1).handlers.onEnd('error'); // the catalog drops and comes back
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(live.closed, true, 'the room stream is closed before the refresh');
  // While the fresh view loads, the old room stream still delivers a delta, and Ryan's own action
  // asks for a sync too: neither may land on top of, or duplicate, the refresh.
  live.handlers.onEvent('room.delta', { roomId: 'r', fromRevision: 1, toRevision: 3, eventCursor: 'delta-3',
    control: { serverTime: new Date().toISOString(), marker: 'stale' }, upsertEntries: [] });
  c.resyncRoom(c.v);
  assert.equal(c.v.revision, 1);
  hold.release();
  await recovered;
  for (let k = 0; k < 20 && c.v.resyncing; k++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.src.calls.filter((x) => x === 'view').length, 1, 'one refresh for both entries');
  assert.equal(c.v.revision, 2);
  assert.equal(c.v.control.marker, undefined);
  const resumed = c.src.streams.at(-1);
  assert.notEqual(resumed, live);
  assert.equal(resumed.cursor, 'fresh', 'the stream resumes from the fresh view, so revision 3 comes through it');
  assert.equal(c.src.catalogs.length, 2, 'the catalog stream reopened');
});
