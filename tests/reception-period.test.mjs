// 0.3.7: Claude's receiving period. The person picks 10 hours, 24 hours or "until I stop it" per room,
// and Claude's work requests and responses start the period again like an ordinary reply does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { V2Broker } from '../src/v2-broker.mjs';
import { WorkCoordinator } from '../src/v2-work.mjs';
import { createV2Server } from '../src/v2-server.mjs';
import { UNLIMITED_DEADLINE } from '../src/reception-period.mjs';

const op = () => randomUUID(), project = resolve(import.meta.dirname, '..');
const HOUR = 3600000, START = Date.parse('2026-10-19T00:00:00Z');
const iso = ms => new Date(ms).toISOString();

async function fixture(t) {
  await mkdir(join(project, 'work'), { recursive: true });
  const runtimeDir = await mkdtemp(join(project, 'work', 'reception-'));
  let now = START;
  const clock = () => now;
  const broker = await V2Broker.open({ runtimeDir, clock });
  const work = await WorkCoordinator.attach(broker, { clock });
  const server = await createV2Server({ broker, work, runtimeDir, projectDir: project });
  t.after(async () => { await server.close(); await work.close(); await broker.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const room = await broker.createRoom({ operationId: op(), name: 'Synthetic receiving period' }), roomId = room.roomId;
  const gate = async () => (await broker.getControl(roomId)).room.gate;
  const codex = await broker.join(roomId, { agent: 'codex', nativeSessionId: op(), expectedBindingId: null, expectedGate: await gate() });
  const claude = await broker.join(roomId, { agent: 'claude', nativeSessionId: op(), expectedBindingId: null, expectedGate: await gate() });
  const deadline = async () => (await broker.store.read(sql => sql.get('SELECT deadline_at FROM bindings WHERE id=?', [claude.bindingId]))).deadline_at;
  const member = async () => (await broker.getControl(roomId)).members.find(m => m.agent === 'claude');
  const setMode = (mode, operationId = op()) => broker.setClaudeReception(roomId, { operationId, mode });
  const startWork = async () => {
    const started = await work.start(roomId, { operationId: op(), expectedGate: await gate(), expectedBindings: { codex: codex.bindingId, claude: claude.bindingId },
      text: 'Synthetic task approved by the user', attachmentIds: [], objective: 'Synthetic work', unlimited: true });
    for (const [who, binding] of [['codex', codex], ['claude', claude]]) {
      const claimId = who === 'claude' ? op() : null;
      const deliveryId = await broker.store.read(async sql => (await sql.get('SELECT id FROM deliveries WHERE work_id=? AND agent=?', [started.work.id, who])).id);
      await broker.store.tx(sql => sql.run("UPDATE deliveries SET attempted=1,write_started=1,state='awaiting_reply',wait_disposition='waiting',claim_id=? WHERE id=?", [claimId, deliveryId]));
      await work.agent('accept', roomId, started.work.id, binding.bindingId, { operationId: op(), deliveryId, claimId, accept: true, text: 'Synthetic acceptance' });
    }
    return started.work.id;
  };
  return { broker, work, server, roomId, codex, claude, gate, deadline, member, setMode, startWork, advance: ms => { now += ms; }, now: () => now };
}

test('a new Claude seat gets the default 10-hour period, and the room says which period applies', async t => {
  const f = await fixture(t);
  assert.equal(await f.deadline(), iso(START + 10 * HOUR));
  const m = await f.member();
  assert.deepEqual(m.reception, { mode: '10h', seconds: 36000, unlimited: false, options: ['10h', '24h', 'unlimited'] });
  assert.equal((await f.broker.getControl(f.roomId)).members.find(x => x.agent === 'codex').reception, undefined);
});

test("Claude's work requests and responses start the period again; receipts, checkpoints, progress and state do not", async t => {
  const f = await fixture(t), workId = await f.startWork();
  f.advance(4 * HOUR);
  const accepted = await f.deadline(); // the acceptance itself renewed it at START
  assert.equal(accepted, iso(START + 10 * HOUR));
  await f.work.agent('requests', f.roomId, workId, f.claude.bindingId, { operationId: op(), toBindingId: f.codex.bindingId, kind: 'review_request', text: 'Synthetic review request', attachmentIds: [] });
  assert.equal(await f.deadline(), iso(START + 14 * HOUR), 'a request renews from now');
  f.advance(1 * HOUR);
  const asked = await f.work.agent('requests', f.roomId, workId, f.codex.bindingId, { operationId: op(), toBindingId: f.claude.bindingId, kind: 'handoff', text: 'Synthetic handoff', attachmentIds: [] });
  assert.equal(await f.deadline(), iso(START + 14 * HOUR), "Codex's request does not touch Claude's period");
  f.advance(1 * HOUR);
  const claim = await f.work.agent('checkpoint', f.roomId, workId, f.claude.bindingId, { operationId: op(), requestId: asked.requestId });
  const claimId = claim.items[0].claimId;
  await f.work.agent('received', f.roomId, workId, f.claude.bindingId, { operationId: op(), requestId: asked.requestId, claimId });
  await f.work.agent('progress', f.roomId, workId, f.claude.bindingId, { operationId: op(), text: 'Synthetic progress' });
  assert.equal(await f.deadline(), iso(START + 14 * HOUR), 'checkpoint, receipt and progress do not renew');
  f.advance(1 * HOUR);
  const body = { operationId: op(), requestId: asked.requestId, claimId, text: 'Synthetic response', attachmentIds: [] };
  await f.work.agent('responses', f.roomId, workId, f.claude.bindingId, body);
  assert.equal(await f.deadline(), iso(START + 17 * HOUR), 'a response renews from now');
  f.advance(1 * HOUR);
  await f.work.agent('responses', f.roomId, workId, f.claude.bindingId, body);
  assert.equal(await f.deadline(), iso(START + 17 * HOUR), 'a replayed response does not renew again');
  const p = (await f.work.get(f.roomId, workId)).participants.find(x => x.agent === 'claude');
  await f.work.agent('state', f.roomId, workId, f.claude.bindingId, { operationId: op(), expectedParticipantVersion: p.version, workState: 'awaiting_review', text: 'Synthetic state' });
  assert.equal(await f.deadline(), iso(START + 17 * HOUR), 'a state report does not renew');
});

test('an expired period is never renewed by work messages: only a reconnect does', async t => {
  const f = await fixture(t), workId = await f.startWork();
  const asked = await f.work.agent('requests', f.roomId, workId, f.codex.bindingId, { operationId: op(), toBindingId: f.claude.bindingId, kind: 'handoff', text: 'Synthetic handoff', attachmentIds: [] });
  const claim = await f.work.agent('checkpoint', f.roomId, workId, f.claude.bindingId, { operationId: op(), requestId: asked.requestId });
  f.advance(11 * HOUR);
  await assert.rejects(f.work.agent('requests', f.roomId, workId, f.claude.bindingId, { operationId: op(), toBindingId: f.codex.bindingId, kind: 'review_request', text: 'Synthetic late request', attachmentIds: [] }), e => e.code === 'WAIT_EXPIRED');
  await f.work.agent('responses', f.roomId, workId, f.claude.bindingId, { operationId: op(), requestId: asked.requestId, claimId: claim.items[0].claimId, text: 'Synthetic late response', attachmentIds: [] });
  assert.equal(await f.deadline(), iso(START + 10 * HOUR), 'a late response is recorded but does not revive the period');
});

test('the person chooses the period: a running one takes the new length from now, the choice is idempotent and logged once', async t => {
  const f = await fixture(t);
  f.advance(2 * HOUR);
  const operationId = op();
  const changed = await f.setMode('24h', operationId), replay = await f.setMode('24h', operationId);
  assert.equal(changed.deadlineAt, iso(START + 26 * HOUR));
  assert.deepEqual(replay, changed);
  assert.equal(await f.deadline(), iso(START + 26 * HOUR));
  assert.equal((await f.member()).reception.mode, '24h');
  await f.setMode('24h'); // same choice again: nothing changes, nothing logged
  const logged = await f.broker.store.read(sql => sql.get("SELECT COUNT(*) AS n FROM timeline WHERE room_id=? AND system_type='reception_changed'", [f.roomId]));
  assert.equal(logged.n, 1);
  await assert.rejects(f.setMode('forever'), e => e.code === 'INVALID_INPUT');
  await assert.rejects(f.broker.setClaudeReception(f.roomId, { operationId: op(), mode: '10h', hours: 5 }), e => e.code === 'UNKNOWN_FIELD');
  f.advance(1 * HOUR);
  await f.setMode('10h');
  assert.equal(await f.deadline(), iso(START + 13 * HOUR), 'a shorter choice also counts from now');
});

test('"until I stop it" keeps receiving through replies and windows; switching back starts a normal period', async t => {
  const f = await fixture(t);
  await f.setMode('unlimited');
  assert.equal(await f.deadline(), UNLIMITED_DEADLINE);
  assert.equal((await f.member()).reception.unlimited, true);
  f.advance(1000 * HOUR);
  const waited = await f.broker.wait(f.roomId, f.claude.bindingId, { requestId: op(), windowMs: 20 });
  assert.equal(waited.status, 'WINDOW_END', 'never TIMEOUT');
  const changed = await f.setMode('10h');
  assert.equal(changed.deadlineAt, iso(f.now() + 10 * HOUR));
});

test('an expired period is not revived by changing the choice; the reconnect then uses the new choice', async t => {
  const f = await fixture(t);
  f.advance(11 * HOUR);
  const before = await f.deadline();
  const changed = await f.setMode('24h');
  assert.equal(changed.deadlineAt, before);
  assert.equal((await f.broker.wait(f.roomId, f.claude.bindingId, { requestId: op() })).status, 'TIMEOUT');
  const control = await f.broker.getControl(f.roomId), m = control.members.find(x => x.agent === 'claude');
  await f.broker.join(f.roomId, { agent: 'claude', nativeSessionId: m.binding.nativeSessionId ?? (await f.broker.store.read(sql => sql.get('SELECT native_session_id FROM bindings WHERE id=?', [f.claude.bindingId]))).native_session_id,
    expectedBindingId: f.claude.bindingId, expectedGate: control.room.gate, reconnect: true, renew: true });
  assert.equal(await f.deadline(), iso(f.now() + 24 * HOUR));
});

test('a wait armed near the end of the period ends with WINDOW_END, not TIMEOUT, when the period was renewed meanwhile', async t => {
  const f = await fixture(t);
  f.advance(10 * HOUR - 150); // 150 ms of the period left: the wait's timer is the period, not the window
  const pending = f.broker.wait(f.roomId, f.claude.bindingId, { requestId: op(), windowMs: 60000 });
  await f.setMode('24h'); // renews the running period from now
  const result = await pending;
  assert.equal(result.status, 'WINDOW_END');
  assert.equal(result.deadlineAt, await f.deadline());
});

test('without a renewal the same wait still ends with TIMEOUT', async t => {
  const f = await fixture(t);
  f.advance(10 * HOUR - 50);
  const pending = f.broker.wait(f.roomId, f.claude.bindingId, { requestId: op(), windowMs: 60000 });
  f.advance(100);
  assert.equal((await pending).status, 'TIMEOUT');
});

test('only the person can choose: the human route works, and agents have no such route', async t => {
  const f = await fixture(t);
  const post = (path, body, headers) => fetch(`${f.server.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const human = { Authorization: `Bearer ${f.server.credentials().humanToken}`, Origin: f.server.url };
  const ok = await post(`/api/v2/rooms/${f.roomId}/members/claude/reception`, { operationId: op(), mode: 'unlimited' }, human);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.reception.mode, 'unlimited');
  const codexSeat = await post(`/api/v2/rooms/${f.roomId}/members/codex/reception`, { operationId: op(), mode: '24h' }, human);
  assert.equal(codexSeat.status, 404);
  const noAuth = await post(`/api/v2/rooms/${f.roomId}/members/claude/reception`, { operationId: op(), mode: '10h' }, { Origin: f.server.url });
  assert.ok(noAuth.status === 401 || noAuth.status === 403);
  assert.equal((await f.member()).reception.mode, 'unlimited');
});
