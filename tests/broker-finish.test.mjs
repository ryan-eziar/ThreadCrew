import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Broker } from '../src/broker.mjs';

const root = resolve(import.meta.dirname, '..', 'work', 'broker-finish-tests');
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await pause(10); }
  assert.fail('condition did not become true');
}
async function fixture(t) {
  await mkdir(root, { recursive: true });
  const runtimeDir = await mkdtemp(join(root, 'case-'));
  const sent = [];
  const transport = { probe: async () => ({ available: true }), send: async (message, controls) => {
    controls.beforeSend(); sent.push(message); return { status: 'sent' };
  } };
  let broker = await Broker.open({ runtimeDir, codexTransport: transport });
  t.after(async () => { await broker.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  return { get broker() { return broker; }, sent, async reopen() {
    await broker.close(); broker = await Broker.open({ runtimeDir, codexTransport: transport });
    await broker.join({ agent: 'codex', nativeSessionId: 'finish-codex' });
    return broker;
  }, async close() { await broker.close(); }, runtimeDir };
}
const gate = broker => broker.snapshot().room.gate;
const exchange = (broker, id) => broker.snapshot().exchanges.find(value => value.id === id);
const post = (broker, bindingId, delivery, done, text = 'Synthetic final') => broker.postReply(bindingId, {
  deliveryId: delivery.deliveryId ?? delivery.id, claimId: delivery.claimId ?? null, text, attachmentIds: [], done
});
async function base(f) {
  const broker = f.broker;
  const codex = await broker.join({ agent: 'codex', nativeSessionId: 'finish-codex' });
  const claude = await broker.join({ agent: 'claude', nativeSessionId: 'finish-claude' });
  const waiting = broker.wait(claude.bindingId, { requestId: 'base-wait' });
  await broker.postMessage({ operationId: 'base', expectedGate: gate(broker), recipients: ['codex', 'claude'], text: 'Synthetic question', attachmentIds: [] });
  const notice = await waiting;
  const claudeDelivery = await broker.read(claude.bindingId, { requestId: 'base-read', batchId: notice.batchId });
  await eventually(() => f.sent.length === 1 && broker.snapshot().deliveries.find(value => value.id === f.sent[0].id)?.state === 'awaiting_reply');
  await post(broker, codex.bindingId, f.sent[0], false, 'Codex base');
  await post(broker, claude.bindingId, claudeDelivery, false, 'Claude base');
  return { codex: codex.bindingId, claude: claude.bindingId };
}
async function start(f, maxRounds, finishPolicy) {
  const broker = f.broker;
  const waiting = broker.wait(broker.snapshot().members[1].binding.id, { requestId: `round-${f.sent.length}-wait` });
  const message = broker.snapshot().messages[0];
  const input = { operationId: 'exchange-start', expectedGate: gate(broker), baseMessageId: message.id,
    baseReplyIds: message.actions.discuss.baseReplyIds, previousExchangeId: null, maxRounds };
  if (finishPolicy !== undefined) input.finishPolicy = finishPolicy;
  const result = await broker.startExchange(input);
  const notice = await waiting;
  const claudeDelivery = await broker.read(broker.snapshot().members[1].binding.id, { requestId: 'round-1-read', batchId: notice.batchId });
  await eventually(() => f.sent.length === 2 && broker.snapshot().deliveries.find(value => value.id === f.sent[1].id)?.state === 'awaiting_reply');
  return { result, input, codexDelivery: f.sent[1], claudeDelivery };
}

test('default policy waits for both same-round votes, then ends by agreement', async t => {
  const f = await fixture(t); const bindings = await base(f);
  const { result, codexDelivery, claudeDelivery } = await start(f, 3);
  assert.deepEqual(f.broker.snapshot().capabilities, { discussionFinishPolicies: ['first_done', 'both_same_round'], contentFormats: ['plain'] });
  assert.equal(result.finishPolicy, 'both_same_round');
  assert.deepEqual(exchange(f.broker, result.exchangeId).rounds[0].finishVotes, { codex: null, claude: null });
  const first = await post(f.broker, bindings.codex, codexDelivery, true, 'Codex agrees');
  let current = exchange(f.broker, result.exchangeId);
  assert.equal(current.state, 'active'); assert.equal(current.completedRounds, 0);
  assert.deepEqual(current.rounds[0].finishVotes, { codex: true, claude: null });
  const replay = await post(f.broker, bindings.codex, codexDelivery, true, 'Codex agrees');
  assert.equal(replay.replyId, first.replyId); assert.equal(exchange(f.broker, result.exchangeId).rounds.length, 1);
  await post(f.broker, bindings.claude, claudeDelivery, true, 'Claude agrees');
  current = exchange(f.broker, result.exchangeId);
  assert.equal(current.state, 'ended'); assert.equal(current.endReason, 'agreement');
  assert.equal(current.completedRounds, 1); assert.equal(current.rounds.length, 1);
  assert.deepEqual(current.rounds[0].finishVotes, { codex: true, claude: true });
});

test('votes do not carry to the next round; a false vote at the budget ends by limit', async t => {
  const f = await fixture(t); const bindings = await base(f);
  const { result, codexDelivery, claudeDelivery } = await start(f, 2);
  await post(f.broker, bindings.codex, codexDelivery, true, 'Codex done in round one');
  await post(f.broker, bindings.claude, claudeDelivery, false, 'Claude has a concern');
  let current = exchange(f.broker, result.exchangeId);
  assert.equal(current.state, 'active'); assert.equal(current.currentRound, 2);
  assert.deepEqual(current.rounds[0].finishVotes, { codex: true, claude: false });
  assert.deepEqual(current.rounds[1].finishVotes, { codex: null, claude: null });
  const waiting = f.broker.wait(bindings.claude, { requestId: 'round-2-wait' });
  const notice = await waiting;
  const nextClaude = await f.broker.read(bindings.claude, { requestId: 'round-2-read', batchId: notice.batchId });
  await eventually(() => f.sent.length === 3 && f.broker.snapshot().deliveries.find(value => value.id === f.sent[2].id)?.state === 'awaiting_reply');
  await post(f.broker, bindings.codex, f.sent[2], false, 'Codex changed position');
  current = exchange(f.broker, result.exchangeId);
  assert.equal(current.state, 'active'); assert.deepEqual(current.rounds[1].finishVotes, { codex: false, claude: null });
  await post(f.broker, bindings.claude, nextClaude, true, 'Claude is done');
  current = exchange(f.broker, result.exchangeId);
  assert.equal(current.endReason, 'limit'); assert.equal(current.completedRounds, 2); assert.equal(current.rounds.length, 2);
  assert.deepEqual(current.rounds[1].finishVotes, { codex: false, claude: true });
});

test('Stop keeps an already written final late and does not add its vote', async t => {
  const f = await fixture(t); const bindings = await base(f);
  const { result, codexDelivery, claudeDelivery } = await start(f, 2);
  await post(f.broker, bindings.codex, codexDelivery, true);
  await f.broker.stop({ operationId: 'stop-exchange', expectedGate: gate(f.broker) });
  const late = await post(f.broker, bindings.claude, claudeDelivery, true);
  const current = exchange(f.broker, result.exchangeId);
  assert.equal(current.endReason, 'stop'); assert.deepEqual(current.rounds[0].finishVotes, { codex: true, claude: null });
  assert.ok(f.broker.snapshot().replies.find(value => value.id === late.replyId).lateReasons.includes('segment_stopped'));
});

test('restart preserves active policy and votes, and explicit first_done remains unilateral', async t => {
  const f = await fixture(t); const bindings = await base(f);
  const { result, codexDelivery, claudeDelivery } = await start(f, 2);
  await post(f.broker, bindings.codex, codexDelivery, true);
  await f.reopen();
  let current = exchange(f.broker, result.exchangeId);
  assert.equal(current.finishPolicy, 'both_same_round'); assert.equal(current.state, 'active');
  assert.deepEqual(current.rounds[0].finishVotes, { codex: true, claude: null });
  await post(f.broker, bindings.claude, claudeDelivery, true);
  assert.equal(exchange(f.broker, result.exchangeId).endReason, 'agreement');

  // The old policy is a deliberate per-exchange choice for compatibility.
  const waiting = f.broker.wait(bindings.claude, { requestId: 'legacy-wait' });
  const previous = exchange(f.broker, result.exchangeId);
  const request = { operationId: 'legacy-again', expectedGate: gate(f.broker), baseMessageId: previous.baseMessageId,
    baseReplyIds: previous.rounds.at(-1).finalReplyIds, previousExchangeId: previous.id, maxRounds: 2, finishPolicy: 'first_done' };
  const legacy = await f.broker.startExchange(request);
  const notice = await waiting;
  const legacyClaude = await f.broker.read(bindings.claude, { requestId: 'legacy-read', batchId: notice.batchId });
  await eventually(() => f.sent.length === 3 && f.broker.snapshot().deliveries.find(value => value.id === f.sent[2].id)?.state === 'awaiting_reply');
  await post(f.broker, bindings.codex, f.sent[2], true);
  current = exchange(f.broker, legacy.exchangeId);
  assert.equal(current.endReason, 'done'); assert.equal(current.doneBy, 'codex');
  assert.deepEqual(current.rounds[0].finishVotes, { codex: true, claude: null });
  await post(f.broker, bindings.claude, legacyClaude, true);
  assert.deepEqual(exchange(f.broker, legacy.exchangeId).rounds[0].finishVotes, { codex: true, claude: null });
  await f.reopen();
  assert.equal(exchange(f.broker, legacy.exchangeId).finishPolicy, 'first_done');
});

test('pre-policy persisted active exchange defaults to first_done after restart', async t => {
  const f = await fixture(t); const bindings = await base(f);
  const { result, codexDelivery } = await start(f, 2, 'first_done');
  await f.close();
  const journalPath = join(f.runtimeDir, 'broker-state.jsonl');
  const records = (await readFile(journalPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const state = records.at(-1).state;
  delete state.exchanges[0].finishPolicy;
  for (const round of state.exchanges[0].rounds) delete round.finishVotes;
  const payload = { version: 1, roomId: state.roomId, seq: 1, previousChecksum: null, state };
  const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await writeFile(journalPath, JSON.stringify({ ...payload, checksum }) + '\n');
  await f.reopen();
  let current = exchange(f.broker, result.exchangeId);
  assert.equal(current.finishPolicy, 'first_done');
  assert.deepEqual(current.rounds[0].finishVotes, { codex: null, claude: null });
  await post(f.broker, bindings.codex, codexDelivery, true);
  current = exchange(f.broker, result.exchangeId);
  assert.equal(current.endReason, 'done'); assert.equal(current.doneBy, 'codex');
  assert.deepEqual(current.rounds[0].finishVotes, { codex: true, claude: null });
});
