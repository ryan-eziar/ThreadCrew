import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { V2Broker } from '../src/v2-broker.mjs';
import { createTextAttachment } from '../src/broker-storage.mjs';

async function fixture(options={}) {
  const parent=join(process.cwd(),'work'); await mkdir(parent,{recursive:true});
  const runtimeDir=await mkdtemp(join(parent,'v2-broker-test-'));
  const broker=await V2Broker.open({runtimeDir,...options});
  return {broker,runtimeDir};
}

test('room operations are workspace-idempotent and have separate lifecycle and read position',async()=>{
  const {broker}=await fixture();
  try {
    const a=await broker.createRoom({operationId:'room-create-a',name:'Same name'});
    const replay=await broker.createRoom({operationId:'room-create-a',name:'Same name'});
    assert.deepEqual(replay,a);
    await assert.rejects(broker.createRoom({operationId:'room-create-a',name:'Different'}),error=>error.code==='ID_CONFLICT');
    const b=await broker.createRoom({operationId:'room-create-b',name:'Same name'});
    assert.notEqual(a.roomId,b.roomId);
    const renamed=await broker.renameRoom(a.roomId,{operationId:'rename-a',expectedRoomVersion:1,name:'Renamed'});
    assert.equal(renamed.room.version,2);
    const sent=await broker.sendHuman(a.roomId,{operationId:'send-a',expectedGate:a.gate,recipients:['claude'],text:'Hello room A',attachmentIds:[]});
    assert.equal((await broker.getView(a.roomId)).page.items.at(-1).message.id,sent.messageId);
    const notice=await broker.store.read(sql=>sql.get('SELECT kind FROM catalog_notices WHERE room_id=?',[a.roomId]));
    assert.equal(notice.kind,'needs_human');
    assert.equal((await broker.getView(b.roomId)).page.items.length,0);
    const read=await broker.setReadPosition(a.roomId,{operationId:'read-a',throughOrder:1});
    assert.equal(read.throughOrder,1);
    const stopped=await broker.stop(a.roomId,{operationId:'stop-a',expectedGate:a.gate});
    assert.equal(stopped.effects.cancelledUnwrittenCount,1);
    const archived=await broker.archiveRoom(a.roomId,{operationId:'archive-a',expectedRoomVersion:2,expectedGate:stopped.gate,acknowledgePossibleRunning:false});
    assert.equal(archived.room.lifecycle,'archived');
    const restored=await broker.restoreRoom(a.roomId,{operationId:'restore-a',expectedRoomVersion:3});
    assert.equal(restored.room.lifecycle,'open');
    assert.equal((await broker.getControl(a.roomId)).members[1].binding,null);
  } finally {await broker.close();}
});

test('one native session cannot cross rooms with unresolved work; exact late final stays in old room',async()=>{
  const {broker}=await fixture();
  try {
    const a=await broker.createRoom({operationId:'room-a',name:'A'});
    const b=await broker.createRoom({operationId:'room-b',name:'B'});
    const joined=await broker.join(a.roomId,{agent:'claude',nativeSessionId:'session-1',expectedGate:a.gate});
    await assert.rejects(broker.join(b.roomId,{agent:'claude',nativeSessionId:'session-1',expectedGate:b.gate}),error=>error.code==='SESSION_IN_OTHER_ROOM'&&error.details.occupiedRoom.id===a.roomId);
    const gate=(await broker.getControl(a.roomId)).room.gate;
    const sent=await broker.sendHuman(a.roomId,{operationId:'send',expectedGate:gate,recipients:['claude'],text:'Prompt',attachmentIds:[]});
    const handoff=await broker.read(a.roomId,joined.bindingId,{requestId:'read-1'},()=>{});
    assert.equal(handoff.status,'DELIVERY');
    const current=(await broker.getControl(a.roomId)).room.gate;
    await broker.removeMember(a.roomId,'claude',{operationId:'remove',expectedGate:current,expectedBindingId:joined.bindingId,expectedBindingVersion:1,acknowledgePossibleRunning:true});
    await assert.rejects(broker.join(b.roomId,{agent:'claude',nativeSessionId:'session-1',expectedGate:b.gate}),error=>error.code==='SESSION_HAS_UNFINISHED_WORK'&&error.details.occupiedRoom.id===a.roomId);
    const delivery=(await broker.getDeliveries(a.roomId,{status:'possible_running'})).deliveries[0];
    await broker.abandonDelivery(a.roomId,sent.deliveryIds.claude,{operationId:'abandon',expectedDeliveryVersion:delivery.version,expectedClaimId:handoff.claimId});
    const moved=await broker.join(b.roomId,{agent:'claude',nativeSessionId:'session-1',expectedGate:b.gate});
    assert.equal(moved.roomId,b.roomId);
    const late=await broker.postReply(a.roomId,joined.bindingId,{deliveryId:handoff.deliveryId,claimId:handoff.claimId,text:'Late answer'});
    assert.ok(late.replyId);
    const answer=(await broker.getTimeline(a.roomId)).items.find(item=>item.reply?.id===late.replyId);
    assert.ok(answer.reply.lateReasons.includes('binding_left'));
    assert.equal((await broker.getTimeline(b.roomId)).items.length,1); // only B's binding event
    const duplicate=await broker.postReply(a.roomId,joined.bindingId,{deliveryId:handoff.deliveryId,claimId:handoff.claimId,text:'Late answer'});
    assert.equal(duplicate.duplicate,true);
  } finally {await broker.close();}
});

