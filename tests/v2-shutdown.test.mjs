import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { V2Broker } from '../src/v2-broker.mjs';
import { WorkCoordinator } from '../src/v2-work.mjs';
import { createV2Server } from '../src/v2-server.mjs';
import { discoverService } from '../src/service-discovery.mjs';

const op = () => randomUUID();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, { beforeClose = async () => {} } = {}) {
  const project = resolve(import.meta.dirname,'..'), base = join(project,'work');
  await mkdir(base,{recursive:true});
  const dir = await mkdtemp(join(base,'v2-shutdown-test-')), runtimeDir = join(dir,'runtime');
  const broker = await V2Broker.open({runtimeDir}), work = await WorkCoordinator.attach(broker);
  let calls = 0;
  const server = await createV2Server({broker,work,runtimeDir,projectDir:project,shutdownGraceMs:5000,onShutdown:async()=>{
    calls++; await beforeClose(); await work.close(); await broker.close();
  }});
  t.after(async()=>{ await server.close(); await work.close(); await broker.close(); assert.ok(resolve(dir).startsWith(base+sep)); await rm(dir,{recursive:true,force:true}); });
  const headers = {Authorization:`Bearer ${server.credentials().humanToken}`};
  const human = (path,body,extra={}) => fetch(server.url+'/api/v2'+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{Origin:server.url,'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const good = async response => { const body = await response.json(); assert.equal(body.ok,true,JSON.stringify(body)); return body.result; };
  const shutdownId = 'shutdown-'+op(), expected = {expectedInstanceId:server.instanceId,shutdownId};
  const status = () => human(`/admin/shutdown-status?expectedInstanceId=${server.instanceId}&shutdownId=${shutdownId}`).then(good);
  const terminal = async () => { for(let i=0;i<150;i++){ const s=await status(); if(s.status!=='SHUTTING_DOWN')return s; await new Promise(done=>setTimeout(done,10)); } assert.fail('No terminal acknowledgement'); };
  return {broker,work,server,runtimeDir,human,good,headers,expected,status,terminal,calls:()=>calls};
}

test('exit authenticates exact instance and request, fences mutations, releases storage before terminal acknowledgement',async t=>{
  const gate=deferred(); t.after(()=>gate.resolve());
  const f=await fixture(t,{beforeClose:()=>gate.promise});
  for(const [body,headers,code] of [[f.expected,{Authorization:`Bearer ${'a'.repeat(43)}`},403],[f.expected,{Origin:'http://evil.invalid'},403],[{...f.expected,expectedInstanceId:'old-instance'},{},409]])
    assert.equal((await f.human('/admin/shutdown',body,headers)).status,code);
  assert.equal(f.calls(),0);
  const res=await f.human('/admin/shutdown',f.expected); assert.equal(res.status,202);
  const initial=await f.good(res); assert.equal(initial.status,'SHUTTING_DOWN'); assert.equal(initial.shutdownId,f.expected.shutdownId); assert.equal(initial.completedAt,null);
  assert.deepEqual(await f.good(await f.human('/admin/shutdown',f.expected)),initial);
  assert.equal((await f.human('/admin/shutdown',{...f.expected,shutdownId:'different-exit'})).status,409);
  assert.equal((await f.human('/rooms',{operationId:op(),name:'must not commit'})).status,503);
  assert.equal((await f.status()).status,'SHUTTING_DOWN');
  assert.ok(await readFile(join(f.runtimeDir,'broker-state.lock')));
  gate.resolve(); const stopped=await f.terminal(); assert.equal(stopped.status,'STOPPED'); assert.ok(stopped.completedAt); assert.equal(f.calls(),1);
  await assert.rejects(readFile(join(f.runtimeDir,'broker-state.lock')),e=>e.code==='ENOENT');
  assert.deepEqual(await f.good(await f.human('/admin/shutdown',f.expected)),stopped);
  assert.equal((await f.human(`/admin/shutdown-status?expectedInstanceId=${f.server.instanceId}&shutdownId=wrong`)).status,404);
  assert.equal((await discoverService(f.runtimeDir)).status,'startable');
  const next=await V2Broker.open({runtimeDir:f.runtimeDir});
  const nextServer=await createV2Server({broker:next,runtimeDir:f.runtimeDir,projectDir:resolve(import.meta.dirname,'..')});
  try {
    await f.server.close();
    assert.equal(JSON.parse(await readFile(join(f.runtimeDir,'connection-codex.json'),'utf8')).instanceId,next.instanceId);
    assert.equal((await discoverService(f.runtimeDir)).instanceId,next.instanceId);
  } finally { await nextServer.close(); await next.close(); }
});

test('all subscribed windows receive matching shutdown events, including completion after SQLite closes',async t=>{
  const f=await fixture(t), catalog=await f.good(await f.human('/rooms'));
  const streams=await Promise.all([1,2].map(async()=>{
    const controller=new AbortController(); t.after(()=>controller.abort());
    return fetch(`${f.server.url}/api/v2/events?after=${encodeURIComponent(catalog.eventCursor)}`,{headers:f.headers,signal:controller.signal}).then(res=>res.body.getReader());
  }));
  const reads=streams.map(async reader=>{
    let text=''; for(;;){ const chunk=await reader.read(); if(chunk.done)break; text+=Buffer.from(chunk.value).toString(); if(text.includes('"STOPPED"'))break; }
    await reader.cancel(); return text;
  });
  await f.good(await f.human('/admin/shutdown',f.expected));
  for(const text of await Promise.all(reads)){ assert.match(text,/event: service.shutdown/); assert.ok(text.includes(f.expected.shutdownId)); assert.match(text,/SHUTTING_DOWN/); assert.match(text,/STOPPED/); }
  await assert.rejects(readFile(join(f.runtimeDir,'broker-state.lock')),e=>e.code==='ENOENT');
});

test('failed close retains a failed acknowledgement and does not report stopped',async t=>{
  const f=await fixture(t,{beforeClose:async()=>{throw Object.assign(new Error('private detail'),{code:'JOURNAL_UNSAFE'});}});
  await f.good(await f.human('/admin/shutdown',f.expected));
  const status=await f.terminal(); assert.equal(status.status,'FAILED'); assert.equal(status.errorCode,'JOURNAL_UNSAFE'); assert.equal(status.completedAt,null);
  assert.ok(await readFile(join(f.runtimeDir,'broker-state.lock'))); assert.doesNotMatch(JSON.stringify(status),/private detail/);
});

test('an accepted operation settles before closing; a request body completed after the fence cannot mutate',async t=>{
  const f=await fixture(t), entered=deferred(), release=deferred(); t.after(()=>release.resolve());
  const original=f.broker.createRoom.bind(f.broker);
  f.broker.createRoom=async input=>{entered.resolve();await release.promise;return original(input);};
  const accepted=f.human('/rooms',{operationId:op(),name:'accepted'}); await entered.promise;
  const body=JSON.stringify({operationId:op(),name:'late body'});
  let pending;
  const late=new Promise((done,reject)=>{
    pending=http.request(f.server.url+'/api/v2/rooms',{method:'POST',headers:{...f.headers,Origin:f.server.url,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>done(res.statusCode));});
    pending.on('error',reject); pending.write(body.slice(0,-1));
  });
  await f.good(await f.human('/admin/shutdown',f.expected));
  assert.equal(f.calls(),0); assert.equal((await f.status()).status,'SHUTTING_DOWN');
  pending.end(body.slice(-1)); assert.equal(await late,503);
  release.resolve(); assert.equal((await f.good(await accepted)).room.name,'accepted');
  assert.equal((await f.terminal()).status,'STOPPED');
  const reopened=await V2Broker.open({runtimeDir:f.runtimeDir});
  try { assert.deepEqual((await reopened.listRooms({})).rooms.map(r=>r.name),['accepted']); } finally { await reopened.close(); }
});

test('exit preview counts queued deliveries across rooms and remains read-only',async t=>{
  const f=await fixture(t);
  for(const name of ['first','second']){
    const r=await f.good(await f.human('/rooms',{operationId:op(),name}));
    await f.good(await f.human(`/rooms/${r.room.id}/messages`,{operationId:op(),expectedGate:r.gate,recipients:['codex','claude'],text:'synthetic pending',attachmentIds:[]}));
  }
  const preview=await f.good(await f.human('/admin/shutdown-preview'));
  assert.equal(preview.instanceId,f.server.instanceId); assert.ok(preview.capturedAt);
  assert.deepEqual(preview.counts,{activeWorkRooms:0,queuedDeliveries:4,pendingWorkRequests:0,pendingWorkResponses:0,inFlightDeliveries:0,uncertainDeliveries:0});
  assert.equal(f.calls(),0); assert.equal((await f.good(await f.human('/rooms'))).rooms.length,2);
});

test('failed production owner exits with its lock intact, then launcher verifies recovery instead of reusing it',{timeout:30000},async t=>{
  const project=resolve(import.meta.dirname,'..'),base=join(project,'work');
  await mkdir(base,{recursive:true});
  const dir=await mkdtemp(join(base,'v2-shutdown-test-')),runtimeDir=join(dir,'runtime');
  const source=`
    import {V2Broker} from ${JSON.stringify(pathToFileURL(join(project,'src/v2-broker.mjs')).href)};
    import {createV2Server} from ${JSON.stringify(pathToFileURL(join(project,'src/v2-server.mjs')).href)};
    const runtimeDir=${JSON.stringify(runtimeDir)},broker=await V2Broker.open({runtimeDir});
    await broker.createRoom({operationId:'synthetic-preserve',name:'Preserved after failed exit'});
    const server=await createV2Server({broker,runtimeDir,projectDir:${JSON.stringify(project)},shutdownGraceMs:750,
      onShutdown:async()=>{throw Object.assign(new Error('synthetic failure'),{code:'JOURNAL_UNSAFE'});},onShutdownFailure:()=>process.exit(1)});
    console.log(JSON.stringify({url:server.url,instanceId:server.instanceId}));
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='',nextPid=null;
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const exited=new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    if(nextPid){try{process.kill(nextPid);}catch{}}
    await exited;
    assert.ok(resolve(dir).startsWith(base+sep)); await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const service=await new Promise((done,reject)=>{let text='';child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){try{done(JSON.parse(text.split('\n')[0]));}catch(e){reject(e);}}});child.once('exit',()=>reject(new Error(stderr)));});
  const client=async url=>{
    const html=await(await fetch(url)).text(),boot=JSON.parse(html.split('window.__AGENT_CHAT__=')[1].split(';</script>')[0]);
    assert.equal(boot.capabilities.shutdown,true);
    return {boot,request:(path,body)=>fetch(url+'/api/v2'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${boot.humanToken}`,...(body===undefined?{}:{Origin:url,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})};
  };
  const first=await client(service.url),shutdownId='failed-exit';
  assert.equal((await first.request('/admin/shutdown',{expectedInstanceId:service.instanceId,shutdownId})).status,202);
  const status=await(await first.request(`/admin/shutdown-status?expectedInstanceId=${service.instanceId}&shutdownId=${shutdownId}`)).json();
  assert.equal(status.result.status,'FAILED');
  assert.deepEqual(await exited,{code:1,signal:null});
  assert.ok(await readFile(join(runtimeDir,'broker-state.lock')));
  assert.equal((await discoverService(runtimeDir)).status,'locked');
  if(process.platform==='win32'){
    const result=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(project,'scripts/launch-agent-chat.ps1'),'-RuntimeDir',runtimeDir,'-NodePath',process.execPath,'-NoOpen'],{windowsHide:true,timeout:15000});
    const launched=JSON.parse(result.stdout);nextPid=launched.processId;
    assert.equal(launched.status,'started');assert.ok(launched.recoveryEvidence);
    const recovered=await client(launched.url),rooms=await(await recovered.request('/rooms')).json();
    assert.equal(rooms.result.rooms[0].name,'Preserved after failed exit');
    await recovered.request('/admin/shutdown',{expectedInstanceId:launched.instanceId,shutdownId:'clean-recovered-exit'});
    for(let i=0;i<100;i++){try{process.kill(nextPid,0);}catch(e){if(e.code==='ESRCH'){nextPid=null;break;}throw e;}await new Promise(done=>setTimeout(done,50));}
    assert.equal(nextPid,null,'recovered production owner should exit cleanly');
  }
});
