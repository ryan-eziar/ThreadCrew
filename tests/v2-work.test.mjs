import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { V2Broker } from '../src/v2-broker.mjs';
import { WorkCoordinator } from '../src/v2-work.mjs';
import { ThreadCrewFeatures } from '../src/threadcrew-features.mjs';

const root = resolve(import.meta.dirname, '..', 'work', 'v2-work-tests');
let serial = 0;
const op = label => `${label}-${++serial}`;
const code = expected => error => error.code === expected;
async function eventually(check) {
  for (let n = 0; n < 300; n++) { if (await check()) return; await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
  assert.fail('condition did not become true');
}
async function fixture(t, options = {}) {
  await mkdir(root, { recursive: true });
  const runtimeDir = await mkdtemp(join(root, 'case-'));
  const broker = await V2Broker.open({ runtimeDir, ...options });
  const work = await WorkCoordinator.attach(broker, options);
  t.after(async () => { await work.close(); await broker.close?.(); await broker.store.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const created = await broker.createRoom({ operationId: op('room'), name: 'Synthetic work room' });
  const roomId = created.room.id;
  const gate = async () => (await broker.getControl(roomId)).room.gate;
  const codex = await broker.join(roomId, { agent: 'codex', nativeSessionId: op('codex-session'), label: 'Codex test', expectedBindingId: null, expectedGate: created.gate });
  const claude = await broker.join(roomId, { agent: 'claude', nativeSessionId: op('claude-session'), label: 'Claude test', expectedBindingId: null, expectedGate: await gate() });
  const begin = async ({ requestLimit = 6, wakeLimit = 3 } = {}) => work.start(roomId, {
    operationId: op('start'), expectedGate: await gate(), expectedBindings: { codex: codex.bindingId, claude: claude.bindingId },
    text: 'Synthetic implementation task', attachmentIds: [], objective: 'Implement synthetic feature', requestLimit, wakeLimit, durationSeconds: 3600
  });
  // The fixture records a synthetic native handoff without invoking a model.
  // Work acceptance still runs through the broker's exact delivery/claim validation.
  const handoff = async (deliveryId, claimId = null) => broker.store.tx(sql => sql.run(`UPDATE deliveries
    SET attempted=1,write_started=1,state='awaiting_reply',wait_disposition='waiting',claim_id=? WHERE id=? AND room_id=?`, [claimId, deliveryId, roomId]));
  const accept = async (started, who, claimId = null) => {
    const bindingId = who === 'codex' ? codex.bindingId : claude.bindingId;
    const deliveryId = started.work._kickoff?.[who] ?? await broker.store.read(async sql => (await sql.get('SELECT id FROM deliveries WHERE work_id=? AND agent=?', [started.work.id, who])).id);
    await handoff(deliveryId, claimId);
    return work.agent('accept', roomId, started.work.id, bindingId,
      { operationId: op(`accept-${who}`), deliveryId, claimId, text: `${who} accepts`, accept: true });
  };
  const request = (workId, from, to, text = 'Please review') => work.agent('requests', roomId, workId, from, {
    operationId: op('request'), toBindingId: to, kind: 'review_request', text, attachmentIds: [] });
  return { broker, work, roomId, codex, claude, gate, begin, accept, request, handoff, runtimeDir };
}

for (const agent of ['codex','claude']) test(`removal of ${agent} warns about stopped and released work even without ordinary replies pending`, async t => {
  const f=await fixture(t),started=await f.begin();
  await f.accept(started,'codex');await f.accept(started,'claude','remove-work-claim');
  await f.broker.stop(f.roomId,{operationId:op('stop-removal'),expectedGate:await f.gate()});
  const member=async()=>(await f.broker.getControl(f.roomId)).members.find(m=>m.agent===agent);
  let m=await member();
  assert.equal(m.openWork.possibleRunning,0);
  assert.equal(m.removalImpact.requiresAcknowledgement,true);
  assert.equal(m.removalImpact.hasHeldWork,true);
  assert.deepEqual(m.removalImpact.possibleRunningAgents,['codex','claude']);
  const remove=ack=>f.broker.removeMember(f.roomId,agent,{operationId:op('remove'),expectedGate:awaitGate,
    expectedBindingId:m.binding.id,expectedBindingVersion:m.binding.version,acknowledgePossibleRunning:ack});
  let awaitGate=await f.gate();
  await assert.rejects(remove(false),code('POSSIBLE_RUNNING_ACK_REQUIRED'));
  assert.equal((await member()).binding.id,m.binding.id,'rejection leaves the binding in place');
  const w=await f.work.get(f.roomId,started.work.id);
  await f.work.release(f.roomId,w.id,{operationId:op('release'),expectedGate:await f.gate(),expectedWorkVersion:w.version,acknowledgePossibleRunning:true});
  m=await member();awaitGate=await f.gate();
  assert.equal(m.removalImpact.hasHeldWork,false);
  assert.equal(m.removalImpact.requiresAcknowledgement,true,'release does not clear possible native execution');
  await assert.rejects(remove(false),code('POSSIBLE_RUNNING_ACK_REQUIRED'));
  await remove(true);
  assert.equal((await member()).binding,null);
  assert.equal((await member()).removalImpact,null);
});

test('held work without an accepted participant still requires a removal acknowledgement',async t=>{
  const f=await fixture(t),initial=(await f.broker.getControl(f.roomId)).members[0];
  assert.deepEqual(initial.removalImpact,{requiresAcknowledgement:false,possibleRunningAgents:[],hasHeldWork:false});
  await f.begin();
  await f.broker.stop(f.roomId,{operationId:op('stop-unaccepted'),expectedGate:await f.gate()});
  const m=(await f.broker.getControl(f.roomId)).members.find(m=>m.agent==='claude');
  assert.equal(m.removalImpact.hasHeldWork,true);
  assert.equal(m.removalImpact.requiresAcknowledgement,true);
  assert.deepEqual(m.removalImpact.possibleRunningAgents,[]);
  await assert.rejects(f.broker.removeMember(f.roomId,'claude',{operationId:op('unconfirmed'),expectedGate:await f.gate(),
    expectedBindingId:m.binding.id,expectedBindingVersion:m.binding.version}),code('POSSIBLE_RUNNING_ACK_REQUIRED'));
});

test('unread locator reaches unloaded replies and both completed work records, then clears with the read cursor', async t => {
  const f=await fixture(t);
  const summary=async()=>(await f.broker.listRooms()).rooms.find(r=>r.id===f.roomId);
  assert.equal((await summary()).firstUnread,null);
  await f.broker.sendHuman(f.roomId,{operationId:op('ordinary-unread'),expectedGate:await f.gate(),
    recipients:['claude'],text:'Synthetic ordinary question',attachmentIds:[]});
  const ordinary=await f.broker.read(f.roomId,f.claude.bindingId,{requestId:op('ordinary-read')},()=>{});
  await f.broker.postReply(f.roomId,f.claude.bindingId,{deliveryId:ordinary.deliveryId,claimId:ordinary.claimId,text:'Synthetic ordinary answer'});
  const started=await f.begin();
  await f.accept(started,'codex');await f.accept(started,'claude','unread-kickoff-claim');
  const request=await f.request(started.work.id,f.codex.bindingId,f.claude.bindingId);
  const claim=(await f.work.agent('checkpoint',f.roomId,started.work.id,f.claude.bindingId,{operationId:op('unread-request-claim')})).items[0];
  await f.work.agent('responses',f.roomId,started.work.id,f.claude.bindingId,
    {operationId:op('unread-response'),requestId:request.requestId,claimId:claim.claimId,text:'Synthetic work answer',attachmentIds:[]});
  const response=(await f.work.agent('checkpoint',f.roomId,started.work.id,f.codex.bindingId,{operationId:op('unread-response-claim')})).items[0];
  await f.work.agent('received',f.roomId,started.work.id,f.codex.bindingId,
    {operationId:op('unread-response-receipt'),requestId:request.requestId,claimId:response.claimId});
  for(const who of ['codex','claude']){
    const p=(await f.work.get(f.roomId,started.work.id)).participants.find(p=>p.agent===who);
    await f.work.agent('state',f.roomId,started.work.id,p.bindingId,
      {operationId:op('unread-completed'),expectedParticipantVersion:p.version,workState:'completed',text:'Synthetic task completed'});
  }
  const counted=(await f.broker.getTimeline(f.roomId,{limit:100})).items.filter(e=>e.kind==='reply'||
    (e.kind==='work'&&(e.work.eventKind==='response'||(e.work.eventKind==='participant_state'&&e.work.workState==='completed'))));
  assert.equal(counted.length,4);
  const tail=await f.broker.getTimeline(f.roomId,{limit:2});
  assert.ok(!tail.items.some(e=>e.id===counted[0].id),'first unread is outside the latest loaded page');
  const other=await f.broker.createRoom({operationId:op('unread-other-room'),name:'Other synthetic room'});
  for(let n=0;n<counted.length;n++){
    const room=await summary(),target=counted[n];
    assert.equal(room.unreadReplyCount,counted.length-n);
    assert.equal(room.firstUnread.timelineItemId,target.id);
    assert.equal(room.firstUnread.timelineOrder,target.order);
    const page=await f.broker.getTimeline(f.roomId,{around:room.firstUnread.aroundCursor,limit:3});
    assert.equal(page.targetItemId,target.id);assert.ok(page.items.some(e=>e.id===target.id));
    await assert.rejects(f.broker.getTimeline(other.roomId,{around:room.firstUnread.aroundCursor}),code('INVALID_CURSOR'));
    await f.broker.setReadPosition(f.roomId,{operationId:op('unread-seen'),throughOrder:target.order});
    await f.broker.setReadPosition(f.roomId,{operationId:op('unread-old-ack'),throughOrder:0});
    assert.equal((await summary()).readThroughOrder,target.order,'late old acknowledgement cannot move the cursor back');
  }
  assert.equal((await summary()).unreadReplyCount,0);
  assert.equal((await summary()).firstUnread,null);
});

test('combined wait receives ordinary and scoped work notifications without a second waiter', { timeout: 20000 }, async t => {
  const f = await fixture(t); const started = await f.begin();
  await f.accept(started, 'codex'); await f.accept(started, 'claude', 'combined-kickoff-claim');
  const controller = new AbortController(); t.after(() => controller.abort());
  const wait = () => f.broker.wait(f.roomId, f.claude.bindingId, {
    requestId: op('combined-wait'), notificationScopes: ['ordinary', 'work'],
    workId: started.work.id, signal: controller.signal,
  });
  await f.broker.sendHuman(f.roomId, { operationId: op('combined-human'), expectedGate: await f.gate(),
    recipients: ['claude'], text: 'Ordinary message during work', attachmentIds: [] });
  const ordinary = await wait();
  assert.equal(ordinary.status, 'NEW'); assert.ok(ordinary.batchId); assert.equal(ordinary.workId, undefined);
  const delivery = await f.broker.read(f.roomId, f.claude.bindingId, { requestId: op('combined-read'), batchId: ordinary.batchId }, () => {});
  assert.equal(delivery.text, 'Ordinary message during work');
  assert.equal(delivery.mode,'discussion'); assert.equal(delivery.authorizedScope,null);
  await f.broker.postReply(f.roomId, f.claude.bindingId, { deliveryId: delivery.deliveryId, claimId: delivery.claimId, text: 'Ordinary reply' });
  const request = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId);
  const work = await wait();
  assert.equal(work.status, 'NEW'); assert.equal(work.workId, started.work.id);
  assert.deepEqual(work.requestIds, [request.requestId]); assert.equal(work.batchId, undefined);
  const checkpoint = await f.work.agent('checkpoint', f.roomId, started.work.id, f.claude.bindingId, { operationId: op('combined-checkpoint') });
  assert.equal(checkpoint.items[0].requestId, request.requestId);
  assert.equal(checkpoint.mode,'work');
  assert.equal(checkpoint.authorizedScope.sourceHumanMessageId,started.work.sourceHumanMessageId);
  const status=await f.work.agentStatus(f.roomId,started.work.id,f.claude.bindingId);
  assert.equal(status.authorizedScope.text,'Synthetic implementation task');
  assert.equal(status.authorizedScope.textSha256,createHash('sha256').update(status.authorizedScope.text).digest('hex'));
  assert.equal(checkpoint.authorizedScope.text,undefined,'compact native reference must not duplicate the full scope');
  assert.equal((await f.work.get(f.roomId, started.work.id)).wakeBudget.used, 1);
});

test('acceptance replies settle kickoff deliveries while the work remains held and active', async t => {
  const f = await fixture(t); const started = await f.begin();
  await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
  const summary = await f.work.get(f.roomId, started.work.id);
  assert.equal(summary.occupancy, 'held'); assert.equal(summary.coordinationState, 'active');
  assert.deepEqual(summary.participants.map(p => p.acceptance), ['accepted', 'accepted']);
  assert.deepEqual(summary.participants.map(p => p.workState), ['working', 'working']);
  const kickoff = await f.broker.store.read(sql => sql.all('SELECT final_reply_id FROM deliveries WHERE work_id=?', [started.work.id]));
  assert.ok(kickoff.every(row => row.final_reply_id));
  assert.equal((await f.broker.getControl(f.roomId)).room.actions.stop.enabled, true);
});

test('kickoff acknowledgements cannot start a discussion during or after completed work',async t=>{
  const f=await fixture(t),started=await f.begin();
  const accepted={codex:await f.accept(started,'codex'),claude:await f.accept(started,'claude','claim-discussion-guard')};
  const assertNotDiscussion=async()=>{
    const candidate=(await f.broker.getControl(f.roomId)).discussionCandidate;
    assert.equal(candidate.baseMessageId,started.work.sourceHumanMessageId);
    assert.deepEqual(candidate.availability,{enabled:false,reason:'KICKOFF_MESSAGE',baseReplyIds:null});
    await assert.rejects(f.broker.startExchange(f.roomId,{
      operationId:op('discuss-kickoff'),expectedGate:await f.gate(),baseMessageId:started.work.sourceHumanMessageId,
      baseReplyIds:{codex:accepted.codex.replyId,claude:accepted.claude.replyId},maxRounds:1,
    }),code('KICKOFF_MESSAGE'));
  };
  await assertNotDiscussion();
  for(const p of (await f.work.get(f.roomId,started.work.id)).participants) {
    await f.work.agent('state',f.roomId,started.work.id,p.bindingId,{operationId:op('complete-discussion-guard'),expectedParticipantVersion:p.version,workState:'completed',text:'Completed'});
  }
  assert.equal((await f.work.get(f.roomId,started.work.id)).coordinationState,'completed');
  await assertNotDiscussion();
});

test('original scope remains exact after restart and is not replaced by later discussion',async t=>{
  const f=await fixture(t), started=await f.begin();
  await f.broker.sendHuman(f.roomId,{operationId:op('discussion'),expectedGate:await f.gate(),recipients:['claude'],text:'Unapproved additional feature',attachmentIds:[]});
  const before=await f.work.agentStatus(f.roomId,started.work.id,f.codex.bindingId);
  await f.work.close(); await f.broker.close();
  const broker=await V2Broker.open({runtimeDir:f.runtimeDir}),work=await WorkCoordinator.attach(broker);
  try {
    assert.deepEqual((await work.agentStatus(f.roomId,started.work.id,f.codex.bindingId)).authorizedScope,before.authorizedScope);
    await assert.rejects(work.agentStatus(f.roomId,started.work.id,'unrelated-binding'),code('FORBIDDEN'));
  } finally {await work.close();await broker.close();}
});

test('exit preview distinguishes active work, a pending request and its pending response',async t=>{
  const f=await fixture(t),started=await f.begin(),features=new ThreadCrewFeatures(f.broker,resolve(import.meta.dirname,'..'));
  await f.accept(started,'codex');await f.accept(started,'claude','preview-claim');
  const request=await f.request(started.work.id,f.codex.bindingId,f.claude.bindingId);
  const first=await features.shutdownPreview();
  assert.equal(first.counts.activeWorkRooms,1);assert.equal(first.counts.pendingWorkRequests,1);assert.equal(first.counts.pendingWorkResponses,0);
  const batch=await f.work.agent('checkpoint',f.roomId,started.work.id,f.claude.bindingId,{operationId:op('preview-read')});
  await f.work.agent('responses',f.roomId,started.work.id,f.claude.bindingId,{operationId:op('preview-response'),requestId:request.requestId,claimId:batch.items[0].claimId,text:'Reviewed',attachmentIds:[]});
  const final=await features.shutdownPreview();assert.equal(final.counts.pendingWorkRequests,0);assert.equal(final.counts.pendingWorkResponses,1);
});

test('unavailable receive mode never routes work and persisted capability is not reused after invalidation', async t => {
  let sends = 0;
  const f = await fixture(t, { codexReceiveMode: 'next_step', transport: { sendWork: async () => { sends++; return { status: 'sent' }; } } });
  const started = await f.begin(); await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-capability');
  f.work.receiveModes.codex = 'unavailable';
  await f.request(started.work.id, f.claude.bindingId, f.codex.bindingId);
  await f.work.flushNative(f.roomId);
  assert.equal(sends, 0);
  assert.equal((await f.work.get(f.roomId, started.work.id)).participants.find(p => p.agent === 'codex').receiveMode, 'unavailable');
  const projected = (await f.broker.getControl(f.roomId)).members.find(m => m.agent === 'codex');
  assert.equal(projected.canReceiveCollaboration, false);
  assert.equal(projected.collaborationReceiveMode, 'unavailable');
  assert.throws(() => new WorkCoordinator(f.broker, { codexReceiveMode: 'native_push' }), code('INVALID_RECEIVE_MODE'));
});

test('live capability is rechecked before claiming a queued request without spending a wake on stale proof', async t => {
  let currentMode = 'unverified', sends = 0, checks = 0;
  const transport = { sendWork: async (_delivery, { beforeSend }) => { beforeSend(); sends++; return { status: 'sent' }; } };
  const f = await fixture(t, { codexReceiveMode: 'next_step', transport, codexReceiveModeProvider: async () => { checks++; return currentMode; } });
  const started = await f.begin(); await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-live-capability');
  const request = await f.request(started.work.id, f.claude.bindingId, f.codex.bindingId);
  await f.work.flushNative(f.roomId);
  assert.equal(sends, 0);
  assert.equal((await f.work.get(f.roomId, started.work.id)).wakeBudget.used, 0);
  assert.equal((await f.broker.store.read(sql => sql.get('SELECT state FROM work_requests WHERE id=?', [request.requestId]))).state, 'queued');
  assert.ok(checks >= 1);
  currentMode = 'next_step';
  await f.work.flushNative(f.roomId);
  assert.equal(sends, 1);
  assert.equal((await f.work.get(f.roomId, started.work.id)).wakeBudget.used, 1);
});

test('accepted work can exchange a request through checkpoint while the primary work continues', async t => {
  const f = await fixture(t); const started = await f.begin(); await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
  const sent = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId);
  const checkpoint = await f.work.agent('checkpoint', f.roomId, started.work.id, f.claude.bindingId, { operationId: op('checkpoint') });
  assert.equal(checkpoint.status, 'DELIVERY'); assert.equal(checkpoint.items.length, 1);
  const item = checkpoint.items[0]; assert.equal(item.requestId, sent.requestId); assert.equal(item.origin, 'codex');
  const replay = await f.work.agent('checkpoint', f.roomId, started.work.id, f.claude.bindingId, { operationId: checkpoint.operationId });
  assert.deepEqual(replay.items, checkpoint.items);
  await f.work.agent('received', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('received'), requestId: item.requestId, claimId: item.claimId });
  const response = await f.work.agent('responses', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('response'), requestId: item.requestId, claimId: item.claimId, text: 'Reviewed', attachmentIds: [] });
  assert.equal(response.lateReason, null);
  const duplicate = await f.work.agent('responses', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('same-final-new-operation'), requestId: item.requestId, claimId: item.claimId, text: 'Reviewed', attachmentIds: [] });
  assert.equal(duplicate.replyId, response.replyId); assert.equal(duplicate.duplicate, true);
  const timeline = await f.broker.getTimeline(f.roomId);
  const responses = timeline.items.filter(entry => entry.kind === 'work' && entry.work?.eventKind === 'response' && entry.work.requestId === item.requestId);
  assert.equal(responses.length, 1);
  const linked = await f.broker.getTimeline(f.roomId, { around: responses[0].work.replyTo.aroundCursor });
  assert.equal(linked.targetItemId, responses[0].work.replyTo.itemId);
  const summary = await f.work.get(f.roomId, started.work.id);
  assert.equal(summary.coordinationState, 'active'); assert.equal(summary.occupancy, 'held');
  assert.deepEqual(summary.participants.map(p => p.workState), ['working', 'working']);
});

