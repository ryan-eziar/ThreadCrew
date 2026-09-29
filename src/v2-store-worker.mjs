import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

// All SQLite work stays on this worker. The parent serializes complete logical
// transactions, so a callback can make several indexed queries without a
// second caller entering between BEGIN and COMMIT.
const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_order INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL, lifecycle TEXT NOT NULL, created_at TEXT NOT NULL,
  archived_at TEXT, last_activity_at TEXT NOT NULL, latest_preview TEXT,
  latest_order INTEGER NOT NULL DEFAULT 0, read_through_order INTEGER NOT NULL DEFAULT 0,
  unread_reply_count INTEGER NOT NULL DEFAULT 0, pending_count INTEGER NOT NULL DEFAULT 0,
  attention_count INTEGER NOT NULL DEFAULT 0, abandoned_late_count INTEGER NOT NULL DEFAULT 0,
  gate_segment_id TEXT NOT NULL,
  gate_version INTEGER NOT NULL, stopped_at TEXT, active_exchange_id TEXT,
  health TEXT NOT NULL DEFAULT 'ok', revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rooms_lifecycle_order ON rooms(lifecycle, created_order DESC);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  created_at TEXT NOT NULL, stopped_at TEXT
);
CREATE INDEX IF NOT EXISTS segments_room ON segments(room_id, created_at);
CREATE TABLE IF NOT EXISTS bindings (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), agent TEXT NOT NULL,
  native_session_id TEXT NOT NULL, version INTEGER NOT NULL, label TEXT NOT NULL,
  source TEXT NOT NULL, joined_at TEXT NOT NULL, left_at TEXT, leave_reason TEXT,
  current INTEGER NOT NULL, lease_id TEXT, deadline_at TEXT,
  last_renewed_by_reply_id TEXT, expired_notified INTEGER NOT NULL DEFAULT 0,
  notification_json TEXT, batch_json TEXT, drain_needs_wait INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS binding_one_seat ON bindings(room_id,agent) WHERE current=1;
CREATE UNIQUE INDEX IF NOT EXISTS binding_one_room_per_session ON bindings(agent,native_session_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS bindings_room ON bindings(room_id,current,agent);
CREATE INDEX IF NOT EXISTS bindings_session_history ON bindings(agent,native_session_id,left_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), version INTEGER NOT NULL,
  segment_id TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
  content_json TEXT NOT NULL, attachment_ids_json TEXT NOT NULL,
  recipients_json TEXT NOT NULL, delivery_ids_json TEXT NOT NULL,
  resend_of_delivery_id TEXT
);
CREATE INDEX IF NOT EXISTS messages_room_created ON messages(room_id,created_at);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), version INTEGER NOT NULL,
  message_id TEXT, source_reply_id TEXT, segment_id TEXT NOT NULL,
  exchange_id TEXT, round INTEGER, agent TEXT NOT NULL, binding_id TEXT,
  native_session_id TEXT, state TEXT NOT NULL, reason TEXT, claim_id TEXT,
  wait_disposition TEXT NOT NULL, abandoned_at TEXT, evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL, waiting_since TEXT, final_reply_id TEXT,
  text TEXT NOT NULL, attachment_ids_json TEXT NOT NULL,
  write_started INTEGER NOT NULL DEFAULT 0, attempted INTEGER NOT NULL DEFAULT 0,
  work_id TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_binding_queue ON deliveries(binding_id,state,created_at,id);
CREATE INDEX IF NOT EXISTS deliveries_binding_unresolved ON deliveries(binding_id,wait_disposition,final_reply_id);
CREATE INDEX IF NOT EXISTS deliveries_room_state ON deliveries(room_id,state,created_at,id);
CREATE INDEX IF NOT EXISTS deliveries_room_wait ON deliveries(room_id,wait_disposition,waiting_since) WHERE final_reply_id IS NULL;
CREATE INDEX IF NOT EXISTS deliveries_stuck_due ON deliveries(waiting_since,room_id)
  WHERE final_reply_id IS NULL AND wait_disposition='waiting' AND state IN ('dispatching','awaiting_reply');
CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries(message_id);
CREATE INDEX IF NOT EXISTS deliveries_source_reply ON deliveries(source_reply_id);
CREATE INDEX IF NOT EXISTS deliveries_exchange ON deliveries(exchange_id);
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_claim ON deliveries(claim_id) WHERE claim_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), delivery_id TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL, binding_id TEXT NOT NULL, segment_id TEXT NOT NULL,
  exchange_id TEXT, round INTEGER, committed_at TEXT NOT NULL,
  content_json TEXT NOT NULL, attachment_ids_json TEXT NOT NULL, done INTEGER NOT NULL,
  late_reasons_json TEXT NOT NULL, text TEXT NOT NULL, fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_room ON replies(room_id,committed_at);
