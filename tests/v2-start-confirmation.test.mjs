import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { V2Broker } from '../src/v2-broker.mjs';
import { WorkCoordinator } from '../src/v2-work.mjs';
const hash=t=>createHash('sha256').update(t).digest('hex');
async function fixture(t){
  await mkdir('work',{recursive:true});const runtimeDir=await mkdtemp(join('work','start-confirm-'));
  const broker=await V2Broker.open({runtimeDir}),work=await WorkCoordinator.attach(broker);
  t.after(async()=>{await work.close();await broker.close();});
  const room=await broker.createRoom({operationId:'room',name:'Synthetic agreement'}),roomId=room.roomId;
  const expectedBindings={};for(const agent of ['codex','claude'])expectedBindings[agent]=(await broker.join(roomId,{agent,nativeSessionId:'session-'+agent,expectedGate:(await broker.getControl(roomId)).room.gate})).bindingId;
  const gate=(await broker.getControl(roomId)).room.gate,text='Agree a plan and implement the synthetic feature.',planText='Codex implements; Claude reviews. Test the specified behavior.';
  const source=await broker.sendHuman(roomId,{operationId:'source',expectedGate:gate,text,recipients:['codex','claude'],attachmentIds:[]});
  for(const agent of ['codex','claude']){
    const deliveryId=source.deliveryIds[agent];
    await broker.store.tx(sql=>sql.run("UPDATE deliveries SET attempted=1,write_started=1,state='awaiting_reply',wait_disposition='waiting' WHERE id=?",[deliveryId]));
    await broker.postReply(roomId,expectedBindings[agent],{deliveryId,claimId:null,text:'Plan agreed.'});
  }
  const body={expectedGate:gate,expectedBindings,sourceHumanMessageId:source.messageId,sourceTextSha256:hash(text),planText,planSha256:hash(planText),implementationAuthorized:true};
  return {broker,work,roomId,body,expectedBindings,source};
}
test('two exact confirmations atomically start one bounded work with original human scope',async t=>{
  const f=await fixture(t),confirm=(agent,operationId)=>f.work.confirmStart(f.roomId,f.expectedBindings[agent],{...f.body,operationId});
  const first=await confirm('codex','first');assert.equal(first.work,null);assert.equal(first.pendingKickoff.state,'waiting_peer');
  const context=await f.work.startContext(f.roomId,f.expectedBindings.claude);
  assert.equal(context.pendingKickoff.planText,f.body.planText);assert.equal(context.sourceHumanMessage.textSha256,f.body.sourceTextSha256);
  await assert.rejects(f.work.confirmStart(f.roomId,f.expectedBindings.claude,{...f.body,operationId:'changed',planText:'different',planSha256:hash('different')}),e=>e.code==='PLAN_CHANGED');
  const [a,b]=await Promise.all([confirm('claude','second'),confirm('claude','retry')]);
  assert.equal(a.work.id,b.work.id);assert.equal(a.work.requestBudget.limit,24);assert.equal(a.work.wakeBudget.limit,48);
  assert.equal(a.work.authority.sourceHumanMessageId,f.source.messageId);assert.equal(a.work.authority.confirmations.length,2);
  const status=await f.work.agentStatus(f.roomId,a.work.id,f.expectedBindings.codex);
  assert.equal(status.authorizedScope.text,'Agree a plan and implement the synthetic feature.');assert.equal(status.authorizedScope.agreedPlan.text,f.body.planText);
  assert.equal((await f.broker.getControl(f.roomId)).pendingKickoff,null);
  const messages=await f.broker.store.read(sql=>sql.get('SELECT COUNT(*) AS n FROM messages WHERE room_id=?',[f.roomId]));assert.equal(messages.n,1);
});
test('new human steering expires pending confirmation and a stale peer cannot start',async t=>{
  const f=await fixture(t);
  await f.work.confirmStart(f.roomId,f.expectedBindings.codex,{...f.body,operationId:'first'});
  await f.broker.sendHuman(f.roomId,{operationId:'steering',expectedGate:f.body.expectedGate,recipients:['codex','claude'],text:'Discuss the revised plan first.',attachmentIds:[]});
  assert.equal((await f.broker.getControl(f.roomId)).pendingKickoff.state,'expired');
  await assert.rejects(f.work.confirmStart(f.roomId,f.expectedBindings.claude,{...f.body,operationId:'stale'}),e=>e.code==='START_CONFIRMATION_EXPIRED');
  assert.equal((await f.broker.getControl(f.roomId)).currentWork,null);
});
test('Stop and unverified source/permission cannot manufacture a work grant',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.work.confirmStart(f.roomId,f.expectedBindings.codex,{...f.body,operationId:'missing-consent',implementationAuthorized:false}),e=>e.code==='INVALID_INPUT');
  await assert.rejects(f.work.confirmStart(f.roomId,f.expectedBindings.codex,{...f.body,operationId:'wrong-source',sourceTextSha256:'0'.repeat(64)}),e=>e.code==='SOURCE_CHANGED');
  await f.work.confirmStart(f.roomId,f.expectedBindings.codex,{...f.body,operationId:'first'});
  await f.broker.stop(f.roomId,{operationId:'stop',expectedGate:f.body.expectedGate});
  assert.equal((await f.broker.getControl(f.roomId)).pendingKickoff.state,'expired');
  await assert.rejects(f.work.confirmStart(f.roomId,f.expectedBindings.claude,{...f.body,operationId:'stale'}),e=>e.code==='GATE_CHANGED');
});
