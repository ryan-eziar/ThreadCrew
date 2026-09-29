import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { runV2Cli } from '../src/v2-cli.mjs';

const root = resolve(import.meta.dirname, '..', 'work', 'v2-cli-tests');
async function fixture(t, handler = () => ({})) {
  await mkdir(root, { recursive: true }); const runtimeDir = await mkdtemp(join(root, 'case-'));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    calls.push({ path: req.url, method: req.method, body, auth: req.headers.authorization });
    const result = await handler({ path: req.url, body, calls });
    res.setHeader('Content-Type', 'application/json');
    if (result?.__error) {
      res.statusCode = result.__error.status ?? 409;
      res.end(JSON.stringify({ apiVersion: 'agent-chat.window.v2', ok: false, error: result.__error }));
      return;
    }
    res.end(JSON.stringify({ apiVersion: 'agent-chat.window.v2', ok: true, result: { roomId: 'room-a', ...result } }));
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  await writeFile(join(runtimeDir, 'connection-claude.json'), JSON.stringify({ apiVersion: 'agent-chat.window.v2', agent: 'claude',
    workspaceId: 'workspace-one', instanceId: 'instance-one', baseUrl, enrollmentToken: 'enrollment-secret' }));
  t.after(async () => { await new Promise(resolveClose => server.close(resolveClose)); await rm(runtimeDir, { recursive: true, force: true }); });
  const output = [];
  const run = (...args) => runV2Cli(args, { runtimeDir, stdout: value => output.push(value) });
  const clientPath = join(runtimeDir, 'clients', `${createHash('sha256').update('binding-a').digest('hex')}.json`);
  return { run, calls, output, runtimeDir, clientPath, baseUrl };
}
async function joinV2(f) {
  return f.run('join', '--room', 'room-a', '--as', 'claude', '--session', 'native-a', '--expected-binding', 'null', '--gate-segment', 'segment-a', '--gate-version', '4');
}
const binding = ['--room', 'room-a', '--as', 'claude', '--binding', 'binding-a'];

test('confirm-start reads a full pending plan and retries its original snapshot after an unknown outcome',async t=>{
  const plan='Full agreed implementation plan',sha=createHash('sha256').update(plan).digest('hex');let contexts=0,posts=0;
  const f=await fixture(t,({path,body})=>{
    if(path.endsWith('/join'))return {bindingId:'binding-a',agent:'claude',nativeSessionId:'native-a',credential:'binding-secret'};
    if(path.endsWith('/start-context')){contexts++;return {sourceHumanMessage:{id:'human-a',text:'Please implement after agreement.',textSha256:'a'.repeat(64)},expectedGate:{segmentId:'segment-a',version:4},expectedBindings:{codex:'binding-codex',claude:'binding-a'},pendingKickoff:{state:'waiting_peer',planText:plan,planSha256:sha}};}
    if(path.endsWith('/confirm-start')){posts++;assert.equal(body.planText,plan);assert.equal(body.sourceTextSha256,'a'.repeat(64));return posts===1?{__error:{code:'RECOVERY_REQUIRED',outcome:'unknown'}}:{bindingId:'binding-a',agent:'claude',pendingKickoff:null,work:{id:'work-a'}};}
  });
  await joinV2(f);const args=['confirm-start',...binding,'--source-message','human-a','--pending','--plan-sha256',sha,'--authorized','--op','confirm-op'];
  await assert.rejects(f.run(...args),e=>e.outcome==='unknown');
  assert.equal((await f.run(...args)).work.id,'work-a');assert.equal(contexts,1);assert.equal(posts,2);
  assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/confirm-start'))[0].body,f.calls.at(-1).body);
});

