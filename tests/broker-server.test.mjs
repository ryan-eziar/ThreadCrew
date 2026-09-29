import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrokerServer, API_VERSION } from '../src/broker-server.mjs';
import { runCli } from '../chat.mjs';
import { Broker } from '../src/broker.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
class FakeBroker extends EventEmitter {
  calls = []; bindings = new Map(); reads = []; posts = new Map(); stopped = false; failRead = false; failPost = false;
  data = { instanceId: `test-${randomUUID()}`, seq: 0, room: { id: 'test-room', gate: { segmentId: 'seg1', version: 1 } }, members: [], messages: [], deliveries: [], replies: [] };
  snapshot() { return structuredClone(this.data); }
  change() { this.data.seq++; this.emit('change', this.snapshot()); }
  async postMessage(body) { this.calls.push(['message', body]); this.change(); return { operationId: body.operationId, messageId: 'message1' }; }
  async startExchange(body) { this.calls.push(['exchange', body]); return { operationId: body.operationId }; }
  async stop(body) { this.stopped = true; this.calls.push(['stop', body]); this.change(); return { operationId: body.operationId }; }
  async abandonDelivery(id, body) { this.calls.push(['abandon', id, body]); return { deliveryId: id }; }
  async resendDelivery(id, body) { this.calls.push(['resend', id, body]); return { deliveryId: id }; }
  getOperation(id) { return { status: 'not_found', operationId: id }; }
  readAttachment(id, cursor) { return { attachmentId: id, text: cursor ?? 'plain <b>text</b>', nextCursor: null }; }
  async join(body) {
    const bindingId = `${body.agent}-${body.nativeSessionId}`;
    const binding = { id: bindingId, nativeSessionId: body.nativeSessionId, label: body.label ?? body.agent, source: 'manual', joinedAt: new Date().toISOString() };
    this.bindings.set(bindingId, { ...binding, bindingId, agent: body.agent });
    this.data.members = this.data.members.filter(m => m.agent !== body.agent).concat({ agent: body.agent, binding, state: 'unarmed' });
    return { bindingId, binding, batchId: null, recoverableClaimId: null };
  }
  getBinding(id) { return this.bindings.get(id); }
  async wait(id, { requestId, signal }) {
    this.calls.push(['wait', id, requestId]);
    if (this.holdWait) return new Promise(resolve => signal.addEventListener('abort', () => { this.waitAborted = true; resolve({ status: 'CANCELLED' }); }, { once: true }));
    return { status: 'NEW', notificationId: 'notification1', batchId: 'batch1' };
  }
  async read(id, body, writer) {
    this.reads.push({ id, ...body });
    if (this.failRead) { this.failRead = false; throw Object.assign(new Error('sensitive native exception'), { code: 'RECOVERY_REQUIRED', outcome: 'unknown' }); }
    if (this.stopped) return { status: 'PAUSED' };
    const result = { status: 'DELIVERY', deliveryId: 'delivery1', claimId: 'claim1', bindingId: id, batchId: body.batchId, segmentId: 'seg1', exchangeId: null, round: null, text: 'synthetic body', attachmentIds: [], attachments: [] };
    if (this.ungated) return result;
    assert.equal(writer(result)?.then, undefined, 'handoff callback must be synchronous');
    return result;
  }
  async postReply(id, body) {
    const old = this.posts.get(body.deliveryId);
    if (old) assert.deepEqual(old, { id, body }); else this.posts.set(body.deliveryId, { id, body });
    if (this.failPost) { this.failPost = false; throw Object.assign(new Error('private native error'), { code: 'RECOVERY_REQUIRED', outcome: 'unknown' }); }
    return { replyId: 'reply1', deliveryId: body.deliveryId };
  }
}
async function fixture(t, { real = false } = {}) {
  await mkdir(join(project, 'work'), { recursive: true });
  const dir = await mkdtemp(join(project, 'work', 'broker-server-test-'));
  await mkdir(join(dir, 'ui')); await writeFile(join(dir, 'ui', 'index.html'), '<!doctype html><html><head></head><body><script src="app.js"></script></body></html>');
  await writeFile(join(dir, 'ui', 'app.js'), 'window.fixture=true');
  const runtimeDir = join(dir, 'runtime');
  const broker = real ? await Broker.open({ runtimeDir, roomId: 'test-room' }) : new FakeBroker();
  const server = await createBrokerServer({ broker, runtimeDir, projectDir: dir });
  const instances = [{ server, broker }];
  t.after(async () => { for (const item of instances.toReversed()) { await item.server.close(); await item.broker.close?.(); } await rm(dir, { recursive: true, force: true }); });
  const token = server.credentials().humanToken;
  const path = `/api/v1/rooms/${server.roomId}`;
  const human = (suffix, body, overrides = {}) => fetch(`${server.url}${path}${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { Origin: server.url, 'Content-Type': 'application/json' }), ...overrides }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const enrollment = async role => JSON.parse(await readFile(join(runtimeDir, `connection-${role}.json`), 'utf8'));
  const agent = (suffix, credential, body, options = {}) => fetch(`${server.url}/agent/v1/${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
  const joinAgent = async (role = 'claude', session = 'native1') => (await (await agent('join', (await enrollment(role)).enrollmentToken, { agent: role, nativeSessionId: session, label: role })).json()).result;
  return { dir, runtimeDir, server, broker, token, human, enrollment, agent, joinAgent, instances };
}
const message = { operationId: 'op1', expectedGate: { segmentId: 'seg1', version: 1 }, recipients: ['claude'], text: 'synthetic', attachmentIds: [] };

test('exchange finish policy is optional, explicitly forwarded and rejects unknown policies', async t => {
  const f = await fixture(t);
  const body = { operationId: 'exchange-policy', expectedGate: message.expectedGate, baseMessageId: 'message1', baseReplyIds: { codex: 'reply-codex', claude: 'reply-claude' }, previousExchangeId: null, maxRounds: 3, finishPolicy: 'both_same_round' };
  assert.equal((await f.human('/exchanges', body)).status, 200);
  assert.equal(f.broker.calls.at(-1)[1].finishPolicy, 'both_same_round');
  const { finishPolicy, ...legacy } = body;
  assert.equal((await f.human('/exchanges', legacy)).status, 200);
  const calls = f.broker.calls.length;
  assert.equal((await f.human('/exchanges', { ...body, finishPolicy: 'infer_from_text' })).status, 400);
  assert.equal(f.broker.calls.length, calls);
  const html = await (await fetch(f.server.url)).text();
  assert.match(html, /discussionFinishPolicies/);
});

test('bootstrap token is ephemeral HTML data; descriptors never contain it', async t => {
  const f = await fixture(t);
  const response = await fetch(f.server.url);
  const html = await response.text();
  assert.match(html, /window\.__AGENT_CHAT__=/);
  assert.ok(html.includes(f.token));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const role of ['codex', 'claude']) {
    const descriptor = await f.enrollment(role);
    assert.equal(descriptor.agent, role); assert.equal(descriptor.humanToken, undefined);
    assert.ok(!JSON.stringify(descriptor).includes(f.token));
  }
  assert.equal((await fetch(`${f.server.url}/runtime/connection-claude.json`)).status, 404);
  assert.equal((await fetch(`${f.server.url}/?token=${f.token}`)).status, 404);
});

test('bootstrap uses the real head tag, ignoring comments, attributes and raw-text examples', async t => {
  const f = await fixture(t);
  const before = '<!doctype html><!-- documentation: <head> -->\n<html data-example="<head>"><HeAd data-title="a > b">';
  const after = '<title>Example <head></title></HeAd><body><script>const example = "<head>";</script><textarea><head></textarea></body></html>';
  await writeFile(join(f.dir, 'ui', 'index.html'), before + after);
  const response = await fetch(f.server.url); assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.startsWith(before + '<script nonce="'));
  assert.ok(html.endsWith(after));
  assert.equal(html.match(/window\.__AGENT_CHAT__=/g).length, 1);
});

