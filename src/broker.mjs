import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { openStore, createTextAttachment, readTextAttachment } from './broker-storage.mjs';

export const API_VERSION = 'agent-chat.window.v1';
const AGENTS = ['codex', 'claude'];
const FINISH_POLICIES = ['first_done', 'both_same_round'];
const copy = value => structuredClone(value);
const id = prefix => `${prefix}-${randomUUID()}`;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const allowed = (reason = null) => ({ enabled: reason === null, reason });
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;
export class BrokerError extends Error {
  constructor(code, message = code, status = 409, outcome = 'rejected') {
    super(message); Object.assign(this, { name: 'BrokerError', code, status, outcome, retrySameOperation: outcome === 'unknown' });
  }
}
function fail(code, status = 409) { throw new BrokerError(code, code, status); }
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) fail('INVALID_INPUT', 400); return value; }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 400);
  if (Object.keys(value).some(key => !keys.includes(key))) fail('UNKNOWN_FIELD', 400);
}
function textInput(value, maximum = 32000) {
  if (typeof value !== 'string') fail('INVALID_INPUT', 400);
  if ([...value].length > maximum) fail('CONTENT_TOO_LARGE', 413);
  return value;
}
const publicItem = value => Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')));

/** One writer owns room transactions. No method launches a model process. */
export class Broker extends EventEmitter {
  #store; #state; #runtimeDir; #clock; #transport; #timeout;
  #tail = Promise.resolve(); #closed = false; #closing = false; #unsafe = false; #seq = 0; #activeDraft = null;
  #instanceId = id('instance'); #stopping = new Set(); #ending = new Set();
  #waiters = new Map(); #connections = new Map(); #sendContexts = new Map();
  #pendingOps = new Map(); #nativeTasks = new Set(); #kickPending = false;
  #writesStarted = new Set();
  #stopOwners = new Map();