test('work-status reads participant versions without creating an operation or widening room scope',async t=>{
  const f=await fixture(t,({path})=>path.endsWith('/join')?{bindingId:'binding-a',agent:'claude',nativeSessionId:'native-a',credential:'binding-secret'}:{bindingId:'binding-a',agent:'claude',workId:'work-a',work:{participants:[{agent:'claude',version:7}]}});
  await joinV2(f);const result=await f.run('work-status',...binding,'--work','work-a');
  assert.equal(result.work.participants[0].version,7);assert.equal(f.calls.at(-1).method,'GET');assert.equal(f.calls.at(-1).body,undefined);
  await assert.rejects(f.run('work-status','--room','room-b','--as','claude','--binding','binding-a','--work','work-a'),e=>e.code==='FORBIDDEN');
});

test('join saves room/workspace identity in the v1 hashed client path without losing legacy state', async t => {
  const f = await fixture(t, ({ path }) => path.endsWith('/join') ? { bindingId: 'binding-a', agent: 'claude', nativeSessionId: 'native-a', credential: 'binding-secret' } : {});
  await mkdir(join(f.runtimeDir, 'clients'));
  await writeFile(f.clientPath, JSON.stringify({ schema: 1, roomId: 'room-a', agent: 'claude', nativeSessionId: 'native-a', bindingId: 'binding-a', posts: { old: { committed: false } } }));
  const result = await joinV2(f);
  assert.equal(result.roomId, 'room-a'); assert.equal(result.credential, undefined);
  const state = JSON.parse(await readFile(f.clientPath, 'utf8'));
  assert.deepEqual(state.posts, { old: { committed: false } });
  assert.equal(state.v2.workspaceId, 'workspace-one'); assert.equal(state.v2.roomId, 'room-a');
  assert.equal(state.v2.credential, 'binding-secret');
  assert.deepEqual(f.calls[0].body.expectedGate, { segmentId: 'segment-a', version: 4 });
  assert.equal(f.calls[0].body.expectedBindingId, null);
});

test('wrong room, workspace and binding fail closed before or after HTTP', async t => {
  const f = await fixture(t, ({ path }) => path.endsWith('/join') ? { bindingId: 'binding-a', agent: 'claude', nativeSessionId: 'native-a', credential: 'binding-secret' }
    : { bindingId: 'binding-other', agent: 'claude', nativeSessionId: 'native-a' });
  await joinV2(f);
  await assert.rejects(f.run('status', '--room', 'room-b', '--as', 'claude', '--binding', 'binding-a'), error => error.code === 'FORBIDDEN');
  await assert.rejects(f.run('status', ...binding), error => error.code === 'INVALID_RESPONSE');
  const descriptorPath = join(f.runtimeDir, 'connection-claude.json');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')); descriptor.workspaceId = 'workspace-other';
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  await assert.rejects(f.run('status', ...binding), error => error.code === 'FORBIDDEN');
  assert.equal(f.calls.length, 2, 'cross-room and cross-workspace attempts made no HTTP call');
});

test('work request and response retry the identical saved operation after lost HTTP results', async t => {
  let failRequest = true, failResponse = true;
  const f = await fixture(t, ({ path, body }) => {
    if (path.endsWith('/join')) return { bindingId: 'binding-a', agent: 'claude', nativeSessionId: 'native-a', credential: 'binding-secret' };
    if (path.endsWith('/requests') && failRequest) { failRequest = false; return { roomId: 'wrong-room' }; }
    if (path.endsWith('/responses') && failResponse) { failResponse = false; return { roomId: 'wrong-room' }; }
    return { operationId: body.operationId, requestId: 'request-one' };
  });
  await joinV2(f);
  const file = join(f.runtimeDir, 'text.txt'); await writeFile(file, 'First text');
  const requestArgs = ['work-request', ...binding, '--work', 'work-a', '--to-binding', 'binding-peer', '--kind', 'review', '--file', file];
  await assert.rejects(f.run(...requestArgs), error => error.code === 'INVALID_RESPONSE');
  const first = f.calls.at(-1).body;
  await writeFile(file, 'Changed text');
  await assert.rejects(f.run(...requestArgs), error => error.code === 'ID_CONFLICT');
  await writeFile(file, 'First text');
  await f.run(...requestArgs);
  assert.deepEqual(f.calls.at(-1).body, first);
  const responseArgs = ['work-response', ...binding, '--work', 'work-a', '--request', 'request-one', '--claim', 'claim-one', '--file', file, '--op', 'response-op'];
  await assert.rejects(f.run(...responseArgs), error => error.code === 'INVALID_RESPONSE');
  const saved = f.calls.at(-1).body;
  await f.run(...responseArgs);
  assert.deepEqual(f.calls.at(-1).body, saved);
  await assert.rejects(f.run(...responseArgs, '--claim', 'claim-two'), error => error.code === 'INVALID_INPUT' || error.code === 'ID_CONFLICT');
});

