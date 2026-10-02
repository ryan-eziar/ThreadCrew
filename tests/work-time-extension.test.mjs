import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { V2Broker } from '../src/v2-broker.mjs';
import { WorkCoordinator } from '../src/v2-work.mjs';
import { createV2Server } from '../src/v2-server.mjs';

const project=resolve(import.meta.dirname,'..'),op=()=>randomUUID();
async function fixture(t,{wakeLimit=3}={}){
  await mkdir(join(project,'work'),{recursive:true});
  const runtimeDir=await mkdtemp(join(project,'work','time-extension-'));
  let now=Date.parse('2026-10-03T00:00:00Z');
  const broker=await V2Broker.open({runtimeDir,clock:()=>now});
  const work=await WorkCoordinator.attach(broker,{clock:()=>now});
  const server=await createV2Server({broker,work,runtimeDir,projectDir:project});
  t.after(async()=>{await server.close();await work.close();await broker.close();await rm(runtimeDir,{recursive:true,force:true});});
  const room=await broker.createRoom({operationId:op(),name:'Synthetic time extension'}),roomId=room.roomId;
  const gate=async()=>(await broker.getControl(roomId)).room.gate;
  const codex=await broker.join(roomId,{agent:'codex',nativeSessionId:op(),expectedBindingId:null,expectedGate:await gate()});
  const claude=await broker.join(roomId,{agent:'claude',nativeSessionId:op(),expectedBindingId:null,expectedGate:await gate()});
  const start=await work.start(roomId,{operationId:op(),expectedGate:await gate(),expectedBindings:{codex:codex.bindingId,claude:claude.bindingId},
    text:'Synthetic authorized task',attachmentIds:[],objective:'Synthetic extension',requestLimit:6,wakeLimit,durationSeconds:3600});
  const workId=start.work.id;
  const add=async(addSeconds,extra={})=>work.budget(roomId,workId,{operationId:op(),expectedGate:await gate(),
    expectedWorkVersion:(await work.get(roomId,workId)).version,addSeconds,...extra});
  return{broker,work,server,roomId,workId,codex,claude,start,gate,add,advance:ms=>{now+=ms;}};
}
test('time-only extension persists authority expiry and retries exactly once without renewing reception',async t=>{
  const f=await fixture(t),before=await f.work.get(f.roomId,f.workId);
  const body={operationId:op(),expectedGate:await f.gate(),expectedWorkVersion:before.version,addSeconds:3600};
  const changed=await f.work.budget(f.roomId,f.workId,body),retry=await f.work.budget(f.roomId,f.workId,body);
  assert.equal(retry.work.expiresAt,changed.work.expiresAt);
  assert.equal(changed.work.timeBudget.limitSeconds,7200);assert.equal(changed.work.timeBudget.remainingSeconds,7200);
  assert.deepEqual(changed.work.requestBudget,before.requestBudget);assert.deepEqual(changed.work.wakeBudget,before.wakeBudget);
  assert.equal(changed.work.participants[1].leaseDeadlineAt,before.participants[1].leaseDeadlineAt);
  const row=await f.broker.store.read(sql=>sql.get('SELECT expires_at,data_json FROM work_sessions WHERE id=?',[f.workId]));
  assert.equal(row.expires_at,changed.work.expiresAt);assert.equal(JSON.parse(row.data_json).expiresAt,changed.work.expiresAt);
  const scope=await f.work.agentStatus(f.roomId,f.workId,f.codex.bindingId);
  assert.equal(scope.authorizedScope.expiresAt,changed.work.expiresAt);
  await assert.rejects(f.work.budget(f.roomId,f.workId,{...body,operationId:op()}),e=>e.code==='WORK_CHANGED');
  // Also assert the persisted operation/event count, independent of UI projection.
  const count=await f.broker.store.read(sql=>sql.get("SELECT COUNT(*) AS n FROM timeline WHERE room_id=? AND json_extract(data_json,'$.eventKind')='budget_changed'",[f.roomId]));
  assert.equal(count.n,1);
});
test('paused work can gain time independently; caps and terminal states cannot be bypassed',async t=>{
  const f=await fixture(t,{wakeLimit:0});
  assert.equal((await f.work.get(f.roomId,f.workId)).coordinationState,'paused_budget');
  await f.add(36000);await f.add(36000);const capped=await f.add(10800);
  assert.equal(capped.work.timeBudget.limitSeconds,86400);assert.equal(capped.work.actions.addTime.reason,'WORK_TIME_LIMIT');
  assert.equal(capped.work.coordinationState,'paused_budget');
  await assert.rejects(f.add(1),e=>e.code==='WORK_TIME_LIMIT');
  for(const seconds of [0,-1,36001,1.5,null,'3600'])await assert.rejects(f.add(seconds),e=>e.code==='INVALID_INPUT');
  await f.broker.stop(f.roomId,{operationId:op(),expectedGate:await f.gate()});
  await assert.rejects(f.add(3600),e=>e.code==='WORK_NOT_ACTIVE');
});
test('obsolete expiry cannot stop extended work; the new expiry stops it and survives reattach',async t=>{
  const f=await fixture(t),old=f.start.work;
  const added=(await f.add(3600)).work;
  f.advance(3600001);await f.work.expireAt(old);
  assert.equal((await f.work.get(f.roomId,f.workId)).coordinationState,'active');
  await f.work.close();
  const restored=await WorkCoordinator.attach(f.broker,{clock:()=>Date.parse(old.startedAt)+3600001});
  assert.equal((await restored.get(f.roomId,f.workId)).expiresAt,added.expiresAt);await restored.close();
  f.advance(3600000);await f.work.expireAt(added);
  assert.equal((await f.work.get(f.roomId,f.workId)).coordinationState,'expired');
  await assert.rejects(f.add(1),e=>e.code==='WORK_NOT_ACTIVE');
});
test('human HTTP time control accepts omitted counters; the agent endpoint cannot extend time',async t=>{
  const f=await fixture(t),w=await f.work.get(f.roomId,f.workId);
  const body={operationId:op(),expectedGate:await f.gate(),expectedWorkVersion:w.version,addSeconds:3600};
  const human=await fetch(`${f.server.url}/api/v2/rooms/${f.roomId}/work/${f.workId}/budget`,{method:'POST',
    headers:{Authorization:`Bearer ${f.server.credentials().humanToken}`,Origin:f.server.url,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const changed=await human.json();assert.equal(human.status,200,JSON.stringify(changed));assert.equal(changed.result.work.timeBudget.limitSeconds,7200);
  const enrollment=JSON.parse(await readFile(join(f.broker.runtimeDir,'connection-codex.json'),'utf8'));
  const joinResponse=await fetch(`${f.server.url}/agent/v2/rooms/${f.roomId}/join`,{method:'POST',
    headers:{Authorization:`Bearer ${enrollment.enrollmentToken}`,'Content-Type':'application/json'},
    body:JSON.stringify({agent:'codex',nativeSessionId:f.codex.binding.nativeSessionId,expectedBindingId:f.codex.bindingId,expectedGate:await f.gate(),reconnect:true})});
  const credential=(await joinResponse.json()).result.credential;
  const agent=await fetch(`${f.server.url}/agent/v2/rooms/${f.roomId}/work/${f.workId}/budget`,{method:'POST',
    headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(agent.status,404);assert.equal((await f.work.get(f.roomId,f.workId)).timeBudget.limitSeconds,7200);
});
