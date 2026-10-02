import { extname, resolve } from 'node:path';
import { createAttachment, readAttachmentBytes } from './broker-storage.mjs';
import { isSupportedNode, SUPPORTED_NODE_RANGE } from './node-runtime.mjs';
import packageInfo from '../package.json' with { type: 'json' };

export const PRODUCT = { product: 'ThreadCrew', version: packageInfo.version, author: 'Ryan Zhang', license: 'MIT' };
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status, outcome: 'rejected' }); };
const parse = (value, fallback = null) => value == null ? fallback : JSON.parse(value);
const shortText = (value, max) => {
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length > max) fail('INVALID_INPUT');
  return value;
};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const meta = row => ({ id: row.id, name: row.name, mediaType: row.media_type, bytes: row.bytes,
  sha256: row.sha256, relativePath: row.relative_path, previewAvailable: Boolean(row.preview_available) });
const publicMeta = value => { const { relativePath, ...safe } = value; return safe; };
const markdownLabel = value => String(value).replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
const settingsKey = 'threadcrew_settings';
const notesKey = roomId => `threadcrew_notes:${roomId}`;
async function readValue(sql, key, fallback) { return parse((await sql.get('SELECT value FROM metadata WHERE key=?', [key]))?.value, fallback); }
async function writeValue(sql, key, value) {
  await sql.run('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]);
}
export async function roomNotes(sql, roomId) { return readValue(sql, notesKey(roomId), { version: 0, text: '', updatedAt: null }); }

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json' };
function uploadBytes(input) {
  shortText(input.name, 160);
  if (!input.name.trim() || /[\x00-\x1f\x7f/\\:]/.test(input.name)) fail('INVALID_INPUT');
  const type = TYPES[extname(input.name).toLowerCase()];
  if (!type || input.mediaType !== type) fail('UNSUPPORTED_ATTACHMENT_TYPE', 415);
  if (typeof input.dataBase64 !== 'string' || input.dataBase64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) fail('CONTENT_TOO_LARGE', 413);
  if (input.dataBase64.length % 4 || /[^A-Za-z0-9+/=]/.test(input.dataBase64)) fail('INVALID_INPUT');
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.toString('base64') !== input.dataBase64) fail('INVALID_INPUT');
  if (bytes.length > MAX_UPLOAD_BYTES) fail('CONTENT_TOO_LARGE', 413);
  let valid = true;
  if (type === 'image/png') valid = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  else if (type === 'image/jpeg') valid = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  else if (type === 'image/webp') valid = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  else if (type === 'application/pdf') valid = bytes.toString('ascii', 0, 5) === '%PDF-';
  else {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) valid = false;
      if (type === 'application/json') JSON.parse(text);
    } catch { valid = false; }
  }
  if (!valid) fail('ATTACHMENT_TYPE_MISMATCH', 415);
  return bytes;
}