test('work state sends participant version and work wait keeps exact scope', async t => {
  const f = await fixture(t, ({ path, body }) => path.endsWith('/join') ? { bindingId: 'binding-a', agent: 'claude', nativeSessionId: 'native-a', credential: 'binding-secret' }
    : path.endsWith('/wait') ? { status: 'NEW', batchId: 'batch-a', notificationId: 'notice-a' } : { operationId: body.operationId });
  await joinV2(f);
  const file = join(f.runtimeDir, 'state.txt'); await writeFile(file, 'Milestone reached');
  await f.run('work-state', ...binding, '--work', 'work-a', '--state', 'working', '--expected-version', '7', '--file', file, '--op', 'state-op');
  assert.deepEqual(f.calls.at(-1).body, { operationId: 'state-op', expectedParticipantVersion: 7, workState: 'working', text: 'Milestone reached' });
  await f.run('wait', ...binding, '--scope', 'work', '--work', 'work-a');
  assert.deepEqual(f.calls.at(-1).body.notificationScopes, ['work']); assert.equal(f.calls.at(-1).body.workId, 'work-a');
  await assert.rejects(f.run('wait', ...binding, '--scope', 'work'), error => error.code === 'INVALID_INPUT');
});

test('combined wait preserves its exact scope and work through an unknown result', async t => {
  let uncertain = true;
  const f = await fixture(t, ({ path }) => {
    if (path.endsWith('/join')) return { bindingId: 'binding-a', agent: 'claude', nativeSessionId: 'native-a', credential: 'binding-secret' };
    if (uncertain) { uncertain = false; return { roomId: 'wrong-room' }; }
    return { status: 'NEW', workId: 'work-a', requestIds: ['review-a'] };
  });
  await joinV2(f);
  const args = ['wait', ...binding, '--scope', 'all', '--work', 'work-a'];
  await assert.rejects(f.run(...args), error => error.code === 'INVALID_RESPONSE');
  const sent = f.calls.at(-1).body;
  assert.deepEqual(sent.notificationScopes, ['ordinary', 'work']);
  assert.equal(sent.workId, 'work-a');
  assert.deepEqual(JSON.parse(await readFile(f.clientPath, 'utf8')).v2.pendingWait, sent);
  await assert.rejects(f.run('wait', ...binding), error => error.code === 'ID_CONFLICT');
  await assert.rejects(f.run('wait', ...binding, '--scope', 'all', '--work', 'work-other'), error => error.code === 'ID_CONFLICT');
  assert.equal(f.calls.length, 2, 'a changed retry must not issue HTTP');
  const result = await f.run(...args);
  assert.deepEqual(f.calls.at(-1).body, sent);
  assert.equal(result.workId, 'work-a');
  assert.deepEqual(result.requestIds, ['review-a']);
  assert.equal(JSON.parse(await readFile(f.clientPath, 'utf8')).v2.pendingWait, null);
});

