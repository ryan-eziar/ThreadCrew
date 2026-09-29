import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { once } from 'node:events';
import { ThreadCrewFeatures } from './threadcrew-features.mjs';
import { UpdateManager } from './update-manager.mjs';
import { updateError } from './update-package.mjs';
import { bearer, sameToken, secret, commonHeaders, identifier, fields, injectBootstrap, jsonBody, validateGate, atomicJson, rejectQuery } from './broker-server.mjs';

export const API_VERSION = 'agent-chat.window.v2';
const ROLES = ['codex', 'claude'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status, outcome: 'rejected' }); };
const response = (res, result, status = 200, version = API_VERSION) => {
  if (res.destroyed || res.writableEnded) return false;
  const data = JSON.stringify({ ok: true, apiVersion: version, result });
  if (Buffer.byteLength(data) > 512 * 1024) fail('RESPONSE_TOO_LARGE', 413);
  commonHeaders(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(data); return true;
};
function errorResponse(res, error, mutated, version = API_VERSION) {
  if (res.headersSent || res.destroyed || res.writableEnded) { res.destroy(); return; }
  const recognized = /^[A-Z][A-Z_]{1,70}$/.test(error?.code ?? '');
  const code = recognized ? error.code : 'RECOVERY_REQUIRED';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : ['AUTH_REQUIRED'].includes(code) ? 401 : ['FORBIDDEN', 'BINDING_INVALID'].includes(code) ? 403 : ['NOT_FOUND', 'ITEM_NOT_FOUND'].includes(code) ? 404 : ['INVALID_INPUT', 'UNKNOWN_FIELD', 'INVALID_CURSOR'].includes(code) ? 400 : code.endsWith('TOO_LARGE') ? 413 : code === 'RECOVERY_REQUIRED' ? 503 : 409;
  const outcome = error?.outcome === 'unknown' || (mutated && (!recognized || error?.name === 'V2StorageError' || ['RECOVERY_REQUIRED','JOURNAL_UNSAFE','RESPONSE_TOO_LARGE'].includes(code))) ? 'unknown' : 'rejected';
  // Only broker-authored structured details are exposed; arbitrary causes/messages stay private.
  const details = error?.publicDetails ?? (error?.name === 'V2BrokerError' ? error.details ?? {} : {});
  commonHeaders(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, apiVersion: version, error: { code, message: outcome === 'unknown' ? 'The outcome is unknown. Check the original operation ID.' : 'The request was not completed. Check the current state.', outcome, retrySameOperation: outcome === 'unknown', details } }));
}

