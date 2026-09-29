import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const unverified = reason => ({ codexReceiveMode: 'unverified', reason, verifiedAt: null });

// Read the running Desktop identity, not a newest-available or unrelated CLI version.
export async function runningCodexDesktopVersion() {
  if (process.platform !== 'win32') return null;
  const script = String.raw`$ErrorActionPreference='Stop'
@(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Select-Object -ExpandProperty ExecutablePath -Unique) | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 16384 });
  const paths = JSON.parse(stdout.trim() || '[]');
  const versions = new Set((Array.isArray(paths) ? paths : [paths]).map(value => typeof value === 'string'
    ? value.match(/^[a-z]:\\Program Files\\WindowsApps\\OpenAI\.Codex_([0-9.]+)_(?:x64|arm64)__2p2nqsd0c76g0\\app\\ChatGPT\.exe$/i)?.[1] : null).filter(Boolean));
  return versions.size === 1 ? [...versions][0] : null;
}

/** Local acceptance evidence, invalidated when the Desktop or native adapter changes.
 * This does not turn a transport "sent" result into an agent receipt. The acceptance
 * run must observe the actual same-turn receipt, single response and continuation.
 */
export async function loadNativeReceiveProof({ runtimeDir, projectDir, desktopVersion = runningCodexDesktopVersion, now = Date.now }) {
  try {
    const file = join(runtimeDir, 'native-receive-proof.json');
    if ((await stat(file)).size > 16384) return unverified('PROOF_INVALID');
    const proof = JSON.parse(await readFile(file, 'utf8'));
    const ids = ['nativeSessionId', 'activeTurnId', 'receivedTurnId', 'requestId'];
    const times = ['primaryStartedAt', 'receivedAt', 'continuedAt', 'verifiedAt'].map(key => Date.parse(proof[key]));
    if (proof.schemaVersion !== 1 || proof.agent !== 'codex' || proof.mode !== 'next_step' ||
        ids.some(key => typeof proof[key] !== 'string' || !ID.test(proof[key])) ||
        proof.activeTurnId !== proof.receivedTurnId || proof.responseCount !== 1 ||
        times.some(value => !Number.isFinite(value)) || times.some((value, index) => index && value < times[index - 1]) ||
        times[3] > now() + 5000 || !/^[0-9]+(?:\.[0-9]+){3}$/.test(proof.desktopVersion ?? '') ||
        !/^[a-f0-9]{64}$/.test(proof.transportSha256 ?? '')) return unverified('PROOF_INVALID');
    const currentVersion = await desktopVersion();
    if (!currentVersion || currentVersion !== proof.desktopVersion) return unverified('DESKTOP_VERSION_CHANGED');
    const transportHash = createHash('sha256').update(await readFile(join(projectDir, 'src', 'codex-transport.mjs'))).digest('hex');
    if (transportHash !== proof.transportSha256) return unverified('TRANSPORT_CHANGED');
    return { codexReceiveMode: 'next_step', reason: null, verifiedAt: proof.verifiedAt };
  } catch (error) { return unverified(error.code === 'ENOENT' ? 'PROOF_MISSING' : 'PROOF_UNAVAILABLE'); }
}
