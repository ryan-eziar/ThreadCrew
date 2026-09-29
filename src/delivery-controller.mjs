import { open, readFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const AGENTS = new Set(['codex', 'claude']);
const copy = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class DeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeliveryError(code, message);
}

function identifier(value, field = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) {
    fail('INVALID_INPUT', `${field} must be a stable identifier of 1–160 characters.`);
  }
  return value;
}

function target(value) {
  if (!value || !AGENTS.has(value.agent) || value.kind !== 'native-desktop') {
    fail('INVALID_TARGET', 'Only explicitly bound Codex/Claude native-desktop targets are supported.');
  }
  return { agent: value.agent, kind: value.kind, id: identifier(value.id, 'target.id') };
}

function body(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32000) {
    fail('INVALID_INPUT', 'text must contain 1–32000 characters.');
  }
  return value;
}

function bindings(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 2) {
    fail('INVALID_TARGET', 'Bind one or two native targets.');
  }
  const result = values.map(target).sort((a, b) => a.agent.localeCompare(b.agent));
  if (new Set(result.map((item) => item.agent)).size !== result.length) {
    fail('INVALID_TARGET', 'Each agent may have exactly one target in this journal session.');
  }
  return result;
}

/** Durable, transport-independent outbox. It never invokes another model itself. */
export class DeliveryController {
  #path;
  #lockPath;
  #lock;
  #file;
  #targets;
  #transport;
  #timeout;
  #seq = 0;
  #messages = new Map();
  #replies = new Map();
  #exchanges = new Map();
  #tail = Promise.resolve();
  #active = new Map();
  #sendContexts = new Map();
  #stopped = false;
  #stopRequested = false;
  #closing = false;
  #closed = false;
  #poisoned = false;