test('request budget and idempotency are independent of wake budget', async t => {
  const f = await fixture(t); const started = await f.begin({ requestLimit: 1, wakeLimit: 0 }); await f.accept(started, 'codex');
  const body = { operationId: op('one-request'), toBindingId: f.claude.bindingId, kind: 'handoff', text: 'One', attachmentIds: [] };
  const first = await f.work.agent('requests', f.roomId, started.work.id, f.codex.bindingId, body);
  const replay = await f.work.agent('requests', f.roomId, started.work.id, f.codex.bindingId, body);
  assert.equal(first.requestId, replay.requestId); assert.equal(first.requestNumber, 1);
  await assert.rejects(f.work.agent('requests', f.roomId, started.work.id, f.codex.bindingId,
    { ...body, operationId: op('second-request'), text: 'Two' }), code('REQUEST_BUDGET_EXHAUSTED'));
  const summary = await f.work.get(f.roomId, started.work.id);
  assert.deepEqual(summary.requestBudget, { limit: 1, used: 1, remaining: 0 });
  assert.deepEqual(summary.wakeBudget, { limit: 0, used: 0, remaining: 0 });
  const claimed = await f.work.agent('checkpoint', f.roomId, started.work.id, f.claude.bindingId, { operationId: op('checkpoint') });
  assert.equal(claimed.items[0].requestId, first.requestId, 'accepted request is still claimable when wake budget is exhausted');
});