test('missing or duplicate head tags produce an explicit error without exposing a bootstrap token', async t => {
  const f = await fixture(t);
  for (const html of ['<!-- only a <head> example --><html><body>Missing</body></html>', '<html><head></head><head></head><body>Duplicate</body></html>', '<html><body><head></head></body></html>']) {
    await writeFile(join(f.dir, 'ui', 'index.html'), html);
    const response = await fetch(f.server.url); assert.equal(response.status, 500);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, 'UI_BOOTSTRAP_INVALID');
    assert.ok(!text.includes(f.token));
  }
});

test('human auth, agent separation, exact Host and same-origin mutation checks fail before broker', async t => {
  const f = await fixture(t); const joined = await f.joinAgent();
  assert.equal((await f.human('/snapshot')).status, 200);
  assert.equal((await f.human('/snapshot', undefined, { Authorization: '' })).status, 401);
  assert.equal((await f.human('/snapshot', undefined, { Authorization: `Bearer ${joined.credential}` })).status, 403);
  assert.equal((await f.human('/messages', message, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await f.human('/messages', message, { Origin: '' })).status, 403);
  const wrongHost = await new Promise((resolveResult, reject) => {
    const req = http.get(`${f.server.url}/api/v1/rooms/test-room/snapshot`, { headers: { Host: 'evil.example', Authorization: `Bearer ${f.token}` } }, response => { response.resume(); resolveResult(response.statusCode); });
    req.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await f.agent('post', f.token, { deliveryId: 'd1', claimId: null, text: 'x', done: false, attachmentIds: [] })).status, 403);
  assert.equal(f.broker.calls.length, 0);
});

test('cross-role enrollment and credential chosen binding cannot be overridden', async t => {
  const f = await fixture(t); const joined = await f.joinAgent();
  assert.equal((await f.agent('join', (await f.enrollment('claude')).enrollmentToken, { agent: 'codex', nativeSessionId: 'native2' })).status, 403);
  const response = await f.agent('read', joined.credential, { requestId: 'read1', batchId: 'batch1', bindingId: 'other' });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'UNKNOWN_FIELD');
  assert.equal((await f.agent('join', joined.credential, { agent: 'claude', nativeSessionId: 'other' })).status, 403);
  const again = await f.joinAgent(); assert.equal(again.credential, joined.credential);
  const next = await f.joinAgent('claude', 'native2'); assert.notEqual(next.credential, joined.credential);
  const old = await (await f.agent('status', joined.credential)).json();
  assert.equal(old.result.nativeSessionId, 'native1'); assert.ok(!JSON.stringify(old).includes('native2'));
});