export async function createV2Server({ broker, work = null, runtimeDir, projectDir, port = 0, onShutdown = null, onShutdownFailure = null, shutdownGraceMs = 2000, autoUpdateChecks = false, updateOptions = {} }) {
  if (!broker || (onShutdown !== null && typeof onShutdown !== 'function') || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid server arguments');
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 0 || shutdownGraceMs > 30000) throw new TypeError('Invalid shutdown acknowledgement interval');
  if (onShutdownFailure !== null && typeof onShutdownFailure !== 'function') throw new TypeError('Invalid shutdown failure handler');
  const root = resolve(runtimeDir), uiRoot = await realpath(join(resolve(projectDir), 'ui'));
  broker.projectDir = resolve(projectDir);
  const features = new ThreadCrewFeatures(broker, projectDir);
  const humanToken = secret(), enrollments = new Map(ROLES.map(agent => [agent, secret()]));
  const streams = new Set(), aborts = new Set(), activeMutations = new Set();
  const instanceId = broker.instanceId, workspaceId = broker.workspaceId;
  identifier(instanceId); identifier(workspaceId);
  await broker.store.tx(sql => sql.run('CREATE TABLE IF NOT EXISTS http_credentials (binding_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent TEXT NOT NULL, native_session_id TEXT NOT NULL, credential TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE, legacy INTEGER NOT NULL DEFAULT 0)'));
  let baseUrl, authority, closing = false, shutdownRequested = false, shutdown = null, shutdownTimer = null, closePromise = null, updatePreparing = false;
  const updates = await new UpdateManager({ projectDir, runtimeDir: root, features, ...updateOptions,
    prepareShutdown: onShutdown ? async (operationId, launch) => {
      if(shutdownRequested || updatePreparing) throw updateError('UPDATE_IN_PROGRESS');
      updatePreparing=true;
      try {
        // Fence new HTTP mutations first, then let already admitted mutations
        // settle before the final serialized snapshot and shutdown handoff.
        await Promise.allSettled([...activeMutations]);
        await broker.store.read(async sql => {
          const preview=await features.updatePreview(sql);
          if(Object.values(preview.counts).some(n=>n>0)) throw updateError('UPDATE_BUSY',preview);
          await launch();
          requestShutdown('update-'+operationId);
        });
      } finally { updatePreparing=false; }
    } : null }).initialize();
  const notifyShutdown = () => {
    const frame = `event: service.shutdown\ndata: ${JSON.stringify(shutdown)}\n\n`;
    for (const res of streams) {
      if (res.destroyed || res.writableEnded || res.writableLength > 256 * 1024) continue;
      res.write(frame);
    }
  };
  const closeServer = () => closePromise ??= (async () => {
    closing = true; updates.close(); clearInterval(heartbeat); clearTimeout(shutdownTimer);
    for (const controller of aborts) controller.abort(); for (const res of streams) res.end();
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
    for (const agent of ROLES) { const path = join(root, `connection-${agent}.json`); try { if (JSON.parse(await readFile(path, 'utf8')).instanceId === instanceId) await unlink(path); } catch {} }
  })();
  const requestShutdown = shutdownId => {
    if (shutdown) {
      if (shutdown.shutdownId !== shutdownId) fail('SHUTDOWN_IN_PROGRESS');
      return { ...shutdown };
    }
    shutdownRequested = true;
    shutdown = { instanceId, shutdownId, status: 'SHUTTING_DOWN', requestedAt: new Date().toISOString(), completedAt: null, errorCode: null };
    broker.beginShutdown();
    clearInterval(heartbeat);
    for (const controller of aborts) controller.abort();
    notifyShutdown();
    // This callback closes storage and releases its lock, but leaves the HTTP
    // acknowledgement channel alive. A lost 202 never rolls back an accepted exit.
    void Promise.allSettled([...activeMutations]).then(onShutdown).then(() => {
      shutdown = { ...shutdown, status: 'STOPPED', completedAt: new Date().toISOString() };
      notifyShutdown();
      shutdownTimer = setTimeout(() => { void closeServer(); }, shutdownGraceMs);
    }).catch(error => {
      shutdown = { ...shutdown, status: 'FAILED', errorCode: /^[A-Z][A-Z_]{1,70}$/.test(error?.code ?? '') ? error.code : 'SHUTDOWN_FAILED' };
      notifyShutdown();
      process.stderr.write('ThreadCrew shutdown failed; inspect the broker process and runtime lock.\n');
      // Preserve the failed acknowledgement briefly, then let the production
      // owner exit. Its existing lock is evidence for verified crash recovery;
      // never leave an unreachable writer alive or remove its lock here.
      shutdownTimer = setTimeout(() => { void closeServer().finally(() => onShutdownFailure?.(shutdown)); }, shutdownGraceMs);
    });
    return { ...shutdown };
  };
  const bindingAuth = async req => {
    const token = bearer(req); if (!token) fail('AUTH_REQUIRED', 401);
    const row = await broker.store.read(sql => sql.get('SELECT * FROM http_credentials WHERE credential_hash=?', [hash(token)]));
    if (!row || !sameToken(token, row.credential)) fail('FORBIDDEN', 403);
    return { bindingId: row.binding_id, roomId: row.room_id, agent: row.agent, nativeSessionId: row.native_session_id, legacy: Boolean(row.legacy) };
  };
  const scoped = (result, b) => {
    if (!result || typeof result !== 'object' || (result.roomId !== undefined && result.roomId !== b.roomId) || (result.bindingId !== undefined && result.bindingId !== b.bindingId) || (result.agent !== undefined && result.agent !== b.agent)) fail('RECOVERY_REQUIRED', 503);
    return { ...result, roomId: b.roomId, bindingId: b.bindingId, agent: b.agent };
  };
  const credentialFor = async (roomId, agent, nativeSessionId, bindingId) => broker.store.tx(async sql => {
    let row = await sql.get('SELECT * FROM http_credentials WHERE binding_id=?', [bindingId]);
    if (row && (row.room_id !== roomId || row.agent !== agent || row.native_session_id !== nativeSessionId)) fail('FORBIDDEN', 403);
    if (!row) {
      const credential = secret();
      await sql.run('INSERT INTO http_credentials(binding_id,room_id,agent,native_session_id,credential,credential_hash) VALUES(?,?,?,?,?,?)', [bindingId, roomId, agent, nativeSessionId, credential, hash(credential)]);
      row = { credential };
    }
    return row.credential;
  });
  const query = (url, allowed) => {
    rejectQuery(url, allowed); const out = Object.fromEntries(url.searchParams);
    if ('limit' in out) { if (!/^[1-9][0-9]*$/.test(out.limit)) fail('INVALID_INPUT', 400); out.limit = Number(out.limit); }
    return out;
  };
  const openStream = async (req, res, roomId, after) => {
    const name = roomId ? 'room.delta' : 'catalog.delta';
    let buffering = true, queued = [], queuedBytes = 0, lastRevision = null, closed = false;
    const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const finish = () => { if (closed) return; closed = true; broker.off(name, onEvent); broker.off('resync_required', onResync); streams.delete(res); res.end(); };
    const resync = reason => { if (!closed && !res.destroyed) res.write(frame('resync_required', { instanceId, roomId, reason })); finish(); };
    const write = event => {
      if (closed) return;
      if (lastRevision !== null && event.toRevision <= lastRevision) return;
      if (lastRevision !== null && event.fromRevision !== lastRevision) return resync('REVISION_GAP');
      const encoded = frame(name, event);
      if (Buffer.byteLength(encoded) > 256 * 1024 || res.writableLength > 256 * 1024) return resync('EVENT_TOO_LARGE');
      res.write(encoded); lastRevision = event.toRevision;
    };
    const onEvent = event => {
      if (roomId && event.roomId !== roomId) return;
      if (!buffering) return write(event);
      queuedBytes += Buffer.byteLength(JSON.stringify(event));
      if (queued.length >= 256 || queuedBytes > 1024 * 1024) return resync('REPLAY_OVERFLOW');
      queued.push(event);
    };
    const onResync = event => { if (!event.roomId || event.roomId === roomId) resync(event.reason ?? 'RESYNC_REQUIRED'); };
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    streams.add(res); res.on('close', finish); broker.on(name, onEvent); broker.on('resync_required', onResync);
    try {
      const replay = await broker.replayEvents(roomId ? 'room' : 'catalog', roomId, after);
      if (replay.resync) return resync(replay.resync.reason ?? 'CURSOR_EXPIRED');
      lastRevision = replay.fromRevision;
      for (const event of replay.events) write(event.data);
      buffering = false;
      for (const event of queued) write(event);
      queued = [];
    } catch { resync('CURSOR_INVALID'); }
  };
  const heartbeat = setInterval(() => { for (const res of streams) { if (res.writableLength > 256 * 1024) res.destroy(); else res.write(': keepalive\n\n'); } }, 15000);
  heartbeat.unref();
  const server = http.createServer(async (req, res) => {
    let mutated = false, responseVersion = API_VERSION, releaseMutation = null;
    const markMutation = () => {
      mutated = true;
      if (releaseMutation) return;
      let done;
      const pending = new Promise(resolve => { done = resolve; });
      activeMutations.add(pending);
      releaseMutation = () => { activeMutations.delete(pending); done(); };
    };
    try {
      commonHeaders(res);
      if (closing) fail('CLOSED', 503);
      if (req.headers.host !== authority || (req.headers.origin !== undefined && req.headers.origin !== baseUrl)) fail('FORBIDDEN', 403);
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) fail('INVALID_INPUT', 400);
      const url = new URL(req.url, baseUrl);
      if (url.origin !== baseUrl || /%2f|%5c|%00/i.test(url.pathname)) fail('INVALID_INPUT', 400);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] === 'api') {
        if (!sameToken(bearer(req), humanToken)) fail(bearer(req) ? 'FORBIDDEN' : 'AUTH_REQUIRED', bearer(req) ? 403 : 401);
        if (parts[1] !== 'v2') fail('VERSION_MISMATCH');
        if (parts.length === 4 && parts[2] === 'admin' && parts[3] === 'shutdown-status' && req.method === 'GET') {
          const q = query(url, ['expectedInstanceId','shutdownId']);
          if (identifier(q.expectedInstanceId) !== instanceId) fail('INSTANCE_MISMATCH');
          if (!shutdown || identifier(q.shutdownId) !== shutdown.shutdownId) fail('SHUTDOWN_NOT_FOUND',404);
          return response(res, { ...shutdown });
        }
        if (parts.length === 4 && parts[2] === 'admin' && parts[3] === 'shutdown' && req.method === 'POST') {
          if (!onShutdown) fail('NOT_FOUND', 404);
          if (req.headers.origin !== baseUrl || req.headers['sec-fetch-site'] === 'cross-site') fail('FORBIDDEN', 403);
          rejectQuery(url);
          const body = fields(await jsonBody(req), ['expectedInstanceId','shutdownId'], ['expectedInstanceId']);
          if (identifier(body.expectedInstanceId) !== instanceId) fail('INSTANCE_MISMATCH', 409);
          const shutdownId = body.shutdownId === undefined ? shutdown?.shutdownId ?? `shutdown-${randomUUID()}` : identifier(body.shutdownId);
          return response(res, requestShutdown(shutdownId), 202);
        }
        if (shutdownRequested) fail('CLOSED',503);
        if (req.method === 'POST' && (updatePreparing || await updates.isApplying())) fail('UPDATE_IN_PROGRESS');
        if (req.method === 'GET') {
          if (parts[2] === 'updates' && parts.length === 3) { rejectQuery(url); return response(res,{updates:await updates.state()}); }
          if (parts[2] === 'updates' && parts[3] === 'install-status' && parts.length === 4) { rejectQuery(url); return response(res,{updates:await updates.state()}); }
          if (parts[2] === 'updates' && parts[3] === 'preview' && parts.length === 4) { rejectQuery(url); return response(res,await features.updatePreview()); }
          if (parts.length === 4 && parts[2] === 'admin' && parts[3] === 'shutdown-preview') { rejectQuery(url); return response(res, await features.shutdownPreview()); }
          if (parts.length === 3 && parts[2] === 'settings') { rejectQuery(url); return response(res, { settings: await features.settings() }); }
          if (parts.length === 3 && parts[2] === 'diagnostics') { rejectQuery(url); return response(res, features.diagnostics()); }
          if (parts.length === 3 && parts[2] === 'rooms') return response(res, await broker.listRooms(query(url, ['lifecycle', 'limit', 'cursor'])));
          if (parts.length === 3 && parts[2] === 'events') { const q = query(url, ['after']); return openStream(req, res, null, q.after); }
          if (parts.length === 4 && parts[2] === 'operations') { rejectQuery(url); return response(res, await broker.getOperation(identifier(parts[3]))); }
        }
        const humanPost = async (allowed, required = allowed, maxBytes) => {
          if (req.method !== 'POST') fail('NOT_FOUND', 404);
          if (req.headers.origin !== baseUrl || req.headers['sec-fetch-site'] === 'cross-site') fail('FORBIDDEN', 403);
          rejectQuery(url); const body = fields(await jsonBody(req, maxBytes), allowed, required);
          if (shutdownRequested) fail('CLOSED',503);
          if(updatePreparing || await updates.isApplying()) fail('UPDATE_IN_PROGRESS');
          identifier(body.operationId); validateGate(body); markMutation(); return body;
        };
        if(parts[2]==='updates' && parts.length===4 && req.method==='POST') {
          if(req.headers.origin!==baseUrl || req.headers['sec-fetch-site']==='cross-site') fail('FORBIDDEN',403);
          rejectQuery(url);
          if(parts[3]==='check'){fields(await jsonBody(req),[],[]);return response(res,{updates:await updates.check()});}
          if(parts[3]==='install'){
            const body=fields(await jsonBody(req),['operationId','expectedVersion']);markMutation();
            return response(res,{updates:await updates.install(body)},202);
          }
          fail('NOT_FOUND',404);
        }
        if (parts.length === 3 && parts[2] === 'settings') return response(res, await features.setSettings(await humanPost(['operationId','expectedVersion','displayName','backgroundNoticeAcknowledged','autoCheckUpdates'], ['operationId','expectedVersion'])));
        if (parts.length === 3 && parts[2] === 'rooms') return response(res, await broker.createRoom(await humanPost(['operationId', 'name'])));
        if (parts[2] !== 'rooms' || !parts[3]) fail('NOT_FOUND', 404);
        const roomId = identifier(parts[3]), endpoint = parts.slice(4), action = endpoint.join('/');
        if (req.method === 'GET') {
          if (action === 'notes') { rejectQuery(url); return response(res, { notes: await features.notes(roomId) }); }
          if (action === 'search') return response(res, await features.search(roomId, query(url, ['q','limit','cursor'])));
          if (action === 'export') {
            const q = query(url, ['lang']); const exported = await features.export(roomId, q.lang ?? 'en');
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="threadcrew-export.md"; filename*=UTF-8''${encodeURIComponent(exported.name)}` });
            for await (const chunk of exported.chunks()) {
              if (res.destroyed) return;
              if (!res.write(chunk)) await once(res, 'drain');
            }
            return res.end();
          }
          if (endpoint.length === 3 && endpoint[0] === 'attachments' && endpoint[2] === 'download') {
            rejectQuery(url); const file = await features.download(roomId,identifier(endpoint[1]));
            res.writeHead(200, { 'Content-Type': file.metadata.mediaType, 'Content-Length': file.bytes.length,
              'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.metadata.name)}` });
            return res.end(file.bytes);
          }
          if (action === 'view') return response(res, await broker.getView(roomId, query(url, ['limit'])));
          if (action === 'control') { rejectQuery(url); return response(res, await broker.getControl(roomId)); }
          if (action === 'timeline') return response(res, await broker.getTimeline(roomId, query(url, ['limit', 'before', 'after', 'around'])));
          if (action === 'deliveries') return response(res, await broker.getDeliveries(roomId, query(url, ['status', 'limit', 'cursor'])));
          if (action === 'attention') return response(res, await broker.getAttention(roomId, query(url, ['limit', 'cursor'])));
          if (action === 'events') { const q = query(url, ['after']); return openStream(req, res, roomId, q.after); }
          if (endpoint.length === 3 && endpoint[0] === 'timeline' && endpoint[1] === 'items') { rejectQuery(url); return response(res, await broker.getTimelineItem(roomId, identifier(endpoint[2]))); }
          if (endpoint.length === 3 && endpoint[0] === 'attachments' && endpoint[2] === 'text') { const q = query(url, ['cursor']); return response(res, await broker.readAttachment(roomId, identifier(endpoint[1]), q.cursor)); }
          if (work && endpoint[0] === 'work' && endpoint.length === 2) { rejectQuery(url); return response(res, await work.get(roomId, identifier(endpoint[1]))); }
          if (work && endpoint[0] === 'work' && endpoint.length === 3 && endpoint[2] === 'requests') return response(res, await work.requests(roomId, identifier(endpoint[1]), query(url, ['limit', 'cursor'])));
          fail('NOT_FOUND', 404);
        }
        if (action === 'notes') return response(res, await features.setNotes(roomId, await humanPost(['operationId','expectedVersion','text'])));
        if (action === 'attachments') return response(res, await features.upload(roomId, await humanPost(['operationId','name','mediaType','dataBase64'], undefined, 15 * 1024 * 1024)));
        const routes = {
          rename: ['renameRoom', ['operationId', 'expectedRoomVersion', 'name']],
          archive: ['archiveRoom', ['operationId', 'expectedRoomVersion', 'expectedGate', 'acknowledgePossibleRunning']],
          restore: ['restoreRoom', ['operationId', 'expectedRoomVersion']],
          'read-position': ['setReadPosition', ['operationId', 'throughOrder']],
          messages: ['sendHuman', ['operationId', 'expectedGate', 'recipients', 'text', 'attachmentIds', 'format']],
          exchanges: ['startExchange', ['operationId', 'expectedGate', 'baseMessageId', 'baseReplyIds', 'previousExchangeId', 'maxRounds', 'finishPolicy']],
          stop: ['stop', ['operationId', 'expectedGate']],
        };
        if (routes[action]) { const [method, keys] = routes[action]; return response(res, await broker[method](roomId, await humanPost(keys, keys.filter(k => !['finishPolicy','format'].includes(k))))); }
        if (endpoint.length === 3 && endpoint[0] === 'members' && endpoint[2] === 'remove' && ROLES.includes(endpoint[1])) return response(res, await broker.removeMember(roomId, endpoint[1], await humanPost(['operationId', 'expectedGate', 'expectedBindingId', 'expectedBindingVersion', 'acknowledgePossibleRunning'])));
        if (endpoint.length === 3 && endpoint[0] === 'deliveries' && ['abandon', 'resend'].includes(endpoint[2])) {
          const abandon = endpoint[2] === 'abandon', keys = abandon ? ['operationId', 'expectedDeliveryVersion', 'expectedClaimId'] : ['operationId', 'expectedGate', 'expectedDeliveryVersion', 'acknowledgePossibleDuplicate'];
          return response(res, await broker[abandon ? 'abandonDelivery' : 'resendDelivery'](roomId, identifier(endpoint[1]), await humanPost(keys, keys.filter(k => k !== 'acknowledgePossibleDuplicate'))));
        }
        if (work && endpoint[0] === 'work') {
          if (endpoint.length === 1) return response(res, await work.start(roomId, await humanPost(['operationId', 'expectedGate', 'expectedBindings', 'text', 'attachmentIds', 'objective', 'requestLimit', 'wakeLimit', 'durationSeconds'])));
          const workId = identifier(endpoint[1]);
          if (endpoint.length === 3 && endpoint[2] === 'budget') return response(res, await work.budget(roomId, workId, await humanPost(['operationId', 'expectedGate', 'expectedWorkVersion', 'addRequests', 'addWakes'])));
          if (endpoint.length === 3 && endpoint[2] === 'release') return response(res, await work.release(roomId, workId, await humanPost(['operationId', 'expectedGate', 'expectedWorkVersion', 'acknowledgePossibleRunning'])));
          if (endpoint.length === 5 && endpoint[2] === 'requests' && ['abandon', 'resend'].includes(endpoint[4])) {
            const action = endpoint[4], keys = action === 'abandon' ? ['operationId', 'expectedRequestVersion'] : ['operationId', 'expectedGate', 'expectedRequestVersion', 'acknowledgeDuplicateRisk'];
            return response(res, await work[action](roomId, workId, identifier(endpoint[3]), await humanPost(keys)));
          }
        }
        fail('NOT_FOUND', 404);
      }
      if (parts[0] === 'agent') {
        if (req.headers.origin !== undefined) fail('FORBIDDEN', 403);
        if(req.method==='POST' && (updatePreparing || await updates.isApplying())) fail('UPDATE_IN_PROGRESS');
        rejectQuery(url);
        if (parts[1] === 'v1') {
          if (shutdownRequested) fail('CLOSED',503);
          responseVersion = 'agent-chat.window.v1';
          if (parts.length !== 3 || !['post', 'status'].includes(parts[2])) fail('VERSION_MISMATCH');
          const b = await bindingAuth(req); if (!b.legacy) fail('FORBIDDEN', 403);
          if (parts[2] === 'status' && req.method === 'GET') return response(res, await broker.getBinding(b.roomId, b.bindingId), 200, responseVersion);
          if (parts[2] !== 'post' || req.method !== 'POST') fail('NOT_FOUND', 404);
          const body = fields(await jsonBody(req), ['deliveryId', 'claimId', 'text', 'attachmentIds', 'done'], ['deliveryId', 'claimId', 'text', 'attachmentIds', 'done']);
          if (shutdownRequested) fail('CLOSED',503);
          markMutation();
          // The core additionally checks this delivery was imported with this exact old binding.
          const allowed = await broker.isLegacyDelivery(b.roomId, b.bindingId, identifier(body.deliveryId));
          if (!allowed) fail('FORBIDDEN', 403);
          return response(res, await broker.postReply(b.roomId, b.bindingId, body), 200, responseVersion);
        }
        if (parts[1] !== 'v2') fail('VERSION_MISMATCH');
        if (parts.length === 3 && parts[2] === 'identity' && req.method === 'GET') {
          if (![...enrollments.values()].some(token => sameToken(token, bearer(req)))) fail('FORBIDDEN', 403);
          return response(res, { workspaceId, instanceId });
        }
        if (shutdownRequested) fail('CLOSED',503);
        if (parts[2] !== 'rooms' || !parts[3] || !parts[4]) fail('NOT_FOUND', 404);
        const roomId = identifier(parts[3]), action = parts[4];
        if (parts.length === 5 && action === 'join' && req.method === 'POST') {
          const agent = [...enrollments].find(([, token]) => sameToken(token, bearer(req)))?.[0]; if (!agent) fail('FORBIDDEN', 403);
          const body = fields(await jsonBody(req), ['agent', 'nativeSessionId', 'label', 'expectedBindingId', 'expectedGate', 'expectedJoinVersion', 'renew', 'reconnect'], ['agent', 'nativeSessionId', 'expectedBindingId', 'expectedGate']);
          if (shutdownRequested) fail('CLOSED',503);
          if(updatePreparing || await updates.isApplying()) fail('UPDATE_IN_PROGRESS');
          if (body.agent !== agent) fail('FORBIDDEN', 403); validateGate(body); markMutation();
          const result = await broker.join(roomId, body), bindingId = identifier(result.bindingId);
          let credential;
          try { credential = await credentialFor(roomId, agent, body.nativeSessionId, bindingId); }
          catch (cause) { throw Object.assign(new Error('Credential persistence after join failed'), {code:'RECOVERY_REQUIRED',status:503,outcome:'unknown',cause}); }
          return response(res, { ...result, bindingId, credential, agent, nativeSessionId: body.nativeSessionId, roomId, instanceId, workspaceId,
            roomNotes: await features.notes(roomId), protocolPath: resolve(projectDir,'docs/AGENT_PROTOCOL.md') });
        }
        const b = await bindingAuth(req); if (b.roomId !== roomId) fail('FORBIDDEN', 403);
        if (parts.length === 5 && action === 'status' && req.method === 'GET') return response(res, scoped(await broker.getBinding(roomId, b.bindingId), b));
        if (parts.length === 5 && action === 'resume' && req.method === 'GET') { rejectQuery(url); return response(res, scoped(await broker.resumeBinding(roomId,b.bindingId), b)); }
        if(work && parts.length===5 && action==='start-context' && req.method==='GET')return response(res,scoped(await work.startContext(roomId,b.bindingId),b));
        if(work&&parts.length===7&&action==='work'&&parts[6]==='status'&&req.method==='GET')return response(res,scoped(await work.agentStatus(roomId,identifier(parts[5]),b.bindingId),b));
        if (req.method !== 'POST') fail('NOT_FOUND', 404);
        const body = await jsonBody(req);
        if (shutdownRequested) fail('CLOSED',503);
        if(updatePreparing || await updates.isApplying()) fail('UPDATE_IN_PROGRESS');
        if(work && parts.length===5 && action==='confirm-start') {
          markMutation();validateGate(body);
          return response(res,scoped(await work.confirmStart(roomId,b.bindingId,body),b));
        }
        if (parts.length === 5 && action === 'wait') {
          fields(body, ['requestId', 'workId', 'notificationScopes'], ['requestId']); identifier(body.requestId);
          const controller = new AbortController(); aborts.add(controller);
          const disconnect = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', disconnect);
          try { return response(res, scoped(await broker.wait(roomId, b.bindingId, { ...body, signal: controller.signal }), b)); }
          finally { aborts.delete(controller); res.off('close', disconnect); }
        }
        if (parts.length === 5 && action === 'read') {
          fields(body, ['requestId', 'batchId', 'claimId'], ['requestId']); markMutation(); let wrote = false;
          const result = await broker.read(roomId, b.bindingId, body, delivery => {
            if (wrote || res.destroyed || res.writableEnded) fail('READ_DISCONNECTED');
            wrote = true; if (!response(res, scoped(delivery, b))) fail('READ_DISCONNECTED');
          });
          if (!wrote) { if (result?.status === 'DELIVERY') fail('RECOVERY_REQUIRED', 503); return response(res, scoped(result, b)); } return;
        }
        if (parts.length === 5 && action === 'post') {
          fields(body, ['deliveryId', 'claimId', 'text', 'attachmentIds', 'done', 'format'], ['deliveryId', 'claimId', 'text', 'attachmentIds', 'done']); markMutation();
          return response(res, scoped(await broker.postReply(roomId, b.bindingId, body), b));
        }
        if (work && parts.length === 7 && action === 'work') {
          const workId = identifier(parts[5]), method = parts[6];
          if (!['accept', 'progress', 'requests', 'checkpoint', 'received', 'responses', 'state'].includes(method)) fail('NOT_FOUND', 404);
          markMutation();
          const result = await work.agent(method, roomId, workId, b.bindingId, body);
          // A checkpoint can reserve claims before a concurrent Stop; recheck at the actual body write.
          const leaseExpired=method==='checkpoint'&&b.agent==='claude'&&Date.parse(result.work.participants.find(p=>p.bindingId===b.bindingId)?.leaseDeadlineAt)<=work.clock();
          if (method === 'checkpoint' && result.items?.length && (leaseExpired||!broker.isWriteAllowed(roomId, b.bindingId, result.work.segmentId) || Date.parse(result.work.expiresAt) <= work.clock())) {
            await work.checkpointWithheld(roomId,workId,b.bindingId,result);
            const code=leaseExpired?'WAIT_EXPIRED':'ROOM_STOPPED';
            throw Object.assign(new Error(code),{code,status:409,outcome:'unknown'});
          }
          return response(res, scoped(result, b));
        }
        fail('NOT_FOUND', 404);
      }
      if (req.method !== 'GET' || url.searchParams.size) fail('NOT_FOUND', 404);
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const within = path => { const rel = relative(uiRoot, path); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
      const candidate = resolve(uiRoot, requested); if (!within(candidate) || !TYPES[extname(candidate)]) fail('NOT_FOUND', 404);
      let file; try { file = await realpath(candidate); if (!within(file) || !(await stat(file)).isFile()) fail('NOT_FOUND', 404); } catch { fail('NOT_FOUND', 404); }
      let content = await readFile(file); const nonce = secret();
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      if (extname(file) === '.html') content = injectBootstrap(content.toString('utf8'), `<script nonce="${nonce}">window.__AGENT_CHAT__=${JSON.stringify({ apiVersion: API_VERSION, workspaceId, instanceId, baseUrl, humanToken, version:updates.installedVersion, capabilities: { ...broker.capabilities, shutdown: Boolean(onShutdown), updates:true }, shutdown }).replace(/</g, '\\u003c')};</script>`);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] }); res.end(content);
    } catch (error) { errorResponse(res, error, mutated, responseVersion); }
    finally { releaseMutation?.(); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.timeout = 0;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  try {
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => { server.off('error', no); yes(); }); });
    authority = `127.0.0.1:${server.address().port}`; baseUrl = `http://${authority}`;
    await mkdir(root, { recursive: true });
    for (const [agent, enrollmentToken] of enrollments) await atomicJson(join(root, `connection-${agent}.json`), { apiVersion: API_VERSION, workspaceId, instanceId, baseUrl, agent, enrollmentToken });
  } catch (error) { clearInterval(heartbeat); server.closeAllConnections(); server.close(); throw error; }
  if(autoUpdateChecks) updates.startAutomatic();
  return { url: baseUrl, workspaceId, instanceId, credentials: () => ({ humanToken }), close: closeServer, updates };
}