/** Small local features sharing the broker's transaction and authorization boundary. */
export class ThreadCrewFeatures {
  constructor(broker, projectDir) { this.broker = broker; this.projectDir = resolve(projectDir); }
  async room(sql, roomId) {
    const room = await sql.get('SELECT * FROM rooms WHERE id=?', [roomId]);
    if (!room) fail('ROOM_NOT_FOUND', 404);
    return room;
  }
  async settings() { return this.broker.store.read(async sql => ({ backgroundNoticeAcknowledged: false, autoCheckUpdates: true,
    ...await readValue(sql, settingsKey, { version: 0, displayName: '' }) })); }
  async setSettings(input) {
    const displayName = input.displayName === undefined ? undefined : shortText(input.displayName, 80).trim();
    if (displayName !== undefined && /[\x00-\x1f\x7f]/.test(displayName)) fail('INVALID_INPUT');
    if ((displayName === undefined && input.backgroundNoticeAcknowledged === undefined && input.autoCheckUpdates === undefined)
      || (input.backgroundNoticeAcknowledged !== undefined && typeof input.backgroundNoticeAcknowledged !== 'boolean')
      || (input.autoCheckUpdates !== undefined && typeof input.autoCheckUpdates !== 'boolean')) fail('INVALID_INPUT');
    return this.broker.mutate('settings.update', null, input, async ctx => {
      const previous = await readValue(ctx.sql, settingsKey, { version: 0, displayName: '' });
      if (input.expectedVersion !== previous.version) fail('VERSION_CONFLICT', 409);
      const settings = { backgroundNoticeAcknowledged: false, autoCheckUpdates: true, ...previous, version: previous.version + 1,
        ...(displayName === undefined ? {} : { displayName }),
        ...(input.autoCheckUpdates === undefined ? {} : { autoCheckUpdates: input.autoCheckUpdates }),
        ...(input.backgroundNoticeAcknowledged === undefined ? {} : { backgroundNoticeAcknowledged: input.backgroundNoticeAcknowledged }) };
      await writeValue(ctx.sql, settingsKey, settings);
      return { settings };
    }, { gate: false });
  }
  async notes(roomId) { return this.broker.store.read(async sql => { await this.room(sql, roomId); return roomNotes(sql, roomId); }); }
  async setNotes(roomId, input) {
    shortText(input.text, 8000);
    return this.broker.mutate('notes.update', roomId, input, async ctx => {
      if (ctx.room.lifecycle !== 'open') fail('ROOM_ARCHIVED', 409);
      const previous = await roomNotes(ctx.sql, roomId);
      if (input.expectedVersion !== previous.version) fail('VERSION_CONFLICT', 409);
      const notes = { version: previous.version + 1, text: input.text, updatedAt: ctx.now };
      await writeValue(ctx.sql, notesKey(roomId), notes);
      return { notes };
    }, { gate: false });
  }
  async upload(roomId, input) {
    const bytes = uploadBytes(input);
    return this.broker.mutate('attachments.upload', roomId, input, async ctx => {
      if (ctx.room.lifecycle !== 'open') fail('ROOM_ARCHIVED', 409);
      const attachment = await createAttachment(this.broker.runtimeDir, bytes, input.name, input.mediaType);
      await ctx.sql.run('INSERT INTO attachments(id,room_id,name,media_type,bytes,sha256,relative_path,preview_available) VALUES(?,?,?,?,?,?,?,?)',
        [attachment.id,roomId,attachment.name,attachment.mediaType,attachment.bytes,attachment.sha256,attachment.relativePath,attachment.previewAvailable ? 1 : 0]);
      return { attachment: publicMeta(attachment) };
    }, { gate: false });
  }
  async download(roomId, attachmentId) {
    const row = await this.broker.store.read(async sql => { await this.room(sql, roomId); return sql.get('SELECT * FROM attachments WHERE id=? AND room_id=?', [attachmentId,roomId]); });
    if (!row) fail('ATTACHMENT_NOT_FOUND', 404);
    const metadata = meta(row);
    return { metadata: publicMeta(metadata), bytes: await readAttachmentBytes(this.broker.runtimeDir, metadata) };
  }
  diagnostics() {
    return { ...PRODUCT, nodeVersion: process.versions.node, platform: process.platform,
      supportedPlatform: process.platform === 'win32',
      supportedNodeRange: SUPPORTED_NODE_RANGE,
      checks: [{ id: 'node', status: isSupportedNode() ? 'ok' : 'unverified' },
        { id: 'native_connections', status: 'check_room_members' }],
      capabilities: { localOnly: true, uploads: true, search: true, markdownExport: true, roomNotes: true,
        maxUploadBytes: MAX_UPLOAD_BYTES, maxAttachments: 20, nativeCancellationSupported: false } };
  }
  async shutdownPreview() {
    return this.broker.store.read(sql => this.shutdownSnapshot(sql));
  }
  async shutdownSnapshot(sql) {
      const capturedAt = new Date().toISOString();
      const work = await sql.get("SELECT COUNT(DISTINCT room_id) AS n FROM work_sessions WHERE occupancy='held' AND state NOT IN ('completed','stopped','expired') AND expires_at>?", [capturedAt]);
      const deliveries = await sql.get(`SELECT
        COALESCE(SUM(state IN ('queued','pending_binding')),0) AS queued,
        COALESCE(SUM(state IN ('dispatching','awaiting_reply')),0) AS in_flight,
        COALESCE(SUM(state='uncertain'),0) AS uncertain
        FROM deliveries WHERE final_reply_id IS NULL AND wait_disposition!='abandoned'`);
      const requests = await sql.get(`SELECT
        COALESCE(SUM(state IN ('queued','notified','claimed','awaiting_response','uncertain') AND wait_disposition!='abandoned'),0) AS pending,
        COALESCE(SUM(json_extract(data_json,'$._responseState') IN ('queued','notified','claimed','uncertain')),0) AS responses
        FROM work_requests WHERE wait_disposition!='abandoned'`);
      return { instanceId: this.broker.instanceId, capturedAt, counts: {
        activeWorkRooms: work.n, queuedDeliveries: deliveries.queued,
        pendingWorkRequests: requests.pending, pendingWorkResponses: requests.responses,
        inFlightDeliveries: deliveries.in_flight, uncertainDeliveries: deliveries.uncertain,
      } };
  }
  async updatePreview(sql = null) {
    if (!sql) return this.broker.store.read(tx => this.updatePreview(tx));
    const snapshot = await this.shutdownSnapshot(sql);
    const rooms = await sql.all(`SELECT r.id AS roomId,r.name AS roomName,
      (SELECT COUNT(*) FROM deliveries d WHERE d.room_id=r.id AND d.final_reply_id IS NULL AND d.wait_disposition!='abandoned' AND d.state IN ('dispatching','awaiting_reply','uncertain')) AS unresolvedDeliveries,
      (SELECT COUNT(*) FROM deliveries d WHERE d.room_id=r.id AND d.final_reply_id IS NULL AND d.wait_disposition!='abandoned' AND d.state IN ('queued','pending_binding')) AS queuedDeliveries,
      (SELECT COUNT(*) FROM work_sessions w WHERE w.room_id=r.id AND w.occupancy='held' AND w.state NOT IN ('completed','stopped','expired') AND w.expires_at>?) AS activeWork
      FROM rooms r`,[snapshot.capturedAt]);
    const busy=[];
    for(const room of rooms){
      const requests=await sql.get("SELECT COUNT(*) AS n FROM work_requests WHERE room_id=? AND wait_disposition!='abandoned' AND (state IN ('queued','notified','claimed','awaiting_response','uncertain') OR json_extract(data_json,'$._responseState') IN ('queued','notified','claimed','uncertain'))",[room.roomId]);
      if(!room.unresolvedDeliveries&&!room.queuedDeliveries&&!room.activeWork&&!requests.n)continue;
      const bindings=await sql.all('SELECT agent FROM bindings WHERE room_id=? AND current=1 ORDER BY agent',[room.roomId]);
      const pendingAgents=await sql.all("SELECT DISTINCT agent FROM deliveries WHERE room_id=? AND final_reply_id IS NULL AND wait_disposition!='abandoned' AND state IN ('queued','pending_binding','dispatching','awaiting_reply','uncertain')",[room.roomId]);
      busy.push({...room,pendingWorkRequests:requests.n,activeWork:Boolean(room.activeWork),agents:room.activeWork?bindings.map(b=>b.agent):pendingAgents.map(b=>b.agent)});
    }
    return {...snapshot,rooms:busy};
  }
  async snapshot(roomId) {
    return this.broker.store.read(async sql => ({ room: await this.room(sql, roomId),
      settings: await readValue(sql, settingsKey, { version: 0, displayName: '' }), notes: await roomNotes(sql, roomId) }));
  }
  async *entries(roomId, maxOrder, descending = false, before = null) {
    let position = before ?? (descending ? maxOrder + 1 : 0);
    for (;;) {
      const rows = await this.broker.store.read(sql => sql.all(`SELECT t.*,m.author AS message_author,m.content_json AS message_content,m.attachment_ids_json AS message_attachments,
        (SELECT text FROM deliveries WHERE message_id=m.id AND room_id=t.room_id ORDER BY created_at,id LIMIT 1) AS message_text,
        r.agent AS reply_author,r.text AS reply_text,r.attachment_ids_json AS reply_attachments,
        wr.data_json AS work_request FROM timeline t
        LEFT JOIN messages m ON t.kind='message' AND m.id=t.ref_id AND m.room_id=t.room_id
        LEFT JOIN replies r ON t.kind='reply' AND r.id=t.ref_id AND r.room_id=t.room_id
        LEFT JOIN work_requests wr ON t.kind='work' AND wr.id=json_extract(t.data_json,'$.requestId') AND wr.room_id=t.room_id
        WHERE t.room_id=? AND t.order_num<=? AND t.order_num${descending ? '<' : '>'}? ORDER BY t.order_num ${descending ? 'DESC' : 'ASC'} LIMIT 100`, [roomId,maxOrder,position]));
      if (!rows.length) return;
      for (const row of rows) {
        position = row.order_num;
        const work = parse(row.data_json, {}), request = parse(row.work_request, {});
        let author = row.message_author ?? row.reply_author ?? (row.kind === 'work' ? work.author : null) ?? 'system';
        if (!['ryan','codex','claude','system'].includes(author)) author = 'system';
        const content = row.kind === 'message' ? parse(row.message_content) : row.kind === 'work' ? work.content : null;
        let text = row.message_text ?? row.reply_text ?? (row.kind === 'work' ? (work.eventKind === 'response' ? request._responseText : work.eventKind === 'request' ? request._text : null) : null);
        if (text == null && content?.truncated && content.attachmentId) {
          const attachment = await this.download(roomId, content.attachmentId);
          text = new TextDecoder('utf-8', { fatal: true }).decode(attachment.bytes);
        }
        text ??= content?.previewText ?? row.text ?? (row.kind === 'work' ? work.eventKind : '') ?? '';
        const attachmentIds = parse(row.message_attachments ?? row.reply_attachments, row.kind === 'work' ? work.attachmentIds ?? [] : []);
        const attachments = await this.broker.store.read(async sql => {
          const items = [];
          for (const id of attachmentIds) { const item = await sql.get('SELECT name,bytes FROM attachments WHERE id=? AND room_id=?', [id,roomId]); if (item) items.push(item); }
          return items;
        });
        yield { id: row.id, order: row.order_num, at: row.at, author, text, attachments, kind: row.kind };
      }
    }
  }
  async search(roomId, { q, limit = 20, cursor = null } = {}) {
    const query = shortText(q, 200).trim();
    if (!query || !Number.isInteger(limit) || limit < 1 || limit > 50) fail('INVALID_INPUT');
    const snapshot = await this.snapshot(roomId);
    let maxOrder = snapshot.room.latest_order, before = null;
    if (cursor) {
      let c; try { if (cursor.length > 4096 || !/^[\w-]+$/.test(cursor)) throw new Error(); c = JSON.parse(Buffer.from(cursor,'base64url')); } catch { fail('INVALID_CURSOR'); }
      if (c.v !== 1 || c.kind !== 'search' || c.workspaceId !== this.broker.workspaceId || c.roomId !== roomId || c.q !== query ||
          !Number.isSafeInteger(c.maxOrder) || c.maxOrder < 0 || !Number.isSafeInteger(c.before) || c.before < 1) fail('INVALID_CURSOR');
      maxOrder = c.maxOrder; before = c.before;
    }
    const items = [];
    for await (const entry of this.entries(roomId, maxOrder, true, before)) {
      if (entry.kind === 'system') continue;
      const index = entry.text.toLowerCase().indexOf(query.toLowerCase());
      if (index < 0) continue;
      items.push({ id: entry.id, order: entry.order, at: entry.at, author: entry.author,
        previewText: (index > 80 ? '…' : '') + [...entry.text.slice(Math.max(0,index - 80))].slice(0,240).join(''),
        aroundCursor: encode({ v: 1, workspaceId: this.broker.workspaceId, roomId, order: entry.order, direction: 'around' }) });
      if (items.length > limit) break;
    }
    const more = items.length > limit; if (more) items.pop();
    return { items, nextCursor: more ? encode({ v: 1, kind: 'search', workspaceId: this.broker.workspaceId, roomId, q: query, maxOrder, before: items.at(-1).order }) : null };
  }
  async export(roomId, lang = 'en') {
    if (!['en', 'zh'].includes(lang)) fail('INVALID_INPUT');
    const snapshot = await this.snapshot(roomId), self = this;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const labels = lang === 'zh'
      ? { intro: `从 ThreadCrew 导出。时区：${timeZone}。不包含系统事件；附件仅列出名称，不包含二进制文件。`, notes: '群说明', you: '你', system: '系统', attachment: '附件', bytes: '字节' }
      : { intro: `Exported from ThreadCrew. Time zone: ${timeZone}. System events are omitted. Attachments are listed only; binary files are not included.`, notes: 'Room notes', you: 'You', system: 'System', attachment: 'Attachment', bytes: 'bytes' };
    const localTime = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
    return { name: `${snapshot.room.name}-${new Date().toISOString().slice(0,10)}.md`, async *chunks() {
      yield `# ${markdownLabel(snapshot.room.name)}\n\n${labels.intro}\n\n`;
      if (snapshot.notes.text) yield `## ${labels.notes}\n\n${snapshot.notes.text}\n\n`;
      for await (const entry of self.entries(roomId,snapshot.room.latest_order)) {
        if (entry.kind === 'system') continue;
        const speaker = entry.author === 'ryan' ? snapshot.settings.displayName || labels.you : entry.author === 'system' ? labels.system : entry.author === 'codex' ? 'Codex' : 'Claude';
        yield `## ${markdownLabel(speaker)} · ${localTime.format(new Date(entry.at))}\n\n${entry.text}\n\n`;
        for (const attachment of entry.attachments) yield `- ${labels.attachment}: ${markdownLabel(attachment.name)} (${attachment.bytes} ${labels.bytes})\n`;
        if (entry.attachments.length) yield '\n';
      }
      yield '<!-- ThreadCrew export complete -->\n';
    } };
  }
}
