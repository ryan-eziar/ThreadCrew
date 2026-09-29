import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Broker } from '../src/broker.mjs';

const root = resolve(import.meta.dirname, '..', 'work', 'broker-tests');
const errorCode = code => error => error.code === code;
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
async function eventually(check) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(10); } assert.fail('condition did not become true'); }
async function fixture(t, options = {}) {
  await mkdir(root, { recursive: true }); const runtimeDir = await mkdtemp(join(root, 'case-'));
  const sent = []; const transport = options.transport ?? { probe: async () => ({ available: true }), send: async (message, controls) => { controls.beforeSend(); sent.push(message); return { status: 'sent' }; } };
  let broker = await Broker.open({ runtimeDir, codexTransport: transport, ...options });
  t.after(async () => { await broker.close(); assert.ok(runtimeDir.startsWith(root + '\\') || runtimeDir.startsWith(root + '/')); await rm(runtimeDir, { recursive: true, force: true }); });
  return { get broker() { return broker; }, sent, runtimeDir, async reopen() { await broker.close(); broker = await Broker.open({ runtimeDir, codexTransport: transport, ...options }); return broker; } };
}
const gate = broker => broker.snapshot().room.gate;
const post = (broker, operationId, recipients = ['claude'], text = 'Synthetic question') => broker.postMessage({ operationId, expectedGate: gate(broker), recipients, text, attachmentIds: [] });
const read = (broker, bindingId, requestId, extra = {}) => broker.read(bindingId, { requestId, ...extra }, () => {});
const final = (broker, bindingId, delivery, text = 'Synthetic answer', done = false) => broker.postReply(bindingId, { deliveryId: delivery.deliveryId ?? delivery.id, claimId: delivery.claimId ?? null, text, attachmentIds: [], done });

test('an abandoned uncertain delivery alone does not leave Stop enabled', async t => {
  const { broker } = await fixture(t, { transport: { probe: async () => ({ available: true }), send: async (message, controls) => { controls.beforeSend(); return { status: 'uncertain' }; } } });
  await broker.join({ agent: 'codex', nativeSessionId: 'synthetic-uncertain-stop' });
  await post(broker, 'uncertain-stop', ['codex']);
  await eventually(() => broker.snapshot().deliveries[0].state === 'uncertain');
  const before = broker.snapshot(); const delivery = before.deliveries[0];
  assert.equal(before.room.actions.stop.enabled, true);
  assert.equal(before.members[0].state, 'recovery_required');
  assert.equal(before.members[0].reason, 'DELIVERY_UNCERTAIN');
  await broker.abandonDelivery(delivery.id, { operationId: 'abandon-uncertain-stop', expectedDeliveryVersion: delivery.version, expectedClaimId: delivery.claimId });
  const after = broker.snapshot();
  assert.equal(after.deliveries[0].state, 'uncertain');
  assert.equal(after.deliveries[0].waitDisposition, 'abandoned');
  assert.equal(after.room.actions.stop.enabled, false);
  assert.equal(after.room.actions.send.enabled, true);
});

test('uncertain native delivery holds later mail until explicit abandonment releases its slot', async t => {
  let attempts = 0;
  const { broker } = await fixture(t, { transport: { probe: async () => ({ available: true }), send: async (message, controls) => { controls.beforeSend(); return { status: ++attempts === 1 ? 'uncertain' : 'sent' }; } } });
  await broker.join({ agent: 'codex', nativeSessionId: 'synthetic-uncertain-queue' });
  await post(broker, 'uncertain-first', ['codex']);
  await eventually(() => broker.snapshot().deliveries[0].state === 'uncertain');
  await post(broker, 'uncertain-queued', ['codex']);
  const before = broker.snapshot(); const delivery = before.deliveries[0];
  assert.equal(attempts, 1);
  assert.equal(before.members[0].canReceive, false);
  assert.equal(before.deliveries[1].state, 'queued');
  assert.equal(before.deliveries[1].blockedByDeliveryId, delivery.id);
  await broker.abandonDelivery(delivery.id, { operationId: 'abandon-uncertain-queue', expectedDeliveryVersion: delivery.version, expectedClaimId: delivery.claimId });
  await eventually(() => broker.snapshot().deliveries[1].state === 'awaiting_reply');
  assert.equal(attempts, 2);
  assert.equal(broker.snapshot().room.actions.stop.enabled, true, 'the new delivery still has work to stop');
});

