import http from 'node:http';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const VERSION = 'agent-chat.window.v2';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ROLES = new Set(['codex', 'claude']);
const COMMANDS = {
  join: ['room', 'as', 'session', 'label', 'renew', 'reconnect', 'expected-binding', 'gate-segment', 'gate-version', 'join-version'],
  wait: ['room', 'as', 'binding', 'request', 'work', 'scope', 'window-ms'],
  read: ['room', 'as', 'binding', 'request', 'batch', 'claim'],
  post: ['room', 'as', 'binding', 'delivery', 'file', 'claim', 'done', 'format', 'attachments-file'],
  status: ['room', 'as', 'binding'],
  resume: ['room', 'as', 'binding'],
  'start-context': ['room','as','binding'],
  'confirm-start': ['room','as','binding','op','source-message','source-sha256','file','pending','plan-sha256','codex-binding','claude-binding','gate-segment','gate-version','authorized'],
  'work-status': ['room', 'as', 'binding', 'work'],
  'work-accept': ['room', 'as', 'binding', 'work', 'op', 'delivery', 'claim', 'file', 'accept'],
  'work-progress': ['room', 'as', 'binding', 'work', 'op', 'file', 'references-file'],
  'work-request': ['room', 'as', 'binding', 'work', 'op', 'to-binding', 'kind', 'file', 'parent-request', 'review-ref', 'attachments-file'],
  'work-checkpoint': ['room', 'as', 'binding', 'work', 'op', 'request'],
  'work-received': ['room', 'as', 'binding', 'work', 'op', 'request', 'claim'],
  'work-response': ['room', 'as', 'binding', 'work', 'op', 'request', 'claim', 'file', 'attachments-file'],
  'work-state': ['room', 'as', 'binding', 'work', 'op', 'expected-version', 'state', 'file', 'references-file'],
};
const BOOLEAN = new Set(['renew', 'reconnect', 'done', 'authorized', 'pending']);
const WORK_PATHS = { 'work-accept': 'accept', 'work-progress': 'progress', 'work-request': 'requests',
  'work-checkpoint': 'checkpoint', 'work-received': 'received', 'work-response': 'responses', 'work-state': 'state' };
