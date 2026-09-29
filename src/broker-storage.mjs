import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const PAGE_SIZE = 8192;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ATTACHMENT_ID = /^att-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Public errors intentionally exclude OS messages, paths and arbitrary causes. */
export class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

function fail(code, message) { throw new StorageError(code, message); }

function isNetworkPath(value) {
  return /^(?:\\\\|\/\/)/.test(value);
}

function checkedRuntime(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || isNetworkPath(value)) {
    fail('INVALID_INPUT', 'A local runtime directory is required.');
  }
  return resolve(value);
}

function within(root, candidate) {
  const part = relative(root, candidate);
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left, right) {
  return sameFile(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function requireRegular(stat, code) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    fail(code, 'The stored file is not an unaliased regular file.');
  }
}

function jsonState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', 'State must be a plain JSON object.');
  }
  const ancestors = new Set();
  const visit = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item)) fail('INVALID_INPUT', 'State must contain only acyclic JSON values.');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      fail('INVALID_INPUT', 'State must contain only plain JSON objects.');
    }
    if (Object.getOwnPropertySymbols(item).length) fail('INVALID_INPUT', 'State must contain only JSON keys.');
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail('INVALID_INPUT', 'Array entries must be ordinary JSON values.');
        }
        visit(descriptor.value);
      }
      if (Object.getOwnPropertyNames(item).length !== item.length + 1) fail('INVALID_INPUT', 'Array properties are not JSON state.');
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT', 'State properties must be ordinary JSON values.');
        visit(descriptor.value);
      }
    }
    ancestors.delete(item);
  };
  try {
    visit(value);
    return clone(value);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    fail('INVALID_INPUT', 'State cannot be serialized as JSON.');
  }
}

async function closeQuietly(handle) { try { await handle?.close(); } catch {} }

/**
 * One lifetime owner of runtimeDir/broker-state.jsonl. The broker serializes
 * transactions. Each successful commit publishes a detached state only after
 * fsync; an uncertain write poisons this instance until deliberate recovery.
 */
export async function openStore({ runtimeDir, roomId } = {}) {
  const directory = checkedRuntime(runtimeDir);
  if (typeof roomId !== 'string' || !ID.test(roomId)) fail('INVALID_INPUT', 'A valid room ID is required.');
  let lock;
  let journal;
  let lockIdentity;
  const lockPath = join(directory, 'broker-state.lock');
  const journalPath = join(directory, 'broker-state.jsonl');
  let state = null;
  let seq = 0;
  let checksum = null;
  let poisoned = false;
  let closed = false;
  let closing = false;
  let closePromise;
  let activeCommit = null;

  const release = async () => {
    let unsafe = false;
    try { await journal?.close(); } catch { unsafe = true; }
    journal = null;
    try { await lock?.close(); } catch { unsafe = true; }
    lock = null;
    if (lockIdentity) {
      try {
        const current = await lstat(lockPath, { bigint: true });
        if (!sameFile(current, lockIdentity) || !current.isFile() || current.isSymbolicLink()) unsafe = true;
        else await unlink(lockPath);
      } catch { unsafe = true; }
      lockIdentity = null;
    }
    if (unsafe) fail('JOURNAL_UNSAFE', 'Storage could not release its verified ownership safely.');
  };

  try {
    await mkdir(directory, { recursive: true });
    const canonicalDirectory = await realpath(directory);
    if (isNetworkPath(canonicalDirectory)) fail('JOURNAL_UNSAFE', 'Storage must remain on a local filesystem.');
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') fail('JOURNAL_LOCKED', 'Storage is already owned or requires explicit crash recovery.');
      throw error;
    }
    lockIdentity = await lock.stat({ bigint: true });
    await lock.writeFile(JSON.stringify({ version: 1, roomId, pid: process.pid, ownerId: randomUUID() }) + '\n');
    await lock.sync();
    try { requireRegular(await lstat(journalPath, { bigint: true }), 'JOURNAL_UNSAFE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    journal = await open(journalPath, 'a+', 0o600);
    const journalIdentity = await journal.stat({ bigint: true });
    requireRegular(journalIdentity, 'JOURNAL_UNSAFE');
    const pathIdentity = await lstat(journalPath, { bigint: true });
    requireRegular(pathIdentity, 'JOURNAL_UNSAFE');
    if (!sameFile(journalIdentity, pathIdentity)) fail('JOURNAL_UNSAFE', 'Journal identity changed during opening.');
    const bytes = await journal.readFile();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('JOURNAL_CORRUPT', 'Journal is not valid UTF-8.'); }
    if (text && !text.endsWith('\n')) fail('JOURNAL_CORRUPT', 'Journal contains an incomplete record.');
    for (const line of text ? text.slice(0, -1).split('\n') : []) {
      let record;
      try { record = JSON.parse(line); } catch { fail('JOURNAL_CORRUPT', 'Journal contains invalid JSON.'); }
      if (!record || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'checksum,previousChecksum,roomId,seq,state,version'
        || record.version !== 1 || record.roomId !== roomId || !Number.isSafeInteger(record.seq) || record.seq !== seq + 1
        || record.previousChecksum !== checksum || typeof record.checksum !== 'string' || !SHA256.test(record.checksum)) {
        fail('JOURNAL_CORRUPT', 'Journal identity, sequence or checksum chain is invalid.');
      }
      const payload = { version: 1, roomId, seq: record.seq, previousChecksum: record.previousChecksum, state: record.state };
      if (hash(JSON.stringify(payload)) !== record.checksum) fail('JOURNAL_CORRUPT', 'Journal checksum does not match its state.');
      try { state = jsonState(record.state); } catch { fail('JOURNAL_CORRUPT', 'Journal state is invalid.'); }
      seq = record.seq;
      checksum = record.checksum;
    }
  } catch (error) {
    try { await release(); } catch {}
    if (error instanceof StorageError) throw error;
    fail('JOURNAL_UNSAFE', 'Storage could not be opened safely.');
  }

  return {
    get state() { return clone(state); },
    async commit(nextState) {
      if (closed || closing) fail('CLOSED', 'Storage is closed.');
      if (poisoned) fail('JOURNAL_UNSAFE', 'An uncertain journal write requires explicit recovery.');
      if (activeCommit) fail('JOURNAL_BUSY', 'The broker must serialize state commits.');
      const next = jsonState(nextState);
      if (!Number.isSafeInteger(seq + 1)) fail('JOURNAL_UNSAFE', 'Journal sequence is exhausted.');
      const payload = { version: 1, roomId, seq: seq + 1, previousChecksum: checksum, state: next };
      const nextChecksum = hash(JSON.stringify(payload));
      const line = JSON.stringify({ ...payload, checksum: nextChecksum }) + '\n';
      activeCommit = (async () => {
        try {
          await journal.writeFile(line, 'utf8');
          await journal.sync();
        } catch {
          poisoned = true;
          fail('JOURNAL_UNSAFE', 'Journal commit is uncertain; further writes are disabled.');
        }
        seq = payload.seq;
        checksum = nextChecksum;
        state = next;
      })();
      try { await activeCommit; } finally { activeCommit = null; }
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        try { await activeCommit; } catch {}
        try { await release(); } finally { closed = true; }
      })();
      return closePromise;
    },
  };
}