test('explicit checkpoint can claim a fourth queued request without claiming the first three', async t => {
  const f = await fixture(t); const started = await f.begin({ requestLimit: 4, wakeLimit: 0 }); await f.accept(started, 'codex');
  const requests = [];
  for (let number = 1; number <= 4; number++) requests.push(await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId, `Request ${number}`));
  const exact = await f.work.agent('checkpoint', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('checkpoint-fourth'), requestId: requests[3].requestId });
  assert.equal(exact.items.length, 1); assert.equal(exact.items[0].requestId, requests[3].requestId);
  const list = (await f.work.requests(f.roomId, started.work.id)).items.map(item => item.request);
  assert.deepEqual(list.map(item => item.requestState), ['queued', 'queued', 'queued', 'claimed']);
});

test('Stop cancels notification-only requests but preserves a claimed request for an exact late final', async t => {
  const f = await fixture(t); const started = await f.begin(); await f.accept(started, 'codex');
  const claimedRequest = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId, 'Claim me');
  const checkpoint = await f.work.agent('checkpoint', f.roomId, started.work.id, f.claude.bindingId, { operationId: op('checkpoint') });
  const claim = checkpoint.items[0];
  const queuedRequest = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId, 'Not claimed');
  const notice = await f.work.nextNotification({ roomId: f.roomId, bindingId: f.claude.bindingId,
    notificationScopes: ['work'], workId: started.work.id });
  assert.equal(notice.status, 'NEW'); assert.deepEqual(notice.requestIds, [queuedRequest.requestId]);
  const notified = (await f.work.requests(f.roomId, started.work.id)).items.find(item => item.request.requestId === queuedRequest.requestId).request;
  assert.equal(notified.requestState, 'notified');
  await f.broker.stop(f.roomId, { operationId: op('stop'), expectedGate: await f.gate() });
  const queued = (await f.work.requests(f.roomId, started.work.id)).items.find(item => item.request.requestId === queuedRequest.requestId).request;
  assert.equal(queued.requestState, 'cancelled');
  const late = await f.work.agent('responses', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('late-response'), requestId: claimedRequest.requestId, claimId: claim.claimId, text: 'Late exact answer', attachmentIds: [] });
  assert.equal(late.lateReason, 'stopped');
  const historical = (await f.work.requests(f.roomId, started.work.id)).items.find(item => item.request.requestId === claimedRequest.requestId).request;
  assert.equal(historical.requestState, 'answered');
});

