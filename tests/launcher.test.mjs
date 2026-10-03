import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    // exit can precede the last stdout chunk; close means both pipes drained.
    child.on('close', code => resolveResult({ code, stdout, stderr }));
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
  let result;
  try {
    assert.equal(launched.code, 0, launched.stderr);
    result = JSON.parse(launched.stdout);
  } catch (error) {
    // Independent creation can succeed even if the launcher result is lost.
    // These IDs come only from the new, bounded synthetic test runtime.
    for (const name of await readdir(runtime)) {
      if (!/^launcher-broker\.[a-f0-9]{32}\.result\.json$/.test(name)) continue;
      const created = JSON.parse(await readFile(join(runtime, name), 'utf8'));
      if (created.ok && created.processId) await terminateSynthetic(created.processId);
    }
    throw error;
  }
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
      signal: AbortSignal.timeout(5000),
    });
    const value = await response.json(); assert.equal(value.ok, true, JSON.stringify(value));
    return value.result;
  };
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// A disposable Windows Job reproduces the lifetime of an app-owned runner.
// Only the synthetic launcher and its descendants are assigned to this Job.
const jobHarness = String.raw`
param([string]$Fixture, [string]$Launcher, [string]$NodePath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LauncherJob {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
  public long ProcessTime, JobTime; public uint Flags;
  public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
  public UIntPtr Affinity; public uint Priority, Scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters {
  public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
 }
 [StructLayout(LayoutKind.Sequential)] struct Limits {
  public BasicLimits Basic; public IoCounters Io;
  public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
 }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
  public uint cb; public string reserved, desktop, title;
  public uint x,y,width,height,xChars,yChars,fill,flags;
  public ushort show, reservedSize; public IntPtr reservedBytes, input, output, error;
 }
 [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process, thread; public uint pid, tid; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref Limits limits, uint length);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out Info info);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static IntPtr job;
 static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(); }
 public static void Start(string command, string cwd) {
  job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
  var limits=new Limits(); limits.Basic.Flags=0x2000;
  Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))));
  var startup=new Startup(); startup.cb=(uint)Marshal.SizeOf(typeof(Startup)); Info info;
  Check(CreateProcess(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref startup,out info));
  try { Check(AssignProcessToJobObject(job,info.process)); Check(ResumeThread(info.thread)!=0xffffffff); }
  catch { TerminateProcess(info.process,1); throw; }
  finally { CloseHandle(info.thread); CloseHandle(info.process); }
 }
 public static bool Contains(uint pid, bool any) {
  var process=OpenProcess(0x1000,false,pid); Check(process!=IntPtr.Zero);
  try { bool result; Check(IsProcessInJob(process,any?IntPtr.Zero:job,out result)); return result; }
  finally { CloseHandle(process); }
 }
 public static void Release() { if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } }
}
'@
function Quote-PS([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
$outcome = Join-Path $Fixture 'launch-result.json'
$failure = Join-Path $Fixture 'launch-error.txt'
$runtime = Join-Path $Fixture 'runtime'
$command = '$ErrorActionPreference = "Stop"; try { & ' + (Quote-PS $Launcher) + ' -RuntimeDir ' + (Quote-PS $runtime) + ' -NodePath ' + (Quote-PS $NodePath) + ' -NoOpen | Set-Content -LiteralPath ' + (Quote-PS $outcome) + ' -Encoding UTF8 } catch { ($_ | Out-String) | Set-Content -LiteralPath ' + (Quote-PS $failure) + ' -Encoding UTF8; exit 1 }'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
try {
 [LauncherJob]::Start(('"' + $shell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded), $Fixture)
 $deadline=[DateTime]::UtcNow.AddSeconds(35)
 while(-not (Test-Path -LiteralPath $outcome)) { if(Test-Path -LiteralPath $failure) { throw (Get-Content -LiteralPath $failure -Raw) }; if([DateTime]::UtcNow -gt $deadline) { throw 'Synthetic launcher did not return' }; Start-Sleep -Milliseconds 100 }
 $launched=Get-Content -LiteralPath $outcome -Raw | ConvertFrom-Json
 $observed=@{processId=$launched.processId; brokerInFixtureJob=[LauncherJob]::Contains($launched.processId,$false); brokerInAnyJob=[LauncherJob]::Contains($launched.processId,$true)}
 $observed | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $Fixture 'job-observation.json') -Encoding UTF8
 while(-not (Test-Path -LiteralPath (Join-Path $Fixture 'release-job'))) { if([DateTime]::UtcNow -gt $deadline) { throw 'Synthetic job release timed out' }; Start-Sleep -Milliseconds 100 }
} finally { [LauncherJob]::Release() }
`;