test('observed native connection loss clears readiness and leaves later messages queued', async t => {
  let attempts = 0;
  const { broker } = await fixture(t, { transport: { probe: async () => ({ available: true }), send: async () => { attempts++; return { status: 'failed', reason: 'NATIVE_UNAVAILABLE' }; } } });
  await broker.join({ agent: 'codex', nativeSessionId: 'synthetic-offline-codex' });
  await post(broker, 'offline-first', ['codex']);
  await eventually(() => broker.snapshot().deliveries[0].state === 'failed');
  const later = await post(broker, 'offline-later', ['codex']);
  const snapshot = broker.snapshot();
  assert.equal(snapshot.members[0].state, 'disconnected');
  assert.equal(snapshot.members[0].canReceive, false);
  const delivery = snapshot.deliveries.find(item => item.id === later.deliveryIds.codex);
  assert.equal(delivery.state, 'queued'); assert.equal(delivery.reason, 'NO_CONNECTION');
  assert.equal(attempts, 1);
});

test('both routes reject an altered attachment before handoff and never retry that delivery', async t => {
  const { broker, runtimeDir, sent } = await fixture(t);
  const claude = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-attachment-claude' });
  const waiting = broker.wait(claude.bindingId, { requestId: 'attachment-seed-wait' });
  await post(broker, 'attachment-seed');
  const notice = await waiting;
  const seed = await read(broker, claude.bindingId, 'attachment-seed-read', { batchId: notice.batchId });
  const original = 'original attachment '.repeat(1000);
  await final(broker, claude.bindingId, seed, original);
  const attachment = broker.snapshot().attachments[0];
  await writeFile(resolve(runtimeDir, attachment.relativePath), 'altered after storage');
  const request = { requestId: 'attachment-corrupt-read', batchId: notice.batchId };
  const created = await broker.postMessage({ operationId: 'attachment-targets', expectedGate: gate(broker), recipients: ['claude', 'codex'], text: 'Review this attachment', attachmentIds: [attachment.id] });
  let handoffs = 0;
  await assert.rejects(broker.read(claude.bindingId, request, () => { handoffs++; }), errorCode('ATTACHMENT_UNAVAILABLE'));
  await broker.join({ agent: 'codex', nativeSessionId: 'synthetic-attachment-codex' });
  await eventually(() => Object.values(created.deliveryIds).every(id => broker.snapshot().deliveries.find(item => item.id === id).state === 'failed'));
  assert.equal(handoffs, 0); assert.equal(sent.length, 0);
  // Repairing a local file is not authority to retry a consumed attempt.
  await writeFile(resolve(runtimeDir, attachment.relativePath), original);
  assert.equal((await broker.read(claude.bindingId, request)).status, 'PAUSED');
  assert.equal(broker.snapshot().deliveries.find(item => item.id === created.deliveryIds.codex).state, 'failed');
});

test('snapshot has typed system events, stable per-recipient IDs and no internal text/operations', async t => {
  const { broker } = await fixture(t);
  const result = await post(broker, 'human-one', ['codex', 'claude']);
  const state = broker.snapshot(); assert.equal(state.messages.length, 1); assert.equal(state.deliveries.length, 2);
  assert.equal(state.timeline[0].systemType, 'segment_opened');
  assert.equal(state.timeline[1].systemType, null);
  assert.notEqual(result.deliveryIds.codex, result.deliveryIds.claude);
  for (const delivery of state.deliveries) { assert.equal(delivery.reason, 'NO_BINDING'); assert.equal(delivery.blockedByDeliveryId, null); }
  assert.equal(state.messages[0].actions.discuss.baseReplyIds, null);
  assert.equal(JSON.stringify(state).includes('_text'), false); assert.equal('operations' in state, false);
});

test('human operation concurrency and replay survive restart and gate changes', async t => {
  const f = await fixture(t); let broker = f.broker;
  const request = { operationId: 'constructor', expectedGate: gate(broker), recipients: ['claude', 'codex'], text: 'one', attachmentIds: [] };
  const results = await Promise.all([broker.postMessage(request), broker.postMessage({ ...request, recipients: ['codex', 'claude'] })]);
  assert.equal(results[0].messageId, results[1].messageId); assert.equal(broker.snapshot().messages.length, 1);
  await assert.rejects(broker.postMessage({ ...request, text: 'changed' }), errorCode('ID_CONFLICT'));
  broker = await f.reopen(); assert.equal((await broker.postMessage(request)).messageId, results[0].messageId);
  assert.equal(broker.getOperation(request.operationId).status, 'committed');
  await assert.rejects(broker.postMessage({ ...request, operationId: 'stale-new-id' }), errorCode('STATE_CONFLICT'));
});