test('abandon and resend retain separate numbered request history and do not reuse the old claim', async t => {
  const f = await fixture(t); const started = await f.begin({ requestLimit: 2 }); await f.accept(started, 'codex');
  const first = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId);
  const claimed = await f.work.agent('checkpoint', f.roomId, started.work.id, f.claude.bindingId, { operationId: op('checkpoint') });
  const old = (await f.work.requests(f.roomId, started.work.id)).items[0].request;
  const abandoned = await f.work.abandon(f.roomId, started.work.id, first.requestId,
    { operationId: op('abandon'), expectedRequestVersion: old.requestVersion });
  assert.equal(abandoned.request.waitDisposition, 'abandoned');
  const resent = await f.work.resend(f.roomId, started.work.id, first.requestId,
    { operationId: op('resend'), expectedGate: await f.gate(), expectedRequestVersion: abandoned.request.requestVersion, acknowledgeDuplicateRisk: true });
  assert.equal(resent.previousRequest.requestId, first.requestId);
  assert.equal(resent.request.resendOfRequestId, first.requestId);
  assert.equal(resent.request.requestNumber, first.requestNumber + 1);
  await f.work.agent('responses', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('late-old'), requestId: first.requestId, claimId: claimed.items[0].claimId, text: 'Old late result', attachmentIds: [] });
  const list = (await f.work.requests(f.roomId, started.work.id)).items.map(item => item.request);
  assert.equal(list.length, 2); assert.equal(list[0].waitDisposition, 'abandoned'); assert.equal(list[1].requestState, 'queued');
});

