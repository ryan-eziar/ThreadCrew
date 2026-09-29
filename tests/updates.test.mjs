import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { readReleaseZip,writePackage,sha256,verifyInstalled,parseManifest,managedPath } from '../src/update-package.mjs';
import { applyUpdate,installationKind,git,writeUpdateState } from '../src/update-install.mjs';
import { UpdateManager,newer } from '../src/update-manager.mjs';
import { V2Broker } from '../src/v2-broker.mjs';
import { createV2Server } from '../src/v2-server.mjs';

// Store-only ZIP fixture. Integrity of file payloads is verified by the manifest.
function zip(entries){
  const local=[],central=[];let offset=0;
  for(const [name,data] of entries){const n=Buffer.from(name),b=Buffer.from(data),l=Buffer.alloc(30),c=Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(b.length,18);l.writeUInt32LE(b.length,22);l.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,6);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    local.push(l,n,b);central.push(c,n);offset+=l.length+n.length+b.length;
  }
  const body=Buffer.concat(local),index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.size,8);end.writeUInt16LE(entries.size,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(body.length,16);return Buffer.concat([body,index,end]);
}
function release(version,extra={}){
  const entries=new Map(Object.entries({'package.json':JSON.stringify({name:'threadcrew',version}), 'chat.mjs':`// ${version}\n`,
    'scripts/launch-agent-chat.ps1':'# synthetic launcher', 'src/node-runtime.mjs':'process.exit(0);',
    '.gitignore':'runtime/\nwork/\n','.gitattributes':'* text=auto eol=lf\n',...extra}).map(([n,b])=>[n,Buffer.from(b)]));
  const manifest={product:'ThreadCrew',files:[...entries].map(([path,b])=>({path,bytes:b.length,sha256:sha256(b)}))};
  entries.set('PUBLIC_EXPORT_MANIFEST.json',Buffer.from(JSON.stringify(manifest)));
  return {manifest,entries,bytes:zip(entries)};
}
async function fixture(){
  await fs.mkdir('work',{recursive:true});const base=await fs.mkdtemp(resolve('work','update-test-')),root=join(base,'app'),runtime=join(root,'runtime');
  await writePackage(root,release('0.2.1',{'old-only.txt':'old'}));await fs.mkdir(runtime);
  await fs.writeFile(join(runtime,'preserved.json'),'private synthetic state');await fs.mkdir(join(runtime,'attachments'));await fs.writeFile(join(runtime,'attachments','synthetic.txt'),'uploaded bytes');
  await fs.writeFile(join(root,'user-notes.txt'),'Keep my notes');
  return {base,root:await fs.realpath(root),runtime:await fs.realpath(runtime)};
}
async function jobFor(f,version='0.3.0'){
  const jobDir=join(f.runtime,'updates','case');await fs.mkdir(jobDir,{recursive:true});const stageDir=join(jobDir,'stage');
  await writePackage(stageDir,release(version,{'new-only.txt':'new'}));
  return {projectDir:f.root,runtimeDir:f.runtime,stageDir,jobDir,version,previousVersion:'0.2.1',operationId:'update-test',startedAt:new Date().toISOString(),installKind:'zip'};
}
test('release archives enforce version, hashes, managed paths and no extra files',()=>{
  const r=release('0.3.0');assert.equal(readReleaseZip(r.bytes,'0.3.0').entries.size,r.entries.size);
  assert.throws(()=>readReleaseZip(r.bytes,'0.4.0'),e=>e.code==='UPDATE_PACKAGE_INVALID');
  const changed=new Map(r.entries);changed.set('chat.mjs',Buffer.from('tamper'));assert.throws(()=>readReleaseZip(zip(changed),'0.3.0'),e=>e.code==='UPDATE_PACKAGE_INVALID');
  for(const name of ['../escape','C:/escape','runtime/secrets.json','ui/../../escape','ui/CON.txt','a\\b'])assert.throws(()=>managedPath(name));
  changed.set('unmanifested.txt',Buffer.from('extra'));assert.throws(()=>readReleaseZip(zip(changed),'0.3.0'));
  assert.equal(newer('0.10.0','0.9.9'),true);assert.equal(newer('0.3.0','0.3.0'),false);assert.throws(()=>newer('1.0.0-beta','0.3.0'));
});
test('portable installation preserves runtime and unmanaged files and removes only obsolete managed files',async()=>{
  const f=await fixture(),job=await jobFor(f);let started=0;
  const result=await applyUpdate(job,{openApp:false,restartApp:async j=>{started++;assert.equal(j.runtimeDir,f.runtime);assert.equal(j.version,'0.3.0');return {};}});
  assert.equal(result.state,'completed');assert.equal(started,1);
  assert.equal(JSON.parse(await fs.readFile(join(f.root,'package.json'))).version,'0.3.0');
  assert.equal(await fs.readFile(join(f.root,'user-notes.txt'),'utf8'),'Keep my notes');
  assert.equal(await fs.readFile(join(f.runtime,'preserved.json'),'utf8'),'private synthetic state');
  assert.equal(await fs.readFile(join(f.runtime,'attachments','synthetic.txt'),'utf8'),'uploaded bytes');
  await assert.rejects(fs.stat(join(f.root,'old-only.txt')),e=>e.code==='ENOENT');
});
test('failed restart rolls back app and runtime before restarting the original version',async()=>{
  const f=await fixture(),job=await jobFor(f),versions=[];
  await fs.writeFile(join(f.runtime,'v2-state.sqlite'),'old database fixture');
  const result=await applyUpdate(job,{openApp:false,stopApp:async()=>{},restartApp:async j=>{
    versions.push(j.version);if(j.version==='0.3.0'){
      await fs.writeFile(join(f.runtime,'preserved.json'),'startup changed state');
      await fs.writeFile(join(f.runtime,'v2-state.sqlite'),'new database fixture');await fs.writeFile(join(f.runtime,'v2-state.sqlite-wal'),'new WAL fixture');await fs.writeFile(join(f.runtime,'v2-state.sqlite-shm'),'new SHM fixture');
      throw Object.assign(Error('restart'),{code:'UPDATE_RESTART_FAILED'});
    }return {};
  }});
  assert.equal(result.state,'rolled_back');assert.deepEqual(versions,['0.3.0','0.2.1']);
  assert.equal(JSON.parse(await fs.readFile(join(f.root,'package.json'))).version,'0.2.1');assert.equal(await fs.readFile(join(f.runtime,'preserved.json'),'utf8'),'private synthetic state');
  await assert.rejects(fs.stat(join(f.root,'new-only.txt')),e=>e.code==='ENOENT');
  assert.equal(await fs.readFile(join(f.runtime,'v2-state.sqlite'),'utf8'),'old database fixture');
  await assert.rejects(fs.stat(join(f.runtime,'v2-state.sqlite-wal')),e=>e.code==='ENOENT');
  assert.equal(await fs.readFile(join(job.jobDir,'failed-startup-runtime','v2-state.sqlite-wal'),'utf8'),'new WAL fixture');
});
test('local modifications prevent replacement and leave the old service restartable',async()=>{
  const f=await fixture(),job=await jobFor(f);await fs.writeFile(join(f.root,'chat.mjs'),'local edit');let restarted=false;
  const result=await applyUpdate(job,{openApp:false,restartApp:async j=>{restarted=j.version==='0.2.1';return {};}});
  assert.equal(result.errorCode,'UPDATE_LOCAL_CHANGES');assert.equal(restarted,true);assert.equal(await fs.readFile(join(f.root,'chat.mjs'),'utf8'),'local edit');
});