test('unknown control fields, nested gate fields and oversized JSON are rejected without actions', async t => {
  const f = await fixture(t);
  for (const body of [{ ...message, from: 'ryan' }, { ...message, expectedGate: { ...message.expectedGate, force: true } }]) {
    const response = await f.human('/messages', body); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'UNKNOWN_FIELD');
  }
  assert.equal((await f.human('/messages', { ...message, text: '😀'.repeat(70000) })).status, 413);
  assert.equal((await f.human('/messages', 'null')).status, 400);
  assert.equal(f.broker.calls.length, 0);
  assert.equal((await f.human('/messages', message)).status, 200);
  assert.equal(f.broker.calls.length, 1);
});

test('human routes delegate exact operation IDs and opaque attachments; queries cannot read paths', async t => {
  const f = await fixture(t);
  await f.human('/deliveries/d1/abandon', { operationId: 'a1', expectedDeliveryVersion: 2, expectedClaimId: 'c1' });
  await f.human('/deliveries/d1/resend', { operationId: 'r1', expectedGate: message.expectedGate, expectedDeliveryVersion: 3, acknowledgePossibleDuplicate: true });
  assert.equal(f.broker.calls[0][0], 'abandon'); assert.equal(f.broker.calls[1][0], 'resend');
  const operation = await (await f.human('/operations/op1')).json(); assert.equal(operation.result.operationId, 'op1');
  const attachment = await (await f.human('/attachments/att1/text?cursor=opaque1')).json(); assert.equal(attachment.result.text, 'opaque1');
  assert.equal((await f.human('/attachments/att1/text?path=C%3A%5Csecret')).status, 400);
});