test('Claude wait/read/final deduplicate and only the first real final renews the lease', async t => {
  let now = Date.parse('2026-09-28T00:00:00Z'); const { broker } = await fixture(t, { clock: () => now });
  const joined = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude' });
  const waiting = broker.wait(joined.bindingId, { requestId: 'wait-one' });
  await post(broker, 'post-one'); const notice = await waiting; assert.equal(notice.status, 'NEW');
  const delivery = await read(broker, joined.bindingId, 'read-one', { batchId: notice.batchId });
  const replay = await read(broker, joined.bindingId, 'read-one', { batchId: notice.batchId }); assert.equal(delivery.claimId, replay.claimId);
  now += 1000; const reply = await final(broker, joined.bindingId, delivery);
  const deadline = reply.deadlineAt; now += 1000;
  const duplicate = await final(broker, joined.bindingId, delivery); assert.equal(duplicate.replyId, reply.replyId); assert.equal(duplicate.deadlineAt, deadline);
  await assert.rejects(final(broker, joined.bindingId, delivery, 'conflicting answer'), errorCode('FINAL_ALREADY_PRESENT'));
  assert.equal((await read(broker, joined.bindingId, 'read-one')).status, 'COMPLETED');
  assert.equal(broker.snapshot().replies.length, 1);
});

test('Stop preserves idle waiter and a genuine next message opens a new segment', async t => {
  const { broker } = await fixture(t); const binding = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-idle' });
  let woke = false; const waiting = broker.wait(binding.bindingId, { requestId: 'wait-idle' }).then(value => { woke = true; return value; });
  const stopRequest = { operationId: 'stop-one', expectedGate: gate(broker) }; const stopped = await broker.stop(stopRequest);
  await pause(30); assert.equal(woke, false); assert.equal(broker.snapshot().members[1].state, 'ready');
  const fresh = await post(broker, 'post-after-stop'); assert.equal(fresh.openedSegment, true);
  const notice = await waiting; assert.equal(notice.status, 'NEW');
  const incoming = await read(broker, binding.bindingId, 'read-after-stop', { batchId: notice.batchId });
  assert.equal(incoming.deliveryId, fresh.deliveryIds.claude);
  await broker.stop(stopRequest); assert.equal(broker.snapshot().room.state, 'active');
  assert.notEqual(gate(broker).segmentId, stopped.stoppedSegmentId);
});

test('Stop blocks old queues, classifies late finals, and old operations cannot resume a stopped segment', async t => {
  const { broker } = await fixture(t); const binding = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-stop' });
  const request = { operationId: 'old-human', expectedGate: gate(broker), recipients: ['claude'], text: 'old', attachmentIds: [] };
  const initial = await broker.postMessage(request); const delivery = await read(broker, binding.bindingId, 'old-read');
  const queued = await post(broker, 'old-queued'); const stopRequest = { operationId: 'stop-active', expectedGate: gate(broker) };
  await broker.stop(stopRequest); const oldReplay = await broker.postMessage(request); assert.equal(oldReplay.messageId, initial.messageId); assert.equal(broker.snapshot().room.state, 'stopped');
  await assert.rejects(broker.postMessage({ ...request, operationId: 'delayed-old-human' }), errorCode('STATE_CONFLICT'));
  await post(broker, 'next-human'); await final(broker, binding.bindingId, delivery);
  const snapshot = broker.snapshot(); assert.equal(snapshot.deliveries.find(value => value.id === queued.deliveryIds.claude).state, 'stopped');
  assert.deepEqual(snapshot.replies[0].lateReasons, ['segment_stopped']); assert.equal(snapshot.replies[0].eligibleAsDiscussionInput, false);
});

test('abandon frees only its own slot, accepts late final and rejects re-reading the abandoned claim', async t => {
  const { broker } = await fixture(t); const binding = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-abandon' });
  await post(broker, 'first'); const first = await read(broker, binding.bindingId, 'read-first'); await post(broker, 'second');
  const old = broker.snapshot().deliveries[0]; await broker.abandonDelivery(old.id, { operationId: 'abandon-first', expectedDeliveryVersion: old.version, expectedClaimId: old.claimId });
  await assert.rejects(read(broker, binding.bindingId, 'stale-explicit', { claimId: old.claimId }), errorCode('DELIVERY_CHANGED'));
  const next = await read(broker, binding.bindingId, 'read-second'); await final(broker, binding.bindingId, first);
  assert.equal(broker.snapshot().members[1].blockingDeliveryId, next.deliveryId);
  assert.deepEqual(broker.snapshot().replies[0].lateReasons, ['wait_abandoned']); assert.equal(broker.snapshot().deliveries[0].waitDisposition, 'abandoned');
});

