import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app=fs.readFileSync(new URL('../app-v2.js',import.meta.url),'utf8');
const start=app.indexOf('  async function removeMember(');
const code=app.slice(start,app.indexOf('\n  }',start)+4);
function harness({impact={requiresAcknowledgement:true,hasHeldWork:true,possibleRunningAgents:['claude']},confirm=()=>true,post=()=>({ok:true}),get}={}) {
  const original={agent:'codex',binding:{id:'binding-original',version:1,label:'Synthetic Codex'},openWork:{queued:0,possibleRunning:0},removalImpact:impact,actions:{remove:{enabled:true}}};
  const c={room:{name:'Synthetic room',gate:{segmentId:'segment-original',version:1}},members:[original]};
  const v={roomId:'room-original'};let current=v,n=0;
  const prompts=[],writes=[],reads=[],flashes=[];
  const ctx={view:()=>current,st:{panel:{}},src:{roomPath:id=>'/rooms/'+id,get:async path=>{reads.push(path);return get?get(reads.length,c):{ok:true,result:c};}},
    t:(s,...a)=>s.replace(/\{(\d+)\}/g,(_,i)=>a[i]),NAMES:{codex:'Codex',claude:'Claude'},
    askConfirm:async p=>{prompts.push(p);return confirm(prompts.length,ctx);},
    runOp:async(key,path,body,onDone)=>{writes.push({key,path,body});const result=post(writes.length,ctx);if(result.ok)onDone();return result;},
    rk:(name,id)=>name+':'+id,uuid:()=>`operation-${++n}`,flash:(s)=>flashes.push(s),errorText:s=>s,reasonText:s=>s,resyncRoom:()=>{},
    switchRoom:()=>{current={roomId:'other-room'};}};
  vm.createContext(ctx);vm.runInContext(code,ctx);
  return {ctx,original,c,prompts,writes,reads,flashes,run:()=>ctx.removeMember(original)};
}
test('work-only removal shows the risk and acknowledges it after confirmation',async()=>{
  const h=harness();await h.run();
  assert.equal(h.prompts.length,1);assert.ok(h.prompts[0].body.some(s=>s.includes('协作任务占用')));
  assert.ok(h.prompts[0].body.some(s=>s.includes('Claude')));
  assert.equal(h.writes[0].body.acknowledgePossibleRunning,true);
  assert.equal(h.writes[0].path,'/rooms/room-original/members/codex/remove');
});
test('released work still shows native-running warning; idle removal needs no running acknowledgement',async()=>{
  const h=harness({impact:{requiresAcknowledgement:true,hasHeldWork:false,possibleRunningAgents:['claude']}});await h.run();
  assert.ok(h.prompts[0].body.some(s=>s.includes('原生应用')));assert.equal(h.writes[0].body.acknowledgePossibleRunning,true);
  const idle=harness({impact:{requiresAcknowledgement:false,hasHeldWork:false,possibleRunningAgents:[]}});await idle.run();
  assert.equal(idle.writes[0].body.acknowledgePossibleRunning,false);
});
test('cancel or switching rooms during confirmation sends no removal',async()=>{
  const cancelled=harness({confirm:()=>false});await cancelled.run();assert.equal(cancelled.writes.length,0);
  const switched=harness({confirm:(_,ctx)=>{ctx.switchRoom();return true;}});await switched.run();assert.equal(switched.writes.length,0);
});
test('replaced binding is not silently selected by refreshing the confirmation',async()=>{
  const h=harness({get:(_,c)=>({ok:true,result:{...c,members:[{...c.members[0],binding:{id:'replacement'}}]}})});
  await h.run();assert.equal(h.prompts.length,0);assert.equal(h.writes.length,0);assert.deepEqual(h.flashes,['BINDING_CHANGED']);
});
test('new running work requires a fresh confirmation; cancelling it does not force retry',async()=>{
  const impact={requiresAcknowledgement:false,hasHeldWork:false,possibleRunningAgents:[]};
  const h=harness({impact,confirm:n=>n===1,post:()=>{impact.requiresAcknowledgement=true;impact.hasHeldWork=true;return {ok:false,error:{code:'POSSIBLE_RUNNING_ACK_REQUIRED',outcome:'rejected'}};}});
  await h.run();assert.equal(h.reads.length,2);assert.equal(h.prompts.length,2);assert.equal(h.writes.length,1);
  assert.ok(h.prompts[1].body.some(s=>s.includes('重新确认')));
});
test('confirmed retry refreshes the gate and uses a new operation only after a definite rejection',async()=>{
  const h=harness({post:(n)=>n===1?{ok:false,error:{code:'GATE_CHANGED',outcome:'rejected'}}:{ok:true},get:(n,c)=>({ok:true,result:{...c,room:{...c.room,gate:{segmentId:'segment-original',version:n}}}})});
  await h.run();assert.equal(h.prompts.length,2);assert.equal(h.writes.length,2);
  assert.equal(h.writes[1].body.expectedGate.version,2);assert.notEqual(h.writes[0].body.operationId,h.writes[1].body.operationId);
  const unknown=harness({post:()=>({ok:false,error:{code:'CONNECTION_LOST',outcome:'unknown'}})});
  await unknown.run();assert.equal(unknown.writes.length,1);assert.equal(unknown.prompts.length,1);
});
