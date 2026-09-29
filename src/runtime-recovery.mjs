import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverService } from './service-discovery.mjs';
import { openStore } from './broker-storage.mjs';

const ROOT_FILES = ['broker-state.lock', 'broker-state.jsonl', 'v2-state.sqlite',
  'v2-state.sqlite-wal', 'v2-state.sqlite-shm', 'connection-codex.json',
  'connection-claude.json', 'agent-bindings.json', 'migration-manifests.jsonl',
  'native-receive-proof.json'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function within(root, file) {
  const part = relative(root, file);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith('..' + sep)) fail('UNSAFE_PATH');
  return part;
}
async function optionalStat(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function regular(file) {
  const stat = await optionalStat(file);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('UNSAFE_FILE');
  return stat;
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}
async function syncFile(file) {
  const handle = await fs.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function save(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
async function directory(file, create = false) {
  if (create) await fs.mkdir(file, { recursive: true });
  const stat = await fs.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
}

// All launchers must hash the same canonical path for their Windows mutex,
// including when a shortcut points through a directory junction.
export async function canonicalRuntime(runtimeDir) {
  if (!runtimeDir || /^(?:\\\\|\/\/)/.test(runtimeDir)) fail('LOCAL_RUNTIME_REQUIRED');
  let candidate = resolve(runtimeDir);
  const suffix = [];
  while (!(await optionalStat(candidate))) {
    const parent = dirname(candidate);
    if (parent === candidate) fail('UNSAFE_PATH');
    suffix.unshift(relative(parent, candidate)); candidate = parent;
  }
  const canonical = join(await fs.realpath(candidate), ...suffix);
  if (/^(?:\\\\|\/\/)/.test(canonical)) fail('LOCAL_RUNTIME_REQUIRED');
  return canonical;
}

async function inputs(root) {
  const files = [];
  for (const name of ROOT_FILES) if (await optionalStat(join(root, name))) files.push(name);
  async function walk(dir, prefix) {
    await directory(dir);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = join(prefix, entry.name), file = join(root, name);
      if (entry.isSymbolicLink()) fail('UNSAFE_FILE');
      if (entry.isDirectory()) await walk(file, name);
      else { await regular(file); files.push(name); }
    }
  }
  for (const name of ['clients', 'attachments', 'replies']) {
    if (await optionalStat(join(root, name))) await walk(join(root, name), name);
  }
  return files.sort();
}

async function deadOwner(root, expected) {
  const file = join(root, 'broker-state.lock');
  const stat = await regular(file);
  const bytes = await fs.readFile(file);
  let owner; try { owner = JSON.parse(bytes); } catch { fail('INVALID_LOCK'); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !ID.test(owner.ownerId ?? '')) fail('INVALID_LOCK');
  if (expected && (identity(stat) !== expected.identity || !bytes.equals(expected.bytes))) fail('LOCK_CHANGED');
  // ESRCH is the only positive evidence of absence. Access-denied and reused
  // live PIDs remain blocked; no process is ever killed by recovery.
  try { process.kill(owner.pid, 0); fail('OWNER_ALIVE'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (owner.version !== 2) fail('UNSUPPORTED_LOCK');
  return { owner, bytes, identity: identity(stat) };
}
async function verifySources(root, manifest) {
  if (JSON.stringify(await inputs(root)) !== JSON.stringify(manifest.files.map(file => file.path))) fail('SOURCE_CHANGED');
  for (const file of manifest.files) {
    const source = join(root, file.path);
    if (identity(await regular(source)) !== file.identity || await sha256(source) !== file.sha256) fail('SOURCE_CHANGED');
  }
}

async function validateCopy(raw, validation, manifest) {
  const { DatabaseSync, backup } = await import('node:sqlite');
  await fs.mkdir(validation);
  for (const name of ['v2-state.sqlite', 'v2-state.sqlite-wal', 'broker-state.jsonl']) {
    if (manifest.files.some(file => file.path === name)) await fs.copyFile(join(raw, name), join(validation, name), fs.constants.COPYFILE_EXCL);
  }
  // Never open the original DB or raw evidence with SQLite. WAL is part of the
  // database; SHM is preserved in raw but rebuilt on this disposable copy.
  const db = new DatabaseSync(join(validation, 'v2-state.sqlite'), { readOnly: true });
  let workspaceId, attachments;
  try {
    const checks = db.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') fail('DATABASE_CORRUPT');
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('FOREIGN_KEY_ERROR');
    workspaceId = db.prepare("SELECT value FROM metadata WHERE key='workspace_id'").get()?.value;
    if (!ID.test(workspaceId ?? '')) fail('WORKSPACE_MISSING');
    attachments = db.prepare('SELECT relative_path,bytes,sha256 FROM attachments').all();
    for (const item of attachments) {
      if (typeof item.relative_path !== 'string' || isAbsolute(item.relative_path)) fail('UNSAFE_ATTACHMENT');
      const file = resolve(raw, item.relative_path);
      const name = within(raw, file);
      const saved = manifest.files.find(entry => entry.path === name);
      if (!saved || saved.bytes !== String(item.bytes) || saved.sha256 !== item.sha256) fail('ATTACHMENT_MISMATCH');
    }
    await backup(db, join(validation, 'verified.sqlite'));
    await syncFile(join(validation, 'verified.sqlite'));
  } finally { db.close(); }
  for (const role of ['codex', 'claude']) {
    const file = join(raw, `connection-${role}.json`);
    if (await optionalStat(file)) {
      const descriptor = JSON.parse(await fs.readFile(file, 'utf8'));
      if (descriptor.apiVersion !== 'agent-chat.window.v2' || descriptor.workspaceId !== workspaceId) fail('WORKSPACE_MISMATCH');
    }
  }
  let journal = 'absent';
  const journalPath = join(validation, 'broker-state.jsonl');
  if (await optionalStat(journalPath)) {
    const text = await fs.readFile(journalPath, 'utf8');
    let first; try { first = JSON.parse(text.split('\n', 1)[0]); } catch { fail('JOURNAL_CORRUPT'); }
    const store = await openStore({ runtimeDir: validation, roomId: first.roomId });
    await store.close(); journal = 'valid';
  }
  return { workspaceId, sqlite: 'ok', foreignKeys: 'ok', attachments: attachments.length, journal };
}

/** Only call while the canonical runtime's Windows launcher mutex is held.
 * Direct `serve` keeps its exclusive-lock refusal. The launcher owns recovery
 * and startup as one operation. This child only prepares evidence: if the
 * launcher dies and releases its mutex, an orphan helper cannot move a lock.
 */
export async function recoverRuntime(runtimeDir) {
  const root = await canonicalRuntime(runtimeDir);
  const expected = await deadOwner(root);
  if ((await discoverService(root)).status !== 'locked') fail('SERVICE_STATE_CHANGED');
  await regular(join(root, 'v2-state.sqlite'));
  const parent = join(root, 'recovery-evidence');
  await directory(parent, true);
  const evidence = join(parent, `recovery-${randomUUID()}`);
  await fs.mkdir(evidence, { mode: 0o700 });
  const raw = join(evidence, 'raw'); await fs.mkdir(raw, { mode: 0o700 });
  const manifest = { version: 1, createdAt: new Date().toISOString(), ownerPid: expected.owner.pid, files: [] };
  try {
    for (const name of await inputs(root)) {
      const source = join(root, name), target = join(raw, name);
      within(root, source); within(raw, target);
      const before = await regular(source), digest = await sha256(source);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL); await syncFile(target);
      if (identity(await regular(source)) !== identity(before) || await sha256(target) !== digest || await sha256(source) !== digest) fail('SOURCE_CHANGED');
      manifest.files.push({ path: name, bytes: before.size.toString(), identity: identity(before), sha256: digest });
    }
    await save(join(evidence, 'manifest.json'), manifest);
    const verified = await validateCopy(raw, join(evidence, 'validation'), manifest);
    await verifySources(root, manifest);
    await deadOwner(root, expected);
    if ((await discoverService(root)).status !== 'locked') fail('SERVICE_STATE_CHANGED');
    await deadOwner(root, expected);
    await save(join(evidence, 'verified.json'), { ...verified, verifiedAt: new Date().toISOString() });
    // The mutex-owning PowerShell process rechecks PID and lock bytes, then
    // performs the same-volume move itself. Original files stay untouched here.
    return { status: 'verified', evidence, workspaceId: verified.workspaceId,
      ownerPid: expected.owner.pid, lockSha256: createHash('sha256').update(expected.bytes).digest('hex') };
  } catch (error) {
    // Only code/path are reported; no chat text or credential bytes in logs.
    throw Object.assign(new Error('Automatic recovery stopped; original lock and data retained.'), { code: error.code ?? 'VALIDATION_FAILED', evidence });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, root] = process.argv.slice(2);
    if (!root || !['canonical', 'recover'].includes(mode)) fail('INVALID_ARGUMENTS');
    console.log(JSON.stringify(mode === 'canonical' ? { runtimeDir: await canonicalRuntime(root) } : await recoverRuntime(root)));
  } catch (error) {
    console.log(JSON.stringify({ status: 'blocked', code: error.code ?? 'RECOVERY_FAILED', ...(error.evidence ? { evidence: error.evidence } : {}) }));
    process.exitCode = 1;
  }
}