test('validation failures record a terminal state and interrupted/unreadable update records do not fence ordinary work',async()=>{
  const f=await fixture(),job=await jobFor(f);await fs.writeFile(join(job.stageDir,'PUBLIC_EXPORT_MANIFEST.json'),'invalid');let restarted=false;
  const result=await applyUpdate(job,{openApp:false,restartApp:async()=>{restarted=true;return {};}});assert.equal(result.state,'failed');assert.equal(restarted,true);
  const features={broker:{workspaceId:'synthetic'},settings:async()=>({autoCheckUpdates:false})};
  await writeUpdateState(f.runtime,{install:{operationId:'interrupted',version:'0.3.0',state:'stopping'},installOwner:null});
  const manager=await new UpdateManager({projectDir:f.root,runtimeDir:f.runtime,features}).initialize();
  assert.equal(await manager.isApplying(),false);assert.equal((await manager.state()).install.errorCode,'UPDATE_INTERRUPTED');
  await fs.writeFile(join(f.runtime,'update-state.json'),'broken record');assert.equal(await manager.isApplying(),false);assert.equal((await manager.state()).errorCode,'UPDATE_STATE_UNREADABLE');
});
test('Git support rejects unsafe worktrees and verified fast-forward preserves runtime',async()=>{
  const f=await fixture();await fs.unlink(join(f.root,'user-notes.txt'));
  await git(f.root,['init','-b','main']);await git(f.root,['config','user.name','Synthetic Tester']);await git(f.root,['config','user.email','tester@example.com']);
  await git(f.root,['add','.']);await git(f.root,['-c','commit.gpgsign=false','commit','-m','Synthetic baseline']);
  const old=String(await git(f.root,['rev-parse','HEAD'])).trim();await git(f.root,['remote','add','origin','https://github.com/ryan-eziar/ThreadCrew.git']);await git(f.root,['update-ref','refs/remotes/origin/main',old]);
  assert.equal((await installationKind(f.root)).installKind,'git');
  const job=await jobFor(f);for(const [name,b] of release('0.3.0',{'new-only.txt':'new'}).entries){await fs.mkdir(join(f.root,name,'..'),{recursive:true});await fs.writeFile(join(f.root,name),b);}await fs.unlink(join(f.root,'old-only.txt'));
  await git(f.root,['add','.']);await git(f.root,['-c','commit.gpgsign=false','commit','-m','Synthetic update']);const target=String(await git(f.root,['rev-parse','HEAD'])).trim();
  assert.equal((await installationKind(f.root)).installUnsupportedReason,'GIT_WORKTREE_UNSAFE');
  await git(f.root,['update-ref','refs/remotes/origin/main',target]);await git(f.root,['reset','--keep',old]);
  const result=await applyUpdate({...job,installKind:'git',previousCommit:old,targetCommit:target},{openApp:false,restartApp:async()=>({})});
  assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(String(await git(f.root,['rev-parse','HEAD'])).trim(),target);
  assert.equal(await fs.readFile(join(f.runtime,'preserved.json'),'utf8'),'private synthetic state');
});

