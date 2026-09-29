import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { V2Broker } from '../src/v2-broker.mjs';
import { WorkCoordinator } from '../src/v2-work.mjs';
import { createV2Server } from '../src/v2-server.mjs';
import { runV2Cli } from '../src/v2-cli.mjs';
const project=resolve(import.meta.dirname,'..');
const op=()=>randomUUID();
async function fixture(t){
  await mkdir(join(project,'work'),{recursive:true});const dir=await mkdtemp(join(project,'work','v2-http-'));
  await mkdir(join(dir,'ui'));await writeFile(join(dir,'ui','index.html'),'<html><head></head><body>synthetic</body></html>');
  const runtimeDir=join(dir,'runtime'),broker=await V2Broker.open({runtimeDir}),work=await WorkCoordinator.attach(broker),server=await createV2Server({broker,work,runtimeDir,projectDir:dir});
  t.after(async()=>{await server.close();await work.close();await broker.close();await rm(dir,{recursive:true,force:true});});
  const human=async(path,body,headers={})=>fetch(`${server.url}/api/v2${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${server.credentials().humanToken}`,...(body===undefined?{}:{Origin:server.url,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:json(body)})});
  const unwrap=async response=>{const data=await response.json();assert.equal(data.ok,true,json(data));return data.result;};
  const create=async name=>unwrap(await human('/rooms',{operationId:op(),name}));
  const cli=(args)=>runV2Cli(args,{projectDir:dir,runtimeDir,stdout:()=>{}});
  return{dir,runtimeDir,broker,work,server,human,unwrap,create,cli};
}
const json=JSON.stringify;
test('v2 authenticates workspace identity and human mutations without leaking enrollment or cross-origin access',async t=>{
  const f=await fixture(t);const html=await(await fetch(f.server.url)).text();assert.match(html,/agent-chat.window.v2/);assert.ok(html.includes(f.broker.workspaceId));
  const boot=JSON.parse(html.split('window.__AGENT_CHAT__=')[1].split(';</script>')[0]);assert.equal(boot.capabilities.shutdown,false);
  for(const role of ['codex','claude']){const d=JSON.parse(await readFile(join(f.runtimeDir,`connection-${role}.json`),'utf8'));assert.equal(d.humanToken,undefined);assert.equal(d.roomId,undefined);const r=await fetch(`${f.server.url}/agent/v2/identity`,{headers:{Authorization:`Bearer ${d.enrollmentToken}`}});const identity=await f.unwrap(r);assert.equal(identity.workspaceId,d.workspaceId);assert.equal(identity.instanceId,d.instanceId);}
  assert.equal((await f.human('/rooms',{operationId:op(),name:'wrongorigin'},{Origin:'http://evil.invalid'})).status,403);
  assert.equal((await f.human('/rooms',undefined,{Authorization:''})).status,401);
  assert.equal((await fetch(`${f.server.url}/runtime/connection-codex.json`)).status,404);
});
test('v2 exact room helper joins, posts a claimed message and rejects room substitution',async t=>{
  const f=await fixture(t);const a=await f.create('A'),b=await f.create('B');
  const joined=await f.cli(['join','--room',a.room.id,'--as','claude','--session','session-claude','--expected-binding','null','--gate-segment',a.gate.segmentId,'--gate-version',String(a.gate.version)]);
  assert.equal(joined.roomId,a.room.id);
  await assert.rejects(f.cli(['status','--room',b.room.id,'--as','claude','--binding',joined.bindingId]),e=>['FORBIDDEN','ROOM_MISMATCH'].includes(e.code));
  const control=await f.unwrap(await f.human(`/rooms/${a.room.id}/control`));
  const sent=await f.unwrap(await f.human(`/rooms/${a.room.id}/messages`,{operationId:op(),expectedGate:control.room.gate,recipients:['claude'],text:'synthetic exact-room task',attachmentIds:[]}));
  const waiting=await f.cli(['wait','--room',a.room.id,'--as','claude','--binding',joined.bindingId]);assert.equal(waiting.status,'NEW');
  const delivery=await f.cli(['read','--room',a.room.id,'--as','claude','--binding',joined.bindingId]);assert.equal(delivery.status,'DELIVERY');assert.equal(delivery.text,'synthetic exact-room task');
  const path=join(f.dir,'answer.txt');await writeFile(path,'complete synthetic answer','utf8');
  const final=await f.cli(['post','--room',a.room.id,'--as','claude','--binding',joined.bindingId,'--delivery',delivery.deliveryId,'--file',path]);assert.ok(final.replyId);
  const view=await f.unwrap(await f.human(`/rooms/${a.room.id}/view`));assert.ok(view.page.items.some(item=>item.reply?.id===final.replyId));
  assert.equal((await f.unwrap(await f.human(`/rooms/${b.room.id}/view`))).page.items.some(item=>item.reply?.id===final.replyId),false);
});
test('v2 operation replay is workspace-wide and timeline cursors cannot cross rooms',async t=>{
  const f=await fixture(t),a=await f.create('A'),b=await f.create('B');
  const body={operationId:op(),expectedGate:a.gate,recipients:['claude'],text:'original',attachmentIds:[]};
  const first=await f.unwrap(await f.human(`/rooms/${a.room.id}/messages`,body));
  assert.deepEqual(await f.unwrap(await f.human(`/rooms/${a.room.id}/messages`,body)),first);
  assert.equal((await f.human(`/rooms/${b.room.id}/messages`,{...body,expectedGate:b.gate})).status,409);
  const page=await f.unwrap(await f.human(`/rooms/${a.room.id}/timeline?limit=1`));
  if(page.nextBeforeCursor)assert.equal((await f.human(`/rooms/${b.room.id}/timeline?before=${encodeURIComponent(page.nextBeforeCursor)}`)).status,400);
  const operation=await f.unwrap(await f.human(`/operations/${body.operationId}`));assert.equal(operation.status,'committed');
  assert.equal((await f.human(`/rooms/${a.room.id}/timeline?before=a&after=b`)).status,400);
});
test('v2 room SSE replays a bounded delta and old instance cursors require resync',async t=>{
  const f=await fixture(t),a=await f.create('Events');const view=await f.unwrap(await f.human(`/rooms/${a.room.id}/view`));
  await f.unwrap(await f.human(`/rooms/${a.room.id}/messages`,{operationId:op(),expectedGate:view.control.room.gate,recipients:['claude'],text:'delta only',attachmentIds:[]}));
  const controller=new AbortController();t.after(()=>controller.abort());
  const res=await fetch(`${f.server.url}/api/v2/rooms/${a.room.id}/events?after=${encodeURIComponent(view.eventCursor)}`,{headers:{Authorization:`Bearer ${f.server.credentials().humanToken}`},signal:controller.signal});
  assert.equal(res.status,200);const reader=res.body.getReader();const first=await reader.read();const chunk=Buffer.from(first.value).toString();assert.match(chunk,/event: room.delta/);assert.match(chunk,/delta only/);assert.ok(first.value.length<256*1024);await reader.cancel();
  const invalid=await fetch(`${f.server.url}/api/v2/rooms/${a.room.id}/events?after=invalid`,{headers:{Authorization:`Bearer ${f.server.credentials().humanToken}`}});
  assert.match(await invalid.text(),/event: resync_required/);
});
