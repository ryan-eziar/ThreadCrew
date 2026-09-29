import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, link, mkdir, open, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, readTextAttachment } from './broker-storage.mjs';
import { V2Store } from './v2-store.mjs';
import { discoverService } from './service-discovery.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TABLE_KEYS = {
  metadata: 'key', rooms: 'id', segments: 'id', bindings: 'id', messages: 'id', deliveries: 'id', replies: 'id',
  exchanges: 'id', timeline: 'id', attachments: 'id', operations: 'operation_id', read_requests: 'binding_id,request_id',
  legacy_deliveries: 'delivery_id', http_credentials: 'binding_id', legacy_timeline_payloads: 'item_id', legacy_reply_fingerprints: 'reply_id',
};
const j = value => JSON.stringify(value);
const fail = (code, message) => { throw Object.assign(new Error(message ?? code), { code }); };
const validId = value => typeof value === 'string' && ID.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const v2Fingerprint = value => sha(j(canonical(value)));
const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;

async function exists(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function regular(info, label) {
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1n) fail('SOURCE_UNSAFE', `${label} is not a single regular file.`);
}
function directory(info, label) {
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('SOURCE_UNSAFE', `${label} is not a real directory.`);
}
function sameVersion(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs; }
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function firstRoomId(journal) {
  const handle = await open(journal, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) fail('SOURCE_UNSAFE', 'The first journal record is incomplete or unusually large.');
    let first;
    try { first = JSON.parse(buffer.subarray(0, end).toString('utf8')); }
    catch { fail('SOURCE_UNSAFE', 'The first journal record is invalid.'); }
    if (!validId(first.roomId)) fail('SOURCE_UNSAFE', 'The v1 journal has no valid room identity.');
    return first.roomId;
  } finally { await handle.close(); }
}
function validateState(state, roomId) {
  if (!state || state.schemaVersion !== 1 || state.roomId !== roomId || !validId(state.gate?.segmentId) || !integer(state.gate?.version)) fail('SOURCE_UNSAFE', 'V1 state identity is invalid.');
  for (const key of ['segments', 'messages', 'deliveries', 'replies', 'exchanges', 'timeline', 'attachments']) {
    if (!Array.isArray(state[key]) || state[key].some(item => !validId(item?.id)) || new Set(state[key].map(item => item.id)).size !== state[key].length) fail('SOURCE_UNSAFE', `V1 ${key} identities are invalid.`);
  }
  if (!state.bindings || Array.isArray(state.bindings) || !state.currentBindings || !state.operations || Array.isArray(state.operations)) fail('SOURCE_UNSAFE', 'V1 maps are invalid.');
  const ids = key => new Set(state[key].map(item => item.id));
  const segments = ids('segments'), messages = ids('messages'), deliveries = ids('deliveries'), replies = ids('replies'), exchanges = ids('exchanges'), attachments = ids('attachments');
  if (!segments.has(state.gate.segmentId)) fail('SOURCE_UNSAFE', 'V1 current segment is absent.');
  for (const [id, binding] of Object.entries(state.bindings)) if (!validId(id) || binding?.id !== id || !['codex', 'claude'].includes(binding.agent) || !validId(binding.nativeSessionId)) fail('SOURCE_UNSAFE', 'V1 binding identity is invalid.');
  for (const agent of ['codex', 'claude']) { const id = state.currentBindings[agent]; if (id !== null && state.bindings[id]?.agent !== agent) fail('SOURCE_UNSAFE', 'V1 current binding is invalid.'); }
  const deliveryById = new Map(state.deliveries.map(item => [item.id, item]));
  const replyById = new Map(state.replies.map(item => [item.id, item]));
  for (const item of state.messages) if (!segments.has(item.segmentId) || !Array.isArray(item.deliveryIds)
    || item.deliveryIds.some(id => deliveryById.get(id)?.messageId !== item.id)
    || !Array.isArray(item.attachmentIds) || item.attachmentIds.some(id => !attachments.has(id))) fail('SOURCE_UNSAFE', 'V1 message references are invalid.');
  const claims = new Set(), waiting = new Set();
  for (const item of state.deliveries) {
    if (!segments.has(item.segmentId) || (item.messageId && !messages.has(item.messageId)) || (item.sourceReplyId && !replies.has(item.sourceReplyId))
      || (item.exchangeId && !exchanges.has(item.exchangeId)) || (item.bindingId && !state.bindings[item.bindingId])
      || (item.finalReplyId && replyById.get(item.finalReplyId)?.deliveryId !== item.id)
      || !Array.isArray(item._attachmentIds) || item._attachmentIds.some(id => !attachments.has(id))) fail('SOURCE_UNSAFE', 'V1 delivery references are invalid.');
    if (item.claimId) { if (!validId(item.claimId) || claims.has(item.claimId)) fail('SOURCE_UNSAFE', 'V1 claim identity is invalid.'); claims.add(item.claimId); }
    if (item.waitDisposition === 'waiting' && !item.finalReplyId) {
      if (!item.bindingId || waiting.has(item.bindingId)) fail('SOURCE_UNSAFE', 'V1 waiting occupancy is invalid.');
      waiting.add(item.bindingId);
    }
  }
  for (const item of state.replies) if (!deliveries.has(item.deliveryId) || deliveryById.get(item.deliveryId)?.finalReplyId !== item.id
    || deliveryById.get(item.deliveryId)?.bindingId !== item.bindingId || !state.bindings[item.bindingId] || !segments.has(item.segmentId)
    || !Array.isArray(item.attachmentIds) || item.attachmentIds.some(id => !attachments.has(id))) fail('SOURCE_UNSAFE', 'V1 reply references are invalid.');
  for (const item of state.exchanges) if (!segments.has(item.segmentId) || !messages.has(item.baseMessageId)) fail('SOURCE_UNSAFE', 'V1 exchange references are invalid.');
  for (let index = 0; index < state.timeline.length; index++) {
    const item = state.timeline[index];
    if (item.order !== index + 1 || !segments.has(item.segmentId) || !['system', 'message', 'reply'].includes(item.kind)
      || (item.kind === 'message' && !messages.has(item.refId)) || (item.kind === 'reply' && !replies.has(item.refId))) fail('SOURCE_UNSAFE', 'V1 timeline order or references are invalid.');
  }
}
async function copyTree(source, destination, relativeName, entries) {
  const info = await lstat(source, { bigint: true });
  directory(info, relativeName);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const children = await readdir(source, { withFileTypes: true });
  for (const child of children) {
    const sub = `${relativeName}/${child.name}`;
    if (child.isSymbolicLink()) fail('SOURCE_UNSAFE', `${sub} is redirected.`);
    const src = join(source, child.name), dst = join(destination, child.name);
    if (child.isDirectory()) await copyTree(src, dst, sub, entries);
    else if (child.isFile()) await copyVerified(src, dst, sub, entries);
    else fail('SOURCE_UNSAFE', `${sub} is not a regular file.`);
  }
}
async function copyVerified(source, destination, relativeName, entries) {
  const before = await lstat(source, { bigint: true }); regular(before, relativeName);
  const sourceHash = await fileHash(source);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const copied = await lstat(destination, { bigint: true }); regular(copied, relativeName);
  const after = await lstat(source, { bigint: true });
  const copyHash = await fileHash(destination);
  if (!sameVersion(before, after) || copied.size !== before.size || sourceHash !== copyHash) fail('SOURCE_CHANGED', `${relativeName} changed during backup.`);
  entries.push({ path: relativeName, bytes: Number(before.size), sha256: sourceHash,
    identity: { dev: String(before.dev), ino: String(before.ino), mtimeNs: String(before.mtimeNs) } });
}
async function makeBackup(root, backupDir) {
  const entries = [], absent = [];
  await mkdir(backupDir, { recursive: false, mode: 0o700 });
  for (const name of ['broker-state.jsonl', 'agent-bindings.json', 'connection-codex.json', 'connection-claude.json']) {
    if (await exists(join(root, name))) await copyVerified(join(root, name), join(backupDir, name), name, entries);
    else absent.push(name);
  }
  for (const name of ['clients', 'attachments', 'replies']) {
    if (await exists(join(root, name))) await copyTree(join(root, name), join(backupDir, name), name, entries);
    else { await mkdir(join(backupDir, name)); absent.push(name); }
  }
  return { entries, absent };
}
async function verifyBackup(root, backupDir, manifest) {
  for (const entry of manifest.entries) {
    const source = join(root, ...entry.path.split('/'));
    const backup = join(backupDir, ...entry.path.split('/'));
    const sourceInfo = await lstat(source, { bigint: true }); regular(sourceInfo, entry.path);
    if (String(sourceInfo.dev) !== entry.identity.dev || String(sourceInfo.ino) !== entry.identity.ino
      || String(sourceInfo.mtimeNs) !== entry.identity.mtimeNs || Number(sourceInfo.size) !== entry.bytes
      || await fileHash(source) !== entry.sha256 || await fileHash(backup) !== entry.sha256) fail('SOURCE_CHANGED', `${entry.path} changed after backup.`);
  }
  const observed = [];
  async function walk(dir, prefix) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const name = `${prefix}/${item.name}`;
      if (item.isDirectory()) await walk(join(dir, item.name), name);
      else if (item.isFile() && !item.isSymbolicLink()) observed.push(name);
      else fail('SOURCE_CHANGED', `${name} appeared after backup.`);
    }
  }
  for (const name of ['clients', 'attachments', 'replies']) if (!manifest.absent.includes(name)) await walk(join(root, name), name);
  for (const name of ['broker-state.jsonl', 'agent-bindings.json', 'connection-codex.json', 'connection-claude.json']) if (!manifest.absent.includes(name)) observed.push(name);
  for (const name of manifest.absent) if (await exists(join(root, name))) fail('SOURCE_CHANGED', `${name} appeared after backup.`);
  if (j(observed.sort()) !== j(manifest.entries.map(item => item.path).sort())) fail('SOURCE_CHANGED', 'The set of V1 files changed after backup.');
}
function rowsFor(state, credentials, roomName, workspaceId) {
  const rows = Object.fromEntries(Object.keys(TABLE_KEYS).map(name => [name, []]));
  const add = (table, row) => rows[table].push(row);
  const roomId = state.roomId;
  const timeline = state.timeline;
  const createdAt = timeline[0]?.at ?? state.messages[0]?.createdAt ?? new Date().toISOString();
  const lastAt = timeline.at(-1)?.at ?? createdAt;
  const activeSegment = state.segments.find(value => value.id === state.gate.segmentId);
  const activeExchange = state.exchanges.find(value => value.state === 'active');
  const pending = state.deliveries.filter(value => !value.finalReplyId && !['failed', 'stopped'].includes(value.state)).length;
  const attention = state.deliveries.filter(value => !value.finalReplyId && ['failed', 'uncertain'].includes(value.state)).length;
  const lastText = [...state.messages, ...state.replies].sort((a, b) => Date.parse(a.createdAt ?? a.committedAt) - Date.parse(b.createdAt ?? b.committedAt)).at(-1)?.content?.previewText ?? null;
  add('metadata', { key: 'workspace_id', value: workspaceId });
  add('metadata', { key: 'catalog_revision', value: '1' });
  add('rooms', { id: roomId, version: 1, created_order: 1, name: roomName, lifecycle: 'open', created_at: createdAt,
    archived_at: null, last_activity_at: lastAt, latest_preview: lastText?.slice(0, 160) ?? null,
    latest_order: timeline.length, read_through_order: timeline.length, unread_reply_count: 0, pending_count: pending,
    attention_count: attention, gate_segment_id: state.gate.segmentId, gate_version: state.gate.version,
    stopped_at: activeSegment?.stoppedAt ?? null, active_exchange_id: activeExchange?.id ?? null, health: 'ok', revision: 1 });
  for (const segment of state.segments) {
    add('segments', { id: segment.id, room_id: roomId, created_at: timeline.find(item => item.segmentId === segment.id)?.at ?? createdAt,
      stopped_at: segment.stoppedAt ?? null });
  }
  for (const binding of Object.values(state.bindings)) {
    add('bindings', { id: binding.id, room_id: roomId, agent: binding.agent, native_session_id: binding.nativeSessionId,
      version: binding.version ?? 1, label: binding.label ?? binding.agent, source: binding.source ?? 'manual', joined_at: binding.joinedAt ?? createdAt,
      left_at: binding.leftAt ?? null, leave_reason: binding.leaveReason ?? null,
      current: state.currentBindings[binding.agent] === binding.id ? 1 : 0, lease_id: binding.leaseId ?? null,
      deadline_at: binding.deadlineAt ?? null, last_renewed_by_reply_id: binding.lastRenewedByReplyId ?? null,
      expired_notified: binding.expiredNotified ? 1 : 0, notification_json: binding.notification == null ? null : j(binding.notification),
      batch_json: binding.batch == null ? null : j(binding.batch), drain_needs_wait: binding.drainNeedsWait ? 1 : 0 });
    for (const [requestId, result] of Object.entries(binding.readRequests ?? {})) add('read_requests', { binding_id: binding.id, request_id: requestId, result_json: j(result) });
  }
  for (const item of state.messages) add('messages', { id: item.id, room_id: roomId, version: item.version ?? 1,
    segment_id: item.segmentId, author: item.author, created_at: item.createdAt, content_json: j(item.content),
    attachment_ids_json: j(item.attachmentIds), recipients_json: j(item.recipients), delivery_ids_json: j(item.deliveryIds),
    resend_of_delivery_id: item.resendOfDeliveryId ?? null });
  for (const item of state.deliveries) {
    add('deliveries', { id: item.id, room_id: roomId, version: item.version ?? 1, message_id: item.messageId ?? null,
      source_reply_id: item.sourceReplyId ?? null, segment_id: item.segmentId, exchange_id: item.exchangeId ?? null,
      round: item.round ?? null, agent: item.agent, binding_id: item.bindingId ?? null,
      native_session_id: item.nativeSessionId ?? null, state: item.state, reason: item.reason ?? null,
      claim_id: item.claimId ?? null, wait_disposition: item.waitDisposition ?? 'none', abandoned_at: item.abandonedAt ?? null,
      evidence_json: j(item.evidence ?? { kind: 'none', at: null }), created_at: item.createdAt,
      waiting_since: item.waitingSince ?? null, final_reply_id: item.finalReplyId ?? null,
      text: item._text ?? '', attachment_ids_json: j(item._attachmentIds ?? []), write_started: item._writeStarted ? 1 : 0,
      attempted: item._attempted ? 1 : 0, work_id: null });
    if (item.bindingId) add('legacy_deliveries', { delivery_id: item.id, room_id: roomId, binding_id: item.bindingId });
  }
  for (const item of state.replies) {
    add('replies', { id: item.id, room_id: roomId, delivery_id: item.deliveryId,
    agent: item.agent, binding_id: item.bindingId, segment_id: item.segmentId, exchange_id: item.exchangeId ?? null,
    round: item.round ?? null, committed_at: item.committedAt, content_json: j(item.content),
    attachment_ids_json: j(item.attachmentIds), done: item.done ? 1 : 0, late_reasons_json: j(item.lateReasons ?? []),
    text: item._text ?? '', fingerprint: v2Fingerprint({ text: item._text ?? '', format: 'plain', attachmentIds: item.attachmentIds, done: Boolean(item.done) }),
    version: item.version ?? 1 });
    add('legacy_reply_fingerprints', { reply_id: item.id, fingerprint: item._fingerprint ?? '' });
  }
  for (const item of state.exchanges) {
    const rounds = item.rounds.map(round => ({ ...round, finishVotes: round.finishVotes ?? { codex: null, claude: null } }));
    add('exchanges', { id: item.id, room_id: roomId, segment_id: item.segmentId, version: item.version ?? 1,
      base_message_id: item.baseMessageId, previous_exchange_id: item.previousExchangeId ?? null,
      base_reply_ids_json: j(item.baseReplyIds), max_rounds: item.maxRounds, finish_policy: item.finishPolicy ?? 'first_done',
      state: item.state, current_round: item.currentRound, completed_rounds: item.completedRounds,
      rounds_json: j(rounds), ended_at: item.endedAt ?? null, end_reason: item.endReason ?? null, done_by: item.doneBy ?? null });
  }
  for (const item of timeline) {
    let data = item.data ?? null;
    const full = j(data);
    if (Buffer.byteLength(full) > 16 * 1024) {
      const digest = sha(full);
      add('legacy_timeline_payloads', { item_id: item.id, full_data_json: full, sha256: digest });
      data = { legacyPayloadSha256: digest, legacyPayloadBytes: Buffer.byteLength(full),
        ...(item.systemType === 'room_stopped' ? { stopOperationId: data?.stopOperationId ?? null,
          possibleRunningCount: data?.possibleRunningDeliveryIds?.length ?? 0,
          possibleRunningDeliveryIds: data?.possibleRunningDeliveryIds?.slice(0, 5) ?? [] } : {}) };
    }
    add('timeline', { id: item.id, room_id: roomId, order_num: item.order, version: item.version ?? 1,
      segment_id: item.segmentId, at: item.at, kind: item.kind, ref_id: item.refId ?? null,
      system_type: item.systemType ?? null, data_json: j(data), text: item.text ?? null });
  }
  for (const item of state.attachments) add('attachments', { id: item.id, room_id: roomId, name: item.name,
    media_type: item.mediaType, bytes: item.bytes, sha256: item.sha256, relative_path: item.relativePath,
    preview_available: item.previewAvailable ? 1 : 0 });
  for (const [operationId, item] of Object.entries(state.operations)) add('operations', {
    operation_id: operationId, action: item.action, room_id: roomId, request_hash: item.fingerprint,
    result_json: j(item.result), committed_at: item.result?.committedAt ?? createdAt });
  for (const item of credentials.bindings) add('http_credentials', { binding_id: item.bindingId, room_id: roomId,
    agent: item.agent, native_session_id: item.nativeSessionId, credential: item.credential,
    credential_hash: sha(item.credential), legacy: 1 });
  return rows;
}
function verifyCredentialFile(value, state) {
  if (value === null) {
    if (Object.keys(state.bindings).length) fail('CREDENTIALS_MISSING', 'V1 bindings exist but HTTP credentials are missing.');
    return { schema: 1, roomId: state.roomId, bindings: [] };
  }
  if (value.schema !== 1 || value.roomId !== state.roomId || !Array.isArray(value.bindings)) fail('CREDENTIALS_UNSAFE', 'V1 credential file identity is invalid.');
  const seen = new Set();
  for (const item of value.bindings) {
    const binding = state.bindings[item.bindingId];
    if (!binding || item.agent !== binding.agent || item.nativeSessionId !== binding.nativeSessionId || !TOKEN.test(item.credential ?? '') || seen.has(item.bindingId)) fail('CREDENTIALS_UNSAFE', 'V1 credential binding is invalid.');
    seen.add(item.bindingId);
  }
  if (seen.size !== Object.keys(state.bindings).length) fail('CREDENTIALS_MISSING', 'A V1 binding credential is absent.');
  return value;
}
function rowDigest(rows, keys) {
  const hash = createHash('sha256');
  const columns = keys.split(',');
  for (const row of [...rows].sort((a, b) => {
    for (const key of columns) { const order = String(a[key]).localeCompare(String(b[key])); if (order) return order; }
    return 0;
  })) hash.update(j(canonical(row)) + '\n');
  return hash.digest('hex');
}
async function buildStage(stageDir, rows) {
  const store = await V2Store.open({ runtimeDir: stageDir });
  try {
    await store.tx(async sql => {
      await sql.run('CREATE TABLE IF NOT EXISTS http_credentials (binding_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent TEXT NOT NULL, native_session_id TEXT NOT NULL, credential TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE, legacy INTEGER NOT NULL DEFAULT 0)');
      await sql.run('CREATE TABLE IF NOT EXISTS legacy_timeline_payloads (item_id TEXT PRIMARY KEY, full_data_json TEXT NOT NULL, sha256 TEXT NOT NULL)');
      await sql.run('CREATE TABLE IF NOT EXISTS legacy_reply_fingerprints (reply_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)');
      for (const [table, items] of Object.entries(rows)) for (const row of items) {
        const columns = Object.keys(row);
        await sql.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, Object.values(row));
      }
    });
  } finally { await store.close(); }
  const dbPath = join(stageDir, 'v2-state.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('STAGE_INVALID', 'SQLite integrity or foreign key verification failed.');
    for (const [table, items] of Object.entries(rows)) {
      const selected = Object.keys(items[0] ?? {});
      const actual = db.prepare(`SELECT ${selected.length ? selected.join(',') : '*'} FROM ${table} ORDER BY ${TABLE_KEYS[table]}`).all();
      if (actual.length !== items.length || rowDigest(actual, TABLE_KEYS[table]) !== rowDigest(items, TABLE_KEYS[table])) fail('STAGE_INVALID', `${table} count, ID or field hash differs.`);
    }
  } finally { db.close(); }
  const siblings = await readdir(stageDir);
  if (siblings.length !== 1 || siblings[0] !== 'v2-state.sqlite') fail('STAGE_INVALID', 'SQLite stage has uncheckpointed side files.');
  return { dbPath, sha256: await fileHash(dbPath), counts: Object.fromEntries(Object.entries(rows).map(([table, values]) => [table, values.length])) };
}

