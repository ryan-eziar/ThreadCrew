// Quitting ThreadCrew from the window: which answers count, and what the window says when the answer
// is missing or belongs to someone else. Runs the real functions from ui/app-v2.js against a fake
// broker; no browser, no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = app.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `${name} not found`);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
};

const NETWORK = { ok: false, status: 0, error: { code: 'NETWORK', outcome: 'rejected' } };
const state = (status, over = {}) => ({ instanceId: 'inst-1', shutdownId: 'shutdown-u1', status, requestedAt: 't0', completedAt: null, errorCode: null, ...over });

// post: the answer to POST /admin/shutdown; statuses: the status record, one per poll, then NETWORK.
function context({ post, statuses = [] } = {}) {
  const log = { posts: [], polls: [], flashes: [], closed: [] };
  const c = {
    Object, Boolean, Promise,
    boot: { instanceId: 'inst-1' },
    st: { exit: null },
    uuid: () => 'u1',
    sleep: async () => {},
    renderExit() {}, flash: (text, tone) => log.flashes.push([text, tone]), errorText: (code) => code, t: (zh, ...a) => zh.replace(/\{(\d+)\}/g, (m, k) => String(a[k])),
    catalogStream: { close() { log.closed.push('catalog'); } },
    roomStream: { close() { log.closed.push('room'); } },
    roomStreamGen: 0,
    src: {
      async shutdown(body) { log.posts.push(body); return typeof post === 'function' ? post(body) : post; },
      async shutdownStatus(instanceId, shutdownId) { log.polls.push([instanceId, shutdownId]); return statuses.length ? statuses.shift() : NETWORK; },
    },
  };
  c.exiting = () => Boolean(c.st.exit);
  vm.createContext(c);
  vm.runInContext(['applyShutdown', 'pollShutdown', 'requestQuit', 'sendQuit'].map(fn).join('\n'), c);
  return { c, log };
}
const flush = async () => { for (let i = 0; i < 300; i++) await new Promise((r) => setImmediate(r)); };

test('quit: one shutdown ID for this instance, followed to STOPPED by its own status record', async () => {
  const { c, log } = context({ post: { ok: true, status: 202, result: state('SHUTTING_DOWN') },
    statuses: [{ ok: true, result: state('SHUTTING_DOWN') }, { ok: true, result: state('STOPPED', { completedAt: 't1' }) }] });
  c.requestQuit();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(log.posts)), [{ expectedInstanceId: 'inst-1', shutdownId: 'shutdown-u1' }]);
  assert.ok(log.polls.every(([inst, id]) => inst === 'inst-1' && id === 'shutdown-u1'));
  assert.equal(c.st.exit.phase, 'STOPPED');
  assert.deepEqual(log.closed.sort(), ['catalog', 'room'], 'no reconnecting to a stopped service');
});

test('an answer for another shutdown or another instance is never taken as success', async () => {
  for (const other of [state('STOPPED', { shutdownId: 'shutdown-someone-else' }), state('STOPPED', { instanceId: 'inst-2' })]) {
    const { c } = context({ post: { ok: true, status: 202, result: other } });
    c.requestQuit();
    await flush();
    assert.equal(c.st.exit.phase, 'mismatch');
  }
  const { c } = context({ post: { ok: true, status: 202, result: state('SHUTTING_DOWN') },
    statuses: [{ ok: false, status: 409, error: { code: 'INSTANCE_MISMATCH', outcome: 'rejected' } }] });
  c.requestQuit();
  await flush();
  assert.equal(c.st.exit.phase, 'mismatch');
});

test('no answer, or the connection gone before a final state: not confirmed, never stopped', async () => {
  const lost = context({ post: { ok: false, status: 0, error: { code: 'NETWORK', outcome: 'unknown' } },
    statuses: [{ ok: true, result: state('SHUTTING_DOWN') }] }); // then the connection is gone
  lost.c.requestQuit();
  await flush();
  assert.equal(lost.c.st.exit.phase, 'unknown');

  const accepted = context({ post: { ok: false, status: 0, error: { code: 'NETWORK', outcome: 'unknown' } },
    statuses: [{ ok: true, result: state('STOPPED') }] });
  accepted.c.requestQuit();
  await flush();
  assert.equal(accepted.c.st.exit.phase, 'STOPPED', 'the status record shows the lost request did arrive');
});

test('a request that never arrived says so, and trying again reuses the same shutdown ID', async () => {
  let n = 0;
  const { c, log } = context({
    post: () => (n++ === 0 ? { ok: false, status: 0, error: { code: 'NETWORK', outcome: 'unknown' } } : { ok: true, status: 202, result: state('STOPPED') }),
    statuses: [{ ok: false, status: 404, error: { code: 'SHUTDOWN_NOT_FOUND', outcome: 'rejected' } }],
  });
  c.requestQuit();
  await flush();
  assert.equal(c.st.exit.phase, 'not_started');
  await c.sendQuit();
  await flush();
  assert.deepEqual(log.posts.map((p) => p.shutdownId), ['shutdown-u1', 'shutdown-u1']);
  assert.equal(c.st.exit.phase, 'STOPPED');
});

