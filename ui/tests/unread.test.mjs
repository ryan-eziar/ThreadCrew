// Unread replies: what counts as seen, what the broker counts as unread, and where the "new
// messages" line goes. Runs the real functions from ui/app-v2.js without a browser.
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
  const c = { ...extra };
  vm.createContext(c);
  vm.runInContext([constant('countsUnread'), extract('firstUnread'), extract('seenThrough'), extract('jumpToUnread')].join('\n')
    + '\nthis.countsUnread = countsUnread;', c);
  return c;
}

const VIEW_BOTTOM = 800;

test('a reply taller than the window counts once its end is on screen, not before', () => {
  const c = context();
  // order 10 is 1500 px tall: its top is far above the view.
  assert.equal(c.seenThrough([{ order: 9, bottom: -700 }, { order: 10, bottom: 1200 }], VIEW_BOTTOM), 9, 'end still below the view');
  assert.equal(c.seenThrough([{ order: 9, bottom: -1100 }, { order: 10, bottom: 790 }], VIEW_BOTTOM), 10, 'end in view: read through it');
});

test('everything above the view is read through; what runs off the bottom is not', () => {
  const c = context();
  const items = [{ order: 3, bottom: 100 }, { order: 4, bottom: 500 }, { order: 5, bottom: 801 }, { order: 6, bottom: 960 }];
  assert.equal(c.seenThrough(items, VIEW_BOTTOM), 5, 'within a pixel of the bottom counts');
  assert.equal(c.seenThrough([], VIEW_BOTTOM), 0);
});

test('the broker’s unread kinds: replies, work answers and a participant reporting completed', () => {
  const c = context();
  assert.equal(c.countsUnread({ kind: 'reply' }), true);
  assert.equal(c.countsUnread({ kind: 'work', work: { eventKind: 'response' } }), true);
  assert.equal(c.countsUnread({ kind: 'work', work: { eventKind: 'participant_state', workState: 'completed' } }), true);
  for (const e of [{ kind: 'message' }, { kind: 'system' }, { kind: 'work', work: { eventKind: 'progress' } },
    { kind: 'work', work: { eventKind: 'participant_state', workState: 'working' } }, { kind: 'work', work: null }]) {
    assert.equal(c.countsUnread(e), false, JSON.stringify(e));
  }
});

test('the "new messages" line goes above the first unread kind after the read position at opening', () => {
  const c = context();
  const sorted = [
    { id: 'a', order: 5, kind: 'reply' },
    { id: 'b', order: 6, kind: 'message' },
    { id: 'c', order: 7, kind: 'work', work: { eventKind: 'progress' } },
    { id: 'd', order: 8, kind: 'work', work: { eventKind: 'participant_state', workState: 'completed' } },
    { id: 'e', order: 9, kind: 'reply' },
  ];
  assert.equal(c.firstUnread({ unreadFrom: 5, sorted }).id, 'd', 'Ryan’s message and a progress note are not unread');
  assert.equal(c.firstUnread({ unreadFrom: 4, sorted }).id, 'a');
  assert.equal(c.firstUnread({ unreadFrom: 9, sorted }), null, 'nothing after it');
  assert.equal(c.firstUnread({ unreadFrom: null, sorted }), null, 'opened with nothing unread');
  assert.equal(c.firstUnread(null), null);
});

test('the broker’s locator, when given, decides the first unread entry', () => {
  const c = context();
  const sorted = [{ id: 'a', order: 5, kind: 'reply' }, { id: 'b', order: 6, kind: 'reply' }];
  const entries = new Map(sorted.map((e) => [e.id, e]));
  assert.equal(c.firstUnread({ unreadFrom: 4, unreadLoc: { timelineItemId: 'b' }, sorted, entries }).id, 'b');
  assert.equal(c.firstUnread({ unreadFrom: 4, unreadLoc: { timelineItemId: 'far' }, sorted, entries }), null,
    'not loaded: nothing to draw the line at yet (the landing fetches around it)');
});