test('50-room catalog and 10k-row history stay bounded under one new message',async()=>{
  const {broker}=await fixture();
  try {
    const root=await broker.createRoom({operationId:'seed-root',name:'History'});
    await broker.store.tx(async sql=>{
      await sql.run(`WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<51)
        INSERT INTO rooms(id,version,created_order,name,lifecycle,created_at,last_activity_at,gate_segment_id,gate_version)
        SELECT 'seed-room-'||x,1,x,'Room '||x,'open','2026-09-28T00:00:00.000Z','2026-09-28T00:00:00.000Z','seed-segment-'||x,1 FROM n`);
      await sql.run(`WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<51)
        INSERT INTO segments(id,room_id,created_at) SELECT 'seed-segment-'||x,'seed-room-'||x,'2026-09-28T00:00:00.000Z' FROM n`);
      await sql.run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO timeline(id,room_id,order_num,version,segment_id,at,kind,system_type,data_json,text)
        SELECT 'seed-item-'||x,?,x,1,?,'2026-09-28T00:00:00.000Z','system','seed','{}','seed' FROM n`,[root.roomId,root.gate.segmentId]);
      await sql.run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO deliveries(id,room_id,version,segment_id,agent,state,wait_disposition,evidence_json,
          created_at,final_reply_id,text,attachment_ids_json,write_started,attempted)
        SELECT 'seed-delivery-'||x,?,1,?,'claude','replied','resolved','{}',
          '2026-09-28T00:00:00.000Z','seed-reply-'||x,'seed','[]',1,1 FROM n`,[root.roomId,root.gate.segmentId]);
      await sql.run('UPDATE rooms SET latest_order=10000 WHERE id=?',[root.roomId]);
    });
    const first=await broker.listRooms({limit:50});
    assert.equal(first.rooms.length,50); assert.ok(first.nextCursor);
    const second=await broker.listRooms({limit:50,cursor:first.nextCursor});
    assert.equal(second.rooms.length,1);
    const started=Date.now();
    const sent=await broker.sendHuman(root.roomId,{operationId:'after-history',expectedGate:root.gate,recipients:['claude'],text:'New tail',attachmentIds:[]});
    assert.ok(Date.now()-started<10000);
    const view=await broker.getView(root.roomId,{limit:100});
    assert.equal(view.page.items.length,100);
    assert.equal(view.page.items.at(-1).order,10001);
    assert.equal(view.page.items.at(-1).message.id,sent.messageId);
    assert.ok(Buffer.byteLength(JSON.stringify(view))<256*1024);
    const older=await broker.getTimeline(root.roomId,{limit:100,before:view.page.nextBeforeCursor});
    assert.equal(older.items.length,100);
    assert.equal(older.items.at(-1).order,9901);
  } finally {await broker.close();}
});

test('instance-scoped replay detects old cursors after restart',async()=>{
  const {broker,runtimeDir}=await fixture();
  const room=await broker.createRoom({operationId:'event-room',name:'Events'});
  const view=await broker.getView(room.roomId);
  await broker.sendHuman(room.roomId,{operationId:'event-message',expectedGate:room.gate,recipients:['claude'],text:'event',attachmentIds:[]});
  const replay=await broker.replayEvents('room',room.roomId,view.eventCursor);
  assert.equal(replay.events.length,1);
  assert.equal(replay.events[0].type,'room.delta');
  await broker.close();
  const restarted=await V2Broker.open({runtimeDir});
  try {assert.equal((await restarted.replayEvents('room',room.roomId,view.eventCursor)).resync.reason,'CURSOR_INVALID');}
  finally {await restarted.close();}
});

