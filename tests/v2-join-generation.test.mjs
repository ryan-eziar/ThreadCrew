import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { V2Broker } from '../src/v2-broker.mjs';

async function fixture(t) {
  await mkdir('work', { recursive: true });
  const runtimeDir = await mkdtemp(join('work', 'join-generation-'));
  const broker = await V2Broker.open({ runtimeDir });
  t.after(() => broker.close());
  const room = await broker.createRoom({ operationId: 'create', name: 'Synthetic join room' });
  const capture = async () => Object.fromEntries((await broker.getControl(room.roomId)).members.map(m => [m.agent, m.joinHint]));
  const enter = (agent, hint, session = agent) => broker.join(room.roomId, { agent, nativeSessionId: session,
    expectedBindingId: hint.expectedBindingId, expectedGate: hint.expectedGate, expectedJoinVersion: hint.expectedJoinVersion });
  return { broker, roomId: room.roomId, capture, enter };
}

for (const order of [['codex', 'claude'], ['claude', 'codex']]) {
  test(`both copied empty-seat instructions work: ${order.join(' then ')}`, async t => {
    const f = await fixture(t), hints = await f.capture();
    for (const role of order) assert.equal((await f.enter(role, hints[role])).agent, role);
    assert.equal((await f.broker.getControl(f.roomId)).room.gate.version, 3);
  });
}

test('same-seat race has one winner; retry is idempotent and removal invalidates its old line only', async t => {
  const f = await fixture(t), hints = await f.capture();
  const results = await Promise.allSettled([f.enter('codex', hints.codex, 'one'), f.enter('codex', hints.codex, 'two')]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const winner = results.find(x => x.status === 'fulfilled').value;
  const retry = await f.enter('codex', hints.codex, winner.binding.nativeSessionId);
  assert.equal(retry.bindingId, winner.bindingId);
  const current = await f.broker.getControl(f.roomId);
  await f.broker.removeMember(f.roomId, 'codex', { operationId: 'remove', expectedGate: current.room.gate,
    expectedBindingId: winner.bindingId, expectedBindingVersion: 1, acknowledgePossibleRunning: false });
  await assert.rejects(f.enter('codex', hints.codex, 'one'), e => e.code === 'JOIN_CHANGED');
  assert.equal((await f.enter('claude', hints.claude)).agent, 'claude');
});

test('Stop and archive/restore invalidate copied join lines while fresh stopped-room lines still work', async t => {
  const f = await fixture(t), original = await f.capture();
  const stopped = await f.broker.stop(f.roomId, { operationId: 'stop', expectedGate: original.codex.expectedGate });
  await assert.rejects(f.enter('codex', original.codex), e => e.code === 'JOIN_CHANGED');
  const afterStop = await f.capture();
  const archived = await f.broker.archiveRoom(f.roomId, { operationId: 'archive', expectedRoomVersion: 1,
    expectedGate: stopped.gate, acknowledgePossibleRunning: false });
  await f.broker.restoreRoom(f.roomId, { operationId: 'restore', expectedRoomVersion: archived.room.version });
  await assert.rejects(f.enter('codex', afterStop.codex), e => e.code === 'JOIN_CHANGED');
  const fresh = await f.capture();
  assert.ok((await f.enter('codex', fresh.codex)).bindingId);
});

test('legacy gate remains strict and join generations cannot be used for replacement/reconnect', async t => {
  const f = await fixture(t), hints = await f.capture();
  const first = await f.enter('codex', hints.codex);
  await assert.rejects(f.broker.join(f.roomId, { agent: 'claude', nativeSessionId: 'legacy',
    expectedBindingId: null, expectedGate: hints.claude.expectedGate }), e => e.code === 'GATE_CHANGED');
  await assert.rejects(f.broker.join(f.roomId, { agent: 'codex', nativeSessionId: 'replacement',
    expectedBindingId: first.bindingId, expectedJoinVersion: 1, expectedGate: hints.codex.expectedGate }), e => e.code === 'INVALID_INPUT');
});