test('wait validates scope/work pairing and preserves ordinary batch notifications', async t => {
  const f = await fixture(t, ({ path }) => path.endsWith('/join')
    ? { bindingId: 'binding-a', agent: 'claude', nativeSessionId: 'native-a', credential: 'binding-secret' }
    : { status: 'NEW', batchId: 'batch-ordinary', notificationId: 'notice-ordinary' });
  await joinV2(f);
  for (const flags of [[], ['--scope', 'ordinary']]) {
    await f.run('wait', ...binding, ...flags);
    assert.deepEqual(f.calls.at(-1).body.notificationScopes, ['ordinary']);
    assert.equal(f.calls.at(-1).body.workId, undefined);
  }
  const callCount = f.calls.length;
  for (const flags of [
    ['--scope', 'all'], ['--scope', 'work'], ['--scope', 'unknown'],
    ['--scope', 'ordinary', '--work', 'work-a'], ['--work', 'work-a'],
  ]) await assert.rejects(f.run('wait', ...binding, ...flags), error => error.code === 'INVALID_INPUT');
  assert.equal(f.calls.length, callCount);
  await f.run('wait', ...binding, '--scope', 'all', '--work', 'work-a');
  const state = JSON.parse(await readFile(f.clientPath, 'utf8')).v2;
  assert.equal(state.batchId, 'batch-ordinary');
  assert.equal(state.notificationId, 'notice-ordinary');
});

test('native final keeps exact text and claim through an unknown result', async t => {
  let first = true;
  const f = await fixture(t, ({ path }) => path.endsWith('/join') ? { bindingId: 'binding-a', agent: 'claude', nativeSessionId: 'native-a', credential: 'binding-secret' }
    : path.endsWith('/post') ? { roomId: first ? (first = false, 'wrong-room') : 'room-a', deliveryId: 'delivery-a', replyId: 'reply-a' } : {});
  await joinV2(f);
  const file = join(f.runtimeDir, 'final.txt'); await writeFile(file, 'Original final');
  const args = ['post', ...binding, '--delivery', 'delivery-a', '--claim', 'claim-a', '--file', file];
  await assert.rejects(f.run(...args), error => error.code === 'INVALID_RESPONSE');
  const original = f.calls.at(-1).body;
  await writeFile(file, 'Changed final');
  await assert.rejects(f.run(...args), error => error.code === 'ID_CONFLICT');
  await writeFile(file, 'Original final');
  await f.run(...args);
  assert.deepEqual(f.calls.at(-1).body, original);
  assert.equal(f.calls.at(-1).auth, 'Bearer binding-secret');
});

test('definitive work rejection permits a corrected new operation while unknown retains its original ID and payload', async t => {
  let requests = 0;
  const f = await fixture(t, ({ path, body }) => {
    if (path.endsWith('/join')) return { bindingId: 'binding-a', agent: 'claude', nativeSessionId: 'native-a', credential: 'binding-secret' };
    if (path.endsWith('/requests')) {
      requests++;
      if (requests === 1) return { __error: { code: 'INVALID_INPUT', outcome: 'rejected', status: 400 } };
      if (requests === 2) return { __error: { code: 'RECOVERY_REQUIRED', outcome: 'unknown', status: 503 } };
    }
    return { operationId: body.operationId, requestId: 'request-one' };
  });
  await joinV2(f);
  const file = join(f.runtimeDir, 'request.txt');
  const args = ['work-request', ...binding, '--work', 'work-a', '--to-binding', 'binding-peer', '--kind', 'review_request', '--file', file];
  await writeFile(file, 'Invalid first draft');
  await assert.rejects(f.run(...args), error => error.code === 'INVALID_INPUT' && error.outcome === 'rejected');
  const rejected = f.calls.at(-1).body;
  await writeFile(file, 'Corrected request');
  await assert.rejects(f.run(...args), error => error.code === 'RECOVERY_REQUIRED' && error.outcome === 'unknown');
  const unknown = f.calls.at(-1).body;
  assert.notEqual(unknown.operationId, rejected.operationId);
  assert.equal(unknown.text, 'Corrected request');
  await writeFile(file, 'Another changed request');
  const count = f.calls.length;
  await assert.rejects(f.run(...args), error => error.code === 'ID_CONFLICT');
  assert.equal(f.calls.length, count, 'an unknown operation cannot be silently replaced over HTTP');
  await writeFile(file, 'Corrected request');
  await f.run(...args);
  assert.deepEqual(f.calls.at(-1).body, unknown);
});
