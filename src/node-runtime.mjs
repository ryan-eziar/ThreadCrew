import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUPPORTED_NODE_RANGE = '>=22.16.0 <23 || >=24.0.0 <25';
export const NODE_REQUIREMENT = 'Node.js 22.16+ (22.x) or 24.x is required. Install the latest Node.js 24 LTS and reopen the terminal.';

export function isSupportedNode(version = process.versions.node) {
  if (typeof version !== 'string') return false;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  const [major, minor] = match.slice(1).map(Number);
  return major === 24 || (major === 22 && minor >= 16);
}

// Run before the launcher opens or recovers any user runtime. The in-memory
// query also catches installations where the built-in SQLite module is disabled.
export async function checkNodeRuntime({ version = process.versions.node, loadSqlite = () => import('node:sqlite') } = {}) {
  const result = { version, supportedRange: SUPPORTED_NODE_RANGE };
  if (!isSupportedNode(version)) return { ...result, ok: false, code: 'NODE_VERSION_UNSUPPORTED', message: NODE_REQUIREMENT };
  let database;
  try {
    const { DatabaseSync, backup } = await loadSqlite();
    if (typeof DatabaseSync !== 'function' || typeof backup !== 'function') throw new Error('SQLite APIs unavailable');
    database = new DatabaseSync(':memory:');
    if (database.prepare('SELECT 1 AS ready').get().ready !== 1) throw new Error('SQLite query failed');
    return { ...result, ok: true };
  } catch {
    return { ...result, ok: false, code: 'NODE_SQLITE_UNAVAILABLE', message: `The required built-in SQLite support is unavailable. ${NODE_REQUIREMENT} Ensure Node options do not disable SQLite.` };
  } finally { database?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkNodeRuntime();
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