test('independent broker survives closing its launcher Job and still shuts down gracefully', { timeout: 60000 }, async () => {
  const fixture = await tempRuntime(), runtime = join(fixture, 'runtime');
  const harness = join(fixture, 'job-harness.ps1');
  let pid, child, exited;
  try {
    // Reproduce the broker's native-owner discovery spawning a child. libuv
    // assigns Node to its own Job, which must not be mistaken for an inherited
    // launcher Job. Clear the preload in its child to prevent recursion.
    const preload = join(fixture, 'preload.mjs');
    await writeFile(preload, `import { spawnSync } from 'node:child_process';\nimport { isMainThread } from 'node:worker_threads';\nif (isMainThread && process.argv[2] === 'serve') spawnSync(process.execPath, ['--version'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });\n`);
    await writeFile(harness, jobHarness);
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, '-Fixture', fixture, '-Launcher', script, '-NodePath', nodePath], { windowsHide: true, env: { ...process.env, NODE_OPTIONS: `--import "${pathToFileURL(preload).href}"` } });
    let stderr = '';
    child.stdout.resume(); child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    exited = new Promise(done => child.once('exit', code => done({ code, stderr })));
    let observed;
    for (let attempt = 0; attempt < 350; attempt++) {
      try { observed = JSON.parse((await readFile(join(fixture, 'job-observation.json'), 'utf8')).replace(/^\uFEFF/, '')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (child.exitCode !== null) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(observed, `Synthetic job never reached readiness: ${stderr}`);
    pid = observed.processId;
    const first = await discoverService(runtime);
    assert.equal(first.status, 'existing');
    const api = await humanApi(first.url);
    const created = await api('/rooms', { operationId: randomUUID(), name: 'Launcher lifetime test' });
    await writeFile(join(fixture, 'release-job'), 'release');
    const closed = await exited;
    assert.equal(closed.code, 0, closed.stderr);
    await new Promise(done => setTimeout(done, 250));
    const after = await discoverService(runtime);
    assert.equal(after.status, 'existing', 'Closing the launcher Job must not terminate the broker');
    assert.equal(after.instanceId, first.instanceId);
    assert.equal(observed.brokerInFixtureJob, false);
    assert.equal(observed.brokerInAnyJob, true, 'Node may own a libuv Job after spawning its own subprocess');
    const view = await api(`/rooms/${created.room.id}/control`);
    assert.equal(view.room.id, created.room.id);
    const reused = await ps(runtime);
    assert.equal(reused.code, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).instanceId, first.instanceId);
    await api('/admin/shutdown', { expectedInstanceId: first.instanceId, shutdownId: randomUUID() });
    let stopped = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await discoverService(runtime)).status === 'startable') { stopped = true; break; }
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(stopped, true, 'Normal Quit must release the original runtime lock');
  } finally {
    if (child?.exitCode === null) { await writeFile(join(fixture, 'release-job'), 'release'); await exited; }
    if (!pid) {
      // Readiness can fail after independent creation. Never leave a synthetic
      // orphan running merely because the parent did not return its result.
      try { pid = JSON.parse(await readFile(join(runtime, 'broker-state.lock'), 'utf8')).pid; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // The process must be gone before deleting its synthetic runtime.
    await terminateSynthetic(pid);
    await removeTemp(fixture);
  }
});

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