test('update endpoints keep auth/origin boundaries, settings and final busy fence',async t=>{
  await fs.mkdir('work',{recursive:true});const runtimeDir=await fs.mkdtemp(resolve('work','update-http-')),broker=await V2Broker.open({runtimeDir});
  const seen=[],server=await createV2Server({broker,runtimeDir,projectDir:resolve('.'),onShutdown:()=>broker.close(),updateOptions:{fetcher:fetchFixture(release('0.3.0'),seen)}});
  t.after(async()=>{await server.close();await broker.close();});
  const headers={Authorization:'Bearer '+server.credentials().humanToken,Origin:server.url,'Content-Type':'application/json'};
  const call=(path,body)=>fetch(server.url+'/api/v2'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await fetch(server.url+'/api/v2/updates')).status,401);
  assert.equal((await fetch(server.url+'/api/v2/updates/check',{method:'POST',headers:{...headers,Origin:'http://other.invalid'},body:'{}'})).status,403);
  assert.equal((await call('/updates')).status,200);assert.equal(seen.length,0);
  const state=await(await call('/updates/check',{})).json();assert.equal(state.result.updates.latestVersion,'0.3.0');assert.equal(seen.length,1);
  const settings=await(await call('/settings',{operationId:'set-updates',expectedVersion:0,autoCheckUpdates:false})).json();assert.equal(settings.result.settings.autoCheckUpdates,false);
  const room=await broker.createRoom({operationId:'room',name:'Busy synthetic room'});
  await broker.sendHuman(room.roomId,{operationId:'pending',expectedGate:room.gate,recipients:['claude'],text:'Pending work',attachmentIds:[]});
  const preview=await(await call('/updates/preview')).json();assert.equal(preview.result.counts.queuedDeliveries,1);assert.equal(preview.result.rooms[0].roomName,'Busy synthetic room');
  let launched=false;await assert.rejects(server.updates.prepareShutdown('busy-final',async()=>{launched=true;}),e=>e.code==='UPDATE_BUSY');assert.equal(launched,false);
  assert.equal((await call('/settings')).status,200);
  await writeUpdateState(runtimeDir,{install:{operationId:'external-runner',version:'0.3.0',state:'restarting'},installOwner:{pid:process.pid}});
  assert.equal((await call('/rooms',{operationId:'fenced',name:'Must not appear'})).status,409);assert.equal((await call('/diagnostics')).status,200);
});
function fetchFixture(r,seen){
  const source='https://github.com/ryan-eziar/ThreadCrew',assetName='ThreadCrew-0.3.0.zip';
  return async url=>{seen.push(url);
    if(url.endsWith('/releases/latest'))return new Response(JSON.stringify({tag_name:'v0.3.0',draft:false,prerelease:false,html_url:source+'/releases/tag/v0.3.0',assets:[{name:assetName,size:r.bytes.length,browser_download_url:source+'/releases/download/v0.3.0/'+assetName},{name:'SHA256SUMS.txt',size:110,browser_download_url:source+'/releases/download/v0.3.0/SHA256SUMS.txt'}]}));
    if(url.endsWith('SHA256SUMS.txt'))return new Response(sha256(r.bytes)+'  '+assetName+'\n');
    if(url.endsWith('.zip'))return new Response(r.bytes);throw Error('Unexpected fetch');
  };
}
test('update manager uses fixed cached release source, exact install idempotency and final busy refusal',async()=>{
  const f=await fixture(),r=release('0.3.0'),seen=[];let busy=false,shutdowns=0;
  // Stage launcher dependencies used by the real manager; no installed app is replaced here.
  for(const name of ['update-install.mjs','update-package.mjs']){await fs.mkdir(join(f.root,'src'),{recursive:true});await fs.copyFile(resolve('src',name),join(f.root,'src',name));}
  const features={broker:{workspaceId:'synthetic-workspace'},settings:async()=>({autoCheckUpdates:true}),updatePreview:async()=>({counts:{activeWorkRooms:busy?1:0},rooms:[]})};
  const manager=await new UpdateManager({projectDir:f.root,runtimeDir:f.runtime,features,fetcher:fetchFixture(r,seen),prepareShutdown:async()=>{shutdowns++;throw Object.assign(Error('busy'),{code:'UPDATE_BUSY'});}}).initialize();
  await manager.check();await manager.check();assert.equal(seen.length,1);assert.equal((await manager.state()).latestVersion,'0.3.0');
  busy=true;await assert.rejects(manager.install({operationId:'busy',expectedVersion:'0.3.0'}),e=>e.code==='UPDATE_BUSY');busy=false;
  const input={operationId:'install-once',expectedVersion:'0.3.0'};const [a,b]=await Promise.all([manager.install(input),manager.install(input)]);assert.equal(a.install.operationId,b.install.operationId);
  await manager.task;assert.equal(shutdowns,1);assert.equal((await manager.state()).install.errorCode,'UPDATE_BUSY');
  assert.equal(JSON.parse(await fs.readFile(join(f.root,'package.json'))).version,'0.2.1');manager.close();
});