test('rebind never retargets queued work, rejects old read but accepts exact old final', async t => {
  const { broker } = await fixture(t); const oldBinding = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-old' });
  await post(broker, 'old-work'); const claimed = await read(broker, oldBinding.bindingId, 'old-claim'); const queued = await post(broker, 'old-unread');
  const newBinding = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-new' });
  assert.notEqual(newBinding.bindingId, oldBinding.bindingId);
  await assert.rejects(read(broker, oldBinding.bindingId, 'read-old-again'), errorCode('BINDING_INVALID'));
  await final(broker, oldBinding.bindingId, claimed);
  const state = broker.snapshot(); assert.equal(state.deliveries.find(value => value.id === queued.deliveryIds.claude).state, 'stopped');
  assert.deepEqual(state.replies[0].lateReasons, ['binding_replaced']);
});

test('discussion fixed pair runs one round, marks final normally, and stops at its budget', async t => {
  const { broker, sent } = await fixture(t); const codex = await broker.join({ agent: 'codex', nativeSessionId: 'synthetic-codex' });
  const claude = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-claude-round' });
  await post(broker, 'base-question', ['codex', 'claude']); const baseClaude = await read(broker, claude.bindingId, 'base-read');
  await eventually(() => sent.length === 1 && broker.snapshot().deliveries.find(value => value.agent === 'codex').state === 'awaiting_reply');
  await final(broker, codex.bindingId, sent[0], 'codex first'); await final(broker, claude.bindingId, baseClaude, 'claude first');
  const waiting = broker.wait(claude.bindingId, { requestId: 'round-wait' }); const message = broker.snapshot().messages[0];
  assert.equal(message.actions.discuss.enabled, true);
  const exchange = await broker.startExchange({ operationId: 'start-round', expectedGate: gate(broker), baseMessageId: message.id, baseReplyIds: message.actions.discuss.baseReplyIds, previousExchangeId: null, maxRounds: 1 });
  const notice = await waiting; const roundClaude = await read(broker, claude.bindingId, 'round-read', { batchId: notice.batchId });
  await eventually(() => sent.length === 2 && broker.snapshot().deliveries.find(value => value.id === sent[1].id).state === 'awaiting_reply');
  assert.equal(sent[1].text, 'claude first'); assert.equal(roundClaude.text, 'codex first');
  await final(broker, codex.bindingId, sent[1], 'codex round'); await final(broker, claude.bindingId, roundClaude, 'claude round');
  const state = broker.snapshot(); const ended = state.exchanges.find(value => value.id === exchange.exchangeId);
  assert.equal(ended.endReason, 'limit'); assert.equal(ended.completedRounds, 1); assert.equal(state.deliveries.length, 4);
  assert.deepEqual(state.replies.at(-1).lateReasons, []); assert.equal(state.replies.at(-1).eligibleAsDiscussionInput, true);
  assert.equal(state.timeline.findLast(value => value.systemType === 'exchange_ended').data.exchangeId, exchange.exchangeId);
});

test('long Unicode final is preserved as an attachment and snapshot contains only a preview', async t => {
  const { broker } = await fixture(t); const binding = await broker.join({ agent: 'claude', nativeSessionId: 'synthetic-long' });
  await post(broker, 'long-request'); const delivery = await read(broker, binding.bindingId, 'long-read');
  const full = '😀'.repeat(40000); await final(broker, binding.bindingId, delivery, full);
  const reply = broker.snapshot().replies[0]; assert.equal([...reply.content.previewText].length, 2000); assert.equal(reply.content.truncated, true);
  let text = '', cursor;
  do { const page = await broker.readAttachment(reply.content.attachmentId, cursor); text += page.text; cursor = page.nextCursor; } while (cursor);
  assert.equal(text, full);
});

test('native Stop at a delayed write boundary prevents the send and releases the reservation', async t => {
  let release; const held = new Promise(resolveHeld => { release = resolveHeld; }); let reached = false, writes = 0;
  const { broker } = await fixture(t, { transport: { probe: async () => ({ available: true }), async send(message, controls) { reached = true; await held; controls.beforeSend(); writes++; return { status: 'sent' }; } } });
  await broker.join({ agent: 'codex', nativeSessionId: 'synthetic-delayed' }); await post(broker, 'delay', ['codex']);
  await eventually(() => reached); await broker.stop({ operationId: 'stop-delayed', expectedGate: gate(broker) }); release();
  await eventually(() => broker.snapshot().deliveries[0].state === 'stopped'); assert.equal(writes, 0); assert.equal(broker.snapshot().members[0].blockingDeliveryId, null);
});
