import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { V2Broker } from '../src/v2-broker.mjs';
import { WorkCoordinator } from '../src/v2-work.mjs';
import { createV2Server } from '../src/v2-server.mjs';
import { ThreadCrewFeatures } from '../src/threadcrew-features.mjs';
import { WORK_COMMUNICATION_INSTRUCTION } from '../src/work-communication.mjs';

const op=()=>randomUUID(),project=resolve(import.meta.dirname,'..');
async function fixture(t) {
  await mkdir(join(project,'work'),{recursive:true});
  const runtimeDir=await mkdtemp(join(project,'work','unlimited-'));
  let now=Date.parse('2026-10-14T00:00:00Z');
  const clock=()=>now;
  const broker=await V2Broker.open({runtimeDir,clock});
  const work=await WorkCoordinator.attach(broker,{clock});
  const server=await createV2Server({broker,work,runtimeDir,projectDir:project});
  let handlesClosed=false;
  const close=async()=>{if(handlesClosed)return;handlesClosed=true;await server.close();await work.close();await broker.close();};
  t.after(async()=>{await close();await rm(runtimeDir,{recursive:true,force:true});});
  const room=await broker.createRoom({operationId:op(),name:'Synthetic unlimited collaboration'}),roomId=room.roomId;
  const gate=async()=>(await broker.getControl(roomId)).room.gate;
  const codex=await broker.join(roomId,{agent:'codex',nativeSessionId:op(),expectedBindingId:null,expectedGate:await gate()});
  const claude=await broker.join(roomId,{agent:'claude',nativeSessionId:op(),expectedBindingId:null,expectedGate:await gate()});
  const body={operationId:op(),expectedGate:await gate(),expectedBindings:{codex:codex.bindingId,claude:claude.bindingId},text:'Synthetic long task approved by the user',attachmentIds:[],objective:'Synthetic multi-day feature',unlimited:true};
  const accept=async(started,who)=>{
    const binding=who==='codex'?codex:claude,claimId=who==='claude'?op():null;
    const deliveryId=await broker.store.read(async sql=>(await sql.get('SELECT id FROM deliveries WHERE work_id=? AND agent=?',[started.work.id,who])).id);
    await broker.store.tx(sql=>sql.run("UPDATE deliveries SET attempted=1,write_started=1,state='awaiting_reply',wait_disposition='waiting',claim_id=? WHERE id=?",[claimId,deliveryId]));
    return work.agent('accept',roomId,started.work.id,binding.bindingId,{operationId:op(),deliveryId,claimId,accept:true,text:'Synthetic acceptance'});
  };
  return {broker,work,server,roomId,runtimeDir,gate,codex,claude,body,accept,clock,close,advance:ms=>{now+=ms;}};
}

test('human HTTP unlimited kickoff has explicit authority and no expiry timer; duplicate does not create another task',async t=>{
  const f=await fixture(t);
  const post=()=>fetch(`${f.server.url}/api/v2/rooms/${f.roomId}/work`,{method:'POST',headers:{Authorization:`Bearer ${f.server.credentials().humanToken}`,Origin:f.server.url,'Content-Type':'application/json'},body:JSON.stringify(f.body)});
  const response=await post(),started=(await response.json()).result;
  assert.equal(response.status,200);
  assert.equal(started.work.unlimited,true);assert.equal(started.work.expiresAt,null);
  assert.deepEqual(started.work.requestBudget,{limit:null,used:0,remaining:null});
  assert.equal(started.work.timeBudget.limitSeconds,null);assert.equal(f.work.timers.size,0);
  assert.equal((await (await post()).json()).result.work.id,started.work.id);
  const scope=await f.work.agentStatus(f.roomId,started.work.id,f.codex.bindingId);
  assert.equal(scope.authorizedScope.unlimited,true);assert.equal(scope.authorizedScope.expiresAt,null);
  assert.equal(scope.authorizedScope.text,f.body.text);
  const features=new ThreadCrewFeatures(f.broker,project);
  const preview=await features.shutdownPreview();
  assert.equal(preview.counts.activeWorkRooms,1);
  assert.equal((await features.updatePreview()).rooms[0].activeWork,true);
});