test('work authorization is fixed to room and original binding; completed participants wait for pending requests', async t => {
  const f = await fixture(t); const started = await f.begin(); await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
  await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId);
  const other = await f.broker.createRoom({ operationId: op('other-room'), name: 'Other synthetic room' });
  await assert.rejects(f.work.get(other.room.id, started.work.id), code('WORK_NOT_FOUND'));
  await assert.rejects(f.work.agent('checkpoint', other.room.id, started.work.id, f.claude.bindingId, { operationId: op('wrong-room') }), code('WORK_NOT_FOUND'));
  await assert.rejects(f.work.agent('checkpoint', f.roomId, started.work.id, 'binding-unknown', { operationId: op('wrong-binding') }), code('FORBIDDEN'));
  let summary = await f.work.get(f.roomId, started.work.id);
  for (const p of summary.participants) {
    const result = await f.work.agent('state', f.roomId, started.work.id, p.bindingId,
      { operationId: op(`complete-${p.agent}`), expectedParticipantVersion: p.version, workState: 'completed', text: 'Finished primary task' });
    summary = result.work;
  }
  assert.equal(summary.occupancy, 'held'); assert.equal(summary.coordinationState, 'active');
  assert.equal(summary.pendingRequestCount, 1);
});

test('replacing a work participant stops collaboration and never grants the replacement the old work', async t => {
  const f = await fixture(t); const started = await f.begin(); await f.accept(started, 'codex');
  const replacement = await f.broker.join(f.roomId, { agent: 'claude', nativeSessionId: op('replacement-session'),
    label: 'Replacement Claude', expectedBindingId: f.claude.bindingId, expectedGate: await f.gate() });
  assert.notEqual(replacement.bindingId, f.claude.bindingId);
  const summary = await f.work.get(f.roomId, started.work.id);
  assert.equal(summary.coordinationState, 'stopped');
  assert.equal(summary.participants.find(p => p.agent === 'claude').bindingId, f.claude.bindingId);
  await assert.rejects(f.work.agent('checkpoint', f.roomId, started.work.id, replacement.bindingId,
    { operationId: op('replacement-checkpoint') }), code('FORBIDDEN'));
  await assert.rejects(f.work.agent('requests', f.roomId, started.work.id, f.codex.bindingId,
    { operationId: op('old-work-request'), toBindingId: replacement.bindingId, kind: 'handoff', text: 'Wrong member', attachmentIds: [] }), code('WORK_NOT_ACTIVE'));
});

