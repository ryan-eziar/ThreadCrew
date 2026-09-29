import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DeliveryController } from '../src/delivery-controller.mjs';

const codex = { agent: 'codex', kind: 'native-desktop', id: 'synthetic-codex-session' };
const claude = { agent: 'claude', kind: 'native-desktop', id: 'synthetic-claude-session' };
const targets = [codex, claude];
const message = (id, extras = {}) => ({ id, target: codex, text: `Synthetic ${id}`, ...extras });
const errorCode = (code) => (error) => error.code === code;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function fixture(t, transport = { send: async () => ({ status: 'sent' }) }, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-delivery-'));
  const journalPath = join(directory, 'journal.jsonl');
  const controllers = [];
  const { guardTransport = true, ...controllerOptions } = options;
  const adapter = guardTransport ? {
    send(input, controls) {
      controls.beforeSend();
      return transport.send(input, controls);
    },
  } : transport;
  const reopen = async (extra = {}) => {
    const controller = await DeliveryController.open({ journalPath, targets, transport: adapter, ...controllerOptions, ...extra });
    controllers.push(controller);
    return controller;
  };
  t.after(async () => {
    for (const controller of controllers) await controller.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { controller: await reopen(), reopen, journalPath };
}

test('exact native binding is persisted and cannot silently change kind or session', async (t) => {
  const { controller, reopen } = await fixture(t);
  await assert.rejects(controller.enqueue(message('wrong-id', { target: { ...codex, id: 'other-session' } })), errorCode('TARGET_MISMATCH'));
  await assert.rejects(controller.enqueue(message('wrong-kind', { target: { ...codex, kind: 'cli' } })), errorCode('INVALID_TARGET'));
  await assert.rejects(controller.enqueue(message('wrong-agent', { target: { ...codex, agent: 'claude' } })), errorCode('TARGET_MISMATCH'));
  await controller.close();
  await assert.rejects(reopen({ targets: [{ ...codex, id: 'other-session' }, claude] }), errorCode('TARGET_MISMATCH'));
  await assert.rejects(reopen({ targets: [{ ...codex, kind: 'api' }, claude] }), errorCode('INVALID_TARGET'));
  const restored = await reopen({ targets: [claude, codex] });
  assert.equal(restored.snapshot().targets.length, 2);
});

test('identical concurrent enqueue and dispatch use one durable attempt, including after reopening', async (t) => {
  const sent = [];
  const { controller, reopen, journalPath } = await fixture(t, {
    send: async (input) => {
      const log = await readFile(journalPath, 'utf8');
      assert.match(log, /"type":"dispatch_started","id":"m1"/);
      sent.push(input);
      return { status: 'sent' };
    },
  });
  await Promise.all(Array.from({ length: 8 }, () => controller.enqueue(message('m1'))));
  const results = await Promise.all(Array.from({ length: 8 }, () => controller.dispatch('m1')));
  assert.equal(sent.length, 1);
  assert.ok(results.every((result) => result.status === 'awaiting_reply' && result.dispatchAttempts === 1));
  await controller.close();
  const restored = await reopen();
  await restored.enqueue(message('m1'));
  await restored.dispatch('m1');
  assert.equal(sent.length, 1);
  const events = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((event) => event.type === 'message_enqueued').length, 1);
  assert.equal(events.filter((event) => event.type === 'dispatch_started').length, 1);
});

test('an ID cannot be reused for changed text, routing, origin or reply content', async (t) => {
  const { controller } = await fixture(t);
  await controller.enqueue(message('m1'));
  await assert.rejects(controller.enqueue(message('m1', { text: 'Changed' })), errorCode('ID_CONFLICT'));
  await assert.rejects(controller.enqueue(message('m1', { target: claude })), errorCode('ID_CONFLICT'));
  await assert.rejects(controller.enqueue(message('m1', { origin: 'claude', exchangeId: 'x1', round: 1 })), errorCode('ID_CONFLICT'));
  await controller.dispatch('m1');
  const reply = { id: 'r1', inReplyTo: 'm1', target: codex, text: 'Synthetic reply' };
  await controller.recordReply(reply);
  await controller.recordReply(reply);
  await assert.rejects(controller.recordReply({ ...reply, text: 'Changed' }), errorCode('ID_CONFLICT'));
  await assert.rejects(controller.enqueue(message('r1')), errorCode('ID_CONFLICT'));
  assert.equal(controller.snapshot().replies.length, 1);
});

test('ambiguous exceptions, invalid results and timeouts never automatically retry', async (t) => {
  const calls = [];
  const { controller, reopen, journalPath } = await fixture(t, {
    send: async ({ id }) => {
      calls.push(id);
      if (id === 'throws') throw new Error('secret-do-not-log');
      if (id === 'timeout') return new Promise(() => {});
      return { unexpected: 'value' };
    },
  }, { sendTimeoutMs: 15 });
  for (const id of ['throws', 'invalid', 'timeout']) {
    await controller.enqueue(message(id));
    assert.equal((await controller.dispatch(id)).status, 'uncertain');
    await controller.dispatch(id);
  }
  await controller.close();
  const restored = await reopen();
  for (const id of ['throws', 'invalid', 'timeout']) await restored.dispatch(id);
  assert.deepEqual(calls, ['throws', 'invalid', 'timeout']);
  assert.doesNotMatch(await readFile(journalPath, 'utf8'), /secret-do-not-log/);
});

test('even definite non-delivery uses the single reserved attempt', async (t) => {
  let calls = 0;
  const { controller } = await fixture(t, { send: async () => { calls++; return { status: 'failed' }; } });
  await controller.enqueue(message('m1'));
  assert.equal((await controller.dispatch('m1')).status, 'failed');
  await controller.dispatch('m1');
  assert.equal(calls, 1);
});

test('replies require the exact attempted target and recording a reply cannot dispatch', async (t) => {
  let calls = 0;
  const { controller } = await fixture(t, { send: async () => { calls++; return { status: 'sent' }; } });
  await controller.enqueue(message('m1'));
  const reply = { id: 'r1', inReplyTo: 'm1', target: codex, text: 'Synthetic return' };
  await assert.rejects(controller.recordReply(reply), errorCode('UNSOLICITED_REPLY'));
  await controller.dispatch('m1');
  await assert.rejects(controller.recordReply({ ...reply, target: claude }), errorCode('TARGET_MISMATCH'));
  await controller.recordReply({ ...reply, channel: 'commentary' });
  assert.equal(controller.snapshot().messages[0].status, 'awaiting_reply');
  await controller.recordReply({ ...reply, id: 'r2' });
  assert.equal(controller.snapshot().messages[0].status, 'replied');
  assert.equal(calls, 1);
});

test('only explicitly started exchanges permit agent messages and each round has two bounded slots', async (t) => {
  let calls = 0;
  const { controller, reopen } = await fixture(t, { send: async () => { calls++; return { status: 'sent' }; } });
  const forwarded = message('a1', { origin: 'claude', exchangeId: 'exchange', round: 1 });
  await assert.rejects(controller.enqueue(forwarded), errorCode('EXCHANGE_REQUIRED'));
  await assert.rejects(controller.startExchange({ id: 'exchange', maxRounds: 4 }), errorCode('ROUND_LIMIT'));
  await controller.startExchange({ id: 'exchange', maxRounds: 3 });
  await controller.startExchange({ id: 'exchange', maxRounds: 3 });
  await assert.rejects(controller.startExchange({ id: 'exchange', maxRounds: 2 }), errorCode('ID_CONFLICT'));
  await assert.rejects(controller.enqueue({ ...forwarded, origin: 'codex' }), errorCode('SELF_SEND'));
  for (let round = 1; round <= 3; round++) {
    for (const [destination, origin] of [[codex, 'claude'], [claude, 'codex']]) {
      const input = message(`round-${round}-${destination.agent}`, { target: destination, origin, exchangeId: 'exchange', round });
      await controller.enqueue(input);
      await controller.dispatch(input.id);
    }
  }
  await assert.rejects(controller.enqueue(forwarded), errorCode('ROUND_SLOT_USED'));
  await assert.rejects(controller.enqueue({ ...forwarded, round: 4 }), errorCode('ROUND_LIMIT'));
  assert.equal(calls, 6);
  await controller.close();
  const restored = await reopen();
  await assert.rejects(restored.enqueue(forwarded), errorCode('ROUND_SLOT_USED'));
  assert.equal(restored.snapshot().exchanges[0].slots.length, 6);
});

test('stop immediately blocks later sends, persists across restart and permits late native replies', async (t) => {
  let calls = 0;
  const { controller, reopen } = await fixture(t, { send: async () => { calls++; return { status: 'sent' }; } });
  await controller.enqueue(message('accepted'));
  await controller.enqueue(message('queued'));
  await controller.dispatch('accepted');
  const stopping = controller.stop();
  const blocked = assert.rejects(controller.dispatch('queued'), errorCode('STOPPED'));
  const result = await stopping;
  await blocked;
  assert.equal(result.nativeCancellation.supported, false);
  assert.deepEqual(result.nativeCancellation.messageIds, ['accepted']);
  assert.deepEqual(result.blockedMessageIds, ['queued']);
  await assert.rejects(controller.enqueue(message('new')), errorCode('STOPPED'));
  await assert.rejects(controller.startExchange({ id: 'new', maxRounds: 1 }), errorCode('STOPPED'));
  await controller.recordReply({ id: 'late', inReplyTo: 'accepted', target: codex, text: 'Late native reply' });
  assert.equal((await controller.stop()).nativeCancellation.messageIds.length, 0);
  await controller.close();
  const restored = await reopen();
  await assert.rejects(restored.dispatch('queued'), errorCode('STOPPED'));
  assert.equal(restored.snapshot().stopped, true);
  assert.equal(calls, 1);
});

test('stop remains responsive during a pending adapter and does not falsely claim model cancellation', async (t) => {
  const entered = deferred();
  const finish = deferred();
  const { controller } = await fixture(t, { send: () => { entered.resolve(); return finish.promise; } });
  await controller.enqueue(message('pending'));
  const dispatch = controller.dispatch('pending');
  await entered.promise;
  const stopped = await controller.stop();
  assert.deepEqual(stopped.nativeCancellation.messageIds, ['pending']);
  finish.resolve({ status: 'sent' });
  assert.equal((await dispatch).status, 'awaiting_reply');
  assert.deepEqual((await controller.stop()).nativeCancellation.messageIds, ['pending']);
});

test('a delayed connection cannot write after Stop and sees an aborted signal', async (t) => {
  const entered = deferred();
  const continueToWrite = deferred();
  let nativeWrites = 0;
  let signal;
  const { controller } = await fixture(t, {
    async send(input, controls) {
      signal = controls.signal;
      entered.resolve();
      await continueToWrite.promise;
      controls.beforeSend();
      nativeWrites++;
      return { status: 'sent' };
    },
  }, { guardTransport: false });
  await controller.enqueue(message('delayed'));
  const dispatch = controller.dispatch('delayed');
  await entered.promise;
  await controller.stop();
  assert.equal(signal.aborted, true);
  continueToWrite.resolve();
  assert.equal((await dispatch).status, 'stopped');
  assert.equal(nativeWrites, 0);
  assert.deepEqual((await controller.stop()).nativeCancellation.messageIds, []);
});

test('a delayed adapter cannot write after timeout and one guard cannot authorize two writes', async (t) => {
  const continueToWrite = deferred();
  const lateFinished = deferred();
  let nativeWrites = 0;
  const { controller } = await fixture(t, {
    async send(input, controls) {
      if (input.id === 'late') {
        await continueToWrite.promise;
        try {
          controls.beforeSend();
          nativeWrites++;
        } finally { lateFinished.resolve(); }
      } else {
        controls.beforeSend();
        nativeWrites++;
        controls.beforeSend();
        nativeWrites++;
      }
      return { status: 'sent' };
    },
  }, { guardTransport: false, sendTimeoutMs: 15 });
  await controller.enqueue(message('late'));
  assert.equal((await controller.dispatch('late')).status, 'uncertain');
  continueToWrite.resolve();
  await lateFinished.promise;
  assert.equal(nativeWrites, 0);
  await controller.enqueue(message('double'));
  assert.equal((await controller.dispatch('double')).status, 'uncertain');
  assert.equal(nativeWrites, 1);
});

test('an adapter cannot claim acceptance without using the write guard', async (t) => {
  const { controller } = await fixture(t, { send: async () => ({ status: 'sent' }) }, { guardTransport: false });
  await controller.enqueue(message('unguarded'));
  const result = await controller.dispatch('unguarded');
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'adapter_omitted_write_guard');
});