test('SSE sends full current snapshot and changes, never starts work', async t => {
  const f = await fixture(t); const controller = new AbortController();
  const response = await fetch(`${f.server.url}/api/v1/rooms/test-room/events?after=old:5`, { headers: { Authorization: `Bearer ${f.token}` }, signal: controller.signal });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /event: snapshot/); assert.match(first, /"seq":0/);
  f.broker.change();
  const second = new TextDecoder().decode((await reader.read()).value); assert.match(second, /"seq":1/);
  controller.abort(); await reader.cancel().catch(() => {});
  assert.equal(f.broker.calls.length, 0);
});

test('read writes DELIVERY only inside synchronous gate callback; stopped/ungated content is not returned', async t => {
  const f = await fixture(t); const joined = await f.joinAgent();
  const body = { requestId: 'read1', batchId: 'batch1' };
  let response = await f.agent('read', joined.credential, body);
  assert.equal((await response.json()).result.text, 'synthetic body');
  f.broker.stopped = true; response = await f.agent('read', joined.credential, body);
  assert.deepEqual((await response.json()).result, { status: 'PAUSED' });
  f.broker.stopped = false; f.broker.ungated = true;
  response = await f.agent('read', joined.credential, body);
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('synthetic body'));
});

test('request disconnect aborts quiet wait, without waking or posting another message', async t => {
  const f = await fixture(t); const joined = await f.joinAgent(); f.broker.holdWait = true;
  const controller = new AbortController();
  const request = f.agent('wait', joined.credential, { requestId: 'wait1' }, { signal: controller.signal }).catch(() => null);
  for (let i = 0; i < 50 && !f.broker.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.broker.calls[0][0], 'wait'); controller.abort(); await request;
  for (let i = 0; i < 50 && !f.broker.waitAborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.broker.waitAborted, true); assert.equal(f.broker.calls.length, 1);
});

test('static assets cannot traverse out of ui or follow an escaping junction', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'secret.js'), 'not a ui asset');
  await mkdir(join(f.dir, 'outside')); await writeFile(join(f.dir, 'outside', 'leak.js'), 'secret');
  await symlink(join(f.dir, 'outside'), join(f.dir, 'ui', 'escaped'), 'junction');
  assert.equal((await fetch(`${f.server.url}/escaped/leak.js`)).status, 404);
  assert.equal((await fetch(`${f.server.url}/%2e%2e/secret.js`)).status, 404);
  assert.equal((await fetch(`${f.server.url}/app.js`)).status, 200);
});

test('CLI retains read request, claim, and full final across uncertain responses and idempotent retries', async t => {
  const f = await fixture(t); const output = [];
  const invoke = args => runCli([...args, '--runtime-dir', f.runtimeDir], { stdout: text => output.push(text) });
  const joined = await invoke(['join', '--as', 'claude', '--session', 'native1']);
  assert.ok(!output.join('').includes((await f.joinAgent()).credential));
  const binding = ['--as', 'claude', '--binding', joined.bindingId];
  await invoke(['wait', ...binding]);
  f.broker.failRead = true;
  await assert.rejects(invoke(['read', ...binding]), { code: 'RECOVERY_REQUIRED' });
  const delivery = await invoke(['read', ...binding]);
  await invoke(['read', ...binding]);
  assert.equal(new Set(f.broker.reads.map(read => read.requestId)).size, 1);
  assert.equal(delivery.claimId, 'claim1');
  const replyFile = join(f.dir, 'reply.txt'); const text = '合成😀回复\n'.repeat(6000);
  await writeFile(replyFile, text); f.broker.failPost = true;
  const post = ['post', ...binding, '--delivery', delivery.deliveryId, '--file', replyFile];
  await assert.rejects(invoke(post), { code: 'RECOVERY_REQUIRED' });
  await invoke(post); await invoke(post);
  assert.equal(f.broker.posts.size, 1); assert.equal(f.broker.posts.get(delivery.deliveryId).body.text, text);
  assert.equal(await readFile(replyFile, 'utf8'), text);
  await writeFile(replyFile, 'different'); await assert.rejects(invoke(post), { code: 'ID_CONFLICT' });
  await assert.rejects(invoke(['status', '--as', 'ryan', '--binding', joined.bindingId]), { code: 'INVALID_INPUT' });
});

