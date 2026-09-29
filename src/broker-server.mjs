import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

// Shared validation/static-serving primitives for the separately versioned v2 adapter.
export { bearer, sameToken, secret, commonHeaders, identifier, fields, injectBootstrap, jsonBody, validateGate, atomicJson, rejectQuery };

export const API_VERSION = 'agent-chat.window.v1';
const MAX_BODY = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ROLES = new Set(['codex', 'claude']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const STATUS = { INVALID_INPUT: 400, UNKNOWN_FIELD: 400, AUTH_REQUIRED: 401, FORBIDDEN: 403, BINDING_INVALID: 403, NOT_FOUND: 404, ATTACHMENT_NOT_FOUND: 404, CONTENT_TOO_LARGE: 413, UI_BOOTSTRAP_INVALID: 500, JOURNAL_UNSAFE: 503, RECOVERY_REQUIRED: 503, CLOSED: 503 };
const PUBLIC_ERRORS = new Set([...Object.keys(STATUS), 'ID_CONFLICT', 'STATE_CONFLICT', 'DELIVERY_CHANGED', 'FINAL_ALREADY_PRESENT', 'MEMBER_NOT_READY', 'EXCHANGE_ACTIVE', 'BASE_REPLY_INVALID', 'ROOM_STOPPED', 'DUPLICATE_ACK_REQUIRED', 'ATTACHMENT_CHANGED', 'BINDING_REPLACED', 'INVALID_BINDING', 'WAIT_ACTIVE', 'WAIT_ALREADY_ACTIVE', 'CLAIM_REQUIRED', 'BATCH_LIMIT', 'BATCH_INVALID', 'WAIT_EXPIRED']);

function fail(code, message) { throw Object.assign(new Error(message ?? code), { code }); }
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_INPUT'); return value; }
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT'); return value; }
function fields(value, allowed, required = []) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('UNKNOWN_FIELD');
  if (required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
  return value;
}
function bearer(req) { const m = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization ?? ''); return m?.[1]; }
function sameToken(left, right) { return typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
function secret() { return randomBytes(32).toString('base64url'); }
function commonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}
function sendJson(res, result, status = 200) {
  if (res.destroyed || res.writableEnded) return false;
  commonHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, apiVersion: API_VERSION, result }));
  return true;
}
function sendError(res, error, mutationStarted = false) {
  if (res.headersSent || res.destroyed || res.writableEnded) { if (!res.writableEnded) res.destroy(); return; }
  const recognized = PUBLIC_ERRORS.has(error?.code);
  const code = recognized ? error.code : 'RECOVERY_REQUIRED';
  const outcome = error?.outcome === 'unknown' || (error?.outcome !== 'rejected' && mutationStarted && (!recognized || STATUS[code] === 503)) ? 'unknown' : 'rejected';
  commonHeaders(res);
  res.writeHead(STATUS[code] ?? 409, { 'Content-Type': 'application/json; charset=utf-8' });
  // Native exceptions and user payloads are deliberately not reflected here.
  const message = code === 'UI_BOOTSTRAP_INVALID' ? 'The window HTML must contain exactly one opening head tag. Fix the page and reload.' : outcome === 'unknown' ? 'The outcome is unknown. Check the original operation ID.' : 'The request was not completed. Check the current state and request fields.';
  res.end(JSON.stringify({ ok: false, apiVersion: API_VERSION, error: { code, message, outcome, retrySameOperation: outcome === 'unknown', details: {} } }));
}
function injectBootstrap(html, script) {
  // Read whole tags (including quoted attributes), ignoring comments and raw text.
  // Fail explicitly for a missing/ambiguous insertion point instead of serving an inert page.
  const tags = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z][a-z0-9:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  const rawText = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'template']);
  let insertion = null, bodySeen = false;
  for (let token; (token = tags.exec(html));) {
    const name = /^<([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(token[0])?.[1].toLowerCase();
    if (!name) continue;
    if (name === 'body') bodySeen = true;
    if (name === 'head') {
      if (insertion !== null || bodySeen) fail('UI_BOOTSTRAP_INVALID');
      insertion = tags.lastIndex;
    }
    if (rawText.has(name)) {
      const end = new RegExp(`</${name}\\s*>`, 'gi'); end.lastIndex = tags.lastIndex;
      if (!end.exec(html)) fail('UI_BOOTSTRAP_INVALID');
      tags.lastIndex = end.lastIndex;
    }
  }
  if (insertion === null) fail('UI_BOOTSTRAP_INVALID');
  return html.slice(0, insertion) + script + html.slice(insertion);
}
async function jsonBody(req, maxBytes = MAX_BODY) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) fail('INVALID_INPUT');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail('INVALID_INPUT');
  if (Number(req.headers['content-length']) > maxBytes) { req.resume(); fail('CONTENT_TOO_LARGE'); }
  const bytes = await new Promise((yes, no) => {
    let size = 0, finished = false; const chunks = [];
    req.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBytes) { finished = true; chunks.length = 0; no(Object.assign(new Error('Body limit'), { code: 'CONTENT_TOO_LARGE' })); return; }
      chunks.push(chunk);
    });
    req.once('end', () => { if (!finished) { finished = true; yes(Buffer.concat(chunks)); } });
    req.once('error', () => { if (!finished) { finished = true; no(Object.assign(new Error('Body incomplete'), { code: 'INVALID_INPUT' })); } });
    req.once('aborted', () => { if (!finished) { finished = true; no(Object.assign(new Error('Body incomplete'), { code: 'INVALID_INPUT' })); } });
  });
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch (error) { if (error.code) throw error; fail('INVALID_INPUT'); }
}
function validateGate(body) {
  if (!Object.hasOwn(body, 'expectedGate')) return;
  fields(body.expectedGate, ['segmentId', 'version'], ['segmentId', 'version']);
  identifier(body.expectedGate.segmentId);
  if (!Number.isSafeInteger(body.expectedGate.version) || body.expectedGate.version < 0) fail('INVALID_INPUT');
}
async function atomicJson(file, value) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => {}); }
}
function rejectQuery(url, allowed = []) { for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail('INVALID_INPUT'); }