test('a busy Claude binding can arm work-scoped wait without ending its primary work', async t => {
  const f = await fixture(t); const started = await f.begin();
  await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
  const controller = new AbortController();
  const waiting = f.broker.wait(f.roomId, f.claude.bindingId,
    { requestId: op('work-wait'), notificationScopes: ['work'], workId: started.work.id, signal: controller.signal });
  try {
    await eventually(async () => (await f.broker.getControl(f.roomId)).currentWork.participants.find(p => p.agent === 'claude').inboxWait === 'armed');
    const control = await f.broker.getControl(f.roomId);
    const claude = control.members.find(member => member.agent === 'claude');
    assert.equal(claude.state, 'busy');
    assert.equal(claude.wait.state, 'armed');
    assert.deepEqual(claude.wait.notificationScopes, ['work']);
    await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId);
    const notice = await waiting;
    assert.equal(notice.status, 'NEW'); assert.equal(notice.workId, started.work.id);
    assert.equal((await f.work.get(f.roomId, started.work.id)).participants.find(p => p.agent === 'claude').workState, 'working');
  } finally {
    controller.abort(); await waiting.catch(() => {});
    await eventually(async () => (await f.work.get(f.roomId, started.work.id)).participants.find(p => p.agent === 'claude').inboxWait !== 'armed');
  }
});

test('native work transport failure settles the exact claim as uncertain without spending a second wake', async t => {
  const attempts = [];
  const transport = { async sendWork(delivery, controls) { controls.beforeSend(); attempts.push(delivery); throw new Error('synthetic transport failure'); } };
  const f = await fixture(t, { transport, codexReceiveMode: 'next_step' });
  const started = await f.begin({ requestLimit: 2, wakeLimit: 1 });
  await f.accept(started, 'claude', 'claim-kickoff-claude');
  const sent = await f.request(started.work.id, f.claude.bindingId, f.codex.bindingId);
  await eventually(async () => (await f.work.requests(f.roomId, started.work.id)).items[0]?.request.requestState === 'uncertain');
  const item = (await f.work.requests(f.roomId, started.work.id)).items[0].request;
  assert.equal(item.requestId, sent.requestId); assert.equal(item.waitDisposition, 'waiting');
  assert.equal(attempts.length, 1);
  const summary = await f.work.get(f.roomId, started.work.id);
  assert.deepEqual(summary.wakeBudget, { limit: 1, used: 1, remaining: 0 });
  const attention = (await f.broker.getControl(f.roomId)).needsRyan;
  assert.equal(attention.items.filter(entry => entry.kind === 'uncertain' && entry.requestId === sent.requestId).length, 1,
    'uncertain work request needs one request-linked attention item');
});

test('a blocked work state contributes one attention item and one catalog notice', async t => {
  const f = await fixture(t); const started = await f.begin();
  await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
  const frames = []; const listener = frame => frames.push(frame);
  f.broker.on('catalog.delta', listener); t.after(() => f.broker.off('catalog.delta', listener));
  const participant = (await f.work.get(f.roomId, started.work.id)).participants.find(p => p.agent === 'claude');
  await f.work.agent('state', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('blocked'), expectedParticipantVersion: participant.version, workState: 'blocked', text: 'Needs Ryan decision' });
  const control = await f.broker.getControl(f.roomId);
  const attention = control.needsRyan.items.filter(item => item.workId === started.work.id && item.kind === 'work_blocked');
  assert.equal(attention.length, 1);
  assert.ok(control.needsRyan.count >= 1, 'attention count must include projected work items');
  assert.equal(frames.flatMap(frame => frame.notices).filter(item => item.kind === 'work_blocked' && item.workId === started.work.id).length, 1);
});

