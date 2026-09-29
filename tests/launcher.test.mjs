import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverService } from '../src/service-discovery.mjs';
import { canonicalRuntime } from '../src/runtime-recovery.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(project, 'scripts', 'launch-agent-chat.ps1');
const nodePath = process.execPath;
const secret = () => randomBytes(32).toString('base64url');

async function tempRuntime() {
  const base = join(project, 'work');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'launcher-test-'));
}
async function removeTemp(runtime) {
  const target = resolve(runtime);
  const workRoot = resolve(project, 'work') + sep;
  assert.ok(target.startsWith(workRoot) && target.slice(workRoot.length).startsWith('launcher-test-') && !target.slice(workRoot.length).includes(sep));
  await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
function ps(runtime, options = {}) {
  return new Promise(resolveResult => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-RuntimeDir', runtime, '-NodePath', nodePath, '-NoOpen'], { windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('exit', code => resolveResult({ code, stdout, stderr }));
  });
}
async function fakeService(runtime, { wrongPage = false } = {}) {
  const token = secret();
  const roomId = 'synthetic-room';
  const instanceId = 'instance-synthetic';
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(wrongPage ? '<html>unrelated service</html>' : `<html><head><script>window.__AGENT_CHAT__=${JSON.stringify({ apiVersion: 'agent-chat.window.v1', roomId, baseUrl, humanToken: token })};</script></head></html>`);
      return;
    }
    if (req.url === `/api/v1/rooms/${roomId}/snapshot` && req.headers.authorization === `Bearer ${token}`) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, apiVersion: 'agent-chat.window.v1', result: { instanceId, room: { id: roomId } } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(runtime, 'broker-state.lock'), JSON.stringify({ version: 1, roomId, pid: process.pid, ownerId: 'synthetic' }));
  await Promise.all(['codex', 'claude'].map(agent => writeFile(join(runtime, `connection-${agent}.json`), JSON.stringify({ apiVersion: 'agent-chat.window.v1', instanceId, roomId, baseUrl, agent, enrollmentToken: secret() }))));
  return { close: () => new Promise(done => server.close(done)), baseUrl };
}
async function fakeV2Service(runtime, { wrongWorkspace = false } = {}) {
  const workspaceId = 'workspace-synthetic';
  const instanceId = 'instance-synthetic-v2';
  const humanToken = secret();
  const enrollments = { codex: secret(), claude: secret() };
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><head><script>window.__AGENT_CHAT__=${JSON.stringify({ apiVersion: 'agent-chat.window.v2', workspaceId, instanceId, baseUrl, humanToken })};</script></head></html>`);
      return;
    }
    if (req.url === '/agent/v2/identity' && Object.values(enrollments).some(token => req.headers.authorization === `Bearer ${token}`)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, apiVersion: 'agent-chat.window.v2', result: { workspaceId: wrongWorkspace ? 'other-workspace' : workspaceId, instanceId } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(runtime, 'broker-state.lock'), JSON.stringify({ version: 1, pid: process.pid, ownerId: 'synthetic-v2' }));
  await Promise.all(Object.entries(enrollments).map(([agent, enrollmentToken]) => writeFile(join(runtime, `connection-${agent}.json`), JSON.stringify({ apiVersion: 'agent-chat.window.v2', workspaceId, instanceId, baseUrl, agent, enrollmentToken }))));
  return { close: () => new Promise(done => server.close(done)), baseUrl };
}

test('missing SQLite is rejected before any runtime directory is created', async () => {
  const fixture = await tempRuntime();
  const runtime = join(fixture, 'not-created');
  try {
    const result = await ps(runtime, { env: { ...process.env, NODE_OPTIONS: '--no-experimental-sqlite' } });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SQLite support is unavailable/);
    await assert.rejects(readdir(runtime), { code: 'ENOENT' });
  } finally { await removeTemp(fixture); }
});

test('reuses only descriptor and authenticated broker identity', async () => {
  const runtime = await tempRuntime();
  let service;
  try {
    service = await fakeService(runtime);
    assert.equal((await discoverService(runtime)).status, 'existing');
    const result = await ps(runtime);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'reused');
    assert.equal(JSON.parse(result.stdout).url, service.baseUrl);
    assert.equal((await readFile(join(runtime, 'broker-state.lock'), 'utf8')).includes('synthetic'), true);
  } finally { await service?.close(); await removeTemp(runtime); }
});

test('occupied descriptor port and crash lock stop without changing runtime', async () => {
  const runtime = await tempRuntime();
  let service;
  try {
    service = await fakeService(runtime, { wrongPage: true });
    const lockBefore = await readFile(join(runtime, 'broker-state.lock'), 'utf8');
    assert.equal((await discoverService(runtime)).status, 'identity_mismatch');
    const mismatch = await ps(runtime);
    assert.notEqual(mismatch.code, 0);
    assert.match(mismatch.stderr, /unrelated or unverified/);
    assert.equal(await readFile(join(runtime, 'broker-state.lock'), 'utf8'), lockBefore);
    await service.close(); service = null;
    const crash = await ps(runtime);
    assert.notEqual(crash.code, 0);
    assert.match(crash.stderr, /Runtime is locked/);
    assert.equal(await readFile(join(runtime, 'broker-state.lock'), 'utf8'), lockBefore);
  } finally { await service?.close(); await removeTemp(runtime); }
});

test('v2 reuses matching workspace and rejects authenticated wrong workspace', async () => {
  const runtime = await tempRuntime();
  let service;
  try {
    service = await fakeV2Service(runtime);
    const valid = await discoverService(runtime);
    assert.equal(valid.status, 'existing');
    assert.equal(valid.workspaceId, 'workspace-synthetic');
    const reused = await ps(runtime);
    assert.equal(reused.code, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).status, 'reused');
    await service.close();
    service = await fakeV2Service(runtime, { wrongWorkspace: true });
    assert.equal((await discoverService(runtime)).status, 'identity_mismatch');
    const rejected = await ps(runtime);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /unrelated or unverified/);
  } finally { await service?.close(); await removeTemp(runtime); }
});

test('simultaneous launchers create one synthetic broker writer', { timeout: 60000 }, async () => {
  const runtime = await tempRuntime();
  let pid;
  try {
    const [first, second] = await Promise.all([ps(runtime), ps(runtime)]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    const outcomes = [JSON.parse(first.stdout), JSON.parse(second.stdout)];
    assert.deepEqual(outcomes.map(item => item.status).sort(), ['reused', 'started']);
    assert.equal(outcomes[0].instanceId, outcomes[1].instanceId);
    assert.equal(outcomes[0].url, outcomes[1].url);
    pid = outcomes.find(item => item.status === 'started').processId;
    assert.equal((await discoverService(runtime)).status, 'existing');
  } finally {
    if (pid) {
      try { process.kill(pid); } catch {}
      let alive = true;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') { alive = false; break; } }
        await new Promise(done => setTimeout(done, 100));
      }
      assert.equal(alive, false, `Synthetic broker ${pid} remained active; runtime retained at ${runtime}`);
    }
    await removeTemp(runtime);
  }
});

async function terminateSynthetic(pid) {
  if (!pid) return;
  // Each PID comes only from ps(tempRuntime()). Never target the formal runtime.
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(done => setTimeout(done, 100));
  }
  assert.fail('Synthetic broker did not exit');
}
async function startSynthetic(runtime) {
  const launched = await ps(runtime);
  assert.equal(launched.code, 0, launched.stderr);
  const result = JSON.parse(launched.stdout);
  assert.equal(result.status, 'started');
  return result;
}
async function humanApi(url) {
  const html = await (await fetch(url)).text();
  const config = JSON.parse(html.match(/window\.__AGENT_CHAT__=(\{.*?\});<\/script>/)[1]);
  return async (route, body) => {
    const response = await fetch(url + '/api/v2' + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.humanToken}`, ...(body ? { Origin: url, 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json(); assert.equal(value.ok, true, JSON.stringify(value));
    return value.result;
  };
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('forced exit with committed WAL recovers once under concurrent launchers, preserving history and evidence', { timeout: 60000 }, async () => {
  const runtime = await tempRuntime();
  let pid;
  try {
    const first = await startSynthetic(runtime); pid = first.processId;
    const api = await humanApi(first.url);
    const created = await api('/rooms', { operationId: randomUUID(), name: 'Recovery test' });
    const text = 'Committed message survives a forced process exit.';
    const sent = await api(`/rooms/${created.room.id}/messages`, {
      operationId: randomUUID(), expectedGate: created.gate, recipients: ['claude'], text, attachmentIds: [],
    });
    const workspace = (await discoverService(runtime)).workspaceId;
    await terminateSynthetic(pid); pid = null;
    const payload = { version: 1, roomId: 'synthetic-room', seq: 1, previousChecksum: null, state: { archived: true } };
    const journal = JSON.stringify({ ...payload, checksum: digest(JSON.stringify(payload)) }) + '\n';
    await writeFile(join(runtime, 'broker-state.jsonl'), journal);
    const lock = await readFile(join(runtime, 'broker-state.lock'));
    const wal = await readFile(join(runtime, 'v2-state.sqlite-wal'));
    assert.ok(wal.length > 32, 'Committed data must have a WAL to recover');
    const results = await Promise.all([ps(runtime), ps(runtime)]);
    for (const result of results) assert.equal(result.code, 0, result.stderr + result.stdout);
    const outcomes = results.map(result => JSON.parse(result.stdout));
    assert.deepEqual(outcomes.map(result => result.status).sort(), ['reused', 'started']);
    const restarted = outcomes.find(result => result.status === 'started'); pid = restarted.processId;
    assert.notEqual(restarted.instanceId, first.instanceId);
    assert.equal(outcomes[0].instanceId, outcomes[1].instanceId);
    assert.equal((await discoverService(runtime)).workspaceId, workspace);
    assert.equal((await readdir(join(runtime, 'recovery-evidence'))).length, 1);
    const evidence = restarted.recoveryEvidence;
    assert.ok(evidence.startsWith(await canonicalRuntime(runtime)));
    assert.deepEqual(await readFile(join(evidence, 'previous-broker-state.lock')), lock);
    assert.deepEqual(await readFile(join(evidence, 'raw', 'v2-state.sqlite-wal')), wal);
    assert.equal(await readFile(join(evidence, 'raw', 'broker-state.jsonl'), 'utf8'), journal);
    assert.equal(JSON.parse(await readFile(join(evidence, 'verified.json'), 'utf8')).journal, 'valid');
    const manifest = JSON.parse(await readFile(join(evidence, 'manifest.json'), 'utf8'));
    for (const file of manifest.files) assert.equal(digest(await readFile(join(evidence, 'raw', file.path))), file.sha256);
    const current = await humanApi(restarted.url);
    const view = await current(`/rooms/${created.room.id}/view`);
    const message = view.page.items.find(item => item.message?.id === sent.messageId)?.message;
    assert.ok(message, 'The same committed message ID must survive');
    assert.equal(JSON.stringify(message).includes(text), true);
    const reused = await ps(runtime);
    assert.equal(reused.code, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).status, 'reused');
    assert.equal((await readdir(join(runtime, 'recovery-evidence'))).length, 1);
  } finally { await terminateSynthetic(pid); await removeTemp(runtime); }
});

test('corrupt database blocks automatic recovery and retains original lock, database and WAL', { timeout: 60000 }, async () => {
  const runtime = await tempRuntime(); let pid;
  try {
    const first = await startSynthetic(runtime); pid = first.processId;
    await terminateSynthetic(pid); pid = null;
    await writeFile(join(runtime, 'v2-state.sqlite'), 'deliberately invalid SQLite file');
    // A valid WAL can repair the main header, so invalidate both to model an
    // unrecoverable dataset rather than a normal SQLite crash-recovery case.
    await writeFile(join(runtime, 'v2-state.sqlite-wal'), 'deliberately invalid WAL');
    const names = ['broker-state.lock', 'v2-state.sqlite', 'v2-state.sqlite-wal', 'connection-codex.json', 'connection-claude.json'];
    const before = await Promise.all(names.map(name => readFile(join(runtime, name))));
    const result = await ps(runtime);
    if (result.code === 0) pid = JSON.parse(result.stdout).processId;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Automatic recovery stopped/);
    for (const [index, name] of names.entries()) assert.deepEqual(await readFile(join(runtime, name)), before[index]);
    assert.equal((await discoverService(runtime)).status, 'locked');
    const folders = await readdir(join(runtime, 'recovery-evidence'));
    const evidence = join(runtime, 'recovery-evidence', folders[0]);
    assert.deepEqual(await readFile(join(evidence, 'raw', 'v2-state.sqlite')), before[1]);
  } finally { await terminateSynthetic(pid); await removeTemp(runtime); }
});

test('damaged legacy journal blocks recovery even when the v2 database is sound', { timeout: 60000 }, async () => {
  const runtime = await tempRuntime(); let pid;
  try {
    const first = await startSynthetic(runtime); pid = first.processId;
    await terminateSynthetic(pid); pid = null;
    const badJournal = JSON.stringify({ roomId: 'synthetic-room', state: {} }) + '\n';
    await writeFile(join(runtime, 'broker-state.jsonl'), badJournal);
    const lock = await readFile(join(runtime, 'broker-state.lock'));
    const result = await ps(runtime);
    if (result.code === 0) pid = JSON.parse(result.stdout).processId;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /JOURNAL_CORRUPT/);
    assert.deepEqual(await readFile(join(runtime, 'broker-state.lock')), lock);
    assert.equal(await readFile(join(runtime, 'broker-state.jsonl'), 'utf8'), badJournal);
  } finally { await terminateSynthetic(pid); await removeTemp(runtime); }
});
