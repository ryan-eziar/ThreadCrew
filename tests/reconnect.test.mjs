import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { V2Broker } from '../src/v2-broker.mjs';
import { createV2Server } from '../src/v2-server.mjs';
import { runV2Cli } from '../src/v2-cli.mjs';

const project = resolve(import.meta.dirname, '..');
const root = join(project, 'work', 'reconnect-tests');
const op = () => randomUUID();
async function fixture(t, options = {}) {
  await mkdir(root, { recursive: true });
  const runtimeDir = await mkdtemp(join(root, 'case-'));
  const broker = await V2Broker.open({ runtimeDir, ...options });
  const server = await createV2Server({ broker, runtimeDir, projectDir: project });
  t.after(async () => {
    await server.close(); await broker.close();
    assert.ok(resolve(runtimeDir).startsWith(`${root}${sep}`));
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const room = await broker.createRoom({ operationId: op(), name: 'Synthetic reconnect room' });
  const control = () => broker.getControl(room.roomId);
  const member = async (role = 'claude') => (await control()).members.find(m => m.agent === role);
  const cli = (...args) => runV2Cli(args, { runtimeDir, projectDir: project, stdout: () => {} });
  const joinMember = async (role, nativeSessionId) => {
    const gate = (await control()).room.gate;
    return cli('join', '--room', room.roomId, '--as', role, '--session', nativeSessionId,
      '--expected-binding', 'null', '--gate-segment', gate.segmentId, '--gate-version', String(gate.version));
  };
  const reconnect = (hint, overrides = {}) => {
    const h = { ...hint, ...overrides };
    return cli('join', '--room', h.roomId, '--as', h.agent, '--session', h.expectedNativeSessionId,
      '--expected-binding', h.expectedBindingId, '--gate-segment', h.expectedGate.segmentId,
      '--gate-version', String(h.expectedGate.version), '--reconnect', ...(h.renew ? ['--renew'] : []));
  };
  return { broker, server, runtimeDir, room, control, member, cli, joinMember, reconnect };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(10); }
  assert.fail('Timed out waiting for synthetic reception state');
}

test('manual expired reconnect preserves the binding, queue and reply exactly once', async t => {
  let now = Date.parse('2026-09-29T00:00:00Z');
  const f = await fixture(t, { clock: () => now });
  assert.equal((await f.member()).reconnectHint, null);
  const joined = await f.joinMember('claude', 'synthetic-native-claude');
  const original = await f.member();
  assert.equal(original.state, 'unarmed');
  assert.equal(original.reconnectHint.expectedNativeSessionId, 'synthetic-native-claude');
  assert.equal(original.reconnectHint.expectedBindingId, joined.bindingId);
  assert.equal(original.reconnectHint.renew, true);
  now += 1000;
  assert.equal((await f.reconnect(original.reconnectHint)).deadlineAt, joined.deadlineAt,
    'reconnecting before expiry must not extend the lease');
  now += 36_000_000;
  const expired = await f.member();
  assert.equal(expired.state, 'expired');
  const sent = await f.broker.sendHuman(f.room.roomId, { operationId: op(), expectedGate: expired.reconnectHint.expectedGate,
    recipients: ['claude'], text: 'Synthetic queued request', attachmentIds: [] });
  const renewed = await f.reconnect((await f.member()).reconnectHint);
  assert.equal(renewed.bindingId, joined.bindingId);
  assert.equal(Date.parse(renewed.deadlineAt), now + 36_000_000);
  assert.equal((await f.member()).canReceive, false, 'join alone is not an armed waiter');
  const base = ['--room', f.room.roomId, '--as', 'claude', '--binding', joined.bindingId];
  const notice = await f.cli('wait', ...base);
  assert.equal(notice.status, 'NEW');
  assert.equal((await f.member()).state, 'notified');
  assert.equal((await f.member()).reconnectHint, null);
  const claimed = await f.cli('read', ...base);
  assert.equal(claimed.deliveryId, sent.deliveryIds.claude);
  assert.equal(claimed.text, 'Synthetic queued request');
  assert.equal((await f.member()).state, 'busy');
  assert.equal((await f.member()).reconnectHint, null);
  const file = join(f.runtimeDir, 'synthetic-answer.txt');
  await writeFile(file, 'Synthetic complete answer', 'utf8');
  const post = ['post', ...base, '--delivery', claimed.deliveryId, '--file', file];
  const first = await f.cli(...post), duplicate = await f.cli(...post);
  assert.equal(duplicate.replyId, first.replyId);
  assert.equal((await f.cli('read', ...base)).status, 'EMPTY');
  const abort = new AbortController(); t.after(() => abort.abort());
  const wait = f.broker.wait(f.room.roomId, joined.bindingId, { requestId: op(), signal: abort.signal });
  await until(async () => (await f.member()).canReceive);
  assert.equal((await f.member()).reconnectHint, null);
  abort.abort(); assert.equal((await wait).status, 'DISCONNECTED');
  const rows = await f.broker.store.read(sql => sql.all('SELECT id FROM replies WHERE delivery_id=?', [claimed.deliveryId]));
  assert.equal(rows.length, 1);
  assert.equal((await f.member()).state, 'unarmed');
  assert.ok((await f.member()).reconnectHint);
});

test('wrong session and stale gate reconnects cannot replace a seat or interrupt its live waiter', async t => {
  const f = await fixture(t);
  const joined = await f.joinMember('claude', 'synthetic-native-claude');
  const hint = (await f.member()).reconnectHint;
  const abort = new AbortController(); t.after(() => abort.abort());
  const wait = f.broker.wait(f.room.roomId, joined.bindingId, { requestId: op(), signal: abort.signal });
  await until(async () => (await f.member()).canReceive);
  await assert.rejects(f.reconnect(hint, { expectedNativeSessionId: 'wrong-native-session' }), e => e.code === 'BINDING_CHANGED');
  assert.equal((await f.member()).canReceive, true);
  await assert.rejects(f.reconnect(hint, { expectedBindingId: 'wrong-binding' }), e => e.code === 'BINDING_CHANGED');
  await f.joinMember('codex', 'synthetic-native-codex');
  await assert.rejects(f.reconnect(hint), e => e.code === 'GATE_CHANGED');
  assert.equal((await f.member()).canReceive, true, 'a stale copied command leaves the active wait intact');
  assert.equal((await f.member()).binding.id, joined.bindingId);
  const currentHint = { ...hint, expectedGate: (await f.control()).room.gate };
  await f.reconnect(currentHint);
  assert.equal((await f.member()).canReceive, true, 'idempotent manual reconnect also leaves the wait intact');
  abort.abort(); await wait;
  await f.broker.join(f.room.roomId, { agent: 'claude', nativeSessionId: 'intentional-replacement',
    expectedBindingId: joined.bindingId, expectedGate: (await f.control()).room.gate });
  await assert.rejects(f.reconnect(currentHint), e => e.code === 'BINDING_CHANGED');
  assert.equal((await f.member()).binding.nativeSessionId, 'intentional-replacement');
});

test('manual reconnect cannot create a seat, bypass Stop, or renew a stopped lease', async t => {
  let now = Date.parse('2026-09-29T00:00:00Z');
  const f = await fixture(t, { clock: () => now });
  const emptyHint = { ...(await f.member()).joinHint, expectedNativeSessionId: 'synthetic-native-claude', renew: true };
  await assert.rejects(f.reconnect({ ...emptyHint, expectedBindingId: 'null' }), e => e.code === 'INVALID_INPUT');
  await assert.rejects(f.broker.join(f.room.roomId, { agent: 'claude', nativeSessionId: 'synthetic-native-claude',
    expectedBindingId: 'missing-binding', expectedGate: f.room.gate, reconnect: true }), e => e.code === 'BINDING_CHANGED');
  const joined = await f.joinMember('claude', 'synthetic-native-claude');
  const hint = (await f.member()).reconnectHint;
  await f.broker.sendHuman(f.room.roomId, { operationId: op(), expectedGate: hint.expectedGate,
    recipients: ['claude'], text: 'Synthetic stopped request', attachmentIds: [] });
  const stop = await f.broker.stop(f.room.roomId, { operationId: op(), expectedGate: hint.expectedGate });
  now += 36_000_001;
  assert.equal((await f.member()).reconnectHint, null);
  await assert.rejects(f.reconnect({ ...hint, expectedGate: stop.gate }), e => e.code === 'ROOM_STOPPED');
  assert.equal((await f.member()).wait.deadlineAt, joined.deadlineAt);
  const queued = (await f.broker.getTimeline(f.room.roomId)).items.flatMap(item => item.deliveries ?? []);
  assert.equal(queued.length, 1); assert.equal(queued[0].state, 'stopped');
});

test('Codex manual reconnect requires a new successful native probe before showing Ready', async t => {
  let available = false, probes = 0;
  const f = await fixture(t, { codexTransport: { probe: async () => { probes++; return { available }; } } });
  const joined = await f.joinMember('codex', 'synthetic-native-codex');
  const member = await f.member('codex');
  assert.equal(member.state, 'disconnected'); assert.equal(member.reconnectHint.renew, false);
  const failedProbe = await f.reconnect(member.reconnectHint);
  assert.equal(failedProbe.bindingId, joined.bindingId);
  assert.equal((await f.member('codex')).canReceive, false);
  available = true;
  await f.reconnect(member.reconnectHint);
  assert.equal((await f.member('codex')).canReceive, true);
  assert.equal((await f.member('codex')).reconnectHint, null);
  assert.equal(probes, 3);
});
