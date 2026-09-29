import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadNativeReceiveProof } from '../src/native-receive-proof.mjs';

const projectDir = resolve(import.meta.dirname, '..');
const root = join(projectDir, 'work', 'native-receive-proof-tests');
async function fixture() {
  await mkdir(root, { recursive: true });
  const runtimeDir = await mkdtemp(join(root, 'case-'));
  const options = { runtimeDir, projectDir, desktopVersion: async () => '26.924.2738.0', now: () => Date.parse('2026-09-28T12:00:00Z') };
  const proof = { schemaVersion: 1, agent: 'codex', mode: 'next_step', desktopVersion: '26.924.2738.0',
    transportSha256: createHash('sha256').update(await readFile(join(projectDir, 'src', 'codex-transport.mjs'))).digest('hex'),
    nativeSessionId: 'synthetic-session', activeTurnId: 'synthetic-turn', receivedTurnId: 'synthetic-turn', requestId: 'synthetic-request',
    primaryStartedAt: '2026-09-28T11:00:00Z', receivedAt: '2026-09-28T11:01:00Z', continuedAt: '2026-09-28T11:02:00Z', verifiedAt: '2026-09-28T11:03:00Z', responseCount: 1 };
  const save = value => writeFile(join(runtimeDir, 'native-receive-proof.json'), JSON.stringify(value));
  return { options, proof, save };
}

test('missing proof never enables native work push', async () => {
  const f = await fixture();
  assert.equal((await loadNativeReceiveProof(f.options)).codexReceiveMode, 'unverified');
});
test('completed same-turn acceptance permits next_step only for the verified Desktop and adapter', async () => {
  const f = await fixture(); await f.save(f.proof);
  assert.equal((await loadNativeReceiveProof(f.options)).codexReceiveMode, 'next_step');
  assert.equal((await loadNativeReceiveProof({ ...f.options, desktopVersion: async () => '26.925.1.0' })).reason, 'DESKTOP_VERSION_CHANGED');
  await f.save({ ...f.proof, transportSha256: '0'.repeat(64) });
  assert.equal((await loadNativeReceiveProof(f.options)).reason, 'TRANSPORT_CHANGED');
});
test('queued new-turn or duplicate responses are not accepted as a same-turn proof', async () => {
  const f = await fixture();
  for (const changes of [{ receivedTurnId: 'new-turn' }, { responseCount: 2 }, { continuedAt: '2026-09-28T10:59:00Z' }, { mode: 'native_push' }]) {
    await f.save({ ...f.proof, ...changes });
    assert.equal((await loadNativeReceiveProof(f.options)).codexReceiveMode, 'unverified');
  }
});
test('identity discovery failure leaves explicit checkpoints available without enabling native push', async () => {
  const f = await fixture(); await f.save(f.proof);
  assert.equal((await loadNativeReceiveProof({ ...f.options, desktopVersion: async () => { throw new Error('unavailable'); } })).codexReceiveMode, 'unverified');
});
