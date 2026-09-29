import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTextAttachment, openStore, readTextAttachment } from '../src/broker-storage.mjs';

const root = resolve(import.meta.dirname, '../work/storage-tests');
const code = (expected) => (error) => error.code === expected;
const sha = (text) => createHash('sha256').update(text).digest('hex');

async function fixture(t) {
  await mkdir(root, { recursive: true });
  const runtimeDir = await mkdtemp(join(root, 'case-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close().catch(() => {});
    const part = relative(root, resolve(runtimeDir));
    assert.ok(part && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`), 'only remove this generated test directory');
    await rm(runtimeDir, { recursive: true, force: true });
  });
  return {
    runtimeDir,
    journalPath: join(runtimeDir, 'broker-state.jsonl'),
    lockPath: join(runtimeDir, 'broker-state.lock'),
    async reopen(roomId = 'synthetic-room') {
      const store = await openStore({ runtimeDir, roomId });
      stores.push(store);
      return store;
    },
  };
}

test('whole snapshots are durable, room-bound and detached from caller mutations', async (t) => {
  const f = await fixture(t);
  const store = await f.reopen();
  assert.equal(store.state, null);
  const input = { gate: { version: 1 }, messages: ['合成消息 🧪'], nullable: null };
  await store.commit(input);
  input.messages.push('must not leak');
  const returned = store.state;
  returned.gate.version = 99;
  assert.deepEqual(store.state, { gate: { version: 1 }, messages: ['合成消息 🧪'], nullable: null });
  await store.commit({ gate: { version: 2 }, messages: ['合成消息 🧪', 'STOPPED'] });
  const records = (await readFile(f.journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((row) => row.seq), [1, 2]);
  assert.equal(records[1].previousChecksum, records[0].checksum);
  await store.close();
  await assert.rejects(f.reopen('different-room'), code('JOURNAL_CORRUPT'));
  const restored = await f.reopen();
  assert.deepEqual(restored.state, { gate: { version: 2 }, messages: ['合成消息 🧪', 'STOPPED'] });
});

test('exclusive lifetime lock rejects another writer; close is idempotent and releases it', async (t) => {
  const f = await fixture(t);
  const store = await f.reopen();
  const originalLock = await readFile(f.lockPath, 'utf8');
  await assert.rejects(f.reopen(), code('JOURNAL_LOCKED'));
  assert.equal(await readFile(f.lockPath, 'utf8'), originalLock);
  await Promise.all([store.close(), store.close()]);
  await assert.rejects(store.commit({ ignored: true }), code('CLOSED'));
  await f.reopen();
});

test('a verified exited child leaves a lock; opening never automatically removes it', async (t) => {
  const f = await fixture(t);
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/broker-storage.mjs')).href;
  const script = `import { openStore } from ${JSON.stringify(moduleUrl)}; const store = await openStore(${JSON.stringify({ runtimeDir: f.runtimeDir, roomId: 'synthetic-room' })}); await store.commit({ synthetic: 'persisted before exit' }); process.exit(0);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const exit = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  assert.equal(exit, 0, stderr);
  const owner = JSON.parse(await readFile(f.lockPath, 'utf8'));
  assert.equal(owner.pid, child.pid);
  await assert.rejects(f.reopen(), code('JOURNAL_LOCKED'));
  assert.equal(JSON.parse(await readFile(f.lockPath, 'utf8')).ownerId, owner.ownerId);
  // This test observed this exact process exit, so removal is deliberate recovery.
  await unlink(f.lockPath);
  const recovered = await f.reopen();
  assert.deepEqual(recovered.state, { synthetic: 'persisted before exit' });
});

test('truncated, altered, out-of-sequence and malformed records fail closed without repair', async (t) => {
  const cases = [
    ['partial record', (text) => text.slice(0, -1)],
    ['modified payload', (text) => text.replace('original-value', 'tampered-value')],
    ['wrong sequence', (text) => text.replace('"seq":1', '"seq":7')],
    ['wrong previous checksum', (text) => text.replace('"previousChecksum":null', `"previousChecksum":"${'a'.repeat(64)}"`)],
    ['extra field', (text) => text.replace('"version":1', '"version":1,"ignored":true')],
    ['extra broken JSON', (text) => `${text}{broken}\n`],
  ];
  for (const [name, corrupt] of cases) {
    await t.test(name, async (sub) => {
      const f = await fixture(sub);
      const store = await f.reopen();
      await store.commit({ text: 'original-value' });
      await store.close();
      const changed = corrupt(await readFile(f.journalPath, 'utf8'));
      await writeFile(f.journalPath, changed);
      await assert.rejects(f.reopen(), code('JOURNAL_CORRUPT'));
      assert.equal(await readFile(f.journalPath, 'utf8'), changed);
    });
  }
});

test('invalid JSON state cannot silently lose fields and does not poison a valid owner', async (t) => {
  const f = await fixture(t);
  const store = await f.reopen();
  const cycle = {}; cycle.self = cycle;
  let accessorCalled = false;
  const accessorArray = [1];
  Object.defineProperty(accessorArray, 0, { get() { accessorCalled = true; return 'not ordinary JSON'; } });
  for (const state of [null, [], { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, { value: new Date() }, { value: [, 1] }, { value: accessorArray }, cycle]) {
    await assert.rejects(store.commit(state), code('INVALID_INPUT'));
  }
  assert.equal(accessorCalled, false);
  assert.equal(await readFile(f.journalPath, 'utf8'), '');
  await store.commit({ valid: true });
  assert.deepEqual(store.state, { valid: true });
});

test('overlapping commits are rejected and close waits for the active write', async (t) => {
  const f = await fixture(t);
  const store = await f.reopen();
  const pending = store.commit({ synthetic: 'one transaction' });
  await assert.rejects(store.commit({ synthetic: 'must not race' }), code('JOURNAL_BUSY'));
  await Promise.all([pending, store.close()]);
  const restored = await f.reopen();
  assert.deepEqual(restored.state, { synthetic: 'one transaction' });
});

test('fsync failure leaves last acknowledged state intact and disables subsequent writes', async (t) => {
  const f = await fixture(t);
  const store = await f.reopen();
  await store.commit({ acknowledged: 1 });
  const probe = await open(join(f.runtimeDir, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const replacement = t.mock.method(prototype, 'sync', async () => { throw new Error('SYNTHETIC_SECRET_PATH_MUST_NOT_ESCAPE'); });
  await assert.rejects(store.commit({ acknowledgementUnknown: 2 }), (error) => {
    assert.equal(error.code, 'JOURNAL_UNSAFE');
    assert.doesNotMatch(error.message, /SYNTHETIC_SECRET|storage-tests|case-/);
    return true;
  });
  assert.deepEqual(store.state, { acknowledged: 1 });
  await assert.rejects(store.commit({ forbidden: 3 }), code('JOURNAL_UNSAFE'));
  replacement.mock.restore();
  await store.close();
  const restored = await f.reopen();
  // Write reached disk before sync threw: recovery can expose its unknown result.
  assert.deepEqual(restored.state, { acknowledgementUnknown: 2 });
});

test('attachment pages preserve Unicode codepoints, BOM and full content without modifying files', async (t) => {
  const f = await fixture(t);
  const text = '\uFEFF' + 'A'.repeat(8190) + '🧪' + '中文𐐷\n'.repeat(3000);
  const metadata = await createTextAttachment(f.runtimeDir, text, 'synthetic-unicode.txt');
  assert.equal(metadata.bytes, Buffer.byteLength(text));
  assert.equal(metadata.sha256, sha(text));
  assert.equal(metadata.mediaType, 'text/plain');
  assert.equal(metadata.previewAvailable, true);
  const path = join(f.runtimeDir, metadata.relativePath);
  const before = await lstat(path, { bigint: true });
  const pages = [];
  let cursor;
  do {
    const page = await readTextAttachment(f.runtimeDir, metadata, cursor);
    assert.equal(page.attachmentId, metadata.id);
    assert.equal(page.sha256, metadata.sha256);
    assert.ok([...page.text].length <= 8192);
    pages.push(page.text);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal([...pages[0]].length, 8192);
  assert.ok(pages[0].endsWith('🧪'));
  assert.equal(pages.join(''), text);
  const after = await lstat(path, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
});

test('empty text works, creation never overwrites another attachment, invalid Unicode is rejected', async (t) => {
  const f = await fixture(t);
  const first = await createTextAttachment(f.runtimeDir, '');
  const second = await createTextAttachment(f.runtimeDir, '');
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await readTextAttachment(f.runtimeDir, first), { attachmentId: first.id, sha256: first.sha256, text: '', nextCursor: null });
  await assert.rejects(createTextAttachment(f.runtimeDir, '\ud800'), code('INVALID_INPUT'));
  await assert.rejects(createTextAttachment(f.runtimeDir, 'safe', '../secret.txt'), code('INVALID_INPUT'));
});

test('attachment edits and replacements are detected, including same-byte-length tampering', async (t) => {
  const f = await fixture(t);
  const metadata = await createTextAttachment(f.runtimeDir, 'A'.repeat(10000));
  const first = await readTextAttachment(f.runtimeDir, metadata);
  assert.ok(first.nextCursor);
  await writeFile(join(f.runtimeDir, metadata.relativePath), 'B'.repeat(10000));
  await assert.rejects(readTextAttachment(f.runtimeDir, metadata, first.nextCursor), code('ATTACHMENT_CHANGED'));
});

test('opaque cursors cannot switch attachments, file hashes or page offsets', async (t) => {
  const f = await fixture(t);
  const first = await createTextAttachment(f.runtimeDir, 'C'.repeat(9000));
  const second = await createTextAttachment(f.runtimeDir, 'C'.repeat(9000));
  const page = await readTextAttachment(f.runtimeDir, first);
  await assert.rejects(readTextAttachment(f.runtimeDir, second, page.nextCursor), code('INVALID_CURSOR'));
  await assert.rejects(readTextAttachment(f.runtimeDir, first, '!not-a-cursor'), code('INVALID_CURSOR'));
  const altered = Buffer.from(JSON.stringify({ v: 1, id: first.id, sha256: first.sha256, offset: 8192 * 9 })).toString('base64url');
  await assert.rejects(readTextAttachment(f.runtimeDir, first, altered), code('INVALID_CURSOR'));
  const wrongHash = Buffer.from(JSON.stringify({ v: 1, id: first.id, sha256: '0'.repeat(64), offset: 8192 })).toString('base64url');
  await assert.rejects(readTextAttachment(f.runtimeDir, first, wrongHash), code('INVALID_CURSOR'));
});

test('metadata paths cannot traverse outside attachments and missing files have sanitized errors', async (t) => {
  const f = await fixture(t);
  const metadata = await createTextAttachment(f.runtimeDir, 'private synthetic content');
  for (const relativePath of ['../outside.txt', 'attachments/../../outside.txt', '\\\\server\\share\\secret.txt', 'C:\\outside.txt']) {
    await assert.rejects(readTextAttachment(f.runtimeDir, { ...metadata, relativePath }), code('ATTACHMENT_UNSAFE'));
  }
  await unlink(join(f.runtimeDir, metadata.relativePath));
  await assert.rejects(readTextAttachment(f.runtimeDir, metadata), (error) => {
    assert.equal(error.code, 'ATTACHMENT_NOT_FOUND');
    assert.doesNotMatch(error.message, /case-|private synthetic|ENOENT/);
    return true;
  });
});

test('an attachment-directory junction cannot redirect reads or new writes', async (t) => {
  const f = await fixture(t);
  const metadata = await createTextAttachment(f.runtimeDir, 'allowed synthetic file');
  const originalDirectory = join(f.runtimeDir, 'attachments');
  const outside = join(f.runtimeDir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, `${metadata.id}.txt`), 'allowed synthetic file');
  await rename(originalDirectory, join(f.runtimeDir, 'original-attachments'));
  try { await symlink(outside, originalDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Host cannot create a directory link for this test.'); return; } throw error; }
  await assert.rejects(readTextAttachment(f.runtimeDir, metadata), code('ATTACHMENT_UNSAFE'));
  await assert.rejects(createTextAttachment(f.runtimeDir, 'must not escape'), code('ATTACHMENT_UNSAFE'));
});

test('hard-linked attachment files are rejected even with a matching digest', async (t) => {
  const f = await fixture(t);
  const metadata = await createTextAttachment(f.runtimeDir, 'same synthetic bytes');
  await link(join(f.runtimeDir, metadata.relativePath), join(f.runtimeDir, 'external-alias.txt'));
  await assert.rejects(readTextAttachment(f.runtimeDir, metadata), code('ATTACHMENT_UNSAFE'));
});

test('journal aliases are refused rather than treated as a second store', async (t) => {
  const f = await fixture(t);
  const store = await f.reopen();
  await store.commit({ synthetic: true });
  await store.close();
  await link(f.journalPath, join(f.runtimeDir, 'aliased-journal.jsonl'));
  await assert.rejects(f.reopen(), code('JOURNAL_UNSAFE'));
});