  static async open({ runtimeDir, roomId = 'agent-chat', codexTransport = null, clock = Date.now, sendTimeoutMs = 15000 }) {
    identifier(roomId);
    const broker = new Broker();
    broker.#runtimeDir = resolve(runtimeDir); broker.#clock = clock; broker.#transport = codexTransport; broker.#timeout = sendTimeoutMs;
    broker.#store = await openStore({ runtimeDir: broker.#runtimeDir, roomId });
    broker.#state = broker.#store.state;
    try {
      if (!broker.#state) {
        const segmentId = id('segment');
        broker.#state = { schemaVersion: 1, roomId, gate: { segmentId, version: 1 }, segments: [{ id: segmentId, stoppedAt: null }],
          currentBindings: { codex: null, claude: null }, bindings: {}, messages: [], deliveries: [], replies: [], exchanges: [], attachments: [], timeline: [], operations: {} };
        broker.#system(broker.#state, 'segment_opened', { previousSegmentId: null });
        await broker.#store.commit(broker.#state);
      } else {
        broker.#validateState(roomId);
        const draft = copy(broker.#state);
        // v1 exchanges were created before finish policies existed. Their persisted
        // meaning is unilateral completion, including when an exchange is active.
        for (const exchange of draft.exchanges) {
          exchange.finishPolicy ??= 'first_done';
          for (const round of exchange.rounds) {
            round.finishVotes ??= Object.fromEntries(AGENTS.map(agent => {
              const reply = draft.replies.find(value => value.id === round.finalReplyIds[agent]);
              return [agent, reply && !reply.lateReasons.length ? reply.done : null];
            }));
          }
        }
        for (const binding of Object.values(draft.bindings)) { binding.notification = null; binding.batch = null; }
        for (const delivery of draft.deliveries) if (delivery.state === 'dispatching') {
          delivery.state = 'uncertain'; delivery.reason = 'DELIVERY_UNCERTAIN'; delivery.evidence = { kind: 'unknown', at: broker.#now() }; delivery.version++;
          if (delivery.exchangeId) broker.#endExchange(draft, delivery.exchangeId, 'uncertain');
        }
        // A restart invalidates stale page actions; historical operation IDs remain valid.
        draft.gate.version++;
        await broker.#store.commit(draft); broker.#state = draft;
      }
      broker.#seq = 1;
      return broker;
    } catch (error) { await broker.#store.close(); if (error instanceof BrokerError) throw error; throw new BrokerError('RECOVERY_REQUIRED', 'RECOVERY_REQUIRED', 503); }
  }
  #validateState(roomId) {
    const state = this.#state;
    try {
      if (state.schemaVersion !== 1 || state.roomId !== roomId || !Number.isSafeInteger(state.gate.version) || state.gate.version < 1) throw 0;
      for (const key of ['segments', 'messages', 'deliveries', 'replies', 'exchanges', 'attachments', 'timeline']) {
        if (!Array.isArray(state[key]) || new Set(state[key].map(item => identifier(item.id))).size !== state[key].length) throw 0;
      }
      if (!state.bindings || !state.operations || !state.currentBindings || !this.#segment(state)) throw 0;
      for (const agent of AGENTS) if (state.currentBindings[agent] !== null && state.bindings[state.currentBindings[agent]]?.agent !== agent) throw 0;
      const finals = new Set(); const waiting = new Set();
      for (const reply of state.replies) {
        const delivery = state.deliveries.find(item => item.id === reply.deliveryId);
        if (!delivery || delivery.finalReplyId !== reply.id || delivery.bindingId !== reply.bindingId || finals.has(reply.deliveryId)) throw 0;
        finals.add(reply.deliveryId);
      }
      for (const delivery of state.deliveries) {
        if (!this.#segment(state, delivery.segmentId) || !AGENTS.includes(delivery.agent)) throw 0;
        if (delivery.bindingId && state.bindings[delivery.bindingId]?.nativeSessionId !== delivery.nativeSessionId) throw 0;
        if (delivery.finalReplyId && !state.replies.some(item => item.id === delivery.finalReplyId)) throw 0;
        if ((delivery.messageId === null) === (delivery.sourceReplyId === null)) throw 0;
        if (delivery.messageId) {
          const message = state.messages.find(item => item.id === delivery.messageId);
          if (!message || !message.recipients.includes(delivery.agent) || !message.deliveryIds.includes(delivery.id) || delivery.exchangeId !== null) throw 0;
        } else {
          const source = state.replies.find(item => item.id === delivery.sourceReplyId);
          const exchange = state.exchanges.find(item => item.id === delivery.exchangeId);
          if (!source || source.agent === delivery.agent || !exchange?.rounds.some(item => item.number === delivery.round && item.deliveryIds[delivery.agent] === delivery.id)) throw 0;
        }
        if (delivery.waitDisposition === 'waiting' && !delivery.finalReplyId) { if (waiting.has(delivery.bindingId)) throw 0; waiting.add(delivery.bindingId); }
      }
      for (const exchange of state.exchanges) {
        if (!Number.isInteger(exchange.maxRounds) || exchange.maxRounds < 1 || exchange.maxRounds > 3 || exchange.rounds.length > exchange.maxRounds
          || (exchange.finishPolicy !== undefined && !FINISH_POLICIES.includes(exchange.finishPolicy))) throw 0;
        for (const round of exchange.rounds) if (round.finishVotes && AGENTS.some(agent => ![null, true, false].includes(round.finishVotes[agent]))) throw 0;
      }
      if (state.exchanges.filter(item => item.state === 'active').length > 1) throw 0;
    } catch { fail('RECOVERY_REQUIRED', 503); }
  }
  #now() { return new Date(this.#clock()).toISOString(); }
  #check() { if (this.#closed) fail('CLOSED', 503); if (this.#unsafe) fail('RECOVERY_REQUIRED', 503); }
  #binding(state, bindingId, current = true) {
    const binding = own(state.bindings, identifier(bindingId));
    if (!binding || (current && state.currentBindings[binding.agent] !== bindingId)) fail('BINDING_INVALID', 403);
    return binding;
  }
  #segment(state, segmentId = state.gate.segmentId) { return state.segments.find(value => value.id === segmentId); }
  #blocked(state, delivery) {
    return this.#unsafe || this.#closed || this.#closing || this.#stopping.has(delivery.segmentId) || Boolean(this.#segment(state, delivery.segmentId)?.stoppedAt)
      || state.currentBindings[delivery.agent] !== delivery.bindingId
      || Boolean(delivery.exchangeId && (this.#ending.has(delivery.exchangeId) || state.exchanges.find(value => value.id === delivery.exchangeId)?.state !== 'active'));
  }
  #blocker(state, bindingId) {
    return state.deliveries.find(value => value.bindingId === bindingId && value.waitDisposition === 'waiting' && !value.finalReplyId);
  }
  #eligible(state, bindingId) {
    if (this.#blocker(state, bindingId)) return null;
    return state.deliveries.find(value => value.bindingId === bindingId && value.state === 'queued' && !this.#blocked(state, value));
  }
  #written(delivery) { return delivery._writeStarted || this.#writesStarted.has(delivery.id); }
  #system(state, systemType, data, segmentId = state.gate.segmentId) {
    state.timeline.push({ id: id('timeline'), order: state.timeline.length + 1, at: this.#now(), segmentId,
      kind: 'system', refId: null, text: systemType, systemType, data });
  }
  #timeline(state, kind, item) { state.timeline.push({ id: id('timeline'), order: state.timeline.length + 1, at: this.#now(), segmentId: item.segmentId, kind, refId: item.id, text: null, systemType: null, data: null }); }
  #publish() { this.#seq++; this.emit('change', this.snapshot()); this.#kick(); }
  #tx(fn) {
    const task = this.#tail.then(async () => {
      this.#check(); const draft = copy(this.#state);
      const priorEnding = new Set(this.#ending); this.#activeDraft = draft;
      try {
        let result;
        try { result = await fn(draft); }
        catch (error) {
          if ([...this.#ending].some(value => !priorEnding.has(value))) {
            this.#unsafe = true; for (const controller of this.#sendContexts.values()) controller.abort(); this.#publish();
            throw new BrokerError('JOURNAL_UNSAFE', 'JOURNAL_UNSAFE', 503, 'unknown');
          }
          throw error;
        }
        for (const delivery of draft.deliveries) if (this.#writesStarted.has(delivery.id)) delivery._writeStarted = true;
        try { await this.#store.commit(draft); }
        catch { this.#unsafe = true; for (const controller of this.#sendContexts.values()) controller.abort(); this.#publish(); throw new BrokerError('JOURNAL_UNSAFE', 'JOURNAL_UNSAFE', 503, 'unknown'); }
        this.#state = draft; this.#publish(); return copy(result);
      } finally { this.#activeDraft = null; }
    });
    this.#tail = task.catch(() => {}); return task;
  }
  #gate(state, expectedGate) { if (!same(state.gate, expectedGate)) fail('STATE_CONFLICT'); }
  #human(action, input, work, { gate = true } = {}) {
    this.#check(); if (this.#closing) fail('CLOSED', 503); identifier(input.operationId);
    const fingerprint = hash({ action, input });
    const stored = own(this.#state.operations, input.operationId);
    if (stored) { if (stored.fingerprint !== fingerprint) return Promise.reject(new BrokerError('ID_CONFLICT')); return Promise.resolve(copy(stored.result)); }
    const pending = this.#pendingOps.get(input.operationId);
    if (pending) { if (pending.fingerprint !== fingerprint) return Promise.reject(new BrokerError('ID_CONFLICT')); return pending.promise; }
    const promise = this.#tx(async state => {
      if (gate) this.#gate(state, input.expectedGate);
      const value = await work(state);
      const result = { operationId: input.operationId, committedAt: this.#now(), ...value };
      state.operations[input.operationId] = { action, fingerprint, result };
      return result;
    });
    this.#pendingOps.set(input.operationId, { action, fingerprint, promise });
    promise.finally(() => this.#pendingOps.delete(input.operationId)).catch(() => {});
    return promise;
  }
  getOperation(operationId) {
    identifier(operationId); const saved = own(this.#state.operations, operationId);
    if (saved) { const { operationId: _, committedAt, ...value } = saved.result; return { status: 'committed', operationId, action: saved.action, committedAt, value: copy(value) }; }
    return { status: this.#unsafe ? 'recovery_required' : this.#pendingOps.has(operationId) ? 'pending' : 'not_found', operationId,
      action: this.#pendingOps.get(operationId)?.action ?? null, committedAt: null, value: null };
  }
  async #content(state, text) {
    const previewText = [...text.split('\n').slice(0, 12).join('\n')].slice(0, 2000).join('');
    if (previewText === text) return { previewText, format: 'plain', truncated: false, attachmentId: null };
    const attachment = await createTextAttachment(this.#runtimeDir, text, 'full-message.txt');
    if (!state.attachments.some(value => value.id === attachment.id)) state.attachments.push(attachment);
    return { previewText, format: 'plain', truncated: true, attachmentId: attachment.id };
  }
  #attachments(state, values) {
    if (!Array.isArray(values) || new Set(values).size !== values.length) fail('INVALID_INPUT', 400);
    for (const value of values) if (!state.attachments.some(item => item.id === identifier(value))) fail('ATTACHMENT_NOT_FOUND', 404);
  }
  #newDelivery(state, { agent, text, attachmentIds, messageId = null, sourceReplyId = null, exchangeId = null, round = null }) {
    const bindingId = state.currentBindings[agent];
    const delivery = { id: id('delivery'), version: 1, messageId, sourceReplyId, segmentId: state.gate.segmentId, exchangeId, round, agent,
      bindingId, nativeSessionId: bindingId ? state.bindings[bindingId].nativeSessionId : null,
      state: bindingId ? 'queued' : 'pending_binding', reason: bindingId ? null : 'NO_BINDING', claimId: null,
      waitDisposition: 'none', abandonedAt: null, evidence: { kind: 'none', at: null }, createdAt: this.#now(), waitingSince: null,
      finalReplyId: null, _text: text, _attachmentIds: copy(attachmentIds), _writeStarted: false, _attempted: false };
    state.deliveries.push(delivery); return delivery;
  }
  async #message(state, input, resendOfDeliveryId = null) {
    let openedSegment = false;
    if (this.#segment(state).stoppedAt) {
      const previousSegmentId = state.gate.segmentId; state.gate = { segmentId: id('segment'), version: state.gate.version + 1 };
      state.segments.push({ id: state.gate.segmentId, stoppedAt: null }); this.#system(state, 'segment_opened', { previousSegmentId }); openedSegment = true;
    }
    const message = { id: id('message'), segmentId: state.gate.segmentId, author: 'ryan', createdAt: this.#now(),
      content: await this.#content(state, input.text), attachmentIds: copy(input.attachmentIds), recipients: copy(input.recipients), deliveryIds: [], resendOfDeliveryId };
    const deliveries = input.recipients.map(agent => this.#newDelivery(state, { agent, text: input.text, attachmentIds: input.attachmentIds, messageId: message.id }));
    message.deliveryIds = deliveries.map(value => value.id); state.messages.push(message); this.#timeline(state, 'message', message);
    return { messageId: message.id, deliveryIds: Object.fromEntries(deliveries.map(value => [value.agent, value.id])), gate: copy(state.gate), openedSegment };
  }
  postMessage(input) {
    fields(input, ['operationId', 'expectedGate', 'recipients', 'text', 'attachmentIds']);
    if (!Array.isArray(input.recipients) || !input.recipients.length || input.recipients.some(value => !AGENTS.includes(value))) fail('INVALID_INPUT', 400);
    const normalized = { ...input, recipients: [...new Set(input.recipients)].sort(), text: textInput(input.text), attachmentIds: input.attachmentIds ?? [] };
    if (!normalized.text.trim() && !normalized.attachmentIds.length) fail('INVALID_INPUT', 400);
    return this.#human('message.create', normalized, async state => { this.#attachments(state, normalized.attachmentIds); return this.#message(state, normalized); });
  }
  #cancel(delivery, reason) { delivery.state = 'stopped'; delivery.reason = reason; delivery.waitDisposition = 'none'; delivery.version++; }
  #endExchange(state, exchangeId, reason, doneBy = null) {
    const exchange = state.exchanges.find(value => value.id === exchangeId);
    if (!exchange || exchange.state === 'ended') return;
    this.#ending.add(exchangeId);
    Object.assign(exchange, { state: 'ended', endReason: reason, doneBy, endedAt: this.#now() });
    for (const delivery of state.deliveries.filter(value => value.exchangeId === exchangeId)) {
      if (['queued', 'pending_binding'].includes(delivery.state) || (delivery.state === 'dispatching' && !this.#written(delivery))) this.#cancel(delivery, reason === 'binding_changed' ? 'BINDING_CHANGED' : 'EXCHANGE_ENDED');
      this.#sendContexts.get(delivery.id)?.abort();
    }
    this.#system(state, 'exchange_ended', { exchangeId }, exchange.segmentId);
  }
  #round(state, exchange, pair) {
    const number = exchange.currentRound + 1;
    const round = { number, deliveryIds: {}, finalReplyIds: { codex: null, claude: null }, finishVotes: { codex: null, claude: null } };
    for (const agent of AGENTS) {
      const peer = agent === 'codex' ? 'claude' : 'codex'; const reply = state.replies.find(value => value.id === pair[peer]);
      const delivery = this.#newDelivery(state, { agent, text: reply._text, attachmentIds: reply.attachmentIds,
        sourceReplyId: reply.id, exchangeId: exchange.id, round: number });
      round.deliveryIds[agent] = delivery.id;
    }
    exchange.currentRound = number; exchange.rounds.push(round);
  }
  #discussionAction(state, item, isExchange = false) {
    let pair = null; let reason = null;
    if (item.segmentId !== state.gate.segmentId || this.#segment(state).stoppedAt) reason = 'ROOM_STOPPED';
    else if (state.exchanges.some(value => value.state === 'active')) reason = 'EXCHANGE_ACTIVE';
    if (isExchange) {
      const last = item.rounds.at(-1); pair = last ? copy(last.finalReplyIds) : copy(item.baseReplyIds);
    } else {
      pair = Object.fromEntries(AGENTS.map(agent => [agent, state.deliveries.find(value => value.messageId === item.id && value.agent === agent)?.finalReplyId ?? null]));
    }
    if (!reason && (!pair.codex || !pair.claude || Object.values(pair).some(replyId => {
      const reply = state.replies.find(value => value.id === replyId); return !reply || reply.lateReasons.length || reply.segmentId !== state.gate.segmentId;
    }))) reason = 'INCOMPLETE_PAIR';
    if (!reason && AGENTS.some(agent => !this.#member(state, agent).canReceive)) reason = 'MEMBER_NOT_READY';
    return { ...allowed(reason), baseReplyIds: reason ? null : pair };
  }
  startExchange(input) {
    fields(input, ['operationId', 'expectedGate', 'baseMessageId', 'baseReplyIds', 'previousExchangeId', 'maxRounds', 'finishPolicy']);
    if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 3) fail('INVALID_INPUT', 400);
    if (input.finishPolicy !== undefined && !FINISH_POLICIES.includes(input.finishPolicy)) fail('INVALID_INPUT', 400);
    return this.#human('exchange.start', input, state => {
      const previous = input.previousExchangeId ? state.exchanges.find(value => value.id === input.previousExchangeId) : null;
      const message = state.messages.find(value => value.id === input.baseMessageId);
      if (!message || (input.previousExchangeId && (!previous || previous.baseMessageId !== message.id))) fail('BASE_REPLY_INVALID');
      const availability = this.#discussionAction(state, previous ?? message, Boolean(previous));
      if (!availability.enabled) fail(availability.reason);
      if (!same(availability.baseReplyIds, input.baseReplyIds)) fail('BASE_REPLY_INVALID');
      const exchange = { id: id('exchange'), segmentId: state.gate.segmentId, baseMessageId: message.id, previousExchangeId: input.previousExchangeId ?? null,
        baseReplyIds: copy(input.baseReplyIds), maxRounds: input.maxRounds, finishPolicy: input.finishPolicy ?? 'both_same_round', state: 'active', currentRound: 0, completedRounds: 0,
        rounds: [], endedAt: null, endReason: null, doneBy: null };
      state.exchanges.push(exchange); this.#system(state, 'exchange_started', { exchangeId: exchange.id }); this.#round(state, exchange, input.baseReplyIds);
      return { exchangeId: exchange.id, gate: copy(state.gate), maxRounds: exchange.maxRounds, finishPolicy: exchange.finishPolicy };
    });
  }
  stop(input) {
    fields(input, ['operationId', 'expectedGate']); identifier(input.operationId);
    const known = own(this.#state.operations, input.operationId) || this.#pendingOps.has(input.operationId);
    let ownsGate = false;
    if (!known) {
      // An already executing transaction's route changes are visible to admission.
      this.#gate(this.#activeDraft ?? this.#state, input.expectedGate);
      if (this.#segment(this.#state, input.expectedGate.segmentId)?.stoppedAt) fail('ROOM_STOPPED');
      const owners = this.#stopOwners.get(input.expectedGate.segmentId) ?? new Set(); owners.add(input.operationId);
      this.#stopOwners.set(input.expectedGate.segmentId, owners); ownsGate = true;
      this.#stopping.add(input.expectedGate.segmentId); for (const controller of this.#sendContexts.values()) controller.abort();
    }
    const result = this.#human('room.stop', input, state => {
      const segment = this.#segment(state); segment.stoppedAt ??= this.#now(); state.gate.version++;
      for (const delivery of state.deliveries.filter(value => value.segmentId === segment.id)) {
        if (['queued', 'pending_binding'].includes(delivery.state) || (delivery.state === 'dispatching' && !this.#written(delivery))) this.#cancel(delivery, 'STOPPED');
      }
      for (const exchange of state.exchanges.filter(value => value.segmentId === segment.id)) this.#endExchange(state, exchange.id, 'stop');
      for (const binding of Object.values(state.bindings)) { binding.notification = null; binding.batch = null; binding.drainNeedsWait = true; }
      const possibleRunningDeliveryIds = state.deliveries.filter(value => value.segmentId === segment.id && value._attempted && !['failed', 'stopped', 'replied'].includes(value.state)).map(value => value.id);
      this.#system(state, 'room_stopped', { stopOperationId: input.operationId, possibleRunningDeliveryIds });
      return { gate: copy(state.gate), stoppedSegmentId: segment.id, blockedDeliveryIds: state.deliveries.filter(value => value.segmentId === segment.id && value.state === 'stopped').map(value => value.id), possibleRunningDeliveryIds, nativeCancellationSupported: false };
    });
    result.finally(() => {
      if (!ownsGate) return;
      const owners = this.#stopOwners.get(input.expectedGate.segmentId); owners?.delete(input.operationId);
      if (!owners?.size) { this.#stopOwners.delete(input.expectedGate.segmentId); this.#stopping.delete(input.expectedGate.segmentId); this.#kick(); }
    }).catch(() => {});
    return result;
  }
  #abandon(state, delivery) {
    delivery.waitDisposition = 'abandoned'; delivery.abandonedAt = this.#now(); delivery.version++;
    if (delivery.exchangeId) this.#endExchange(state, delivery.exchangeId, 'abandoned');
  }
  abandonDelivery(deliveryId, input) {
    fields(input, ['operationId', 'expectedDeliveryVersion', 'expectedClaimId']); identifier(deliveryId);
    return this.#human('delivery.abandon', { ...input, deliveryId }, state => {
      const delivery = state.deliveries.find(value => value.id === deliveryId); if (!delivery) fail('NOT_FOUND', 404);
      if (delivery.version !== input.expectedDeliveryVersion || delivery.claimId !== input.expectedClaimId) fail('DELIVERY_CHANGED');
      if (delivery.finalReplyId) fail('FINAL_ALREADY_PRESENT');
      if (!['awaiting_reply', 'uncertain'].includes(delivery.state) || delivery.waitDisposition !== 'waiting') fail('DELIVERY_CHANGED');
      this.#abandon(state, delivery);
      return { deliveryId, deliveryVersion: delivery.version, endedExchangeId: delivery.exchangeId, releasedSlot: true, nativeCancellationSupported: false };
    }, { gate: false });
  }
  resendDelivery(deliveryId, input) {
    fields(input, ['operationId', 'expectedGate', 'expectedDeliveryVersion', 'acknowledgePossibleDuplicate']); identifier(deliveryId);
    return this.#human('delivery.resend', { ...input, deliveryId }, async state => {
      const delivery = state.deliveries.find(value => value.id === deliveryId); if (!delivery) fail('NOT_FOUND', 404);
      if (delivery.version !== input.expectedDeliveryVersion) fail('DELIVERY_CHANGED');
      if (delivery.finalReplyId || (!['failed', 'uncertain'].includes(delivery.state) && delivery.waitDisposition !== 'abandoned')) fail('DELIVERY_CHANGED');
      if (delivery.state !== 'failed' && input.acknowledgePossibleDuplicate !== true) fail('DUPLICATE_ACK_REQUIRED');
      if (delivery.waitDisposition === 'waiting') this.#abandon(state, delivery);
      return { ...await this.#message(state, { text: delivery._text, attachmentIds: delivery._attachmentIds, recipients: [delivery.agent] }, deliveryId), resendOfDeliveryId: deliveryId };
    });
  }
  async join({ agent, nativeSessionId, label = '', renew = false }) {
    if (this.#closing) fail('CLOSED', 503);
    if (!AGENTS.includes(agent)) fail('INVALID_INPUT', 400); identifier(nativeSessionId); textInput(label, 160);
    let verified = false;
    if (agent === 'codex' && this.#transport) { try { verified = (await this.#transport.probe({ nativeSessionId })).available === true; } catch {} }
    const result = await this.#tx(state => {
      const existing = state.bindings[state.currentBindings[agent]];
      if (existing?.nativeSessionId === nativeSessionId) {
        if (agent === 'claude' && renew && Date.parse(existing.deadlineAt) <= this.#clock()) {
          existing.leaseId = id('lease'); existing.deadlineAt = new Date(this.#clock() + 36000000).toISOString(); existing.expiredNotified = false;
        }
        return this.#joinResult(state, existing);
      }
      // A queued route change cannot invalidate an already admitted Stop.
      if (this.#stopping.has(state.gate.segmentId)) fail('STATE_CONFLICT');
      if (existing) {
        for (const delivery of state.deliveries.filter(value => value.bindingId === existing.id)) if (['pending_binding', 'queued'].includes(delivery.state)) this.#cancel(delivery, 'BINDING_CHANGED');
        for (const exchange of state.exchanges.filter(value => value.state === 'active')) this.#endExchange(state, exchange.id, 'binding_changed');
      }
      const binding = { id: id('binding'), agent, nativeSessionId, label: label || `${agent} session`, source: verified ? 'native_verified' : 'manual', joinedAt: this.#now(),
        leaseId: agent === 'claude' ? id('lease') : null, deadlineAt: agent === 'claude' ? new Date(this.#clock() + 36000000).toISOString() : null,
        lastRenewedByReplyId: null, expiredNotified: false, notification: null, batch: null, drainNeedsWait: false, readRequests: {} };
      state.bindings[binding.id] = binding; state.currentBindings[agent] = binding.id; state.gate.version++;
      for (const delivery of state.deliveries.filter(value => value.agent === agent && value.state === 'pending_binding')) {
        delivery.bindingId = binding.id; delivery.nativeSessionId = nativeSessionId; delivery.state = 'queued'; delivery.reason = null; delivery.version++;
      }
      this.#system(state, 'binding_changed', { agent, bindingId: binding.id }); return this.#joinResult(state, binding);
    });
    this.#connections.set(result.bindingId, { available: agent === 'codex' && verified, at: this.#now() }); this.#publish();
    for (const [bindingId, waiter] of this.#waiters) if (this.#state.currentBindings.claude !== bindingId) waiter.finish({ status: 'BINDING_INVALID' });
    return result;
  }
  #joinResult(state, binding) {
    const claim = this.#blocker(state, binding.id);
    return { agent: binding.agent, bindingId: binding.id, binding: { id: binding.id, nativeSessionId: binding.nativeSessionId, label: binding.label, source: binding.source, joinedAt: binding.joinedAt },
      leaseId: binding.leaseId, deadlineAt: binding.deadlineAt, recoverableClaimId: claim && !this.#blocked(state, claim) ? claim.claimId : null, batchId: binding.batch?.id ?? null };
  }
  getBinding(bindingId) { return this.#joinResult(this.#state, this.#binding(this.#state, bindingId, false)); }
  #member(state, agent) {
    const binding = state.bindings[state.currentBindings[agent]]; const blocker = binding && this.#blocker(state, binding.id);
    let status = 'unbound', reason = 'NO_BINDING'; let wait = null;
    const connection = binding && this.#connections.get(binding.id);
    if (binding) {
      if (agent === 'codex') { status = connection?.available ? 'ready' : 'disconnected'; reason = connection?.available ? null : 'NO_CONNECTION'; }
      else {
        const expired = Date.parse(binding.deadlineAt) <= this.#clock();
        const waitState = this.#waiters.has(binding.id) ? 'armed' : binding.notification ? 'notified' : expired ? 'expired' : 'unarmed';
        status = waitState === 'armed' ? 'ready' : waitState; reason = waitState === 'armed' || waitState === 'notified' ? null : expired ? 'WAIT_EXPIRED' : 'WAITER_UNARMED';
        wait = { leaseId: binding.leaseId, state: waitState, deadlineAt: binding.deadlineAt, lastRenewedByReplyId: binding.lastRenewedByReplyId };
      }
      if (blocker) { status = blocker.state === 'uncertain' ? 'recovery_required' : 'busy'; reason = blocker.state === 'uncertain' ? 'DELIVERY_UNCERTAIN' : 'AWAITING_REPLY'; }
      if (this.#unsafe) { status = 'recovery_required'; reason = 'RECOVERY_REQUIRED'; }
    }
    return { agent, route: agent === 'codex' ? 'codex-push' : 'claude-pull', binding: binding ? this.#joinResult(state, binding).binding : null,
      state: status, canReceive: status === 'ready' && !this.#unsafe, reason, evidenceAt: connection?.at ?? null, blockingDeliveryId: blocker?.id ?? null, wait };
  }
  snapshot() {
    const state = this.#state; const members = AGENTS.map(agent => this.#member(state, agent)); const segment = this.#segment(state);
    const exchanges = state.exchanges.map(value => ({ ...publicItem(copy(value)), finishPolicy: value.finishPolicy ?? 'first_done', waitingFor: value.state === 'active' ? AGENTS.filter(agent => !value.rounds.at(-1)?.finalReplyIds[agent]) : [], actions: { again: this.#discussionAction(state, value, true) } }));
    const deliveries = state.deliveries.map(value => {
      const item = publicItem(copy(value)); const member = members.find(member => member.agent === value.agent); const blocker = value.bindingId && this.#blocker(state, value.bindingId);
      item.blockedByDeliveryId = value.state === 'queued' && blocker?.id !== value.id ? blocker?.id ?? null : null;
      item.blockedByStoppedSegment = Boolean(item.blockedByDeliveryId && this.#segment(state, blocker.segmentId)?.stoppedAt);
      if (value.state === 'queued') item.reason = item.blockedByDeliveryId ? 'BLOCKED_BY_DELIVERY' : ['NO_CONNECTION', 'WAIT_EXPIRED', 'WAITER_UNARMED'].includes(member.reason) ? member.reason : null;
      const canAbandon = !value.finalReplyId && value.waitDisposition === 'waiting' && ['awaiting_reply', 'uncertain'].includes(value.state);
      const canResend = !value.finalReplyId && (['failed', 'uncertain'].includes(value.state) || value.waitDisposition === 'abandoned');
      const disabled = this.#unsafe ? 'RECOVERY_REQUIRED' : value.finalReplyId ? 'FINAL_ALREADY_PRESENT' : 'AWAITING_REPLY';
      item.actions = { abandon: allowed(canAbandon && !this.#unsafe ? null : disabled), resend: allowed(canResend && !this.#unsafe ? null : disabled) }; return item;
    });
    const active = state.exchanges.find(value => value.state === 'active');
    const canStop = !segment.stoppedAt && (Boolean(active) || state.deliveries.some(value => value.segmentId === segment.id && value.waitDisposition !== 'abandoned' && ['pending_binding', 'queued', 'dispatching', 'awaiting_reply', 'uncertain'].includes(value.state)));
    return { instanceId: this.#instanceId, seq: this.#seq, serverTime: this.#now(), capabilities: { discussionFinishPolicies: copy(FINISH_POLICIES), contentFormats: ['plain'] }, room: { id: state.roomId, gate: copy(state.gate), state: segment.stoppedAt ? 'stopped' : 'active', stoppedAt: segment.stoppedAt,
      health: this.#unsafe ? 'recovery_required' : 'ok', activeExchangeId: active?.id ?? null,
      actions: { send: allowed(this.#unsafe ? 'RECOVERY_REQUIRED' : null), stop: allowed(this.#unsafe ? 'RECOVERY_REQUIRED' : canStop ? null : 'NO_PENDING_WORK') } },
      limits: { maxRounds: 3, idleWaitSeconds: 36000, maxDrainDeliveries: 3, maxHumanTextCodePoints: 32000, previewCodePoints: 2000, previewLines: 12 }, members,
      messages: state.messages.map(value => ({ ...publicItem(copy(value)), actions: { discuss: this.#discussionAction(state, value) } })), deliveries,
      replies: state.replies.map(value => ({ ...publicItem(copy(value)), eligibleAsDiscussionInput: !value.lateReasons.length && value.segmentId === state.gate.segmentId && !segment.stoppedAt })),
      exchanges, attachments: copy(state.attachments), timeline: copy(state.timeline) };
  }
  async wait(bindingId, { signal, requestId = id('wait') } = {}) {
    if (this.#closing) fail('CLOSED', 503);
    const binding = this.#binding(this.#state, bindingId); if (binding.agent !== 'claude') fail('INVALID_INPUT', 400); identifier(requestId);
    if (this.#waiters.has(bindingId)) fail('WAIT_ALREADY_ACTIVE');
    if (binding.notification) return { status: 'NOTICE_PENDING', notificationId: binding.notification.id, batchId: binding.notification.batchId };
    if (Date.parse(binding.deadlineAt) <= this.#clock()) return { status: 'TIMEOUT', deadlineAt: binding.deadlineAt };
    if (signal?.aborted) return { status: 'DISCONNECTED' };
    return new Promise(resolveWait => {
      let timer; let finished = false;
      const finish = value => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', disconnected); this.#waiters.delete(bindingId); this.#publish(); resolveWait(value); };
      const disconnected = () => finish({ status: 'DISCONNECTED' });
      const onDeadline = () => {
        const currentDeadline = Date.parse(this.#state.bindings[bindingId]?.deadlineAt);
        if (currentDeadline > this.#clock()) { timer = setTimeout(onDeadline, currentDeadline - this.#clock()); timer.unref?.(); return; }
        this.#tx(state => { const current = this.#binding(state, bindingId);
        if (Date.parse(current.deadlineAt) > this.#clock()) return { status: 'REARM_DEADLINE', deadlineAt: current.deadlineAt };
        current.batch = null; current.notification = null; current.drainNeedsWait = true;
        if (!current.expiredNotified) { current.expiredNotified = true; this.#system(state, 'wait_expired', { agent: 'claude', bindingId, leaseId: current.leaseId, deadlineAt: current.deadlineAt }); }
        return { status: 'TIMEOUT', deadlineAt: current.deadlineAt }; }).then(value => {
          if (value.status === 'REARM_DEADLINE' && !finished) { timer = setTimeout(onDeadline, Math.max(1, Date.parse(value.deadlineAt) - this.#clock())); timer.unref?.(); }
          else finish(value);
        }, () => finish({ status: 'RECOVERY_REQUIRED' }));
      };
      timer = setTimeout(onDeadline, Math.max(1, Date.parse(binding.deadlineAt) - this.#clock()));
      timer.unref?.(); signal?.addEventListener('abort', disconnected, { once: true });
      this.#waiters.set(bindingId, { requestId, finish }); this.#connections.set(bindingId, { available: true, at: this.#now() }); this.#publish();
    });
  }
  #kick() {
    if (this.#closed || this.#closing || this.#unsafe || this.#kickPending) return;
    this.#kickPending = true;
    queueMicrotask(() => {
      this.#kickPending = false;
      for (const [bindingId, waiter] of this.#waiters) {
        if (!this.#eligible(this.#state, bindingId) || this.#state.bindings[bindingId]?.notification || waiter.notifying) continue;
        waiter.notifying = true;
        this.#tx(state => {
          if (!this.#eligible(state, bindingId)) return null;
          const binding = this.#binding(state, bindingId); const batchId = id('batch');
          binding.batch = { id: batchId, count: 0 }; binding.notification = { id: id('notice'), batchId }; binding.drainNeedsWait = false;
          return { status: 'NEW', notificationId: binding.notification.id, batchId, deadlineAt: binding.deadlineAt };
        }).then(value => { waiter.notifying = false; if (value && this.#state.bindings[bindingId]?.notification?.id === value.notificationId && this.#eligible(this.#state, bindingId)) waiter.finish(value); }, () => waiter.finish({ status: 'RECOVERY_REQUIRED' }));
      }
      const bindingId = this.#state.currentBindings.codex;
      if (bindingId && this.#connections.get(bindingId)?.available && this.#transport && this.#eligible(this.#state, bindingId)) {
        this.#dispatchCodex(bindingId);
      }
    });
  }
  async read(bindingId, input = {}, write = () => {}) {
    if (this.#closing) fail('CLOSED', 503);
    fields(input, ['requestId', 'batchId', 'claimId']); const binding = this.#binding(this.#state, bindingId); if (binding.agent !== 'claude') fail('INVALID_INPUT', 400);
    identifier(input.requestId);
    const reservation = await this.#tx(state => {
      const current = this.#binding(state, bindingId); let delivery = this.#blocker(state, bindingId);
      current.readRequests ??= {};
      const clear = status => { current.notification = null; current.batch = null; current.drainNeedsWait = true; const result = { status, bindingId, deadlineAt: current.deadlineAt }; current.readRequests[input.requestId] = result; return result; };
      if (this.#segment(state).stoppedAt || this.#stopping.has(state.gate.segmentId)) return clear('PAUSED');
      const previous = own(current.readRequests, input.requestId);
      if (previous) {
        if (previous.status !== 'RESERVED') return previous;
        const previousDelivery = state.deliveries.find(value => value.id === previous.deliveryId);
        if (previousDelivery?.finalReplyId) return { status: 'COMPLETED', deliveryId: previousDelivery.id, replyId: previousDelivery.finalReplyId };
        if (!previousDelivery || previousDelivery.state === 'failed' || this.#blocked(state, previousDelivery) || previousDelivery.waitDisposition === 'abandoned') return { status: 'PAUSED', bindingId };
        return { ...previous, replay: true };
      }
      if (delivery) {
        if (this.#blocked(state, delivery)) return clear('PAUSED');
        if (input.claimId && input.claimId !== delivery.claimId) fail('DELIVERY_CHANGED');
        const result = { status: 'RESERVED', deliveryId: delivery.id, replay: true, batchId: current.batch?.id ?? null }; current.readRequests[input.requestId] = result; return result;
      }
      if (input.claimId) fail('DELIVERY_CHANGED');
      if (!current.batch && current.drainNeedsWait) return clear('BATCH_LIMIT');
      if (!current.batch) { current.batch = { id: id('batch'), count: 0 }; }
      if (input.batchId && input.batchId !== current.batch.id) fail('BATCH_INVALID');
      if (current.batch.count >= 3) return clear('BATCH_LIMIT');
      delivery = this.#eligible(state, bindingId); if (!delivery) return clear('EMPTY');
      current.notification = null; current.batch.count++;
      Object.assign(delivery, { claimId: id('claim'), state: 'dispatching', waitDisposition: 'waiting', waitingSince: this.#now(), _attempted: true }); delivery.version++;
      const result = { status: 'RESERVED', deliveryId: delivery.id, replay: false, batchId: current.batch.id }; current.readRequests[input.requestId] = result; return result;
    });
    if (reservation.status !== 'RESERVED') return reservation;
    let delivery = this.#state.deliveries.find(value => value.id === reservation.deliveryId);
    let attachments;
    try { attachments = await this.#attachmentPaths(delivery); }
    catch {
      await this.#tx(state => {
        const current = state.deliveries.find(value => value.id === delivery.id);
        if (!this.#written(current) && current.state !== 'stopped') {
          Object.assign(current, { state: 'failed', reason: 'DELIVERY_FAILED', waitDisposition: 'none', evidence: { kind: 'none', at: this.#now() } }); current.version++;
          if (current.exchangeId) this.#endExchange(state, current.exchangeId, 'failed');
        }
        return null;
      });
      fail('ATTACHMENT_UNAVAILABLE');
    }
    delivery = this.#state.deliveries.find(value => value.id === reservation.deliveryId);
    if (this.#blocked(this.#state, delivery) || delivery.waitDisposition === 'abandoned' || delivery.finalReplyId) {
      if (!this.#written(delivery)) await this.#tx(state => { const current = state.deliveries.find(value => value.id === delivery.id); if (!this.#written(current)) this.#cancel(current, 'STOPPED'); return null; });
      return { status: 'PAUSED', bindingId };
    }
    const result = { status: 'DELIVERY', deliveryId: delivery.id, claimId: delivery.claimId, bindingId, batchId: reservation.batchId,
      segmentId: delivery.segmentId, exchangeId: delivery.exchangeId, round: delivery.round, text: delivery._text,
      attachmentIds: copy(delivery._attachmentIds), attachments };
    // This assignment + synchronous write is the handoff boundary; no await here.
    this.#writesStarted.add(delivery.id);
    let uncertain = false;
    try { write(copy(result)); } catch { uncertain = true; }
    await this.#tx(state => {
      const current = state.deliveries.find(value => value.id === delivery.id); current._writeStarted = true;
      if (!current.finalReplyId && current.waitDisposition !== 'abandoned') {
        current.state = uncertain ? 'uncertain' : 'awaiting_reply'; current.reason = uncertain ? 'DELIVERY_UNCERTAIN' : null;
        current.evidence = { kind: uncertain ? 'unknown' : 'pull_handoff', at: this.#now() }; current.version++;
        if (uncertain && current.exchangeId) this.#endExchange(state, current.exchangeId, 'uncertain');
      }
      return null;
    });
    return result;
  }
  async #attachmentPaths(delivery) {
    const manifest = [];
    for (const attachmentId of delivery._attachmentIds) {
      const attachment = this.#state.attachments.find(value => value.id === attachmentId);
      if (!attachment) fail('ATTACHMENT_NOT_FOUND', 404);
      // The store verifies the complete file, even when returning only its first page.
      await readTextAttachment(this.#runtimeDir, attachment);
      manifest.push({ id: attachmentId, path: resolve(this.#runtimeDir, attachment.relativePath), sha256: attachment.sha256 });
    }
    return manifest;
  }
  postReply(bindingId, input) {
    if (this.#closing) fail('CLOSED', 503);
    fields(input, ['deliveryId', 'claimId', 'text', 'attachmentIds', 'done']); identifier(input.deliveryId);
    textInput(input.text, 4000000); if (typeof input.done !== 'boolean' && input.done !== undefined) fail('INVALID_INPUT', 400);
    const attachmentIds = input.attachmentIds ?? []; const done = input.done ?? false;
    return this.#tx(async state => {
      const binding = this.#binding(state, bindingId, false); const delivery = state.deliveries.find(value => value.id === input.deliveryId);
      if (!delivery || delivery.bindingId !== bindingId || !delivery._attempted || delivery.state === 'stopped') fail('DELIVERY_CHANGED');
      if (!this.#written(delivery) && delivery.state !== 'uncertain') fail('DELIVERY_CHANGED');
      if ((input.claimId ?? null) !== delivery.claimId) fail('DELIVERY_CHANGED');
      if (done && !delivery.exchangeId) fail('INVALID_INPUT', 400);
      this.#attachments(state, attachmentIds); if (!input.text.trim() && !attachmentIds.length) fail('INVALID_INPUT', 400);
      const fingerprint = hash({ text: input.text, attachmentIds, done });
      if (delivery.finalReplyId) { const existing = state.replies.find(value => value.id === delivery.finalReplyId); if (existing._fingerprint !== fingerprint) fail('FINAL_ALREADY_PRESENT'); return { replyId: existing.id, deliveryId: delivery.id, committedAt: existing.committedAt, duplicate: true, deadlineAt: binding.deadlineAt }; }
      const content = await this.#content(state, input.text);
      const lateReasons = [];
      if (this.#segment(state, delivery.segmentId)?.stoppedAt || this.#stopping.has(delivery.segmentId)) lateReasons.push('segment_stopped');
      if (delivery.waitDisposition === 'abandoned') lateReasons.push('wait_abandoned');
      if (delivery.exchangeId && state.exchanges.find(value => value.id === delivery.exchangeId)?.state !== 'active') lateReasons.push('exchange_ended');
      if (state.currentBindings[binding.agent] !== bindingId) lateReasons.push('binding_replaced');
      const reply = { id: id('reply'), deliveryId: delivery.id, agent: binding.agent, bindingId, segmentId: delivery.segmentId,
        exchangeId: delivery.exchangeId, round: delivery.round, committedAt: this.#now(), content, attachmentIds: copy(attachmentIds), done,
        lateReasons, _text: input.text, _fingerprint: fingerprint };
      state.replies.push(reply); delivery.finalReplyId = reply.id; delivery.state = 'replied'; delivery.version++;
      if (delivery.waitDisposition !== 'abandoned') delivery.waitDisposition = 'resolved';
      this.#timeline(state, 'reply', reply);
      if (binding.agent === 'claude' && state.currentBindings.claude === bindingId && !lateReasons.includes('wait_abandoned')) {
        binding.deadlineAt = new Date(Date.parse(reply.committedAt) + 36000000).toISOString(); binding.lastRenewedByReplyId = reply.id; binding.expiredNotified = false;
      }
      if (delivery.exchangeId) {
        const exchange = state.exchanges.find(value => value.id === delivery.exchangeId);
        const postedRound = exchange.rounds.find(value => value.number === delivery.round);
        postedRound.finalReplyIds[binding.agent] = reply.id;
        if (!lateReasons.length) postedRound.finishVotes[binding.agent] = done;
        if (!lateReasons.length && exchange.state === 'active') {
          const round = exchange.rounds.at(-1); const complete = AGENTS.every(agent => round.finalReplyIds[agent]);
          if (complete) exchange.completedRounds = round.number;
          if (exchange.finishPolicy === 'first_done' && done) this.#endExchange(state, exchange.id, 'done', binding.agent);
          else if (complete) {
            if (exchange.finishPolicy === 'both_same_round' && AGENTS.every(agent => round.finishVotes[agent] === true)) this.#endExchange(state, exchange.id, 'agreement');
            else if (exchange.currentRound === exchange.maxRounds) this.#endExchange(state, exchange.id, 'limit');
            else this.#round(state, exchange, round.finalReplyIds);
          }
        }
      }
      return { replyId: reply.id, deliveryId: delivery.id, committedAt: reply.committedAt, duplicate: false, deadlineAt: binding.deadlineAt };
    });
  }
  async readAttachment(attachmentId, cursor) {
    const attachment = this.#state.attachments.find(value => value.id === identifier(attachmentId)); if (!attachment) fail('ATTACHMENT_NOT_FOUND', 404);
    return readTextAttachment(this.#runtimeDir, attachment, cursor);
  }
  #dispatchCodex(bindingId) {
    if (this.#nativeTasks.size) return;
    const task = this.#sendCodex(bindingId).catch(() => {});
    this.#nativeTasks.add(task); task.finally(() => { this.#nativeTasks.delete(task); this.#kick(); });
  }
  async #sendCodex(bindingId) {
    const deliveryId = await this.#tx(state => {
      const delivery = this.#eligible(state, bindingId); if (!delivery) return null;
      delivery.state = 'dispatching'; delivery.waitDisposition = 'waiting'; delivery.waitingSince = this.#now(); delivery._attempted = true; delivery.version++; return delivery.id;
    });
    if (!deliveryId) return;
    const abort = new AbortController(); this.#sendContexts.set(deliveryId, abort);
    let wrote = false; let outcome = 'uncertain'; let timer;
    try {
      const delivery = this.#state.deliveries.find(value => value.id === deliveryId);
      const attachments = await this.#attachmentPaths(delivery);
      const beforeSend = () => {
        const current = this.#state.deliveries.find(value => value.id === deliveryId);
        if (wrote) fail('DUPLICATE_WRITE_BLOCKED');
        if (abort.signal.aborted || this.#blocked(this.#state, current) || current.state === 'stopped') fail('SEND_CANCELLED_BEFORE_WRITE');
        wrote = true; this.#writesStarted.add(current.id);
      };
      const response = await Promise.race([
        this.#transport.send({ ...publicItem(copy(delivery)), text: delivery._text, attachmentIds: copy(delivery._attachmentIds), attachments, origin: delivery.exchangeId ? 'claude' : 'human' }, { signal: abort.signal, beforeSend }),
        new Promise(resolveTimeout => { timer = setTimeout(() => { abort.abort(); resolveTimeout({ status: 'uncertain' }); }, this.#timeout); }),
      ]);
      outcome = ['sent', 'failed', 'uncertain'].includes(response?.status) ? response.status : 'uncertain';
      if (['NATIVE_UNAVAILABLE', 'DISCOVERY_UNAVAILABLE', 'NATIVE_PIPE_ERROR', 'NATIVE_PIPE_CLOSED', 'TARGET_MISMATCH', 'TIMEOUT', 'NATIVE_DELIVERY_UNCONFIRMED'].includes(response?.reason)) {
        this.#connections.set(bindingId, { available: false, at: this.#now() });
      }
      if (!wrote && this.#blocked(this.#state, delivery)) outcome = 'stopped';
      if (outcome === 'sent' && !wrote) outcome = 'uncertain';
    } catch { if (!wrote) outcome = this.#blocked(this.#state, this.#state.deliveries.find(value => value.id === deliveryId)) ? 'stopped' : 'failed'; }
    finally { clearTimeout(timer); abort.abort(); this.#sendContexts.delete(deliveryId); }
    await this.#tx(state => {
      const delivery = state.deliveries.find(value => value.id === deliveryId); delivery._writeStarted ||= wrote;
      if (!delivery.finalReplyId && delivery.waitDisposition !== 'abandoned') {
        if (outcome === 'stopped' || (delivery.state === 'stopped' && !wrote)) this.#cancel(delivery, 'STOPPED');
        else {
          delivery.state = outcome === 'sent' ? 'awaiting_reply' : outcome; delivery.reason = outcome === 'failed' ? 'DELIVERY_FAILED' : outcome === 'uncertain' ? 'DELIVERY_UNCERTAIN' : null;
          delivery.evidence = { kind: outcome === 'sent' ? 'native_accepted' : outcome === 'uncertain' ? 'unknown' : 'none', at: this.#now() }; delivery.version++;
          if (outcome === 'failed') delivery.waitDisposition = 'none';
          if (delivery.exchangeId && ['failed', 'uncertain'].includes(outcome)) this.#endExchange(state, delivery.exchangeId, outcome);
        }
      }
      return null;
    });
  }
  async close() {
    if (this.#closed) return;
    this.#closing = true; for (const controller of this.#sendContexts.values()) controller.abort();
    for (const waiter of [...this.#waiters.values()]) waiter.finish({ status: 'DISCONNECTED' });
    await Promise.allSettled([...this.#nativeTasks]); await this.#tail; this.#closed = true; await this.#store.close(); this.removeAllListeners();
  }
}