/** A local presentation/CLI adapter. It never calls a model or implements routing policy. */
export async function createBrokerServer({ broker, runtimeDir, projectDir, port = 0 }) {
  if (!broker || !runtimeDir || !projectDir || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('broker, runtimeDir, projectDir and a valid port are required');
  const initial = await broker.snapshot();
  const roomId = identifier(initial.room.id);
  const instanceId = identifier(initial.instanceId);
  const humanToken = secret();
  const enrollments = new Map([...ROLES].map(role => [role, secret()]));
  const bindings = new Map();
  const streams = new Set();
  const aborts = new Set();
  const uiRoot = await realpath(join(resolve(projectDir), 'ui'));
  const root = resolve(runtimeDir);
  const credentialFile = join(root, 'agent-bindings.json');
  let credentialWrites = Promise.resolve();
  let baseUrl, authority, closing = false;

  try {
    const saved = JSON.parse(await readFile(credentialFile, 'utf8'));
    if (saved.schema !== 1 || saved.roomId !== roomId || !Array.isArray(saved.bindings)) fail('RECOVERY_REQUIRED');
    for (const entry of saved.bindings) {
      fields(entry, ['bindingId', 'agent', 'nativeSessionId', 'credential'], ['bindingId', 'agent', 'nativeSessionId', 'credential']);
      identifier(entry.bindingId); identifier(entry.nativeSessionId);
      if (!ROLES.has(entry.agent) || !/^[A-Za-z0-9_-]{43}$/.test(entry.credential) || bindings.has(entry.bindingId)) fail('RECOVERY_REQUIRED');
      const bound = await broker.getBinding(entry.bindingId);
      if ((bound.binding?.nativeSessionId ?? bound.nativeSessionId) !== entry.nativeSessionId || bound.agent !== entry.agent || bound.bindingId !== entry.bindingId) fail('RECOVERY_REQUIRED');
      bindings.set(entry.bindingId, entry);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const persistCredentials = () => {
    const pending = credentialWrites.then(() => atomicJson(credentialFile, { schema: 1, roomId, bindings: [...bindings.values()] }));
    credentialWrites = pending.catch(() => {});
    return pending;
  };

  const bindCredential = (agent, nativeSessionId, bindingId) => {
    const prior = bindings.get(bindingId);
    if (prior && (prior.agent !== agent || prior.nativeSessionId !== nativeSessionId)) fail('STATE_CONFLICT');
    const binding = prior ?? { bindingId, agent, nativeSessionId, credential: secret() };
    bindings.set(bindingId, binding);
    return binding;
  };
  const authenticateBinding = req => {
    const token = bearer(req);
    if (!token) fail('AUTH_REQUIRED');
    for (const binding of bindings.values()) if (sameToken(token, binding.credential)) return binding;
    fail('FORBIDDEN');
  };
  const frame = snapshot => `id: ${snapshot.instanceId}:${snapshot.seq}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  const changed = snapshot => {
    const data = frame(snapshot);
    for (const res of streams) {
      // A slow page reconnects for a full snapshot; never buffer an unbounded history.
      if (res.writableLength > 1024 * 1024) { streams.delete(res); res.destroy(); }
      else res.write(data);
    }
  };
  broker.on('change', changed);
  const heartbeat = setInterval(() => { for (const res of streams) res.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();

  const server = http.createServer(async (req, res) => {
    let mutationStarted = false;
    try {
      commonHeaders(res);
      if (closing) fail('RECOVERY_REQUIRED');
      if (req.headers.host !== authority || (req.headers.origin !== undefined && req.headers.origin !== baseUrl)) fail('FORBIDDEN');
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) fail('INVALID_INPUT');
      const url = new URL(req.url, baseUrl);
      if (url.origin !== baseUrl || /%2f|%5c|%00/i.test(url.pathname)) fail('INVALID_INPUT');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] === 'api') {
        if (!sameToken(bearer(req), humanToken)) fail(bearer(req) ? 'FORBIDDEN' : 'AUTH_REQUIRED');
        if (parts[1] !== 'v1' || parts[2] !== 'rooms' || parts[3] !== roomId) fail('NOT_FOUND');
        const endpoint = parts.slice(4);
        if (req.method === 'GET') {
          if (endpoint.length === 1 && endpoint[0] === 'snapshot') { rejectQuery(url); return sendJson(res, await broker.snapshot()); }
          if (endpoint.length === 1 && endpoint[0] === 'events') {
            rejectQuery(url, ['after']);
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            // Attach before snapshot capture: changed frames may precede it, but seq prevents rollback.
            streams.add(res); res.on('close', () => streams.delete(res));
            res.write(frame(await broker.snapshot())); return;
          }
          if (endpoint.length === 2 && endpoint[0] === 'operations') { rejectQuery(url); return sendJson(res, await broker.getOperation(identifier(endpoint[1]))); }
          if (endpoint.length === 3 && endpoint[0] === 'attachments' && endpoint[2] === 'text') {
            rejectQuery(url, ['cursor']); return sendJson(res, await broker.readAttachment(identifier(endpoint[1]), url.searchParams.get('cursor') ?? undefined));
          }
          fail('NOT_FOUND');
        }
        if (req.method !== 'POST') fail('NOT_FOUND');
        if (req.headers.origin !== baseUrl || req.headers['sec-fetch-site'] === 'cross-site') fail('FORBIDDEN');
        rejectQuery(url);
        const body = await jsonBody(req);
        const routes = { messages: ['postMessage', ['operationId', 'expectedGate', 'recipients', 'text', 'attachmentIds']], exchanges: ['startExchange', ['operationId', 'expectedGate', 'baseMessageId', 'baseReplyIds', 'previousExchangeId', 'maxRounds', 'finishPolicy']], stop: ['stop', ['operationId', 'expectedGate']] };
        if (endpoint.length === 1 && routes[endpoint[0]]) {
          const [method, allowed] = routes[endpoint[0]];
          fields(body, allowed, allowed.filter(key => key !== 'finishPolicy')); identifier(body.operationId); validateGate(body);
          if (body.finishPolicy !== undefined && !['first_done', 'both_same_round'].includes(body.finishPolicy)) fail('INVALID_INPUT');
          if (method === 'startExchange') fields(body.baseReplyIds, ['codex', 'claude'], ['codex', 'claude']);
          mutationStarted = true; return sendJson(res, await broker[method](body));
        }
        if (endpoint.length === 3 && endpoint[0] === 'deliveries' && ['abandon', 'resend'].includes(endpoint[2])) {
          const abandon = endpoint[2] === 'abandon';
          const allowed = abandon ? ['operationId', 'expectedDeliveryVersion', 'expectedClaimId'] : ['operationId', 'expectedGate', 'expectedDeliveryVersion', 'acknowledgePossibleDuplicate'];
          fields(body, allowed, abandon ? allowed : ['operationId', 'expectedGate', 'expectedDeliveryVersion']); identifier(body.operationId); validateGate(body);
          mutationStarted = true;
          return sendJson(res, await broker[abandon ? 'abandonDelivery' : 'resendDelivery'](identifier(endpoint[1]), body));
        }
        fail('NOT_FOUND');
      }
      if (parts[0] === 'agent') {
        if (parts[1] !== 'v1' || parts.length !== 3 || req.headers.origin !== undefined) fail('FORBIDDEN');
        rejectQuery(url);
        if (parts[2] === 'join' && req.method === 'POST') {
          const role = [...enrollments].find(([, token]) => sameToken(token, bearer(req)))?.[0];
          if (!role) fail(bearer(req) ? 'FORBIDDEN' : 'AUTH_REQUIRED');
          const body = fields(await jsonBody(req), ['agent', 'nativeSessionId', 'label', 'renew'], ['agent', 'nativeSessionId']);
          if (body.agent !== role || !ROLES.has(body.agent)) fail('FORBIDDEN');
          identifier(body.nativeSessionId);
          if (body.label !== undefined && (typeof body.label !== 'string' || [...body.label].length > 200)) fail('INVALID_INPUT');
          if (body.renew !== undefined && typeof body.renew !== 'boolean') fail('INVALID_INPUT');
          mutationStarted = true;
          const result = await broker.join(body);
          const bindingId = identifier(result.bindingId ?? result.binding?.id);
          const binding = bindCredential(role, body.nativeSessionId, bindingId);
          await persistCredentials();
          return sendJson(res, { ...result, bindingId, credential: binding.credential, agent: role, nativeSessionId: body.nativeSessionId, instanceId, roomId });
        }
        const binding = authenticateBinding(req);
        if (parts[2] === 'status' && req.method === 'GET') {
          return sendJson(res, await broker.getBinding(binding.bindingId));
        }
        if (req.method !== 'POST') fail('NOT_FOUND');
        const body = await jsonBody(req);
        if (parts[2] === 'wait') {
          fields(body, ['requestId'], ['requestId']); identifier(body.requestId);
          const controller = new AbortController(); aborts.add(controller);
          const disconnect = () => { if (!res.writableEnded) controller.abort(); };
          res.on('close', disconnect);
          try { return sendJson(res, await broker.wait(binding.bindingId, { requestId: body.requestId, signal: controller.signal })); }
          finally { aborts.delete(controller); res.off('close', disconnect); }
        }
        if (parts[2] === 'read') {
          fields(body, ['requestId', 'batchId', 'claimId'], ['requestId']); identifier(body.requestId);
          if (body.batchId !== undefined && body.batchId !== null) identifier(body.batchId);
          if (body.claimId !== undefined && body.claimId !== null) identifier(body.claimId);
          if (!body.batchId && !body.claimId) fail('INVALID_INPUT');
          mutationStarted = true;
          let wrote = false;
          const result = await broker.read(binding.bindingId, body, delivery => {
            // This callback must remain synchronous: gate check and actual response write are inseparable.
            if (wrote || res.destroyed || res.writableEnded) throw Object.assign(new Error('Reader disconnected before handoff'), { code: 'READ_DISCONNECTED' });
            wrote = true;
            if (!sendJson(res, delivery)) throw Object.assign(new Error('Reader disconnected before handoff'), { code: 'READ_DISCONNECTED' });
          });
          if (!wrote) {
            if (result?.status === 'DELIVERY') fail('RECOVERY_REQUIRED');
            return sendJson(res, result);
          }
          return;
        }
        if (parts[2] === 'post') {
          fields(body, ['deliveryId', 'claimId', 'text', 'attachmentIds', 'done'], ['deliveryId', 'claimId', 'text', 'attachmentIds', 'done']); identifier(body.deliveryId);
          if (body.claimId !== null) identifier(body.claimId);
          if (typeof body.text !== 'string' || !Array.isArray(body.attachmentIds) || typeof body.done !== 'boolean') fail('INVALID_INPUT');
          body.attachmentIds.forEach(identifier);
          mutationStarted = true; return sendJson(res, await broker.postReply(binding.bindingId, body));
        }
        fail('NOT_FOUND');
      }
      if (req.method !== 'GET' || url.searchParams.size) fail('NOT_FOUND');
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const candidate = resolve(uiRoot, requested);
      const within = path => { const rel = relative(uiRoot, path); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
      if (!within(candidate) || !TYPES[extname(candidate)]) fail('NOT_FOUND');
      let file;
      try { file = await realpath(candidate); if (!within(file) || !(await stat(file)).isFile()) fail('NOT_FOUND'); }
      catch { fail('NOT_FOUND'); }
      let content = await readFile(file);
      const nonce = secret();
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      if (extname(file) === '.html') {
        const bootstrap = JSON.stringify({ apiVersion: API_VERSION, roomId, baseUrl, humanToken, capabilities: initial.capabilities ?? { discussionFinishPolicies: ['first_done'], contentFormats: ['plain'] } }).replace(/</g, '\\u003c');
        const script = `<script nonce="${nonce}">window.__AGENT_CHAT__=${bootstrap};</script>`;
        content = injectBootstrap(content.toString('utf8'), script);
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] }); res.end(content);
    } catch (error) { sendError(res, error, mutationStarted); }
  });
  server.requestTimeout = 30000; // Bounds receiving request bodies, not the long-wait response.
  server.headersTimeout = 15000;
  server.timeout = 0;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  try {
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => { server.off('error', no); yes(); }); });
    authority = `127.0.0.1:${server.address().port}`; baseUrl = `http://${authority}`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const [agent, enrollmentToken] of enrollments) await atomicJson(join(root, `connection-${agent}.json`), { apiVersion: API_VERSION, instanceId, roomId, baseUrl, agent, enrollmentToken });
  } catch (error) { clearInterval(heartbeat); broker.off('change', changed); server.closeAllConnections(); server.close(); throw error; }
  return {
    url: baseUrl, roomId, instanceId,
    // Deliberate programmatic access for an embedding launcher/tests; never persisted in agent descriptors.
    credentials: () => ({ humanToken }),
    async close() {
      if (closing) return; closing = true;
      clearInterval(heartbeat); broker.off('change', changed);
      for (const controller of aborts) controller.abort();
      for (const res of streams) res.end(); streams.clear();
      await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
      await credentialWrites;
      for (const agent of ROLES) {
        const file = join(root, `connection-${agent}.json`);
        try { if (JSON.parse(await readFile(file, 'utf8')).instanceId === instanceId) await unlink(file); } catch {}
      }
    },
  };
}