// Opening a room at its first unread: the real landUnread / postReadPosition / readerMoved with a
// fake timeline, timers run by hand, and an around fetch the test resolves (or never does).
function landingHarness() {
  const posts = [];
  const timers = [];
  let current = null;
  let finishAround = null;
  const tl = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 800 }), querySelectorAll: () => (current ? current.dom : []) };
  const c = {
    Math, Number, Boolean, Promise, Map, Date,
    st: { catalog: { rooms: new Map() }, updateFollow: null },
    view: () => current, exiting: () => false, uuid: () => 'op',
    document: { visibilityState: 'visible', hasFocus: () => true },
    $: (id) => (id === 'timeline' ? tl : null),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    jumpTo: () => new Promise((done) => { finishAround = done; }),
    jumpToEntry: (v, id, opts) => { v.jumped = [id, Boolean(opts && opts.instant)]; },
    highlight: () => {},
    src: { roomPath: (id) => `/rooms/${id}`, post: async (path, body) => { posts.push([path, body.throughOrder]); return { ok: true }; } },
  };
  vm.createContext(c);
  vm.runInContext('let readTimer = null;\n' + [constant('countsUnread'), extract('firstUnread'), extract('seenThrough'), extract('scheduleReadPosition'),
    extract('postReadPosition'), extract('landUnread'), extract('showUnreadLine'), extract('readerMoved'), extract('jumpToUnread')].join('\n'), c);
  const runTimers = async () => { while (timers.length) await timers.shift()(); };
  return { c, posts, timers, runTimers, open: (v) => { current = v; }, finishAround: () => finishAround && finishAround() };
}
const tail = { id: 'tail', order: 421, kind: 'work', work: { eventKind: 'participant_state', workState: 'completed' } };
const roomView = (roomId, extra = {}) => ({
  roomId, control: {}, readPosted: 0, readSending: 0, unreadFrom: 419, sorted: [tail], entries: new Map([['tail', tail]]),
  unreadLoc: { timelineItemId: 'first', timelineOrder: 300, aroundCursor: 'around-300' }, unreadLanding: { state: 'waiting' },
  dom: [{ dataset: { id: 'tail' }, getBoundingClientRect: () => ({ bottom: 500 }) }], ...extra,
});

test('while the around page for the first unread is pending, the visible latest tail is not acknowledged', async () => {
  const h = landingHarness();
  const v = roomView('r1');
  h.open(v);
  h.c.landUnread(v);
  assert.equal(v.unreadLanding.state, 'fetching');
  const fetching = h.timers.shift()();
  await h.c.postReadPosition();
  assert.deepEqual(h.posts, [], 'nothing counted while the around page is on its way (the reproduction acknowledged 421)');
  // The around page arrives and shows the first unread; reading starts there.
  const first = { id: 'first', order: 300, kind: 'reply' };
  v.entries.set('first', first);
  v.sorted = [first, tail];
  v.dom = [{ dataset: { id: 'first' }, getBoundingClientRect: () => ({ bottom: 500 }) }, { dataset: { id: 'tail' }, getBoundingClientRect: () => ({ bottom: 1600 }) }];
  h.finishAround();
  await fetching;
  assert.equal(v.unreadLanding, null);
  await h.runTimers();
  assert.deepEqual(h.posts.map((p) => [...p]), [['/rooms/r1/read-position', 300]], 'read through what is on screen, not the tail below');
});

test('a failed around fetch keeps counting nothing until the reader moves', async () => {
  const h = landingHarness();
  const v = roomView('r1');
  h.open(v);
  h.c.landUnread(v);
  const fetching = h.timers.shift()();
  h.finishAround(); // the page never brought the target
  await fetching;
  assert.equal(v.unreadLanding.state, 'failed');
  await h.c.postReadPosition();
  assert.deepEqual(h.posts, [], 'no fail-open to the latest tail');
  h.c.readerMoved(); // the reader scrolls: reading goes on from where they are
  assert.equal(v.unreadLanding, null);
  await h.runTimers();
  assert.deepEqual(h.posts.map((p) => [...p]), [['/rooms/r1/read-position', 421]]);
});