test('real broker HTTP/CLI saves messages, one claim/final, complete long text, and fresh read IDs after final', async t => {
  const f = await fixture(t, { real: true });
  const invoke = args => runCli([...args, '--runtime-dir', f.runtimeDir], { stdout() {} });
  const joined = await invoke(['join', '--as', 'claude', '--session', 'native-synthetic']);
  const binding = ['--as', 'claude', '--binding', joined.bindingId];
  const gate = f.broker.snapshot().room.gate;
  const body = { ...message, expectedGate: gate };
  const saved = await (await f.human('/messages', body)).json(); assert.equal(saved.ok, true);
  const duplicate = await (await f.human('/messages', body)).json(); assert.deepEqual(duplicate.result, saved.result);
  const notice = await invoke(['wait', ...binding]); assert.equal(notice.status, 'NEW');
  const claimed = await invoke(['read', ...binding]); assert.equal(claimed.status, 'DELIVERY');
  const replay = await invoke(['read', ...binding]); assert.equal(replay.claimId, claimed.claimId);
  const file = join(f.dir, 'final.txt'); const finalText = '合成回复😀\n'.repeat(3000); await writeFile(file, finalText);
  const post = ['post', ...binding, '--delivery', claimed.deliveryId, '--file', file];
  const result = await invoke(post); const repeated = await invoke(post); assert.equal(repeated.replyId, result.replyId);
  const snapshot = f.broker.snapshot(); assert.equal(snapshot.messages.length, 1); assert.equal(snapshot.replies.length, 1);
  const attachmentId = snapshot.replies[0].content.attachmentId; assert.ok(attachmentId);
  let assembled = '', cursor;
  do {
    const response = await f.human(`/attachments/${attachmentId}/text${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    const chunk = (await response.json()).result; assembled += chunk.text; cursor = chunk.nextCursor;
  } while (cursor);
  assert.equal(assembled, finalText);
  const empty = await invoke(['read', ...binding]); assert.equal(empty.status, 'EMPTY');
  assert.equal(f.broker.snapshot().deliveries.length, 1);
});

test('restart rotates human token but exact old agent credentials can post late final without re-binding', async t => {
  const f = await fixture(t, { real: true });
  const invoke = args => runCli([...args, '--runtime-dir', f.runtimeDir], { stdout() {} });
  const old = await invoke(['join', '--as', 'claude', '--session', 'old-native']);
  const binding = ['--as', 'claude', '--binding', old.bindingId];
  const gate = f.broker.snapshot().room.gate;
  await f.human('/messages', { ...message, expectedGate: gate });
  await invoke(['wait', ...binding]); const claimed = await invoke(['read', ...binding]);
  await f.human('/stop', { operationId: 'stop1', expectedGate: f.broker.snapshot().room.gate });
  const current = await f.joinAgent('claude', 'new-native');
  await f.server.close(); await f.broker.close();
  const broker = await Broker.open({ runtimeDir: f.runtimeDir, roomId: 'test-room' });
  const server = await createBrokerServer({ broker, runtimeDir: f.runtimeDir, projectDir: f.dir }); f.instances.push({ broker, server });
  assert.notEqual(server.credentials().humanToken, f.token);
  const unauthorized = await fetch(`${server.url}/api/v1/rooms/test-room/snapshot`, { headers: { Authorization: `Bearer ${f.token}` } }); assert.equal(unauthorized.status, 403);
  const file = join(f.dir, 'late.txt'); await writeFile(file, 'SYNTHETIC late final');
  await invoke(['post', ...binding, '--delivery', claimed.deliveryId, '--file', file]);
  const snapshot = broker.snapshot(); assert.equal(snapshot.members.find(m => m.agent === 'claude').binding.id, current.bindingId);
  assert.equal(snapshot.replies.length, 1); assert.ok(snapshot.replies[0].lateReasons.includes('segment_stopped')); assert.ok(snapshot.replies[0].lateReasons.includes('binding_replaced'));
  await assert.rejects(invoke(['read', ...binding, '--claim', claimed.claimId]), { code: 'BINDING_INVALID' });
});