function error(code, message) { return Object.assign(new Error(message), { code }); }
function validId(value, label) { if (typeof value !== 'string' || !ID.test(value)) throw error('INVALID_INPUT', `${label} must be an explicit stable ID.`); return value; }
function need(value, label) { if (typeof value !== 'string' || !value) throw error('INVALID_INPUT', `${label} is required.`); return value; }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw error('INVALID_INPUT', `${label} must be a positive integer.`); return number; }
function argsOf(args, projectDir, runtimeDir) {
  const [command, ...rest] = args;
  if (!Object.hasOwn(COMMANDS, command)) throw error('INVALID_INPUT', 'Unknown v2 helper command.');
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    if (!rest[index].startsWith('--')) throw error('INVALID_INPUT', 'Use named flags; text must be supplied with --file.');
    const key = rest[index].slice(2);
    if (key !== 'runtime-dir' && !COMMANDS[command].includes(key) || Object.hasOwn(flags, key)) throw error('INVALID_INPUT', `Unknown or repeated flag: --${key}`);
    if (BOOLEAN.has(key)) flags[key] = true;
    else { const value = rest[++index]; if (!value || value.startsWith('--')) throw error('INVALID_INPUT', `Missing value for --${key}`); flags[key] = value; }
  }
  return { command, flags, runtime: resolve(runtimeDir ?? flags['runtime-dir'] ?? join(projectDir, 'runtime')) };
}
function readJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }
function arrayFile(path, ids = false) {
  if (path === undefined) return [];
  let value;
  try { const data=fs.readFileSync(path);if(data.length>4096)throw new Error('size');value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)); }
  catch { throw error('INVALID_INPUT','Expected a UTF-8 JSON array file no larger than 4096 bytes.'); }
  if (!Array.isArray(value)||value.length>20)throw error('INVALID_INPUT','At most 20 references or attachment IDs are allowed.');
  if(ids){value.forEach(id=>validId(id,'attachment ID'));if(new Set(value).size!==value.length)throw error('INVALID_INPUT','Duplicate attachment IDs.');}
  return value;
}
function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, path); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
function clientFile(runtime, bindingId) { return join(runtime, 'clients', `${createHash('sha256').update(bindingId).digest('hex')}.json`); }
function withState(runtime, bindingId, action) {
  const path = clientFile(runtime, bindingId); fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`, nonce = randomUUID(); let held = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 }); held = true; break; }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      try {
        const before = fs.readFileSync(lock, 'utf8'), owner = JSON.parse(before);
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw error('CLI_BUSY', 'Local helper state needs inspection.');
        let alive = true; try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
        if (alive || fs.readFileSync(lock, 'utf8') !== before) throw error('CLI_BUSY', 'Another helper is saving state; retry the same command.');
        fs.unlinkSync(lock);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  if (!held) throw error('CLI_BUSY', 'Another helper is saving state; retry the same command.');
  try {
    let outer = null;
    try { outer = readJson(path); } catch (e) { if (e.code !== 'ENOENT') throw error('LOCAL_STATE_UNSAFE', 'Local helper state is unreadable; retain its files.'); }
    const { state, value } = action(outer?.v2 ?? null, outer);
    if (state !== undefined) atomicJson(path, { ...(outer ?? {}), v2: state });
    return value;
  } finally { try { if (readJson(lock).nonce === nonce) fs.unlinkSync(lock); } catch {} }
}
function descriptor(runtime, role) {
  let value;
  try { value = readJson(join(runtime, `connection-${role}.json`)); }
  catch { throw error('BROKER_UNAVAILABLE', 'Start the v2 broker, then join this exact native session.'); }
  let url; try { url = new URL(value.baseUrl); } catch { throw error('LOCAL_STATE_UNSAFE', 'Invalid local broker descriptor.'); }
  if (value.apiVersion !== VERSION || value.agent !== role || !ID.test(value.workspaceId ?? '') || !ID.test(value.instanceId ?? '')
    || typeof value.enrollmentToken !== 'string' || !value.enrollmentToken
    || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw error('LOCAL_STATE_UNSAFE', 'Invalid local broker descriptor.');
  return value;
}
function verifyIdentity(result, state, roomId, { native = false } = {}) {
  if (!result || result.roomId !== roomId || result.bindingId !== state.bindingId || result.agent !== state.agent
    || (result.workspaceId !== undefined && result.workspaceId !== state.workspaceId)
    || (native && (result.binding?.nativeSessionId ?? result.nativeSessionId) !== state.nativeSessionId))
    throw error('INVALID_RESPONSE', 'Broker response did not match the exact room and binding.');
  return result;
}
function requestJson(baseUrl, path, credential, body, { wait = false, signal, roomId } = {}) {
  return new Promise((yes, no) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(path, baseUrl), { method: encoded ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${credential}`, ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}) }, signal }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', data => { bytes += data.length; if (bytes > 8 * 1024 * 1024) { res.destroy(); no(error('RESPONSE_TOO_LARGE', 'Reply was not consumed; retry original IDs.')); } else chunks.push(data); });
      res.on('error', () => no(error('CONNECTION_LOST', 'Connection lost; retry original IDs.')));
      res.on('end', () => {
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return no(error('CONNECTION_LOST', 'No complete broker result; retry original IDs.')); }
        if (value.apiVersion !== VERSION) return no(error('VERSION_MISMATCH', 'Broker version does not match this helper.'));
        if (!value.ok) return no(Object.assign(error(value.error?.code ?? 'BROKER_ERROR', value.error?.message ?? 'Broker rejected the request.'), { outcome: value.error?.outcome }));
        if (value.result?.roomId !== roomId) return no(error('INVALID_RESPONSE', 'Broker result belongs to another room.'));
        yes(value.result);
      });
    });
    if (!wait) req.setTimeout(30000, () => req.destroy(error('CONNECTION_LOST', 'Operation timed out; retry original IDs.')));
    req.on('error', cause => no(error(cause.code === 'ABORT_ERR' ? 'WAIT_CANCELLED' : 'CONNECTION_LOST', 'Broker connection failed; retain original IDs.')));
    req.end(encoded);
  });
}
function textFile(path) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(resolve(need(path, '--file')))); }
  catch { throw error('INVALID_INPUT', 'Cannot read --file as UTF-8. Original local state is retained.'); }
}
function operation(runtime, bindingId, key, opFlag, makeBody) {
  return withState(runtime, bindingId, current => {
    if (!current) throw error('JOIN_REQUIRED', 'Join the exact native session first.');
    current.operations ??= {}; current.pendingOperations ??= {};
    const requestedId = opFlag ? validId(opFlag, '--op') : current.pendingOperations[key] ?? randomUUID();
    if (current.pendingOperations[key] && current.pendingOperations[key] !== requestedId) throw error('ID_CONFLICT', 'Retry the unresolved operation with its original ID.');
    const proposed = { operationId: requestedId, ...makeBody(current) };
    const saved = current.operations[requestedId];
    if (saved && JSON.stringify(saved.body) !== JSON.stringify(proposed)) throw error('ID_CONFLICT', 'Operation ID already has another saved payload.');
    current.operations[requestedId] ??= { key, body: proposed, committed: false };
    if (!current.operations[requestedId].committed) current.pendingOperations[key] = requestedId;
    return { state: current, value: current.operations[requestedId].body };
  });
}
function commitOperation(runtime, bindingId, operationId) {
  withState(runtime, bindingId, current => {
    const saved = current?.operations?.[operationId]; if (!saved) throw error('LOCAL_STATE_UNSAFE', 'Saved operation disappeared.');
    saved.committed = true;
    if (current.pendingOperations?.[saved.key] === operationId) delete current.pendingOperations[saved.key];
    return { state: current, value: null };
  });
}
function rejectOperation(runtime,bindingId,operationId,cause){
  withState(runtime,bindingId,current=>{
    const saved=current?.operations?.[operationId];if(!saved)return {value:null};
    saved.rejected={code:cause.code,outcome:'rejected'};
    if(current.pendingOperations?.[saved.key]===operationId)delete current.pendingOperations[saved.key];
    return {state:current,value:null};
  });
}