async function attachmentDirectory(runtimeDir, create) {
  const directory = checkedRuntime(runtimeDir);
  if (create) await mkdir(directory, { recursive: true });
  const runtime = await realpath(directory);
  if (isNetworkPath(runtime)) fail('ATTACHMENT_UNSAFE', 'Attachments must remain on a local filesystem.');
  const candidate = join(runtime, 'attachments');
  if (create) await mkdir(candidate, { recursive: true });
  const stat = await lstat(candidate, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ATTACHMENT_UNSAFE', 'The attachment directory must not be redirected.');
  const canonical = await realpath(candidate);
  if (!within(runtime, canonical) || relative(candidate, canonical) !== '') fail('ATTACHMENT_UNSAFE', 'The attachment directory escaped its allowed location.');
  return { runtime, directory: canonical };
}

function attachmentError(error, writing = false) {
  if (error instanceof StorageError) return error;
  if (error.code === 'ENOENT' && !writing) return new StorageError('ATTACHMENT_NOT_FOUND', 'The attachment is not available.');
  return new StorageError('ATTACHMENT_UNSAFE', writing ? 'The complete attachment could not be saved.' : 'The attachment could not be read safely.');
}

export async function createTextAttachment(runtimeDir, text, name = 'reply.txt') {
  if (typeof text !== 'string' || !text.isWellFormed()) fail('INVALID_INPUT', 'Attachment text must be valid Unicode.');
  return createAttachment(runtimeDir, Buffer.from(text, 'utf8'), name, 'text/plain');
}

const MEDIA_EXT = { 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const TEXT_MEDIA = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

export async function createAttachment(runtimeDir, bytes, name, mediaType) {
  if (!Buffer.isBuffer(bytes) || !Object.hasOwn(MEDIA_EXT, mediaType)) fail('INVALID_INPUT', 'Unsupported attachment.');
  if (typeof name !== 'string' || !name.trim() || [...name].length > 160 || /[\x00-\x1f\x7f/\\]/.test(name)) {
    fail('INVALID_INPUT', 'Attachment name must be a short display name, not a path.');
  }
  let file;
  let path;
  let identity;
  try {
    const root = await attachmentDirectory(runtimeDir, true);
    const id = `att-${randomUUID()}`;
    const extension = MEDIA_EXT[mediaType];
    path = join(root.directory, `${id}.${extension}`);
    file = await open(path, 'wx', 0o600);
    identity = await file.stat({ bigint: true });
    const actual = await realpath(path);
    requireRegular(identity, 'ATTACHMENT_UNSAFE');
    const named = await lstat(path, { bigint: true });
    requireRegular(named, 'ATTACHMENT_UNSAFE');
    if (!within(root.directory, actual) || !sameFile(named, identity)) fail('ATTACHMENT_UNSAFE', 'Attachment destination changed before saving.');
    await file.writeFile(bytes);
    await file.sync();
    const currentRoot = await attachmentDirectory(runtimeDir, false);
    const current = await lstat(path, { bigint: true });
    if (relative(root.directory, currentRoot.directory) !== '' || !sameFile(current, identity)) fail('ATTACHMENT_UNSAFE', 'Attachment destination changed while saving.');
    requireRegular(current, 'ATTACHMENT_UNSAFE');
    return { id, name, mediaType, bytes: bytes.length, sha256: hash(bytes), relativePath: `attachments/${id}.${extension}`, previewAvailable: TEXT_MEDIA.has(mediaType) };
  } catch (error) {
    // Only remove a file this invocation created and can still identify.
    await closeQuietly(file);
    file = null;
    if (identity && path) {
      try { const current = await lstat(path, { bigint: true }); if (sameFile(current, identity) && !current.isSymbolicLink()) await unlink(path); } catch {}
    }
    throw attachmentError(error, true);
  } finally { await closeQuietly(file); }
}

function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || !ATTACHMENT_ID.test(metadata.id ?? '')
    || typeof metadata.sha256 !== 'string' || !SHA256.test(metadata.sha256)
    || !Object.hasOwn(MEDIA_EXT, metadata.mediaType)
    || metadata.relativePath !== `attachments/${metadata.id}.${MEDIA_EXT[metadata.mediaType]}`
    || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) {
    fail('ATTACHMENT_UNSAFE', 'Attachment metadata is invalid.');
  }
}

