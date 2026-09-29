#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrokerServer, API_VERSION } from './src/broker-server.mjs';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ROLES = new Set(['codex', 'claude']);
const OPTIONS = {
  serve: ['runtime', 'port', 'api-version'], migrate: ['runtime'], join: ['runtime', 'as', 'session', 'label', 'renew'],
  wait: ['runtime', 'as', 'binding', 'request'], read: ['runtime', 'as', 'binding', 'request', 'batch', 'claim'],
  post: ['runtime', 'as', 'binding', 'delivery', 'file', 'claim', 'done'], status: ['runtime', 'as', 'binding'],
};
const BOOLEAN = new Set(['renew', 'done']);
function error(code, message) { return Object.assign(new Error(message), { code }); }
function validId(value, name) { if (typeof value !== 'string' || !ID.test(value)) throw error('INVALID_INPUT', `${name} must be an explicit stable ID.`); return value; }
function argsOf(args) {
  const [command, ...rest] = args;
  if (!OPTIONS[command]) throw error('INVALID_INPUT', 'Commands: serve, join, wait, read, post, status.');
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw error('INVALID_INPUT', 'Use named flags; text must be supplied with --file.');
    const key = rest[i] === '--runtime-dir' ? 'runtime' : rest[i].slice(2);
    if (!OPTIONS[command].includes(key) || Object.hasOwn(flags, key)) throw error('INVALID_INPUT', `Unknown or repeated flag: --${key}`);
    if (BOOLEAN.has(key)) flags[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw error('INVALID_INPUT', `Missing value for --${key}`);
      flags[key] = value;
    }
  }
  return { command, flags, runtimeDir: resolve(flags.runtime ?? join(PROJECT, 'runtime')) };
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
function clientFile(runtimeDir, bindingId) { return join(runtimeDir, 'clients', `${createHash('sha256').update(bindingId).digest('hex')}.json`); }
function withState(runtimeDir, bindingId, action) {
  const file = clientFile(runtimeDir, bindingId);
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`, nonce = randomUUID();
  let held = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 }); held = true; break; }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      try {
        const before = fs.readFileSync(lock, 'utf8'), owner = JSON.parse(before);
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw error('CLI_BUSY', 'Local helper state needs inspection.');
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
        if (alive || fs.readFileSync(lock, 'utf8') !== before) throw error('CLI_BUSY', 'Another helper is saving state; retry the same command.');
        fs.unlinkSync(lock);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  if (!held) throw error('CLI_BUSY', 'Another helper is saving state; retry the same command.');
  try {
    let state = null;
    try { state = readJson(file); } catch (e) { if (e.code !== 'ENOENT') throw error('LOCAL_STATE_UNSAFE', 'Local helper state is unreadable; retain the files and rejoin the exact session.'); }
    const { state: next, value } = action(state);
    if (next !== undefined) atomicJson(file, next);
    return value;
  } finally { try { if (readJson(lock).nonce === nonce) fs.unlinkSync(lock); } catch {} }
}
function connection(runtimeDir, role, allowLegacy = false) {
  let value;
  try { value = readJson(join(runtimeDir, `connection-${role}.json`)); }
  catch { throw error('BROKER_UNAVAILABLE', 'Start the broker, then join this exact native session.'); }
  const url = new URL(value.baseUrl);
  if ((value.apiVersion !== API_VERSION && !(allowLegacy && value.apiVersion === 'agent-chat.window.v2')) || value.agent !== role || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw error('LOCAL_STATE_UNSAFE', 'Invalid local broker descriptor.');
  return value;
}
function loadState(runtimeDir, role, bindingId, descriptor) {
  let state;
  try { state = readJson(clientFile(runtimeDir, bindingId)); }
  catch { throw error('JOIN_REQUIRED', 'Join the exact native session first.'); }
  if (state.agent !== role || state.bindingId !== bindingId) throw error('FORBIDDEN', 'This credential belongs to a different exact binding.');
  return state;
}
function requestJson(baseUrl, path, credential, body, { wait = false, signal } = {}) {
  return new Promise((yes, no) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(path, baseUrl), { method: encoded ? 'POST' : 'GET', headers: { Authorization: `Bearer ${credential}`, ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}) }, signal }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', data => { bytes += data.length; if (bytes > 8 * 1024 * 1024) { res.destroy(); no(error('RESPONSE_TOO_LARGE', 'Reply was not consumed; inspect broker state before retrying.')); } else chunks.push(data); });
      res.on('error', () => no(error('CONNECTION_LOST', 'Connection lost. Keep the same command and IDs; do not generate another reply.')));
      res.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return no(error('CONNECTION_LOST', 'No complete broker result. Retry the same command and IDs.')); }
        if (value.apiVersion !== API_VERSION) return no(error('VERSION_MISMATCH', 'Broker version does not match this helper.'));
        if (!value.ok) return no(Object.assign(error(value.error?.code ?? 'BROKER_ERROR', value.error?.message ?? 'Broker rejected the request.'), { outcome: value.error?.outcome }));
        yes(value.result);
      });
    });
    // The broker owns the finite lease deadline. No socket timer, polling, or automatic rearm for wait.
    if (!wait) req.setTimeout(30000, () => req.destroy(error('CONNECTION_LOST', 'Operation timed out. Retry the same command and IDs.')));
    req.on('error', cause => no(cause.code === 'ABORT_ERR' ? error('WAIT_CANCELLED', 'Helper stopped; no native turn was cancelled.') : error(cause.code === 'CONNECTION_LOST' ? cause.code : 'CONNECTION_LOST', 'Broker connection failed. Retain the original command and IDs.')));
    req.end(encoded);
  });
}

export async function runCli(args, { stdout = text => process.stdout.write(text), signal } = {}) {
  if (args.includes('--room') || args[0]?.startsWith('work-')) {
    const { runV2Cli } = await import('./src/v2-cli.mjs');
    return runV2Cli(args, { stdout, signal, projectDir: PROJECT });
  }
  const { command, flags, runtimeDir } = argsOf(args);
  const print = result => { stdout(`${JSON.stringify(result, null, 2)}\n`); return result; };
  if (command === 'migrate') {
    const { migrateV1 } = await import('./src/v2-migrate.mjs');
    return print(await migrateV1({ runtimeDir }));
  }
  if (command === 'serve') {
    const port = flags.port === undefined ? 0 : Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw error('INVALID_INPUT', 'Invalid --port.');
    const { createCodexTransport } = await import('./src/codex-transport.mjs');
    const codexTransport = await createCodexTransport({ projectDir: PROJECT, runtimeDir });
    const api = flags['api-version'] ?? 'v2';
    if (!['v1', 'v2'].includes(api)) throw error('INVALID_INPUT', '--api-version must be v1 or v2.');
    if (api === 'v2') {
      if (fs.existsSync(join(runtimeDir, 'broker-state.jsonl')) && !fs.existsSync(join(runtimeDir, 'v2-state.sqlite'))) throw error('MIGRATION_REQUIRED', 'Stop the old writer and run the verified offline migration before using v2 with existing history.');
      const { V2Broker } = await import('./src/v2-broker.mjs');
      const { WorkCoordinator } = await import('./src/v2-work.mjs');
      const { createV2Server } = await import('./src/v2-server.mjs');
      const { loadNativeReceiveProof } = await import('./src/native-receive-proof.mjs');
      const receiveProof = await loadNativeReceiveProof({ runtimeDir, projectDir: PROJECT });
      const broker = await V2Broker.open({ runtimeDir, codexTransport });
      let work, server;
      let resourcesClosing = null;
      const closeResources = () => resourcesClosing ??= (async () => {
        broker.beginShutdown();
        await work?.close(); await broker.close(); await codexTransport.close?.();
      })();
      const close = async () => { await server?.close(); await closeResources(); };
      try {
        work = await WorkCoordinator.attach(broker, {
          transport: codexTransport, codexReceiveMode: receiveProof.codexReceiveMode,
          codexReceiveModeProvider: async () => (await loadNativeReceiveProof({ runtimeDir, projectDir: PROJECT })).codexReceiveMode,
        });
        server = await createV2Server({ broker, work, runtimeDir, projectDir: PROJECT, port, onShutdown: closeResources,
          onShutdownFailure: () => process.exit(1) });
      }
      catch (cause) { await work?.close(); await broker.close(); await codexTransport.close?.(); throw cause; }
      print({ status: 'LISTENING', apiVersion: 'agent-chat.window.v2', url: server.url, workspaceId: broker.workspaceId, runtimeDir, nativeReceive: receiveProof });
      signal?.addEventListener('abort', () => { void close(); }, { once: true });
      return { server, broker, work, close };
    }
    if (fs.existsSync(join(runtimeDir, 'v2-state.sqlite'))) throw error('MIGRATION_ALREADY_ACTIVE', 'This runtime contains v2 data. Do not start the old writer against its pre-migration journal.');
    const { Broker } = await import('./src/broker.mjs');
    const broker = await Broker.open({ runtimeDir, codexTransport });
    let server;
    try { server = await createBrokerServer({ broker, runtimeDir, projectDir: PROJECT, port }); }
    catch (cause) { await broker.close(); await codexTransport.close?.(); throw cause; }
    print({ status: 'LISTENING', url: server.url, roomId: server.roomId, runtimeDir });
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await server.close(); await broker.close(); await codexTransport.close?.(); };
    signal?.addEventListener('abort', () => { void close(); }, { once: true });
    return { server, broker, close };
  }
  const role = flags.as;
  if (!ROLES.has(role)) throw error('INVALID_INPUT', '--as must be codex or claude; there is no CLI human role.');
  const descriptor = connection(runtimeDir, role, ['post', 'status'].includes(command));
  if (command === 'join') {
    const nativeSessionId = validId(flags.session, '--session');
    const result = await requestJson(descriptor.baseUrl, '/agent/v1/join', descriptor.enrollmentToken, { agent: role, nativeSessionId, label: flags.label ?? role, renew: flags.renew ?? false }, { signal });
    validId(result.bindingId, 'bindingId');
    if (typeof result.credential !== 'string' || result.agent !== role || result.nativeSessionId !== nativeSessionId) throw error('INVALID_RESPONSE', 'Join identity could not be verified.');
    withState(runtimeDir, result.bindingId, prior => {
      if (prior && (prior.agent !== role || prior.nativeSessionId !== nativeSessionId)) throw error('FORBIDDEN', 'Binding identity changed.');
      const state = { ...prior, schema: 1, agent: role, nativeSessionId, bindingId: result.bindingId, instanceId: descriptor.instanceId, roomId: descriptor.roomId, baseUrl: descriptor.baseUrl, credential: result.credential, claims: prior?.claims ?? {}, posts: prior?.posts ?? {}, recoverableClaimId: result.recoverableClaimId ?? null };
      if (prior?.instanceId !== descriptor.instanceId) { state.pendingWait = null; state.pendingRead = null; state.batchId = result.batchId ?? null; }
      else if (result.batchId) state.batchId = result.batchId;
      return { state, value: null };
    });
    const { credential, ...safe } = result;
    return print({ ...safe, next: `node chat.mjs ${role === 'claude' ? 'wait' : 'status'} --as ${role} --binding ${result.bindingId}` });
  }
  const bindingId = validId(flags.binding, '--binding');
  let state = loadState(runtimeDir, role, bindingId, descriptor);
  if (state.instanceId !== descriptor.instanceId || state.baseUrl !== descriptor.baseUrl) {
    // Reconnect an exact persisted binding without making the old session current again.
    const bound = await requestJson(descriptor.baseUrl, '/agent/v1/status', state.credential, undefined, { signal });
    if (bound.bindingId !== bindingId || bound.agent !== role || (bound.binding?.nativeSessionId ?? bound.nativeSessionId) !== state.nativeSessionId) throw error('FORBIDDEN', 'Persisted binding identity could not be verified after restart.');
    state = withState(runtimeDir, bindingId, current => {
      current.instanceId = descriptor.instanceId; current.baseUrl = descriptor.baseUrl;
      current.pendingWait = null; current.batchId = bound.batchId ?? null;
      current.recoverableClaimId = bound.recoverableClaimId ?? null;
      return { state: current, value: current };
    });
  }
  if (command === 'status') return print(await requestJson(state.baseUrl, '/agent/v1/status', state.credential, undefined, { signal }));
  if (command === 'wait') {
    if (role !== 'claude') throw error('INVALID_INPUT', 'Codex uses native push; it does not arm a pull wait.');
    const body = withState(runtimeDir, bindingId, current => {
      const requestId = flags.request ? validId(flags.request, '--request') : current.pendingWait?.requestId ?? randomUUID();
      if (current.pendingWait && current.pendingWait.requestId !== requestId) throw error('ID_CONFLICT', 'A wait request is pending. Retry it with its original request ID.');
      current.pendingWait = { requestId }; return { state: current, value: current.pendingWait };
    });
    const result = await requestJson(state.baseUrl, '/agent/v1/wait', state.credential, body, { wait: true, signal });
    withState(runtimeDir, bindingId, current => {
      if (current.pendingWait?.requestId === body.requestId) current.pendingWait = null;
      if (['NEW', 'NOTICE_PENDING'].includes(result.status)) {
        if (result.status === 'NEW' && current.pendingRead?.batchId !== result.batchId) current.pendingRead = null;
        current.batchId = result.batchId; current.notificationId = result.notificationId;
      }
      return { state: current, value: null };
    });
    return print(result);
  }
  if (command === 'read') {
    const body = withState(runtimeDir, bindingId, current => {
      if (current.pendingRead) {
        for (const [flag, field] of [['request', 'requestId'], ['batch', 'batchId'], ['claim', 'claimId']]) if (flags[flag] !== undefined && flags[flag] !== current.pendingRead[field]) throw error('ID_CONFLICT', 'Retry the pending read with its original IDs.');
        return { value: current.pendingRead };
      }
      const request = { requestId: flags.request ? validId(flags.request, '--request') : randomUUID() };
      if (flags.batch ?? current.batchId) request.batchId = validId(flags.batch ?? current.batchId, '--batch');
      else if (!flags.claim) throw error('INVALID_INPUT', 'A prior NEW batch or an explicitly restored --claim is required.');
      if (flags.claim) request.claimId = validId(flags.claim, '--claim');
      current.pendingRead = request; return { state: current, value: request };
    });
    const result = await requestJson(state.baseUrl, '/agent/v1/read', state.credential, body, { signal });
    withState(runtimeDir, bindingId, current => {
      if (result.status === 'DELIVERY') {
        if (result.bindingId !== bindingId) throw error('INVALID_RESPONSE', 'Delivery belongs to a different binding.');
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
    const deliveryId = validId(flags.delivery, '--delivery');
    if (!flags.file) throw error('INVALID_INPUT', '--file must name the UTF-8 response file. It is kept unchanged.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(resolve(flags.file))); }
    catch { throw error('INVALID_INPUT', 'Cannot read --file as UTF-8. The claim remains open.'); }
    const body = withState(runtimeDir, bindingId, current => {
      const claimId = flags.claim ? validId(flags.claim, '--claim') : current.claims[deliveryId]?.claimId ?? null;
      if (role === 'claude' && claimId === null) throw error('CLAIM_REQUIRED', 'Read the delivery first, or supply its original --claim ID.');
      const request = { deliveryId, claimId, text, attachmentIds: [], done: flags.done ?? false };
      const previous = current.posts[deliveryId];
      if (previous && JSON.stringify(previous.request) !== JSON.stringify(request)) throw error('ID_CONFLICT', 'A different final is already saved for this delivery. Original file and final are retained.');
      current.posts[deliveryId] = previous ?? { request, committed: false };
      return { state: current, value: request };
    });
    const result = await requestJson(state.baseUrl, '/agent/v1/post', state.credential, body, { signal });
    withState(runtimeDir, bindingId, current => {
      current.posts[deliveryId].committed = true;
      const claim = current.claims[deliveryId];
      if (claim) { claim.finalPosted = true; if (current.pendingRead?.requestId === claim.requestId) current.pendingRead = null; }
      return { state: current, value: null };
    });
    return print(result);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try { await runCli(process.argv.slice(2), { signal: controller.signal }); }
  catch (cause) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: cause.code ?? 'LOCAL_ERROR', message: cause.code ? cause.message : 'Local helper failed; preserve runtime files and inspect the broker.' } })}\n`);
    process.exitCode = 1;
  }
}