test('a final reply arriving before transport acknowledgement is not overwritten', async (t) => {
  const entered = deferred();
  const finish = deferred();
  const { controller } = await fixture(t, { send: () => { entered.resolve(); return finish.promise; } });
  await controller.enqueue(message('pending'));
  const dispatch = controller.dispatch('pending');
  await entered.promise;
  await controller.recordReply({ id: 'fast-reply', inReplyTo: 'pending', target: codex, text: 'Completed' });
  finish.resolve({ status: 'sent' });
  assert.equal((await dispatch).status, 'replied');
});

test('a second owner is excluded and truncated journals fail closed', async (t) => {
  const { controller, reopen, journalPath } = await fixture(t);
  await assert.rejects(reopen(), errorCode('JOURNAL_LOCKED'));
  await controller.close();
  await appendFile(journalPath, '{"version":1');
  await assert.rejects(reopen(), errorCode('JOURNAL_CORRUPT'));
});

test('a real process exit after reservation recovers as uncertain without re-dispatch', async (t) => {
  let calls = 0;
  const { controller, reopen, journalPath } = await fixture(t, { send: async () => { calls++; return { status: 'sent' }; } });
  await controller.enqueue(message('crash'));
  await controller.close();
  const moduleUrl = new URL('../src/delivery-controller.mjs', import.meta.url).href;
  const script = `import { DeliveryController } from ${JSON.stringify(moduleUrl)};
    const controller = await DeliveryController.open({ journalPath: ${JSON.stringify(journalPath)}, targets: ${JSON.stringify(targets)}, transport: { send() { process.exit(23); } } });
    await controller.dispatch('crash');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
  assert.equal(exitCode, 23, stderr);
  await assert.rejects(reopen(), errorCode('JOURNAL_LOCKED'));
  // The specific lock belongs to the child whose exit was just observed, not a guessed PID.
  const owner = JSON.parse(await readFile(`${journalPath}.lock`, 'utf8'));
  assert.equal(owner.pid, child.pid);
  await unlink(`${journalPath}.lock`);
  const restored = await reopen();
  assert.equal(restored.snapshot().messages[0].status, 'uncertain');
  assert.equal(restored.snapshot().messages[0].dispatchAttempts, 1);
  await restored.dispatch('crash');
  assert.equal(calls, 0);
});
