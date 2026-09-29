import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { V2Broker } from '../src/v2-broker.mjs';
import { createV2Server } from '../src/v2-server.mjs';
import { runV2Cli } from '../src/v2-cli.mjs';
const project = resolve(import.meta.dirname, '..');
const op = () => randomUUID();
async function fixture(t) {
  const base = join(project,'work'); await mkdir(base,{recursive:true});
  const dir = await mkdtemp(join(base,'threadcrew-test-')), runtimeDir = join(dir,'runtime');
  const broker = await V2Broker.open({runtimeDir}), server = await createV2Server({broker,runtimeDir,projectDir:project});
  t.after(async()=>{ await server.close(); await broker.close(); assert.ok(resolve(dir).startsWith(base+sep)); await rm(dir,{recursive:true,force:true}); });
  const human = (path,body,headers={}) => fetch(server.url+'/api/v2'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${server.credentials().humanToken}`,...(body===undefined?{}:{Origin:server.url,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const good = async res => { const body=await res.json(); assert.equal(body.ok,true,JSON.stringify(body)); return body.result; };
  const room = async name => good(await human('/rooms',{operationId:op(),name}));
  const cli = args => runV2Cli(args,{projectDir:project,runtimeDir,stdout:()=>{}});
  return {dir,runtimeDir,broker,server,human,good,room,cli};
}
test('settings and room notes are durable, versioned, replayable and included on exact join',async t=>{
  const f=await fixture(t),r=await f.room('Research');
  assert.deepEqual((await f.good(await f.human('/settings'))).settings,{version:0,displayName:'',backgroundNoticeAcknowledged:false,autoCheckUpdates:true});
  const body={operationId:op(),expectedVersion:0,displayName:'  Alex  '};
  const first=await f.good(await f.human('/settings',body)); assert.equal(first.settings.displayName,'Alex');
  assert.deepEqual(await f.good(await f.human('/settings',body)),first);
  assert.equal((await f.human('/settings',{...body,operationId:op()})).status,409);
  const note={operationId:op(),expectedVersion:0,text:'Current objective: compare two synthetic drafts.'};
  const saved=await f.good(await f.human(`/rooms/${r.room.id}/notes`,note)); assert.equal(saved.notes.version,1);
  assert.deepEqual(await f.good(await f.human(`/rooms/${r.room.id}/notes`,note)),saved);
  const control=await f.good(await f.human(`/rooms/${r.room.id}/control`));
  assert.equal(control.members[0].joinHint.helperPath,join(project,'chat.mjs'));
  assert.equal(control.members[0].joinHint.protocolPath,join(project,'docs/AGENT_PROTOCOL.md'));
  const joined=await f.cli(['join','--room',r.room.id,'--as','claude','--session','session-synthetic-notes','--expected-binding','null','--gate-segment',control.room.gate.segmentId,'--gate-version',String(control.room.gate.version)]);
  assert.equal(joined.roomNotes.text,note.text);
  const persisted=await f.broker.store.read(sql=>sql.get('SELECT value FROM metadata WHERE key=?',['threadcrew_settings']));
  assert.equal(JSON.parse(persisted.value).displayName,'Alex');
  const notice=await f.good(await f.human('/settings',{operationId:op(),expectedVersion:1,backgroundNoticeAcknowledged:true}));
  assert.equal(notice.settings.displayName,'Alex'); assert.equal(notice.settings.backgroundNoticeAcknowledged,true);
  const rename=await f.good(await f.human('/settings',{operationId:op(),expectedVersion:2,displayName:'Sam'}));
  assert.equal(rename.settings.backgroundNoticeAcknowledged,true);
  assert.equal((await f.human('/settings',{operationId:op(),expectedVersion:3,backgroundNoticeAcknowledged:'yes'})).status,400);
  assert.equal(JSON.parse((await f.broker.store.read(sql=>sql.get('SELECT value FROM metadata WHERE key=?',['threadcrew_settings']))).value).backgroundNoticeAcknowledged,true);
  const diag=await f.good(await f.human('/diagnostics')); assert.equal(diag.product,'ThreadCrew');
  assert.equal(diag.version,'0.3.0');
  assert.equal(diag.supportedNodeRange,'>=22.16.0 <23 || >=24.0.0 <25');
  assert.equal(diag.checks.find(check=>check.id==='node').status,'ok');
  assert.doesNotMatch(JSON.stringify(diag),/token|credential|nativeSessionId|[A-Z]:[\\/]/i);
});

test('uploads supported files, reads exact binary and text, and delivers registered paths through Claude',async t=>{
  const f=await fixture(t),r=await f.room('Files'),other=await f.room('Other');
  const fixtures=[['notes.txt','text/plain',Buffer.from('hello 世界')],['notes.log','text/plain',Buffer.from('log')],
    ['notes.md','text/markdown',Buffer.from('# title')],['table.csv','text/csv',Buffer.from('a,b\n1,2')],
    ['data.json','application/json',Buffer.from('{"ok":true}')],['page.pdf','application/pdf',Buffer.from('%PDF-1.4\nsynthetic')],
    ['pixel.png','image/png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')],
    ['photo.jpg','image/jpeg',Buffer.from([255,216,255,217])],['image.webp','image/webp',Buffer.from('RIFF0000WEBP')]];
  const ids=[];
  for(const [name,mediaType,bytes] of fixtures){
    const body={operationId:op(),name,mediaType,dataBase64:bytes.toString('base64')};
    const result=await f.good(await f.human(`/rooms/${r.room.id}/attachments`,body));
    assert.deepEqual(await f.good(await f.human(`/rooms/${r.room.id}/attachments`,body)),result);
    const a=result.attachment; ids.push(a.id); assert.equal(a.sha256,createHash('sha256').update(bytes).digest('hex')); assert.equal(a.relativePath,undefined);
    const download=await f.human(`/rooms/${r.room.id}/attachments/${a.id}/download`); assert.equal(download.status,200); assert.match(download.headers.get('content-disposition'),/filename\*=UTF-8/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    if(a.previewAvailable) assert.equal((await f.good(await f.human(`/rooms/${r.room.id}/attachments/${a.id}/text`))).text,bytes.toString());
    assert.equal((await f.human(`/rooms/${other.room.id}/attachments/${a.id}/download`)).status,404);
  }
  const joined=await f.cli(['join','--room',r.room.id,'--as','claude','--session','session-synthetic-files','--expected-binding','null','--gate-segment',r.gate.segmentId,'--gate-version',String(r.gate.version)]);
  const gate=(await f.good(await f.human(`/rooms/${r.room.id}/control`))).room.gate;
  await f.good(await f.human(`/rooms/${r.room.id}/messages`,{operationId:op(),expectedGate:gate,recipients:['claude'],text:'Read these files',attachmentIds:ids}));
  await f.cli(['wait','--room',r.room.id,'--as','claude','--binding',joined.bindingId]);
  const delivery=await f.cli(['read','--room',r.room.id,'--as','claude','--binding',joined.bindingId]);
  assert.equal(delivery.attachments.length,fixtures.length);
  for(const a of delivery.attachments) assert.equal(createHash('sha256').update(await readFile(a.path)).digest('hex'),a.sha256);
});

test('upload enforces authentication, type, path and per-file limits without raising ordinary body limits',async t=>{
  const f=await fixture(t),r=await f.room('Limits');
  const body={operationId:op(),name:'data.txt',mediaType:'text/plain',dataBase64:Buffer.from('safe').toString('base64')};
  const endpoint=`/rooms/${r.room.id}/attachments`;
  assert.equal((await f.human(endpoint,body,{Authorization:''})).status,401);
  assert.equal((await f.human(endpoint,body,{Origin:'http://foreign.invalid'})).status,403);
  assert.equal((await f.human(endpoint,{...body,name:'../data.txt'})).status,400);
  assert.equal((await f.human(endpoint,{...body,name:'page.html',mediaType:'text/html'})).status,415);
  assert.equal((await f.human(endpoint,{...body,name:'page.pdf',mediaType:'application/pdf'})).status,415);
  assert.equal((await f.human(endpoint,{...body,dataBase64:'@@@@'})).status,400);
  const maximum=Buffer.alloc(10*1024*1024,65);
  assert.equal((await f.human(endpoint,{...body,operationId:op(),dataBase64:maximum.toString('base64')})).status,200);
  assert.equal((await f.human(endpoint,{...body,operationId:op(),dataBase64:Buffer.concat([maximum,Buffer.from('X')]).toString('base64')})).status,413);
  assert.notEqual((await f.human('/settings',{operationId:op(),expectedVersion:0,displayName:'x'.repeat(1024*1024)})).status,200);
});

test('search pages exact room full messages/replies and exports full text with attachment names, not paths',async t=>{
  const f=await fixture(t),r=await f.room('搜索群'),other=await f.room('Private other');
  const joinResult=await f.cli(['join','--room',r.room.id,'--as','claude','--session','session-synthetic-search','--expected-binding','null','--gate-segment',r.gate.segmentId,'--gate-version',String(r.gate.version)]);
  let gate=(await f.good(await f.human(`/rooms/${r.room.id}/control`))).room.gate;
  await f.good(await f.human(`/rooms/${r.room.id}/messages`,{operationId:op(),expectedGate:gate,recipients:['claude'],text:'Needle question',attachmentIds:[]}));
  await f.cli(['wait','--room',r.room.id,'--as','claude','--binding',joinResult.bindingId]);
  const delivery=await f.cli(['read','--room',r.room.id,'--as','claude','--binding',joinResult.bindingId]);
  const long='plain '.repeat(4000)+'needle full reply tail';const answer=join(f.dir,'answer.txt');await writeFile(answer,long);
  await f.cli(['post','--room',r.room.id,'--as','claude','--binding',joinResult.bindingId,'--delivery',delivery.deliveryId,'--file',answer]);
  await f.good(await f.human(`/rooms/${other.room.id}/messages`,{operationId:op(),expectedGate:other.gate,recipients:['claude'],text:'needle OTHER_ROOM_SECRET',attachmentIds:[]}));
  const found=await f.good(await f.human(`/rooms/${r.room.id}/search?q=needle&limit=1`)); assert.equal(found.items.length,1); assert.ok(found.nextCursor);assert.equal(found.items[0].author,'claude');
  const around=await f.good(await f.human(`/rooms/${r.room.id}/timeline?around=${encodeURIComponent(found.items[0].aroundCursor)}`)); assert.ok(around.items.some(i=>i.id===found.items[0].id));
  const next=await f.good(await f.human(`/rooms/${r.room.id}/search?q=needle&limit=1&cursor=${encodeURIComponent(found.nextCursor)}`)); assert.equal(next.items[0].author,'ryan');assert.equal(next.nextCursor,null);
  assert.equal((await f.human(`/rooms/${other.room.id}/search?q=needle&cursor=${encodeURIComponent(found.nextCursor)}`)).status,400);
  const download=await f.human(`/rooms/${r.room.id}/export`); assert.match(download.headers.get('content-disposition'),/filename\*=UTF-8/);
  const markdown=await download.text(); assert.ok(markdown.includes(long));assert.doesNotMatch(markdown,/OTHER_ROOM_SECRET|nativeSessionId|binding-|credential/);
  assert.ok(markdown.includes(`Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`));
  assert.doesNotMatch(markdown,/binding_changed|room_created/);
  assert.ok(markdown.endsWith('<!-- ThreadCrew export complete -->\n'));
  assert.match(markdown,/## You/);
  const chinese=await(await f.human(`/rooms/${r.room.id}/export?lang=zh`)).text();
  assert.ok(chinese.includes(long)); assert.match(chinese,/## 你/);
  assert.equal((await f.human(`/rooms/${r.room.id}/export?lang=bad`)).status,400);
});