/** Offline, one-way preparation. The v1 source and its backup remain untouched. */
export async function migrateV1({ runtimeDir, roomName = 'Agent Chat' } = {}) {
  if (typeof runtimeDir !== 'string' || !runtimeDir || /^(?:\\\\|\/\/)/.test(runtimeDir)) fail('INVALID_INPUT', 'A local runtime directory is required.');
  if (typeof roomName !== 'string' || !roomName.trim() || [...roomName].length > 80) fail('INVALID_INPUT', 'Room name must be 1–80 characters.');
  const root = await realpath(resolve(runtimeDir));
  directory(await lstat(root, { bigint: true }), 'runtime');
  if (/^(?:\\\\|\/\/)/.test(root)) fail('INVALID_INPUT', 'A local runtime directory is required.');
  const target = join(root, 'v2-state.sqlite');
  if (await exists(target)) fail('V2_EXISTS', 'The v2 dataset already exists. Migration will not overwrite it.');
  const service = await discoverService(root);
  if (['existing', 'missing_lock'].includes(service.status)) fail('LIVE_SERVICE', 'A broker still answers for this runtime; stop and verify it before migration.');
  if (['identity_mismatch', 'invalid_descriptor', 'unsafe_lock', 'probe_error'].includes(service.status)) fail('SOURCE_UNSAFE', `Runtime service identity needs inspection: ${service.status}.`);
  const journal = join(root, 'broker-state.jsonl');
  regular(await lstat(journal, { bigint: true }), 'v1 journal');
  const roomId = await firstRoomId(journal);
  const source = await openStore({ runtimeDir: root, roomId });
  let backupDir = null;
  try {
    if (await exists(target)) fail('V2_EXISTS', 'The v2 dataset appeared while acquiring the source lock.');
    const state = source.state;
    validateState(state, roomId);
    const credentialPath = join(root, 'agent-bindings.json');
    const credentials = verifyCredentialFile(await exists(credentialPath) ? JSON.parse(await readFile(credentialPath, 'utf8')) : null, state);
    for (const item of state.attachments) await readTextAttachment(root, item);

    const backupRoot = join(root, 'backups');
    if (await exists(backupRoot)) directory(await lstat(backupRoot, { bigint: true }), 'backups');
    else await mkdir(backupRoot, { mode: 0o700 });
    const migrationId = `v1-to-v2-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    backupDir = join(backupRoot, migrationId);
    const backup = await makeBackup(root, backupDir);
    await verifyBackup(root, backupDir, backup);

    const workspaceId = `workspace-${randomUUID()}`;
    const rows = rowsFor(state, credentials, roomName, workspaceId);
    const stageDir = join(root, `migration-stage-${randomUUID()}`);
    await mkdir(stageDir, { mode: 0o700 });
    const staged = await buildStage(stageDir, rows);
    await verifyBackup(root, backupDir, backup);
    if (await exists(target)) fail('V2_EXISTS', 'The v2 dataset appeared before activation.');
    const manifest = { schema: 1, migrationId, source: { roomId, journalSha256: backup.entries.find(item => item.path === 'broker-state.jsonl')?.sha256 },
      target: { workspaceId, roomId, sqliteSha256: staged.sha256, counts: staged.counts }, backup };
    await writeFile(join(backupDir, 'migration-manifest.json'), `${j(manifest)}\n`, { flag: 'wx', mode: 0o600 });
    // Hard-link creation is atomic and fails if the destination already exists.
    // Both paths are in this runtime on the same local volume; remove the stage
    // name immediately so the activated database has the single link V2Store requires.
    await link(staged.dbPath, target);
    await unlink(staged.dbPath);
    await rmdir(stageDir);
    const activated = await lstat(target, { bigint: true }); regular(activated, 'activated v2 database');
    if (await fileHash(target) !== staged.sha256) fail('ACTIVATION_UNSAFE', 'Activated SQLite hash changed.');
    const log = await open(join(root, 'migration-manifests.jsonl'), 'a', 0o600);
    try { await log.writeFile(`${j({ migrationId, backupDir, workspaceId, roomId, sqliteSha256: staged.sha256 })}\n`); await log.sync(); }
    finally { await log.close(); }
    return { status: 'migrated', migrationId, workspaceId, roomId, backupDir, database: target, counts: staged.counts };
  } finally { await source.close(); }
}
