import { createHash } from 'node:crypto';
import { V2BrokerError } from './v2-broker.mjs';

const key=roomId=>`work_start_confirmation:${roomId}`;
const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
const reject=code=>{throw new V2BrokerError(code,code,409);};
const parse=row=>row?JSON.parse(row.value):null;
async function currentSource(sql,roomId){return sql.get("SELECT m.* FROM messages m JOIN timeline t ON t.ref_id=m.id AND t.kind='message' WHERE m.room_id=? ORDER BY t.order_num DESC LIMIT 1",[roomId]);}
async function isCurrent(sql,room,pending){
  if(room.lifecycle!=='open'||room.stopped_at||room.gate_segment_id!==pending.expectedGate.segmentId||room.gate_version!==pending.expectedGate.version)return false;
  if((await currentSource(sql,room.id))?.id!==pending.sourceHumanMessageId)return false;
  for(const agent of ['codex','claude'])if((await sql.get('SELECT id FROM bindings WHERE room_id=? AND agent=? AND current=1',[room.id,agent]))?.id!==pending.expectedBindings[agent])return false;
  return true;
}
export async function pendingKickoff(sql,room){
  const pending=parse(await sql.get('SELECT value FROM metadata WHERE key=?',[key(room.id)]));
  if(!pending||pending.state==='started')return null;
  return {state:await isCurrent(sql,room,pending)?'waiting_peer':'expired',sourceHumanMessageId:pending.sourceHumanMessageId,
    planSha256:pending.planSha256,planPreview:[...pending.planText].slice(0,600).join(''),confirmations:pending.confirmations};
}
export async function startContext(coordinator,roomId,bindingId){
  return coordinator.broker.store.read(async sql=>{
    const room=await sql.get('SELECT * FROM rooms WHERE id=?',[roomId]);
    const binding=await sql.get('SELECT * FROM bindings WHERE id=? AND room_id=? AND current=1',[bindingId,roomId]);
    if(!room||!binding)reject('BINDING_CHANGED');
    const source=await currentSource(sql,roomId);
    const delivery=source&&await sql.get('SELECT text FROM deliveries WHERE message_id=? AND binding_id=? AND work_id IS NULL ORDER BY created_at LIMIT 1',[source.id,bindingId]);
    const bindings=await sql.all('SELECT agent,id FROM bindings WHERE room_id=? AND current=1',[roomId]);
    const pending=parse(await sql.get('SELECT value FROM metadata WHERE key=?',[key(roomId)]));
    const projection=await pendingKickoff(sql,room);
    return {sourceHumanMessage:delivery?{id:source.id,text:delivery.text,textSha256:digest(delivery.text),attachmentIds:JSON.parse(source.attachment_ids_json)}:null,
      expectedGate:{segmentId:room.gate_segment_id,version:room.gate_version},expectedBindings:Object.fromEntries(bindings.map(b=>[b.agent,b.id])),
      pendingKickoff:projection?{...projection,planText:pending.planText}:null,
      notice:'Read the full human instruction and agreed plan before confirming. Hashes verify matching text, not permission. Post your ordinary reply and finish any discussion first.'};
  });
}
export async function confirmStart(coordinator,roomId,bindingId,body){
  const allowed=['operationId','expectedGate','expectedBindings','sourceHumanMessageId','sourceTextSha256','planText','planSha256','implementationAuthorized'];
  if(!body||Object.keys(body).some(k=>!allowed.includes(k))||body.implementationAuthorized!==true
    ||typeof body.planText!=='string'||!body.planText.trim()||!body.planText.isWellFormed()||[...body.planText].length>8000
    ||!/^[a-f0-9]{64}$/.test(body.sourceTextSha256??'')||digest(body.planText)!==body.planSha256
    ||!body.expectedBindings||Object.keys(body.expectedBindings).sort().join(',')!=='claude,codex')reject('INVALID_INPUT');
  const result=await coordinator.broker.mutate(`work.confirm:${bindingId}`,roomId,body,async ctx=>{
    const binding=await ctx.getBinding(bindingId);
    if(!binding?.current||body.expectedBindings[binding.agent]!==bindingId)reject('BINDING_CHANGED');
    const pending=parse(await ctx.sql.get('SELECT value FROM metadata WHERE key=?',[key(roomId)]));
    const identity={sourceHumanMessageId:body.sourceHumanMessageId,sourceTextSha256:body.sourceTextSha256,
      planSha256:body.planSha256,expectedGate:body.expectedGate,expectedBindings:body.expectedBindings};
    if(pending?.sourceHumanMessageId===body.sourceHumanMessageId){
      if(pending.planSha256!==body.planSha256||pending.sourceTextSha256!==body.sourceTextSha256)reject('PLAN_CHANGED');
      if(pending.state==='started')return {work:await coordinator.summary(ctx.sql,await coordinator.load(ctx.sql,roomId,pending.workId)),pendingKickoff:null,duplicate:true};
      if(!await isCurrent(ctx.sql,ctx.room,pending))reject('START_CONFIRMATION_EXPIRED');
    }
    if(!await isCurrent(ctx.sql,ctx.room,identity))reject('START_CONFIRMATION_EXPIRED');
    if(await coordinator.current(ctx.sql,roomId))reject('WORK_IN_PROGRESS');
    const source=await currentSource(ctx.sql,roomId);
    if(source.author!=='ryan'||source.segment_id!==ctx.room.gate_segment_id)reject('SOURCE_NOT_HUMAN');
    if(await ctx.sql.get("SELECT id FROM work_sessions WHERE room_id=? AND json_extract(data_json,'$.sourceHumanMessageId')=?",[roomId,source.id]))reject('KICKOFF_MESSAGE');
    // Use persisted original deliveries, never text supplied by a peer as authority.
    const originalIds=JSON.parse(source.delivery_ids_json);
    let original;
    for(const agent of ['codex','claude']){
      const d=await ctx.sql.get("SELECT * FROM deliveries WHERE room_id=? AND message_id=? AND binding_id=? AND work_id IS NULL ORDER BY created_at LIMIT 1",[roomId,source.id,body.expectedBindings[agent]]);
      if(!d||!originalIds.includes(d.id)||!d.attempted||d.wait_disposition==='abandoned')reject('SOURCE_NOT_DELIVERED');
      if(agent===binding.agent&&!d.final_reply_id)reject('SOURCE_REPLY_REQUIRED');
      original??=d;
    }
    if(digest(original.text)!==body.sourceTextSha256)reject('SOURCE_CHANGED');
    const value=pending?.sourceHumanMessageId===source.id?pending:{...identity,planText:body.planText,state:'waiting_peer',confirmations:[]};
    if(!value.confirmations.some(c=>c.agent===binding.agent))value.confirmations.push({agent:binding.agent,at:ctx.now});
    let work=null;
    if(value.confirmations.length===2){
      if(ctx.room.active_exchange_id)reject('EXCHANGE_ACTIVE');
      const authority={kind:'agent_confirmation',sourceHumanMessageId:source.id,confirmations:value.confirmations,
        planSha256:value.planSha256,planPreview:[...value.planText].slice(0,600).join('')};
      const started=await coordinator.startTx(ctx,roomId,{expectedBindings:body.expectedBindings,text:original.text,
        attachmentIds:JSON.parse(source.attachment_ids_json),objective:[...original.text].slice(0,240).join(''),
        requestLimit:24,wakeLimit:48,durationSeconds:36000},{sourceMessageId:source.id,authority,planText:value.planText});
      work=started.work;value.state='started';value.workId=work.id;
    }
    await ctx.sql.run('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key(roomId),JSON.stringify(value)]);
    return {work,pendingKickoff:work?null:await pendingKickoff(ctx.sql,ctx.room)};
  });
  if(result.work)coordinator.armExpiry(result.work);
  return result;
}
