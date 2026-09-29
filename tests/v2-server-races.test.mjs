import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { V2Broker } from '../src/v2-broker.mjs';
import { WorkCoordinator } from '../src/v2-work.mjs';
import { createV2Server } from '../src/v2-server.mjs';

const project = resolve(import.meta.dirname, '..');
const op = () => randomUUID();
const json = JSON.stringify;

async function fixture(t) {
  await mkdir(join(project, 'work'), { recursive: true });
  const dir = await mkdtemp(join(project, 'work', 'v2-server-race-'));
  await mkdir(join(dir, 'ui'));
  await writeFile(join(dir, 'ui', 'index.html'), '<html><body>synthetic</body></html>');
  const runtimeDir = join(dir, 'runtime');
  const broker = await V2Broker.open({ runtimeDir });
  const work = await WorkCoordinator.attach(broker);
  const server = await createV2Server({ broker, work, runtimeDir, projectDir: dir });
  t.after(async () => {
    await work.close();
    await server.close();
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path, body, token, human = false) => fetch(`${server.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(human && body !== undefined ? { Origin: server.url } : {}),
    },
    ...(body === undefined ? {} : { body: json(body) }),
  });
  const human = (path, body) => request(`/api/v2${path}`, body, server.credentials().humanToken, true);
  const agent = (path, body, credential) => request(`/agent/v2${path}`, body, credential);
  const result = async response => {
    const value = await response.json();
    assert.equal(value.ok, true, json(value));
    return value.result;
  };
  const createRoom = async () => result(await human('/rooms', { operationId: op(), name: 'Synthetic race room' }));
  const joinAgent = async (roomId, role, expectedGate) => {
    const descriptor = JSON.parse(await readFile(join(runtimeDir, `connection-${role}.json`), 'utf8'));
    return result(await agent(`/rooms/${roomId}/join`, {
      agent: role, nativeSessionId: op(), expectedBindingId: null, expectedGate,
    }, descriptor.enrollmentToken));
  };
  return { broker, work, server, runtimeDir, human, agent, result, createRoom, joinAgent };
}

for(const trigger of ['Stop','lease expiry'])test(`a checkpoint committed just before ${trigger} cannot leave an invisible claimed request`, async t => {
  const f = await fixture(t);
  const created = await f.createRoom();
  const roomId = created.room.id;
  const codex = await f.joinAgent(roomId, 'codex', created.gate);
  const claude = await f.joinAgent(roomId, 'claude', (await f.broker.getControl(roomId)).room.gate);
  const started = await f.result(await f.human(`/rooms/${roomId}/work`, {
    operationId: op(), expectedGate: (await f.broker.getControl(roomId)).room.gate,
    expectedBindings: { codex: codex.bindingId, claude: claude.bindingId },
    text: 'Synthetic work', attachmentIds: [], objective: 'Exercise checkpoint Stop race',
    requestLimit: 3, wakeLimit: 0, durationSeconds: 36000,
  }));
  const workId = started.work.id;
  const kickoff = await f.broker.store.read(sql => sql.get('SELECT id FROM deliveries WHERE work_id=? AND agent=?', [workId, 'codex']));
  assert.ok(kickoff?.id);
  await f.broker.store.tx(sql => sql.run("UPDATE deliveries SET attempted=1,write_started=1,state='awaiting_reply',wait_disposition='waiting' WHERE id=?", [kickoff.id]));
  await f.work.agent('accept', roomId, workId, codex.bindingId, {
    operationId: op(), deliveryId: kickoff.id, claimId: null, text: 'Accepted', accept: true,
  });
  const sent = await f.work.agent('requests', roomId, workId, codex.bindingId, {
    operationId: op(), toBindingId: claude.bindingId, kind: 'review_request',
    text: 'Please review', attachmentIds: [],
  });

  // The HTTP handler is paused only after the real checkpoint transaction has committed.
  const originalAgent = f.work.agent.bind(f.work);
  let claimCommitted;
  const committed = new Promise(resolveCommitted => { claimCommitted = resolveCommitted; });
  let continueHandler;
  const released = new Promise(resolveReleased => { continueHandler = resolveReleased; });
  f.work.agent = async (...args) => {
    const value = await originalAgent(...args);
    if (args[0] === 'checkpoint') { claimCommitted(value); await released; }
    return value;
  };
  t.after(() => continueHandler());
  const checkpointOperation = op();
  const checkpointResponse = f.agent(`/rooms/${roomId}/work/${workId}/checkpoint`, {
    operationId: checkpointOperation,
  }, claude.credential);
  const claimed = await committed;
  assert.equal(claimed.items[0].requestId, sent.requestId);
  const beforeStop = (await f.work.requests(roomId, workId)).items.find(item => item.request.requestId === sent.requestId).request;
  assert.equal(beforeStop.requestState, 'claimed');
  if(trigger==='Stop')await f.result(await f.human(`/rooms/${roomId}/stop`, {
    operationId: op(), expectedGate: (await f.broker.getControl(roomId)).room.gate,
  }));
  else{f.work.clock=()=>Date.parse(claude.deadlineAt)+1;assert.ok(f.work.clock()<Date.parse(started.work.expiresAt),'lease expires before this later work grant');}
  continueHandler();
  const response = await checkpointResponse;
  const body = await response.json();
  assert.equal(body.ok, false, json(body));
  assert.equal(body.error.code, trigger==='Stop'?'ROOM_STOPPED':'WAIT_EXPIRED');
  assert.equal(body.error.outcome, 'unknown', 'the checkpoint operation committed before its response was withheld');
  const afterStop = (await f.work.requests(roomId, workId)).items.find(item => item.request.requestId === sent.requestId).request;
  assert.equal(afterStop.requestState, 'uncertain', 'an undisclosed claim needs explicit reconciliation');
  const row = await f.broker.store.read(sql => sql.get('SELECT data_json FROM work_requests WHERE id=?', [sent.requestId]));
  assert.equal(JSON.parse(row.data_json)._failureReason, 'CHECKPOINT_WITHHELD');
  const status=await f.result(await f.agent(`/rooms/${roomId}/work/${workId}/status`,undefined,codex.credential));
  assert.equal(status.work.coordinationState,trigger==='Stop'?'stopped':'paused_budget');
  assert.equal(status.work.participants.find(p=>p.bindingId===codex.bindingId).acceptance,'accepted');
  const other=await f.createRoom();
  assert.equal((await f.agent(`/rooms/${other.room.id}/work/${workId}/status`,undefined,codex.credential)).status,403);
});

test('join credential storage failure reports unknown after its binding transaction commits', async t => {
  const f = await fixture(t);
  const created = await f.createRoom();
  const roomId = created.room.id;
  const descriptor = JSON.parse(await readFile(join(f.runtimeDir, 'connection-claude.json'), 'utf8'));
  const originalTx = f.broker.store.tx.bind(f.broker.store);
  let injected = false;
  f.broker.store.tx = fn => originalTx(sql => fn({
    ...sql,
    run(statement, params) {
      if (!injected && /^INSERT INTO http_credentials\b/.test(statement)) {
        injected = true;
        throw Object.assign(new Error('synthetic credential write failed'), { code: 'SQLITE_ERROR' });
      }
      return sql.run(statement, params);
    },
  }));
  const response = await f.agent(`/rooms/${roomId}/join`, {
    agent: 'claude', nativeSessionId: op(),
    expectedBindingId: null, expectedGate: created.gate,
  }, descriptor.enrollmentToken);
  const body = await response.json();
  assert.equal(injected, true, json(body));
  assert.equal(body.ok, false, json(body));
  assert.equal(body.error.outcome, 'unknown', 'the binding was committed before credential storage failed');
  assert.equal(body.error.retrySameOperation, true);
  const bindingId = (await f.broker.getControl(roomId)).members.find(member => member.agent === 'claude')?.binding?.id;
  assert.ok(bindingId, 'the member join committed before credential creation failed');
  const credential = await f.broker.store.read(sql => sql.get('SELECT binding_id FROM http_credentials WHERE binding_id=?', [bindingId]));
  assert.equal(credential, null);
});

test('human message HTTP route accepts and preserves markdown content format', async t => {
  const f = await fixture(t);
  const created = await f.createRoom();
  const roomId = created.room.id;
  const text = '**Markdown** synthetic message';
  const sent = await f.result(await f.human(`/rooms/${roomId}/messages`, {
    operationId: op(), expectedGate: created.gate, recipients: ['claude'],
    text, format: 'markdown', attachmentIds: [],
  }));
  const stored = await f.broker.store.read(sql => sql.get('SELECT content_json FROM messages WHERE id=? AND room_id=?', [sent.messageId, roomId]));
  assert.ok(stored);
  assert.deepEqual(JSON.parse(stored.content_json), {
    previewText: text, format: 'markdown', truncated: false, attachmentId: null,
  });
});
