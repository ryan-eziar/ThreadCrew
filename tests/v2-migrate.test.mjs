import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createTextAttachment, openStore } from '../src/broker-storage.mjs';
import { migrateV1 } from '../src/v2-migrate.mjs';
import { V2Broker } from '../src/v2-broker.mjs';
import { createV2Server } from '../src/v2-server.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = () => randomBytes(32).toString('base64url');
async function runtime() {
  const root = join(project, 'work');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'migration-test-'));
}
async function cleanup(path) {
  const work = resolve(project, 'work') + sep;
  const target = resolve(path);
  assert.ok(target.startsWith(work) && target.slice(work.length).startsWith('migration-test-') && !target.slice(work.length).includes(sep));
  await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
function helper(args) {
  return new Promise(done => {
    const child = spawn(process.execPath, [join(project, 'chat.mjs'), ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('exit', code => done({ code, stdout, stderr }));
  });
}
async function fixture(root) {
  const attachment = await createTextAttachment(root, 'Full attachment text: ' + 'a'.repeat(6000), 'source.txt');
  const time = '2026-09-28T04:00:00.000Z';
  const binding = { id: 'binding-claude', agent: 'claude', nativeSessionId: 'native-claude', label: 'Claude', source: 'manual',
    joinedAt: time, leaseId: 'lease-old', deadlineAt: '2026-09-29T04:00:00.000Z', lastRenewedByReplyId: null,
    expiredNotified: false, notification: null, batch: null, drainNeedsWait: true,
    readRequests: { 'read-old': { status: 'RESERVED', deliveryId: 'delivery-late', replay: true, batchId: 'batch-old' } } };
  const codexBinding = { ...binding, id: 'binding-codex', agent: 'codex', nativeSessionId: 'native-codex', label: 'Codex',
    readRequests: {}, notification: null, batch: null, drainNeedsWait: false };
  const content = text => ({ previewText: text, format: 'plain', truncated: false, attachmentId: null });
  const late = { id: 'delivery-late', version: 4, messageId: 'message-late', sourceReplyId: null, segmentId: 'segment-old',
    exchangeId: null, round: null, agent: 'claude', bindingId: binding.id, nativeSessionId: binding.nativeSessionId,
    state: 'awaiting_reply', reason: null, claimId: 'claim-old', waitDisposition: 'waiting', abandonedAt: null,
    evidence: { kind: 'written', at: time }, createdAt: time, waitingSince: time, finalReplyId: null,
    _text: 'Please finish', _attachmentIds: [attachment.id], _writeStarted: true, _attempted: true };
  const replied = { ...late, id: 'delivery-replied', messageId: 'message-replied', claimId: 'claim-replied',
    state: 'replied', waitDisposition: 'resolved', finalReplyId: 'reply-old', _text: 'Already finished', _attachmentIds: [] };
  const codexPending = { ...late, id: 'delivery-codex-pending', messageId: 'message-codex-pending', agent: 'codex',
    bindingId: codexBinding.id, nativeSessionId: codexBinding.nativeSessionId, claimId: null,
    evidence: { kind: 'native_accepted', at: time }, _text: 'Native Codex work', _attachmentIds: [] };
  const messages = [
    { id: 'message-late', segmentId: 'segment-old', author: 'ryan', createdAt: time, content: content('Please finish'),
      attachmentIds: [attachment.id], recipients: ['claude'], deliveryIds: [late.id], resendOfDeliveryId: null },
    { id: 'message-replied', segmentId: 'segment-old', author: 'ryan', createdAt: time, content: content('Already finished'),
      attachmentIds: [], recipients: ['claude'], deliveryIds: [replied.id], resendOfDeliveryId: null },
    { id: 'message-codex-pending', segmentId: 'segment-old', author: 'ryan', createdAt: time, content: content('Native Codex work'),
      attachmentIds: [], recipients: ['codex'], deliveryIds: [codexPending.id], resendOfDeliveryId: null },
  ];
  const reply = { id: 'reply-old', deliveryId: replied.id, agent: 'claude', bindingId: binding.id, segmentId: 'segment-old',
    exchangeId: null, round: null, committedAt: time, content: content('Done'), attachmentIds: [], done: false,
    lateReasons: [], _text: 'Done', _fingerprint: 'old-v1-fingerprint' };
  const largeData = { note: 'x'.repeat(20000) };
  const timeline = [
    { id: 'timeline-start', order: 1, at: time, segmentId: 'segment-old', kind: 'system', refId: null, text: 'segment_opened', systemType: 'segment_opened', data: { previousSegmentId: null } },
    { id: 'timeline-late', order: 2, at: time, segmentId: 'segment-old', kind: 'message', refId: messages[0].id, text: null, systemType: null, data: null },
    { id: 'timeline-replied', order: 3, at: time, segmentId: 'segment-old', kind: 'message', refId: messages[1].id, text: null, systemType: null, data: null },
    { id: 'timeline-reply', order: 4, at: time, segmentId: 'segment-old', kind: 'reply', refId: reply.id, text: null, systemType: null, data: null },
    { id: 'timeline-big', order: 5, at: time, segmentId: 'segment-old', kind: 'system', refId: null, text: 'diagnostic', systemType: 'diagnostic', data: largeData },
    { id: 'timeline-codex-pending', order: 6, at: time, segmentId: 'segment-old', kind: 'message', refId: codexPending.messageId, text: null, systemType: null, data: null },
  ];
  const state = { schemaVersion: 1, roomId: 'room-old', gate: { segmentId: 'segment-old', version: 5 },
    segments: [{ id: 'segment-old', stoppedAt: time }], currentBindings: { codex: codexBinding.id, claude: binding.id },
    bindings: { [binding.id]: binding, [codexBinding.id]: codexBinding }, messages, deliveries: [late, replied, codexPending], replies: [reply], exchanges: [],
    attachments: [attachment], timeline, operations: { 'op-old': { action: 'message.create', fingerprint: 'fingerprint-old',
      result: { operationId: 'op-old', committedAt: time, messageId: 'message-late', deliveryIds: { claude: late.id } } } } };
  const store = await openStore({ runtimeDir: root, roomId: state.roomId });
  try { await store.commit(state); } finally { await store.close(); }
  const credential = token(), codexCredential = token();
  await writeFile(join(root, 'agent-bindings.json'), JSON.stringify({ schema: 1, roomId: state.roomId, bindings: [
    { bindingId: binding.id, agent: binding.agent, nativeSessionId: binding.nativeSessionId, credential },
    { bindingId: codexBinding.id, agent: codexBinding.agent, nativeSessionId: codexBinding.nativeSessionId, credential: codexCredential },
  ] }));
  await mkdir(join(root, 'clients'));
  const clientName = createHash('sha256').update(binding.id).digest('hex') + '.json';
  await writeFile(join(root, 'clients', clientName), JSON.stringify({ schema: 1, agent: 'claude', nativeSessionId: binding.nativeSessionId,
    bindingId: binding.id, instanceId: 'old-instance', roomId: state.roomId, baseUrl: 'http://127.0.0.1:1', credential,
    claims: { [late.id]: { claimId: late.claimId, batchId: 'batch-old', requestId: 'read-old', finalPosted: false } }, posts: {} }));
  const codexClientName = createHash('sha256').update(codexBinding.id).digest('hex') + '.json';
  await writeFile(join(root, 'clients', codexClientName), JSON.stringify({ schema: 1, agent: 'codex', nativeSessionId: codexBinding.nativeSessionId,
    bindingId: codexBinding.id, instanceId: 'old-instance', roomId: state.roomId, baseUrl: 'http://127.0.0.1:1', credential: codexCredential,
    claims: {}, posts: {} }));
  return { state, attachment, largeData, credential, codexCredential, clientName, codexClientName };
}

test('migrates exact old identities, late claim, credentials, operations and full payloads', async () => {
  const root = await runtime();
  try {
    const { state, attachment, largeData, credential, codexCredential, clientName, codexClientName } = await fixture(root);
    const sourceBefore = await readFile(join(root, 'broker-state.jsonl'));
    const outcome = await migrateV1({ runtimeDir: root, roomName: 'Legacy room' });
    assert.equal(outcome.status, 'migrated');
    assert.equal(outcome.roomId, state.roomId);
    assert.deepEqual(await readFile(join(root, 'broker-state.jsonl')), sourceBefore);
    const backup = JSON.parse(await readFile(join(outcome.backupDir, 'migration-manifest.json'), 'utf8'));
    assert.equal(backup.source.roomId, state.roomId);
    assert.equal(backup.backup.entries.find(item => item.path === 'broker-state.jsonl').sha256, createHash('sha256').update(sourceBefore).digest('hex'));
    assert.ok(backup.backup.entries.some(item => item.path === `attachments/${attachment.id}.txt`));
    assert.ok(backup.backup.entries.some(item => item.path === `clients/${clientName}`));
    assert.ok(backup.backup.entries.some(item => item.path === `clients/${codexClientName}`));
    const db = new DatabaseSync(outcome.database);
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('SELECT name FROM rooms WHERE id=?').get(state.roomId).name, 'Legacy room');
      assert.equal(db.prepare('SELECT claim_id FROM deliveries WHERE id=?').get('delivery-late').claim_id, 'claim-old');
      assert.equal(db.prepare('SELECT binding_id FROM legacy_deliveries WHERE delivery_id=?').get('delivery-late').binding_id, 'binding-claude');
      assert.equal(db.prepare('SELECT binding_id FROM legacy_deliveries WHERE delivery_id=?').get('delivery-codex-pending').binding_id, 'binding-codex');
      assert.equal(db.prepare('SELECT legacy FROM http_credentials WHERE binding_id=?').get('binding-claude').legacy, 1);
      assert.equal(db.prepare('SELECT result_json FROM operations WHERE operation_id=?').get('op-old').result_json, JSON.stringify(state.operations['op-old'].result));
      assert.equal(JSON.parse(db.prepare('SELECT result_json FROM read_requests WHERE binding_id=? AND request_id=?').get('binding-claude', 'read-old').result_json).deliveryId, 'delivery-late');
      assert.equal(db.prepare('SELECT sha256 FROM attachments WHERE id=?').get(attachment.id).sha256, attachment.sha256);
      assert.equal(db.prepare('SELECT finish_policy FROM exchanges LIMIT 1').get(), undefined);
      assert.deepEqual(JSON.parse(db.prepare('SELECT full_data_json FROM legacy_timeline_payloads WHERE item_id=?').get('timeline-big').full_data_json), largeData);
      assert.ok(Buffer.byteLength(db.prepare('SELECT data_json FROM timeline WHERE id=?').get('timeline-big').data_json) < 1024);
      assert.equal(db.prepare('SELECT fingerprint FROM legacy_reply_fingerprints WHERE reply_id=?').get('reply-old').fingerprint, 'old-v1-fingerprint');
    } finally { db.close(); }
    let broker = await V2Broker.open({ runtimeDir: root });
    let server;
    try {
      server = await createV2Server({ broker, runtimeDir: root, projectDir: project, port: 0 });
      const body = { deliveryId: 'delivery-late', claimId: 'wrong-claim', text: 'Late final', attachmentIds: [], done: false };
      const wrong = await fetch(new URL('/agent/v1/post', server.url), { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.notEqual(wrong.status, 200);
      const badToken = await fetch(new URL('/agent/v1/post', server.url), { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, claimId: 'claim-old' }) });
      assert.equal(badToken.status, 403);
      await server.close(); server = null;
      await broker.close();
      const codexFile = join(root, 'synthetic-native-final.txt');
      await writeFile(codexFile, 'Native Codex final after restart', 'utf8');
      const codexCommand = ['post', '--runtime-dir', root, '--as', 'codex', '--binding', 'binding-codex', '--delivery', 'delivery-codex-pending', '--file', codexFile];
      const duringOutage = await helper(codexCommand);
      assert.notEqual(duringOutage.code, 0, 'a final attempted during cutover needs an explicit retry');
      assert.equal(await readFile(codexFile, 'utf8'), 'Native Codex final after restart');
      broker = await V2Broker.open({ runtimeDir: root });
      server = await createV2Server({ broker, runtimeDir: root, projectDir: project, port: 0 });
      const stillPending = await broker.store.read(sql => sql.get('SELECT state,claim_id,wait_disposition,final_reply_id FROM deliveries WHERE id=?', ['delivery-late']));
      assert.deepEqual(stillPending, { state: 'awaiting_reply', claim_id: 'claim-old', wait_disposition: 'waiting', final_reply_id: null });
      const nativePending = await broker.store.read(sql => sql.get('SELECT state,claim_id,wait_disposition,final_reply_id FROM deliveries WHERE id=?', ['delivery-codex-pending']));
      assert.deepEqual(nativePending, { state: 'awaiting_reply', claim_id: null, wait_disposition: 'waiting', final_reply_id: null });
      const responseFile = join(root, 'synthetic-late-final.txt');
      await writeFile(responseFile, 'Late final', 'utf8');
      const command = ['post', '--runtime-dir', root, '--as', 'claude', '--binding', 'binding-claude', '--delivery', 'delivery-late', '--file', responseFile];
      const posted = await helper(command);
      assert.equal(posted.code, 0, posted.stderr);
      assert.equal(JSON.parse(posted.stdout).duplicate, false);
      const duplicate = await helper(command);
      assert.equal(duplicate.code, 0, duplicate.stderr);
      assert.equal(JSON.parse(duplicate.stdout).duplicate, true);
      const saved = await broker.store.read(sql => sql.get('SELECT final_reply_id FROM deliveries WHERE id=?', ['delivery-late']));
      assert.ok(saved.final_reply_id);
      const reply = await broker.store.read(sql => sql.get('SELECT late_reasons_json FROM replies WHERE id=?', [saved.final_reply_id]));
      assert.ok(JSON.parse(reply.late_reasons_json).includes('segment_stopped'));
      const codexPosted = await helper(codexCommand);
      assert.equal(codexPosted.code, 0, codexPosted.stderr);
      assert.equal(JSON.parse(codexPosted.stdout).duplicate, false);
      const codexDuplicate = await helper(codexCommand);
      assert.equal(codexDuplicate.code, 0, codexDuplicate.stderr);
      assert.equal(JSON.parse(codexDuplicate.stdout).duplicate, true);
      const codexSaved = await broker.store.read(sql => sql.get('SELECT final_reply_id FROM deliveries WHERE id=?', ['delivery-codex-pending']));
      assert.ok(codexSaved.final_reply_id);
      const codexWrongToken = await fetch(new URL('/agent/v1/post', server.url), { method: 'POST', headers: { Authorization: `Bearer ${codexCredential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ deliveryId: 'delivery-late', claimId: 'claim-old', text: 'Wrong binding', attachmentIds: [], done: false }) });
      assert.equal(codexWrongToken.status, 403);
    } finally { await server?.close(); await broker.close(); }
    await assert.rejects(migrateV1({ runtimeDir: root }), error => error.code === 'V2_EXISTS');
  } finally { await cleanup(root); }
});

test('live writer and corrupted source are rejected without activating v2', async () => {
  const root = await runtime();
  try {
    await fixture(root);
    const owner = await openStore({ runtimeDir: root, roomId: 'room-old' });
    try { await assert.rejects(migrateV1({ runtimeDir: root }), error => error.code === 'JOURNAL_LOCKED'); }
    finally { await owner.close(); }
    const journal = join(root, 'broker-state.jsonl');
    const record = JSON.parse((await readFile(journal, 'utf8')).trim());
    record.state.gate.version += 1;
    await writeFile(journal, JSON.stringify(record) + '\n');
    await assert.rejects(migrateV1({ runtimeDir: root }), error => error.code === 'JOURNAL_CORRUPT');
    await assert.rejects(readFile(join(root, 'v2-state.sqlite')), error => error.code === 'ENOENT');
  } finally { await cleanup(root); }
});
