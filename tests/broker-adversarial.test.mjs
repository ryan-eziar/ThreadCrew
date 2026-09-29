import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Broker } from '../src/broker.mjs';
import { openStore } from '../src/broker-storage.mjs';

const root = resolve(import.meta.dirname, '../work/broker-adversarial-tests');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const deferred = () => { let resolveValue; const promise = new Promise((done) => { resolveValue = done; }); return { promise, resolve: resolveValue }; };
const code = (value) => (error) => error.code === value;
let operation = 0;
const op = (prefix) => `${prefix}-${++operation}`;

async function fixture(t, options = {}) {
  await mkdir(root, { recursive: true });
  const runtimeDir = await mkdtemp(join(root, 'case-'));
  const roomId = 'synthetic-adversarial-room';
  const brokers = [];
  t.after(async () => {
    for (const broker of brokers) await broker.close().catch(() => {});
    const part = relative(root, resolve(runtimeDir));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const reopen = async () => { const broker = await Broker.open({ runtimeDir, roomId, sendTimeoutMs: 2000, ...options }); brokers.push(broker); return broker; };
  return { runtimeDir, roomId, broker: await reopen(), reopen };
}

async function send(broker, text, recipients = ['claude']) {
  return broker.postMessage({ operationId: op('human'), expectedGate: broker.snapshot().room.gate, recipients, text, attachmentIds: [] });
}

async function takeFirst(broker, bindingId, text = 'synthetic first') {
  const waiting = broker.wait(bindingId, { requestId: op('wait') });
  await send(broker, text);
  const notice = await waiting;
  assert.equal(notice.status, 'NEW');
  return broker.read(bindingId, { requestId: op('read'), batchId: notice.batchId });
}

async function finish(broker, bindingId, delivery, text = 'synthetic final') {
  return broker.postReply(bindingId, { deliveryId: delivery.deliveryId, claimId: delivery.claimId, text, done: false, attachmentIds: [] });
}

async function syncBarrier(t, runtimeDir, ordinal = 1) {
  const probe = await open(join(runtimeDir, 'sync-probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.sync;
  const entered = deferred(); const released = deferred();
  let count = 0;
  const mocked = t.mock.method(prototype, 'sync', async function () {
    await original.call(this);
    count += 1;
    if (count === ordinal) { entered.resolve(); await released.promise; }
  });
  return { entered: entered.promise, release() { released.resolve(); }, restore() { mocked.mock.restore(); } };
}

test('a consumed three-delivery batch cannot be reopened with another direct read', async (t) => {
  const { broker } = await fixture(t);
  const joined = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  const waiting = broker.wait(joined.bindingId, { requestId: op('wait') });
  for (let index = 1; index <= 4; index += 1) await send(broker, `synthetic-${index}`);
  const notice = await waiting;
  for (let index = 1; index <= 3; index += 1) {
    const delivery = await broker.read(joined.bindingId, { requestId: op('read'), batchId: notice.batchId });
    assert.equal(delivery.text, `synthetic-${index}`);
    await finish(broker, joined.bindingId, delivery);
  }
  const boundary = await broker.read(joined.bindingId, { requestId: op('read'), batchId: notice.batchId });
  assert.equal(boundary.status, 'BATCH_LIMIT');
  let bypass;
  try { bypass = await broker.read(joined.bindingId, { requestId: op('read') }); }
  catch (error) { bypass = { status: 'REJECTED', code: error.code }; }
  assert.notEqual(bypass.status, 'DELIVERY', 'direct read must not silently mint the next batch');
  const nextNotice = await broker.wait(joined.bindingId, { requestId: op('wait') });
  assert.equal(nextNotice.status, 'NEW');
  const fourth = await broker.read(joined.bindingId, { requestId: op('read'), batchId: nextNotice.batchId });
  assert.equal(fourth.text, 'synthetic-4');
});

test('a delayed duplicate read request never claims a different delivery after its final', async (t) => {
  const { broker } = await fixture(t);
  const joined = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  const wait = broker.wait(joined.bindingId, { requestId: op('wait') });
  await send(broker, 'first synthetic message');
  await send(broker, 'second synthetic message');
  const notice = await wait;
  const request = { requestId: op('read'), batchId: notice.batchId };
  const first = await broker.read(joined.bindingId, request);
  await finish(broker, joined.bindingId, first);
  let duplicate;
  try { duplicate = await broker.read(joined.bindingId, request); }
  catch (error) { duplicate = { status: 'REJECTED', code: error.code }; }
  assert.ok(duplicate.status !== 'DELIVERY' || duplicate.deliveryId === first.deliveryId, 'network retry must not take the next message');
  const second = broker.snapshot().deliveries.find((item) => item.id !== first.deliveryId);
  assert.equal(second.claimId, null, 'second delivery remains unclaimed until a new read operation');
});

test('a real final renewing a lease also moves an already armed waiter timeout', async (t) => {
  let now = Date.UTC(2026, 8, 28, 0, 0, 0);
  const { broker } = await fixture(t, { clock: () => now });
  const joined = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  const first = await takeFirst(broker, joined.bindingId);
  now = Date.parse(joined.deadlineAt) - 250;
  const abort = new AbortController();
  let completed = null;
  const waiting = broker.wait(joined.bindingId, { requestId: op('wait'), signal: abort.signal }).then((result) => { completed = result; return result; });
  try {
    const reply = await finish(broker, joined.bindingId, first);
    assert.ok(Date.parse(reply.deadlineAt) > Date.parse(joined.deadlineAt));
    now += 300;
    await delay(350);
    assert.equal(completed, null, 'the original timer must not TIMEOUT a renewed lease');
    const member = broker.snapshot().members.find((item) => item.agent === 'claude');
    assert.equal(member.wait.state, 'armed');
    assert.equal(member.wait.deadlineAt, reply.deadlineAt);
  } finally { abort.abort(); await waiting; }
});

test('a timeout queued behind final fsync rechecks the newly committed deadline', async (t) => {
  let now = Date.UTC(2026, 8, 28, 0, 0, 0);
  const { broker, runtimeDir } = await fixture(t, { clock: () => now });
  const joined = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  const first = await takeFirst(broker, joined.bindingId);
  const barrier = await syncBarrier(t, runtimeDir);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  now = Date.parse(joined.deadlineAt) - 50;
  const abort = new AbortController(); let completed = null;
  const waiting = broker.wait(joined.bindingId, { requestId: op('wait'), signal: abort.signal }).then((value) => { completed = value; return value; });
  try {
    const replying = finish(broker, joined.bindingId, first);
    await barrier.entered;
    now += 100;
    t.mock.timers.tick(100); // The old timeout callback queues behind the uncommitted final.
    barrier.release();
    const reply = await replying;
    // This idempotent operation is queued after the timeout transaction, so the
    // assertion observes its completed effects without a wall-clock sleep.
    await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
    assert.equal(completed, null, 'a queued expiration must not invalidate the newly renewed lease');
    assert.equal(broker.snapshot().members.find((item) => item.agent === 'claude').wait.deadlineAt, reply.deadlineAt);
  } finally { barrier.release(); barrier.restore(); abort.abort(); await waiting; t.mock.timers.reset(); }
});

test('late abandoned final does not free another claim or renew the current lease', async (t) => {
  let now = Date.UTC(2026, 8, 28, 0, 0, 0);
  const { broker } = await fixture(t, { clock: () => now });
  const joined = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  const first = await takeFirst(broker, joined.bindingId);
  await send(broker, 'synthetic second');
  const old = broker.snapshot().deliveries.find((item) => item.id === first.deliveryId);
  await broker.abandonDelivery(old.id, { operationId: op('abandon'), expectedDeliveryVersion: old.version, expectedClaimId: old.claimId });
  const second = await broker.read(joined.bindingId, { requestId: op('read'), batchId: first.batchId });
  assert.equal(second.status, 'DELIVERY');
  now += 5000;
  await finish(broker, joined.bindingId, first, 'late synthetic final');
  const snapshot = broker.snapshot();
  const member = snapshot.members.find((item) => item.agent === 'claude');
  assert.equal(member.blockingDeliveryId, second.deliveryId);
  assert.equal(member.wait.deadlineAt, joined.deadlineAt);
  assert.deepEqual(snapshot.replies.find((item) => item.deliveryId === first.deliveryId).lateReasons, ['wait_abandoned']);
});

test('a real stopped-segment final renews once without pretending the member is online', async (t) => {
  let now = Date.UTC(2026, 8, 28, 0, 0, 0);
  const { broker } = await fixture(t, { clock: () => now });
  const joined = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  const first = await takeFirst(broker, joined.bindingId);
  await broker.stop({ operationId: op('stop'), expectedGate: broker.snapshot().room.gate });
  now += 5000;
  const posted = await finish(broker, joined.bindingId, first, 'real final after Stop');
  assert.equal(Date.parse(posted.deadlineAt), now + 36000000);
  now += 9000;
  const repeated = await finish(broker, joined.bindingId, first, 'real final after Stop');
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.deadlineAt, posted.deadlineAt);
  const snapshot = broker.snapshot();
  const member = snapshot.members.find((item) => item.agent === 'claude');
  assert.equal(member.canReceive, false);
  assert.equal(member.wait.state, 'unarmed');
  assert.ok(snapshot.replies[0].lateReasons.includes('segment_stopped'));
  assert.equal(snapshot.replies[0].eligibleAsDiscussionInput, false);
});

test('replaced binding can finish its old claim but cannot read or release the new binding slot', async (t) => {
  let now = Date.UTC(2026, 8, 28, 0, 0, 0);
  const { broker } = await fixture(t, { clock: () => now });
  const oldBinding = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude-old' });
  const oldClaim = await takeFirst(broker, oldBinding.bindingId);
  await send(broker, 'old queued target must not migrate');
  const newBinding = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude-new' });
  const newClaim = await takeFirst(broker, newBinding.bindingId, 'new precise target');
  await assert.rejects(broker.read(oldBinding.bindingId, { requestId: op('read') }), code('BINDING_INVALID'));
  now += 9000;
  await finish(broker, oldBinding.bindingId, oldClaim, 'final from replaced binding');
  const snapshot = broker.snapshot();
  const member = snapshot.members.find((item) => item.agent === 'claude');
  assert.equal(member.blockingDeliveryId, newClaim.deliveryId);
  assert.equal(member.wait.deadlineAt, newBinding.deadlineAt);
  const oldReply = snapshot.replies.find((item) => item.deliveryId === oldClaim.deliveryId);
  assert.ok(oldReply.lateReasons.includes('binding_replaced'));
  const oldQueued = snapshot.deliveries.find((item) => item.bindingId === oldBinding.bindingId && item.id !== oldClaim.deliveryId);
  assert.equal(oldQueued.state, 'stopped');
  assert.equal(oldQueued.nativeSessionId, 'synthetic-claude-old');
});

test('Stop during notification fsync suppresses stale NEW and the next segment can still wake', async (t) => {
  const { broker, runtimeDir } = await fixture(t);
  const joined = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  const abort = new AbortController(); let notice = null;
  const waiting = broker.wait(joined.bindingId, { requestId: op('wait'), signal: abort.signal }).then((value) => { notice = value; return value; });
  const barrier = await syncBarrier(t, runtimeDir, 2); // Human message commit, then NEW reservation commit.
  try {
    const posted = send(broker, 'old synthetic message');
    await barrier.entered;
    const stopping = broker.stop({ operationId: op('stop'), expectedGate: broker.snapshot().room.gate });
    barrier.release();
    await posted; await stopping;
    await delay(30);
    assert.equal(notice, null, 'Stop must not finish an idle waiter with an already-invalid NEW');
    await send(broker, 'new synthetic message');
    const fresh = await waiting;
    assert.equal(fresh.status, 'NEW');
    const delivery = await broker.read(joined.bindingId, { requestId: op('read'), batchId: fresh.batchId });
    assert.equal(delivery.text, 'new synthetic message');
  } finally { barrier.release(); barrier.restore(); abort.abort(); await waiting; }
});

test('Stop during claim fsync prevents handoff and releases the canceled claim slot', async (t) => {
  const { broker, runtimeDir } = await fixture(t);
  const joined = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  const waiting = broker.wait(joined.bindingId, { requestId: op('wait') });
  const posted = await send(broker, 'must never reach the native reader');
  const notice = await waiting;
  const barrier = await syncBarrier(t, runtimeDir);
  const handedOff = [];
  try {
    const reading = broker.read(joined.bindingId, { requestId: op('read'), batchId: notice.batchId }, (value) => handedOff.push(value));
    await barrier.entered;
    const stopping = broker.stop({ operationId: op('stop'), expectedGate: broker.snapshot().room.gate });
    barrier.release();
    assert.equal((await reading).status, 'PAUSED');
    await stopping;
    assert.equal(handedOff.length, 0);
    assert.equal(broker.snapshot().deliveries.find((item) => item.id === posted.deliveryIds.claude).state, 'stopped');
    assert.equal(broker.snapshot().members.find((item) => item.agent === 'claude').blockingDeliveryId, null);
    const nextWait = broker.wait(joined.bindingId, { requestId: op('wait') });
    await send(broker, 'only the new segment is delivered');
    const nextNotice = await nextWait;
    const next = await broker.read(joined.bindingId, { requestId: op('read'), batchId: nextNotice.batchId });
    assert.equal(next.text, 'only the new segment is delivered');
  } finally { barrier.release(); barrier.restore(); }
});

test('an unrelated fsync cannot erase native write evidence before Stop and late final', async (t) => {
  const ready = deferred(); const allowWrite = deferred(); const wrote = deferred(); const respond = deferred();
  const transport = {
    probe: async () => ({ available: true }),
    async send(message, { beforeSend }) {
      ready.resolve(message); await allowWrite.promise;
      beforeSend(); wrote.resolve(message);
      await respond.promise;
      return { status: 'sent' };
    },
  };
  const { broker, runtimeDir } = await fixture(t, { codexTransport: transport });
  const joined = await broker.join({ agent: 'codex', nativeSessionId: 'synthetic-codex' });
  const firstPost = await send(broker, 'codex synthetic delivery', ['codex']);
  await ready.promise;
  const barrier = await syncBarrier(t, runtimeDir);
  try {
    const unrelated = send(broker, 'unrelated queued synthetic message', ['claude']);
    await barrier.entered;
    allowWrite.resolve();
    await wrote.promise;
    const stopping = broker.stop({ operationId: op('stop'), expectedGate: broker.snapshot().room.gate });
    barrier.release();
    await unrelated;
    const stopped = await stopping;
    assert.ok(stopped.possibleRunningDeliveryIds.includes(firstPost.deliveryIds.codex), 'already-written message must not be reported as safely canceled');
    const reply = await broker.postReply(joined.bindingId, { deliveryId: firstPost.deliveryIds.codex, claimId: null, text: 'late native synthetic answer', done: false, attachmentIds: [] });
    const saved = broker.snapshot().replies.find((item) => item.id === reply.replyId);
    assert.ok(saved.lateReasons.includes('segment_stopped'));
  } finally { barrier.release(); barrier.restore(); allowWrite.resolve(); respond.resolve(); }
});

test('a final cannot be accepted before its reserved native delivery starts writing', async (t) => {
  const reserved = deferred(); const allowWrite = deferred();
  const transport = {
    probe: async () => ({ available: true }),
    async send(message, { beforeSend }) {
      reserved.resolve(message);
      await allowWrite.promise;
      beforeSend();
      return { status: 'sent' };
    },
  };
  const { broker } = await fixture(t, { codexTransport: transport });
  const joined = await broker.join({ agent: 'codex', nativeSessionId: 'synthetic-codex' });
  const sent = await send(broker, 'synthetic reserved but unhanded message', ['codex']);
  await reserved.promise;
  try {
    await assert.rejects(broker.postReply(joined.bindingId, { deliveryId: sent.deliveryIds.codex, claimId: null, text: 'synthetic premature final', done: false, attachmentIds: [] }), code('DELIVERY_CHANGED'));
    assert.equal(broker.snapshot().replies.length, 0);
  } finally { allowWrite.resolve(); }
});

test('valid storage checksum does not make a dangling domain segment valid on recovery', async (t) => {
  const f = await fixture(t);
  await f.broker.close();
  const store = await openStore({ runtimeDir: f.runtimeDir, roomId: f.roomId });
  const state = store.state;
  state.gate.segmentId = 'synthetic-nonexistent-segment';
  await store.commit(state);
  await store.close();
  await assert.rejects(f.reopen(), code('RECOVERY_REQUIRED'));
});

test('a queued delivery without its original human message is rejected on recovery', async (t) => {
  const f = await fixture(t);
  await f.broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  await send(f.broker, 'source must remain correlated');
  await f.broker.close();
  const store = await openStore({ runtimeDir: f.runtimeDir, roomId: f.roomId });
  const state = store.state;
  state.messages = [];
  await store.commit(state);
  await store.close();
  await assert.rejects(f.reopen(), code('RECOVERY_REQUIRED'));
});