test('a refused request leaves the window as it was', async () => {
  const { c, log } = context({ post: { ok: false, status: 409, error: { code: 'INSTANCE_MISMATCH', outcome: 'rejected' } } });
  c.requestQuit();
  await flush();
  assert.equal(c.st.exit, null);
  assert.deepEqual(log.flashes, [['没有退出：INSTANCE_MISMATCH', 'bad']]);
});

test('other windows follow the event of their own instance only; a final state is never undone', async () => {
  const { c } = context({ statuses: [{ ok: true, result: state('FAILED', { shutdownId: 'shutdown-x', errorCode: 'LOCK_RELEASE_FAILED' }) }] });
  c.applyShutdown(state('SHUTTING_DOWN', { instanceId: 'inst-2', shutdownId: 'shutdown-x' }), 'event');
  assert.equal(c.st.exit, null, 'another instance’s event is ignored');
  c.applyShutdown(state('SHUTTING_DOWN', { shutdownId: 'shutdown-x' }), 'event');
  assert.equal(c.st.exit.own, false);
  assert.equal(c.st.exit.shutdownId, 'shutdown-x');
  await flush();
  assert.equal(c.st.exit.phase, 'FAILED');
  assert.equal(c.st.exit.errorCode, 'LOCK_RELEASE_FAILED');
  c.applyShutdown(state('SHUTTING_DOWN', { shutdownId: 'shutdown-x' }), 'event');
  assert.equal(c.st.exit.phase, 'FAILED');
});

test('two windows quitting at once: the one that lost follows the winner’s shutdown', async () => {
  const { c, log } = context({
    post: () => {
      c.applyShutdown(state('SHUTTING_DOWN', { shutdownId: 'shutdown-other' }), 'event'); // the winner's event arrives first
      return { ok: false, status: 409, error: { code: 'SHUTDOWN_IN_PROGRESS', outcome: 'rejected' } };
    },
    statuses: [{ ok: true, result: state('STOPPED', { shutdownId: 'shutdown-other' }) }],
  });
  c.requestQuit();
  await flush();
  assert.equal(c.st.exit.own, false);
  assert.equal(c.st.exit.shutdownId, 'shutdown-other');
  assert.ok(log.polls.every(([, id]) => id === 'shutdown-other'), 'the status of the shutdown that is actually running');
  assert.equal(c.st.exit.phase, 'STOPPED');
});

test('a lost request while another window’s quit was accepted: that one is followed openly', async () => {
  const { c, log } = context({
    post: () => {
      c.applyShutdown(state('SHUTTING_DOWN', { shutdownId: 'shutdown-other' }), 'event');
      return { ok: false, status: 0, error: { code: 'NETWORK', outcome: 'unknown' } };
    },
    statuses: [{ ok: true, result: state('STOPPED', { shutdownId: 'shutdown-other' }) }],
  });
  c.requestQuit();
  await flush();
  assert.equal(c.st.exit.own, false, 'shown as another window’s quit, not as this request’s result');
  assert.equal(c.st.exit.shutdownId, 'shutdown-other', 'one ID: the one actually followed');
  assert.ok(log.polls.length && log.polls.every(([, id]) => id === 'shutdown-other'));
  assert.equal(c.st.exit.phase, 'STOPPED');
});

test('a late answer to this window’s request never undoes a final state', async () => {
  for (const late of [
    { ok: true, status: 202, result: state('SHUTTING_DOWN') },
    { ok: false, status: 409, error: { code: 'SHUTDOWN_IN_PROGRESS', outcome: 'rejected' } },
    { ok: false, status: 409, error: { code: 'INSTANCE_MISMATCH', outcome: 'rejected' } },
  ]) {
    const { c, log } = context({
      post: () => {
        c.applyShutdown(state('STOPPED', { shutdownId: 'shutdown-other', completedAt: 't1' }), 'event');
        return late;
      },
    });
    c.requestQuit();
    await flush();
    assert.equal(c.st.exit.phase, 'STOPPED', JSON.stringify(late));
    assert.equal(c.st.exit.own, false);
    assert.equal(c.st.exit.shutdownId, 'shutdown-other');
    assert.deepEqual(log.flashes, [], 'no “not quit” over a stopped service');
  }
});

test('this window’s own acceptance arriving as an event first keeps it this window’s quit', async () => {
  const { c } = context({
    post: () => {
      c.applyShutdown(state('SHUTTING_DOWN'), 'event');
      return { ok: true, status: 202, result: state('SHUTTING_DOWN') };
    },
    statuses: [{ ok: true, result: state('STOPPED') }],
  });
  c.requestQuit();
  await flush();
  assert.equal(c.st.exit.own, true);
  assert.equal(c.st.exit.shutdownId, 'shutdown-u1');
  assert.equal(c.st.exit.phase, 'STOPPED');
});

test('Quit is offered only when the broker says it can quit', () => {
  const line = app.match(/^  const EXIT_SUPPORTED = .*;$/m);
  assert.ok(line, 'EXIT_SUPPORTED not found');
  const supported = (capabilities, boot = {}) => vm.runInNewContext(`${line[0]}; EXIT_SUPPORTED`, { capabilities, boot, Object, Boolean });
  assert.equal(supported({ shutdown: true }), true);
  assert.equal(supported({ shutdown: false }, { shutdown: null }), false, 'a broker without a shutdown handler');
  assert.equal(supported({}, { shutdown: null }), false, 'the bootstrap state alone is not permission');
  assert.equal(supported({ shutdown: 'yes' }), false);
});