  static async open({ journalPath, targets, transport, sendTimeoutMs = 15000 }) {
    if (typeof journalPath !== 'string' || !journalPath) fail('INVALID_INPUT', 'journalPath is required.');
    if (typeof transport?.send !== 'function') fail('INVALID_INPUT', 'transport.send is required.');
    if (!Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 60000) {
      fail('INVALID_INPUT', 'sendTimeoutMs must be between 1 and 60000.');
    }
    const instance = new DeliveryController();
    instance.#path = resolve(journalPath);
    instance.#lockPath = `${instance.#path}.lock`;
    instance.#targets = bindings(targets);
    instance.#transport = transport;
    instance.#timeout = sendTimeoutMs;
    await mkdir(dirname(instance.#path), { recursive: true });
    try {
      instance.#lock = await open(instance.#lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') fail('JOURNAL_LOCKED', 'Journal is already owned, or its prior owner needs crash recovery.');
      throw error;
    }
    try {
      await instance.#lock.writeFile(JSON.stringify({ pid: process.pid, journalPath: instance.#path }) + '\n');
      await instance.#lock.sync();
      instance.#file = await open(instance.#path, 'a+', 0o600);
      const content = await readFile(instance.#path, 'utf8');
      if (content) {
        if (!content.endsWith('\n')) fail('JOURNAL_CORRUPT', 'Journal has an incomplete record; automatic repair is unsafe.');
        for (const line of content.slice(0, -1).split('\n')) {
          let event;
          try { event = JSON.parse(line); } catch { fail('JOURNAL_CORRUPT', 'Journal contains invalid JSON.'); }
          instance.#apply(event);
        }
      } else {
        await instance.#append('init', { targets: instance.#targets });
      }
      // The durable attempt was reserved before the old process could send. Never retry it.
      for (const message of instance.#messages.values()) {
        if (message.status === 'dispatching') {
          await instance.#append('dispatch_finished', { id: message.id, outcome: 'uncertain', reason: 'interrupted_before_confirmation' });
        }
      }
      return instance;
    } catch (error) {
      await instance.#release();
      throw error;
    }
  }

  #checkOpen() {
    if (this.#closed || this.#closing) fail('CLOSED', 'Delivery controller is closed.');
    if (this.#poisoned) fail('JOURNAL_UNSAFE', 'A journal write failed; reopen only after checking the journal.');
  }

  #serial(operation) {
    const pending = this.#tail.then(operation);
    this.#tail = pending.catch(() => {});
    return pending;
  }

  #bound(value) {
    const normalized = target(value);
    if (!this.#targets.some((binding) => equal(binding, normalized))) {
      fail('TARGET_MISMATCH', 'Target agent, kind and ID must exactly match this journal session.');
    }
    return normalized;
  }

  #messageInput(value) {
    const message = {
      id: identifier(value?.id), target: this.#bound(value?.target), text: body(value?.text),
      origin: value.origin ?? 'human', exchangeId: value.exchangeId ?? null, round: value.round ?? null,
    };
    if (message.origin !== 'human' && !AGENTS.has(message.origin)) fail('INVALID_INPUT', 'Unknown message origin.');
    if (message.origin === 'human') {
      if (message.exchangeId !== null || message.round !== null) fail('INVALID_INPUT', 'Human messages do not consume automated exchange rounds.');
    } else {
      identifier(message.exchangeId, 'exchangeId');
      if (!Number.isInteger(message.round)) fail('INVALID_INPUT', 'An agent message requires an explicit round.');
      if (message.origin === message.target.agent) fail('SELF_SEND', 'An agent cannot send a message to itself.');
    }
    return message;
  }

  #validateNewMessage(message) {
    if (this.#messages.has(message.id) || this.#replies.has(message.id)) fail('ID_CONFLICT', 'Message ID already exists.');
    if (message.origin !== 'human') {
      const exchange = this.#exchanges.get(message.exchangeId);
      if (!exchange) fail('EXCHANGE_REQUIRED', 'Start an explicit bounded exchange before forwarding agent messages.');
      if (message.round < 1 || message.round > exchange.maxRounds) fail('ROUND_LIMIT', 'Message exceeds the exchange round limit.');
      if (exchange.slots.includes(`${message.round}:${message.target.agent}`)) {
        fail('ROUND_SLOT_USED', 'This recipient already has a message in this exchange round.');
      }
    }
  }

  async #append(type, fields) {
    if (this.#poisoned) fail('JOURNAL_UNSAFE', 'Journal is unsafe.');
    const event = { version: 1, seq: this.#seq + 1, at: new Date().toISOString(), type, ...fields };
    try {
      await this.#file.writeFile(JSON.stringify(event) + '\n');
      await this.#file.sync();
    } catch (error) {
      this.#poisoned = true;
      throw new DeliveryError('JOURNAL_WRITE_FAILED', `Journal write failed (${error.code ?? 'unknown'}); no further sends allowed.`);
    }
    this.#apply(event);
  }

  #apply(event) {
    if (event?.version !== 1 || event.seq !== this.#seq + 1 || typeof event.at !== 'string') {
      fail('JOURNAL_CORRUPT', 'Unexpected journal version, sequence or timestamp.');
    }
    if ((this.#seq === 0) !== (event.type === 'init')) fail('JOURNAL_CORRUPT', 'Journal must start with exactly one binding record.');
    switch (event.type) {
      case 'init':
        if (!equal(bindings(event.targets), this.#targets)) fail('TARGET_MISMATCH', 'Existing journal is bound to different targets.');
        break;
      case 'exchange_started': {
        const { id, maxRounds } = event.exchange;
        identifier(id, 'exchange.id');
        if (this.#stopped || this.#targets.length !== 2 || this.#exchanges.has(id) || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3) {
          fail('JOURNAL_CORRUPT', 'Invalid exchange record.');
        }
        this.#exchanges.set(id, { id, maxRounds, slots: [], startedAt: event.at });
        break;
      }
      case 'message_enqueued': {
        const input = this.#messageInput(event.message);
        if (this.#stopped) fail('JOURNAL_CORRUPT', 'Message was added after stop.');
        this.#validateNewMessage(input);
        this.#messages.set(input.id, { ...input, status: 'queued', dispatchAttempts: 0, deliveryOutcome: null, replyIds: [], createdAt: event.at, updatedAt: event.at });
        if (input.origin !== 'human') this.#exchanges.get(input.exchangeId).slots.push(`${input.round}:${input.target.agent}`);
        break;
      }
      case 'dispatch_started': {
        const message = this.#messages.get(event.id);
        if (this.#stopped || !message || message.status !== 'queued' || message.dispatchAttempts !== 0) fail('JOURNAL_CORRUPT', 'Invalid dispatch attempt.');
        Object.assign(message, { status: 'dispatching', dispatchAttempts: 1, updatedAt: event.at });
        break;
      }
      case 'dispatch_finished': {
        const message = this.#messages.get(event.id);
        if (!message || message.dispatchAttempts !== 1 || message.deliveryOutcome !== null || !['sent', 'failed', 'uncertain', 'stopped'].includes(event.outcome)) fail('JOURNAL_CORRUPT', 'Invalid dispatch result.');
        const hasFinal = message.replyIds.some((id) => this.#replies.get(id).channel === 'final');
        Object.assign(message, { deliveryOutcome: event.outcome, status: hasFinal ? 'replied' : event.outcome === 'sent' ? 'awaiting_reply' : event.outcome, updatedAt: event.at });
        if (event.reason) message.reason = event.reason;
        break;
      }
      case 'reply_recorded': {
        const reply = this.#replyInput(event.reply);
        if (this.#messages.has(reply.id) || this.#replies.has(reply.id)) fail('JOURNAL_CORRUPT', 'Duplicate reply ID.');
        const message = this.#validateReply(reply);
        this.#replies.set(reply.id, { ...reply, receivedAt: event.at });
        message.replyIds.push(reply.id);
        message.updatedAt = event.at;
        if (reply.channel === 'final') message.status = 'replied';
        break;
      }
      case 'stopped':
        this.#stopped = true;
        this.#stopRequested = true;
        for (const message of this.#messages.values()) if (message.status === 'queued') message.status = 'stopped';
        break;
      default: fail('JOURNAL_CORRUPT', 'Unknown journal event.');
    }
    this.#seq = event.seq;
  }

  enqueue(value) {
    return this.#serial(async () => {
      this.#checkOpen();
      const input = this.#messageInput(value);
      const existing = this.#messages.get(input.id);
      if (existing) {
        if (!equal(this.#messageInput(existing), input)) fail('ID_CONFLICT', 'The same message ID has different content or routing.');
        return copy(existing);
      }
      if (this.#stopRequested) fail('STOPPED', 'This journal session has stopped.');
      this.#validateNewMessage(input);
      await this.#append('message_enqueued', { message: input });
      return copy(this.#messages.get(input.id));
    });
  }

  startExchange({ id, maxRounds }) {
    return this.#serial(async () => {
      this.#checkOpen();
      identifier(id, 'exchange.id');
      if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3) fail('ROUND_LIMIT', 'maxRounds must be 1, 2 or 3.');
      const existing = this.#exchanges.get(id);
      if (existing) {
        if (existing.maxRounds !== maxRounds) fail('ID_CONFLICT', 'Exchange ID is already bound to a different limit.');
        return copy(existing);
      }
      if (this.#stopRequested) fail('STOPPED', 'This journal session has stopped.');
      if (this.#targets.length !== 2) fail('EXCHANGE_TARGETS_REQUIRED', 'Both native agents must be bound before starting an exchange.');
      await this.#append('exchange_started', { exchange: { id, maxRounds } });
      return copy(this.#exchanges.get(id));
    });
  }

  dispatch(id) {
    identifier(id);
    if (this.#active.has(id)) return this.#active.get(id);
    const pending = this.#dispatch(id);
    this.#active.set(id, pending);
    pending.then(() => this.#active.delete(id), () => this.#active.delete(id));
    return pending;
  }

  async #dispatch(id) {
    const shouldSend = await this.#serial(async () => {
      this.#checkOpen();
      const message = this.#messages.get(id);
      if (!message) fail('NOT_FOUND', 'Unknown message ID.');
      if (message.dispatchAttempts) return false;
      if (this.#stopRequested) fail('STOPPED', 'This journal session has stopped.');
      await this.#append('dispatch_started', { id });
      return true;
    });
    if (!shouldSend) return copy(this.#messages.get(id));
    let outcome = 'uncertain';
    let reason;
    if (this.#stopRequested) {
      outcome = 'stopped';
      reason = 'stopped_before_transport';
    } else {
      let timer;
      let writeAuthorized = false;
      let blockedBeforeWrite = false;
      let suppressed = false;
      const abort = new AbortController();
      this.#sendContexts.set(id, abort);
      const beforeSend = () => {
        if (writeAuthorized) fail('DUPLICATE_WRITE_BLOCKED', 'The adapter may authorize only one native write per message.');
        if (this.#stopRequested || abort.signal.aborted) {
          blockedBeforeWrite = true;
          fail('SEND_CANCELLED_BEFORE_WRITE', 'Stop or timeout blocked this outbound write.');
        }
        writeAuthorized = true;
      };
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            // Stop may have arrived between durable reservation and this microtask.
            if (this.#stopRequested) {
              suppressed = true;
              return { status: 'stopped' };
            }
            return this.#transport.send(copy(this.#messages.get(id)), { signal: abort.signal, beforeSend });
          }),
          new Promise((resolveTimeout) => {
            timer = setTimeout(() => {
              abort.abort(new DeliveryError('SEND_TIMEOUT', 'Transport deadline expired.'));
              resolveTimeout({ status: 'uncertain', reason: 'transport_timeout' });
            }, this.#timeout);
          }),
        ]);
        if (suppressed) outcome = 'stopped';
        else if (['sent', 'failed', 'uncertain'].includes(result?.status)) outcome = result.status;
        if (outcome === 'sent' && !writeAuthorized) {
          outcome = 'uncertain';
          reason = 'adapter_omitted_write_guard';
        }
        if (result?.reason === 'transport_timeout') reason = 'transport_timeout';
        else if (suppressed) reason = 'stopped_before_transport';
      } catch {
        // Do not persist arbitrary adapter errors: they may contain credentials.
        if (blockedBeforeWrite && !writeAuthorized) {
          outcome = 'stopped';
          reason = 'cancelled_before_write';
        } else {
          reason = 'transport_threw_without_confirmation';
        }
      } finally {
        clearTimeout(timer);
        // Prevent a misbehaving delayed callback from authorizing a write after
        // its adapter operation has already settled (also after timeout).
        abort.abort(new DeliveryError('SEND_SETTLED', 'Transport operation has settled.'));
        this.#sendContexts.delete(id);
      }
    }
    await this.#serial(() => this.#append('dispatch_finished', { id, outcome, ...(reason ? { reason } : {}) }));
    return copy(this.#messages.get(id));
  }

  #replyInput(value) {
    const result = { id: identifier(value?.id), inReplyTo: identifier(value?.inReplyTo, 'inReplyTo'), target: this.#bound(value?.target), text: body(value?.text), channel: value.channel ?? 'final' };
    if (!['commentary', 'final'].includes(result.channel)) fail('INVALID_INPUT', 'Reply channel must be commentary or final.');
    return result;
  }

  #validateReply(reply) {
    const message = this.#messages.get(reply.inReplyTo);
    if (!message || message.dispatchAttempts !== 1 || message.deliveryOutcome === 'stopped') fail('UNSOLICITED_REPLY', 'Reply must reference an attempted message.');
    if (!equal(message.target, reply.target)) fail('TARGET_MISMATCH', 'Reply must come from the exact dispatched native target.');
    return message;
  }

  recordReply(value) {
    return this.#serial(async () => {
      this.#checkOpen();
      const input = this.#replyInput(value);
      const existing = this.#replies.get(input.id);
      if (existing) {
        if (!equal(this.#replyInput(existing), input)) fail('ID_CONFLICT', 'Reply ID is already bound to different content or routing.');
        return copy(existing);
      }
      if (this.#messages.has(input.id)) fail('ID_CONFLICT', 'Reply ID conflicts with a message ID.');
      this.#validateReply(input);
      await this.#append('reply_recorded', { reply: input });
      return copy(this.#replies.get(input.id));
    });
  }

  stop() {
    // Synchronously closes the dispatch gate, even while an earlier write is pending.
    this.#stopRequested = true;
    for (const abort of this.#sendContexts.values()) {
      abort.abort(new DeliveryError('STOPPED', 'This journal session has stopped.'));
    }
    return this.#serial(async () => {
      this.#checkOpen();
      if (!this.#stopped) await this.#append('stopped', {});
      return {
        stopped: true,
        blockedMessageIds: [...this.#messages.values()].filter((m) => m.status === 'stopped').map((m) => m.id),
        nativeCancellation: {
          supported: false,
          messageIds: [...this.#messages.values()].filter((m) => m.dispatchAttempts && !['replied', 'failed', 'stopped'].includes(m.status)).map((m) => m.id),
          explanation: 'Further sends are blocked. Native model execution may continue; this controller cannot cancel it.',
        },
      };
    });
  }

  snapshot() {
    return copy({ version: 1, journalPath: this.#path, stopped: this.#stopRequested, targets: this.#targets, messages: [...this.#messages.values()], replies: [...this.#replies.values()], exchanges: [...this.#exchanges.values()] });
  }

  async #release() {
    try { await this.#file?.close(); } finally {
      try { await this.#lock?.close(); } finally { await unlink(this.#lockPath); }
    }
  }

  async close() {
    if (this.#closed) return;
    if (this.#closing) fail('CLOSED', 'Close is already in progress.');
    this.#closing = true;
    await Promise.allSettled([...this.#active.values()]);
    await this.#tail;
    await this.#release();
    this.#closed = true;
  }
}