export async function runV2Cli(args, { stdout = text => process.stdout.write(text), signal, projectDir = resolve(import.meta.dirname, '..'), runtimeDir } = {}) {
  const parsed = argsOf(args, projectDir, runtimeDir); const { command, flags, runtime } = parsed;
  const print = value => { stdout(`${JSON.stringify(value, null, 2)}\n`); return value; };
  const role = flags.as; if (!ROLES.has(role)) throw error('INVALID_INPUT', '--as must be codex or claude.');
  const roomId = validId(flags.room, '--room'); const connection = descriptor(runtime, role);
  const route = `/agent/v2/rooms/${encodeURIComponent(roomId)}`;
  if (command === 'join') {
    const nativeSessionId = validId(flags.session, '--session');
    if (flags['expected-binding'] === undefined) throw error('INVALID_INPUT', '--expected-binding is required; use null for an empty seat.');
    const expectedBindingId = flags['expected-binding'] === 'null' ? null : validId(flags['expected-binding'], '--expected-binding');
    if (flags.reconnect && !expectedBindingId) throw error('INVALID_INPUT', '--reconnect requires the existing --expected-binding.');
    const expectedGate = { segmentId: validId(flags['gate-segment'], '--gate-segment'), version: positiveInteger(flags['gate-version'], '--gate-version') };
    const result = await requestJson(connection.baseUrl, `${route}/join`, connection.enrollmentToken,
      { agent: role, nativeSessionId, label: flags.label ?? role, renew: flags.renew ?? false,
        ...(flags.reconnect ? { reconnect: true } : {}),
        ...(flags['join-version'] === undefined ? {} : { expectedJoinVersion: positiveInteger(flags['join-version'], '--join-version') }),
        expectedBindingId, expectedGate }, { signal, roomId });
    validId(result.bindingId, 'bindingId');
    if (result.agent !== role || result.nativeSessionId !== nativeSessionId || (flags.reconnect && result.bindingId !== expectedBindingId)
      || (result.workspaceId !== undefined && result.workspaceId !== connection.workspaceId)
      || typeof result.credential !== 'string' || !result.credential) throw error('INVALID_RESPONSE', 'Join identity could not be verified.');
    withState(runtime, result.bindingId, (prior, outer) => {
      if (prior && (prior.workspaceId !== connection.workspaceId || prior.roomId !== roomId || prior.agent !== role || prior.nativeSessionId !== nativeSessionId)) throw error('FORBIDDEN', 'Binding identity changed.');
      if (outer && !prior && outer.bindingId && (outer.bindingId !== result.bindingId || outer.agent !== role || outer.nativeSessionId !== nativeSessionId || outer.roomId !== roomId)) throw error('FORBIDDEN', 'Legacy binding identity conflicts with v2 join.');
      const state = { ...prior, schema: 2, workspaceId: connection.workspaceId, roomId, agent: role, nativeSessionId, bindingId: result.bindingId,
        instanceId: connection.instanceId, baseUrl: connection.baseUrl, credential: result.credential,
        claims: prior?.claims ?? {}, posts: prior?.posts ?? {}, operations: prior?.operations ?? {}, pendingOperations: prior?.pendingOperations ?? {} };
      if (prior?.instanceId !== connection.instanceId) { state.pendingWait = null; state.pendingRead = null; state.batchId = result.batchId ?? null; }
      else if (result.batchId) state.batchId = result.batchId;
      return { state, value: null };
    });
    const { credential, ...safe } = result;
    if (role === 'codex') {
      const folder=join(runtime,'recovery-sessions');fs.mkdirSync(folder,{recursive:true,mode:0o700});
      atomicJson(join(folder,`${createHash('sha256').update(nativeSessionId).digest('hex')}.json`),
        {schema:1,nativeSessionId,roomId,bindingId:result.bindingId,agent:role,projectDir:resolve(projectDir),runtimeDir:runtime});
    }
    return print({ ...safe, next: `node chat.mjs ${role === 'claude' ? 'wait' : 'status'} --room ${roomId} --as ${role} --binding ${result.bindingId}` });
  }
  const bindingId = validId(flags.binding, '--binding');
  let state = withState(runtime, bindingId, current => ({ value: current }));
  if (!state) throw error('JOIN_REQUIRED', 'Join the exact native session first.');
  if (state.workspaceId !== connection.workspaceId || state.roomId !== roomId || state.agent !== role || state.bindingId !== bindingId) throw error('FORBIDDEN', 'Credential belongs to another workspace, room, role or binding.');
  if (state.instanceId !== connection.instanceId || state.baseUrl !== connection.baseUrl) {
    const bound = await requestJson(connection.baseUrl, `${route}/status`, state.credential, undefined, { signal, roomId });
    verifyIdentity(bound, state, roomId, { native: true });
    state = withState(runtime, bindingId, current => {
      current.instanceId = connection.instanceId; current.baseUrl = connection.baseUrl; current.pendingWait = null;
      current.batchId = bound.batchId ?? null; return { state: current, value: current };
    });
  }
  const call = (suffix, body, options = {}) => requestJson(state.baseUrl, `${route}/${suffix}`, state.credential, body, { signal, roomId, ...options });
  if (command === 'status') return print(verifyIdentity(await call('status'), state, roomId, { native: true }));
  if (command === 'resume') return print(verifyIdentity(await call('resume'), state, roomId, { native: true }));
  if(command==='start-context')return print(await call('start-context'));
  if (command === 'wait') {
    if (role !== 'claude') throw error('INVALID_INPUT', 'Codex uses native push.');
    const scope = flags.scope ?? 'ordinary';
    if (!['ordinary', 'work', 'all'].includes(scope)) throw error('INVALID_INPUT', '--scope must be ordinary, work, or all.');
    if ((scope !== 'ordinary') !== Boolean(flags.work)) throw error('INVALID_INPUT', '--scope work or all requires --work; ordinary wait must omit --work.');
    const windowMs = flags['window-ms'] === undefined ? undefined : positiveInteger(flags['window-ms'], '--window-ms');
    if (windowMs > 6900000) throw error('INVALID_INPUT', '--window-ms must not exceed 6900000.');
    const body = withState(runtime, bindingId, current => {
      const requestId = flags.request ? validId(flags.request, '--request') : current.pendingWait?.requestId ?? randomUUID();
      const proposed = { requestId, notificationScopes: scope === 'all' ? ['ordinary', 'work'] : [scope],
        ...(flags.work ? { workId: validId(flags.work, '--work') } : {}), ...(windowMs === undefined ? {} : { windowMs }) };
      if (current.pendingWait && JSON.stringify(current.pendingWait) !== JSON.stringify(proposed)) throw error('ID_CONFLICT', 'Retry the pending wait with its original IDs and scope.');
      current.pendingWait = proposed; return { state: current, value: proposed };
    });
    let result,updateId=null,recoveryDeadline=0;
    for(;;){
      let cause;
      try{result=await call('wait',body,{wait:true});if(result.status!=='DISCONNECTED')break;}
      catch(e){cause=e;if(!['UPDATE_IN_PROGRESS','CLOSED','CONNECTION_LOST','BROKER_UNAVAILABLE'].includes(e.code)||signal?.aborted)throw e;}
      let install;try{install=readJson(join(runtime,'update-state.json')).install;}catch{}
      const activeUpdate=install&&['downloading','verifying','stopping','installing','restarting'].includes(install.state);
      if(!updateId&&activeUpdate){updateId=install.operationId;recoveryDeadline=Date.now()+120000;}
      if(!updateId||Date.now()>=recoveryDeadline){if(cause)throw cause;break;}
      await delay(500,undefined,{signal});
      try{
        const next=descriptor(runtime,role);
        if(next.workspaceId!==state.workspaceId)throw error('FORBIDDEN','Updated broker belongs to a different workspace.');
        if(next.instanceId!==state.instanceId||next.baseUrl!==state.baseUrl){
          const bound=await requestJson(next.baseUrl,`${route}/status`,state.credential,undefined,{signal,roomId});
          verifyIdentity(bound,state,roomId,{native:true});
          state=withState(runtime,bindingId,current=>{current.instanceId=next.instanceId;current.baseUrl=next.baseUrl;current.batchId=bound.batchId??null;return {state:current,value:current};});
        }
      }catch(e){if(!['BROKER_UNAVAILABLE','CONNECTION_LOST','CLOSED'].includes(e.code))throw e;}
      // Same scope, request and binding; no lease extension or model wake.
    }
    withState(runtime, bindingId, current => {
      if (current.pendingWait?.requestId === body.requestId) current.pendingWait = null;
      if (['NEW', 'NOTICE_PENDING'].includes(result.status)) { current.batchId = result.batchId; current.notificationId = result.notificationId; }
      return { state: current, value: null };
    });
    return print(result);
  }
  if (command === 'read') {
    if (role !== 'claude') throw error('INVALID_INPUT', 'Codex uses native push.');
    const body = withState(runtime, bindingId, current => {
      if (current.pendingRead) {
        for (const [flag, field] of [['request', 'requestId'], ['batch', 'batchId'], ['claim', 'claimId']])
          if (flags[flag] !== undefined && flags[flag] !== current.pendingRead[field]) throw error('ID_CONFLICT', 'Retry the pending read with original IDs.');
        return { value: current.pendingRead };
      }
      const request = { requestId: flags.request ? validId(flags.request, '--request') : randomUUID() };
      if (flags.batch ?? current.batchId) request.batchId = validId(flags.batch ?? current.batchId, '--batch');
      else if (!flags.claim) throw error('INVALID_INPUT', 'A prior NEW batch or an exact --claim is required.');
      if (flags.claim) request.claimId = validId(flags.claim, '--claim');
      current.pendingRead = request; return { state: current, value: request };
    });
    const result = await call('read', body);
    if (result.status === 'DELIVERY') verifyIdentity(result, state, roomId);
    withState(runtime, bindingId, current => {
      if (result.status === 'DELIVERY') {
        validId(result.deliveryId, 'deliveryId'); validId(result.claimId, 'claimId');
        current.claims[result.deliveryId] = { claimId: result.claimId, batchId: result.batchId, requestId: body.requestId, finalPosted: false };
      } else if (['EMPTY', 'PAUSED', 'BATCH_LIMIT', 'COMPLETED'].includes(result.status)) {
        if (current.pendingRead?.requestId === body.requestId) current.pendingRead = null;
        if (result.status !== 'COMPLETED') { current.batchId = null; current.notificationId = null; }
        if (result.status === 'COMPLETED' && current.claims[result.deliveryId]) current.claims[result.deliveryId].finalPosted = true;
      }
      return { state: current, value: null };
    });
    return print(result);
  }
  if (command === 'post') {
    const deliveryId = validId(flags.delivery, '--delivery'); const text = textFile(flags.file);
    if(flags.format!==undefined&&!['plain','markdown'].includes(flags.format))throw error('INVALID_INPUT','--format must be plain or markdown.');
    const body = withState(runtime, bindingId, current => {
      const claimId = flags.claim ? validId(flags.claim, '--claim') : current.claims[deliveryId]?.claimId ?? null;
      if (role === 'claude' && claimId === null) throw error('CLAIM_REQUIRED', 'Read the exact delivery first.');
      const request = { deliveryId, claimId, text, attachmentIds: arrayFile(flags['attachments-file'],true), done: flags.done ?? false, ...(flags.format?{format:flags.format}:{}) };
      const previous = current.posts[deliveryId];
      if (previous && JSON.stringify(previous.request) !== JSON.stringify(request)) throw error('ID_CONFLICT', 'A different final is already saved for this delivery.');
      current.posts[deliveryId] = previous ?? { request, committed: false };
      return { state: current, value: request };
    });
    const result = await call('post', body);
    if (result.deliveryId !== deliveryId) throw error('INVALID_RESPONSE', 'Final result belongs to another delivery.');
    withState(runtime, bindingId, current => {
      current.posts[deliveryId].committed = true;
      const claim = current.claims[deliveryId];
      if (claim) { claim.finalPosted = true; if (current.pendingRead?.requestId === claim.requestId) current.pendingRead = null; }
      return { state: current, value: null };
    });
    return print(result);
  }
  if(command==='confirm-start'){
    if(flags.authorized!==true||Boolean(flags.file)===Boolean(flags.pending))throw error('INVALID_INPUT','Read the full human message and use exactly one of --file or --pending with --authorized.');
    const opKey=`confirm-start:${validId(flags['source-message'],'--source-message')}`;
    const saved=withState(runtime,bindingId,current=>({value:current.operations[flags.op??current.pendingOperations[opKey]]??null}));
    let body;
    if(saved){
      body=saved.body;
      const matches=(flag,value)=>flags[flag]===undefined||String(flags[flag])===String(value);
      if(flags.file&&textFile(flags.file)!==body.planText||!matches('source-sha256',body.sourceTextSha256)||!matches('plan-sha256',body.planSha256)
        ||!matches('codex-binding',body.expectedBindings.codex)||!matches('claude-binding',body.expectedBindings.claude)
        ||!matches('gate-segment',body.expectedGate.segmentId)||!matches('gate-version',body.expectedGate.version))throw error('ID_CONFLICT','Retry the saved confirmation with its original plan and IDs.');
    }else{
    const context=await call('start-context');
    if(context.sourceHumanMessage?.id!==flags['source-message'])throw error('SOURCE_CHANGED','The selected human instruction is no longer current.');
    if(flags.pending&&context.pendingKickoff?.state!=='waiting_peer')throw error('START_CONFIRMATION_EXPIRED','No current peer plan is waiting for confirmation.');
    const planText=flags.pending?context.pendingKickoff.planText:textFile(flags.file),planSha256=createHash('sha256').update(planText,'utf8').digest('hex');
    if(flags['plan-sha256']&&flags['plan-sha256']!==planSha256)throw error('PLAN_CHANGED','The plan differs from the one you read.');
    const sourceHash=flags['source-sha256']??context.sourceHumanMessage.textSha256;
    if(!/^[a-f0-9]{64}$/.test(sourceHash))throw error('INVALID_INPUT','Invalid full source hash.');
    body=operation(runtime,bindingId,opKey,flags.op,()=>({
      sourceHumanMessageId:flags['source-message'],sourceTextSha256:sourceHash,planText,planSha256,implementationAuthorized:true,
      expectedBindings:{codex:validId(flags['codex-binding']??context.expectedBindings.codex,'--codex-binding'),claude:validId(flags['claude-binding']??context.expectedBindings.claude,'--claude-binding')},
      expectedGate:{segmentId:validId(flags['gate-segment']??context.expectedGate.segmentId,'--gate-segment'),version:positiveInteger(flags['gate-version']??context.expectedGate.version,'--gate-version')}
    }));
    }
    let result;try{result=await call('confirm-start',body);}catch(cause){if(cause.outcome==='rejected')rejectOperation(runtime,bindingId,body.operationId,cause);throw cause;}
    commitOperation(runtime,bindingId,body.operationId);return print(result);
  }
  const workId = validId(flags.work, '--work');
  if(command==='work-status'){const result=await call(`work/${encodeURIComponent(workId)}/status`);if(result.workId!==workId)throw error('INVALID_RESPONSE','Work status belongs to another task.');return print(result);}
  const workRoute = `work/${encodeURIComponent(workId)}/${WORK_PATHS[command]}`;
  const opKey = `${command}:${workId}${flags.request ? `:${validId(flags.request, '--request')}` : ''}${flags.delivery ? `:${validId(flags.delivery, '--delivery')}` : ''}`;
  const body = operation(runtime, bindingId, opKey, flags.op, current => {
    if (command === 'work-accept') {
      if (!['true', 'false'].includes(flags.accept)) throw error('INVALID_INPUT', '--accept must be true or false.');
      return { deliveryId: validId(flags.delivery, '--delivery'), claimId: flags.claim ? validId(flags.claim, '--claim') : current.claims[flags.delivery]?.claimId ?? null,
        text: textFile(flags.file), accept: flags.accept === 'true' };
    }
    if (command === 'work-progress') return { text: textFile(flags.file), ...(flags['references-file']?{references:arrayFile(flags['references-file'])}:{}) };
    if (command === 'work-request') return { toBindingId: validId(flags['to-binding'], '--to-binding'), kind: validId(flags.kind, '--kind'), text: textFile(flags.file), attachmentIds: arrayFile(flags['attachments-file'],true),
      ...(flags['parent-request'] ? { parentRequestId: validId(flags['parent-request'], '--parent-request') } : {}),
      ...(flags['review-ref'] ? { reviewRef: {itemId:validId(flags['review-ref'], '--review-ref')} } : {}) };
    if (command === 'work-checkpoint') return flags.request ? { requestId: validId(flags.request, '--request') } : {};
    if (command === 'work-received') return { requestId: validId(flags.request, '--request'), claimId: validId(flags.claim, '--claim') };
    if (command === 'work-response') return { requestId: validId(flags.request, '--request'), claimId: validId(flags.claim, '--claim'), text: textFile(flags.file), attachmentIds: arrayFile(flags['attachments-file'],true) };
    if (command === 'work-state') {
      const workState = need(flags.state, '--state');
      if (!['not_started', 'working', 'awaiting_review', 'blocked', 'completed', 'stopped', 'unknown'].includes(workState)) throw error('INVALID_INPUT', 'Invalid --state.');
      return { expectedParticipantVersion: positiveInteger(flags['expected-version'], '--expected-version'), workState, text: textFile(flags.file), ...(flags['references-file']?{references:arrayFile(flags['references-file'])}:{}) };
    }
  });
  let result;
  try { result = await call(workRoute, body); }
  catch(cause){if(cause.outcome==='rejected')rejectOperation(runtime,bindingId,body.operationId,cause);throw cause;}
  if (result.workId !== undefined && result.workId !== workId) throw error('INVALID_RESPONSE', 'Work result belongs to another task.');
  if (['work-received', 'work-response'].includes(command) && result.requestId !== undefined && result.requestId !== body.requestId)
    throw error('INVALID_RESPONSE', 'Work result belongs to another request.');
  commitOperation(runtime, bindingId, body.operationId);
  return print(result);
}
