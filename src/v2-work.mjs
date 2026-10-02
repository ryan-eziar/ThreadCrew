import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { readAttachmentBytes } from './broker-storage.mjs';
import { V2BrokerError } from './v2-broker.mjs';
import { workAuthorization } from './delivery-authority.mjs';
import { confirmStart, pendingKickoff, startContext } from './work-start-confirmation.mjs';

const agents = ['codex', 'claude'];
const receiveModes = new Set(['unverified', 'next_step', 'next_turn', 'unavailable']);
const canPush = mode => mode === 'next_step' || mode === 'next_turn';
const active = w => ['active', 'paused_budget'].includes(w.coordinationState);
const MAX_WORK_SECONDS = 86400;
const MAX_ADD_SECONDS = 36000;
const uid = prefix => `${prefix}-${randomUUID()}`;
const json = JSON.stringify;
const parse = row => row ? JSON.parse(row.data_json) : null;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const availability = reason => ({ enabled: !reason, reason: reason ?? null });
const safeText = (value, max = 32000) => { if (typeof value !== 'string' || !value.isWellFormed() || [...value].length > max) reject('INVALID_INPUT', 400); return value; };
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) reject('INVALID_INPUT', 400); return value; };
const boundedNumber = (value, min, max) => { if (!Number.isSafeInteger(value) || value < min || value > max) reject('INVALID_INPUT', 400); return value; };
const reject = (code, status = 409, details) => { throw new V2BrokerError(code, code, status, details); };
const only = (body, allowed) => { if (!body || typeof body !== 'object' || Array.isArray(body)) reject('INVALID_INPUT', 400); if (Object.keys(body).some(key => !allowed.includes(key))) reject('UNKNOWN_FIELD', 400); id(body.operationId); };
const publicOnly = value => Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')));
const notice = (ctx, w, kind, entry, text) => {
  ctx.changes.notices ??= [];
  ctx.changes.notices.push({ id: uid('notice'), roomId: w.roomId, workId: w.id, kind, at: ctx.now, timelineItemId: entry?.id ?? null, previewText: [...text].slice(0, 160).join('') });
};