test('unlimited work remains active after four days and coordinator restart, without renewing native reception authority',async t=>{
  const f=await fixture(t),started=await f.work.start(f.roomId,f.body);
  const lease=started.work.participants[1].leaseDeadlineAt;
  f.advance(4*86400000);await f.work.expireAt(started.work);
  await f.work.close();
  const restored=await WorkCoordinator.attach(f.broker,{clock:f.clock});
  try {
    const status=await restored.get(f.roomId,started.work.id);
    assert.equal(status.coordinationState,'active');assert.equal(status.occupancy,'held');
    assert.equal(status.expiresAt,null);assert.equal(status.participants[1].leaseDeadlineAt,lease);
    assert.equal(restored.timers.size,0);
    const row=await f.broker.store.read(sql=>sql.get('SELECT expires_at,data_json FROM work_sessions WHERE id=?',[started.work.id]));
    assert.equal(JSON.parse(row.data_json).expiresAt,null);assert.ok(row.expires_at>'2026-10-18');
  } finally {await restored.close();}
});

test('the unlimited grant persists across a complete broker storage close and reopen after four days',async t=>{
  const f=await fixture(t),started=await f.work.start(f.roomId,f.body);
  f.advance(4*86400000);await f.close();
  const broker=await V2Broker.open({runtimeDir:f.runtimeDir,clock:f.clock});
  const work=await WorkCoordinator.attach(broker,{clock:f.clock});
  try {
    const control=await broker.getControl(f.roomId);
    assert.equal(control.currentWork.id,started.work.id);assert.equal(control.currentWork.unlimited,true);
    assert.equal(control.currentWork.coordinationState,'active');assert.equal(work.timers.size,0);
    const scope=await work.agentStatus(f.roomId,started.work.id,f.codex.bindingId);
    assert.equal(scope.authorizedScope.text,f.body.text);assert.equal(scope.authorizedScope.expiresAt,null);
  } finally {await work.close();await broker.close();}
});

test('unlimited requests and wake notifications remain usable past previous caps; request replay consumes once',async t=>{
  const f=await fixture(t),started=await f.work.start(f.roomId,f.body);
  await f.accept(started,'codex');await f.accept(started,'claude');
  // Exercise an already long-running persisted grant rather than create ten thousand messages.
  await f.broker.store.tx(async sql=>{const w=await f.work.load(sql,f.roomId,started.work.id);w.requestBudget.used=10000;w.wakeBudget.used=10000;await f.work.saveWork({sql},w);});
  const requestBody={operationId:op(),toBindingId:f.claude.bindingId,kind:'review_request',text:'Synthetic review beyond prior caps',attachmentIds:[]};
  const first=await f.work.agent('requests',f.roomId,started.work.id,f.codex.bindingId,requestBody);
  const replay=await f.work.agent('requests',f.roomId,started.work.id,f.codex.bindingId,requestBody);
  assert.equal(replay.requestId,first.requestId);
  const notification=await f.work.nextNotification({roomId:f.roomId,bindingId:f.claude.bindingId,notificationScopes:['work'],workId:started.work.id});
  assert.ok(notification);
  const status=await f.work.get(f.roomId,started.work.id);
  assert.equal(status.requestBudget.used,10001);assert.equal(status.wakeBudget.used,10001);
  assert.equal(status.coordinationState,'active');assert.equal(status.wakeBudget.remaining,null);
  await assert.rejects(f.work.agent('requests',f.roomId,started.work.id,f.codex.bindingId,{...requestBody,operationId:op(),unlimited:true}),e=>e.code==='UNKNOWN_FIELD');
});

test('Stop cancels an unlimited grant and preserves exact late replies without resuming forwarding',async t=>{
  const f=await fixture(t),started=await f.work.start(f.roomId,f.body);
  await f.accept(started,'codex');await f.accept(started,'claude');
  const request=await f.work.agent('requests',f.roomId,started.work.id,f.codex.bindingId,{operationId:op(),toBindingId:f.claude.bindingId,kind:'handoff',text:'Synthetic stop test',attachmentIds:[]});
  const claim=await f.work.agent('checkpoint',f.roomId,started.work.id,f.claude.bindingId,{operationId:op(),requestId:request.requestId});
  await f.broker.stop(f.roomId,{operationId:op(),expectedGate:await f.gate()});
  const late=await f.work.agent('responses',f.roomId,started.work.id,f.claude.bindingId,{operationId:op(),requestId:request.requestId,claimId:claim.items[0].claimId,text:'Synthetic exact late reply',attachmentIds:[]});
  assert.equal(late.lateReason,'stopped');
  assert.equal((await f.work.get(f.roomId,started.work.id)).coordinationState,'stopped');
  await assert.rejects(f.work.agent('requests',f.roomId,started.work.id,f.codex.bindingId,{operationId:op(),toBindingId:f.claude.bindingId,kind:'handoff',text:'Cannot continue',attachmentIds:[]}),e=>e.code==='WORK_NOT_ACTIVE');
});