test('registered attachment reaches sendWork with its exact file and SHA-256', async t => {
  const sent = [];
  const transport = { async sendWork(delivery, controls) { controls.beforeSend(); sent.push(delivery); return { status: 'sent' }; } };
  const f = await fixture(t, { transport, codexReceiveMode: 'next_step' });
  const started = await f.begin({ requestLimit: 3, wakeLimit: 2 });
  await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
  const seed = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId, 'Attachment seed '.repeat(250));
  const attachmentId = (await f.work.requests(f.roomId, started.work.id)).items.find(item => item.request.requestId === seed.requestId).request.content.attachmentId;
  assert.ok(attachmentId);
  const request = await f.work.agent('requests', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('attachment-request'), toBindingId: f.codex.bindingId, kind: 'review_request', text: 'Review attached text', attachmentIds: [attachmentId] });
  await eventually(() => sent.some(delivery => delivery.requestId === request.requestId));
  const delivery = sent.find(item => item.requestId === request.requestId);
  assert.deepEqual(delivery.attachmentIds, [attachmentId]); assert.equal(delivery.attachments.length, 1);
  assert.equal(delivery.attachments[0].id, attachmentId);
  const bytes = await readFile(delivery.attachments[0].path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), delivery.attachments[0].sha256);
  assert.equal(bytes.toString('utf8'), 'Attachment seed '.repeat(250));
});

test('tampered registered attachment blocks transport and records a failed request', async t => {
  const sent = [];
  const transport = { async sendWork(delivery, controls) { controls.beforeSend(); sent.push(delivery); return { status: 'sent' }; } };
  const f = await fixture(t, { transport, codexReceiveMode: 'next_step' });
  const started = await f.begin({ requestLimit: 3, wakeLimit: 2 });
  await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
  const seed = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId, 'Original attachment '.repeat(200));
  const attachmentId = (await f.work.requests(f.roomId, started.work.id)).items.find(item => item.request.requestId === seed.requestId).request.content.attachmentId;
  const relativePath = await f.broker.store.read(async sql => (await sql.get('SELECT relative_path FROM attachments WHERE id=?', [attachmentId])).relative_path);
  await writeFile(resolve(f.runtimeDir, relativePath), 'Tampered attachment bytes');
  const request = await f.work.agent('requests', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('tampered-request'), toBindingId: f.codex.bindingId, kind: 'review_request', text: 'Review attached text', attachmentIds: [attachmentId] });
  await eventually(async () => (await f.work.requests(f.roomId, started.work.id)).items.find(item => item.request.requestId === request.requestId)?.request.requestState === 'failed');
  assert.equal(sent.length, 0);
  const attention = (await f.broker.getControl(f.roomId)).needsRyan.items;
  assert.equal(attention.filter(item => item.requestId === request.requestId && item.kind === 'failed').length, 1);
});

test('a second queued native work request wakes after the first send finishes', async t => {
  let releaseFirst; const held = new Promise(resolveHeld => { releaseFirst = resolveHeld; });
  const sent = [];
  const transport = { async sendWork(delivery, controls) {
    controls.beforeSend(); sent.push(delivery);
    if (sent.length === 1) await held;
    return { status: 'sent' };
  } };
  const f = await fixture(t, { transport, codexReceiveMode: 'next_step' });
  const started = await f.begin({ requestLimit: 3, wakeLimit: 2 }); await f.accept(started, 'claude', 'claim-kickoff-claude');
  const first = await f.request(started.work.id, f.claude.bindingId, f.codex.bindingId, 'First queued request');
  await eventually(() => sent.length === 1);
  const second = await f.request(started.work.id, f.claude.bindingId, f.codex.bindingId, 'Second queued request');
  assert.equal(sent.length, 1);
  releaseFirst();
  await eventually(() => sent.length === 2);
  assert.deepEqual(sent.map(item => item.requestId), [first.requestId, second.requestId]);
  assert.equal((await f.work.get(f.roomId, started.work.id)).wakeBudget.used, 2);
});

test('work close waits for an in-flight native send to settle', async t => {
  let release; const held = new Promise(resolveHeld => { release = resolveHeld; });
  const sent = [];
  const transport = { async sendWork(delivery, controls) { controls.beforeSend(); sent.push(delivery); await held; return { status: 'sent' }; } };
  const f = await fixture(t, { transport, codexReceiveMode: 'next_step' });
  const started = await f.begin({ requestLimit: 1, wakeLimit: 1 }); await f.accept(started, 'claude', 'claim-kickoff-claude');
  await f.request(started.work.id, f.claude.bindingId, f.codex.bindingId);
  await eventually(() => sent.length === 1);
  let closed = false;
  const closing = f.work.close().then(() => { closed = true; });
  try {
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
    assert.equal(closed, false);
  } finally { release(); await closing; }
  assert.equal(closed, true); assert.equal(sent.length, 1);
});