/** Work is independent of an ordinary delivery's awaiting-final slot. */
export class WorkCoordinator {
  constructor(broker, { clock = Date.now, transport = null, codexReceiveMode = 'unverified', claudeReceiveMode = 'next_step', codexReceiveModeProvider = null } = {}) {
    if (!receiveModes.has(codexReceiveMode) || !receiveModes.has(claudeReceiveMode)) reject('INVALID_RECEIVE_MODE', 400);
    if (codexReceiveModeProvider !== null && typeof codexReceiveModeProvider !== 'function') reject('INVALID_RECEIVE_MODE', 400);
    this.broker = broker; this.clock = clock; this.transport = transport;
    this.runtimeDir = broker.runtimeDir;
    this.receiveModes = { codex: codexReceiveMode, claude: claudeReceiveMode };
    this.codexReceiveModeProvider = codexReceiveModeProvider;
    this.timers = new Map(); this.attentionTimers = new Map(); this.flushing = new Map(); this.nativeAborts = new Set(); this.closed = false;
  }
  static async attach(broker, options = {}) {
    const self = new WorkCoordinator(broker, options);
    await broker.store.tx(async sql => {
      await sql.run('CREATE UNIQUE INDEX IF NOT EXISTS work_one_held ON work_sessions(room_id) WHERE occupancy=\'held\'');
      await sql.run('CREATE UNIQUE INDEX IF NOT EXISTS work_number_unique ON work_requests(work_id,request_number)');
      await sql.run('CREATE INDEX IF NOT EXISTS work_requests_work_state ON work_requests(work_id,state,wait_disposition)');
      await sql.run("CREATE INDEX IF NOT EXISTS work_request_wait_due ON work_requests(room_id,wait_disposition,state,json_extract(data_json,'$.waitingSince'))");
      await sql.run("CREATE INDEX IF NOT EXISTS work_responses_queue ON work_requests(json_extract(data_json,'$._fromBindingId'),json_extract(data_json,'$._responseState'))");
      // Restart never replays a possibly written native message.
      const rows = await sql.all("SELECT * FROM work_requests WHERE state='claimed' OR json_extract(data_json,'$._responseState')='claimed'");
      for (const row of rows) {
        const r = parse(row);
        if (r._nativeAttempt && r.requestState === 'claimed') r.requestState = 'uncertain';
        if (r._responseNativeAttempt && r._responseState === 'claimed') r._responseState = 'uncertain';
        await self.saveRequest({ sql }, r);
      }
    });
    broker.registerWorkHooks({
      onStop: ctx => self.stopWork(ctx, 'stopped'),
      onBindingLeave: (ctx, binding) => self.stopWork(ctx, 'stopped', binding.id),
      projectControl: (roomId, control, { sql }) => self.projectControl(sql, roomId, control),
      projectMember: (roomId, member, { sql }) => self.projectMember(sql, roomId, member),
      projectTimeline: (roomId, entry, { sql }) => self.projectTimeline(sql, roomId, entry),
      attention: (roomId, items, { sql, after, limit }) => self.attention(sql, roomId, items, { after, limit }),
      countAttention: ctx => self.attentionCount(ctx.sql, ctx.room.id),
      effects: (ctx, effects, filter) => self.effects(ctx.sql, ctx.room.id, effects, filter),
      onWaitChanged: (roomId, bindingId, info) => self.waitChanged(roomId, bindingId, info),
      nextNotification: args => self.nextNotification(args),
    });
    const held = await broker.store.read(sql => sql.all("SELECT * FROM work_sessions WHERE occupancy='held'"));
    for (const row of held) { self.armExpiry(parse(row)); await self.scheduleAttention(row.room_id); }
    self.onDelta = event => { void self.flushNative(event.roomId).catch(() => {}); void self.scheduleAttention(event.roomId).catch(() => {}); };
    broker.on('room.delta', self.onDelta);
    await broker.refreshDueAttention();
    return self;
  }
  async load(sql, roomId, workId) {
    const row = await sql.get('SELECT * FROM work_sessions WHERE id=? AND room_id=?', [id(workId), id(roomId)]);
    if (!row) reject('WORK_NOT_FOUND', 404); return parse(row);
  }
  async current(sql, roomId) { return parse(await sql.get("SELECT * FROM work_sessions WHERE room_id=? AND occupancy='held'", [roomId])); }
  async request(sql, w, requestId) {
    const row = await sql.get('SELECT * FROM work_requests WHERE id=? AND work_id=? AND room_id=?', [id(requestId), w.id, w.roomId]);
    if (!row) reject('REQUEST_NOT_FOUND', 404); return parse(row);
  }
  participant(w, bindingId) { const p = w.participants.find(p => p.bindingId === bindingId); if (!p) reject('FORBIDDEN', 403); return p; }
  async requireActive(ctx, w, bindingId = null) {
    if (!active(w) || w.occupancy !== 'held' || Date.parse(w.expiresAt) <= this.clock()) reject('WORK_NOT_ACTIVE');
    if (ctx.room.lifecycle !== 'open' || ctx.room.stopped_at || ctx.room.gate_segment_id !== w.segmentId) reject('ROOM_STOPPED');
    for (const p of w.participants) {
      const b = await ctx.getBinding(p.bindingId);
      if (!b || !b.current || b.native_session_id !== p.nativeSessionId) reject('BINDING_CHANGED');
      if (bindingId === p.bindingId && p.agent === 'claude' && Date.parse(b.deadline_at) <= this.clock()) reject('WAIT_EXPIRED');
    }
  }
  async saveWork(ctx, w) {
    w.version++;
    w.requestBudget.remaining = w.requestBudget.limit - w.requestBudget.used;
    w.wakeBudget.remaining = w.wakeBudget.limit - w.wakeBudget.used;
    if (active(w)) {
      w.pauseReasons = [w.requestBudget.remaining <= 0 ? 'request_budget' : null, w.wakeBudget.remaining <= 0 ? 'wake_budget' : null].filter(Boolean);
      w.coordinationState = w.pauseReasons.length ? 'paused_budget' : 'active';
    }
    w._possibleRunningAgents = (await this.summary(ctx.sql, w)).possibleRunningAgents;
    await ctx.sql.run(`INSERT INTO work_sessions(id,room_id,segment_id,version,occupancy,state,expires_at,binding_codex,binding_claude,data_json)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,occupancy=excluded.occupancy,state=excluded.state,expires_at=excluded.expires_at,data_json=excluded.data_json`,
    [w.id,w.roomId,w.segmentId,w.version,w.occupancy,w.coordinationState,w.expiresAt,w.participants[0].bindingId,w.participants[1].bindingId,json(w)]);
    ctx.changes && (ctx.changes.catalog = true);
  }
  async saveRequest(ctx, r) {
    r.requestVersion++;
    await ctx.sql.run(`INSERT INTO work_requests(id,room_id,work_id,to_binding_id,state,wait_disposition,claim_id,request_number,timeline_id,version,data_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,wait_disposition=excluded.wait_disposition,claim_id=excluded.claim_id,version=excluded.version,data_json=excluded.data_json`,
    [r.requestId,r._roomId,r.workId,r._toBindingId,r.requestState,r.waitDisposition,r._claimId,r.requestNumber,r._timelineId,r.requestVersion,json(r)]);
    for (const itemId of [r._timelineId, r._responseTimelineId].filter(Boolean)) {
      await ctx.sql.run('UPDATE timeline SET version=version+1 WHERE id=? AND room_id=?', [itemId, r._roomId]);
      ctx.changes?.entries.push(itemId);
    }
  }
  async summary(sql, w) {
    const result = structuredClone(publicOnly(w));
    const running = new Set(w.participants.filter(p => p.acceptance === 'accepted' && !['completed', 'stopped'].includes(p.workState)).map(p => p.agent));
    result.pendingRequestCount = (await sql.get("SELECT COUNT(*) AS n FROM work_requests WHERE work_id=? AND wait_disposition!='abandoned' AND (state IN ('queued','notified','claimed','awaiting_response','uncertain') OR json_extract(data_json,'$._responseState') IN ('queued','notified','claimed','uncertain'))", [w.id])).n;
    const requestRunning = await sql.all("SELECT DISTINCT json_extract(data_json,'$.recipient') AS agent FROM work_requests WHERE work_id=? AND state IN ('claimed','awaiting_response','uncertain')", [w.id]);
    const responseRunning = await sql.all("SELECT DISTINCT json_extract(data_json,'$.author') AS agent FROM work_requests WHERE work_id=? AND json_extract(data_json,'$._responseState') IN ('claimed','uncertain')", [w.id]);
    for (const row of [...requestRunning,...responseRunning]) running.add(row.agent);
    const kickoff = await sql.all("SELECT agent FROM deliveries WHERE work_id=? AND final_reply_id IS NULL AND (write_started=1 OR state IN ('dispatching','awaiting_reply','uncertain'))", [w.id]);
    for (const row of kickoff) running.add(row.agent);
    result.possibleRunningAgents = agents.filter(a => running.has(a));
    result.needsHumanCount = w.participants.filter(p => p.workState === 'blocked').length;
    const ended = !active(w) || w.occupancy !== 'held' || Date.parse(w.expiresAt) <= this.clock();
    result.timeBudget = {
      limitSeconds: Math.round((Date.parse(w.expiresAt) - Date.parse(w.startedAt)) / 1000),
      remainingSeconds: Math.max(0, Math.ceil((Date.parse(w.expiresAt) - this.clock()) / 1000)),
      maxSeconds: MAX_WORK_SECONDS, maxAddSeconds: MAX_ADD_SECONDS
    };
    result.actions = {
      addBudget: availability(ended ? 'WORK_NOT_ACTIVE' : null),
      addTime: availability(ended ? 'WORK_NOT_ACTIVE' : result.timeBudget.limitSeconds >= MAX_WORK_SECONDS ? 'WORK_TIME_LIMIT' : null),
      release: availability(w.occupancy === 'released' ? 'WORK_RELEASED' : ['stopped','expired','completed'].includes(w.coordinationState) ? null : 'WORK_MUST_BE_STOPPED_FIRST')
    };
    for (const p of result.participants) {
      p.receiveMode = this.receiveModes[p.agent];
      const b = await sql.get('SELECT deadline_at FROM bindings WHERE id=?', [p.bindingId]);
      p.leaseDeadlineAt = b?.deadline_at ?? null;
      if (ended || (p.agent === 'claude' && Date.parse(p.leaseDeadlineAt) <= this.clock())) { p.inboxWait = p.agent === 'claude' ? 'not_armed' : null; p.inboxWaitAt = null; }
    }
    if (Buffer.byteLength(json(result)) > 8192) reject('WORK_SUMMARY_TOO_LARGE', 413);
    return result;
  }
  async get(roomId, workId) { return this.broker.store.read(async sql => this.summary(sql, await this.load(sql, roomId, workId))); }
  async agentStatus(roomId,workId,bindingId){return this.broker.store.read(async sql=>{
    const w=await this.load(sql,roomId,workId);this.participant(w,bindingId);
    const authorizedScope=await workAuthorization(sql,roomId,workId,{includeText:true});
    return {workId,work:await this.summary(sql,w),mode:'work',authorizedScope:{...authorizedScope,attachments:await this.attachmentManifest(sql,roomId,authorizedScope.attachmentIds)}};
  });}
  async start(roomId, body) {
    only(body, ['operationId','expectedGate','expectedBindings','text','attachmentIds','objective','requestLimit','wakeLimit','durationSeconds']);
    safeText(body.objective, 240); safeText(body.text);
    if (!body.expectedBindings || typeof body.expectedBindings !== 'object' || Array.isArray(body.expectedBindings) || Object.keys(body.expectedBindings).length !== 2 || !agents.every(a => typeof body.expectedBindings[a] === 'string')) reject('INVALID_INPUT', 400);
    if (!body.objective.trim() || !body.text.trim()) reject('INVALID_INPUT', 400);
    boundedNumber(body.requestLimit, 1, 10000); boundedNumber(body.wakeLimit, 0, 10000); boundedNumber(body.durationSeconds, 60, 36000);
    const result = await this.broker.mutate('work.start', roomId, body, ctx => this.startTx(ctx,roomId,body));
    this.armExpiry(result.work); return result;
  }
  confirmStart(roomId,bindingId,body) { return confirmStart(this,roomId,bindingId,body); }
  startContext(roomId,bindingId) { return startContext(this,roomId,bindingId); }
  async startTx(ctx,roomId,body,{sourceMessageId=null,authority=null,planText=null}={}) {
      const old = await this.current(ctx.sql, roomId);
      if (old) reject('WORK_IN_PROGRESS', 409, { workId: old.id, objective: old.objective, timelineItemId: old._startTimelineId, aroundCursor: old._aroundCursor ?? null });
      const participants = [];
      for (const agent of agents) {
        const b = await ctx.sql.get('SELECT * FROM bindings WHERE room_id=? AND agent=? AND current=1', [roomId,agent]);
        if (!b || body.expectedBindings?.[agent] !== b.id) reject('BINDING_CHANGED');
        participants.push({ agent, bindingId:b.id, nativeSessionId:b.native_session_id,version:1,acceptance:'pending',acceptanceReplyId:null,workState:'not_started',stateReportedAt:null,lastCheckpointAt:null,receiveMode:this.receiveModes[agent],inboxWait:agent==='claude'?'not_armed':null,inboxWaitAt:null,leaseDeadlineAt:b.deadline_at });
      }
      const source = sourceMessageId ? {messageId:sourceMessageId,deliveryIds:{},gate:{segmentId:ctx.room.gate_segment_id,version:ctx.room.gate_version}}
        : await ctx.addHumanMessage({ text:body.text,attachmentIds:body.attachmentIds,recipients:agents });
      if(sourceMessageId) for(const agent of agents) source.deliveryIds[agent]=(await ctx.addDelivery({agent,text:body.text,attachmentIds:body.attachmentIds,messageId:sourceMessageId})).id;
      const w = { id:uid('work'),roomId,version:0,segmentId:source.gate.segmentId,sourceHumanMessageId:source.messageId,objective:body.objective,scopeSummary:'Only the user-authorized task in the selected native conversations',startedAt:ctx.now,expiresAt:new Date(Date.parse(ctx.now)+body.durationSeconds*1000).toISOString(),coordinationState:'active',pauseReasons:[],occupancy:'held',requestBudget:{limit:body.requestLimit,used:0,remaining:body.requestLimit},wakeBudget:{limit:body.wakeLimit,used:0,remaining:body.wakeLimit},participants,pendingRequestCount:0,needsHumanCount:0,possibleRunningAgents:[],actions:{},_nextRequestNumber:1,_kickoff:source.deliveryIds,_notifications:{},_progress:{} };
      w.authority=authority??{kind:'human_kickoff',sourceHumanMessageId:source.messageId,confirmations:[]};
      if(planText)w._planText=planText;
      for (const deliveryId of Object.values(source.deliveryIds)) await ctx.sql.run('UPDATE deliveries SET work_id=? WHERE id=?', [w.id,deliveryId]);
      const entry = await this.event(ctx,w,'started','ryan',await ctx.createContent(body.objective,'plain'),{authority:w.authority});
      w._startTimelineId = entry.id; w._aroundCursor = await this.around(ctx.sql, roomId, entry.id);
      await this.saveWork(ctx,w);
      return { sourceHumanMessageId:source.messageId,work:await this.summary(ctx.sql,w),gate:source.gate };
  }
  async budget(roomId, workId, body) {
    only(body,['operationId','expectedGate','expectedWorkVersion','addRequests','addWakes','addSeconds']);
    const addRequests = body.addRequests === undefined ? 0 : body.addRequests,
      addWakes = body.addWakes === undefined ? 0 : body.addWakes,
      addSeconds = body.addSeconds === undefined ? 0 : body.addSeconds;
    boundedNumber(addRequests,0,10000); boundedNumber(addWakes,0,10000); boundedNumber(addSeconds,0,MAX_ADD_SECONDS);
    if (!addRequests && !addWakes && !addSeconds) reject('INVALID_INPUT',400);
    const result = await this.broker.mutate(`work.budget:${workId}`,roomId,body,async ctx=>{
      const w=await this.load(ctx.sql,roomId,workId); await this.requireActive(ctx,w);
      if(w.version!==body.expectedWorkVersion) reject('WORK_CHANGED');
      boundedNumber(w.requestBudget.limit+addRequests,1,10000); boundedNumber(w.wakeBudget.limit+addWakes,0,10000);
      if (addSeconds && Date.parse(w.expiresAt) + addSeconds * 1000 > Date.parse(w.startedAt) + MAX_WORK_SECONDS * 1000) reject('WORK_TIME_LIMIT');
      w.requestBudget.limit+=addRequests; w.wakeBudget.limit+=addWakes;
      if (addSeconds) w.expiresAt = new Date(Date.parse(w.expiresAt) + addSeconds * 1000).toISOString();
      const text = addSeconds ? `Added ${addRequests} requests, ${addWakes} wakes and ${addSeconds} seconds; ends at ${w.expiresAt}`
        : `Added ${addRequests} requests and ${addWakes} wakes`;
      await this.event(ctx,w,'budget_changed','ryan',await ctx.createContent(text),{addRequests,addWakes,addSeconds,expiresAt:w.expiresAt});
      await this.saveWork(ctx,w); return {work:await this.summary(ctx.sql,w)};
    });
    // Reschedule even after an idempotent retry: the stored expiry is authoritative.
    this.armExpiry(await this.get(roomId, workId)); return result;
  }
  async release(roomId,workId,body) {
    only(body,['operationId','expectedGate','expectedWorkVersion','acknowledgePossibleRunning']);
    return this.broker.mutate(`work.release:${workId}`,roomId,body,async ctx=>{
      const w=await this.load(ctx.sql,roomId,workId);
      if(w.version!==body.expectedWorkVersion) reject('WORK_CHANGED');
      if(!['stopped','expired','completed'].includes(w.coordinationState)) reject('WORK_MUST_BE_STOPPED_FIRST');
      if(body.acknowledgePossibleRunning!==true) reject('DUPLICATE_ACK_REQUIRED');
      w.occupancy='released'; await this.event(ctx,w,'released','ryan',null); await this.saveWork(ctx,w);
      const summary=await this.summary(ctx.sql,w); return {work:summary,effects:{possibleRunningAgents:summary.possibleRunningAgents,nativeCancellationSupported:false}};
    });
  }
  async event(ctx,w,eventKind,author,content,extra={}) {
    const data={workId:w.id,eventKind,author,recipient:null,requestId:null,requestVersion:null,requestNumber:null,resendOfRequestId:null,requestKind:null,requestState:null,waitDisposition:null,abandonedAt:null,receivedAt:null,waitingSince:null,actions:null,content,attachmentIds:[],references:[],responseDelivery:null,replyTo:null,lateReason:null,...extra};
    return ctx.addTimeline('work',{segmentId:w.segmentId,data});
  }
  requestPublic(w,r) {
    const value=publicOnly(r);
    delete value.finalReplyId;
    value.deliveryBlockedReason=r.requestState==='queued'&&!['stopped','expired','completed'].includes(w.coordinationState)?r._routingBlockedReason??null:null;
    value.references??=[];value.responseDelivery=null;
    const final=Boolean(r.finalReplyId), stopped=!active(w)||w.occupancy!=='held'||Date.parse(w.expiresAt)<=this.clock();
    value.actions={abandon:availability(final?'FINAL_ALREADY_PRESENT':r.waitDisposition==='waiting'&&['claimed','awaiting_response','uncertain'].includes(r.requestState)?null:'REQUEST_NOT_WAITING'),resend:availability(final?'FINAL_ALREADY_PRESENT':stopped?'WORK_NOT_ACTIVE':w.requestBudget.remaining<=0?'REQUEST_BUDGET_EXHAUSTED':(['failed','uncertain'].includes(r.requestState)||r.waitDisposition==='abandoned')?null:'AWAITING_RESPONSE')};
    return value;
  }
  async newRequest(ctx,w,p,body,resendOf=null) {
    const target=w.participants.find(other=>other.bindingId===body.toBindingId&&other.bindingId!==p.bindingId);
    if(!target||!['handoff','review_request','blocker'].includes(body.kind)) reject('INVALID_INPUT',400);
    if(w.requestBudget.used>=w.requestBudget.limit) reject('REQUEST_BUDGET_EXHAUSTED');
    safeText(body.text); const attachmentIds=await this.checkAttachments(ctx.sql,w.roomId,body.attachmentIds??[]);
    if(!body.text.trim()&&!attachmentIds.length) reject('INVALID_INPUT',400);
    if(body.parentRequestId) await this.request(ctx.sql,w,body.parentRequestId);
    if(body.reviewRef && (typeof body.reviewRef!=='object'||Buffer.byteLength(json(body.reviewRef))>4096)) reject('INVALID_INPUT',400);
    const content=await ctx.createContent(body.text,'markdown');
    const r={workId:w.id,eventKind:'request',author:p.agent,recipient:target.agent,requestId:uid('request'),requestVersion:0,requestNumber:w._nextRequestNumber++,resendOfRequestId:resendOf,requestKind:body.kind,requestState:'queued',waitDisposition:'none',abandonedAt:null,receivedAt:null,waitingSince:null,actions:null,content,attachmentIds,replyTo:null,lateReason:null,finalReplyId:null,_roomId:w.roomId,_fromBindingId:p.bindingId,_toBindingId:target.bindingId,_claimId:null,_text:body.text,_attachmentIds:attachmentIds,_parentRequestId:body.parentRequestId??null,_reviewRef:body.reviewRef??null,_responseState:null};
    const e=await this.event(ctx,w,'request',p.agent,content,this.requestPublic(w,r)); r._timelineId=e.id;
    await this.saveRequest(ctx,r); w.requestBudget.used++; return r;
  }
  async checkAttachments(sql,roomId,attachmentIds){
    if(!Array.isArray(attachmentIds)||attachmentIds.length>20||new Set(attachmentIds).size!==attachmentIds.length)reject('INVALID_INPUT',400);
    for(const attachmentId of attachmentIds){id(attachmentId);if(!await sql.get('SELECT id FROM attachments WHERE id=? AND room_id=?',[attachmentId,roomId]))reject('ATTACHMENT_NOT_FOUND',404);}
    return attachmentIds;
  }
  async attachmentManifest(sql,roomId,attachmentIds){
    const items=[];
    for(const attachmentId of attachmentIds){
      const row=await sql.get('SELECT * FROM attachments WHERE id=? AND room_id=?',[attachmentId,roomId]);
      if(!row)reject('ATTACHMENT_NOT_FOUND',404);
      const metadata={id:row.id,name:row.name,mediaType:row.media_type,bytes:row.bytes,sha256:row.sha256,relativePath:row.relative_path,previewAvailable:Boolean(row.preview_available)};
      await readAttachmentBytes(this.runtimeDir,metadata);
      items.push({id:row.id,path:join(this.runtimeDir,row.relative_path),sha256:row.sha256});
    }
    return items;
  }
  async deliveryContent(sql,roomId,r,isResponse){
    const fullText=isResponse?r._responseText:r._text;
    const content=isResponse?r._responseContent:r.content;
    const tooLarge=[...fullText].length>32000||Buffer.byteLength(json(fullText))>64*1024;
    if(tooLarge&&!content?.attachmentId)reject('CONTENT_TOO_LARGE',413);
    const attachmentIds=[...new Set([...(isResponse?r._responseAttachmentIds:r._attachmentIds),...(tooLarge?[content.attachmentId]:[])])];
    const attachments=await this.attachmentManifest(sql,roomId,attachmentIds);
    const text=tooLarge?`${content.previewText}\n\n[Preview only. Read the complete verified attachment ${content.attachmentId} before handling this request.]`:fullText;
    return {text,attachmentIds,attachments,fullTextAttachmentId:tooLarge?content.attachmentId:null};
  }
  async requests(roomId,workId,{limit=20,cursor}={}) {
    boundedNumber(limit,1,20);
    let after=0;
    if(cursor){try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString());if(c.workId!==workId||c.roomId!==roomId)throw 0;after=boundedNumber(c.after,0,Number.MAX_SAFE_INTEGER);}catch{reject('INVALID_CURSOR',400);}}
    return this.broker.store.read(async sql=>{
      const w=await this.load(sql,roomId,workId),rows=await sql.all('SELECT * FROM work_requests WHERE work_id=? AND request_number>? ORDER BY request_number LIMIT ?',[workId,after,limit+1]);
      const items=rows.slice(0,limit).map(row=>({request:this.requestPublic(w,parse(row)),timelineItemId:row.timeline_id}));
      return {roomId,workId,items,nextCursor:rows.length>limit?Buffer.from(json({roomId,workId,after:rows[limit-1].request_number})).toString('base64url'):null};
    });
  }
  async abandon(roomId,workId,requestId,body) {
    only(body,['operationId','expectedRequestVersion']);
    return this.broker.mutate(`work.abandon:${workId}:${requestId}`,roomId,body,async ctx=>{
      const w=await this.load(ctx.sql,roomId,workId),r=await this.request(ctx.sql,w,requestId);
      if(r.requestVersion!==body.expectedRequestVersion) reject('REQUEST_CHANGED');
      const action=this.requestPublic(w,r).actions.abandon;if(!action.enabled)reject(action.reason);
      r.waitDisposition='abandoned';r.abandonedAt=ctx.now;await this.saveRequest(ctx,r);await this.saveWork(ctx,w);
      return {workId,request:this.requestPublic(w,r)};
    },{gate:false});
  }
  async resend(roomId,workId,requestId,body) {
    only(body,['operationId','expectedGate','expectedRequestVersion','acknowledgeDuplicateRisk']);
    return this.broker.mutate(`work.resend:${workId}:${requestId}`,roomId,body,async ctx=>{
      const w=await this.load(ctx.sql,roomId,workId);await this.requireActive(ctx,w);
      const old=await this.request(ctx.sql,w,requestId);if(old.requestVersion!==body.expectedRequestVersion)reject('REQUEST_CHANGED');
      const action=this.requestPublic(w,old).actions.resend;if(!action.enabled)reject(action.reason);
      if(body.acknowledgeDuplicateRisk!==true)reject('DUPLICATE_ACK_REQUIRED');
      old.waitDisposition='abandoned';old.abandonedAt??=ctx.now;await this.saveRequest(ctx,old);
      const r=await this.newRequest(ctx,w,this.participant(w,old._fromBindingId),{toBindingId:old._toBindingId,kind:old.requestKind,text:old._text,attachmentIds:old._attachmentIds,parentRequestId:old._parentRequestId,reviewRef:old._reviewRef},old.requestId);
      await this.saveWork(ctx,w);return {workId,previousRequest:this.requestPublic(w,old),request:this.requestPublic(w,r)};
    });
  }
  async agent(method,roomId,workId,bindingId,body) {
    const keys={accept:['deliveryId','claimId','text','accept'],progress:['text','references'],requests:['toBindingId','kind','text','attachmentIds','parentRequestId','reviewRef'],checkpoint:['requestId'],received:['requestId','claimId'],responses:['requestId','claimId','text','attachmentIds'],state:['expectedParticipantVersion','workState','text','references']};
    if(!keys[method])reject('NOT_FOUND',404);only(body,['operationId',...keys[method]]);
    return this.broker.mutate(`work.agent.${method}:${workId}:${bindingId}`,roomId,body,async ctx=>{
      const w=await this.load(ctx.sql,roomId,workId),p=this.participant(w,bindingId);
      if(!['responses','received','state'].includes(method))await this.requireActive(ctx,w,bindingId);
      let result;
      if(method==='accept'){
        if(typeof body.accept!=='boolean'||w._kickoff[p.agent]!==body.deliveryId)reject('INVALID_INPUT',400);
        if(p.acceptance!=='pending')reject('ACCEPTANCE_ALREADY_PRESENT');safeText(body.text,2000);
        const final=await ctx.addReply({bindingId,deliveryId:body.deliveryId,claimId:body.claimId,text:body.text,attachmentIds:[],done:false,workAcceptance:true});
        p.acceptance=body.accept?'accepted':'declined';p.acceptanceReplyId=final.replyId;p.workState=body.accept?'working':'stopped';p.stateReportedAt=ctx.now;p.version++;
        await this.event(ctx,w,'accepted',p.agent,await ctx.createContent(body.text));result={replyId:final.replyId};
      }else if(method==='progress'){
        safeText(body.text,2000);if(body.references&&(!Array.isArray(body.references)||body.references.length>20||Buffer.byteLength(json(body.references))>4096))reject('INVALID_INPUT',400);
        const previous=w._progress[bindingId];
        if(previous&&(previous.text===body.text||Date.parse(ctx.now)-Date.parse(previous.at)<10000))reject('PROGRESS_RATE_LIMITED');
        const entry=await this.event(ctx,w,'progress',p.agent,await ctx.createContent(body.text),{references:body.references??[]});w._progress[bindingId]={at:ctx.now,text:body.text};result={timelineItemId:entry.id};
      }else if(method==='requests'){
        if(p.acceptance!=='accepted')reject('WORK_NOT_ACCEPTED');const r=await this.newRequest(ctx,w,p,body);result={requestId:r.requestId,requestVersion:r.requestVersion,requestNumber:r.requestNumber};
      }else if(method==='checkpoint'){
        p.lastCheckpointAt=ctx.now;p.version++;
        if(body.requestId)id(body.requestId);
        const rows=await ctx.sql.all(`SELECT * FROM work_requests WHERE work_id=? AND ((to_binding_id=? AND state IN ('queued','notified')) OR (json_extract(data_json,'$._fromBindingId')=? AND json_extract(data_json,'$._responseState') IN ('queued','notified','failed'))) ${body.requestId?'AND id=?':''} ORDER BY request_number LIMIT 3`,[w.id,bindingId,bindingId,...(body.requestId?[body.requestId]:[])]);
        const claimed=[];let claimedBytes=0;
        for(const row of rows){const r=parse(row);if(body.requestId&&r.requestId!==body.requestId)continue;const isResponse=r._fromBindingId===bindingId;
          const payload=await this.deliveryContent(ctx.sql,roomId,r,isResponse);
          const bytes=Buffer.byteLength(json(payload))+8192;if(claimedBytes+bytes>256*1024)break;claimedBytes+=bytes;
          r._routingBlockedReason=null;r._routingBlockedAt=null;
          if(isResponse){r._responseState='claimed';r._responseClaimId=uid('claim');r._responseReason=null;r._responseNativeAttempt=false;}else{r.requestState='claimed';r.waitDisposition='waiting';r.waitingSince??=ctx.now;r._claimId=uid('claim');r._nativeAttempt=false;}
          await this.saveRequest(ctx,r);claimed.push({kind:isResponse?'response':'request',roomId,workId,requestId:r.requestId,requestNumber:r.requestNumber,claimId:isResponse?r._responseClaimId:r._claimId,origin:isResponse?r.recipient:r.author,...payload,reviewRef:r._reviewRef??null});
        }
        delete w._notifications[bindingId];result={status:claimed.length?'DELIVERY':'EMPTY',items:claimed,mode:'work',authorizedScope:await workAuthorization(ctx.sql,roomId,workId)};
      }else if(method==='received'){
        const r=await this.request(ctx.sql,w,body.requestId);
        if(r._toBindingId===bindingId&&r._claimId&&r._claimId===body.claimId){r.receivedAt??=ctx.now;if(r.requestState==='claimed')r.requestState='awaiting_response';}
        else if(r._fromBindingId===bindingId&&r._responseClaimId&&r._responseClaimId===body.claimId){r._responseState='received';r._responseReceivedAt??=ctx.now;}
        else reject('CLAIM_REQUIRED',403);
        await this.saveRequest(ctx,r);result={requestId:r.requestId,receivedAt:r.receivedAt,responseReceivedAt:r._responseReceivedAt??null};
      }else if(method==='responses'){
        const r=await this.request(ctx.sql,w,body.requestId);
        if(r._toBindingId!==bindingId||!r._claimId||r._claimId!==body.claimId)reject('CLAIM_REQUIRED',403);
        safeText(body.text,4000000);const attachmentIds=await this.checkAttachments(ctx.sql,roomId,body.attachmentIds??[]);
        const finalHash=hash({claimId:body.claimId,text:body.text,attachmentIds});
        if(r.finalReplyId){if(r._finalHash!==finalHash)reject('FINAL_ALREADY_PRESENT');return{replyId:r.finalReplyId,requestId:r.requestId,lateReason:r._responseLateReason,duplicate:true,workId,work:await this.summary(ctx.sql,w)};}
        r._finalHash=finalHash;
        r.finalReplyId=uid('work-reply');r.requestState='answered';if(r.waitDisposition!=='abandoned')r.waitDisposition='resolved';
        const late=r.waitDisposition==='abandoned'?'abandoned':w.coordinationState==='expired'||Date.parse(w.expiresAt)<=this.clock()?'expired':!active(w)?'stopped':ctx.room.gate_segment_id!==w.segmentId?'binding_changed':null;
        r._responseText=body.text;r._responseAttachmentIds=attachmentIds;r._responseLateReason=late;r._responseState=late?'cancelled':'queued';r._responseAt=ctx.now;
        r._responseContent=await ctx.createContent(body.text,'markdown');
        const e=await this.event(ctx,w,'response',p.agent,r._responseContent,{recipient:r.author,requestId:r.requestId,requestVersion:r.requestVersion+1,requestNumber:r.requestNumber,attachmentIds,lateReason:late,replyTo:{itemId:r._timelineId,requestId:r.requestId,author:r.author,previewText:[...r._text].slice(0,40).join(''),timelineOrder:(await ctx.sql.get('SELECT order_num FROM timeline WHERE id=?',[r._timelineId])).order_num,aroundCursor:await this.around(ctx.sql,w.roomId,r._timelineId)}});
        r._responseTimelineId=e.id;await this.saveRequest(ctx,r);ctx.room.unread_reply_count++;result={replyId:r.finalReplyId,requestId:r.requestId,lateReason:late,duplicate:false};
      }else if(method==='state'){
        if(!['not_started','working','awaiting_review','blocked','completed','stopped','unknown'].includes(body.workState))reject('INVALID_INPUT',400);
        if(p.acceptance!=='accepted')reject('WORK_NOT_ACCEPTED');
        if(!active(w)&&!['completed','stopped'].includes(body.workState))reject('WORK_NOT_ACTIVE');
        if(active(w)&&!['completed','stopped'].includes(body.workState))await this.requireActive(ctx,w,bindingId);
        if(p.version!==body.expectedParticipantVersion)reject('PARTICIPANT_CHANGED');safeText(body.text??'',2000);
        if(body.references&&(!Array.isArray(body.references)||body.references.length>20||Buffer.byteLength(json(body.references))>4096))reject('INVALID_INPUT',400);
        const old=p.workState;p.workState=body.workState;p.stateReportedAt=ctx.now;p.version++;
        const e=await this.event(ctx,w,'participant_state',p.agent,await ctx.createContent(body.text??''),{workState:p.workState,references:body.references??[]});
        if(old!=='completed'&&p.workState==='completed')ctx.room.unread_reply_count++;
        if(old!=='blocked'&&p.workState==='blocked')notice(ctx,w,'work_blocked',e,body.text||w.objective);
        result={participant:structuredClone(p)};
      }
      await this.maybeComplete(ctx,w);await this.saveWork(ctx,w);return {...result,workId,work:await this.summary(ctx.sql,w)};
    },{gate:false});
  }
  async around(sql,roomId,itemId){const t=await sql.get('SELECT order_num FROM timeline WHERE id=? AND room_id=?',[itemId,roomId]);return t?Buffer.from(json({v:1,workspaceId:this.broker.workspaceId,roomId,direction:'around',order:t.order_num})).toString('base64url'):null;}
  async maybeComplete(ctx,w){
    if(!active(w)||Date.parse(w.expiresAt)<=this.clock()||!w.participants.every(p=>p.acceptance==='accepted'&&p.workState==='completed'))return;
    const remaining=await ctx.sql.get("SELECT COUNT(*) AS count FROM work_requests WHERE work_id=? AND (state NOT IN ('answered','failed','cancelled') OR json_extract(data_json,'$._responseState') IN ('queued','notified','claimed','uncertain','failed'))",[w.id]);
    if(remaining.count)return;w.coordinationState='completed';w.occupancy='released';w.pauseReasons=[];
    const e=await this.event(ctx,w,'ended','system',null);notice(ctx,w,'work_completed',e,w.objective);this.clearExpiry(w.id);
  }
  async stopWork(ctx,state,bindingId=null){
    const w=await this.current(ctx.sql,ctx.room.id);if(!w||!active(w)||(bindingId&&!w.participants.some(p=>p.bindingId===bindingId)))return;
    w.coordinationState=state;w.pauseReasons=[];w._notifications={};
    for(const p of w.participants){p.inboxWait=p.agent==='claude'?'not_armed':null;p.inboxWaitAt=null;p.version++;}
    const rows=await ctx.sql.all("SELECT * FROM work_requests WHERE work_id=? AND (state IN ('queued','notified') OR json_extract(data_json,'$._responseState') IN ('queued','notified'))",[w.id]);
    for(const row of rows){const r=parse(row);if(['queued','notified'].includes(r.requestState)){r.requestState='cancelled';r.waitDisposition='resolved';}if(['queued','notified'].includes(r._responseState))r._responseState='cancelled';await this.saveRequest(ctx,r);}
    await this.event(ctx,w,'ended','system',await ctx.createContent(state==='expired'?'The collaboration authorization has expired':'Collaboration communication has stopped'));
    await this.saveWork(ctx,w);this.clearExpiry(w.id);
  }
  clearExpiry(workId){clearTimeout(this.timers.get(workId));this.timers.delete(workId);}
  async scheduleAttention(roomId){
    if(this.closed)return;
    const cutoff=new Date(this.clock()-30*60*1000).toISOString();
    const next=await this.broker.store.read(sql=>sql.get(`SELECT MIN(json_extract(r.data_json,'$.waitingSince')) AS since FROM work_requests r JOIN work_sessions w ON w.id=r.work_id JOIN rooms g ON g.id=r.room_id WHERE r.room_id=? AND w.occupancy='held' AND g.lifecycle='open' AND r.wait_disposition='waiting' AND r.state IN ('claimed','awaiting_response') AND json_extract(r.data_json,'$.waitingSince')>?`,[roomId,cutoff]));
    if(this.closed)return;clearTimeout(this.attentionTimers.get(roomId));this.attentionTimers.delete(roomId);
    if(!next?.since)return;
    const timer=setTimeout(()=>{this.attentionTimers.delete(roomId);if(!this.closed)void this.broker.mutate('work.attentionTick',roomId,{operationId:uid('op')},async()=>({}),{gate:false}).catch(()=>{});},Math.max(1,Date.parse(next.since)+30*60*1000-this.clock()));
    timer.unref?.();this.attentionTimers.set(roomId,timer);
  }
  armExpiry(w){
    if(!active(w)||w.occupancy!=='held')return;
    this.clearExpiry(w.id);
    const timer=setTimeout(()=>{void this.expireAt(w).catch(()=>{});},Math.max(1,Date.parse(w.expiresAt)-this.clock()));
    timer.unref?.();this.timers.set(w.id,timer);
  }
  async expireAt(expected){
    return this.broker.mutate(`work.expire:${expected.id}`,expected.roomId,
      {operationId:`expiry-${expected.id}-${hash(expected.expiresAt).slice(0,12)}`},async ctx=>{
        const w=await this.load(ctx.sql,expected.roomId,expected.id);
        if(w.expiresAt!==expected.expiresAt||Date.parse(w.expiresAt)>this.clock()||!active(w)||w.occupancy!=='held')return{};
        return this.stopWork(ctx,'expired');
      },{gate:false});
  }
  async waitChanged(roomId,bindingId,info){
    const exists=await this.broker.store.read(sql=>this.current(sql,roomId));if(!exists||!exists.participants.some(p=>p.bindingId===bindingId)||!active(exists))return;
    return this.broker.mutate('work.waitEvidence',roomId,{operationId:uid('op')},async ctx=>{
      const w=await this.current(ctx.sql,roomId);if(!w||!active(w))return{};const p=this.participant(w,bindingId);if(p.agent!=='claude')return{};
      p.inboxWait=info.workId===w.id&&info.notificationScopes?.includes('work')&&['armed','notified','rearming'].includes(info.state)?info.state:'not_armed';p.inboxWaitAt=p.inboxWait==='not_armed'?null:info.at;p.version++;await this.saveWork(ctx,w);return{};
    },{gate:false});
  }
  async nextNotification({roomId,bindingId,notificationScopes,workId}){
    if(!notificationScopes.includes('work')||!workId)return null;
    const candidate=await this.broker.store.read(async sql=>{const w=await this.load(sql,roomId,workId);if(!active(w)||w.wakeBudget.remaining<=0||Date.parse(w.expiresAt)<=this.clock())return null;if(w._notifications[bindingId])return w._notifications[bindingId];const r=await sql.get("SELECT id FROM work_requests WHERE work_id=? AND ((to_binding_id=? AND state='queued') OR (json_extract(data_json,'$._fromBindingId')=? AND json_extract(data_json,'$._responseState')='queued')) LIMIT 1",[workId,bindingId,bindingId]);return r?{queued:true}:null;});
    if(!candidate)return null;if(!candidate.queued)return candidate;
    const result=await this.broker.mutate(`work.notify:${workId}:${bindingId}`,roomId,{operationId:uid('op')},async ctx=>{
      const w=await this.load(ctx.sql,roomId,workId);await this.requireActive(ctx,w,bindingId);if(w._notifications[bindingId])return{notification:w._notifications[bindingId]};if(w.wakeBudget.remaining<=0)return{notification:null};
      const rows=await ctx.sql.all("SELECT * FROM work_requests WHERE work_id=? AND ((to_binding_id=? AND state='queued') OR (json_extract(data_json,'$._fromBindingId')=? AND json_extract(data_json,'$._responseState')='queued')) ORDER BY request_number LIMIT 3",[workId,bindingId,bindingId]);if(!rows.length)return{notification:null};
      const notification={status:'NEW',notificationId:uid('work-notice'),roomId,workId,requestIds:rows.map(r=>r.id)};
      for(const row of rows){const r=parse(row);if(r._fromBindingId===bindingId)r._responseState='notified';else{r.requestState='notified';r.waitDisposition='waiting';r.waitingSince??=ctx.now;}await this.saveRequest(ctx,r);}
      w.wakeBudget.used++;w._notifications[bindingId]=notification;await this.saveWork(ctx,w);return{notification};
    },{gate:false});return result.notification;
  }
  async effects(sql,roomId,effects,{where='1=1',params=[]}={}){
    const rows=await sql.all("SELECT * FROM work_sessions WHERE room_id=? AND (occupancy='held' OR json_array_length(json_extract(data_json,'$._possibleRunningAgents'))>0)",[roomId]);
    const running=new Set(effects.possibleRunningAgents??[]);
    for(const row of rows){const w=parse(row);if(where.includes('segment_id')&&w.segmentId!==params[0])continue;if(where.includes('binding_id')&&!w.participants.some(p=>p.bindingId===params[0]))continue;for(const agent of (await this.summary(sql,w)).possibleRunningAgents)running.add(agent);}
    return {...effects,possibleRunningAgents:agents.filter(a=>running.has(a)),possibleRunningCount:Math.max(effects.possibleRunningCount??0,running.size)};
  }
  async projectControl(sql,roomId,control){const w=await this.current(sql,roomId);control.currentWork=w?await this.summary(sql,w):null;control.pendingKickoff=await pendingKickoff(sql,await sql.get('SELECT * FROM rooms WHERE id=?',[roomId]));const effects=await this.effects(sql,roomId,control);control.possibleRunningCount=effects.possibleRunningCount;control.possibleRunningAgents=effects.possibleRunningAgents;return control;}
  async projectMember(sql,roomId,member){
    member.canReceiveCollaboration=false;member.collaborationReceiveMode='unverified';member.collaborationEvidenceAt=null;member.workInboxActive=false;
    const w=await this.current(sql,roomId);if(!w||!member.binding)return member;const p=w.participants.find(p=>p.bindingId===member.binding.id);if(!p)return member;
    if(p.acceptance==='accepted'&&!['completed','stopped'].includes(p.workState)&&!['recovery_required','disconnected'].includes(member.state))member.state='busy';
    if(!active(w)||Date.parse(w.expiresAt)<=this.clock()){member.collaborationReceiveMode='unavailable';return member;}
    member.workInboxActive=true;
    const armed=['armed','rearming'].includes(member.wait?.state)&&member.wait.workId===w.id&&member.wait.notificationScopes?.includes('work')&&Date.parse(member.wait.deadlineAt)>this.clock();
    const blocked=p.agent==='codex'?await sql.get("SELECT id FROM work_requests WHERE work_id=? AND json_extract(data_json,'$._routingBlockedReason')='NATIVE_UNAVAILABLE' AND ((to_binding_id=? AND state='queued') OR (json_extract(data_json,'$._fromBindingId')=? AND json_extract(data_json,'$._responseState')='queued')) LIMIT 1",[w.id,p.bindingId,p.bindingId]):null;
    if(blocked){member.state='disconnected';member.reason='NO_CONNECTION';}
    member.collaborationReceiveMode=p.agent==='claude'?(armed?'background_wait':'checkpoint'):canPush(this.receiveModes.codex)?'native_push':this.receiveModes.codex;
    member.canReceiveCollaboration=p.agent==='claude'?armed:canPush(this.receiveModes.codex)&&Boolean(this.transport)&&!['disconnected','recovery_required'].includes(member.state);
    member.collaborationEvidenceAt=armed?p.inboxWaitAt:member.evidenceAt??null;return member;
  }
  async projectTimeline(sql,roomId,entry){
    if(entry.stopStatus)entry.stopStatus=await this.effects(sql,roomId,entry.stopStatus,{where:'segment_id=?',params:[entry.segmentId]});
    if(entry.kind!=='work')return {...entry,work:null};
    const data=entry.work??entry.system?.data??entry.data;
    if(!data?.workId)return entry;
    if(data.eventKind==='request'){const w=await this.load(sql,roomId,data.workId);const r=await this.request(sql,w,data.requestId);entry.work=this.requestPublic(w,r);}
    else if(data.eventKind==='response'){const w=await this.load(sql,roomId,data.workId),r=await this.request(sql,w,data.requestId);entry.work={...data,responseDelivery:{state:r._responseState,reason:r._responseReason??null,receivedAt:r._responseReceivedAt??null,blockedReason:r._responseState==='queued'?r._routingBlockedReason??null:null}};}
    else entry.work=data;
    entry.message=null;entry.reply=null;entry.system=null;entry.deliveries=[];return entry;
  }
  async checkpointWithheld(roomId,workId,bindingId,result){
    if(!result.items?.length)return;
    return this.broker.mutate('work.checkpointWithheld',roomId,{operationId:uid('op')},async ctx=>{
      const w=await this.load(ctx.sql,roomId,workId);this.participant(w,bindingId);
      for(const item of result.items){
        const r=await this.request(ctx.sql,w,item.requestId);
        // A concurrent replay may already have handed off the same claim. Preserve that possibility.
        if(item.kind==='request'&&r._toBindingId===bindingId&&r._claimId===item.claimId&&r.requestState==='claimed'){r.requestState='uncertain';r._failureReason='CHECKPOINT_WITHHELD';await this.saveRequest(ctx,r);}
        if(item.kind==='response'&&r._fromBindingId===bindingId&&r._responseClaimId===item.claimId&&r._responseState==='claimed'){r._responseState='uncertain';r._responseReason='CHECKPOINT_WITHHELD';await this.saveRequest(ctx,r);}
      }
      await this.saveWork(ctx,w);return{};
    },{gate:false});
  }
  async attention(sql,roomId,items,{after=null,limit=21}={}){
    const w=await this.current(sql,roomId);if(!w)return items;
    const ref={agent:null,bindingId:null,deliveryId:null,timelineItemId:w._startTimelineId,timelineOrder:null,aroundCursor:await this.around(sql,roomId,w._startTimelineId),since:w.startedAt,workId:w.id,requestId:null};
    if(w.coordinationState==='paused_budget')items.push({id:`budget-${w.id}`,kind:'work_budget',...ref,reason:'WORK_BUDGET_EXHAUSTED'});
    if(w.coordinationState==='expired')items.push({id:`expired-${w.id}`,kind:'work_expired',...ref,reason:'WORK_EXPIRED'});
    for(const p of w.participants.filter(p=>p.workState==='blocked'))items.push({id:`blocked-${w.id}-${p.agent}`,kind:'work_blocked',...ref,agent:p.agent,bindingId:p.bindingId,reason:'WORK_BLOCKED'});
    if(active(w)&&Date.parse(w.expiresAt)>this.clock()){
      const blocked=await sql.all("SELECT * FROM work_requests WHERE work_id=? AND json_extract(data_json,'$._routingBlockedReason') IS NOT NULL AND (state='queued' OR json_extract(data_json,'$._responseState')='queued')",[w.id]);
      for(const row of blocked){const r=parse(row),response=r._responseState==='queued',itemId=response?r._responseTimelineId:r._timelineId;
        items.push({id:`routing-${r.requestId}`,kind:'work_receive_unavailable',...ref,requestId:r.requestId,agent:response?r.author:r.recipient,bindingId:response?r._fromBindingId:r._toBindingId,timelineItemId:itemId,aroundCursor:await this.around(sql,roomId,itemId),since:r._routingBlockedAt??w.startedAt,reason:r._routingBlockedReason});}
    }
    const cutoff=new Date(this.clock()-30*60*1000).toISOString();
    const since="COALESCE(json_extract(data_json,'$.waitingSince'),?)";
    const condition=after?`AND (${since}>? OR (${since}=? AND ('request-'||id)>?))`:'';
    const rows=await sql.all(`SELECT * FROM work_requests WHERE work_id=? AND wait_disposition!='abandoned' AND (state IN ('uncertain','failed') OR (state IN ('claimed','awaiting_response') AND json_extract(data_json,'$.waitingSince')<=?) OR json_extract(data_json,'$._responseState') IN ('uncertain','failed')) ${condition} ORDER BY ${since},id LIMIT ?`,[w.id,cutoff,...(after?[w.startedAt,after.since,w.startedAt,after.since,after.id]:[]),w.startedAt,limit]);
    for(const row of rows){const r=parse(row),response=['uncertain','failed'].includes(r._responseState),state=response?r._responseState:r.requestState,kind=state==='uncertain'?'uncertain':state==='failed'?'failed':'stuck',itemId=response?r._responseTimelineId:r._timelineId;
      items.push({id:`request-${r.requestId}`,kind,...ref,requestId:r.requestId,agent:response?r.author:r.recipient,bindingId:response?r._fromBindingId:r._toBindingId,timelineItemId:itemId,aroundCursor:await this.around(sql,roomId,itemId),since:r.waitingSince??w.startedAt,reason:response?`RESPONSE_${kind.toUpperCase()}`:kind==='stuck'?'REQUEST_WAIT_TOO_LONG':r._failureReason??`REQUEST_${kind.toUpperCase()}`});}
    return items.filter(i=>!after||i.since>after.since||(i.since===after.since&&i.id>after.id)).sort((a,b)=>a.since<b.since?-1:a.since>b.since?1:a.id<b.id?-1:a.id>b.id?1:0).slice(0,limit);
  }
  async attentionCount(sql,roomId){
    const w=await this.current(sql,roomId);if(!w)return 0;
    const cutoff=new Date(this.clock()-30*60*1000).toISOString();
    const requests=await sql.get("SELECT COUNT(*) AS n FROM work_requests WHERE work_id=? AND wait_disposition!='abandoned' AND (state IN ('uncertain','failed') OR (state IN ('claimed','awaiting_response') AND json_extract(data_json,'$.waitingSince')<=?) OR json_extract(data_json,'$._responseState') IN ('uncertain','failed'))",[w.id,cutoff]);
    const blocked=active(w)&&Date.parse(w.expiresAt)>this.clock()?await sql.get("SELECT COUNT(*) AS n FROM work_requests WHERE work_id=? AND json_extract(data_json,'$._routingBlockedReason') IS NOT NULL AND (state='queued' OR json_extract(data_json,'$._responseState')='queued')",[w.id]):{n:0};
    return requests.n+blocked.n+Number(['paused_budget','expired'].includes(w.coordinationState))+w.participants.filter(p=>p.workState==='blocked').length;
  }
  async markNativeBlocked(roomId,candidate,reason){
    const prior=await this.broker.store.read(sql=>sql.get('SELECT data_json FROM work_requests WHERE id=? AND work_id=?',[candidate.requestId,candidate.workId]));
    if(prior&&JSON.parse(prior.data_json)._routingBlockedReason===reason)return;
    await this.broker.mutate('work.routingBlocked',roomId,{operationId:uid('op')},async ctx=>{
      const w=await this.load(ctx.sql,roomId,candidate.workId),r=await this.request(ctx.sql,w,candidate.requestId);
      if(!active(w)||Date.parse(w.expiresAt)<=this.clock()||!((r._toBindingId===candidate.bindingId&&r.requestState==='queued')||(r._fromBindingId===candidate.bindingId&&r._responseState==='queued')))return{};
      r._routingBlockedReason=reason;r._routingBlockedAt=ctx.now;await this.saveRequest(ctx,r);return{};
    },{gate:false});
  }
  async flushQueuedNative(){
    const rooms=await this.broker.store.read(sql=>sql.all("SELECT room_id FROM work_sessions WHERE occupancy='held' AND state IN ('active','paused_budget')"));
    for(const row of rooms)await this.flushNative(row.room_id);
  }
  flushNative(roomId){
    // Native delivery and same-turn timing are separate capabilities.
    if(this.closed||!this.transport?.sendWork||(!this.codexReceiveModeProvider&&!canPush(this.receiveModes.codex)))return Promise.resolve();
    if(this.flushing.has(roomId))return this.flushing.get(roomId);
    const task=this.drainNative(roomId).finally(()=>this.flushing.delete(roomId));
    this.flushing.set(roomId,task);return task;
  }
  async drainNative(roomId){
    // Each pass consumes only a newly queued item; failed/uncertain writes are never retried.
    while(!this.closed){
      const candidate=await this.broker.store.read(async sql=>{const w=await this.current(sql,roomId);if(!w||!active(w)||Date.parse(w.expiresAt)<=this.clock()||w.wakeBudget.remaining<=0)return null;const p=w.participants.find(p=>p.agent==='codex');const row=await sql.get("SELECT * FROM work_requests WHERE work_id=? AND ((to_binding_id=? AND state='queued') OR (json_extract(data_json,'$._fromBindingId')=? AND json_extract(data_json,'$._responseState')='queued')) ORDER BY request_number LIMIT 1",[w.id,p.bindingId,p.bindingId]);return row?{workId:w.id,requestId:row.id,bindingId:p.bindingId,nativeSessionId:p.nativeSessionId}:null;});
      if(!candidate)return;
      if(this.codexReceiveModeProvider){
        let mode='unverified';
        try{const value=await this.codexReceiveModeProvider();if(receiveModes.has(value))mode=value;}catch{}
        if(this.closed)return;
        if(mode!==this.receiveModes.codex){
          this.receiveModes.codex=mode;
          await this.broker.mutate('work.receiveCapability',roomId,{operationId:uid('op')},async()=>({codexReceiveMode:mode}),{gate:false});
        }
        if(!canPush(mode)){await this.markNativeBlocked(roomId,candidate,'NATIVE_RECEIVE_UNVERIFIED');return;}
      }
      // This read-only check spends no wake and invokes no model. A later room
      // event or explicit reconnect retries the original queued item, never a
      // message whose write outcome is uncertain.
      if(this.transport.probe){
        let available=false;try{available=(await this.transport.probe({nativeSessionId:candidate.nativeSessionId})).available===true;}catch{}
        if(this.closed)return;
        await this.broker.recordNativeConnection(candidate.bindingId,candidate.nativeSessionId,available);
        if(!available){await this.markNativeBlocked(roomId,candidate,'NATIVE_UNAVAILABLE');return;}
      }
      if(this.closed)return;
      const claimed=await this.broker.mutate(`work.nativeClaim:${candidate.requestId}`,roomId,{operationId:uid('op')},async ctx=>{
        const w=await this.load(ctx.sql,roomId,candidate.workId);await this.requireActive(ctx,w,candidate.bindingId);if(w.wakeBudget.remaining<=0)return{delivery:null};
        const r=await this.request(ctx.sql,w,candidate.requestId),p=this.participant(w,candidate.bindingId),isResponse=r._fromBindingId===p.bindingId;
        if((isResponse?r._responseState:r.requestState)!=='queued')return{delivery:null};
        let payload;
        try{payload=await this.deliveryContent(ctx.sql,roomId,r,isResponse);}
        catch(error){
          const reason=/^[A-Z_]{2,70}$/.test(error?.code??'')?error.code:'ATTACHMENT_UNAVAILABLE';
          if(isResponse){r._responseState='failed';r._responseReason=reason;}
          else{r.requestState='failed';r._failureReason=reason;}
          await this.saveRequest(ctx,r);await this.saveWork(ctx,w);return{delivery:null};
        }
        r._routingBlockedReason=null;r._routingBlockedAt=null;
        const claimId=uid('claim');if(isResponse){r._responseState='claimed';r._responseClaimId=claimId;r._responseNativeAttempt=true;}else{r.requestState='claimed';r._claimId=claimId;r._nativeAttempt=true;r.waitDisposition='waiting';r.waitingSince??=ctx.now;}
        w.wakeBudget.used++;await this.saveRequest(ctx,r);await this.saveWork(ctx,w);
        return{delivery:{id:isResponse?r.finalReplyId:r.requestId,roomId,workId:w.id,requestId:r.requestId,claimId,kind:isResponse?'response':'request',requestNumber:r.requestNumber,reviewRef:r._reviewRef??null,bindingId:p.bindingId,nativeSessionId:p.nativeSessionId,segmentId:w.segmentId,origin:isResponse?r.recipient:r.author,expiresAt:w.expiresAt,mode:'work',authorizedScope:await workAuthorization(ctx.sql,roomId,w.id),...payload}};
      },{gate:false});
      if(!claimed.delivery)continue;const d=claimed.delivery;
      let sent,timer,wrote=false;const abort=new AbortController();this.nativeAborts.add(abort);
      try { sent=await Promise.race([
        this.transport.sendWork(d,{signal:abort.signal,beforeSend:()=>{if(wrote)reject('DUPLICATE_WRITE_BLOCKED');if(!canPush(this.receiveModes.codex))reject('NATIVE_CAPABILITY_CHANGED');if(abort.signal.aborted||this.closed||!this.broker.isWriteAllowed(roomId,d.bindingId,d.segmentId)||Date.parse(d.expiresAt)<=this.clock())reject('ROOM_STOPPED');wrote=true;}}),
        new Promise(resolve=>{timer=setTimeout(()=>{abort.abort();resolve({status:'uncertain',reason:'TIMEOUT'});},15000);})
      ]); }
      catch { sent={status:'uncertain'}; }
      finally{clearTimeout(timer);abort.abort();this.nativeAborts.delete(abort);}
      if(!['sent','failed','uncertain'].includes(sent?.status))sent={status:'uncertain'};
      if(sent.status==='sent'&&!wrote)sent={status:'uncertain',reason:'MISSING_WRITE_EVIDENCE'};
      await this.broker.mutate(`work.nativeResult:${d.id}`,roomId,{operationId:uid('op')},async ctx=>{
        const w=await this.load(ctx.sql,roomId,d.workId),r=await this.request(ctx.sql,w,d.requestId);
        if(d.kind==='request'&&r._claimId===d.claimId&&r.requestState==='claimed'){r.requestState=sent.status==='sent'?'awaiting_response':sent.status==='failed'?'failed':'uncertain';r._failureReason=sent.status==='sent'?null:sent.reason??`REQUEST_${sent.status.toUpperCase()}`;}
        if(d.kind==='response'&&r._responseClaimId===d.claimId&&r._responseState==='claimed'){r._responseState=sent.status==='sent'?'claimed':sent.status==='failed'?'failed':'uncertain';r._responseReason=sent.status==='sent'?null:sent.reason??`RESPONSE_${sent.status.toUpperCase()}`;}
        await this.saveRequest(ctx,r);await this.saveWork(ctx,w);return{};
      },{gate:false});
    }
  }
  async close(){this.closed=true;this.broker.off('room.delta',this.onDelta);for(const timer of [...this.timers.values(),...this.attentionTimers.values()])clearTimeout(timer);this.timers.clear();this.attentionTimers.clear();for(const abort of this.nativeAborts)abort.abort();await Promise.allSettled([...this.flushing.values()]);}
}