test('Stop cancels a large unwritten queue with bounded effects',async()=>{
  const {broker}=await fixture();
  try{
    const room=await broker.createRoom({operationId:'bulk-room',name:'Bulk'});
    await broker.store.tx(async sql=>{
      await sql.run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
        INSERT INTO deliveries(id,room_id,version,segment_id,agent,state,reason,wait_disposition,evidence_json,
          created_at,text,attachment_ids_json)
        SELECT 'bulk-delivery-'||x,?,1,?,'claude','pending_binding','NO_BINDING','none','{}',
          '2026-09-28T00:00:00.000Z','bulk','[]' FROM n`,[room.roomId,room.gate.segmentId]);
      await sql.run('UPDATE rooms SET pending_count=2000 WHERE id=?',[room.roomId]);
    });
    const result=await broker.stop(room.roomId,{operationId:'bulk-stop',expectedGate:room.gate});
    assert.equal(result.effects.cancelledUnwrittenCount,2000);
    assert.equal(result.effects.possibleRunningPreview.length,0);
    assert.equal((await broker.getControl(room.roomId)).pendingCount,0);
    const count=await broker.store.read(sql=>sql.get("SELECT COUNT(*) AS n FROM deliveries WHERE room_id=? AND state='stopped'",[room.roomId]));
    assert.equal(count.n,2000);
    const view=await broker.getView(room.roomId);
    assert.ok(Buffer.byteLength(JSON.stringify(view))<256*1024);
  }finally{await broker.close();}
});

test('verified Codex route carries room identity and synchronous Stop gate blocks unwritten transport',async()=>{
  let entered;
  const enteredPromise=new Promise(resolve=>{entered=resolve;});
  let gate;
  const transport={
    probe:async()=>({available:true}),
    send:async (delivery,{beforeSend})=>{
      entered({delivery,beforeSend});
      return new Promise(resolve=>{gate=resolve;});
    },
  };
  const {broker}=await fixture({codexTransport:transport});
  try{
    const room=await broker.createRoom({operationId:'push-room',name:'Push'});
    const joined=await broker.join(room.roomId,{agent:'codex',nativeSessionId:'codex-native',expectedGate:room.gate});
    assert.equal((await broker.getControl(room.roomId)).members[0].canReceive,true);
    const current=(await broker.getControl(room.roomId)).room.gate;
    const sent=await broker.sendHuman(room.roomId,{operationId:'push-message',expectedGate:current,recipients:['codex'],text:'Synthetic',attachmentIds:[]});
    const pending=await enteredPromise;
    assert.equal(pending.delivery.roomId,room.roomId);
    assert.equal(pending.delivery.bindingId,joined.bindingId);
    const stop=await broker.stop(room.roomId,{operationId:'push-stop',expectedGate:current});
    assert.equal(stop.effects.cancelledUnwrittenCount,1);
    assert.throws(()=>pending.beforeSend(),error=>error.code==='SEND_CANCELLED_BEFORE_WRITE');
    gate({status:'failed'});
    const page=await broker.getTimeline(room.roomId);
    assert.equal(page.items.find(item=>item.message?.id===sent.messageId).deliveries[0].state,'stopped');
  }finally{gate?.({status:'failed'});await broker.close();}
});

test('time-derived stuck attention changes once, without a synthetic timeline item',async()=>{
  let now=Date.parse('2026-09-28T00:00:00.000Z');
  const {broker}=await fixture({clock:()=>now});
  try{
    const room=await broker.createRoom({operationId:'stuck-room',name:'Stuck'});
    const joined=await broker.join(room.roomId,{agent:'claude',nativeSessionId:'stuck-native',expectedGate:room.gate});
    const gate=(await broker.getControl(room.roomId)).room.gate;
    const sent=await broker.sendHuman(room.roomId,{operationId:'stuck-send',expectedGate:gate,
      recipients:['claude'],text:'Question',attachmentIds:[]});
    const handed=await broker.read(room.roomId,joined.bindingId,{requestId:'stuck-read'},()=>{});
    assert.equal(handed.status,'DELIVERY');
    assert.equal((await broker.getControl(room.roomId)).needsRyan.count,0);
    const before=await broker.getView(room.roomId);
    const notices=[];
    broker.on('catalog.delta',event=>notices.push(...event.notices));
    now+=31*60_000;
    const first=await broker.refreshDueAttention({notify:true});
    assert.deepEqual(first.updatedRoomIds,[room.roomId]);
    const attention=await broker.getAttention(room.roomId);
    assert.equal(attention.count,1);
    assert.equal(attention.items[0].kind,'stuck');
    assert.equal(attention.items[0].deliveryId,sent.deliveryIds.claude);
    assert.equal(notices.length,1);
    assert.equal(notices[0].kind,'needs_human');
    assert.equal((await broker.store.read(sql=>sql.get('SELECT COUNT(*) AS n FROM catalog_notices WHERE room_id=?',[room.roomId]))).n,1);
    const after=await broker.getView(room.roomId);
    assert.equal(after.page.items.length,before.page.items.length);
    const second=await broker.refreshDueAttention({notify:true});
    assert.deepEqual(second.updatedRoomIds,[]);
    assert.equal(notices.length,1);
    assert.equal((await broker.getView(room.roomId)).revision,after.revision);
    await broker.store.tx(sql=>sql.run('UPDATE rooms SET attention_count=0 WHERE id=?',[room.roomId]));
    assert.deepEqual((await broker.refreshDueAttention()).updatedRoomIds,[room.roomId]);
    assert.equal(notices.length,1); // startup reconciliation does not backfill notifications
  }finally{await broker.close();}
});

test('missing attachment fails an active read but cannot overwrite a stopped reservation',async()=>{
  const {broker,runtimeDir}=await fixture();
  try{
    const room=await broker.createRoom({operationId:'attachment-room',name:'Attachment'});
    const joined=await broker.join(room.roomId,{agent:'claude',nativeSessionId:'attachment-native',expectedGate:room.gate});
    const gate=(await broker.getControl(room.roomId)).room.gate;
    const attachment=await createTextAttachment(runtimeDir,'Attachment body','evidence.txt');
    await broker.store.tx(sql=>sql.run(`INSERT INTO attachments(id,room_id,name,media_type,bytes,sha256,relative_path,preview_available)
      VALUES(?,?,?,?,?,?,?,?)`,[attachment.id,room.roomId,attachment.name,attachment.mediaType,attachment.bytes,
      attachment.sha256,attachment.relativePath,1]));
    const first=await broker.sendHuman(room.roomId,{operationId:'attachment-send-1',expectedGate:gate,
      recipients:['claude'],text:'First',attachmentIds:[attachment.id]});
    await unlink(join(runtimeDir,attachment.relativePath));
    await assert.rejects(broker.read(room.roomId,joined.bindingId,{requestId:'attachment-read-1'},()=>{}),
      error=>error.code==='ATTACHMENT_UNAVAILABLE');
    const failed=await broker.store.read(sql=>sql.get('SELECT id,state FROM deliveries WHERE id=?',[first.deliveryIds.claude]));
    assert.equal(failed.state,'failed');
    assert.equal((await broker.getTimeline(room.roomId)).items.find(item=>item.message?.id===first.messageId).deliveries[0].state,'failed');

    const second=await broker.sendHuman(room.roomId,{operationId:'attachment-send-2',expectedGate:gate,
      recipients:['claude'],text:'Second',attachmentIds:[attachment.id]});
    await broker.store.tx(async sql=>{
      await sql.run(`UPDATE deliveries SET state='dispatching',wait_disposition='waiting',claim_id=?,attempted=1,
        waiting_since=? WHERE id=?`,['synthetic-claim',new Date().toISOString(),second.deliveryIds.claude]);
      await sql.run('INSERT INTO read_requests(binding_id,request_id,result_json) VALUES(?,?,?)',
        [joined.bindingId,'attachment-read-2',JSON.stringify({status:'RESERVED',deliveryId:second.deliveryIds.claude,
          claimId:'synthetic-claim',batchId:null,replay:false})]);
    });
    const stopped=await broker.stop(room.roomId,{operationId:'attachment-stop',expectedGate:gate});
    assert.equal(stopped.effects.cancelledUnwrittenCount,1);
    const replay=await broker.read(room.roomId,joined.bindingId,{requestId:'attachment-read-2'},()=>{});
    assert.equal(replay.status,'PAUSED');
    assert.equal(replay.roomId,room.roomId);
    const state=await broker.store.read(sql=>sql.get('SELECT state FROM deliveries WHERE id=?',[second.deliveryIds.claude]));
    assert.equal(state.state,'stopped');
  }finally{await broker.close();}
});

test('expired Claude lease blocks a new claim while an exact written claim remains retriable',async()=>{
  let now=Date.parse('2026-09-28T00:00:00.000Z');
  const {broker}=await fixture({clock:()=>now});
  try{
    const room=await broker.createRoom({operationId:'lease-room',name:'Lease'});
    const joined=await broker.join(room.roomId,{agent:'claude',nativeSessionId:'lease-native',expectedGate:room.gate});
    const gate=(await broker.getControl(room.roomId)).room.gate;
    await broker.sendHuman(room.roomId,{operationId:'lease-first',expectedGate:gate,
      recipients:['claude'],text:'First',attachmentIds:[]});
    const first=await broker.read(room.roomId,joined.bindingId,{requestId:'lease-read-first'},()=>{});
    assert.equal(first.status,'DELIVERY');
    now+=11*60*60_000;
    const retry=await broker.read(room.roomId,joined.bindingId,{requestId:'lease-retry',claimId:first.claimId},()=>{});
    assert.equal(retry.status,'DELIVERY');
    assert.equal(retry.claimId,first.claimId);
    await broker.postReply(room.roomId,joined.bindingId,{deliveryId:first.deliveryId,claimId:first.claimId,text:'Answer'});
    const second=await broker.sendHuman(room.roomId,{operationId:'lease-second',expectedGate:gate,
      recipients:['claude'],text:'Second',attachmentIds:[]});
    now+=11*60*60_000;
    const expired=await broker.read(room.roomId,joined.bindingId,{requestId:'lease-read-second'},()=>{});
    assert.equal(expired.status,'TIMEOUT');
    assert.equal(expired.roomId,room.roomId);
    const expiredBatch=await broker.store.read(sql=>sql.get('SELECT batch_json,notification_json,drain_needs_wait FROM bindings WHERE id=?',[joined.bindingId]));
    assert.equal(expiredBatch.batch_json,null);
    assert.equal(expiredBatch.notification_json,null);
    assert.equal(expiredBatch.drain_needs_wait,1);
    const delivery=await broker.store.read(sql=>sql.get('SELECT state,claim_id FROM deliveries WHERE id=?',[second.deliveryIds.claude]));
    assert.equal(delivery.state,'queued');
    assert.equal(delivery.claim_id,null);
  }finally{await broker.close();}
});

test('discussion system items project exact room exchange and update through agreement or limit',async()=>{
  const {broker}=await fixture();
  try{
    const room=await broker.createRoom({operationId:'exchange-room',name:'Discussion'});
    const other=await broker.createRoom({operationId:'exchange-other',name:'Other'});
    const codex=await broker.join(room.roomId,{agent:'codex',nativeSessionId:'exchange-codex',expectedGate:room.gate});
    const claude=await broker.join(room.roomId,{agent:'claude',nativeSessionId:'exchange-claude',expectedGate:(await broker.getControl(room.roomId)).room.gate});
    const gate=(await broker.getControl(room.roomId)).room.gate;
    const base=await broker.sendHuman(room.roomId,{operationId:'exchange-base',expectedGate:gate,
      recipients:['codex','claude'],text:'Base question',attachmentIds:[]});
    await broker.store.tx(sql=>sql.run(`UPDATE deliveries SET attempted=1,write_started=1,state='awaiting_reply',
      wait_disposition='waiting' WHERE message_id=?`,[base.messageId]));
    const codexBase=await broker.postReply(room.roomId,codex.bindingId,{deliveryId:base.deliveryIds.codex,text:'Codex base'});
    const claudeBase=await broker.postReply(room.roomId,claude.bindingId,{deliveryId:base.deliveryIds.claude,text:'Claude base'});
    const pair={codex:codexBase.replyId,claude:claudeBase.replyId};
    const events=[];broker.on('room.delta',event=>events.push(event));

    async function seedExchange(number, legacyStart) {
      const exchangeId=`exchange-projection-${number}`;
      const ids={codex:`exchange-delivery-${number}-codex`,claude:`exchange-delivery-${number}-claude`};
      const claims={codex:`exchange-claim-${number}-codex`,claude:`exchange-claim-${number}-claude`};
      const startedId=`exchange-started-${number}`;
      await broker.store.tx(async sql=>{
        const current=await sql.get('SELECT latest_order,gate_segment_id FROM rooms WHERE id=?',[room.roomId]);
        const round={number:1,deliveryIds:ids,finalReplyIds:{codex:null,claude:null},finishVotes:{codex:null,claude:null}};
        await sql.run(`INSERT INTO exchanges(id,room_id,segment_id,version,base_message_id,previous_exchange_id,
          base_reply_ids_json,max_rounds,finish_policy,state,current_round,completed_rounds,rounds_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[exchangeId,room.roomId,current.gate_segment_id,1,base.messageId,null,
          JSON.stringify(pair),1,'both_same_round','active',1,0,JSON.stringify([round])]);
        await sql.run(`INSERT INTO timeline(id,room_id,order_num,version,segment_id,at,kind,ref_id,system_type,data_json,text)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[startedId,room.roomId,current.latest_order+1,1,current.gate_segment_id,
          new Date().toISOString(),'system',legacyStart?null:exchangeId,'exchange_started',JSON.stringify({exchangeId}),'exchange_started']);
        await sql.run('UPDATE rooms SET latest_order=?,active_exchange_id=? WHERE id=?',[current.latest_order+1,exchangeId,room.roomId]);
        for(const agent of ['codex','claude']){
          const binding=agent==='codex'?codex:claude;
          await sql.run(`INSERT INTO deliveries(id,room_id,version,source_reply_id,segment_id,exchange_id,round,agent,
            binding_id,native_session_id,state,claim_id,wait_disposition,evidence_json,created_at,text,
            attachment_ids_json,write_started,attempted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ids[agent],room.roomId,1,pair[agent==='codex'?'claude':'codex'],current.gate_segment_id,
            exchangeId,1,agent,binding.bindingId,binding.binding.nativeSessionId,'awaiting_reply',claims[agent],
            'waiting','{}',new Date().toISOString(),`Round ${number}`, '[]',1,1]);
        }
      });
      return {exchangeId,startedId,ids,claims};
    }

    for(const [number,done,reason] of [[1,true,'agreement'],[2,false,'limit']]){
      const ex=await seedExchange(number,number===1); // first item has the v1 migration shape: data.exchangeId, no ref_id
      const plan=await broker.store.read(sql=>sql.all(`EXPLAIN QUERY PLAN SELECT id FROM timeline WHERE room_id=?
        AND kind='system' AND system_type IN ('exchange_started','exchange_ended')
        AND json_extract(data_json,'$.exchangeId')=? LIMIT 3`,[room.roomId,ex.exchangeId]));
      assert.match(plan.map(item=>item.detail).join(' '),/timeline_exchange_system/);
      const initial=await broker.getTimelineItem(room.roomId,ex.startedId);
      assert.equal(initial.exchange.id,ex.exchangeId);
      assert.equal(initial.exchange.maxRounds,1);
      assert.equal(initial.exchange.state,'active');
      const first=await broker.postReply(room.roomId,codex.bindingId,{deliveryId:ex.ids.codex,
        claimId:ex.claims.codex,text:`Codex round ${number}`,done});
      assert.ok(first.replyId);
      const afterFirst=await broker.getTimelineItem(room.roomId,ex.startedId);
      assert.ok(afterFirst.version>initial.version);
      assert.equal(afterFirst.exchange.rounds[0].finishVotes.codex,done);
      assert.ok(events.at(-1).upsertEntries.some(item=>item.id===ex.startedId&&item.version===afterFirst.version));
      const second=await broker.postReply(room.roomId,claude.bindingId,{deliveryId:ex.ids.claude,
        claimId:ex.claims.claude,text:`Claude round ${number}`,done});
      assert.ok(second.replyId);
      const page=await broker.getTimeline(room.roomId);
      const started=page.items.find(item=>item.id===ex.startedId);
      const ended=page.items.find(item=>item.system?.systemType==='exchange_ended'&&item.system.data.exchangeId===ex.exchangeId);
      assert.equal(started.exchange.endReason,reason);
      assert.equal(started.exchange.completedRounds,1);
      assert.equal(ended.exchange.id,ex.exchangeId);
      assert.equal(ended.exchange.endReason,reason);
      assert.equal(ended.exchange.maxRounds,1);
      assert.ok(events.at(-1).upsertEntries.some(item=>item.id===ex.startedId&&item.exchange.endReason===reason));
      assert.ok(events.at(-1).upsertEntries.some(item=>item.id===ended.id&&item.exchange.endReason===reason));
    }
    await broker.store.tx(async sql=>{
      await sql.run(`INSERT INTO timeline(id,room_id,order_num,version,segment_id,at,kind,system_type,data_json,text)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,['foreign-exchange-system',other.roomId,1,1,other.gate.segmentId,
        new Date().toISOString(),'system','exchange_started',JSON.stringify({exchangeId:'exchange-projection-1'}),'exchange_started']);
      await sql.run('UPDATE rooms SET latest_order=1 WHERE id=?',[other.roomId]);
    });
    assert.equal((await broker.getTimelineItem(other.roomId,'foreign-exchange-system')).exchange,null);
  }finally{await broker.close();}
});

test('Claude drain closes each wake batch after three claims and never re-notifies an empty batch',async()=>{
  const {broker}=await fixture();
  try{
    const room=await broker.createRoom({operationId:'batch-room',name:'Batch drain'});
    const joined=await broker.join(room.roomId,{agent:'claude',nativeSessionId:'batch-claude',expectedGate:room.gate});
    const gate=(await broker.getControl(room.roomId)).room.gate;
    for(let i=1;i<=5;i++)await broker.sendHuman(room.roomId,{operationId:`batch-send-${i}`,expectedGate:gate,
      recipients:['claude'],text:`Message ${i}`,attachmentIds:[]});
    const first=await broker.wait(room.roomId,joined.bindingId,{requestId:'batch-wait-1'});
    assert.equal(first.status,'NEW');
    for(let i=1;i<=3;i++){
      const item=await broker.read(room.roomId,joined.bindingId,{requestId:`batch-read-${i}`,batchId:first.batchId},()=>{});
      assert.equal(item.status,'DELIVERY');
      assert.equal(item.text,`Message ${i}`);
      await broker.postReply(room.roomId,joined.bindingId,{deliveryId:item.deliveryId,claimId:item.claimId,text:`Reply ${i}`});
    }
    const limited=await broker.read(room.roomId,joined.bindingId,{requestId:'batch-limit',batchId:first.batchId});
    assert.equal(limited.status,'BATCH_LIMIT');
    const closed=await broker.store.read(sql=>sql.get('SELECT batch_json,notification_json,drain_needs_wait FROM bindings WHERE id=?',[joined.bindingId]));
    assert.equal(closed.batch_json,null);
    assert.equal(closed.notification_json,null);
    assert.equal(closed.drain_needs_wait,1);

    const second=await broker.wait(room.roomId,joined.bindingId,{requestId:'batch-wait-2'});
    assert.equal(second.status,'NEW');
    assert.notEqual(second.batchId,first.batchId);
    const replay=await broker.read(room.roomId,joined.bindingId,{requestId:'batch-limit',batchId:first.batchId});
    assert.equal(replay.status,limited.status); // exact request replay is inert
    assert.equal(replay.bindingId,limited.bindingId);
    await assert.rejects(broker.read(room.roomId,joined.bindingId,{requestId:'batch-stale',batchId:first.batchId}),
      error=>error.code==='BATCH_INVALID');
    const stillNew=await broker.store.read(sql=>sql.get('SELECT batch_json,notification_json FROM bindings WHERE id=?',[joined.bindingId]));
    assert.equal(JSON.parse(stillNew.batch_json).id,second.batchId);
    assert.equal(JSON.parse(stillNew.notification_json).batchId,second.batchId);
    for(let i=4;i<=5;i++){
      const item=await broker.read(room.roomId,joined.bindingId,{requestId:`batch-read-${i}`,batchId:second.batchId},()=>{});
      assert.equal(item.status,'DELIVERY');
      assert.equal(item.text,`Message ${i}`);
      await broker.postReply(room.roomId,joined.bindingId,{deliveryId:item.deliveryId,claimId:item.claimId,text:`Reply ${i}`});
    }
    const empty=await broker.read(room.roomId,joined.bindingId,{requestId:'batch-empty',batchId:second.batchId});
    assert.equal(empty.status,'EMPTY');
    const afterEmpty=await broker.store.read(sql=>sql.get('SELECT batch_json,notification_json,drain_needs_wait FROM bindings WHERE id=?',[joined.bindingId]));
    assert.equal(afterEmpty.batch_json,null);
    assert.equal(afterEmpty.notification_json,null);
    assert.equal(afterEmpty.drain_needs_wait,1);
    const abort=new AbortController();
    const idle=broker.wait(room.roomId,joined.bindingId,{requestId:'batch-idle',signal:abort.signal});
    await new Promise(resolve=>setTimeout(resolve,25));
    abort.abort();
    assert.equal((await idle).status,'DISCONNECTED');

    await broker.sendHuman(room.roomId,{operationId:'batch-send-6',expectedGate:gate,
      recipients:['claude'],text:'Message 6',attachmentIds:[]});
    const third=await broker.wait(room.roomId,joined.bindingId,{requestId:'batch-wait-3'});
    assert.equal(third.status,'NEW');
    assert.notEqual(third.batchId,second.batchId);
    assert.equal((await broker.read(room.roomId,joined.bindingId,{requestId:'batch-read-6',batchId:third.batchId},()=>{})).text,'Message 6');
    broker.blockRoom(room.roomId); // model the synchronous Stop gate before its transaction commits
    assert.equal((await broker.read(room.roomId,joined.bindingId,{requestId:'batch-paused',batchId:third.batchId})).status,'PAUSED');
    const afterPause=await broker.store.read(sql=>sql.get('SELECT batch_json,notification_json,drain_needs_wait FROM bindings WHERE id=?',[joined.bindingId]));
    assert.equal(afterPause.batch_json,null);
    assert.equal(afterPause.notification_json,null);
    assert.equal(afterPause.drain_needs_wait,1);
  }finally{await broker.close();}
});

test('queued delivery names an unresolved blocker from the stopped segment',async()=>{
  const {broker}=await fixture();
  try{
    const room=await broker.createRoom({operationId:'blocker-room',name:'Queue blocker'});
    const joined=await broker.join(room.roomId,{agent:'claude',nativeSessionId:'blocker-claude',expectedGate:room.gate});
    const gate=(await broker.getControl(room.roomId)).room.gate;
    const first=await broker.sendHuman(room.roomId,{operationId:'blocker-first',expectedGate:gate,
      recipients:['claude'],text:'Before stop',attachmentIds:[]});
    const running=await broker.read(room.roomId,joined.bindingId,{requestId:'blocker-read'},()=>{});
    assert.equal(running.status,'DELIVERY');
    const stopped=await broker.stop(room.roomId,{operationId:'blocker-stop',expectedGate:gate});
    const second=await broker.sendHuman(room.roomId,{operationId:'blocker-second',expectedGate:stopped.gate,
      recipients:['claude'],text:'After stop',attachmentIds:[]});
    const page=await broker.getTimeline(room.roomId);
    const queuedItem=page.items.find(item=>item.message?.id===second.messageId);
    const queued=queuedItem.deliveries[0];
    assert.equal(queued.state,'queued');
    assert.equal(queued.reason,'BLOCKED_BY_DELIVERY');
    assert.equal(queued.blockedByDeliveryId,first.deliveryIds.claude);
    assert.equal(queued.blockedByStoppedSegment,true);
    const listed=(await broker.getDeliveries(room.roomId,{status:'pending'})).deliveries.find(item=>item.id===queued.id);
    assert.equal(listed.reason,'BLOCKED_BY_DELIVERY');
    assert.equal(listed.blockedByDeliveryId,first.deliveryIds.claude);
    assert.equal(listed.blockedByStoppedSegment,true);
    const events=[];broker.on('room.delta',event=>events.push(event));
    await broker.postReply(room.roomId,joined.bindingId,{deliveryId:running.deliveryId,claimId:running.claimId,text:'Late answer'});
    const unblockedItem=await broker.getTimelineItem(room.roomId,queuedItem.id);
    const unblocked=unblockedItem.deliveries[0];
    assert.equal(unblocked.blockedByDeliveryId,null);
    assert.equal(unblocked.blockedByStoppedSegment,false);
    assert.ok(unblockedItem.version>queuedItem.version);
    assert.ok(events.some(event=>event.upsertEntries.some(item=>item.id===queuedItem.id&&item.version===unblockedItem.version)));

    const third=await broker.sendHuman(room.roomId,{operationId:'blocker-third',expectedGate:second.gate,
      recipients:['claude'],text:'Also after stop',attachmentIds:[]});
    const thirdBefore=(await broker.getTimeline(room.roomId)).items.find(item=>item.message?.id===third.messageId);
    assert.equal(thirdBefore.deliveries[0].blockedByDeliveryId,null);
    const notice=await broker.wait(room.roomId,joined.bindingId,{requestId:'blocker-second-wait'});
    assert.equal(notice.status,'NEW');
    const claimed=await broker.read(room.roomId,joined.bindingId,{requestId:'blocker-second-read',batchId:notice.batchId},()=>{});
    assert.equal(claimed.deliveryId,second.deliveryIds.claude);
    const thirdBlocked=await broker.getTimelineItem(room.roomId,thirdBefore.id);
    assert.equal(thirdBlocked.deliveries[0].blockedByDeliveryId,claimed.deliveryId);
    assert.ok(thirdBlocked.version>thirdBefore.version);
    assert.ok(events.some(event=>event.upsertEntries.some(item=>item.id===thirdBefore.id&&item.version===thirdBlocked.version)));
    const claimedRow=(await broker.getDeliveries(room.roomId,{status:'possible_running'})).deliveries.find(item=>item.id===claimed.deliveryId);
    await broker.abandonDelivery(room.roomId,claimed.deliveryId,{operationId:'blocker-abandon',
      expectedDeliveryVersion:claimedRow.version,expectedClaimId:claimed.claimId});
    const thirdUnblocked=await broker.getTimelineItem(room.roomId,thirdBefore.id);
    assert.equal(thirdUnblocked.deliveries[0].blockedByDeliveryId,null);
    assert.ok(thirdUnblocked.version>thirdBlocked.version);
    assert.ok(events.some(event=>event.upsertEntries.some(item=>item.id===thirdBefore.id&&item.version===thirdUnblocked.version)));
  }finally{await broker.close();}
});