test('ambiguous unlimited inputs are rejected and finite kickoff still requires its original caps',async t=>{
  const f=await fixture(t);
  for(const bad of [{unlimited:'true'},{unlimited:true,durationSeconds:3600},{unlimited:true,requestLimit:12},{unlimited:false},{unlimited:undefined,requestLimit:null,wakeLimit:null,durationSeconds:null}]) {
    await assert.rejects(f.work.start(f.roomId,{...f.body,...bad,operationId:op()}),e=>e.code==='INVALID_INPUT');
  }
});

test('both participants completing their authorized task ends unlimited collaboration',async t=>{
  const f=await fixture(t),started=await f.work.start(f.roomId,f.body);
  await f.accept(started,'codex');await f.accept(started,'claude');
  for(const who of ['codex','claude']) {
    const status=await f.work.get(f.roomId,started.work.id),p=status.participants.find(p=>p.agent===who);
    await f.work.agent('state',f.roomId,started.work.id,p.bindingId,{operationId:op(),expectedParticipantVersion:p.version,workState:'completed',text:'Synthetic completion'});
  }
  assert.equal((await f.work.get(f.roomId,started.work.id)).coordinationState,'completed');
  assert.equal(await f.work.nextNotification({roomId:f.roomId,bindingId:f.claude.bindingId,notificationScopes:['work'],workId:started.work.id}),null);
});

test('a fresh room first kickoff and both acceptances explicitly guide real peer messages; status is display-only',async t=>{
  const f=await fixture(t),started=await f.work.start(f.roomId,f.body);
  const waiting=await f.broker.wait(f.roomId,f.claude.bindingId,{requestId:op()});
  const first=await f.broker.read(f.roomId,f.claude.bindingId,{requestId:op(),batchId:waiting.batchId},()=>{});
  assert.equal(first.mode,'work');assert.equal(first.authorizedScope.communicationPolicy,WORK_COMMUNICATION_INSTRUCTION);
  const claude=await f.work.agent('accept',f.roomId,started.work.id,f.claude.bindingId,{operationId:op(),deliveryId:first.deliveryId,claimId:first.claimId,accept:true,text:'Synthetic first acceptance'});
  const codex=await f.accept(started,'codex');
  for(const [result,peer] of [[claude,f.codex],[codex,f.claude]]) {
    assert.equal(result.communication.peerBindingId,peer.bindingId);
    assert.equal(result.communication.displayUpdatesDeliveredToPeer,false);
    assert.equal(result.communication.peerRequestArgs[0],'work-request');
    assert.equal(result.communication.peerRequestArgs[result.communication.peerRequestArgs.indexOf('--to-binding')+1],peer.bindingId);
  }
  const before=await f.work.get(f.roomId,started.work.id),p=before.participants.find(p=>p.agent==='codex');
  const state=await f.work.agent('state',f.roomId,started.work.id,f.codex.bindingId,{operationId:op(),expectedParticipantVersion:p.version,workState:'awaiting_review',text:'Please review the synthetic changes'});
  const progress=await f.work.agent('progress',f.roomId,started.work.id,f.codex.bindingId,{operationId:op(),text:'Synthetic handoff ready'});
  assert.equal(state.displayUpdate.deliveredToPeer,false);assert.equal(progress.displayUpdate.deliveredToPeer,false);
  assert.match(state.displayUpdate.instruction,/send work-request/);
  const after=await f.work.get(f.roomId,started.work.id);
  assert.equal(after.pendingRequestCount,0);assert.equal(after.requestBudget.used,before.requestBudget.used);assert.equal(after.wakeBudget.used,before.wakeBudget.used);
  const requested=await f.work.agent('requests',f.roomId,started.work.id,f.codex.bindingId,{operationId:op(),toBindingId:f.claude.bindingId,kind:'review_request',text:'Actual synthetic peer message',attachmentIds:[]});
  const inbox=await f.work.agent('checkpoint',f.roomId,started.work.id,f.claude.bindingId,{operationId:op(),requestId:requested.requestId});
  assert.equal(inbox.items[0].text,'Actual synthetic peer message');
});