test('switching rooms while the fetch is pending credits nothing to the room that was left', async () => {
  const h = landingHarness();
  const left = roomView('r1');
  h.open(left);
  h.c.landUnread(left);
  const fetching = h.timers.shift()();
  const other = roomView('r2', { unreadFrom: null, unreadLoc: null, unreadLanding: null,
    dom: [{ dataset: { id: 'tail' }, getBoundingClientRect: () => ({ bottom: 500 }) }] });
  h.open(other);
  h.finishAround();
  await fetching;
  assert.notEqual(left.unreadLanding, null, 'the room that was left keeps its guard');
  await h.c.postReadPosition();
  assert.ok(h.posts.every(([path]) => path === '/rooms/r2/read-position'), JSON.stringify(h.posts));
});

test('a loaded first unread is landed on at once, then reading resumes', async () => {
  const h = landingHarness();
  const first = { id: 'first', order: 420, kind: 'work', work: { eventKind: 'participant_state', workState: 'completed' } };
  const v = roomView('r1', { unreadLoc: null, sorted: [first, tail], entries: new Map([['first', first], ['tail', tail]]) });
  h.open(v);
  h.c.landUnread(v);
  assert.equal(v.unreadLanding.state, 'jumping');
  await h.runTimers();
  assert.deepEqual([...v.jumped], ['first', true], 'an instant jump, no smooth scroll');
  assert.equal(v.unreadLanding, null);
  assert.equal(h.posts.length, 1, 'then what is on screen counts');
});

test('the unread button after a failed landing keeps the guard through a slow or failed fetch', async () => {
  const h = landingHarness();
  const v = roomView('r1', { unreadLanding: { state: 'failed' } });
  h.c.st.catalog.rooms.set('r1', { readThroughOrder: 419, unreadReplyCount: 2, firstUnread: v.unreadLoc });
  h.open(v);
  h.c.readerMoved(); // a pointerdown in the room lands first (Codex's retry reproduction)
  h.c.jumpToUnread(v); // the button click: the around fetch starts under a new guard
  assert.equal(v.unreadLanding.state, 'fetching');
  await h.c.postReadPosition();
  await h.runTimers();
  assert.deepEqual(h.posts, [], 'the latest tail (421) is not acknowledged while the fetch is slow');
  h.finishAround(); // it fails: the target never arrives
  await new Promise((done) => setImmediate(done));
  assert.equal(v.unreadLanding.state, 'failed');
  await h.c.postReadPosition();
  assert.deepEqual(h.posts, [], 'no fail-open after the failed retry either');
  h.c.readerMoved(); // an intentional scroll or back-to-latest ends it
  await h.runTimers();
  assert.deepEqual(h.posts.map((p) => [...p]), [['/rooms/r1/read-position', 421]]);
});

test('pressing the unread button is not the reader’s own navigation', () => {
  const nav = constant('READER_NAV');
  assert.ok(nav.includes('#timeline') && nav.includes('.jumps'), nav);
  assert.ok(!nav.includes('#jump-unread'), 'the pill navigates under its own guard');
  assert.ok(app.includes("!target.closest('#jump-unread')"), 'and the handler leaves it out explicitly');
});

test('"jump to the first" follows the broker’s locator past what is loaded, else the first loaded unread', () => {
  const calls = [];
  const rooms = new Map();
  const v = { roomId: 'r', unreadFrom: 4, sorted: [{ id: 'a', order: 5, kind: 'reply' }], entries: new Map() };
  const c = context({ st: { catalog: { rooms } }, view: () => v, scheduleReadPosition: () => {},
    jumpTo: (...a) => { calls.push(['jumpTo', a[1], a[2]]); return Promise.resolve(); },
    jumpToEntry: (x, id) => calls.push(['jumpToEntry', id]), highlight: (id) => calls.push(['highlight', id]) });
  rooms.set('r', { unreadReplyCount: 3, firstUnread: { timelineItemId: 'far', timelineOrder: 2, aroundCursor: 'cur-1' } });
  c.jumpToUnread(v);
  assert.deepEqual(calls.splice(0), [['jumpTo', 'cur-1', 'far']]);
  rooms.set('r', { unreadReplyCount: 1, firstUnread: null });
  c.jumpToUnread(v);
  assert.deepEqual(calls.splice(0), [['jumpToEntry', 'a'], ['highlight', 'a']], 'an older broker: the loaded entry');
});