for (const outcome of ['failed', 'uncertain']) {
  test(`response forwarding ${outcome} is visible, with checkpoint recovery only for definite failure`, async t => {
    const sent = [];
    const transport = { async sendWork(delivery, controls) {
      if (outcome === 'uncertain') controls.beforeSend();
      sent.push(delivery); return { status: outcome };
    } };
    const f = await fixture(t, { transport, codexReceiveMode: 'next_step' });
    const started = await f.begin({ requestLimit: 2, wakeLimit: 1 });
    await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
    const request = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId, 'Please answer');
    const claim = await f.work.agent('checkpoint', f.roomId, started.work.id, f.claude.bindingId,
      { operationId: op('response-source-checkpoint'), requestId: request.requestId });
    await f.work.agent('responses', f.roomId, started.work.id, f.claude.bindingId,
      { operationId: op('response-for-native'), requestId: request.requestId, claimId: claim.items[0].claimId, text: 'Answer for Codex', attachmentIds: [] });
    await eventually(() => sent.length === 1);
    assert.equal(sent[0].kind, 'response'); assert.equal(sent[0].requestId, request.requestId);
    await eventually(async () => (await f.broker.getControl(f.roomId)).needsRyan.items.some(item => item.requestId === request.requestId && item.kind === outcome));
    const attention = (await f.broker.getControl(f.roomId)).needsRyan;
    assert.equal(attention.items.filter(item => item.requestId === request.requestId && item.kind === outcome).length, 1);
    assert.ok(attention.count >= 1);
    const recovered = await f.work.agent('checkpoint', f.roomId, started.work.id, f.codex.bindingId,
      { operationId: op('response-recovery-checkpoint'), requestId: request.requestId });
    if (outcome === 'failed') {
      assert.equal(recovered.status, 'DELIVERY'); assert.equal(recovered.items.length, 1);
      assert.equal(recovered.items[0].kind, 'response'); assert.equal(recovered.items[0].text, 'Answer for Codex');
    } else {
      assert.equal(recovered.status, 'EMPTY', 'uncertain native write must not be duplicated by checkpoint');
    }
  });
}

test('checkpoint preserves a 40,000-codepoint response through a verified full-text attachment', async t => {
  const f = await fixture(t); const started = await f.begin();
  await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
  const request = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId);
  const claim = await f.work.agent('checkpoint', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('long-response-source'), requestId: request.requestId });
  const fullText = '😀'.repeat(40000);
  await f.work.agent('responses', f.roomId, started.work.id, f.claude.bindingId,
    { operationId: op('long-response'), requestId: request.requestId, claimId: claim.items[0].claimId, text: fullText, attachmentIds: [] });
  const received = await f.work.agent('checkpoint', f.roomId, started.work.id, f.codex.bindingId,
    { operationId: op('long-response-checkpoint'), requestId: request.requestId });
  assert.equal(received.status, 'DELIVERY'); assert.equal(received.items[0].kind, 'response');
  const item = received.items[0];
  assert.ok(item.fullTextAttachmentId, 'full text must be addressable without truncating it into a model frame');
  let reconstructed = '', cursor = null;
  do {
    const page = await f.broker.readAttachment(f.roomId, item.fullTextAttachmentId, cursor);
    reconstructed += page.text; cursor = page.nextCursor;
  } while (cursor);
  assert.equal(reconstructed, fullText);
});

test('attention pages traverse more than twenty mixed work items without gaps or duplicates', async t => {
  const f = await fixture(t); const started = await f.begin({ requestLimit: 23, wakeLimit: 1 });
  await f.accept(started, 'codex'); await f.accept(started, 'claude', 'claim-kickoff-claude');
  const seed = await f.request(started.work.id, f.codex.bindingId, f.claude.bindingId, 'Pagination seed');
  // Seed a large synthetic failure set at the storage boundary; this test is
  // about the read-side cursor, not request admission or transport throughput.
  await f.broker.store.tx(async sql => {
    const row = await sql.get('SELECT * FROM work_requests WHERE id=?', [seed.requestId]);
    for (let number = 2; number <= 22; number++) {
      const requestId = `request-page-${String(number).padStart(2, '0')}`;
      const record = { ...JSON.parse(row.data_json), requestId, requestNumber: number, requestVersion: 1,
        requestState: 'failed', waitDisposition: 'none', waitingSince: new Date(Date.parse(started.work.startedAt) + number * 1000).toISOString(),
        _claimId: null, _failureReason: 'DELIVERY_FAILED' };
      await sql.run(`INSERT INTO work_requests(id,room_id,work_id,to_binding_id,state,wait_disposition,claim_id,
        request_number,timeline_id,version,data_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [requestId, f.roomId, started.work.id, f.claude.bindingId, 'failed', 'none', null, number, row.timeline_id, 1, JSON.stringify(record)]);
    }
  });
  const participant = (await f.work.get(f.roomId, started.work.id)).participants.find(p => p.agent === 'codex');
  await f.work.agent('state', f.roomId, started.work.id, f.codex.bindingId,
    { operationId: op('blocked-for-pagination'), expectedParticipantVersion: participant.version, workState: 'blocked', text: 'One mixed attention item' });
  const first = await f.broker.getAttention(f.roomId, { limit: 20 });
  assert.equal(first.count, 22); assert.equal(first.items.length, 20); assert.ok(first.nextCursor);
  const second = await f.broker.getAttention(f.roomId, { limit: 20, cursor: first.nextCursor });
  assert.equal(second.count, 22); assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
  const all = [...first.items, ...second.items];
  assert.equal(new Set(all.map(item => item.id)).size, 22);
  assert.ok(all.some(item => item.kind === 'work_blocked'));
  assert.equal(all.filter(item => item.kind === 'failed' && item.requestId).length, 21);
});
