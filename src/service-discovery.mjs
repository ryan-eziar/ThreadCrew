import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_VERSION_V1 = 'agent-chat.window.v1';
const API_VERSION_V2 = 'agent-chat.window.v2';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

function result(status, detail, extra = {}) { return { status, detail, ...extra }; }
async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}
function descriptor(value, role) {
  return value && [API_VERSION_V1, API_VERSION_V2].includes(value.apiVersion) && value.agent === role
    && ID.test(value.instanceId) && (value.apiVersion === API_VERSION_V1 ? ID.test(value.roomId) : ID.test(value.workspaceId))
    && /^[A-Za-z0-9_-]{43}$/.test(value.enrollmentToken ?? '') && validUrl(value.baseUrl);
}
async function boundedResponse(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}
function bootstrap(html) {
  const marker = 'window.__AGENT_CHAT__=';
  const start = html.indexOf(marker);
  if (start < 0 || html.indexOf(marker, start + marker.length) >= 0) return null;
  const end = html.indexOf(';</script>', start + marker.length);
  if (end < 0) return null;
  try { return JSON.parse(html.slice(start + marker.length, end)); }
  catch { return null; }
}
function snapshotIdentity(body, expected) {
  const snap = body?.result;
  return body?.ok === true && body.apiVersion === API_VERSION_V1 && snap?.instanceId === expected.instanceId
    && snap?.room?.id === expected.roomId;
}
function v2Identity(body, expected) {
  return body?.ok === true && body.apiVersion === API_VERSION_V2
    && body.result?.workspaceId === expected.workspaceId && body.result?.instanceId === expected.instanceId;
}

/** Read-only probe. Returned data never contains the browser or agent credentials. */
export async function discoverService(runtimeDir, { timeoutMs = 3000 } = {}) {
  const root = resolve(runtimeDir);
  const lockPath = join(root, 'broker-state.lock');
  let lockPresent = false;
  try {
    const lock = await lstat(lockPath);
    if (!lock.isFile() || lock.isSymbolicLink()) return result('unsafe_lock', 'Broker lock is not a regular file.');
    lockPresent = true;
  } catch (error) { if (error.code !== 'ENOENT') return result('unsafe_lock', 'Cannot inspect broker lock.'); }

  let codex, claude;
  try {
    [codex, claude] = await Promise.all(['codex', 'claude'].map(role => optionalJson(join(root, `connection-${role}.json`))));
  } catch { return result('invalid_descriptor', 'Broker descriptor cannot be parsed.', { lockPresent }); }
  if (!codex && !claude) return lockPresent
    ? result('locked', 'Broker lock exists without complete service descriptors.', { lockPresent })
    : result('startable', 'No broker lock or descriptors.', { lockPresent });
  if (!descriptor(codex, 'codex') || !descriptor(claude, 'claude') ||
      ['apiVersion', 'instanceId', 'baseUrl', codex?.apiVersion === API_VERSION_V2 ? 'workspaceId' : 'roomId'].some(key => codex[key] !== claude[key])) {
    return result('invalid_descriptor', 'Broker descriptors are incomplete or disagree.', { lockPresent });
  }
  const expected = codex;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const page = await fetch(expected.baseUrl, { signal: controller.signal, cache: 'no-store' });
      if (!page.ok || !/^text\/html\b/i.test(page.headers.get('content-type') ?? '')) return result('identity_mismatch', 'Descriptor port serves a different page.', { lockPresent });
      const info = bootstrap(await boundedResponse(page, 2 * 1024 * 1024));
      const scopeMatch = expected.apiVersion === API_VERSION_V1 ? info?.roomId === expected.roomId
        : info?.workspaceId === expected.workspaceId && info?.instanceId === expected.instanceId;
      if (!info || info.apiVersion !== expected.apiVersion || !scopeMatch || info.baseUrl !== expected.baseUrl || !/^[A-Za-z0-9_-]{43}$/.test(info.humanToken ?? '')) {
        return result('identity_mismatch', 'Page bootstrap does not match the runtime descriptors.', { lockPresent });
      }
      if (expected.apiVersion === API_VERSION_V1) {
        const path = `/api/v1/rooms/${encodeURIComponent(expected.roomId)}/snapshot`;
        const response = await fetch(new URL(path, expected.baseUrl), { signal: controller.signal, cache: 'no-store', headers: { Authorization: `Bearer ${info.humanToken}` } });
        if (!response.ok) return result('identity_mismatch', 'Authenticated broker request was rejected.', { lockPresent });
        const body = JSON.parse(await boundedResponse(response, 64 * 1024 * 1024));
        if (!snapshotIdentity(body, expected)) return result('identity_mismatch', 'Authenticated broker identity differs from the runtime descriptors.', { lockPresent });
      } else {
        for (const role of [codex, claude]) {
          const response = await fetch(new URL('/agent/v2/identity', expected.baseUrl), { signal: controller.signal, cache: 'no-store', headers: { Authorization: `Bearer ${role.enrollmentToken}` } });
          if (!response.ok) return result('identity_mismatch', 'Authenticated broker identity request was rejected.', { lockPresent });
          const body = JSON.parse(await boundedResponse(response, 4096));
          if (!v2Identity(body, expected)) return result('identity_mismatch', 'Authenticated broker identity differs from the runtime descriptors.', { lockPresent });
        }
      }
      if (!lockPresent && expected.apiVersion === API_VERSION_V2 && info.shutdown?.instanceId === expected.instanceId
          && info.shutdown.status === 'STOPPED' && ID.test(info.shutdown.shutdownId ?? '') && info.shutdown.completedAt) {
        const status = await fetch(new URL(`/api/v2/admin/shutdown-status?expectedInstanceId=${encodeURIComponent(expected.instanceId)}&shutdownId=${encodeURIComponent(info.shutdown.shutdownId)}`, expected.baseUrl),
          { signal: controller.signal, cache: 'no-store', headers: { Authorization: `Bearer ${info.humanToken}` } });
        const body = status.ok ? JSON.parse(await boundedResponse(status,4096)) : null;
        if (body?.ok === true && body.apiVersion === API_VERSION_V2 && body.result?.status === 'STOPPED'
            && body.result.instanceId === expected.instanceId && body.result.shutdownId === info.shutdown.shutdownId && body.result.completedAt) {
          return result('startable', 'Previous broker confirmed storage shutdown and released its lock.', { lockPresent });
        }
      }
      if (!lockPresent) return result('missing_lock', 'Broker responds but the runtime lock is absent.', { lockPresent });
      return result('existing', 'Authenticated broker identity verified.', { lockPresent, url: expected.baseUrl, instanceId: expected.instanceId,
        ...(expected.apiVersion === API_VERSION_V1 ? { roomId: expected.roomId } : { workspaceId: expected.workspaceId }) });
    } finally { clearTimeout(timer); }
  } catch {
    return lockPresent
      ? result('locked', 'Broker lock exists; descriptor endpoint did not pass verification.', { lockPresent })
      : result('startable', 'No broker lock; old descriptor endpoint is unavailable.', { lockPresent });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root) { process.stderr.write('Usage: node service-discovery.mjs <runtime-dir>\n'); process.exitCode = 2; }
  else {
    try { process.stdout.write(`${JSON.stringify(await discoverService(root))}\n`); }
    catch { process.stdout.write(`${JSON.stringify(result('probe_error', 'Service probe failed.'))}\n`); process.exitCode = 1; }
  }
}