CREATE TABLE IF NOT EXISTS exchanges (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), segment_id TEXT NOT NULL,
  version INTEGER NOT NULL, base_message_id TEXT NOT NULL, previous_exchange_id TEXT,
  base_reply_ids_json TEXT NOT NULL, max_rounds INTEGER NOT NULL,
  finish_policy TEXT NOT NULL, state TEXT NOT NULL, current_round INTEGER NOT NULL,
  completed_rounds INTEGER NOT NULL, rounds_json TEXT NOT NULL, ended_at TEXT,
  end_reason TEXT, done_by TEXT
);
CREATE INDEX IF NOT EXISTS exchanges_room_state ON exchanges(room_id,state);
CREATE INDEX IF NOT EXISTS exchanges_room_base ON exchanges(room_id,base_message_id);
CREATE TABLE IF NOT EXISTS timeline (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), order_num INTEGER NOT NULL,
  version INTEGER NOT NULL, segment_id TEXT NOT NULL, at TEXT NOT NULL,
  kind TEXT NOT NULL, ref_id TEXT, system_type TEXT, data_json TEXT,
  text TEXT, UNIQUE(room_id,order_num)
);
CREATE INDEX IF NOT EXISTS timeline_room_order ON timeline(room_id,order_num);
CREATE INDEX IF NOT EXISTS timeline_room_ref ON timeline(room_id,kind,ref_id);
CREATE INDEX IF NOT EXISTS timeline_room_kind_order ON timeline(room_id,kind,order_num DESC);
CREATE INDEX IF NOT EXISTS timeline_exchange_system ON timeline(room_id,json_extract(data_json,'$.exchangeId'))
  WHERE kind='system' AND system_type IN ('exchange_started','exchange_ended');
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), name TEXT NOT NULL,
  media_type TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  relative_path TEXT NOT NULL, preview_available INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_room ON attachments(room_id);
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY, action TEXT NOT NULL, room_id TEXT,
  request_hash TEXT NOT NULL, result_json TEXT NOT NULL, committed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS read_requests (
  binding_id TEXT NOT NULL, request_id TEXT NOT NULL, result_json TEXT NOT NULL,
  PRIMARY KEY(binding_id,request_id)
);
CREATE TABLE IF NOT EXISTS legacy_deliveries (
  delivery_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
  binding_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS legacy_deliveries_binding ON legacy_deliveries(binding_id,room_id);
CREATE TABLE IF NOT EXISTS catalog_notices (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, work_id TEXT,
  kind TEXT NOT NULL, at TEXT NOT NULL, timeline_item_id TEXT,
  preview_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS catalog_notices_room_at ON catalog_notices(room_id,at);
CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  segment_id TEXT NOT NULL, version INTEGER NOT NULL, occupancy TEXT NOT NULL,
  state TEXT NOT NULL, expires_at TEXT NOT NULL, binding_codex TEXT NOT NULL,
  binding_claude TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_sessions_room_occupancy ON work_sessions(room_id,occupancy);
CREATE INDEX IF NOT EXISTS work_sessions_binding_codex ON work_sessions(binding_codex,occupancy);
CREATE INDEX IF NOT EXISTS work_sessions_binding_claude ON work_sessions(binding_claude,occupancy);
CREATE TABLE IF NOT EXISTS work_requests (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  work_id TEXT NOT NULL REFERENCES work_sessions(id), to_binding_id TEXT NOT NULL,
  state TEXT NOT NULL, wait_disposition TEXT NOT NULL, claim_id TEXT,
  request_number INTEGER NOT NULL, timeline_id TEXT, version INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_requests_work_number ON work_requests(work_id,request_number);
CREATE INDEX IF NOT EXISTS work_requests_binding_queue ON work_requests(to_binding_id,state,request_number);
CREATE INDEX IF NOT EXISTS work_requests_room_state ON work_requests(room_id,state);
CREATE UNIQUE INDEX IF NOT EXISTS work_requests_claim ON work_requests(claim_id) WHERE claim_id IS NOT NULL;
`);
// Small additive migrations for local pre-release v2 datasets. Never rewrite
// existing rows or silently fall back to a fresh database.
if (!db.prepare('PRAGMA table_info(rooms)').all().some(column=>column.name==='abandoned_late_count')) {
  db.exec('ALTER TABLE rooms ADD COLUMN abandoned_late_count INTEGER NOT NULL DEFAULT 0');
}
for (const column of ['join_codex_version', 'join_claude_version']) {
  if (!db.prepare('PRAGMA table_info(rooms)').all().some(item => item.name === column)) {
    db.exec(`ALTER TABLE rooms ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 1`);
  }
}

function output(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(output);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, output(item)]));
  return value;
}

parentPort.on('message', ({ id, op, sql, params = [] }) => {
  try {
    let result;
    if (op === 'get') result = db.prepare(sql).get(...params) ?? null;
    else if (op === 'all') result = db.prepare(sql).all(...params);
    else if (op === 'run') result = db.prepare(sql).run(...params);
    else if (op === 'begin') result = db.exec('BEGIN IMMEDIATE');
    else if (op === 'readBegin') result = db.exec('BEGIN');
    else if (op === 'commit') result = db.exec('COMMIT');
    else if (op === 'rollback') result = db.exec('ROLLBACK');
    else if (op === 'close') { db.close(); result = true; }
    else throw new Error('INVALID_WORKER_OPERATION');
    parentPort.postMessage({ id, ok: true, result: output(result) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, code: error?.code ?? 'SQLITE_ERROR', message: String(error?.message ?? 'SQLite error').slice(0, 300) });
  }
});