function cursorOffset(cursor, metadata) {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail('INVALID_CURSOR', 'Attachment cursor is invalid.');
  let value;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { fail('INVALID_CURSOR', 'Attachment cursor is invalid.'); }
  if (!value || Object.keys(value).sort().join(',') !== 'id,offset,sha256,v' || value.v !== 1 || value.id !== metadata.id
    || value.sha256 !== metadata.sha256 || !Number.isSafeInteger(value.offset) || value.offset <= 0 || value.offset % PAGE_SIZE !== 0) {
    fail('INVALID_CURSOR', 'Attachment cursor does not match this file version.');
  }
  return value.offset;
}

/** Reads only broker-created metadata; never accepts a user-supplied file path. */
export async function readAttachmentBytes(runtimeDir, metadata) {
  validateMetadata(metadata);
  let file;
  try {
    const root = await attachmentDirectory(runtimeDir, false);
    const path = join(root.directory, `${metadata.id}.${MEDIA_EXT[metadata.mediaType]}`);
    const named = await lstat(path, { bigint: true });
    requireRegular(named, 'ATTACHMENT_UNSAFE');
    const actual = await realpath(path);
    if (!within(root.directory, actual)) fail('ATTACHMENT_UNSAFE', 'Attachment escaped its allowed location.');
    file = await open(path, 'r');
    const before = await file.stat({ bigint: true });
    requireRegular(before, 'ATTACHMENT_UNSAFE');
    if (!sameFile(before, named)) fail('ATTACHMENT_CHANGED', 'Attachment identity changed before reading.');
    if (before.size !== BigInt(metadata.bytes)) fail('ATTACHMENT_CHANGED', 'Attachment content changed.');
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const currentRoot = await attachmentDirectory(runtimeDir, false);
    const current = await lstat(path, { bigint: true });
    requireRegular(current, 'ATTACHMENT_UNSAFE');
    if (relative(root.directory, currentRoot.directory) !== '' || !sameVersion(before, after) || !sameFile(current, after)
      || bytes.length !== metadata.bytes || hash(bytes) !== metadata.sha256) fail('ATTACHMENT_CHANGED', 'Attachment content or identity changed.');
    return bytes;
  } catch (error) { throw attachmentError(error); }
  finally { await closeQuietly(file); }
}

export async function readTextAttachment(runtimeDir, metadata, cursor) {
  validateMetadata(metadata);
  if (!TEXT_MEDIA.has(metadata.mediaType)) fail('ATTACHMENT_NOT_TEXT', 'This attachment is not text.');
  const offset = cursorOffset(cursor, metadata);
  const bytes = await readAttachmentBytes(runtimeDir, metadata);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('ATTACHMENT_CHANGED', 'Attachment is no longer valid UTF-8 text.'); }
    const points = Array.from(text);
    if (offset && offset >= points.length) fail('INVALID_CURSOR', 'Attachment cursor is outside this file.');
    const end = Math.min(offset + PAGE_SIZE, points.length);
    const nextCursor = end < points.length
      ? Buffer.from(JSON.stringify({ v: 1, id: metadata.id, sha256: metadata.sha256, offset: end })).toString('base64url')
      : null;
    return { attachmentId: metadata.id, sha256: metadata.sha256, text: points.slice(offset, end).join(''), nextCursor };
}
