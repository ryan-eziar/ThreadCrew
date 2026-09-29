/* Agent Chat window for BROKER_WINDOW_CONTRACT_V2 (rooms, pages, deltas, work sessions).
 * The broker decides what is allowed (actions/availability) and computes counts; the page maps
 * reasons to readable text, keeps bounded caches, and never renders server or agent text as HTML.
 * UI text goes through t() (ui/i18n.js): the Chinese string is the key, English lives there. */
(function () {
  'use strict';

  const I18N = window.AgentChatI18n || null;
  const t = I18N ? I18N.t : (zh, ...args) => zh.replace(/\{(\d+)\}/g, (m, k) => (args[k] == null ? '' : String(args[k])));
  const EN_UI = Boolean(I18N && I18N.lang === 'en');

  const AGENTS = ['codex', 'claude'];
  const PRODUCT = 'ThreadCrew';
  const REPO_URL = 'https://github.com/ryan-eziar/ThreadCrew';
  const NAMES = { codex: 'Codex', claude: 'Claude', system: t('系统') };
  // The person at this window ("ryan" stays the human role's internal ID): the display name from
  // the settings, or "You" when none is set.
  Object.defineProperty(NAMES, 'ryan', { enumerable: true, get: () => humanName() });
  const WINDOW = 300;          // entries in the DOM
  const CACHE = 500;           // entries kept per room when paging back
  const ROOM_VIEWS = 8;        // rooms kept in memory
  const ABANDON_SHOW_MIN = 5;
  const ABANDON_STRESS_MIN = 30;
  const BACKOFF_S = [1, 2, 4, 8, 15];
  // Work budgets: [requests, wake-ups], ceilings rather than targets. A request round trip wakes two
  // sessions (the request, then its answer), so wake-ups get twice the requests: the first real
  // work session used 10 requests and 18 wake-ups, and wake-ups ran out first.
  const PRESETS = { small: [12, 24, t('小')], standard: [24, 48, t('标准')], large: [48, 96, t('大')] };
  const BUDGET_STEP = { requests: 12, wakes: 24 }; // one "+" in the header or the work popover
  // Files the broker accepts, by extension; it checks the type against the name and the content.
  const UPLOAD_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf',
    txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json' };
  const UPLOAD_ACCEPT = Object.keys(UPLOAD_TYPES).map((x) => `.${x}`).join(',');
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const MAX_ATTACHMENTS = 20;
  const MD = window.AgentChatMarkdown || null;
  const boot = window.__AGENT_CHAT__;
  const src = window.AgentChatSourceV2.create(boot);
  const capabilities = boot.capabilities || {};

  // ---- Small helpers ------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const codePoints = (s) => [...s].length;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'op-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
    sget(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } },
    sset(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }
  // replaceChildren() prints a null child as the text "null" (it happened three times): every
  // re-fill of an element goes through here, which drops empty children.
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const link = (label, onclick, attrs = {}) => h('button', { class: 'link', type: 'button', onclick, ...attrs }, label);
  // A small bordered action button; `danger` for actions that cancel or remove something.
  const btn = (label, onclick, attrs = {}) => {
    const { danger, ...rest } = attrs;
    return h('button', { type: 'button', class: `btn${danger ? ' danger' : ''}`, onclick, ...rest }, label);
  };

  // Line icons on a 24×24 grid, drawn with the DOM like everything else (no markup strings).
  const ICONS = {
    send: ['M12 19V5', 'M5.5 11.5 12 5l6.5 6.5'],
    plus: ['M12 5v14', 'M5 12h14'],
    check: ['M5 12.5 10 17.5 19.5 7'],
    x: ['M6 6l12 12', 'M18 6 6 18'],
    chevronDown: ['M6 9l6 6 6-6'],
    chevronRight: ['M9 6l6 6-6 6'],
    chevronLeft: ['M15 6l-6 6 6 6'],
    zap: ['M13 2 4.5 13.5H12L11 22l8.5-11.5H12L13 2z'],
    chat: ['M4 5.5h16v10.5H11l-4.5 3.5V16H4z', 'M8 9.5h8', 'M8 12.5h5'],
    power: ['M12 3v8', 'M7 6.2a7 7 0 1 0 10 0'],
    archive: ['M3.5 5.5h17v4h-17z', 'M5 9.5V19h14V9.5', 'M10 13h4'],
    bell: ['M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z', 'M10 20.5a2 2 0 0 0 4 0'],
    copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
    menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
    toTop: ['M5 4.5h14', 'M12 20V9', 'M7 13.5l5-5 5 5'],
    toLatest: ['M5 19.5h14', 'M12 4v11', 'M7 10.5l5 5 5-5'],
    list: ['M9.5 6.5h10', 'M9.5 12h10', 'M9.5 17.5h10', 'M4.5 6.5h.01', 'M4.5 12h.01', 'M4.5 17.5h.01'],
    settings: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'],
    search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20.5 20.5 16 16'],
    clip: ['M20 11.5 12.5 19a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.8 1.8 0 0 1-2.5-2.5l7.2-7.2'],
    download: ['M4 15v4.5h16V15', 'M12 4v11', 'M7.5 10.5 12 15l4.5-4.5'],
    file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
    note: ['M5 4h14v16H5z', 'M8.5 9h7', 'M8.5 13h7', 'M8.5 17h4'],
    sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2.5v2', 'M12 19.5v2', 'M4.6 4.6l1.4 1.4', 'M18 18l1.4 1.4', 'M2.5 12h2', 'M19.5 12h2', 'M4.6 19.4 6 18', 'M18 6l1.4-1.4'],
    moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  };
  function icon(name, size = 16) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `icon icon-${name}` })) svg.setAttribute(k, String(v));
    if (name === 'stop') {
      const r = document.createElementNS(NS, 'rect');
      for (const [k, v] of Object.entries({ x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.5, fill: 'currentColor', stroke: 'none' })) r.setAttribute(k, String(v));
      svg.append(r);
      return svg;
    }
    for (const d of ICONS[name]) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }
  const AVATAR = { codex: '>_', claude: '✳' };
  const avatar = (agent, size = '') => h('span', { class: `av av-${agent}${size ? ` av-${size}` : ''}`, 'aria-hidden': 'true' }, AVATAR[agent]);

  function mediaTypeFor(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    return m ? UPLOAD_TYPES[m[1].toLowerCase()] || null : null;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  // Rooms get a lettered tile in one of six soft colours, stable per name.
  const roomHue = (name) => { let n = 0; for (const ch of String(name)) n = (n * 31 + ch.codePointAt(0)) >>> 0; return n % 6; };
  const roomInitial = (name) => ([...String(name).trim()][0] || '#').toUpperCase();

  // One-line summary: Markdown markers and line breaks removed.
  const snippet = (raw, n = 14) => {
    const s = String(raw || '')
      .replace(/```[^\n]*\n?/g, ' ')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/gm, '')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return codePoints(s) > n ? `${[...s].slice(0, n).join('')}…` : s;
  };

  let clockOffset = 0;
  const serverNow = () => Date.now() + clockOffset;
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === new Date(serverNow()).toDateString() ? hm : `${monthDay(d)} ${hm}`;
  }
  const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthDay = (d) => (EN_UI ? `${EN_MONTHS[d.getMonth()]} ${d.getDate()}` : `${d.getMonth() + 1}月${d.getDate()}日`);
  // Day labels for the sidebar and the timeline separators.
  function dayOffset(iso) {
    const d = new Date(iso);
    const today = new Date(serverNow());
    const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.round((b - a) / 86400000);
  }
  function fmtShort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const off = dayOffset(iso);
    if (off === 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (off === 1) return t('昨天');
    return monthDay(d);
  }
  function dayLabel(iso) {
    const d = new Date(iso);
    const off = dayOffset(iso);
    if (off === 0) return t('今天');
    if (off === 1) return t('昨天');
    if (EN_UI) {
      return d.getFullYear() === new Date(serverNow()).getFullYear() ? `${EN_DAYS[d.getDay()]}, ${monthDay(d)}` : `${monthDay(d)}, ${d.getFullYear()}`;
    }
    const week = `周${'日一二三四五六'[d.getDay()]}`;
    return d.getFullYear() === new Date(serverNow()).getFullYear() ? `${monthDay(d)} ${week}` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }
  const minutesSince = (iso) => Math.max(0, Math.floor((serverNow() - Date.parse(iso)) / 60000));
  function timeLeft(iso) {
    const m = Math.floor((Date.parse(iso) - serverNow()) / 60000);
    if (m <= 0) return t('已到期');
    return m >= 60 ? t('剩 {0} 小时 {1} 分', Math.floor(m / 60), m % 60) : t('剩 {0} 分钟', m);
  }

  // ---- Wording ------------------------------------------------------------------------

  const ERROR_TEXT = {
    INVALID_INPUT: t('请求格式不对，已保留输入。'), UNKNOWN_FIELD: t('请求格式不对，已保留输入。'),
    AUTH_REQUIRED: t('凭证失效：请重新载入页面。'), FORBIDDEN: t('凭证失效：请重新载入页面。'),
    NOT_FOUND: t('找不到这个对象，已刷新。'), ITEM_NOT_FOUND: t('找不到这条记录。'), ATTACHMENT_NOT_FOUND: t('附件不存在。'),
    ID_CONFLICT: t('同一个操作 ID 的内容不一致，已停止重试。'),
    STATE_CONFLICT: t('状态已变化，请确认后再操作。'), GATE_CHANGED: t('状态已变化，请确认后再操作。'),
    DELIVERY_CHANGED: t('状态已变化，请确认后再操作。'), ROOM_CHANGED: t('群的信息刚变过，请确认后再操作。'),
    BINDING_CHANGED: t('成员刚变过，请确认后再操作。'), WORK_CHANGED: t('任务状态刚变过，请确认后再操作。'),
    FINAL_ALREADY_PRESENT: t('对方已经回复，不需要再操作。'),
    MEMBER_NOT_READY: t('有成员还不能接收。'), EXCHANGE_ACTIVE: t('已有讨论进行中。'),
    BASE_REPLY_INVALID: t('这两份回复不能用来讨论，请看最新状态。'), ROOM_STOPPED: t('已停止：先发一条新消息。'),
    KICKOFF_MESSAGE: t('开工消息的回复是接单，不用讨论。'),
    UPDATE_BUSY: t('还有没完成的消息或任务，现在不能更新。'), UPDATE_VERSION_CHANGED: t('这期间又有了更新的版本，请重新检查。'),
    UPDATE_UNSUPPORTED: t('这份 ThreadCrew 不能自动更新。'), UPDATE_IN_PROGRESS: t('已经在更新了。'),
    UPDATE_CHECK_FAILED: t('没能连上 GitHub 检查更新。'), UPDATE_CHECKSUM_FAILED: t('下载的文件和校验值对不上，没有安装。'),
    UPDATE_LOCAL_CHANGES: t('ThreadCrew 的文件在这台电脑上被改动过，更新不会覆盖它们。'),
    UPDATE_PACKAGE_INVALID: t('版本包不完整或不对，没有安装。'), UPDATE_INSTALL_FAILED: t('安装新版本时出错。'),
    UPDATE_RESTART_FAILED: t('新版本没能启动。'), UPDATE_ROLLBACK_FAILED: t('新版本没能启动，退回原来的版本也没有完全成功。'),
    UPDATE_INTERRUPTED: t('更新过程被中断了。'),
    UPDATE_STATE_UNREADABLE: t('读不到更新记录。'),
    ROOM_ARCHIVED: t('这个群已归档，不能再收发。'), WORK_IN_PROGRESS: t('本群已有进行中的任务。'),
    WORK_MUST_BE_STOPPED_FIRST: t('先停止本群，才能解除这项任务。'), WORK_NOT_ACTIVE: t('这项任务已经不在进行中。'),
    DUPLICATE_ACK_REQUIRED: t('需要先确认可能重复。'), ATTACHMENT_CHANGED: t('附件被改动过，已停止读取。'),
    CONTENT_TOO_LARGE: t('内容太长（上限 32,000 字），已保留输入。'), RESPONSE_TOO_LARGE: t('返回内容过大，请缩小范围。'),
    JOURNAL_UNSAFE: t('broker 需要恢复，所有操作已暂停。'), RECOVERY_REQUIRED: t('broker 需要恢复，所有操作已暂停。'),
    CLOSED: t('broker 正在关闭。'), NETWORK: t('连接中断。'), VERSION_MISMATCH: t('页面和 broker 版本不一致，请重新载入。'),
    UNCONFIRMED: t('结果待确认。'), INVALID_CURSOR: t('翻页位置已失效，已重新加载。'),
    VERSION_CONFLICT: t('已在别处修改，已刷新。'),
  };
  const errorText = (code) => ERROR_TEXT[code] || t('操作没有完成（{0}）。', code);

  function reasonText(code, agent) {
    const who = agent ? NAMES[agent] : t('有成员');
    const map = {
      NO_PENDING_WORK: t('现在没有进行中的消息或讨论'), NO_BINDING: t('{0} 未进群', who), NO_CONNECTION: t('{0} 连接断开', who),
      WAITER_UNARMED: t('{0} 未待命', who), WAIT_EXPIRED: t('{0} 等待到期', who), AWAITING_REPLY: t('{0} 在回复上一条', who),
      NATIVE_BUSY: t('{0} 正在忙', who), MEMBER_NOT_READY: t('{0} 还不能接收', who), ALREADY_ABANDONED: t('已放弃等待'),
      FINAL_ALREADY_PRESENT: t('已回复'), ROOM_STOPPED: t('已停止：先发一条新消息'), EXCHANGE_ACTIVE: t('已有讨论进行中'),
      BASE_REPLY_INVALID: t('这两份回复不能用来讨论'), INCOMPLETE_PAIR: t('还没有完整的两份回复'), KICKOFF_MESSAGE: t('开工消息不用讨论'),
      RECOVERY_REQUIRED: t('broker 需要恢复'), JOURNAL_UNSAFE: t('broker 需要恢复'), ROOM_OPEN: t('群没有归档'),
      ROOM_ARCHIVED: t('群已归档'), WORK_IN_PROGRESS: t('本群已有进行中的任务'), WORK_MUST_BE_STOPPED_FIRST: t('先停止本群'),
      WORK_ACTIVE: t('有进行中的协作任务，先停止本群'), ACTIVE_WORK: t('有进行中的协作任务，先停止本群'),
      WORK_NOT_ACTIVE: t('任务不在进行中'), NO_MEMBER: t('席位是空的'),
    };
    return map[code] || t('暂时不可用');
  }

  function memberView(m) {
    if (!m) return { text: t('未进群'), tone: 'off' };
    const claudeArmed = m.route === 'claude-pull' && m.wait && m.wait.state === 'armed';
    switch (m.state) {
      case 'unbound': return { text: t('未进群'), tone: 'off' };
      case 'ready': return claudeArmed ? { text: t('待命至 {0}', fmtTime(m.wait.deadlineAt)), short: t('待命'), tone: 'ok' } : { text: t('已连接'), tone: 'ok' };
      case 'notified': return { text: t('已通知 · 等它来取'), short: t('已通知'), tone: 'busy' };
      case 'busy':
        if (claudeArmed || m.canReceiveCollaboration) return { text: t('工作中 · 收件已接通'), short: t('工作中'), tone: 'busy' };
        return { text: t('处理中'), tone: 'busy' };
      case 'unarmed': return { text: t('未待命'), tone: 'off' };
      case 'expired': return { text: t('等待到期'), tone: 'off' };
      case 'disconnected': return { text: t('连接断开'), tone: 'bad' };
      case 'recovery_required':
        if (m.reason === 'DELIVERY_UNCERTAIN') return { text: t('待确认 · 上一条不确定是否送到'), short: t('待确认'), tone: 'warn' };
        return { text: t('需要恢复'), tone: 'bad' };
      default: return { text: String(m.state), tone: 'off' };
    }
  }

  // ---- Reconnecting a member ------------------------------------------------------------------------
  // A member with a seat in the room who can't receive right now, so its own native session has to
  // reconnect: Claude's wait ended (the app or the computer restarted, or its wait ran out), or Codex's
  // connection is gone. Offered only when the broker says so with reconnectHint (an open, healthy room
  // that isn't stopped, and a broker that knows --reconnect). busy, notified and recovery_required keep
  // their own meaning.
  const RECONNECT_STATES = ['unarmed', 'expired', 'disconnected'];
  const RECONNECT_GRACE_MS = 45000;
  function needsReconnect(m) {
    return Boolean(m && m.binding && m.reconnectHint && RECONNECT_STATES.includes(m.state));
  }
  // One seat as this window sees it: a broker restart or a replaced binding is a new seat.
  const memberKey = (c, m) => `${c.instanceId}:${c.room.id}:${m.binding ? m.binding.id : m.agent}`;

  // Whether to tell the person that a member of the open room needs reconnecting. Only the room they are
  // in is checked, so dozens of rooms never raise dozens of warnings. A seat is observed from the first
  // current snapshot after entering the room (`fresh`): unavailable then is shown at once, the usual case
  // after a restart; available first and unavailable later waits RECONNECT_GRACE_MS, so the gap between
  // two of Claude's turns never flashes a warning. A drop seen live sends one desktop notification.
  // "Back" is said only when the same seat receives again (armed, or already notified); a warning that
  // goes away for any other reason (stop, archive, busy, a removed seat) goes quietly.
  function offlineDue(key, m, fresh, now = Date.now()) {
    const offline = needsReconnect(m);
    let seen = st.offline.get(key);
    if (!seen) {
      if (!fresh) return false;
      seen = { since: offline ? now : null, immediate: offline, shown: false };
      st.offline.set(key, seen);
    } else if (!offline) {
      if (seen.shown && ['ready', 'notified'].includes(m.state)) flash(t('{0} 已重新连上。', NAMES[m.agent]));
      Object.assign(seen, { since: null, immediate: false, shown: false });
      return false;
    } else if (seen.since === null) {
      seen.since = now;
      clearTimeout(st.offlineTimer);
      st.offlineTimer = setTimeout(() => render({ keepAnchor: true }), RECONNECT_GRACE_MS + 250);
    }
    const due = offline && (seen.immediate || now - seen.since >= RECONNECT_GRACE_MS);
    if (due && !seen.shown) {
      seen.shown = true;
      if (!seen.immediate) {
        showNotice({ id: `reconnect:${key}:${seen.since}`, roomId: st.currentRoomId, kind: 'reconnect', agent: m.agent,
          previewText: t('发给 {0} 的消息会先保存。打开它原来的会话，贴入重连口令。', NAMES[m.agent]) });
      }
    }
    return due;
  }
  // The same answer for the open room without changing anything (labels, the member panel).
  function dueNow(agent) {
    const c = control();
    const m = c && c.members.find((x) => x.agent === agent);
    const seen = m && st.offline.get(memberKey(c, m));
    return Boolean(seen && seen.since !== null && needsReconnect(m) && (seen.immediate || Date.now() - seen.since >= RECONNECT_GRACE_MS));
  }
  // The open room's control is known to be current: loaded or changed since entering the room, or its
  // stream has been live for a moment (changes missed while away are replayed first).
  function roomFresh() {
    const v = view();
    return Boolean(v && ((v.freshAt || 0) >= st.roomEnteredAt || (st.conn.room === 'live' && Date.now() - st.roomLiveAt >= 1500)));
  }

  function reconnectView(m) {
    return { text: t('{0} · 需要重新连接', memberView(m).text), short: t('需重连'), tone: m.state === 'disconnected' ? 'bad' : 'warn' };
  }

  // What the person pastes into the member's original session, built from the broker's reconnectHint.
  // It reconnects that exact seat (--reconnect: the same binding, native session and gate, never a new
  // or replaced seat); Claude also renews its receiving lease if it ran out. The agent checks its own
  // session ID first. The room name stays in the sentence, never in the command.
  function reconnectLine(m) {
    const hint = m.reconnectHint;
    const quote = (p) => `"${p}"`;
    const cmd = [`node ${quote(hint.helperPath)} join`, `--room ${hint.roomId}`, `--as ${m.agent}`,
      `--session ${t('<你当前原生会话的 ID>')}`, `--expected-binding ${hint.expectedBindingId}`, `--gate-segment ${hint.expectedGate.segmentId}`,
      `--gate-version ${hint.expectedGate.version}`, hint.runtimeDir ? `--runtime-dir ${quote(hint.runtimeDir)}` : null,
      '--reconnect', hint.renew ? '--renew' : null].filter(Boolean).join(' ');
    // The command sits on a line of its own, so no punctuation around it can end up in the shell.
    return t('请重新连接群「{0}」（room: {1}）。先读 {2}。然后核对你当前原生会话的 ID 是否为 {3}：不是就停下并告诉我，不要拿这个 ID 冒充。核对无误后，在 --session 后面填你的会话 ID，运行下面这行：\n{4}\n再按协议重新开始收消息。如果提示 GATE_CHANGED 或 BINDING_CHANGED，请让我重新复制。',
      hint.roomName, hint.roomId, hint.protocolPath || 'docs/AGENT_PROTOCOL.md', hint.expectedNativeSessionId, cmd);
  }

  // For a seated member that lost track of what it owes (after compacting its context, say): the
  // broker's recoveryHint exists only while that seat has an exact unanswered delivery. The line runs
  // the read-only resume helper for that exact binding, which lists what is still unanswered; the
  // agent checks its own session ID first. Nothing is sent or answered on its behalf.
  function resumeLine(m, roomName) {
    const hint = m.recoveryHint;
    const quote = (p) => `"${p}"`;
    const cmd = [`node ${quote(hint.helperPath)} resume`, `--room ${hint.roomId}`, `--as ${m.agent}`, `--binding ${hint.bindingId}`,
      hint.runtimeDir ? `--runtime-dir ${quote(hint.runtimeDir)}` : null].filter(Boolean).join(' ');
    return t('群「{0}」（room: {1}）里还有发给你的消息没有回复。先核对你当前原生会话的 ID 是否为 {2}：不是就停下并告诉我，不要拿这个 ID 冒充。核对无误后运行下面这行，它会列出还没回复的消息：\n{3}\n然后按协议逐条回复。',
      roomName, hint.roomId, hint.nativeSessionId, cmd);
  }

  function memberBlockText(m, short, due = false) {
    const name = NAMES[m.agent];
    if (due) return short ? t('{0} 需重连', name) : t('{0} 需要重新连接：消息先保存，连上后再送达', name);
    if (m.state === 'busy') return short ? t('{0} 在回复上一条', name) : t('{0} 在回复上一条，新消息会排队', name);
    if (m.state === 'recovery_required' && m.reason === 'DELIVERY_UNCERTAIN') {
      return short ? t('{0} 上一条不确定是否送到', name) : t('{0} 上一条不确定是否送到：先在那条消息下选“不再等待”或“重新发送”，新消息会先保存', name);
    }
    return short ? `${name} ${memberView(m).text}` : t('{0} {1}：消息先保存，它进群待命后才送达', name, memberView(m).text);
  }

  function deliveryView(d) {
    const name = NAMES[d.agent];
    if (d.waitDisposition === 'abandoned') return { text: d.finalReplyId ? t('已放弃等待 · 后有回复') : t('已放弃等待'), tone: 'off' };
    switch (d.state) {
      case 'pending_binding': return { text: t('未进群，已保存'), tone: 'off' };
      case 'queued':
        if (d.reason === 'BLOCKED_BY_DELIVERY') return { text: d.blockedByStoppedSegment ? t('排队中 · {0} 在回复停止前的消息', name) : t('排队中 · {0} 在回复上一条', name), tone: 'pending' };
        if (['WAITER_UNARMED', 'WAIT_EXPIRED', 'NO_CONNECTION'].includes(d.reason)) {
          return dueNow(d.agent) ? { text: t('等重新连接'), tone: 'warn' } : { text: t('未待命，已保存'), tone: 'off' };
        }
        return { text: t('排队中'), tone: 'pending' };
      case 'dispatching': return { text: t('正在交付'), tone: 'pending' };
      case 'awaiting_reply': {
        const kind = d.evidence && d.evidence.kind;
        return { text: kind === 'pull_handoff' ? t('已领取 · 待回复') : kind === 'native_accepted' ? t('已送达 · 待回复') : t('待回复'), tone: 'pending' };
      }
      case 'replied': return { text: t('已回复'), tone: 'ok' };
      case 'uncertain': return { text: t('不确定是否送到'), tone: 'warn' };
      case 'failed': return { text: t('发送失败'), tone: 'bad' };
      case 'stopped':
        if (d.reason === 'EXCHANGE_ENDED') return { text: t('已取消 · 讨论结束'), tone: 'off' };
        if (d.reason === 'BINDING_CHANGED' || d.reason === 'MEMBER_LEFT') return { text: t('已取消 · 成员变了'), tone: 'off' };
        if (d.reason === 'ROOM_ARCHIVED') return { text: t('已取消 · 群已归档'), tone: 'off' };
        return { text: t('已停止'), tone: 'off' };
      default: return { text: String(d.state), tone: 'off' };
    }
  }

  const LATE = [
    ['segment_stopped', t('停止后返回')], ['room_archived', t('归档后返回')], ['wait_abandoned', t('放弃等待后返回')],
    ['exchange_ended', t('讨论结束后返回')], ['binding_replaced', t('旧会话返回')], ['binding_left', t('移出后返回')],
  ];
  const WORK_LATE = { stopped: t('停止后返回'), expired: t('到期后返回'), binding_changed: t('成员变了后返回'), abandoned: t('放弃等待后返回') };

  function exchangeEndText(ex) {
    const c = ex.completedRounds;
    const n = ex.maxRounds;
    switch (ex.endReason) {
      case 'limit': return t('已达到讨论上限（{0}/{1} 轮）', n, n);
      case 'agreement': return t('双方均表示无需继续，提前结束（{0}/{1} 轮）', c, n);
      case 'done': return t('讨论结束：{0} 表示没有更多意见（{1}/{2} 轮）', NAMES[ex.doneBy] || t('一方'), c, n);
      case 'stop': return t('讨论随停止结束（{0}/{1} 轮）', c, n);
      case 'abandoned': return t('讨论结束：放弃等待回复（{0}/{1} 轮）', c, n);
      case 'failed': return t('讨论结束：有一条没送出去（{0}/{1} 轮）', c, n);
      case 'uncertain': return t('讨论结束：有一条不确定是否送到（{0}/{1} 轮）', c, n);
      case 'binding_changed': return t('讨论结束：有成员换了会话（{0}/{1} 轮）', c, n);
      case 'room_archived': return t('讨论随归档结束（{0}/{1} 轮）', c, n);
      default: return t('讨论结束');
    }
  }

  const WORK_STATE = {
    not_started: t('未开始'), working: t('工作中'), awaiting_review: t('等审查'), blocked: t('卡住了'),
    completed: t('已完成'), stopped: t('已停下'), unknown: t('状态未知'),
  };
  const COORDINATION = {
    active: t('协作进行中'), paused_budget: t('额度用完，已暂停'), stopped: t('已停止'), expired: t('已到期'),
    completed: t('已完成'), recovery_required: t('需要恢复'),
  };
  const REQUEST_KIND = { handoff: t('交接'), review_request: t('审查请求'), blocker: t('阻塞求助') };
  function requestStateView(w) {
    if (w.waitDisposition === 'abandoned') return { text: t('已放弃等待'), tone: 'off' };
    switch (w.requestState) {
      case 'queued': return { text: t('排队中，等对方检查点'), tone: 'pending' };
      case 'notified': return { text: t('已通知对方'), tone: 'pending' };
      case 'claimed': return { text: t('对方已领取'), tone: 'pending' };
      case 'awaiting_response': return { text: w.receivedAt ? t('对方已接收 · 待答复') : t('已交给原生应用 · 待答复'), tone: 'pending' };
      case 'answered': return { text: t('已答复'), tone: 'ok' };
      case 'uncertain': return { text: t('不确定是否送到'), tone: 'warn' };
      case 'failed': return { text: t('发送失败'), tone: 'bad' };
      case 'cancelled': return { text: t('已取消'), tone: 'off' };
      default: return { text: String(w.requestState || ''), tone: 'off' };
    }
  }
  const RESPONSE_DELIVERY = {
    queued: [t('答复排队中'), 'pending'], notified: [t('已通知请求方'), 'pending'], claimed: [t('请求方已领取'), 'pending'],
    received: [t('请求方已接收'), 'ok'], failed: [t('答复没送到'), 'bad'], uncertain: [t('答复不确定是否送到'), 'warn'],
    cancelled: [t('答复已取消'), 'off'],
  };
  const ATTENTION = {
    uncertain: t('不确定是否送到'), failed: t('发送失败'), member_unready: t('成员未进群，消息在排队'), stuck: t('等太久没回复'),
    work_budget: t('协作额度用完'), work_expired: t('协作任务到期'), work_blocked: t('有人卡住了'), abandoned_late: t('放弃后又回来了'),
  };

  // ---- State --------------------------------------------------------------------------

  const st = {
    catalog: { rooms: new Map(), revision: null, cursor: null, nextCursor: null, totals: { unreadReplyCount: 0, needsAttentionCount: 0 } },
    archived: null,            // { rooms: [], nextCursor } when the archived list is open
    sidebarMode: 'rooms',      // 'rooms' | 'archived'
    archivedFilter: '',
    currentRoomId: null,
    openGen: 0,
    views: new Map(),          // roomId -> view (LRU order)
    conn: { catalog: 'connecting', room: 'idle' },
    ops: new Map(),            // key -> { state, path, body, error, onDone }
    notice: null,
    expanded: new Map(),       // attachmentId -> { status, text, capped, error, roomId, entryId }
    raw: new Set(),
    copied: null,
    downloading: new Set(),
    panel: null,               // { kind: 'member', agent } | { kind: 'room' } | { kind: 'attention' }
    attention: null,           // a later attention page of the current room: { roomId, back, cursor, items, nextCursor }
    mention: null,             // open @ menu: { start, query, items, active }
    jumping: false,            // walking back to the start of the conversation
    sidebarOpen: false,
    composer: { to: new Set(AGENTS), toTouched: false, composing: false, compositionEndedAt: 0, work: false, preset: 'standard', hours: 10, stopGuardUntil: 0, discussOpen: false, discussTarget: null },
    rounds: 3,
    settings: { version: null, displayName: '' }, // from GET /settings; settingsOk false when the broker has none
    settingsOk: null,
    diagnostics: null,
    notes: null,               // the open room's notes: { roomId, status: 'loading'|'ready'|'unsupported'|'error', data }
    search: { roomId: null, q: '', items: [], nextCursor: null, status: 'idle' },
    exporting: null,           // room ID while its Markdown export downloads
    notify: { enabled: store.get('agentchat.notify') === 'on', seen: new Set(JSON.parse(store.sget('agentchat.notices') || '[]')) },
    offline: new Map(),        // `${roomId}:${agent}` -> { since, shown, atOpen }: open room's members needing a reconnect (offlineDue)
    roomEnteredAt: 0,          // when the open room was entered (roomFresh)
    roomLiveAt: 0,             // when the open room's stream last went live (roomFresh)
    offlineTimer: null,        // re-render when a live drop's grace period ends
    updates: null,             // the broker's UpdateState (GET /updates), when it can update
    updateChecking: false,     // this window's explicit check is in flight
    updateFollow: null,        // an install this window follows: { operationId, version, phase, own, lost, errorCode, polling }
    updateBox: null,           // the Updates section of an open Settings dialog
  };
  let catalogStream = null;
  let roomStream = null;
  let roomStreamGen = 0;

  const view = () => (st.currentRoomId ? st.views.get(st.currentRoomId) : null);
  // Memory counters for browser checks (open the page with #debug). Counts only, no content or token.
  if (location.hash === '#debug') {
    window.agentChatStats = () => {
      const v = view();
      let expandedChars = 0;
      for (const e of st.expanded.values()) expandedChars += e.text ? e.text.length : 0;
      return {
        roomViews: st.views.size, entries: v ? v.entries.size : 0, cachedNodes: v ? v.cache.size : 0,
        window: v ? [v.win.start, v.win.end] : null, headTrimmed: v ? v.headTrimmed : null, detached: v ? v.detached : null,
        stick: v ? v.stick : null, sorted: v ? v.sorted.length : 0,
        orders: v && v.sorted.length ? [v.sorted[0].order, v.sorted[v.sorted.length - 1].order] : null,
        gaps: v ? v.sorted.filter((e, i) => i > 0 && e.order !== v.sorted[i - 1].order + 1).length : 0,
        expanded: st.expanded.size, expandedChars, raw: st.raw.size, attentionPage: st.attention ? st.attention.back.length + 1 : 1,
      };
    };
  }
  // Expanded full texts: one reply shows at most EXPANDED_ITEM_CHARS (copy and download still read
  // and check the whole text), so evicting older ones always brings the total back under the cap.
  const EXPANDED_ENTRIES = 20;
  const EXPANDED_CHARS = 2000000;
  const EXPANDED_ITEM_CHARS = 200000;
  function dropExpanded(key) {
    const e = st.expanded.get(key);
    if (!e) return;
    st.expanded.delete(key);
    const v = st.views.get(e.roomId);
    if (v && e.entryId) v.cache.delete(e.entryId); // the cached node still holds the rendered text
  }
  function setExpanded(id, value) {
    st.expanded.delete(id);
    st.expanded.set(id, { ...value, roomId: value.roomId || st.currentRoomId });
    let total = 0;
    for (const e of st.expanded.values()) total += e.text ? e.text.length : 0;
    for (const [key, e] of [...st.expanded]) {
      if (st.expanded.size <= EXPANDED_ENTRIES && total <= EXPANDED_CHARS) break;
      if (key === id) continue;
      total -= e.text ? e.text.length : 0;
      dropExpanded(key);
    }
  }
  // Entries leaving a room's cache take their per-entry view state with them.
  function forgetEntries(v, entries) {
    const ids = new Set();
    for (const e of entries) {
      ids.add(e.id);
      if (e.message) ids.add(e.message.id);
      if (e.reply) ids.add(e.reply.id);
    }
    for (const id of ids) st.raw.delete(id);
    for (const [key, x] of [...st.expanded]) if (x.roomId === v.roomId && ids.has(x.entryId)) st.expanded.delete(key);
  }
  const control = () => (view() ? view().control : null);
  const connected = () => st.conn.catalog === 'live' || st.conn.catalog === 'polling';
  const writable = () => connected() && control() && control().room.health === 'ok';

  function newView(roomId) {
    return {
      roomId, control: null, entries: new Map(), sorted: [], revision: null, eventCursor: null,
      nextBeforeCursor: null, nextAfterCursor: null, detached: false, win: { start: 0, end: 0 },
      newCount: 0, draft: '', scrollTop: null, stick: true, cache: new Map(), loading: false, readPosted: 0, headTrimmed: false,
      unreadFrom: null, // the read position when the room was opened with unread replies: the "new messages" line
      unreadLoc: null, // the broker's first-unread locator at that opening: { timelineItemId, timelineOrder, aroundCursor }
      unreadLanding: null, // { state } until the view has landed on the first unread (landUnread)
      readSending: 0, // a read position sent and not yet answered
      attach: [], // files for the next message: { key, name, bytes, mediaType, file, state, id, error, opId, preview }
      epoch: 0, resyncing: false,
    };
  }

  function touchView(roomId) {
    let v = st.views.get(roomId);
    if (v) st.views.delete(roomId);
    else v = newView(roomId);
    st.views.set(roomId, v);
    while (st.views.size > ROOM_VIEWS) {
      const oldest = st.views.keys().next().value;
      if (oldest === st.currentRoomId) break;
      forgetEntries(st.views.get(oldest), st.views.get(oldest).entries.values());
      st.views.delete(oldest);
      for (const [key, e] of [...st.expanded]) if (e.roomId === oldest) st.expanded.delete(key);
    }
    return v;
  }

  // ---- Operations (idempotent by operation ID; a lost response is looked up, never re-created) --

  function flash(text, tone = 'info') {
    st.notice = { text, tone };
    render();
    const current = st.notice;
    setTimeout(() => { if (st.notice === current) { st.notice = null; render(); } }, 8000);
  }

  async function confirmOutcome(operationId) {
    for (const seconds of [1, 2, 4]) {
      await sleep(seconds * 1000);
      const q = await src.operation(operationId);
      if (!q.ok) continue;
      if (q.result.status === 'committed') return { ok: true, result: q.result.value };
      if (q.result.status === 'recovery_required') return { ok: false, error: { code: 'RECOVERY_REQUIRED', outcome: 'unknown' } };
      if (q.result.status === 'not_found') break;
    }
    return { ok: false, error: { code: 'UNCONFIRMED', outcome: 'unknown' } };
  }

  // Writes in flight or with an unknown outcome are kept in session storage (never the token), so a
  // refresh looks them up by their original operation ID instead of creating a new one.
  const PENDING_KEY = `agentchat.pending.${boot.workspaceId}`;
  function savePending() {
    const list = [...st.ops.entries()].map(([key, op]) => ({ key, path: op.path, body: op.body }));
    try { window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(list)); }
    catch (err) { if (list.length) st.notice = { text: t('浏览器不允许保存待确认的操作；刷新页面前请先看它的结果。'), tone: 'warn' }; }
  }

  async function restorePending() {
    let list = [];
    try { list = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) || '[]'); } catch (err) { list = []; }
    for (const p of list) {
      if (!p || !p.body || !p.body.operationId) continue;
      const q = await src.operation(p.body.operationId);
      if (q.ok && q.result.status === 'committed') {
        if (p.key.startsWith('send:')) clearDraft(p.key.slice(5), null);
        continue;
      }
      st.ops.set(p.key, { state: 'unknown', path: p.path, body: p.body, error: q.ok ? null : q.error });
    }
    savePending();
  }

  async function runOp(key, path, body, onDone) {
    const existing = st.ops.get(key);
    if (existing && existing.state === 'sending') return null;
    st.ops.set(key, { state: 'sending', path, body, onDone });
    savePending();
    render();
    let res = await src.post(path, body);
    if (!res.ok && res.error && res.error.outcome === 'unknown') {
      st.ops.set(key, { state: 'unknown', path, body, onDone });
      render();
      res = await confirmOutcome(body.operationId);
    }
    if (res.ok) {
      st.ops.delete(key);
      if (onDone) onDone(res.result);
      // Without a live room stream (page hidden, reconnecting), show the result of Ryan's own action now.
      const v = view();
      if (v && st.conn.room !== 'live' && path.startsWith(src.roomPath(v.roomId))) resyncRoom(v);
    } else if (res.error.outcome === 'unknown') {
      st.ops.set(key, { state: 'unknown', path, body, onDone, error: res.error });
    } else {
      st.ops.delete(key);
      flash(errorText(res.error.code) + detailsText(res.error), 'bad');
    }
    savePending();
    render();
    return res;
  }

  // Operation keys that belong to one room carry its ID, so switching rooms never mixes them.
  const rk = (name, roomId = st.currentRoomId) => `${name}:${roomId}`;

  function detailsText(error) {
    const d = error && error.details;
    if (!d) return '';
    if (d.occupiedRoom && d.occupiedRoom.name) return t('（会话在「{0}」）', d.occupiedRoom.name);
    return '';
  }

  function retryOp(key) {
    const op = st.ops.get(key);
    if (op) { st.ops.delete(key); runOp(key, op.path, op.body, op.onDone); }
  }

  function dropOp(key, text) {
    st.ops.delete(key);
    savePending();
    if (text) flash(text, 'warn');
    render();
  }

  function actionState(key) {
    const op = st.ops.get(key);
    if (!op) return null;
    return op.state === 'sending' ? h('span', { class: 'hint' }, t('处理中…'))
      : h('span', { class: 'hint warn' }, t('结果待确认 '), link(t('重试'), () => retryOp(key)));
  }

  // ---- Catalog (left list) -----------------------------------------------------------

  async function loadCatalog() {
    const res = await src.rooms('open');
    if (!res.ok) {
      if (['AUTH_REQUIRED', 'FORBIDDEN'].includes(res.error.code)) st.conn.catalog = 'auth';
      else st.conn.catalog = 'offline';
      render();
      return false;
    }
    const r = res.result;
    st.catalog.rooms = new Map(r.rooms.map((x) => [x.id, x]));
    st.catalog.revision = r.catalogRevision;
    st.catalog.cursor = r.eventCursor;
    st.catalog.nextCursor = r.nextCursor;
    if (r.totals) st.catalog.totals = r.totals;
    return true;
  }

  async function loadMoreRooms() {
    if (!st.catalog.nextCursor) return;
    const res = await src.rooms('open', st.catalog.nextCursor);
    if (!res.ok) { flash(errorText(res.error.code), 'bad'); return; }
    for (const x of res.result.rooms) st.catalog.rooms.set(x.id, x);
    st.catalog.nextCursor = res.result.nextCursor;
    render();
  }

  async function loadArchived(more = false) {
    if (more && !(st.archived && st.archived.nextCursor)) return;
    const res = await src.rooms('archived', more ? st.archived.nextCursor : undefined);
    if (!res.ok) { flash(errorText(res.error.code), 'bad'); return; }
    const known = more ? st.archived.rooms : [];
    st.archived = { rooms: known.concat(res.result.rooms.filter((r) => !known.some((x) => x.id === r.id))), nextCursor: res.result.nextCursor };
    render();
  }

  function applyCatalogDelta(d) {
    if (d.instanceId && d.instanceId !== boot.instanceId) { st.conn.catalog = 'auth'; render(); return; }
    if (st.catalog.revision !== null && d.toRevision <= st.catalog.revision) return;
    if (st.catalog.revision !== null && d.fromRevision !== st.catalog.revision) { resyncCatalog(); return; }
    st.catalog.revision = d.toRevision;
    st.catalog.cursor = d.eventCursor;
    for (const room of d.upsertRooms || []) {
      if (room.lifecycle === 'archived') {
        st.catalog.rooms.delete(room.id);
        if (st.archived) {
          st.archived.rooms = st.archived.rooms.filter((x) => x.id !== room.id);
          st.archived.rooms.unshift(room);
        }
      } else {
        st.catalog.rooms.set(room.id, room);
        if (st.archived) st.archived.rooms = st.archived.rooms.filter((x) => x.id !== room.id);
      }
    }
    if (d.totals) st.catalog.totals = d.totals;
    for (const notice of d.notices || []) showNotice(notice);
    render();
  }

  async function resyncCatalog() {
    if (await loadCatalog()) connectCatalog();
    render();
  }

  function connectCatalog() {
    if (catalogStream) catalogStream.close();
    let attempt = 0;
    const open = () => {
      catalogStream = src.catalogStream(st.catalog.cursor, {
        onOpen: () => { attempt = 0; st.conn.catalog = 'live'; render(); },
        onEvent: (name, data) => {
          if (name === 'catalog.delta') applyCatalogDelta(data);
          else if (name === 'resync_required') { catalogStream.close(); resyncCatalog(); }
          else if (name === 'service.shutdown') applyShutdown(data, 'event');
        },
        onEnd: async (reason) => {
          if (exiting()) return;
          if (reason === 'auth') { st.conn.catalog = 'auth'; render(); return; }
          st.conn.catalog = 'offline';
          render();
          await sleep(BACKOFF_S[Math.min(attempt++, BACKOFF_S.length - 1)] * 1000);
          if (exiting()) return;
          const ok = await loadCatalog();
          if (!ok && st.conn.catalog === 'auth') return;
          if (ok) { st.conn.catalog = 'polling'; if (view()) resyncRoom(view()); }
          open();
        },
      });
    };
    open();
  }

  // ---- Room view: pages, deltas, window ----------------------------------------------

  function sortEntries(v) {
    v.sorted = [...v.entries.values()].sort((a, b) => a.order - b.order);
  }

  function applyPage(v, page, mode) {
    // mode: 'replace' | 'before' | 'after'
    // epoch: bumped whenever the cache stops being one run with what came before (replace, head trim)
    if (mode === 'replace') { v.entries = new Map(); v.cache.clear(); v.headTrimmed = false; v.epoch = (v.epoch || 0) + 1; }
    for (const e of page.items) mergeEntry(v, e);
    if (mode === 'replace' || mode === 'before') v.nextBeforeCursor = page.nextBeforeCursor;
    if (mode === 'replace' || mode === 'after') v.nextAfterCursor = page.nextAfterCursor;
    v.detached = Boolean(v.nextAfterCursor);
    sortEntries(v);
  }

  // A page followed by the rows fillForward found after it, as one run with the combined end.
  function extendPage(page, more) {
    const items = page.items.concat(more.items);
    return { ...page, items, lastOrder: items.length ? items[items.length - 1].order : page.lastOrder, nextAfterCursor: more.nextAfterCursor };
  }

  function mergeEntry(v, e) {
    const old = v.entries.get(e.id);
    if (old && old.version >= e.version) return false;
    v.entries.set(e.id, e);
    v.cache.delete(e.id);
    return true;
  }

  function setWindowToEnd(v) {
    v.win.end = v.sorted.length;
    v.win.start = Math.max(0, v.win.end - WINDOW);
  }

  // `still` lets a caller drop the reload when it comes back (back to latest, after a newer
  // navigation): nothing is applied and the view stays as it is.
  async function reloadView(v, still = () => true) {
    v.loading = true;
    const res = await src.view(v.roomId);
    const more = res.ok && res.result.page.nextAfterCursor ? await fillForward(v.roomId, res.result.page, Infinity) : null;
    v.loading = false;
    if (!still()) return false;
    if (!res.ok) {
      if (res.error.code === 'NOT_FOUND') {
        st.catalog.rooms.delete(v.roomId);
        st.views.delete(v.roomId);
        if (v.roomId === st.currentRoomId) st.currentRoomId = null;
      }
      if (v.roomId === st.currentRoomId || res.error.code === 'NOT_FOUND') flash(errorText(res.error.code), 'bad');
      render();
      return false;
    }
    const r = res.result;
    v.control = r.control;
    v.freshAt = Date.now();
    attentionChanged(v);
    v.revision = r.revision;
    v.eventCursor = r.eventCursor;
    clockOffset = Date.parse(r.control.serverTime) - Date.now();
    applyPage(v, r.page, 'replace');
    if (more) applyPage(v, { items: more.items, nextBeforeCursor: v.nextBeforeCursor, nextAfterCursor: more.nextAfterCursor }, 'after');
    setWindowToEnd(v);
    trimHead(v);
    v.stick = true;
    v.newCount = 0;
    if (v.roomId === st.currentRoomId) render();
    return true;
  }

  function applyRoomDelta(v, d) {
    if (d.roomId !== v.roomId) return;
    if (v.revision !== null && d.toRevision <= v.revision) return;
    if (v.revision !== null && d.fromRevision !== v.revision) { resyncRoom(v); return; }
    v.revision = d.toRevision;
    v.eventCursor = d.eventCursor;
    if (d.control) { v.control = d.control; v.freshAt = Date.now(); clockOffset = Date.parse(d.control.serverTime) - Date.now(); attentionChanged(v); }
    let appended = 0;
    const tail = v.sorted.length ? v.sorted[v.sorted.length - 1].order : 0;
    const head = v.sorted.length ? v.sorted[0].order : 0;
    for (const e of d.upsertEntries || []) {
      if (v.entries.has(e.id)) { mergeEntry(v, e); continue; }
      // Reading far up while the room keeps talking: stop growing the cache and count instead.
      if (!v.detached && !v.stick && e.order > tail && v.entries.size >= CACHE + WINDOW) { v.detached = true; v.nextAfterCursor = null; }
      if (v.detached) { if (e.order > tail) v.newCount += 1; continue; }
      if (e.order > tail || !v.sorted.length) { mergeEntry(v, e); appended += 1; }
      else if (e.order >= head) mergeEntry(v, e);
      // older than the loaded range: picked up when that page is fetched
    }
    sortEntries(v);
    if (appended) {
      if (v.stick) setWindowToEnd(v);
      else v.newCount += appended;
    }
    trimHead(v);
    if (d.invalidateHistory) { resyncRoom(v); return; }
    if (v.roomId === st.currentRoomId) render();
  }

  // Reload an open room in place without moving the reader. Only resyncRoom calls this, after it has
  // closed the room stream, so no delta can land in between; the stream then resumes from the fresh
  // view's cursor and brings everything after it. Everything is fetched first: the fresh view and,
  // when the reader is up in the history, the page around the entry they are looking at. Where the
  // reader is gets read again once that is in, so a jump made meanwhile counts (and is fetched for
  // in turn; each extra round needs a new jump). Then the data is applied and rendered there in one
  // step. Returns false when nothing could be applied.
  async function refreshRoom(v) {
    const gen = st.openGen;
    const here = () => gen === st.openGen && v.roomId === st.currentRoomId;
    const has = (page, id) => Boolean(page && page.items.some((e) => e.id === id));
    v.loading = true;
    const res = await src.view(v.roomId);
    let latest = res.ok ? res.result.page : null;
    if (latest && latest.nextAfterCursor) latest = extendPage(latest, await fillForward(v.roomId, latest, Infinity));
    let around = null;
    let asked = null;
    let failed = false;
    while (latest && here()) {
      const pos = readerPosition(v);
      if (pos.latest || has(latest, pos.id) || has(around, pos.id) || pos.id === asked) break;
      asked = pos.id;
      const r = await src.timeline(v.roomId, { around: pos.id });
      if (!r.ok) { failed = r.error.code !== 'NOT_FOUND'; break; } // gone from the history: show the latest
      around = r.result;
      if (!has(around, pos.id) && around.nextAfterCursor) {
        around = extendPage(around, await fillForward(v.roomId, around, Infinity, 5, (items) => items.some((e) => e.id === pos.id)));
      }
    }
    v.loading = false;
    if (!here()) return true;
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) st.conn.room = 'auth';
      if (res.error.code === 'NOT_FOUND') {
        st.catalog.rooms.delete(v.roomId);
        st.views.delete(v.roomId);
        st.currentRoomId = null;
        flash(errorText(res.error.code), 'bad');
      }
      render();
      return false;
    }
    if (failed) return false;
    const r = res.result;
    v.control = r.control;
    v.freshAt = Date.now();
    attentionChanged(v);
    v.revision = r.revision;
    v.eventCursor = r.eventCursor;
    clockOffset = Date.parse(r.control.serverTime) - Date.now();
    const pos = readerPosition(v);
    const page = !pos.latest && !has(latest, pos.id) && has(around, pos.id) ? around : latest;
    applyPage(v, page, 'replace');
    if (!pos.latest && has(page, pos.id)) {
      landAt(v, pos);
      return true;
    }
    setWindowToEnd(v);
    trimHead(v);
    v.stick = true;
    v.newCount = 0;
    render();
    return true;
  }

  // The one way to bring an open room up to date: tab visible again, a stream gap, the broker
  // asking, history invalidated, the catalog back after an outage, Ryan's own action while the
  // stream is down. It closes the room stream, refreshes the room in place, then reconnects. A
  // failed refresh is retried with backoff instead of leaving the room without a stream. It stops
  // if the room is left, the page is hidden (showing it again resyncs) or the credential is refused.
  // Concurrent callers share the one run.
  async function resyncRoom(v) {
    if (v.roomId !== st.currentRoomId || v.resyncing) return;
    v.resyncing = true;
    if (roomStream) { roomStream.close(); roomStream = null; }
    roomStreamGen += 1;
    const gen = st.openGen;
    const here = () => gen === st.openGen && v.roomId === st.currentRoomId;
    try {
      for (let attempt = 0; ; attempt++) {
        if (await refreshRoom(v)) break;
        if (!here() || st.conn.room === 'auth') return;
        st.conn.room = 'offline';
        render();
        await sleep(BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)] * 1000);
        if (!here() || document.visibilityState === 'hidden') return;
      }
    } finally {
      v.resyncing = false;
    }
    if (here()) connectRoom(v);
  }

  function connectRoom(v) {
    if (roomStream) roomStream.close();
    const gen = ++roomStreamGen;
    let attempt = 0;
    const open = () => {
      if (gen !== roomStreamGen) return;
      if (document.visibilityState === 'hidden') { st.conn.room = 'paused'; return; }
      roomStream = src.roomStream(v.roomId, v.eventCursor, {
        onOpen: () => { attempt = 0; st.conn.room = 'live'; st.roomLiveAt = Date.now(); setTimeout(() => render({ keepAnchor: true }), 1600); },
        onEvent: (name, data) => {
          if (gen !== roomStreamGen) return;
          if (name === 'room.delta') applyRoomDelta(v, data);
          else if (name === 'resync_required') resyncRoom(v);
          else if (name === 'service.shutdown') applyShutdown(data, 'event');
        },
        onEnd: async (reason) => {
          if (gen !== roomStreamGen || exiting()) return;
          st.conn.room = reason === 'auth' ? 'auth' : 'offline';
          if (reason === 'auth') { render(); return; }
          await sleep(BACKOFF_S[Math.min(attempt++, BACKOFF_S.length - 1)] * 1000);
          if (gen !== roomStreamGen) return;
          open();
        },
      });
    };
    open();
  }

  async function openRoom(roomId) {
    const old = view();
    if (old) { old.draft = $('input') ? $('input').value : old.draft; savePosition(); }
    if (roomStream) { roomStream.close(); roomStream = null; roomStreamGen += 1; }
    st.conn.room = 'idle';
    st.currentRoomId = roomId;
    st.panel = null;
    st.attention = null;
    st.sidebarOpen = false;
    st.composer.discussOpen = false;
    st.offline.clear(); // reconnect warnings are about the room just entered
    clearTimeout(st.offlineTimer);
    st.roomEnteredAt = Date.now();
    store.set('agentchat.room', roomId);
    const gen = ++st.openGen;
    const nav = navGen;
    const v = touchView(roomId);
    // Where the unread replies begin, as the room stood when it was opened; kept for this visit. With
    // unread replies the room opens at the first of them rather than at the end (landUnread).
    const summary = st.catalog.rooms.get(roomId);
    v.unreadFrom = summary && summary.unreadReplyCount > 0 ? summary.readThroughOrder : null;
    v.unreadLoc = v.unreadFrom != null && summary.firstUnread && summary.firstUnread.timelineItemId ? summary.firstUnread : null;
    v.unreadLanding = v.unreadFrom != null ? { state: 'waiting' } : null;
    if ($('input')) { $('input').value = v.draft || store.sget(`agentchat.draft.${roomId}`) || ''; autoGrow(); }
    render();
    if (!v.control || v.revision === null) await reloadView(v);
    else render();
    if (gen !== st.openGen || st.currentRoomId !== roomId) return;
    await restorePosition(v, gen, nav);
    if (gen !== st.openGen || st.currentRoomId !== roomId) return;
    connectRoom(v);
    focusInput();
  }

  function focusInput() {
    const t = $('input');
    if (t && !t.disabled && window.matchMedia && window.matchMedia('(pointer: fine)').matches) t.focus({ preventScroll: true });
  }

  // The broker caps a page at 256 KB. Before Codex's F3 fix (6936760) it kept the oldest rows of
  // the range when it cut, so a latest or "before" page could stop short of where it should end
  // and an "around" page could miss its target. Following "after" cursors from the end of the
  // page fills anything left out; kept as a guard. Read-only and bounded.
  async function fillForward(roomId, page, untilOrder, maxPages = 20, done = null) {
    const items = [];
    let cursor = page.nextAfterCursor;
    let last = page.lastOrder;
    for (let i = 0; cursor && (last == null || last < untilOrder - 1) && i < maxPages; i++) {
      if (done && done(items)) break;
      const res = await src.timeline(roomId, { after: cursor });
      if (!res.ok) break;
      const fresh = res.result.items.filter((e) => e.order < untilOrder);
      items.push(...fresh);
      if (!fresh.length || fresh.length < res.result.items.length) { cursor = res.result.items.length ? null : cursor; break; }
      cursor = res.result.nextAfterCursor;
      last = res.result.lastOrder;
    }
    return { items, nextAfterCursor: cursor };
  }

  // Following the live tail for hours: keep at most CACHE entries by releasing the oldest ones
  // outside the DOM window. Their page cursor is lost; paging back past the head recovers it.
  function trimHead(v) {
    const excess = Math.min(v.sorted.length - CACHE, v.win.start);
    if (excess <= 0) return;
    const drop = v.sorted.slice(0, excess);
    for (const e of drop) { v.entries.delete(e.id); v.cache.delete(e.id); }
    forgetEntries(v, drop);
    v.sorted = v.sorted.slice(excess);
    v.win.start -= excess;
    v.win.end -= excess;
    v.nextBeforeCursor = null;
    v.headTrimmed = true;
    v.epoch = (v.epoch || 0) + 1;
  }

  // Navigation. Every command that moves the view (a rail tick or outline item, jump to start,
  // back to latest, a quote or "view" link) begins a new navigation. Anything still pending from
  // an older one (the landing after a smooth scroll, a walk to the start, a page loading for a
  // quote, a reload back to the latest, a saved position being restored, a page loaded by
  // scrolling) is dropped when it comes due, so the newest intent wins. Scrolling by hand also
  // cancels pending landings, but not the page loads the scrolling itself starts.
  let navGen = 0;  // commands
  let landGen = 0; // commands and scrolling by hand
  const beginNav = () => { navGen += 1; landGen += 1; return landGen; };
  const cancelLanding = () => { landGen += 1; };

  // Walk back from the newest page (opaque cursors only) to the page just before `head`.
  async function recoverBefore(v, head) {
    let res = await src.timeline(v.roomId, {});
    for (let pages = 0; res.ok && res.result.firstOrder !== null && res.result.firstOrder >= head && res.result.nextBeforeCursor && pages < 100; pages++) {
      res = await src.timeline(v.roomId, { before: res.result.nextBeforeCursor });
    }
    if (!res.ok) return res;
    const items = res.result.items.filter((e) => e.order < head);
    return { ok: true, result: { ...res.result, items, nextBeforeCursor: res.result.nextBeforeCursor } };
  }

  // The page just before `head` (an order): from `cursor` or, after a head trim, by walking back
  // from the newest page; a page cut short of the head is filled forward. Network only.
  async function olderPage(v, head, cursor) {
    const res = cursor ? await src.timeline(v.roomId, { before: cursor }) : await recoverBefore(v, head);
    if (!res.ok) return res;
    let page = res.result;
    if (page.lastOrder != null && page.lastOrder < head - 1 && page.nextAfterCursor) {
      const more = await fillForward(v.roomId, page, head, 10);
      page = { ...page, items: page.items.concat(more.items) };
    }
    return { ok: true, result: page };
  }

  // One page older, added to the cache. `still` drops it when it comes back after a newer
  // navigation; it is also dropped if the cache head moved meanwhile (a resync or a trim).
  async function fetchOlder(v, still = () => true) {
    if (v.loading || (!v.nextBeforeCursor && !v.headTrimmed)) return false;
    const headOf = () => (v.sorted.length ? v.sorted[0].order : Infinity);
    const head = headOf();
    const cursor = v.nextBeforeCursor;
    v.loading = true;
    const res = await olderPage(v, head, cursor);
    v.loading = false;
    if (!still() || v.nextBeforeCursor !== cursor || headOf() !== head) return false;
    if (!res.ok) { flash(errorText(res.error.code), 'bad'); return false; }
    v.headTrimmed = false;
    const before = v.sorted.length;
    applyPage(v, res.result, 'before');
    const added = v.sorted.length - before;
    v.win.start = 0;
    v.win.end = Math.min(v.sorted.length, v.win.end + added);
    if (v.win.end - v.win.start > WINDOW) v.win.end = v.win.start + WINDOW;
    trimCache(v);
    return true;
  }

  async function loadOlder(v) {
    const nav = navGen;
    if (await fetchOlder(v, () => nav === navGen)) render({ keepAnchor: true });
  }

  // The very beginning: walk back page by page (the broker has no "first page" query yet), then
  // show the top. Pages are collected first and applied together at the end, so a walk that is
  // cancelled (a newer navigation, or scrolling by hand) leaves the view exactly as it was. Only
  // the oldest CACHE entries are kept; bounded to 80 pages.
  async function jumpToStart(v) {
    if (st.jumping) return;
    const land = beginNav();
    const still = () => land === landGen && v.roomId === st.currentRoomId;
    const epoch = v.epoch;
    const pages = [];
    let kept = 0;
    let joined = true; // false once newer pages were let go: the rest no longer meets the cache
    let failed = null;
    st.jumping = true;
    updateJumps();
    try {
      let head = v.sorted.length ? v.sorted[0].order : Infinity;
      let cursor = v.nextBeforeCursor;
      for (let n = 0; n < 80 && (cursor || (n === 0 && v.headTrimmed)); n++) {
        const res = await olderPage(v, head, cursor);
        if (!still()) return;
        if (!res.ok) { failed = res.error; break; }
        const page = res.result;
        pages.push(page);
        if (!page.items.length) break;
        kept += page.items.length;
        while (pages.length > 1 && kept - pages[0].items.length >= CACHE) { kept -= pages.shift().items.length; joined = false; }
        head = page.firstOrder;
        cursor = page.nextBeforeCursor;
      }
    } finally {
      st.jumping = false;
      updateJumps();
    }
    if (failed) flash(errorText(failed.code), 'bad');
    if (pages.length) {
      // Joined onto the cache when it is still the run the walk started from; otherwise (pages let
      // go, or the cache was replaced or trimmed meanwhile) the pages replace it.
      if (joined && v.epoch === epoch) for (const page of pages) applyPage(v, page, 'before');
      else {
        applyPage(v, { items: pages.flatMap((p) => p.items), nextBeforeCursor: pages[pages.length - 1].nextBeforeCursor,
          nextAfterCursor: pages[0].nextAfterCursor }, 'replace');
      }
      v.headTrimmed = false;
      trimCache(v);
    }
    v.win.start = 0;
    v.win.end = Math.min(v.sorted.length, WINDOW);
    v.stick = false;
    render();
    $('timeline').scrollTop = 0;
    updateJumps();
  }

  // Reading position per room: "following the latest", or the entry at the top of the view with
  // its offset (not scrollTop: line heights change with the language). Kept in sessionStorage so a
  // refresh or a language switch comes back to the same place; a first open shows the latest.
  const POS_KEY = (roomId) => `agentchat.pos.${roomId}`;
  let posTimer = null;
  function savePosition() {
    clearTimeout(posTimer);
    posTimer = null;
    const v = view();
    if (!v || !v.control || !$('timeline') || !v.sorted.length) return;
    v.readPos = readerPosition(v);
    store.sset(POS_KEY(v.roomId), JSON.stringify(v.readPos));
  }

  // Where the reader of the open room is: following the latest, or the entry at the top of the view
  // and its offset. A rail jump that is still landing counts as being at its target.
  function readerPosition(v) {
    if (landing && landing.land === landGen && landing.roomId === v.roomId) return { latest: false, id: landing.id, offset: 24 };
    if (v.stick && !v.detached) return { latest: true };
    const a = anchorInfo($('timeline'));
    return a ? { latest: false, id: a.id, offset: Math.round(a.offset) } : { latest: true };
  }

  // Show a loaded entry at `pos.offset` from the top of the view.
  function landAt(v, pos) {
    const idx = v.sorted.findIndex((e) => e.id === pos.id);
    if (idx < 0) return false;
    v.win.start = Math.max(0, idx - Math.floor(WINDOW / 3));
    v.win.end = Math.min(v.sorted.length, v.win.start + WINDOW);
    v.stick = false;
    render();
    const tl = $('timeline');
    const el = tl.querySelector(`[data-id="${CSS.escape(pos.id)}"]`);
    if (el) tl.scrollTop += el.getBoundingClientRect().top - tl.getBoundingClientRect().top - (pos.offset || 0);
    updateJumps();
    updateRailActive();
    return true;
  }
  const schedulePosition = () => { clearTimeout(posTimer); posTimer = setTimeout(savePosition, 300); };

  // `nav` is the navigation when the open or resync began: if the user has jumped somewhere since,
  // that wins over the saved position.
  async function restorePosition(v, gen, nav = navGen) {
    const still = () => gen === st.openGen && v.roomId === st.currentRoomId && nav === navGen;
    if (!still()) return;
    let pos = v.readPos;
    if (!pos) { try { pos = JSON.parse(store.sget(POS_KEY(v.roomId)) || 'null'); } catch (e) { pos = null; } }
    if (!pos || pos.latest || typeof pos.id !== 'string') return;
    if (!v.entries.has(pos.id)) {
      const res = await src.timeline(v.roomId, { around: pos.id });
      if (!res.ok || !still()) return;
      let page = res.result;
      if (!page.items.some((e) => e.id === pos.id) && page.nextAfterCursor) {
        const more = await fillForward(v.roomId, page, Infinity, 5, (items) => items.some((e) => e.id === pos.id));
        if (!still()) return;
        page = extendPage(page, more);
      }
      if (!page.items.some((e) => e.id === pos.id)) return;
      applyPage(v, page, 'replace');
    }
    landAt(v, pos);
  }

  function jumpToLatest(v) {
    const land = beginNav();
    if (v.detached) { backToLatest(v, () => land === landGen); return; }
    v.newCount = 0;
    setWindowToEnd(v);
    v.stick = true;
    render();
    $('timeline').scrollTop = $('timeline').scrollHeight;
    updateJumps();
  }

  // A loaded entry (from the conversation rail): bring it into the DOM window and put it at the top.
  // `instant` goes there without the smooth scroll (opening a room at its first unread reply).
  let landing = null; // a rail jump still on its way: { roomId, id, land }
  function jumpToEntry(v, itemId, { instant = false } = {}) {
    const land = beginNav();
    const idx = v.sorted.findIndex((e) => e.id === itemId);
    if (idx < 0) return;
    if (idx < v.win.start || idx >= v.win.end) {
      v.win.start = Math.max(0, idx - Math.floor(WINDOW / 3));
      v.win.end = Math.min(v.sorted.length, v.win.start + WINDOW);
    }
    v.stick = false;
    render();
    const el = $('timeline').querySelector(`[data-id="${CSS.escape(itemId)}"]`);
    if (!el) return;
    const tl = $('timeline');
    const reduce = instant || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const target = tl.scrollTop + el.getBoundingClientRect().top - tl.getBoundingClientRect().top - 24;
    tl.scrollTo({ top: target, behavior: reduce ? 'auto' : 'smooth' });
    // A smooth scroll can be dropped (window in the background); land there anyway, by the entry,
    // since a refresh may have re-rendered the room in between.
    if (!reduce) {
      landing = { roomId: v.roomId, id: itemId, land };
      setTimeout(() => {
        if (landing && landing.land === land) landing = null;
        if (land !== landGen || st.currentRoomId !== v.roomId) return;
        const now = tl.querySelector(`[data-id="${CSS.escape(itemId)}"]`);
        const off = now ? now.getBoundingClientRect().top - tl.getBoundingClientRect().top - 24 : 0;
        if (Math.abs(off) > 4) tl.scrollTop += off;
      }, 700);
    }
    el.classList.remove('flash-row');
    void el.offsetWidth;
    el.classList.add('flash-row');
    setTimeout(() => el.classList.remove('flash-row'), 1400);
    updateRailActive();
  }

  async function loadNewer(v) {
    if (v.loading) return;
    const nav = navGen;
    const cursor = v.nextAfterCursor;
    const last = v.sorted.length ? v.sorted[v.sorted.length - 1].id : null;
    // A cut cache (paged back past the cap, or read far up while the room kept talking) has no
    // "after" cursor: the page around its last entry has one, so reading down continues in order.
    const query = cursor ? { after: cursor } : v.detached && last ? { around: last } : null;
    if (!query) return;
    v.loading = true;
    const res = await src.timeline(v.roomId, query);
    v.loading = false;
    // Dropped when a newer navigation moved the view or the cache changed under it meanwhile.
    const tail = v.sorted.length ? v.sorted[v.sorted.length - 1].id : null;
    if (nav !== navGen || v.nextAfterCursor !== cursor || tail !== last) return;
    if (query.around && (res.ok ? !res.result.items.some((e) => e.id === last) : res.error.code === 'NOT_FOUND')) {
      await backToLatest(v, () => nav === navGen); // that entry is no longer in the history
      return;
    }
    if (!res.ok) { flash(errorText(res.error.code), 'bad'); return; }
    applyPage(v, { ...res.result, nextBeforeCursor: v.nextBeforeCursor }, 'after');
    v.win.end = v.sorted.length;
    v.win.start = Math.max(0, v.win.end - WINDOW);
    render({ keepAnchor: true });
  }

  // Paging back past the cache cap drops the newest entries; the view is then "detached" with no
  // "after" cursor. Reading down past the cut asks for the page around the last cached entry, which
  // carries a real one (see loadNewer), so nothing is skipped and no cursor is made up.
  function trimCache(v) {
    if (v.sorted.length <= CACHE) return;
    const drop = v.sorted.slice(CACHE);
    for (const e of drop) { v.entries.delete(e.id); v.cache.delete(e.id); }
    forgetEntries(v, drop);
    v.sorted = v.sorted.slice(0, CACHE);
    v.win.end = Math.min(v.win.end, v.sorted.length);
    v.detached = true;
    v.nextAfterCursor = null;
  }

  async function backToLatest(v, still = () => true) {
    const gen = st.openGen;
    if (await reloadView(v, () => still() && gen === st.openGen && v.roomId === st.currentRoomId)) connectRoom(v);
  }

  // A quote or "view" link: the entry around a cursor, loading that part of the room if needed.
  async function jumpTo(v, aroundCursor, targetItemId) {
    if (!aroundCursor) return;
    const land = beginNav();
    const still = () => land === landGen && v.roomId === st.currentRoomId;
    if (targetItemId && v.entries.has(targetItemId)) {
      const idx = v.sorted.findIndex((e) => e.id === targetItemId);
      if (idx < v.win.start || idx >= v.win.end) {
        v.win.start = Math.max(0, idx - Math.floor(WINDOW / 2));
        v.win.end = Math.min(v.sorted.length, v.win.start + WINDOW);
      }
      v.stick = false;
      render();
      highlight(targetItemId);
      return;
    }
    const res = await src.timeline(v.roomId, { around: aroundCursor });
    if (!still()) return;
    if (!res.ok) { flash(errorText(res.error.code), 'bad'); return; }
    let page = res.result;
    const target = page.targetItemId || targetItemId;
    if (target && !page.items.some((e) => e.id === target) && page.nextAfterCursor) {
      const more = await fillForward(v.roomId, page, Infinity, 5, (items) => items.some((e) => e.id === target));
      if (!still()) return;
      page = extendPage(page, more);
    }
    applyPage(v, page, 'replace');
    const idx = Math.max(0, v.sorted.findIndex((e) => e.id === target));
    v.win.start = Math.max(0, idx - Math.floor(WINDOW / 2));
    v.win.end = Math.min(v.sorted.length, v.win.start + WINDOW);
    v.stick = false;
    render();
    highlight(target);
  }

  function highlight(itemId) {
    const el = document.querySelector(`[data-id="${CSS.escape(itemId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }

  // ---- Human actions -----------------------------------------------------------------

  const roomPath = (suffix) => `${src.roomPath(st.currentRoomId)}${suffix}`;

  function clearDraft(roomId, sentText) {
    const v = st.views.get(roomId);
    if (v && (sentText === null || v.draft === sentText)) { v.draft = ''; v.stick = true; }
    if (sentText === null || store.sget(`agentchat.draft.${roomId}`) === sentText) store.sset(`agentchat.draft.${roomId}`, '');
    if (st.currentRoomId === roomId && $('input') && (sentText === null || $('input').value === sentText)) {
      $('input').value = '';
      st.composer.to = new Set(AGENTS);
      st.composer.toTouched = false;
      st.composer.work = false;
      autoGrow();
    }
  }

  const afterSend = (roomId, sentText, sentFiles = []) => () => { guardStop(); clearDraft(roomId, sentText); dropFiles(roomId, sentFiles); };

  function canSend() {
    const c = control();
    return Boolean(c) && writable() && c.room.lifecycle === 'open' && c.room.actions.send.enabled
      && !st.ops.has(rk('send')) && !st.ops.has(rk('stop')) && st.composer.to.size > 0
      && codePoints($('input').value) <= 32000;
  }

  // After a send the same button turns into Stop; ignore clicks on it briefly so a double click
  // on 发送 can never stop the room.
  function guardStop() {
    st.composer.stopGuardUntil = Date.now() + 1000;
    setTimeout(renderComposer, 1050);
  }

  function onSendButton() {
    if ($('send').dataset.mode === 'stop') {
      if (Date.now() < st.composer.stopGuardUntil) return;
      stop();
      return;
    }
    send();
    focusInput();
  }

  // The files ready to go with the next message; null while one is still uploading or has failed
  // (a message is never sent without a file the user added).
  function readyFiles() {
    const v = view();
    const files = v ? v.attach : [];
    return files.every((a) => a.state === 'done') ? files : null;
  }

  function send() {
    const text = $('input').value;
    const files = readyFiles();
    if (!files || (!text.trim() && !files.length)) return;
    guardStop();
    if (st.composer.work) { startWork(text, files); return; }
    if (!canSend()) return;
    runOp(rk('send'), roomPath('/messages'), {
      operationId: uuid(), expectedGate: control().room.gate,
      recipients: AGENTS.filter((a) => st.composer.to.has(a)), text, attachmentIds: files.map((a) => a.id),
      ...(Array.isArray(capabilities.contentFormats) && capabilities.contentFormats.includes('markdown') ? { format: 'markdown' } : {}),
    }, afterSend(st.currentRoomId, text, files));
  }

  function workBlocker() {
    const c = control();
    if (!c) return t('没有打开群');
    if (c.currentWork) return t('本群已有进行中的任务：{0}', c.currentWork.objective);
    const unbound = c.members.filter((m) => !m.binding);
    if (unbound.length) return t('{0} 还没进群', unbound.map((m) => NAMES[m.agent]).join(t('、')));
    return null;
  }

  function startWork(text, files = []) {
    const c = control();
    const reason = workBlocker();
    if (reason) { flash(reason, 'warn'); return; }
    if (!writable() || st.ops.has(rk('send'))) return;
    const objective = ($('work-objective').value || text.split('\n')[0]).trim().slice(0, 240);
    const [requestLimit, wakeLimit] = PRESETS[st.composer.preset];
    const expectedBindings = Object.fromEntries(c.members.map((m) => [m.agent, m.binding.id]));
    runOp(rk('send'), roomPath('/work'), {
      operationId: uuid(), expectedGate: c.room.gate, expectedBindings, text, attachmentIds: files.map((a) => a.id),
      objective, requestLimit, wakeLimit, durationSeconds: Math.min(st.composer.hours, 10) * 3600,
    }, afterSend(st.currentRoomId, text, files));
  }

  // "Kick off with this plan": Ryan picks the one agent reply he agrees with, and its full text (not a
  // preview, not its first line) becomes the kickoff in the composer, in work mode, for him to check
  // and send. Nothing is sent here, no reply is taken as agreed by itself, and a second pick replaces
  // the first rather than merging two proposals.
  async function kickoffWith(entry, reply) {
    const c = control();
    if (!c || c.room.lifecycle !== 'open') return;
    const blocker = workBlocker();
    if (blocker) { flash(t('不能开工：{0}', blocker), 'warn'); return; }
    const roomId = st.currentRoomId;
    const content = reply.content;
    let text = content.previewText;
    if (content.truncated && content.attachmentId) {
      const cached = st.expanded.get(content.attachmentId);
      if (cached && cached.status === 'done' && !cached.capped) text = cached.text;
      else {
        const res = await fullText(entry, content.attachmentId, roomId);
        if (!res.ok) { flash(t('没有放进输入框：全文读取失败（{0}）', res.error), 'bad'); return; }
        text = res.text;
      }
    }
    if (st.currentRoomId !== roomId) return;
    const body = `${t('按 {0} 在 {1} 的这份方案开工：', NAMES[reply.agent], fmtTime(reply.committedAt))}\n\n${text}`;
    if (codePoints(body) > 32000) { flash(t('这条回复太长（超过 32,000 字），不能直接作为开工内容。'), 'warn'); return; }
    const input = $('input');
    if (input.value.trim() && input.value !== body
      && !(await askConfirm({ title: t('替换输入框里的草稿？'), body: [t('输入框会换成这条回复的全文，作为开工内容。')], confirm: t('替换') }))) return;
    if (st.currentRoomId !== roomId) return;
    input.value = body;
    $('work-objective').value = planObjective(text, reply.agent);
    st.composer.work = true;
    onInput();
    input.focus({ preventScroll: true });
    input.setSelectionRange(0, 0);
    input.scrollTop = 0;
    flash(t('已放进输入框：检查一下目标和内容，再按「开工」发出。'));
  }

  // The work goal: the plan's first line that says something (headings and rules cleaned away).
  function planObjective(text, agent) {
    const line = String(text).split('\n').map((l) => snippet(l, 120)).find((l) => /[\p{L}\p{N}]/u.test(l));
    return line || t('按 {0} 的方案执行', NAMES[agent]);
  }

  function stop() {
    if (st.ops.has(rk('stop'))) { retryOp(rk('stop')); return; }
    runOp(rk('stop'), roomPath('/stop'), { operationId: uuid(), expectedGate: control().room.gate });
  }

  function startDiscussion(cand) {
    const v = view();
    if (v) v.stick = true;
    const body = {
      operationId: uuid(), expectedGate: control().room.gate, baseMessageId: cand.baseMessageId,
      baseReplyIds: cand.availability.baseReplyIds, previousExchangeId: cand.previousExchangeId || null, maxRounds: st.rounds,
    };
    if (Array.isArray(capabilities.discussionFinishPolicies) && capabilities.discussionFinishPolicies.includes('both_same_round')) body.finishPolicy = 'both_same_round';
    runOp(rk('discuss'), roomPath('/exchanges'), body, () => { st.composer.discussOpen = false; });
  }

  async function abandon(d) {
    if (!(await askConfirm({ title: t('不再等待这条回复？'), body: [t('只释放排队位置，不会停止对方；它可能还在原应用里运行，需要的话到那边停止。')], confirm: t('不再等待') }))) return;
    runOp(`abandon:${d.id}`, roomPath(`/deliveries/${encodeURIComponent(d.id)}/abandon`), {
      operationId: uuid(), expectedDeliveryVersion: d.version, expectedClaimId: d.claimId,
    });
  }

  async function resend(d) {
    const ack = d.state === 'uncertain' || d.waitDisposition === 'abandoned';
    const m = control().members.find((x) => x.agent === d.agent);
    const where = m && m.binding ? t('会发到：{0}', m.binding.label) : null;
    const ok = ack
      ? await askConfirm({ title: t('可能会重复发送'), body: [t('{0} 也许已经收到过这条。请先到它的窗口确认。', NAMES[d.agent]), where], confirm: t('仍要重新发送'), danger: true })
      : await askConfirm({ title: t('重新发送给 {0}？', NAMES[d.agent]), body: [where], confirm: t('重新发送') });
    if (!ok) return;
    runOp(`resend:${d.id}`, roomPath(`/deliveries/${encodeURIComponent(d.id)}/resend`), {
      operationId: uuid(), expectedGate: control().room.gate, expectedDeliveryVersion: d.version, acknowledgePossibleDuplicate: ack,
    });
  }

  // In-page dialogs (the embedded browser does not support prompt(), and confirm() blocks the page).
  function openModal({ title, body, actions, role = 'dialog', onCancel, focus, wide = false }) {
    const prevFocus = document.activeElement;
    const overlay = h('div', { class: 'modal', role, 'aria-modal': 'true', 'aria-label': title, onmousedown: (e) => { if (e.target === overlay) onCancel(); } },
      h('div', { class: `modal-box${wide ? ' wide' : ''}` }, h('div', { class: 'modal-title' }, title), body, h('div', { class: 'modal-actions' }, actions)));
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } };
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    if (focus) focus.focus();
    return () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus();
    };
  }

  function askText(title, initial = '') {
    return new Promise((resolve) => {
      const input = h('input', { type: 'text', value: initial, 'aria-label': title });
      let dispose = null;
      const close = (value) => { dispose(); resolve(value); };
      const ok = () => close(input.value.trim() || null);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ok(); }
      });
      dispose = openModal({ title, body: input, onCancel: () => close(null), focus: input, actions: [
        h('button', { type: 'button', class: 'secondary', onclick: () => close(null) }, t('取消')),
        h('button', { type: 'button', class: 'primary', onclick: ok }, t('确定'))] });
      input.select();
    });
  }

  // Resolves true only when the confirm button is pressed. Destructive dialogs focus Cancel.
  function askConfirm({ title, body = [], confirm = t('确定'), danger = false }) {
    return new Promise((resolve) => {
      let dispose = null;
      const close = (value) => { dispose(); resolve(value); };
      const cancelBtn = h('button', { type: 'button', class: 'secondary', onclick: () => close(false) }, t('取消'));
      const okBtn = h('button', { type: 'button', class: danger ? 'primary danger' : 'primary', onclick: () => close(true) }, confirm);
      const lines = body.filter(Boolean);
      dispose = openModal({ title, role: 'alertdialog', onCancel: () => close(false), focus: danger ? cancelBtn : okBtn,
        body: lines.length ? h('div', { class: 'modal-body' }, lines.map((line) => h('p', null, line))) : null,
        actions: [cancelBtn, okBtn] });
    });
  }

  // ---- Attachments ---------------------------------------------------------------------

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const s = String(reader.result); resolve(s.slice(s.indexOf(',') + 1)); };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // A screenshot pasted from the clipboard arrives as "image.png": give it a readable, dated name.
  // Characters the broker refuses in names (control characters, slashes, colons) become "_".
  function uploadName(file, pasted) {
    const generic = /^image\.(png|jpe?g|webp)$/i.exec(file.name || '');
    if (pasted && generic) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${t('截图')}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${generic[1].toLowerCase()}`;
    }
    return (file.name || 'file').replace(/[\x00-\x1f\x7f/\\:]/g, '_');
  }

  function uploadErrorText(code) {
    if (code === 'UNSUPPORTED_ATTACHMENT_TYPE') return t('不支持这种文件（支持图片、PDF、文本）');
    if (code === 'ATTACHMENT_TYPE_MISMATCH') return t('文件内容和扩展名对不上');
    if (code === 'CONTENT_TOO_LARGE') return t('文件太大（上限 10 MB）');
    if (code === 'READ_FAILED') return t('读不了这个文件');
    return errorText(code);
  }

  // Files picked, dropped or pasted: each uploads at once and shows above the text. Sending waits
  // for all of them; a failed one must be retried or removed, never silently left out.
  function addFiles(list, pasted = false) {
    const v = view();
    const c = control();
    if (!v || !c || c.room.lifecycle !== 'open') return;
    const files = [...list];
    const room = MAX_ATTACHMENTS - v.attach.length;
    if (files.length > room) flash(t('一条消息最多 {0} 个附件。', MAX_ATTACHMENTS), 'warn');
    for (const file of files.slice(0, Math.max(0, room))) {
      const name = uploadName(file, pasted);
      const mediaType = mediaTypeFor(name);
      const a = { key: uuid(), name, bytes: file.size, mediaType, file, state: 'uploading', id: null, error: null, opId: uuid(),
        preview: mediaType && mediaType.startsWith('image/') ? URL.createObjectURL(file) : null };
      if (!mediaType) { a.state = 'failed'; a.error = uploadErrorText('UNSUPPORTED_ATTACHMENT_TYPE'); a.final = true; }
      else if (file.size > MAX_UPLOAD_BYTES) { a.state = 'failed'; a.error = uploadErrorText('CONTENT_TOO_LARGE'); a.final = true; }
      v.attach.push(a);
      if (a.state === 'uploading') uploadFile(v, a);
    }
    renderComposer();
  }

  async function uploadFile(v, a) {
    a.state = 'uploading';
    a.error = null;
    renderComposer();
    let res;
    try {
      const body = { operationId: a.opId, name: a.name, mediaType: a.mediaType, dataBase64: await readBase64(a.file) };
      res = await src.post(`${src.roomPath(v.roomId)}/attachments`, body);
      if (!res.ok && res.error && res.error.outcome === 'unknown') res = await confirmOutcome(a.opId);
    } catch (err) {
      res = { ok: false, error: { code: 'READ_FAILED' } };
    }
    if (!v.attach.includes(a)) return; // removed while it was uploading
    if (res.ok && res.result && res.result.attachment) {
      a.state = 'done';
      a.id = res.result.attachment.id;
    } else {
      const code = res.error && res.error.code;
      a.state = 'failed';
      a.error = uploadErrorText(code);
      a.final = ['UNSUPPORTED_ATTACHMENT_TYPE', 'ATTACHMENT_TYPE_MISMATCH', 'CONTENT_TOO_LARGE', 'READ_FAILED'].includes(code);
    }
    renderComposer();
  }

  function removeFile(v, key) {
    const a = v.attach.find((x) => x.key === key);
    if (!a) return;
    if (a.preview) URL.revokeObjectURL(a.preview);
    v.attach = v.attach.filter((x) => x !== a);
    renderComposer();
  }

  // After a send, the files that went with it leave the draft (ones added meanwhile stay).
  function dropFiles(roomId, sent) {
    const v = st.views.get(roomId);
    if (!v || !sent.length) return;
    for (const a of sent) if (a.preview) URL.revokeObjectURL(a.preview);
    v.attach = v.attach.filter((a) => !sent.includes(a));
    if (roomId === st.currentRoomId) renderComposer();
  }

  function renderAttachStrip() {
    const strip = $('attach-strip');
    const v = view();
    const files = v ? v.attach : [];
    strip.hidden = !files.length;
    fill(strip, ...files.map((a) => h('div', {
      class: `att-chip is-${a.state}`, title: a.error ? `${a.name}\n${a.error}` : a.name,
    },
    a.preview ? h('img', { class: 'att-thumb', src: a.preview, alt: '' }) : h('span', { class: 'att-thumb is-file' }, icon('file', 16)),
    h('span', { class: 'att-meta' }, h('span', { class: 'att-name' }, a.name),
      h('span', { class: 'att-sub' }, a.state === 'failed' ? a.error : a.state === 'uploading' ? t('上传中…') : formatBytes(a.bytes))),
    a.state === 'uploading' ? h('span', { class: 'spinner', role: 'status', 'aria-label': t('上传中…') }) : null,
    a.state === 'failed' && !a.final ? h('button', { type: 'button', class: 'att-act', title: t('重试'), 'aria-label': t('重试'), onclick: () => uploadFile(v, a) }, '↻') : null,
    h('button', { type: 'button', class: 'att-act', title: t('移除'), 'aria-label': t('移除 {0}', a.name), onclick: () => removeFile(v, a.key) }, icon('x', 12)))));
  }

  // Bytes of an attachment through the page (Authorization header), as an object URL; images are
  // kept for a while so a re-render does not fetch them again.
  const blobUrls = new Map(); // attachment ID -> Promise<string|null>
  function attachmentUrl(roomId, id) {
    if (!blobUrls.has(id)) {
      blobUrls.set(id, src.download(src.attachmentDownloadPath(roomId, id)).then((res) => (res.ok ? URL.createObjectURL(res.blob) : null)));
      while (blobUrls.size > 60) {
        const [oldest, url] = blobUrls.entries().next().value;
        blobUrls.delete(oldest);
        url.then((u) => { if (u) URL.revokeObjectURL(u); });
      }
    }
    return blobUrls.get(id);
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function downloadAttachment(roomId, att) {
    const res = await src.download(src.attachmentDownloadPath(roomId, att.id));
    if (!res.ok) { flash(errorText(res.error.code), 'bad'); return; }
    saveBlob(res.blob, res.filename || att.name);
  }

  function openImage(roomId, att) {
    const img = h('img', { class: 'lightbox-img', alt: att.name });
    attachmentUrl(roomId, att.id).then((url) => { if (url) img.src = url; });
    let dispose = null;
    dispose = openModal({ title: att.name, body: h('div', { class: 'lightbox' }, img), onCancel: () => dispose(), wide: true, actions: [
      h('button', { type: 'button', class: 'secondary', onclick: () => downloadAttachment(roomId, att) }, t('下载')),
      h('button', { type: 'button', class: 'primary', onclick: () => dispose() }, t('关闭'))] });
  }

  // Files that came with a message or reply (not the full text of a long one): images as
  // thumbnails that open larger, other files as a named chip that downloads.
  function renderAttachments(e, content) {
    const skip = content && content.attachmentId;
    const list = (e.attachments || []).filter((a) => a.id !== skip);
    if (!list.length) return null;
    return h('div', { class: 'attachments' }, list.map((a) => {
      if (a.mediaType && a.mediaType.startsWith('image/')) {
        const img = h('img', { class: 'att-img', alt: a.name, loading: 'lazy' });
        attachmentUrl(e.roomId, a.id).then((url) => { if (url) img.src = url; else img.replaceWith(h('span', { class: 'att-missing' }, t('图片读不出来'))); });
        return h('button', { type: 'button', class: 'att-image', title: a.name, onclick: () => openImage(e.roomId, a) }, img);
      }
      return h('button', { type: 'button', class: 'att-file', title: t('下载 {0}', a.name), onclick: () => downloadAttachment(e.roomId, a) },
        icon('file', 16), h('span', { class: 'att-name' }, a.name), h('span', { class: 'att-sub' }, formatBytes(a.bytes)), icon('download', 14));
    }));
  }

  // ---- Room notes, search, export ------------------------------------------------------

  async function loadNotes(roomId) {
    st.notes = { roomId, status: 'loading', data: null };
    const res = await src.notes(roomId);
    if (!st.notes || st.notes.roomId !== roomId) return;
    st.notes = res.ok && res.result && res.result.notes ? { roomId, status: 'ready', data: res.result.notes }
      : { roomId, status: res.status === 404 && (!res.error || res.error.code === 'NOT_FOUND') ? 'unsupported' : 'error', data: null, error: res.error };
    render();
  }

  // Background for anyone who joins the room: plain text the user writes; sessions that join read it
  // first. Shown in the room panel.
  function notesSection(c) {
    const n = st.notes && st.notes.roomId === c.room.id ? st.notes : null;
    if (!n) loadNotes(c.room.id);
    const text = n && n.data ? n.data.text : '';
    const editable = n && n.status === 'ready' && c.room.lifecycle === 'open';
    const body = !n || n.status === 'loading' ? h('p', { class: 'hint' }, t('正在读取…'))
      : n.status === 'unsupported' ? h('p', { class: 'hint' }, t('当前 broker 还不支持群说明。'))
      : n.status === 'error' ? h('p', { class: 'hint warn' }, errorText(n.error && n.error.code))
      : text ? h('div', { class: 'notes-text' }, text)
      : h('p', { class: 'hint' }, t('还没有群说明。写几句背景和约定，新进群的会话会先读到。'));
    return h('section', { class: 'notes' },
      h('div', { class: 'notes-head' }, icon('note', 14), h('strong', null, t('群说明')),
        editable ? link(text ? t('编辑') : t('写群说明'), () => editNotes(c)) : null),
      body);
  }

  function editNotes(c) {
    const roomId = c.room.id;
    const area = h('textarea', { class: 'notes-edit', rows: '10', 'aria-label': t('群说明') });
    area.value = st.notes && st.notes.data ? st.notes.data.text : '';
    const count = h('span', { class: 'notes-count' });
    const status = h('span', { class: 'settings-status', 'aria-live': 'polite' });
    const update = () => {
      const n = codePoints(area.value);
      count.textContent = t('{0} / 8000 字', n);
      count.classList.toggle('over', n > 8000);
    };
    area.addEventListener('input', update);
    update();
    let dispose = null;
    const save = async () => {
      if (codePoints(area.value) > 8000) { status.textContent = t('最多 8000 字。'); return; }
      status.textContent = t('保存中…');
      const res = await runOp(rk('notes', roomId), `${src.roomPath(roomId)}/notes`,
        { operationId: uuid(), expectedVersion: st.notes && st.notes.data ? st.notes.data.version : null, text: area.value },
        (r) => { if (r && r.notes) st.notes = { roomId, status: 'ready', data: r.notes }; });
      if (res && res.ok) { dispose(); render(); return; }
      if (res && res.error && res.error.code === 'VERSION_CONFLICT') {
        await loadNotes(roomId);
        status.textContent = t('已在别处修改：已换成最新版本，你的改动还在，确认后再保存一次。');
      } else status.textContent = '';
    };
    dispose = openModal({ title: t('群说明'), onCancel: () => dispose(), focus: area, wide: true,
      body: h('div', { class: 'notes-editor' },
        h('p', { class: 'settings-hint' }, t('写给新进群的会话看的背景：项目是什么、约定、注意事项。只是背景，不算新任务。')),
        area, h('div', { class: 'notes-foot' }, count, status)),
      actions: [h('button', { type: 'button', class: 'secondary', onclick: () => dispose() }, t('取消')),
        h('button', { type: 'button', class: 'primary', onclick: save }, t('保存'))] });
  }

  async function exportRoom(c) {
    if (st.exporting) return;
    st.exporting = c.room.id;
    render();
    // Labels and times in the window's language; the conversation itself is exported as written. A
    // broker from before the language option refuses any query, so that one is asked again without it.
    let res = await src.download(src.exportPath(c.room.id, EN_UI ? 'en' : 'zh'));
    if (!res.ok && ['UNKNOWN_FIELD', 'INVALID_INPUT'].includes(res.error.code)) res = await src.download(src.exportPath(c.room.id));
    st.exporting = null;
    render();
    if (!res.ok) { flash(res.status === 404 && res.error.code === 'NOT_FOUND' ? t('当前 broker 还不支持导出。') : errorText(res.error.code), 'bad'); return; }
    const d = new Date();
    saveBlob(res.blob, res.filename || `${c.room.name}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.md`);
    flash(t('已导出「{0}」。', c.room.name));
  }

  // Search this room's history: the broker matches the words as typed (any case), newest first; a
  // result jumps there with the usual "around" navigation. The panel keeps its input between
  // renders so typing is never interrupted.
  let searchNode = null;
  let searchGen = 0;
  async function runSearch(more = false) {
    const s = st.search;
    const roomId = st.currentRoomId;
    const q = s.q.trim();
    if (!roomId || !q) return;
    const gen = ++searchGen;
    if (!more) { s.roomId = roomId; s.items = []; s.nextCursor = null; }
    s.status = 'loading';
    updateSearch();
    const res = await src.search(roomId, q, more ? s.nextCursor : null);
    if (gen !== searchGen || st.currentRoomId !== roomId) return;
    if (!res.ok) {
      s.status = 'error';
      s.error = res.status === 404 && res.error.code === 'NOT_FOUND' ? t('当前 broker 还不支持搜索。') : errorText(res.error.code);
    } else {
      s.items = s.items.concat(res.result.items || []);
      s.nextCursor = res.result.nextCursor || null;
      s.status = 'ready';
      s.done = q;
    }
    updateSearch();
  }

  function marked(text, q) {
    const out = [];
    const lower = text.toLowerCase();
    const needle = q.toLowerCase();
    let at = 0;
    for (let i = lower.indexOf(needle); needle && i >= 0; i = lower.indexOf(needle, at)) {
      out.push(text.slice(at, i), h('mark', null, text.slice(i, i + needle.length)));
      at = i + needle.length;
    }
    out.push(text.slice(at));
    return out;
  }

  function updateSearch() {
    if (!searchNode) return;
    const s = st.search;
    const list = searchNode.querySelector('.search-results');
    const q = s.done || s.q.trim();
    const rows = s.roomId === st.currentRoomId ? s.items : [];
    fill(list, ...[
      ...rows.map((it) => h('li', null, h('button', {
        type: 'button', class: 'search-hit',
        onclick: () => { const v = view(); st.panel = null; render(); if (v) jumpTo(v, it.aroundCursor, it.id); },
      },
      h('span', { class: 'search-who' }, it.author === 'ryan' ? h('span', { class: 'you-tag' }, NAMES.ryan) : [avatar(it.author, 'xs'), NAMES[it.author] || it.author],
        h('span', { class: 'ts' }, fmtShort(it.at))),
      h('span', { class: 'search-text' }, marked(snippet(it.previewText, 240), q))))),
      s.status === 'loading' ? h('li', { class: 'hint' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('正在搜索…')) : null,
      s.status === 'error' ? h('li', { class: 'hint warn' }, s.error) : null,
      s.status === 'ready' && !rows.length ? h('li', { class: 'hint' }, t('没有找到「{0}」。', q)) : null,
      s.status === 'ready' && s.nextCursor ? h('li', null, link(t('加载更多结果'), () => runSearch(true))) : null,
    ].filter(Boolean));
  }

  function searchPanel() {
    if (!st.panel || st.panel.kind !== 'search') { searchNode = null; return null; }
    if (searchNode) return searchNode;
    if (st.search.roomId !== st.currentRoomId) st.search = { roomId: st.currentRoomId, q: '', items: [], nextCursor: null, status: 'idle' };
    const input = h('input', { type: 'search', class: 'search-input', placeholder: t('搜索本群的消息和回复'), 'aria-label': t('搜索本群') });
    input.value = st.search.q;
    input.addEventListener('input', () => { st.search.q = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); runSearch(); } });
    searchNode = panelCard('search', [icon('search', 16), h('strong', null, t('搜索本群'))],
      h('div', { class: 'search-body' },
        h('div', { class: 'search-row' }, input, h('button', { type: 'button', class: 'primary', onclick: () => runSearch() }, t('搜索'))),
        h('ul', { class: 'search-results' })));
    updateSearch();
    setTimeout(() => input.focus(), 0);
    return searchNode;
  }

  // ---- Settings and About ---------------------------------------------------------------

  function humanName() {
    const name = st.settings && typeof st.settings.displayName === 'string' ? st.settings.displayName.trim() : '';
    return name || t('你');
  }

  async function loadSettings() {
    const res = await src.settings();
    if (res.ok && res.result && res.result.settings) { st.settings = res.result.settings; st.settingsOk = true; } else st.settingsOk = false;
    render();
  }

  async function loadDiagnostics() {
    const res = await src.diagnostics();
    st.diagnostics = res.ok && res.result ? (res.result.diagnostics || res.result) : null;
    return st.diagnostics;
  }

  async function copyDiagnostics() {
    const d = await loadDiagnostics();
    if (!d) { flash(t('当前 broker 还不提供诊断信息。'), 'warn'); return; }
    if (await copyText(JSON.stringify(d, null, 2))) flash(t('诊断信息已复制（不含凭证和本机路径）。'));
  }

  // One small dialog: the name Codex and Claude call you by, then what this is, its version,
  // author, license and link, a three-step start, and the safe diagnostics for a bug report; then
  // updates and quitting where the broker offers them. `section` 'updates' opens it there.
  function openSettings(section) {
    if (document.querySelector('.modal')) return;
    const input = h('input', { type: 'text', value: (st.settings && st.settings.displayName) || '', placeholder: t('你'), 'aria-label': t('你的显示名') });
    const status = h('span', { class: 'settings-status', 'aria-live': 'polite' });
    const version = h('span', { class: 'about-version' });
    const save = async () => {
      const name = input.value.trim();
      if (codePoints(name) > 80) { status.textContent = t('最多 80 个字。'); return; }
      if (st.settingsOk === false) { status.textContent = t('当前 broker 还不能保存显示名，更新后再试。'); return; }
      status.textContent = t('保存中…');
      const res = await runOp('settings', '/settings', { operationId: uuid(), expectedVersion: st.settings.version, displayName: name },
        (r) => { if (r && r.settings) st.settings = r.settings; });
      if (res && res.ok) status.textContent = t('已保存。');
      else if (res && res.error && res.error.code === 'VERSION_CONFLICT') {
        await loadSettings();
        input.value = st.settings.displayName || '';
        status.textContent = t('已在别处修改，已刷新。');
      } else status.textContent = '';
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); } });
    const body = h('div', { class: 'settings' },
      h('section', { class: 'settings-sec' },
        h('div', { class: 'settings-label' }, t('你的显示名')),
        h('div', { class: 'settings-row' }, input, h('button', { type: 'button', class: 'primary', onclick: save }, t('保存'))),
        h('p', { class: 'settings-hint' }, t('群里和导出的记录里用这个名字显示你；留空就显示「你」。')), status),
      h('section', { class: 'about' },
        h('div', { class: 'about-head' }, brandMark(),
          h('div', null, h('div', { class: 'about-name' }, h('strong', null, PRODUCT), version),
            h('div', { class: 'settings-hint' }, t('AI 同席 · Codex & Claude, one room')))),
        h('ul', { class: 'about-facts' },
          h('li', null, t('作者：{0}', 'Ryan Zhang')),
          h('li', null, t('开源许可：MIT')),
          h('li', null, h('a', { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer' }, 'github.com/ryan-eziar/ThreadCrew'))),
        h('ol', { class: 'about-steps' },
          h('li', null, t('新建群聊。')),
          h('li', null, t('把进群口令分别贴到你要用的 Claude Code 和 Codex 会话里。')),
          h('li', null, t('发消息先讨论；要它们动手改，直接说明或点「开工」。'))),
        h('button', { type: 'button', class: 'btn', onclick: copyDiagnostics }, icon('copy', 14), t('复制诊断信息'))),
      UPDATES_SUPPORTED ? updateSection() : null,
      EXIT_SUPPORTED ? h('section', { class: 'settings-sec' },
        h('div', { class: 'settings-label' }, t('退出')),
        h('p', { class: 'settings-hint' }, t('关掉窗口时 ThreadCrew 会在后台继续运行。要完全停止它（所有群），用退出。')),
        h('div', null, h('button', { type: 'button', class: 'btn danger', onclick: () => { close(); askQuit(); } }, icon('power', 14), t('退出 ThreadCrew…')))) : null);
    let dispose = null;
    const close = () => { st.updateBox = null; settingsClose = null; dispose(); };
    dispose = openModal({ title: t('设置与关于'), body, onCancel: close, focus: input,
      actions: [h('button', { type: 'button', class: 'secondary', onclick: close }, t('关闭'))] });
    settingsClose = close;
    loadDiagnostics().then((d) => { if (d && d.version) version.textContent = ` v${d.version}`; });
    if (UPDATES_SUPPORTED) {
      loadUpdates();
      if (section === 'updates' && st.updateBox) {
        st.updateBox.scrollIntoView({ block: 'nearest' });
        const go = st.updateBox.querySelector('.update-go') || st.updateBox.querySelector('button');
        if (go) go.focus();
      }
    }
  }

  // ---- Quitting ThreadCrew --------------------------------------------------------------------------
  // Closing the window leaves the service running; Quit stops it for every room. The window asks the
  // broker what is pending, says what this window alone would lose (unsent text, attached files), and
  // on confirmation asks this broker instance, and no other, to stop under one shutdown ID. What
  // happens next comes from the broker only: the reply to that request, its status record, or the
  // service.shutdown event that every open window receives. A lost connection before a final answer is
  // "not confirmed", never "stopped". Quit is offered only where the broker says it can quit
  // (capabilities.shutdown); an older broker, or one run without a shutdown handler, has none here.
  const EXIT_SUPPORTED = capabilities.shutdown === true;
  const exiting = () => Boolean(st.exit);

  const QUIT_COUNTS = [
    ['activeWorkRooms', (n) => t('进行中的协作任务：{0} 个群', n)],
    ['queuedDeliveries', (n) => t('还没送达的消息：{0} 份（发给两位的算两份）', n)],
    ['inFlightDeliveries', (n) => t('代理正在回复的：{0} 份', n)],
    ['pendingWorkRequests', (n) => t('还没答复的协作请求：{0} 个', n)],
    ['pendingWorkResponses', (n) => t('还没送达的协作答复：{0} 个', n)],
    ['uncertainDeliveries', (n) => t('不确定是否送到的：{0} 份', n)],
  ];

  // What only this window holds: text typed and files attached but not sent, in any room it has open.
  function unsentHere() {
    const typed = new Set();
    let files = 0;
    for (const [roomId, v] of st.views) {
      const text = roomId === st.currentRoomId && $('input') ? $('input').value : v.draft || '';
      if (text.trim()) typed.add(roomId);
      files += (v.attach || []).length;
    }
    return { rooms: typed.size, files };
  }

  function quitLines(preview, failure) {
    const lines = [h('p', null, t('退出会停止 ThreadCrew 本身：所有群都会停下，不只是这个群。'))];
    if (preview) {
      const counts = QUIT_COUNTS.filter(([k]) => preview.counts && preview.counts[k] > 0).map(([k, text]) => h('li', null, text(preview.counts[k])));
      lines.push(counts.length ? h('ul', { class: 'quit-counts' }, counts) : h('p', null, t('现在没有排队或进行中的消息和任务。')));
      if (counts.length) lines.push(h('p', { class: 'quit-hint' }, t('这是 {0} 的情况，退出前还可能变化。', fmtTime(preview.capturedAt))));
    } else if (failure) {
      lines.push(h('p', { class: 'quit-warn' }, failure));
    }
    // What happens to what is pending, said only where it applies (all of it when the counts are unknown).
    const n = (k) => (preview && preview.counts ? preview.counts[k] || 0 : 1);
    const after = [
      n('queuedDeliveries') + n('pendingWorkRequests') + n('pendingWorkResponses') ? t('排队的消息和请求会留着，重新打开 ThreadCrew、代理能接收后再送达。') : null,
      n('activeWorkRooms') ? t('协作任务只在原来的授权还有效时继续，期限照常计时。') : null,
      n('uncertainDeliveries') ? t('不确定是否送到的不会自动重发。') : null,
      n('inFlightDeliveries') ? t('已经在生成的回复会在代理自己的应用里继续。') : null,
    ].filter(Boolean);
    lines.push(h('p', null, [t('已保存的消息和任务记录都会保留，Codex 和 Claude 自己的会话也不会被关掉。'), ...after].join(' ')));
    const local = unsentHere();
    if (local.rooms) lines.push(h('p', { class: 'quit-warn' }, t('这个窗口里有没发出的文字（{0} 个群），退出后会丢失。', local.rooms)));
    if (local.files) lines.push(h('p', { class: 'quit-warn' }, t('还有 {0} 个已添加、没发出的附件，重新打开后要再添加。', local.files)));
    lines.push(h('p', { class: 'quit-hint' }, t('只是关掉这个窗口的话，ThreadCrew 会在后台继续运行。')));
    return lines;
  }

  async function askQuit() {
    if (!EXIT_SUPPORTED || exiting() || document.querySelector('.modal')) return;
    const body = h('div', { class: 'modal-body quit-body' }, h('p', null, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', t('正在读取各群的情况…')));
    let closed = false;
    let dispose = null;
    const close = () => { if (!closed) { closed = true; dispose(); } };
    const cancelBtn = h('button', { type: 'button', class: 'secondary', onclick: close }, t('取消'));
    const quitBtn = h('button', { type: 'button', class: 'primary danger', disabled: true }, t('退出 ThreadCrew'));
    dispose = openModal({ title: t('退出 ThreadCrew？'), role: 'alertdialog', body, onCancel: close, focus: cancelBtn, actions: [cancelBtn, quitBtn] });
    const res = await src.shutdownPreview();
    if (closed) return;
    // A preview from another instance means this window belongs to a broker that has since been
    // replaced: it must not ask anything to stop.
    if (res.ok && res.result.instanceId !== boot.instanceId) {
      fill(body, h('p', { class: 'quit-warn' }, t('ThreadCrew 在这个窗口打开之后重启过。请先重新载入窗口，再退出。')));
      fill(quitBtn, t('重新载入'));
      quitBtn.className = 'primary';
      quitBtn.disabled = false;
      quitBtn.onclick = () => location.reload();
      return;
    }
    fill(body, ...quitLines(res.ok ? res.result : null, res.ok ? null : t('没能读取各群的情况（{0}），仍然可以退出。', res.error.code)));
    quitBtn.disabled = false;
    quitBtn.onclick = () => { close(); requestQuit(); };
  }

  function requestQuit(shutdownId = `shutdown-${uuid()}`) {
    st.exit = { phase: 'requesting', shutdownId, own: true, errorCode: null, slow: false, polling: false };
    renderExit();
    sendQuit();
  }

  async function sendQuit() {
    const x = st.exit;
    x.phase = 'requesting';
    renderExit();
    const res = await src.shutdown({ expectedInstanceId: boot.instanceId, shutdownId: x.shutdownId });
    if (st.exit !== x) return;
    // An event may have settled it meanwhile: this request's own acceptance, or another window's quit,
    // followed openly (own: false). A late answer then changes nothing, least of all a final state.
    if (!x.own || x.phase !== 'requesting') { if (x.phase === 'SHUTTING_DOWN') pollShutdown(x); return; }
    if (res.ok) { if (applyShutdown(res.result, 'request')) pollShutdown(x); return; }
    if (res.error.code === 'SHUTDOWN_IN_PROGRESS') {
      // Another window's quit holds this instance, and its service.shutdown event names it. Without
      // that event this window can't follow it, and says so instead of guessing.
      Object.assign(x, { own: false, shutdownId: null, phase: 'SHUTTING_DOWN' });
      renderExit();
      setTimeout(() => { if (st.exit === x && !x.shutdownId && x.phase === 'SHUTTING_DOWN') { x.phase = 'unknown'; renderExit(); } }, 15000);
      return;
    }
    if (res.error.outcome === 'unknown') { pollShutdown(x); return; } // no answer: its status record says whether it arrived
    st.exit = null;
    renderExit();
    flash(res.error.code === 'NOT_FOUND' ? t('这个 ThreadCrew 服务不能从窗口退出。') : t('没有退出：{0}', errorText(res.error.code)), 'bad');
  }

  // The shutdown record as the broker states it: the answer to this window's request, the status record,
  // or the service.shutdown event that every window of this instance receives. Only this instance counts.
  // An answer must carry the shutdown ID this window follows. An event with another ID means another
  // window's quit was accepted: this window then follows that one openly (own: false), and never shows
  // it as the result of its own request. A final state never changes back.
  function applyShutdown(s, via) {
    const x = st.exit;
    if (!s || s.instanceId !== boot.instanceId) {
      if (x && via !== 'event') { x.phase = 'mismatch'; renderExit(); }
      return false;
    }
    const final = Boolean(x && ['STOPPED', 'FAILED'].includes(x.phase));
    if (x && x.shutdownId && s.shutdownId !== x.shutdownId) {
      if (via !== 'event') { if (!final) { x.phase = 'mismatch'; renderExit(); } return false; }
      if (!final) Object.assign(x, { own: false, shutdownId: s.shutdownId });
    }
    if (final) return true;
    const next = { phase: s.status, errorCode: s.errorCode || null, shutdownId: s.shutdownId };
    if (x) Object.assign(x, next); else st.exit = { own: false, slow: false, polling: false, ...next };
    if (s.status !== 'SHUTTING_DOWN') {
      if (catalogStream) { catalogStream.close(); catalogStream = null; }
      if (roomStream) { roomStream.close(); roomStream = null; roomStreamGen += 1; }
    }
    renderExit();
    // Another window's quit is followed from here; this window's own request polls once its answer is in.
    if (s.status === 'SHUTTING_DOWN' && via === 'event' && !st.exit.own) pollShutdown(st.exit);
    return true;
  }

  // The bounded fallback beside the event: the broker's in-memory status record for the followed ID.
  // It stays readable for a short while after STOPPED; losing it before a final answer is "not confirmed".
  async function pollShutdown(x) {
    if (x.polling || !x.shutdownId) return;
    x.polling = true;
    try {
      for (let i = 0; i < 60; i++) {
        await sleep(i < 10 ? 500 : 1000);
        if (st.exit !== x || !['requesting', 'SHUTTING_DOWN'].includes(x.phase)) return;
        const id = x.shutdownId;
        const res = await src.shutdownStatus(boot.instanceId, id);
        if (st.exit !== x || !['requesting', 'SHUTTING_DOWN'].includes(x.phase)) return;
        if (x.shutdownId !== id) continue; // another window's quit was adopted meanwhile: ask about that one
        if (res.ok) { if (!applyShutdown(res.result, 'status')) return; continue; }
        if (res.error.code === 'SHUTDOWN_NOT_FOUND' && x.own && x.phase === 'requesting') x.phase = 'not_started';
        else x.phase = res.error.code === 'INSTANCE_MISMATCH' ? 'mismatch' : 'unknown';
        renderExit();
        return;
      }
      if (st.exit === x) { x.slow = true; renderExit(); }
    } finally {
      x.polling = false;
    }
  }

  function renderExit() {
    let screen = $('exit-screen');
    const x = st.exit;
    if (!x) { if (screen) screen.remove(); document.body.classList.remove('is-exiting'); return; }
    if (!screen) { screen = h('div', { id: 'exit-screen', class: 'exit-screen', role: 'alertdialog', 'aria-modal': 'true', 'aria-live': 'polite' }); document.body.append(screen); }
    document.body.classList.add('is-exiting');
    // Without the broker's final answer nothing here claims it stopped: the launcher checks that.
    const reopen = t('从快捷方式重新打开 ThreadCrew：启动器会核实它是否还在运行，还在就直接打开，否则先安全恢复再启动。');
    const views = {
      requesting: [t('正在退出 ThreadCrew…'), [t('正在请求停止。')], null, true],
      SHUTTING_DOWN: [t('正在退出 ThreadCrew…'), [t('先做完已经接下的事，再关闭数据库。通常几秒钟。'), x.own ? null : t('退出是在另一个窗口发起的。'),
        x.slow ? t('比平时久。可以再等一会儿，结果一到这里就会显示。') : null], null, true],
      STOPPED: [t('ThreadCrew 已停止'), [t('可以关掉这个窗口了。要再用时，从 ThreadCrew 的快捷方式重新打开。'), t('已保存的消息和任务记录都在。'),
        x.own ? null : t('退出是在另一个窗口发起的。')], null, false],
      FAILED: [t('ThreadCrew 没能正常停止'), [t('错误：{0}。它可能还在运行。', x.errorCode || 'SHUTDOWN_FAILED'), reopen, t('不要删除它的运行数据。')], null, false],
      unknown: [t('没能确认已经停止'), [t('ThreadCrew 确认之前连接就断了，所以不能确定它有没有停。'), reopen], null, false],
      mismatch: [t('没能确认已经停止'), [t('回应来自另一个 ThreadCrew 实例或另一次退出请求，所以这个窗口不能确定结果。'), reopen], null, false],
      not_started: [t('退出请求没有送到'), [t('ThreadCrew 没有收到这个窗口的退出请求。可以再试一次，或者返回。')], [
        h('button', { type: 'button', class: 'secondary', onclick: () => { st.exit = null; renderExit(); resyncCatalog(); if (view()) resyncRoom(view()); } }, t('返回')),
        h('button', { type: 'button', class: 'primary danger', onclick: () => sendQuit() }, t('再试一次'))], false],
    };
    const [title, lines, actions, busy] = views[x.phase] || views.unknown;
    fill(screen, h('div', { class: 'exit-card' },
      h('div', { class: 'exit-mark' }, brandMark()),
      h('div', { class: 'exit-title' }, busy ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, title),
      lines.filter(Boolean).map((line) => h('p', null, line)),
      actions ? h('div', { class: 'exit-actions' }, actions) : null));
  }

  // Once, until acknowledged (kept in the broker's settings, so a new port doesn't bring it back).
  function backgroundNotice() {
    if (!EXIT_SUPPORTED || !st.settings || st.settings.backgroundNoticeAcknowledged !== false || exiting()) return null;
    return [t('关掉这个窗口后，ThreadCrew 仍在后台运行。要停止它，用侧栏的「退出 ThreadCrew」。'), ' ',
      st.ops.has('settings-bg') ? h('span', { class: 'hint' }, t('处理中…')) : link(t('知道了'), acknowledgeBackground)];
  }

  function acknowledgeBackground() {
    runOp('settings-bg', '/settings', { operationId: uuid(), expectedVersion: st.settings.version, backgroundNoticeAcknowledged: true },
      (r) => { if (r && r.settings) st.settings = r.settings; }).then((res) => { if (res && !res.ok) loadSettings(); });
  }

  // ---- Updates ----------------------------------------------------------------------------------------
  // Only checking is automatic: the broker asks GitHub for the stable releases of ryan-eziar/ThreadCrew
  // at start and every six hours while autoCheckUpdates is on. Installing is always a click here, and the
  // broker decides whether it may: not while anything is pending, not over a Git checkout or changed
  // files. What the window shows comes from the broker's UpdateState alone. While ThreadCrew restarts, a
  // lost connection means "restarting", never "updated": the new service reports the outcome it saved,
  // and the window that reaches it shows that once. Offered only where the broker says it can
  // (capabilities.updates).
  const UPDATES_SUPPORTED = capabilities.updates === true;
  const INSTALL_ACTIVE = ['downloading', 'verifying', 'stopping', 'installing', 'restarting'];
  const INSTALL_DONE = ['completed', 'failed', 'rolled_back'];
  // Failures after which the running version may be the old one or the new one.
  const UNCERTAIN_UPDATE = ['UPDATE_ROLLBACK_FAILED', 'UPDATE_INTERRUPTED'];
  const INSTALL_STEPS = [['downloading', t('下载')], ['verifying', t('校验')], ['stopping', t('停止服务')], ['installing', t('安装')], ['restarting', t('重新启动')]];
  const UPDATE_ACK_KEY = 'agentchat.update.ack';     // the install outcome this browser acknowledged (its operation ID)
  const UPDATE_LATER_KEY = 'agentchat.update.later'; // the release this browser said "later" to
  const RELEASE_NOTES_MAX = 4000;
  const updateErrorText = (code) => (code ? errorText(code) : t('原因不明。'));
  let settingsClose = null; // closes an open Settings dialog before the update confirmation opens

  // The notice bar's update line: an install's outcome first (once, until acknowledged), then a release
  // that can be installed (until "later" for that version). Pure over its inputs, for the tests.
  function updateBanner(u, ackedId, laterVersion) {
    if (!u) return null;
    const job = u.install;
    if (job && INSTALL_DONE.includes(job.state) && ackedId !== job.operationId) return { kind: job.state, job };
    if (job && INSTALL_ACTIVE.includes(job.state)) return null;
    if (u.checkState === 'available' && u.latestVersion && laterVersion !== u.latestVersion) return { kind: 'available', version: u.latestVersion };
    return null;
  }

  function updateNotice() {
    if (!UPDATES_SUPPORTED || exiting() || st.updateFollow) return null;
    const u = st.updates;
    const b = updateBanner(u, store.get(UPDATE_ACK_KEY), store.get(UPDATE_LATER_KEY));
    if (!b) return null;
    if (b.kind === 'available') {
      return { tone: 'info', content: [t('ThreadCrew v{0} 可以更新了。', b.version), ' ', link(t('查看'), () => openSettings('updates')), ' · ',
        link(t('以后再说'), () => { store.set(UPDATE_LATER_KEY, b.version); render(); })] };
    }
    const ack = link(t('知道了'), () => { store.set(UPDATE_ACK_KEY, b.job.operationId); render(); });
    if (b.kind === 'completed') {
      const notes = u.releaseUrl && u.latestVersion === b.job.version
        ? [h('a', { href: u.releaseUrl, target: '_blank', rel: 'noopener noreferrer', class: 'link' }, t('看看有什么新内容')), ' · '] : [];
      return { tone: 'info', content: [t('ThreadCrew 已更新到 v{0}。', b.job.version), ' ', ...notes, ack] };
    }
    const why = b.kind === 'rolled_back' ? t('新版本没能正常启动，已退回 v{0}，群和记录都在。', u.installedVersion)
      : UNCERTAIN_UPDATE.includes(b.job.errorCode) ? t('{0} 现在运行的是 v{1}。如果用起来不对，从快捷方式重新打开 ThreadCrew，启动器会检查；不要删除它的运行数据。', updateErrorText(b.job.errorCode), u.installedVersion)
      : t('{0} 现在仍是 v{1}，群和记录都在。', updateErrorText(b.job.errorCode), u.installedVersion);
    return { tone: 'warn', content: [t('更新到 v{0} 没有完成。', b.job.version), ' ', why, ' ', ack] };
  }

  let updatesReadAt = 0;
  async function loadUpdates() {
    if (!UPDATES_SUPPORTED) return;
    const res = await src.updates();
    if (res.ok && res.result && res.result.updates) { updatesReadAt = Date.now(); applyUpdates(res.result.updates); }
  }

  // The broker's own first check starts a moment after it does, so a page that loaded first reads
  // "idle". Follow that first check with a few cached reads until it settles (about half a minute at
  // most); nothing here asks GitHub, and nothing is read when automatic checks are off.
  const FIRST_CHECK_WAITS = [3000, 5000, 8000, 15000];
  async function followFirstCheck(read = loadUpdates, wait = sleep) {
    for (const ms of FIRST_CHECK_WAITS) {
      const u = st.updates;
      if (!u || u.autoCheckUpdates !== true || !['idle', 'checking'].includes(u.checkState)) return;
      await wait(ms);
      await read();
    }
  }

  // A window left open for hours reads the cached state again when it comes back into view, at
  // most every ten minutes, so the six-hourly check's result reaches it.
  function refreshUpdatesIfStale() {
    if (UPDATES_SUPPORTED && !st.updateFollow && !exiting() && Date.now() - updatesReadAt > 10 * 60 * 1000) loadUpdates();
  }

  // A newer UpdateState from any answer. An install running in the service is followed by every open
  // window, since all of them lose the service while it restarts.
  function applyUpdates(u) {
    st.updates = u;
    const job = u.install;
    if (job && INSTALL_ACTIVE.includes(job.state) && !st.updateFollow) {
      st.updateFollow = { operationId: job.operationId, version: job.version, phase: job.state, own: false, lost: false, errorCode: null, polling: false };
      renderUpdateScreen();
      pollInstall(st.updateFollow);
    }
    fillUpdateBox();
    render();
  }

  async function checkUpdates() {
    if (st.updateChecking) return;
    st.updateChecking = true;
    fillUpdateBox();
    const res = await src.updatesCheck();
    st.updateChecking = false;
    if (res.ok && res.result && res.result.updates) applyUpdates(res.result.updates);
    else { fillUpdateBox(); flash(t('没能检查更新：{0}', updateErrorText(res.error && res.error.code)), 'warn'); }
  }

  function setAutoCheck(on) {
    if (st.settingsOk !== true) return;
    runOp('settings-updates', '/settings', { operationId: uuid(), expectedVersion: st.settings.version, autoCheckUpdates: on },
      (r) => { if (r && r.settings) st.settings = r.settings; })
      .then((res) => { if (res && !res.ok) loadSettings(); loadUpdates(); });
  }

  // The Updates part of Settings, refilled in place while the dialog is open.
  function updateSection() {
    st.updateBox = h('section', { class: 'settings-sec update-sec', 'aria-live': 'polite' });
    fillUpdateBox();
    return st.updateBox;
  }

  function fillUpdateBox() {
    const box = st.updateBox;
    if (!box) return;
    const u = st.updates;
    const parts = [h('div', { class: 'settings-label' }, t('更新'))];
    if (!u) { fill(box, ...parts, h('p', { class: 'settings-hint' }, t('正在读取…'))); return; }
    const checking = st.updateChecking || u.checkState === 'checking';
    const running = Boolean(u.install && INSTALL_ACTIVE.includes(u.install.state));
    parts.push(h('p', { class: 'update-status' }, checking ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', t('正在检查…')]
      : u.checkState === 'available' ? t('有新版本 v{0}，你现在用的是 v{1}。', u.latestVersion, u.installedVersion)
      : u.checkState === 'current' ? t('已是最新版本（v{0}）。', u.installedVersion)
      : u.checkState === 'error' ? t('没能检查更新：{0}', updateErrorText(u.errorCode))
      : t('现在用的是 v{0}，还没检查过更新。', u.installedVersion)));
    if (u.checkedAt) parts.push(h('p', { class: 'settings-hint' }, t('上次检查：{0}', fmtTime(u.checkedAt))));
    const actions = [];
    if (u.checkState === 'available' && u.installSupported) {
      actions.push(h('button', { type: 'button', class: 'primary update-go', 'data-key': 'go', disabled: running,
        onclick: () => { if (settingsClose) settingsClose(); askUpdate(); } }, t('更新到 v{0}…', u.latestVersion)));
    }
    actions.push(h('button', { type: 'button', class: 'btn', 'data-key': 'check', disabled: checking || running, onclick: checkUpdates }, t('立即检查')));
    if (u.checkState === 'available' && u.releaseUrl) actions.push(h('a', { class: 'btn', 'data-key': 'notes', href: u.releaseUrl, target: '_blank', rel: 'noopener noreferrer' }, t('版本说明')));
    parts.push(h('div', { class: 'update-actions' }, actions));
    if (u.checkState === 'available' && !u.installSupported) parts.push(...unsupportedLines(u.installUnsupportedReason));
    parts.push(h('label', { class: 'settings-check' },
      h('input', { type: 'checkbox', 'data-key': 'auto', checked: u.autoCheckUpdates === true, disabled: st.settingsOk !== true || st.ops.has('settings-updates'),
        onchange: (e) => setAutoCheck(e.target.checked) }), t('自动检查更新')));
    parts.push(h('p', { class: 'settings-hint' }, t('开着时，ThreadCrew 启动时和每 6 小时向 GitHub 查一次正式版本，只查版本号，不发送你的消息或文件。安装一定要你点。')));
    // Refilled whenever the state arrives: keep the keyboard focus on the same control.
    const focusKey = box.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    fill(box, ...parts);
    const again = focusKey && box.querySelector(`[data-key="${focusKey}"]`);
    if (again && !again.disabled) again.focus();
  }

  // Why this copy can't install by itself, and what to do instead. A clean official Git clone on main
  // updates like a ZIP install; one with local changes, commits, another branch or remote does not.
  function unsupportedLines(reason) {
    const text = reason === 'GIT_WORKTREE_UNSAFE'
      ? t('这份 ThreadCrew 是用 Git 装的，但里面有本地改动、本地提交，或者不在官方仓库的 main 分支上。为了不覆盖你的东西，这里不自动更新。请先用 Git 自己处理，比如提交或还原改动后运行 git pull --ff-only，再退出 ThreadCrew，从快捷方式打开。')
      : reason === 'UNSUPPORTED_PLATFORM' ? t('自动安装目前只支持 Windows。请从版本页面下载新版本。')
      : reason === 'UNMANAGED_INSTALL' ? t('这份 ThreadCrew 不是用安装包或官方 Git 仓库装的，不能自己更新。请从版本页面下载新版本。')
      : t('这份 ThreadCrew 不能自动更新（{0}）。请从版本页面下载新版本。', reason || '—');
    return [h('p', { class: 'settings-hint' }, text)];
  }

  // What is still pending, from the broker's update preview: its busy rooms, else the Quit counts. The
  // broker refuses a busy update anyway and checks again right before it stops.
  const busyCounts = (preview) => QUIT_COUNTS.filter(([k]) => preview && preview.counts && preview.counts[k] > 0);
  const isBusy = (preview) => Boolean(preview && ((Array.isArray(preview.rooms) && preview.rooms.length) || busyCounts(preview).length));
  // A busy room and what is pending in it. The preview's `agents` are the room's members, not who is
  // busy, so no one is named.
  function busyRoomText(r) {
    const parts = [r.unresolvedDeliveries ? t('{0} 份等回复', r.unresolvedDeliveries) : null,
      r.queuedDeliveries ? t('{0} 份排队', r.queuedDeliveries) : null,
      r.pendingWorkRequests ? t('{0} 个协作请求没完成', r.pendingWorkRequests) : null,
      r.activeWork ? t('有进行中的协作任务') : null].filter(Boolean);
    return [t('「{0}」', r.roomName || r.roomId), ...(parts.length ? parts : [t('还有没完成的事')])].join(' · ');
  }
  function busyList(preview) {
    if (preview && Array.isArray(preview.rooms) && preview.rooms.length) return h('ul', { class: 'quit-counts' }, preview.rooms.map((r) => h('li', null, busyRoomText(r))));
    const counts = busyCounts(preview);
    return counts.length ? h('ul', { class: 'quit-counts' }, counts.map(([k, text]) => h('li', null, text(preview.counts[k])))) : null;
  }

  // The confirmation: what restarting means, what is still pending, what only this window would lose,
  // and the release's own notes (as plain text).
  async function askUpdate() {
    const u = st.updates;
    if (!UPDATES_SUPPORTED || !u || u.checkState !== 'available' || !u.installSupported || st.updateFollow || exiting() || document.querySelector('.modal')) return;
    const version = u.latestVersion;
    const body = h('div', { class: 'modal-body quit-body' }, h('p', null, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', t('正在读取各群的情况…')));
    let closed = false;
    let dispose = null;
    const close = () => { if (!closed) { closed = true; dispose(); } };
    const cancelBtn = h('button', { type: 'button', class: 'secondary', onclick: close }, t('取消'));
    const goBtn = h('button', { type: 'button', class: 'primary', disabled: true }, t('更新并重新启动'));
    dispose = openModal({ title: t('更新到 v{0}？', version), role: 'alertdialog', body, onCancel: close, focus: cancelBtn, actions: [cancelBtn, goBtn] });
    const res = await src.updatesPreview();
    if (closed) return;
    if (res.ok && res.result.instanceId !== boot.instanceId) {
      fill(body, h('p', { class: 'quit-warn' }, t('ThreadCrew 在这个窗口打开之后重启过。请先重新载入窗口。')));
      fill(goBtn, t('重新载入'));
      goBtn.disabled = false;
      goBtn.onclick = () => location.reload();
      return;
    }
    fill(body, ...updateLines(u, res.ok ? res.result : null, res.ok ? null : res.error.code));
    goBtn.disabled = isBusy(res.ok ? res.result : null);
    goBtn.onclick = () => { close(); requestInstall(version); };
  }

  function updateLines(u, preview, previewError) {
    const lines = [h('p', null, t('ThreadCrew 会停下来安装新版本，再自己重新启动，所有群会暂停一会儿。已保存的消息和任务记录都会保留，Codex 和 Claude 自己的会话也不会被关掉。'))];
    if (u.installKind === 'git') lines.push(h('p', null, t('这份是官方 Git 仓库的副本：会快进到 v{0} 的正式版本标签，并核对文件和发布清单一致。', u.latestVersion)));
    else if (u.installKind === 'zip') lines.push(h('p', null, t('只替换 ThreadCrew 的程序文件，先校验下载的版本包；你的群、记录、附件和设置都不动，旧版本会留一份备份。')));
    if (isBusy(preview)) {
      lines.push(h('p', { class: 'quit-warn' }, t('现在还有没完成的，暂时不能更新：')));
      lines.push(busyList(preview));
      lines.push(h('p', { class: 'quit-hint' }, t('等它们完成，或者停止相关的群，再来更新。这是 {0} 的情况。', fmtTime(preview.capturedAt))));
    } else if (previewError) {
      lines.push(h('p', { class: 'quit-warn' }, t('没能读取各群的情况（{0}）。可以继续，ThreadCrew 开始前会再检查一次。', previewError)));
    }
    const local = unsentHere();
    if (local.rooms) lines.push(h('p', { class: 'quit-warn' }, t('这个窗口里有没发出的文字（{0} 个群），重新启动后会丢失。', local.rooms)));
    if (local.files) lines.push(h('p', { class: 'quit-warn' }, t('还有 {0} 个已添加、没发出的附件，重新启动后要再添加。', local.files)));
    const notes = (u.releaseNotes || '').trim();
    if (notes) {
      const cut = [...notes].length > RELEASE_NOTES_MAX ? `${[...notes].slice(0, RELEASE_NOTES_MAX).join('')}…` : notes;
      lines.push(h('details', { class: 'update-notes' }, h('summary', null, t('这个版本的说明')), h('div', { class: 'update-notes-text' }, cut),
        u.releaseUrl ? h('a', { href: u.releaseUrl, target: '_blank', rel: 'noopener noreferrer', class: 'link' }, t('在 GitHub 上看完整说明')) : null));
    }
    lines.push(h('p', { class: 'quit-hint' }, t('装好后 ThreadCrew 会自己打开新窗口（地址可能会变）。如果没有打开，就从 ThreadCrew 的快捷方式打开。')));
    return lines;
  }

  function requestInstall(version) {
    st.updateFollow = { operationId: uuid(), version, phase: 'requesting', own: true, lost: false, errorCode: null, polling: false };
    sendInstall(st.updateFollow);
  }

  async function sendInstall(f) {
    f.phase = 'requesting';
    renderUpdateScreen();
    const res = await src.updatesInstall({ operationId: f.operationId, expectedVersion: f.version });
    if (st.updateFollow !== f) return;
    if (res.ok && res.result && res.result.updates) {
      st.updates = res.result.updates;
      const job = st.updates.install;
      if (job && job.operationId === f.operationId) { f.phase = job.state; f.errorCode = job.errorCode || null; }
      renderUpdateScreen();
      pollInstall(f);
      return;
    }
    const code = res.error && res.error.code;
    // Another install holds the service (another window's): follow that one openly.
    if (code === 'UPDATE_IN_PROGRESS') { f.own = false; pollInstall(f); return; }
    // No answer: whether it arrived is in the install status.
    if (res.error && res.error.outcome === 'unknown') { pollInstall(f); return; }
    st.updateFollow = null;
    renderUpdateScreen();
    loadUpdates();
    showUpdateRefusal(res.error || { code: 'NETWORK' });
  }

  // A refusal before anything started: what it was, and for a busy service what is still pending.
  function showUpdateRefusal(error) {
    if (document.querySelector('.modal')) { flash(errorText(error.code), 'warn'); return; }
    const preview = error.details && (error.details.counts || error.details.rooms) ? error.details : null;
    const body = h('div', { class: 'modal-body quit-body' }, h('p', null, errorText(error.code)),
      isBusy(preview) ? busyList(preview) : null,
      error.code === 'UPDATE_BUSY' ? h('p', { class: 'quit-hint' }, t('等它们完成，或者停止相关的群，再来更新。')) : null);
    let dispose = null;
    const ok = h('button', { type: 'button', class: 'primary', onclick: () => dispose() }, t('知道了'));
    dispose = openModal({ title: t('没有开始更新'), role: 'alertdialog', body, onCancel: () => dispose(), focus: ok, actions: [ok] });
  }

  // Every two seconds while an install runs and this window is open. No answer while it stops, installs
  // or restarts is the restart itself: "restarting", never "updated". A new service that no longer
  // accepts this page's token is back: reloading shows the outcome it saved.
  async function pollInstall(f) {
    if (f.polling) return;
    f.polling = true;
    let misses = 0;
    try {
      while (st.updateFollow === f && (f.phase === 'requesting' || INSTALL_ACTIVE.includes(f.phase))) {
        await sleep(2000);
        if (st.updateFollow !== f) return;
        const res = await src.updatesInstallStatus();
        if (st.updateFollow !== f) return;
        if (res.ok && res.result && res.result.updates) {
          misses = 0;
          f.lost = false;
          st.updates = res.result.updates;
          const job = st.updates.install;
          if (job && job.operationId !== f.operationId && INSTALL_ACTIVE.includes(job.state)) Object.assign(f, { operationId: job.operationId, version: job.version, own: false });
          if (job && job.operationId === f.operationId) { f.phase = job.state; f.errorCode = job.errorCode || null; }
          else f.phase = f.phase === 'requesting' && f.own ? 'not_started' : 'unknown';
          renderUpdateScreen();
          continue;
        }
        const code = res.error && res.error.code;
        if (code === 'AUTH_REQUIRED' || code === 'FORBIDDEN') { f.phase = 'restarted'; break; }
        misses += 1;
        if (misses >= 2 && !f.lost) { f.lost = true; renderUpdateScreen(); }
        if (misses >= 150) break; // five minutes without an answer: the screen keeps saying what to do
      }
    } finally {
      f.polling = false;
    }
    renderUpdateScreen();
  }

  // What the update screen says in each phase of the install it follows. Pure over f, for the tests.
  function installView(f) {
    const other = f.own ? null : t('更新是在另一个窗口发起的。');
    const reopen = t('如果它没有自己打开新窗口，就从 ThreadCrew 的快捷方式打开。');
    if (f.phase === 'requesting' || INSTALL_ACTIVE.includes(f.phase)) {
      const lines = f.lost
        ? [t('ThreadCrew 正在重新启动，这个窗口暂时连不上它。准备好后它会自己打开新窗口，那时可以关掉这个。'), reopen]
        : [f.phase === 'requesting' ? t('正在请求更新。') : t('先下载、校验新版本，再停下 ThreadCrew 安装并重新启动。通常一两分钟。')];
      return { title: t('正在更新到 v{0}…', f.version), busy: true, steps: true, lines: [...lines, other], actions: [] };
    }
    switch (f.phase) {
      case 'completed':
        return { title: t('已更新到 v{0}', f.version), lines: [t('重新载入这个窗口，就能用新版本。')], actions: [['reload', t('重新载入'), 'primary']] };
      case 'failed':
        // After a failed rollback or a lost updater, which version runs isn't known: say what to do.
        return UNCERTAIN_UPDATE.includes(f.errorCode)
          ? { title: t('更新没有完成'), lines: [t('错误：{0}', updateErrorText(f.errorCode)), t('如果 ThreadCrew 用起来不对，从快捷方式重新打开它，启动器会检查并安全恢复。不要删除它的运行数据。'), other],
            actions: [['reload', t('重新载入'), 'primary']] }
          : { title: t('更新没有完成'), lines: [t('错误：{0}', updateErrorText(f.errorCode)), t('ThreadCrew 还在用原来的版本，群和记录都在。'), other], actions: [['back', t('返回'), 'primary']] };
      case 'rolled_back':
        return { title: t('新版本没能启动，已退回原来的版本'), lines: [f.errorCode ? t('错误：{0}', updateErrorText(f.errorCode)) : null, t('群和记录都在。'), other],
          actions: [['reload', t('重新载入'), 'primary']] };
      case 'restarted':
        return { title: t('ThreadCrew 已经重新启动'), lines: [t('重新载入这个窗口，就能看到更新的结果。'), t('如果已经打开了新窗口，也可以直接关掉这个。')],
          actions: [['reload', t('重新载入'), 'primary']] };
      case 'not_started':
        return { title: t('更新请求没有送到'), lines: [t('ThreadCrew 没有收到这个窗口的更新请求，什么都没有变。可以再试一次，或者返回。')],
          actions: [['back', t('返回'), 'secondary'], ['retry', t('再试一次'), 'primary']] };
      default:
        return { title: t('没能确认更新的结果'), lines: [t('这个窗口没能确认更新有没有完成。'), reopen], actions: [['reload', t('重新载入'), 'primary']] };
    }
  }

  function renderUpdateScreen() {
    let screen = $('update-screen');
    const f = st.updateFollow;
    if (!f) {
      if (screen) screen.remove();
      if (!st.exit) document.body.classList.remove('is-exiting');
      return;
    }
    if (!screen) { screen = h('div', { id: 'update-screen', class: 'exit-screen', role: 'alertdialog', 'aria-modal': 'true', 'aria-live': 'polite' }); document.body.append(screen); }
    document.body.classList.add('is-exiting');
    const v = installView(f);
    const handlers = {
      back: () => { st.updateFollow = null; renderUpdateScreen(); loadUpdates(); resyncCatalog(); if (view()) resyncRoom(view()); },
      reload: () => location.reload(),
      retry: () => sendInstall(f),
    };
    const now = INSTALL_STEPS.findIndex(([k]) => k === f.phase);
    fill(screen, h('div', { class: 'exit-card' },
      h('div', { class: 'exit-mark' }, brandMark()),
      h('div', { class: 'exit-title' }, v.busy ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, v.title),
      v.steps ? h('ol', { class: 'update-steps' }, INSTALL_STEPS.map(([k, label], i) =>
        h('li', { class: i < now ? 'is-done' : i === now ? 'is-now' : null, 'aria-current': i === now ? 'step' : null }, label))) : null,
      v.lines.filter(Boolean).map((line) => h('p', null, line)),
      v.actions.length ? h('div', { class: 'exit-actions' }, v.actions.map(([key, label, kind]) =>
        h('button', { type: 'button', class: kind, onclick: handlers[key] }, label))) : null));
  }

  async function createRoom() {
    const name = ((await askText(t('新群聊的名字（1–80 个字）'), '')) || '').trim();
    if (!name) return;
    if (codePoints(name) > 80) { flash(t('名字太长，最多 80 个字。'), 'warn'); return; }
    runOp('create-room', '/rooms', { operationId: uuid(), name }, (r) => {
      const room = r.room;
      if (room) st.catalog.rooms.set(room.id, room);
      openRoom(r.roomId || (room && room.id));
    });
  }

  async function renameRoom() {
    const c = control();
    const name = ((await askText(t('新的群名'), c.room.name)) || '').trim();
    if (!name || name === c.room.name) return;
    if (codePoints(name) > 80) { flash(t('名字太长，最多 80 个字。'), 'warn'); return; }
    runOp(rk('rename'), roomPath('/rename'), { operationId: uuid(), expectedRoomVersion: c.room.version, name });
  }

  async function archiveRoom() {
    const c = control();
    const running = c.possibleRunningCount || 0;
    const lines = [t('归档后这个群不再收发，两个席位会空出来。')];
    if (c.pendingCount) lines.push(t('还在排队的 {0} 条会取消。', c.pendingCount));
    if (running) lines.push(t('{0} 可能仍在生成，回来后标迟到、不转发。', (c.possibleRunningAgents || []).map((a) => NAMES[a]).join(t('、')) || running + t(' 条')));
    lines.push(t('归档不会关闭 Codex/Claude 的会话，历史会保留，可以随时恢复。'));
    if (!(await askConfirm({ title: t('归档「{0}」？', c.room.name), body: lines, confirm: t('归档'), danger: true }))) return;
    runOp(rk('archive'), roomPath('/archive'), {
      operationId: uuid(), expectedRoomVersion: c.room.version, expectedGate: c.room.gate, acknowledgePossibleRunning: running > 0,
    }, () => { st.panel = null; });
  }

  async function restoreRoom() {
    const c = control();
    if (!(await askConfirm({ title: t('恢复这个群？'), body: [t('恢复后两个席位是空的，需要重新进群；旧的排队和讨论不会恢复。')], confirm: t('恢复') }))) return;
    runOp(rk('restore'), roomPath('/restore'), { operationId: uuid(), expectedRoomVersion: c.room.version });
  }

  async function removeMember(m) {
    const c = control();
    const work = m.openWork || { queued: 0, possibleRunning: 0 };
    const lines = [t('会话：{0}', m.binding.label)];
    if (work.queued) lines.push(t('发给它、还在排队的 {0} 条会取消。', work.queued));
    if (work.possibleRunning) lines.push(t('它还有 {0} 条可能在生成；移出不会停止它，回来会标迟到。', work.possibleRunning));
    lines.push(t('移出不会关闭它的原会话，也不会删除聊天记录。'));
    if (!(await askConfirm({ title: t('把 {0} 移出「{1}」？', NAMES[m.agent], c.room.name), body: lines, confirm: t('移出'), danger: true }))) return;
    runOp(rk(`remove:${m.agent}`), roomPath(`/members/${m.agent}/remove`), {
      operationId: uuid(), expectedGate: c.room.gate, expectedBindingId: m.binding.id,
      expectedBindingVersion: m.binding.version, acknowledgePossibleRunning: work.possibleRunning > 0,
    }, () => { st.panel = null; });
  }

  // What the user pastes into a native session to bring it into this room: the exact join command
  // (paths from the broker's hint, quoted) and the manual to read first. Written in the user's voice.
  // An empty seat's line also carries that seat's own join version, so the other agent joining first
  // does not void it; a broker without one keeps the strict room gate alone.
  function joinLine(m) {
    const c = control();
    const hint = m.joinHint || {};
    const gate = hint.expectedGate || c.room.gate;
    const expected = hint.expectedBindingId && m.binding ? hint.expectedBindingId : 'null';
    const joinVersion = expected === 'null' && Number.isSafeInteger(hint.expectedJoinVersion) && hint.expectedJoinVersion > 0
      ? hint.expectedJoinVersion : null;
    const quote = (p) => `"${p}"`;
    const cmd = [`node ${hint.helperPath ? quote(hint.helperPath) : 'chat.mjs'} join`, `--room ${c.room.id}`, `--as ${m.agent}`,
      `--session ${t('<你当前原生会话的 ID>')}`, `--expected-binding ${expected}`, `--gate-segment ${gate.segmentId}`,
      `--gate-version ${gate.version}`, joinVersion ? `--join-version ${joinVersion}` : null,
      hint.runtimeDir ? `--runtime-dir ${quote(hint.runtimeDir)}` : null].filter(Boolean).join(' ');
    const where = hint.helperPath ? '' : t('在 {0} ', hint.projectDir || t('ThreadCrew 的安装目录'));
    return t('请进群「{0}」（room: {1}）：{2}运行 {3}。进群后先读 {4}，按里面的说明收发消息。如果提示 GATE_CHANGED 或 JOIN_CHANGED，请让我重新复制这句。',
      c.room.name, c.room.id, where, cmd, hint.protocolPath || 'docs/AGENT_PROTOCOL.md');
  }

  function addBudget(w, kind) {
    const [req, wake] = kind === 'requests' ? [BUDGET_STEP.requests, 0] : [0, BUDGET_STEP.wakes];
    runOp(rk(`budget:${kind}`), roomPath(`/work/${encodeURIComponent(w.id)}/budget`), {
      operationId: uuid(), expectedGate: control().room.gate, expectedWorkVersion: w.version, addRequests: req, addWakes: wake,
    });
  }

  async function releaseWork(w) {
    const running = w.possibleRunningAgents
      || w.participants.filter((p) => ['working', 'awaiting_review', 'blocked', 'unknown'].includes(p.workState)).map((p) => p.agent);
    const lines = [t('不再等待这项工作，解除它对本群的占用。')];
    if (running.length) lines.push(t('{0} 可能仍在运行；解除不会停止它们，之后回来的结果标迟到、不转发。', running.map((a) => NAMES[a]).join(t('、'))));
    if (!(await askConfirm({ title: t('解除这项任务？'), body: lines, confirm: t('解除'), danger: true }))) return;
    runOp(rk('release'), roomPath(`/work/${encodeURIComponent(w.id)}/release`), {
      operationId: uuid(), expectedGate: control().room.gate, expectedWorkVersion: w.version, acknowledgePossibleRunning: true,
    });
  }

  async function abandonRequest(w) {
    if (!(await askConfirm({ title: t('不再等待这条请求？'), body: [t('只释放等待，不会停止对方；它可能还在处理，需要的话到原应用停止。')], confirm: t('不再等待') }))) return;
    runOp(`rabandon:${w.requestId}`, roomPath(`/work/${encodeURIComponent(w.workId)}/requests/${encodeURIComponent(w.requestId)}/abandon`), {
      operationId: uuid(), expectedRequestVersion: w.requestVersion,
    });
  }

  async function resendRequest(w) {
    const risk = w.requestState === 'uncertain' || w.waitDisposition === 'abandoned';
    const ok = risk
      ? await askConfirm({ title: t('可能会重复发送'), body: [t('对方也许已经收到过这条请求。')], confirm: t('仍要重新发送'), danger: true })
      : await askConfirm({ title: t('重新发送这条请求？'), confirm: t('重新发送') });
    if (!ok) return;
    runOp(`rresend:${w.requestId}`, roomPath(`/work/${encodeURIComponent(w.workId)}/requests/${encodeURIComponent(w.requestId)}/resend`), {
      operationId: uuid(), expectedGate: control().room.gate, expectedRequestVersion: w.requestVersion, acknowledgeDuplicateRisk: risk,
    });
  }

  // What the broker counts as unread: replies, work answers, and a participant reporting completed.
  const countsUnread = (e) => e.kind === 'reply' || (e.kind === 'work' && Boolean(e.work)
    && (e.work.eventKind === 'response' || (e.work.eventKind === 'participant_state' && e.work.workState === 'completed')));

  // The first entry that was unread when the room was opened: the "new messages" line sits above it.
  // The broker's locator when it gives one (the same rule as its count), else the first loaded
  // entry of a counted kind after the read position at opening.
  function firstUnread(v) {
    if (!v) return null;
    if (v.unreadLoc) return (v.entries && v.entries.get(v.unreadLoc.timelineItemId)) || null;
    if (v.unreadFrom == null) return null;
    return v.sorted.find((e) => e.order > v.unreadFrom && countsUnread(e)) || null;
  }

  // "N unread · jump to the first": the broker's current locator, loaded or not (around pagination),
  // else the first loaded unread entry. The target is highlighted. Going there puts up the same
  // guard as opening the room (landUnread): nothing counts as read until it has arrived, after a
  // failed fetch neither, until the reader moves on their own.
  function jumpToUnread(v) {
    const summary = v && st.catalog.rooms.get(v.roomId);
    const loc = summary && summary.firstUnread;
    if (loc && loc.aroundCursor) {
      const landing = { state: 'fetching' };
      v.unreadLanding = landing;
      Promise.resolve(jumpTo(v, loc.aroundCursor, loc.timelineItemId)).then(() => {
        if (v.unreadLanding !== landing) return; // the reader moved on meanwhile
        if (view() === v && v.entries.has(loc.timelineItemId)) { v.unreadLanding = null; scheduleReadPosition(); }
        else landing.state = 'failed';
      });
      return;
    }
    const first = firstUnread(v);
    if (first) { jumpToEntry(v, first.id); highlight(first.id); }
  }

  // The read position is "read through" a timeline order: the highest order whose end has come into
  // view, or is already above it. A reply taller than the window counts once its end is seen; one
  // still running off the bottom does not. Every kind counts, so a work update or a system line seen
  // at the end of the room carries the position past the replies above it. Pure, for the tests.
  function seenThrough(items, viewBottom) {
    let highest = 0;
    for (const it of items) if (it.bottom <= viewBottom + 1) highest = Math.max(highest, it.order);
    return highest;
  }

  // Read position: only forward, only while the window is visible and focused. Asked for after a
  // scroll, a render, and the window coming back; at most once a second. It is sent for the room it
  // was measured in, and counts as posted only once the broker accepted it: a failed request leaves
  // the next trigger free to send it again.
  let readTimer = null;
  function scheduleReadPosition() {
    if (readTimer) return;
    readTimer = setTimeout(postReadPosition, 1000);
  }
  async function postReadPosition() {
    readTimer = null;
    const v = view();
    if (!v || !v.control || document.visibilityState !== 'visible' || !document.hasFocus() || exiting() || st.updateFollow) return;
    if (v.unreadLanding) return; // not landed on the first unread yet, and the reader hasn't moved: count nothing
    const tl = $('timeline');
    const box = tl.getBoundingClientRect();
    const items = [];
    for (const el of tl.querySelectorAll('[data-id]')) {
      const e = v.entries.get(el.dataset.id);
      if (e && Number.isSafeInteger(e.order)) items.push({ order: e.order, bottom: el.getBoundingClientRect().bottom });
    }
    const highest = seenThrough(items, box.bottom);
    const summary = st.catalog.rooms.get(v.roomId);
    const known = Math.max(v.readPosted, v.readSending, summary ? summary.readThroughOrder : 0);
    if (highest <= known) return;
    v.readSending = highest;
    const res = await src.post(`${src.roomPath(v.roomId)}/read-position`, { operationId: uuid(), throughOrder: highest });
    if (v.readSending === highest) v.readSending = 0;
    if (res && res.ok) v.readPosted = Math.max(v.readPosted, highest);
  }

  // ---- Attachments and copy ----------------------------------------------------------

  async function fetchAttachment(roomId, attachmentId, maxChars, sha256) {
    let text = '';
    let cursor = null;
    do {
      const res = await src.attachmentText(roomId, attachmentId, cursor);
      if (!res.ok) return { ok: false, error: errorText(res.error.code) };
      if (sha256 && res.result.sha256 !== sha256) return { ok: false, error: errorText('ATTACHMENT_CHANGED') };
      text += res.result.text;
      cursor = res.result.nextCursor;
    } while (cursor && text.length < maxChars);
    return { ok: true, text, more: Boolean(cursor) };
  }

  async function loadFull(entry, attachmentId) {
    const meta = (entry.attachments || []).find((a) => a.id === attachmentId);
    const roomId = st.currentRoomId;
    const at = { roomId, entryId: entry.id };
    setExpanded(attachmentId, { status: 'loading', ...at });
    invalidate(entry.id, roomId);
    const res = await fetchAttachment(roomId, attachmentId, EXPANDED_ITEM_CHARS, meta && meta.sha256);
    const now = st.expanded.get(attachmentId);
    if (!now || now.status !== 'loading') return; // collapsed or evicted meanwhile
    setExpanded(attachmentId, res.ok
      ? { status: 'done', text: cut(res.text, EXPANDED_ITEM_CHARS), capped: res.more || res.text.length > EXPANDED_ITEM_CHARS, ...at }
      : { status: 'error', error: res.error, ...at });
    invalidate(entry.id, roomId);
  }

  // Never split a surrogate pair at the cut.
  const cut = (t, n) => (t.length <= n ? t : t.slice(0, /[\uD800-\uDBFF]/.test(t[n - 1]) ? n - 1 : n));

  async function fullText(entry, attachmentId, roomId) {
    const meta = (entry.attachments || []).find((a) => a.id === attachmentId);
    return fetchAttachment(roomId, attachmentId, Infinity, meta && meta.sha256);
  }

  async function downloadFull(entry, content) {
    const id = content.attachmentId;
    if (st.downloading.has(id)) return;
    st.downloading.add(id);
    invalidate(entry.id);
    const res = await fullText(entry, id, st.currentRoomId);
    st.downloading.delete(id);
    invalidate(entry.id);
    if (!res.ok) { flash(t('没有下载：全文读取失败（{0}）', res.error), 'bad'); return; }
    const url = URL.createObjectURL(new Blob([res.text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}.${content.format === 'markdown' ? 'md' : 'txt'}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (err) {
      const area = h('textarea', { class: 'copy-buffer', readonly: true, 'aria-hidden': 'true' });
      area.value = text;
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      area.remove();
      return ok;
    }
  }

  async function copyContent(entry, content, key) {
    let text = content.previewText;
    if (content.truncated && content.attachmentId) {
      const cached = st.expanded.get(content.attachmentId);
      if (cached && cached.status === 'done' && !cached.capped) text = cached.text;
      else {
        const res = await fullText(entry, content.attachmentId, st.currentRoomId);
        if (!res.ok) { flash(t('没有复制：全文读取失败（{0}）', res.error), 'bad'); return; }
        text = res.text;
      }
    }
    if (!(await copyText(text))) { flash(t('没有复制：浏览器不允许访问剪贴板。'), 'bad'); return; }
    st.copied = key;
    invalidate(entry.id);
    setTimeout(() => { if (st.copied === key) { st.copied = null; invalidate(entry.id); } }, 1500);
  }

  function invalidate(entryId, roomId = st.currentRoomId) {
    const v = st.views.get(roomId);
    if (v) v.cache.delete(entryId);
    if (roomId === st.currentRoomId) render({ keepAnchor: true });
  }

  // ---- Rendering: entries ------------------------------------------------------------

  function body(text, key, format) {
    if (!MD || format !== 'markdown' || st.raw.has(key)) return h('div', { class: 'text' }, text);
    return h('div', { class: 'md' }, MD.render(MD.parse(text), h, {
      onCopyCode: async (code) => { if (await copyText(code)) flash(t('代码已复制。')); },
    }));
  }

  function contentTools(entry, content, key, extra = null) {
    return h('span', { class: 'msg-tools' },
      MD && content.format === 'markdown' ? link(st.raw.has(key) ? t('排版') : t('原文'), () => {
        if (st.raw.has(key)) st.raw.delete(key); else st.raw.add(key);
        invalidate(entry.id);
      }) : null,
      st.copied === key ? h('span', { class: 'copied' }, t('已复制')) : link(t('复制'), () => copyContent(entry, content, key)),
      extra);
  }

  function renderContent(entry, content, key) {
    const box = body(content.previewText, key, content.format);
    if (!content.truncated || !content.attachmentId) return box;
    const id = content.attachmentId;
    const s = st.expanded.get(id);
    const meta = (entry.attachments || []).find((a) => a.id === id);
    const size = meta ? ` · ${Math.ceil(meta.bytes / 1024)} KB` : '';
    if (s && s.status === 'done') {
      return h('div', null, body(s.text, key, content.format),
        h('div', { class: 'more-row' },
          s.capped ? h('span', null, t('只显示前 {0} 字{1}；完整内容请用「复制」或', EXPANDED_ITEM_CHARS.toLocaleString('en'), size)) : null,
          s.capped ? (st.downloading.has(id) ? h('span', null, t('正在准备下载…')) : link(t('下载全文'), () => downloadFull(entry, content))) : null,
          link(t('收起'), () => { st.expanded.delete(id); invalidate(entry.id); })));
    }
    const action = !s ? link(t('展开全文{0}', size), () => loadFull(entry, id))
      : s.status === 'loading' ? h('span', null, t('正在读取全文…'))
      : h('span', { class: 'error' }, t('全文暂不可读：{0} ', s.error), link(t('重试'), () => { st.expanded.delete(id); loadFull(entry, id); }));
    return h('div', null, box, h('div', { class: 'more-row' }, h('span', null, t('预览只显示前一部分。')), action));
  }

  function refLink(ref, label) {
    if (!ref) return null;
    const v = view();
    return link(label, () => jumpTo(v, ref.aroundCursor, ref.timelineItemId || ref.itemId), { class: 'link reply-to', title: t('跳到原消息') });
  }

  function renderDeliveryChip(d) {
    let dv = deliveryView(d);
    // v2 may omit BLOCKED_BY_DELIVERY; the member's blocking delivery says the same thing.
    if (d.state === 'queued' && !d.reason && d.waitDisposition !== 'abandoned') {
      const m = control() && control().members.find((x) => x.agent === d.agent);
      if (m && m.blockingDeliveryId && m.blockingDeliveryId !== d.id) dv = { text: t('排队中 · {0} 在回复上一条', NAMES[d.agent]), tone: 'pending' };
    }
    let tone = dv.tone;
    const parts = [h('strong', null, NAMES[d.agent]), dv.text];
    const waiting = d.waitDisposition === 'waiting' && d.waitingSince && ['awaiting_reply', 'uncertain'].includes(d.state);
    const minutes = waiting ? minutesSince(d.waitingSince) : null;
    if (d.state === 'awaiting_reply' && minutes >= 1) parts.push(t('· {0} 分钟', minutes));
    // A long wait on an awaiting reply offers the resume line first (the agent may have lost track of
    // it), next to giving up the wait. Shown by the same threshold; nothing happens by itself.
    if (d.state === 'awaiting_reply' && waiting && minutes >= ABANDON_SHOW_MIN) {
      const m = control() && control().members.find((x) => x.agent === d.agent);
      if (m && m.binding && m.recoveryHint && !dueNow(m.agent)) parts.push(link(t('复制恢复口令'), () => copyResume(m), { title: t('它没回的消息，让它接着回') }));
    }
    if (d.actions && d.actions.abandon.enabled && waiting && (d.state === 'uncertain' || minutes >= ABANDON_SHOW_MIN)) {
      if (minutes >= ABANDON_STRESS_MIN) tone = 'warn';
      parts.push(actionState(`abandon:${d.id}`) || link(t('不再等待'), () => abandon(d), { title: t('只释放排队位置，不会停止对方') }));
    }
    if (d.actions && d.actions.resend.enabled) {
      const label = d.state === 'uncertain' && d.waitDisposition === 'waiting' ? t('放弃旧等待并重新发送') : t('重新发送');
      parts.push(actionState(`resend:${d.id}`) || link(label, () => resend(d)));
    }
    return h('span', { class: `chip tone-${tone}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), parts);
  }

  const MENTION_RE = /[@＠](codex|claude)(?![A-Za-z])/gi;
  function markMentions(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('code, pre, .md-code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      MENTION_RE.lastIndex = 0;
      if (MENTION_RE.test(n.data)) hits.push(n);
    }
    for (const n of hits) {
      MENTION_RE.lastIndex = 0;
      const parts = [];
      let at = 0;
      for (let m = MENTION_RE.exec(n.data); m; m = MENTION_RE.exec(n.data)) {
        if (m.index > at) parts.push(document.createTextNode(n.data.slice(at, m.index)));
        const agent = m[1].toLowerCase();
        parts.push(h('span', { class: `mention mention-${agent}` }, `@${NAMES[agent]}`));
        at = m.index + m[0].length;
      }
      if (at < n.data.length) parts.push(document.createTextNode(n.data.slice(at)));
      n.replaceWith(...parts);
    }
    MENTION_RE.lastIndex = 0;
    return root;
  }

  function renderMessage(e) {
    const m = e.message;
    return h('article', { class: 'msg from-ryan', 'data-id': e.id },
      h('div', { class: 'meta' },
        h('span', null, t('发给 {0}', AGENTS.filter((a) => m.recipients.includes(a)).map((a) => NAMES[a]).join(t('、')))),
        e.resendOf ? refLink(e.resendOf, t('重新发送（原「{0}」）', snippet(e.resendOf.previewText))) : null,
        h('span', { class: 'ts' }, fmtTime(m.createdAt)),
        contentTools(e, m.content, m.id)),
      h('div', { class: 'bubble' }, markMentions(renderContent(e, m.content, m.id))),
      renderAttachments(e, m.content),
      h('div', { class: 'deliveries' }, (e.deliveries || []).slice()
        .sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent)).map(renderDeliveryChip)));
  }

  function renderReply(e) {
    const r = e.reply;
    const ex = e.exchange;
    const late = LATE.find(([key]) => (r.lateReasons || []).includes(key));
    const tags = [];
    if (late) tags.push(h('span', { class: 'tag muted' }, t('{0} · 未转发', late[1])));
    if (r.done) tags.push(h('span', { class: 'tag' }, ex && ex.finishPolicy === 'both_same_round' ? t('表示无需继续') : t('没有更多意见')));
    const who = e.replyTo ? NAMES[e.replyTo.agent] : null;
    return h('article', { class: `msg from-agent from-${r.agent}${late ? ' is-late' : ''}`, 'data-id': e.id, 'data-reply-order': String(e.order) },
      h('div', { class: 'meta' },
        h('strong', { class: `name name-${r.agent}` }, NAMES[r.agent]),
        r.round ? h('span', { class: 'round' }, t('第 {0}/{1} 轮', r.round, ex ? ex.maxRounds : '?')) : null,
        e.replyTo ? refLink(e.replyTo, t('回复 {0}「{1}」', who, snippet(e.replyTo.previewText))) : null,
        h('span', { class: 'ts' }, fmtTime(r.committedAt)),
        contentTools(e, r.content, r.id, link(t('按这个方案开工'), () => kickoffWith(e, r), { title: t('把这条回复的全文放进输入框，作为开工内容') }))),
      h('div', { class: 'bubble' }, renderContent(e, r.content, r.id)),
      renderAttachments(e, r.content),
      tags.length ? h('div', { class: 'tags' }, tags) : null);
  }

  const divider = (text, id) => h('div', { class: 'divider', role: 'separator', 'data-id': id }, h('span', null, text));
  const systemLine = (text, tone, at, id) =>
    h('div', { class: `system tone-${tone || 'info'}`, 'data-id': id }, at ? h('span', { class: 'ts' }, fmtTime(at)) : null, h('span', null, text));

  function renderSystem(e) {
    const s = e.system;
    const data = s.data || {};
    switch (s.systemType) {
      case 'segment_opened': return data.previousSegmentId ? divider(t('已停止 · 新的一段'), e.id) : null;
      case 'room_stopped': {
        const stopStatus = e.stopStatus || {};
        const who = stopStatus.possibleRunningAgents || [];
        let text = t('已停止：还没发出的消息和讨论都已取消。正在生成的回复要到原应用停止。发新消息可继续聊天。');
        if (who.length) text += t('\n{0} 可能仍在回复；回来后只显示、不转发。', who.map((a) => NAMES[a]).join(t('、')));
        return h('div', { class: 'system tone-stop', role: 'status', 'data-id': e.id }, h('span', { class: 'ts' }, fmtTime(e.at)), h('span', null, text));
      }
      case 'exchange_started': return divider(t('{0} · 最多 {1} 轮', e.exchange && e.exchange.previousExchangeId ? t('再讨论') : t('讨论开始'), e.exchange ? e.exchange.maxRounds : '?'), e.id);
      case 'exchange_ended': return divider(e.exchange ? exchangeEndText(e.exchange) : t('讨论结束'), e.id);
      case 'binding_changed': {
        const m = control() && control().members.find((x) => x.agent === data.agent);
        const label = m && m.binding && m.binding.id === data.bindingId ? t('（{0}）', m.binding.label) : '';
        return systemLine(t('{0} 进群{1}', NAMES[data.agent] || t('成员'), label), 'info', e.at, e.id);
      }
      case 'member_removed': return systemLine(t('{0} 已移出本群；它的原会话不受影响', NAMES[data.agent] || t('成员')), 'info', e.at, e.id);
      case 'room_archived': return divider(t('本群已归档'), e.id);
      case 'room_restored': return divider(t('本群已恢复 · 席位是空的'), e.id);
      case 'room_renamed': return systemLine(t('群名改为「{0}」', data.name || ''), 'info', e.at, e.id);
      case 'wait_expired': return systemLine(t('{0} 的等待已到期（{1}）。要继续，请在它的会话里重新进群。', NAMES[data.agent] || t('成员'), fmtTime(data.deadlineAt)), 'warn', e.at, e.id);
      case 'recovery_required': return systemLine(t('broker 需要恢复，操作已暂停。'), 'stop', e.at, e.id);
      default: return systemLine(s.text || s.systemType, 'info', e.at, e.id);
    }
  }

  // One of Ryan's messages by its ID: a link when this window has it loaded, plain text otherwise.
  function humanMessageLink(messageId, label) {
    const v = view();
    const entry = discussedEntry(null, messageId);
    return entry && v ? link(label, () => jumpToEntry(v, entry.id), { title: t('跳到原消息') }) : h('span', null, label);
  }

  // Why a work session exists when Ryan didn't press Kick off: both agents confirmed that his own
  // message asks them to start once they agree, and on which plan. Null for his own kickoffs.
  function workAuthority(a, withPlan) {
    if (!a || a.kind !== 'agent_confirmation') return null;
    return h('div', { class: 'work-auth' },
      h('span', null, t('两位都确认了你消息里的开工要求，自动开工。')), ' ',
      humanMessageLink(a.sourceHumanMessageId, t('查看这条消息')),
      withPlan && a.planPreview ? h('details', { class: 'work-plan' }, h('summary', null, t('两位确认的方案')), h('div', { class: 'work-plan-text' }, a.planPreview)) : null);
  }

  function renderWork(e) {
    const w = e.work;
    const who = NAMES[w.author] || w.author;
    const late = w.lateReason ? h('span', { class: 'tag muted' }, t('{0} · 未转发', WORK_LATE[w.lateReason] || t('迟到'))) : null;
    const text = w.content ? renderContent(e, w.content, e.id) : null;
    switch (w.eventKind) {
      case 'started': {
        const auto = Boolean(w.authority && w.authority.kind === 'agent_confirmation');
        return h('div', { class: `work-mark${auto ? ' is-auto' : ''}`, 'data-id': e.id },
          h('span', { class: 'work-badge' }, auto ? t('自动开工') : t('开工')), h('strong', null, snippet(w.content ? w.content.previewText : '', 60)),
          h('span', { class: 'ts' }, fmtTime(e.at)), auto ? workAuthority(w.authority, false) : null);
      }
      case 'accepted':
        return h('div', { class: `work-line from-${w.author}`, 'data-id': e.id }, h('strong', { class: `name name-${w.author}` }, who), t(' 已接单'), w.content ? [' · ', h('span', { class: 'muted' }, snippet(w.content.previewText, 80))] : null, h('span', { class: 'ts' }, fmtTime(e.at)));
      case 'progress':
        return h('div', { class: `work-line from-${w.author}`, 'data-id': e.id }, h('strong', { class: `name name-${w.author}` }, who), t(' 进度：'), h('span', null, snippet(w.content ? w.content.previewText : '', 120)), h('span', { class: 'ts' }, fmtTime(e.at)));
      case 'participant_state':
        return h('div', { class: `work-line from-${w.author}`, 'data-id': e.id }, h('strong', { class: `name name-${w.author}` }, who), t(' 状态：{0}', WORK_STATE[w.workState] || w.workState || ''), w.content && w.content.previewText ? [' · ', h('span', { class: 'muted' }, snippet(w.content.previewText, 80))] : null, h('span', { class: 'ts' }, fmtTime(e.at)));
      case 'ended': return divider(t('协作任务已结束'), e.id);
      case 'released': return divider(t('已解除这项任务的占用'), e.id);
      case 'budget_changed': return systemLine(t('协作额度已调整'), 'info', e.at, e.id);
      case 'needs_human':
        return h('article', { class: 'msg work-card needs-human', 'data-id': e.id },
          h('div', { class: 'meta' }, h('strong', null, t('{0} 需要你决定', who)), h('span', { class: 'ts' }, fmtTime(e.at))),
          h('div', { class: 'bubble' }, text),
          renderAttachments(e, w.content));
      case 'request': {
        const rs = requestStateView(w);
        let tone = rs.tone;
        const parts = [h('span', { class: 'dot', 'aria-hidden': 'true' }), rs.text];
        const waiting = w.waitDisposition === 'waiting' && w.waitingSince && ['claimed', 'awaiting_response', 'uncertain'].includes(w.requestState);
        const minutes = waiting ? minutesSince(w.waitingSince) : null;
        if (minutes >= 1) parts.push(t(' · {0} 分钟', minutes));
        if (w.actions && w.actions.abandon && w.actions.abandon.enabled && waiting && (w.requestState === 'uncertain' || minutes >= ABANDON_SHOW_MIN)) {
          if (minutes >= ABANDON_STRESS_MIN) tone = 'warn';
          parts.push(actionState(`rabandon:${w.requestId}`) || link(t('不再等待'), () => abandonRequest(w)));
        }
        if (w.actions && w.actions.resend && w.actions.resend.enabled) parts.push(actionState(`rresend:${w.requestId}`) || link(t('重新发送'), () => resendRequest(w)));
        return h('article', { class: `msg work-card from-${w.author}${late ? ' is-late' : ''}`, 'data-id': e.id },
          h('div', { class: 'meta' },
            h('strong', { class: `name name-${w.author}` }, who), ` → ${NAMES[w.recipient] || ''}`,
            h('span', { class: 'round' }, `${REQUEST_KIND[w.requestKind] || t('请求')} #${w.requestNumber || '?'}`),
            h('span', { class: 'ts' }, fmtTime(e.at)),
            w.content ? contentTools(e, w.content, e.id) : null),
          h('div', { class: 'bubble' }, text),
          renderAttachments(e, w.content),
          h('div', { class: 'deliveries left' }, h('span', { class: `chip tone-${tone}` }, parts)), late ? h('div', { class: 'tags' }, late) : null);
      }
      case 'response': {
        const rd = w.responseDelivery && RESPONSE_DELIVERY[w.responseDelivery.state];
        return h('article', { class: `msg work-card from-${w.author}${late ? ' is-late' : ''}`, 'data-id': e.id, 'data-reply-order': String(e.order) },
          h('div', { class: 'meta' },
            h('strong', { class: `name name-${w.author}` }, who), ` → ${NAMES[w.recipient] || ''}`,
            h('span', { class: 'round' }, t('答复 #{0}', w.requestNumber || '?')),
            w.replyTo ? refLink(w.replyTo, t('回应「{0}」', snippet(w.replyTo.previewText))) : null,
            h('span', { class: 'ts' }, fmtTime(e.at)),
            w.content ? contentTools(e, w.content, e.id) : null),
          h('div', { class: 'bubble' }, text),
          renderAttachments(e, w.content),
          rd ? h('div', { class: 'deliveries left' }, h('span', { class: `chip tone-${rd[1]}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), rd[0])) : null,
          late ? h('div', { class: 'tags' }, late) : null);
      }
      default: return systemLine(t('协作：{0}', w.eventKind), 'info', e.at, e.id);
    }
  }

  function renderEntry(e) {
    if (e.kind === 'message' && e.message) return renderMessage(e);
    if (e.kind === 'reply' && e.reply) return renderReply(e);
    if (e.kind === 'system' && e.system) return renderSystem(e);
    if (e.kind === 'work' && e.work) return renderWork(e);
    return null;
  }

  // Entries whose rendering depends on the clock (minute counters) are re-rendered by the timer.
  function timeDependent(e) {
    const waitingDelivery = (e.deliveries || []).some((d) => d.waitDisposition === 'waiting' && ['awaiting_reply', 'uncertain'].includes(d.state));
    const waitingRequest = e.work && e.work.waitDisposition === 'waiting' && ['claimed', 'awaiting_response', 'uncertain'].includes(e.work.requestState);
    return waitingDelivery || waitingRequest;
  }

  function cachedNode(v, e) {
    const hit = v.cache.get(e.id);
    if (hit && hit.version === e.version && !hit.timed) return hit.node;
    const node = renderEntry(e);
    v.cache.set(e.id, { version: e.version, node, timed: timeDependent(e) });
    return node;
  }

  // ---- Rendering: discussion, work bar, attention ------------------------------------

  function discussionReason(c, cand) {
    const code = cand.availability.reason;
    if (['MEMBER_NOT_READY', 'NO_BINDING', 'NO_CONNECTION', 'WAITER_UNARMED', 'WAIT_EXPIRED', 'AWAITING_REPLY', 'NATIVE_BUSY'].includes(code)) {
      const blocked = c.members.filter((m) => !m.canReceive);
      if (blocked.length) return blocked.map((m) => memberBlockText(m, true, dueNow(m.agent))).join(t('、'));
    }
    return reasonText(code);
  }

  // "Let them discuss" sits in the composer bar beside Kick off. A discussion is always about Ryan's
  // latest message (the broker's candidate) and needs both answers in and both agents able to receive.
  // When it can't run, the button stays where it is, muted, and its popover says why. A kickoff is never
  // offered: the replies to it are acceptances, and during the work the two talk to each other directly.
  function discussionInfo(c) {
    if (!c) return { mode: 'none' };
    if (c.activeExchange) return { mode: 'active', ex: c.activeExchange };
    const cand = c.discussionCandidate;
    if (!cand) return { mode: 'none' };
    // The broker marks a kickoff anchor KICKOFF_MESSAGE, during the work and after it; an older broker
    // only tells us through the current work.
    if (cand.availability.reason === 'KICKOFF_MESSAGE' || (c.currentWork && c.currentWork.sourceHumanMessageId === cand.baseMessageId)) return { mode: 'kickoff', cand };
    if (!cand.availability.enabled) return { mode: 'blocked', cand, reason: discussionReason(c, cand) };
    return { mode: 'ready', cand };
  }

  // The discussed message, if this window has it loaded.
  function discussedEntry(itemId, messageId) {
    const v = view();
    if (!v) return null;
    if (itemId && v.entries.has(itemId)) return v.entries.get(itemId);
    return (messageId && v.sorted.find((e) => e.kind === 'message' && e.message && e.message.id === messageId)) || null;
  }

  function discussedLine(info) {
    const v = view();
    const e = info.cand ? discussedEntry(info.cand.anchorItemId, info.cand.baseMessageId) : info.ex ? discussedEntry(null, info.ex.baseMessageId) : null;
    if (!v || !e) return info.cand ? h('p', { class: 'dp-about' }, t('讨论你最新发的那条消息。')) : null;
    const go = () => { setDiscussOpen(false); if (v.entries.has(e.id)) jumpToEntry(v, e.id); else if (info.cand) jumpTo(v, info.cand.anchorCursor, e.id); };
    return h('p', { class: 'dp-about' }, t('讨论的消息：'), link(`“${snippet(e.message.content.previewText, 70)}”`, go, { class: 'link dp-quote', title: t('跳到原消息'), 'data-key': 'quote' }));
  }

  function discussLabel(info, op) {
    if (info.mode === 'active') return t('讨论中 · {0}/{1}', info.ex.currentRound, info.ex.maxRounds);
    if (op && op.state !== 'sending') return t('讨论待确认');
    return info.cand && info.cand.previousExchangeId && info.mode !== 'kickoff' ? t('再讨论') : t('让他们讨论');
  }

  function renderDiscussButton(c) {
    const b = $('discuss-toggle');
    const info = discussionInfo(c);
    const op = st.ops.get(rk('discuss'));
    const muted = !op && ['none', 'blocked', 'kickoff'].includes(info.mode);
    $('discuss-label').textContent = discussLabel(info, op);
    b.className = `tool-toggle discuss-toggle${muted ? ' is-muted' : ''}${info.mode === 'active' ? ' is-live' : ''}${op && op.state !== 'sending' ? ' tone-warn' : ''}`;
    b.disabled = !c || c.room.lifecycle !== 'open';
    if (b.disabled && st.composer.discussOpen) st.composer.discussOpen = false;
    b.setAttribute('aria-expanded', String(st.composer.discussOpen));
    b.title = info.mode === 'blocked' ? t('现在不能讨论：{0}', info.reason) : info.mode === 'ready' ? t('让两位看到对方的回复，再各自回应') : '';
    renderDiscussPop(c, info, op);
  }

  function setDiscussOpen(open, focusBack = false) {
    if (st.composer.discussOpen === open) return;
    st.composer.discussOpen = open;
    const info = discussionInfo(control());
    st.composer.discussTarget = open ? (info.cand ? info.cand.baseMessageId : info.ex ? info.ex.baseMessageId : null) : null;
    renderComposer();
    if (open) {
      const pop = $('discuss-pop');
      const first = pop.querySelector('.dp-foot .primary:not(:disabled)') || pop.querySelector('.dp-close');
      if (first) first.focus();
    } else if (focusBack) $('discuss-toggle').focus();
  }

  function renderDiscussPop(c, info, op) {
    const pop = $('discuss-pop');
    const open = Boolean(c && st.composer.discussOpen);
    pop.hidden = !open;
    if (!open) { fill(pop); return; }
    const title = info.mode === 'active' ? t('讨论中 · 第 {0}/{1} 轮', info.ex.currentRound, info.ex.maxRounds)
      : info.cand && info.cand.previousExchangeId && info.mode !== 'kickoff' ? t('再讨论') : t('让他们讨论');
    const parts = [h('div', { class: 'dp-head' }, h('span', { class: 'dp-title' }, title),
      h('button', { type: 'button', class: 'icon-btn dp-close', 'data-key': 'close', 'aria-label': t('关闭'), title: t('关闭'), onclick: () => setDiscussOpen(false, true) }, icon('x', 14)))];
    if (info.mode === 'none') {
      parts.push(h('p', { class: 'dp-text' }, t('先发一条消息。两位都回复后，可以让他们看到对方的回复再回应，最多三轮。')));
    } else if (info.mode === 'kickoff') {
      parts.push(discussedLine(info), h('p', { class: 'dp-text' }, t('开工消息的回复是接单，不用讨论：开工期间两位会直接互相请求。想讨论别的，先发一条新消息。')));
    } else if (info.mode === 'blocked') {
      parts.push(discussedLine(info), h('p', { class: 'dp-reason' }, t('现在不能讨论：{0}', info.reason)));
    } else if (info.mode === 'active') {
      const ex = info.ex;
      const waiting = ex.waitingFor && ex.waitingFor.length ? t('等待 {0}', ex.waitingFor.map((a) => NAMES[a]).join(t('、'))) : t('正在转发');
      const round = (ex.rounds || []).find((r) => r.number === ex.currentRound);
      const done = round && round.finishVotes ? AGENTS.filter((a) => round.finishVotes[a] === true) : [];
      parts.push(discussedLine(info),
        h('p', { class: 'dp-status' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), waiting, done.length === 1 ? t(' · {0} 已表示无需继续', NAMES[done[0]]) : null),
        h('p', { class: 'dp-text' }, ex.finishPolicy === 'both_same_round' ? t('轮数用完，或者两位在同一轮都表示没有要补充的，讨论就结束。') : t('轮数用完，或者任何一方表示没有要补充的，讨论就结束。')),
        h('div', { class: 'dp-foot' }, h('span', { class: 'hint' }, t('想现在结束：')),
          btn(t('停止…'), stopDiscussion, { danger: true, 'data-key': 'stop', disabled: !writable() || !c.room.actions.stop.enabled || st.ops.has(rk('stop')) })));
    } else {
      const again = Boolean(info.cand.previousExchangeId);
      const sending = Boolean(op && op.state === 'sending');
      // The popover was opened for one message; if Ryan's latest message changed meanwhile (another
      // tab), say so and let him take the new one on purpose instead of starting on it silently.
      if (!st.composer.discussTarget) st.composer.discussTarget = info.cand.baseMessageId;
      const moved = st.composer.discussTarget !== info.cand.baseMessageId;
      parts.push(discussedLine(info),
        moved ? h('p', { class: 'dp-reason' }, t('你刚发了一条新消息，要讨论的已换成这条最新的。'), ' ',
          link(t('就讨论这条'), () => { st.composer.discussTarget = info.cand.baseMessageId; renderComposer(); }, { 'data-key': 'retarget' })) : null,
        h('p', { class: 'dp-text' }, again ? t('每位先看对方最新的回复，再回应。') : t('每位先看对方的回复，再回应。')),
        h('div', { class: 'dp-rounds', role: 'group', 'aria-label': t('讨论轮数') }, h('span', { class: 'dp-label' }, t('轮数')),
          [1, 2, 3].map((n) => h('button', { type: 'button', class: 'dp-round', 'data-key': `round-${n}`, 'aria-pressed': String(n === st.rounds), disabled: sending, onclick: () => { st.rounds = n; renderComposer(); } }, String(n)))),
        h('div', { class: 'dp-foot' }, (op && actionState(rk('discuss'))) || h('span', { class: 'hint' }, t('最多再触发 {0} 次代理回复', st.rounds * 2)),
          h('button', { type: 'button', class: 'primary', 'data-key': 'start', disabled: !writable() || Boolean(op) || moved, onclick: () => startDiscussion(info.cand) }, sending ? t('正在开始…') : t('开始讨论'))));
    }
    // The popover is rebuilt on every render (the room keeps updating): keep the keyboard focus on the
    // same control, or a keyboard user loses their place while the room updates.
    const focusKey = pop.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    fill(pop, ...parts.filter(Boolean));
    const again = focusKey && pop.querySelector(`[data-key="${focusKey}"]`);
    if (again && !again.disabled) again.focus();
    placeDiscussPop();
  }

  // Above the composer, lined up with the button, inside the composer column.
  function placeDiscussPop() {
    const pop = $('discuss-pop');
    const box = pop.parentElement.getBoundingClientRect();
    const b = $('discuss-toggle').getBoundingClientRect();
    const left = Math.max(12, Math.min(b.left - box.left - 10, box.width - pop.offsetWidth - 12));
    pop.style.left = `${Math.round(left)}px`;
  }

  // The room's Stop is the only way to end a discussion early, and it stops everything in the room, so
  // this asks first and says so.
  async function stopDiscussion() {
    const c = control();
    if (!c) return;
    const work = c.currentWork && !['completed', 'stopped', 'expired'].includes(c.currentWork.coordinationState);
    const ok = await askConfirm({ title: t('停止本群？'), body: [
      t('讨论会结束，还没送达的消息也会一起取消。'), work ? t('进行中的协作任务也会停止。') : null,
      t('已经在生成的回复要到原应用里停。')], confirm: t('停止'), danger: true });
    if (!ok) return;
    setDiscussOpen(false);
    stop();
  }

  function renderExchangeStatus(ex) {
    const waiting = ex.waitingFor && ex.waitingFor.length ? t('等待 {0}', ex.waitingFor.map((a) => NAMES[a]).join(t('、'))) : t('正在转发');
    const parts = [h('span', { class: 'pulse', 'aria-hidden': 'true' }), t('讨论进行中 · 第 {0}/{1} 轮 · {2}', ex.currentRound, ex.maxRounds, waiting)];
    const round = (ex.rounds || []).find((r) => r.number === ex.currentRound);
    if (round && round.finishVotes) {
      const done = AGENTS.filter((a) => round.finishVotes[a] === true);
      if (done.length === 1) parts.push(t(' · {0} 已表示无需继续', NAMES[done[0]]));
    }
    return h('div', { class: 'exchange-status', role: 'status' }, parts);
  }

  // An allowance as a small track: how much is left of the limit.
  function meter(label, left, limit) {
    const pct = limit > 0 ? Math.max(0, Math.min(100, Math.round((left / limit) * 100))) : 0;
    return h('span', { class: `meter${pct <= 20 ? ' is-low' : ''}`, title: `${label} ${left}/${limit}` },
      h('span', { class: 'meter-label' }, label),
      h('span', { class: 'meter-track', 'aria-hidden': 'true' }, h('span', { class: 'meter-fill', style: `width:${pct}%` })),
      h('span', { class: 'meter-num' }, `${left}/${limit}`));
  }

  // The work session lives in the header as a small chip; its details open as a popover, so
  // nothing sits over the conversation or looks like a message.
  function renderStatusChips(c) {
    const chips = [];
    const w = c.currentWork;
    if (w) {
      const paused = w.coordinationState === 'paused_budget';
      const open = Boolean(st.panel && st.panel.kind === 'work');
      chips.push(h('button', {
        type: 'button', class: `status-chip is-work${paused || ['stopped', 'expired', 'recovery_required'].includes(w.coordinationState) ? ' tone-warn' : ''}`, 'aria-expanded': String(open), title: w.objective,
        onclick: () => { st.panel = open ? null : { kind: 'work' }; render(); },
      }, icon('zap', 14), h('span', { class: 'chip-label' }, t('协作任务')),
        h('span', { class: 'chip-sub' }, w.coordinationState === 'active' ? timeLeft(w.expiresAt) : (COORDINATION[w.coordinationState] || w.coordinationState))));
      if (!['completed', 'stopped', 'expired'].includes(w.coordinationState)) chips.push(budgetMeter(w, 'requests'), budgetMeter(w, 'wakes'));
    }
    const n = c.needsRyan;
    if (n && n.count) {
      const open = Boolean(st.panel && st.panel.kind === 'attention');
      chips.push(h('button', {
        type: 'button', class: 'status-chip is-attn', 'aria-expanded': String(open),
        onclick: () => { st.panel = open ? null : { kind: 'attention' }; st.attention = null; attentionGen += 1; render(); },
      }, h('span', { class: 'attn-dot', 'aria-hidden': 'true' }), h('span', { class: 'chip-label' }, t('需要你处理 {0} 项', n.count)),
        h('span', { class: 'chip-count', 'aria-hidden': 'true' }, String(n.count))));
    }
    return chips.length ? h('div', { class: 'status-chips' }, chips) : null;
  }

  // What is left of a work budget, in the header beside the work chip, with a "+" while budget can
  // still be added (the same action as in the work popover). Low turns amber, none left red.
  function budgetMeter(w, kind) {
    const b = kind === 'requests' ? w.requestBudget : w.wakeBudget;
    const pct = b.limit > 0 ? Math.max(0, Math.min(100, Math.round((b.remaining / b.limit) * 100))) : 0;
    const tone = b.remaining <= 0 ? ' tone-bad' : pct <= 20 ? ' tone-warn' : '';
    const canAdd = Boolean(w.actions && w.actions.addBudget && w.actions.addBudget.enabled);
    const op = st.ops.get(rk(`budget:${kind}`));
    const add = !canAdd ? null
      : op && op.state === 'sending' ? h('span', { class: 'spinner wm-busy', role: 'status', 'aria-label': t('处理中…') })
      : op ? h('button', { type: 'button', class: 'wm-add is-unsure', title: t('结果待确认，打开详情重试'), onclick: () => { st.panel = { kind: 'work' }; render(); } }, '!')
      : h('button', {
        type: 'button', class: 'wm-add',
        title: kind === 'requests' ? t('再给 {0} 条请求', BUDGET_STEP.requests) : t('再给 {0} 次唤醒', BUDGET_STEP.wakes),
        'aria-label': kind === 'requests' ? t('再给 {0} 条请求', BUDGET_STEP.requests) : t('再给 {0} 次唤醒', BUDGET_STEP.wakes),
        onclick: () => addBudget(w, kind),
      }, icon('plus', 12));
    return h('span', {
      class: `work-meter${tone}${add ? ' has-add' : ''}`,
      title: kind === 'requests' ? t('请求额度：剩 {0}，共 {1}', b.remaining, b.limit) : t('唤醒额度：剩 {0}，共 {1}', b.remaining, b.limit),
    },
    h('span', { class: 'wm-label' }, kind === 'requests' ? t('请求余量') : t('唤醒余量')),
    h('span', { class: 'wm-num' }, `${b.remaining}/${b.limit}`),
    h('span', { class: 'wm-track', 'aria-hidden': 'true' }, h('span', { class: 'wm-fill', style: `width:${pct}%` })),
    add);
  }

  function renderWorkPanel(c) {
    const w = c.currentWork;
    if (!w || !st.panel || st.panel.kind !== 'work') return null;
    const participants = w.participants.map((p) => {
      const acc = p.acceptance === 'pending' ? t('等接单') : p.acceptance === 'declined' ? t('拒绝了') : WORK_STATE[p.workState] || p.workState;
      const cp = p.lastCheckpointAt ? t(' · 最后检查点 {0}', fmtTime(p.lastCheckpointAt)) : '';
      return h('li', { class: `work-who from-${p.agent}` }, avatar(p.agent, 'sm'), h('strong', null, NAMES[p.agent]), h('span', { class: 'hint' }, `${acc}${cp}`));
    });
    const paused = w.coordinationState === 'paused_budget';
    const pausedWhat = (w.pauseReasons || []).map((r) => (r === 'request_budget' ? t('请求额度') : t('唤醒额度'))).join(t('、'));
    const actions = [];
    if (w.actions && w.actions.addBudget && w.actions.addBudget.enabled) {
      actions.push(actionState(rk('budget:requests')) || btn(t('再给 {0} 条请求', BUDGET_STEP.requests), () => addBudget(w, 'requests')));
      actions.push(actionState(rk('budget:wakes')) || btn(t('再给 {0} 次唤醒', BUDGET_STEP.wakes), () => addBudget(w, 'wakes')));
    }
    if (w.actions && w.actions.release) {
      actions.push(w.actions.release.enabled ? (actionState(rk('release')) || btn(t('解除这项任务'), () => releaseWork(w), { danger: true }))
        : h('span', { class: 'hint', title: reasonText(w.actions.release.reason) }, w.coordinationState === 'active' ? '' : reasonText(w.actions.release.reason)));
    }
    const body = h('div', { class: 'work-detail' },
      h('p', { class: 'work-goal', title: w.scopeSummary || '' }, w.objective),
      workAuthority(w.authority, true),
      h('div', { class: `work-state${paused ? ' tone-warn' : ''}` },
        `${COORDINATION[w.coordinationState] || w.coordinationState}${paused && pausedWhat ? t('（{0}用完）', pausedWhat) : ''} · ${timeLeft(w.expiresAt)}`),
      h('ul', { class: 'work-people' }, participants),
      h('div', { class: 'work-meters' },
        meter(t('请求额度'), w.requestBudget.remaining, w.requestBudget.limit),
        meter(t('唤醒额度'), w.wakeBudget.remaining, w.wakeBudget.limit)),
      w.pendingRequestCount ? h('div', { class: 'hint' }, t('待处理请求 {0}', w.pendingRequestCount)) : null);
    return panelCard('work', [h('span', { class: 'work-badge' }, icon('zap', 12)), h('strong', null, t('协作任务'))], body, actions.filter(Boolean));
  }

  // The attention list shows one page at a time. The first page is always the live
  // control.needsRyan; a later page is fetched by cursor, refetched when control changes,
  // and forgotten when the list closes or the room changes.
  let attentionGen = 0;
  async function showAttentionPage(roomId, cursor, back) {
    const gen = ++attentionGen;
    if (!cursor) { st.attention = null; render(); return; }
    const res = await src.attention(roomId, cursor);
    if (gen !== attentionGen || roomId !== st.currentRoomId || !st.panel || st.panel.kind !== 'attention') return;
    if (!res.ok) { flash(errorText(res.error.code), 'bad'); return; }
    if (!res.result.items.length && back.length) { showAttentionPage(roomId, back[back.length - 1], back.slice(0, -1)); return; }
    st.attention = { roomId, back, cursor, items: res.result.items, nextCursor: res.result.nextCursor };
    render();
  }

  function attentionChanged(v) {
    const n = v.control && v.control.needsRyan;
    if (v.roomId !== st.currentRoomId) return;
    if (!n || !n.count) {
      st.attention = null;
      if (st.panel && st.panel.kind === 'attention') st.panel = null;
      return;
    }
    clearTimeout(attentionChanged.timer);
    attentionChanged.timer = setTimeout(() => {
      const a = st.attention;
      if (a && a.roomId === st.currentRoomId) showAttentionPage(a.roomId, a.cursor, a.back);
    }, 300);
  }

  function renderAttention(c) {
    const n = c.needsRyan;
    if (!n || !n.count || !st.panel || st.panel.kind !== 'attention') return null;
    const v = view();
    const a = st.attention && st.attention.roomId === c.room.id ? st.attention : null;
    const items = a ? a.items : n.items;
    const next = a ? a.nextCursor : n.nextCursor;
    const back = a ? a.back : [];
    const body = h('div', { class: 'attn-body' },
      h('ul', { class: 'attention-list' }, items.map((it) => h('li', null,
        it.agent ? avatar(it.agent, 'xs') : h('span', { class: 'attn-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'attention-what' }, `${it.agent ? NAMES[it.agent] + ' · ' : ''}${ATTENTION[it.kind] || it.kind}`),
        h('span', { class: 'ts' }, fmtTime(it.since)),
        it.aroundCursor ? btn(t('查看'), () => jumpTo(v, it.aroundCursor, it.timelineItemId)) : null))),
      a || next ? h('div', { class: 'attention-pager' },
        btn(t('上一页'), () => showAttentionPage(c.room.id, back[back.length - 1], back.slice(0, -1)), { disabled: !a }),
        h('span', { class: 'hint' }, t('第 {0} 页', a ? back.length + 1 : 1)),
        btn(t('下一页'), () => showAttentionPage(c.room.id, next, back.concat(a ? a.cursor : null)), { disabled: !next })) : null);
    return panelCard('attention', [h('span', { class: 'attn-dot', 'aria-hidden': 'true' }), h('strong', null, t('需要你处理 {0} 项', n.count))], body, null);
  }

  // The open room's members who need reconnecting, in plain view until they are actually back (the
  // broker reports a live wait or connection again; copying the line proves nothing).
  function reconnectButton(m) {
    const app = m.agent === 'claude' ? 'Claude Code' : 'Codex';
    return btn([icon('copy', 14), t('复制重连口令')], async () => {
      if (await copyText(reconnectLine(m))) flash(t('已复制。请贴回原来的 {0} 会话。', app));
    }, { class: 'btn reconnect-copy' });
  }
  async function copyResume(m) {
    const app = m.agent === 'claude' ? 'Claude Code' : 'Codex';
    if (await copyText(resumeLine(m, control().room.name))) flash(t('已复制。请贴回原来的 {0} 会话，它会接着回复没回的消息。', app));
  }
  // One agent confirmed that Ryan's message asks them to start once they agree, and waits for the
  // other: shown with that message and the plan, since both confirming starts a work session by
  // itself. An expired confirmation is said once, until dismissed here. Pure text choice in
  // pendingKickoffView, for the tests.
  function pendingKickoffView(p) {
    if (!p) return null;
    const done = (p.confirmations || []).map((x) => x.agent);
    const waiting = AGENTS.filter((a) => !done.includes(a));
    if (p.state === 'waiting_peer') {
      return { tone: 'info', title: t('{0} 确认可以开工，在等 {1} 确认', done.map((a) => NAMES[a]).join(t('、')), waiting.map((a) => NAMES[a]).join(t('、'))),
        text: t('两位都确认后，群会自动开工，用标准额度，随时可以停止。不想开工的话，发一条新消息就会取消。') };
    }
    if (p.state === 'expired') return { tone: 'off', title: t('开工确认已失效'), text: t('之后又有了新消息，或者群停止了、成员变了，所以没有开工。') };
    return null;
  }
  const kickoffDismissed = new Set(); // expired confirmations dismissed in this window, by plan hash
  let kickoffCache = { key: '', node: null };
  function renderPendingKickoff(c) {
    const p = c.pendingKickoff;
    const v = pendingKickoffView(p);
    if (!v || (p.state === 'expired' && kickoffDismissed.has(`${p.sourceHumanMessageId}:${p.planSha256}`))) return null;
    const key = [c.room.id, p.state, p.sourceHumanMessageId, p.planSha256, ...(p.confirmations || []).map((x) => x.agent)].join('|');
    if (kickoffCache.key === key) return kickoffCache.node;
    const node = h('div', { class: `reconnect kickoff-pending tone-${v.tone}`, 'data-kind': 'kickoff', role: 'status' },
      h('div', { class: 'reconnect-row' },
        h('span', { class: 'work-badge' }, icon('zap', 12)),
        h('div', { class: 'reconnect-text' }, h('strong', null, v.title),
          h('span', null, v.text, ' ', humanMessageLink(p.sourceHumanMessageId, t('查看你的消息'))),
          p.state === 'waiting_peer' && p.planPreview ? h('details', { class: 'work-plan' }, h('summary', null, t('确认的方案')), h('div', { class: 'work-plan-text' }, p.planPreview)) : null),
        p.state === 'expired' ? btn(t('知道了'), () => { kickoffDismissed.add(`${p.sourceHumanMessageId}:${p.planSha256}`); render(); }) : null));
    kickoffCache = { key, node };
    return node;
  }

  let reconnectCache = { key: '', node: null }; // the same node while nothing changes, so the search box keeps its focus
  function renderReconnect(c) {
    const due = c.members.filter((m) => offlineDue(memberKey(c, m), m, roomFresh()));
    if (!due.length) return null;
    const key = [c.instanceId, c.room.id, ...due.map((m) => `${m.binding.id}:${m.state}:${m.reconnectHint.expectedGate.segmentId}:${m.reconnectHint.expectedGate.version}`)].join('|');
    if (reconnectCache.key === key) return reconnectCache.node;
    const node = h('div', { class: 'reconnect', 'data-kind': 'reconnect', role: 'status' }, due.map((m) => {
      const app = m.agent === 'claude' ? 'Claude Code' : 'Codex';
      return h('div', { class: `reconnect-row tone-${reconnectView(m).tone}` },
        avatar(m.agent, 'sm'),
        h('div', { class: 'reconnect-text' },
          h('strong', null, t('{0} 需要重新连接', NAMES[m.agent])),
          h('span', null, t('{0} 现在收不到消息，发给它的消息会先保存，连上后再送达。打开原来的 {1} 会话，贴入重连口令。', NAMES[m.agent], app))),
        reconnectButton(m));
    }));
    reconnectCache = { key, node };
    return node;
  }

  // ---- Rendering: header, members, panels --------------------------------------------

  function renderMembers(c) {
    const box = h('div', { class: `members${connected() ? '' : ' stale'}`, title: connected() ? '' : t('连接中断，这是最后已知的状态') });
    for (const agent of AGENTS) {
      const m = c.members.find((x) => x.agent === agent) || { agent, state: 'unbound' };
      const mv = offlineDue(memberKey(c, m), m, roomFresh()) ? reconnectView(m) : memberView(m);
      const bound = m.binding ? `${m.binding.label} · ${m.binding.source === 'native_verified' ? t('已核实原生会话') : t('手动登记')}` : t('还没有绑定会话');
      box.append(h('button', {
        type: 'button', class: `member tone-${mv.tone}`, title: `${NAMES[agent]} · ${mv.text}\n${bound}`,
        onclick: () => { st.panel = st.panel && st.panel.kind === 'member' && st.panel.agent === agent ? null : { kind: 'member', agent }; render(); },
        'aria-expanded': String(Boolean(st.panel && st.panel.kind === 'member' && st.panel.agent === agent)),
      }, h('span', { class: 'member-av' }, avatar(agent, 'sm'), h('span', { class: 'status-dot', 'aria-hidden': 'true' })),
        h('strong', null, NAMES[agent]), h('span', { class: 'member-state' }, mv.short || mv.text)));
    }
    return box;
  }

  const closePanel = () => { st.panel = null; render(); };
  function panelCard(kind, title, body, actions) {
    return h('div', { class: `panel panel-${kind}`, 'data-kind': kind, role: 'region', 'aria-label': t('详情') },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, title),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('关闭'), title: t('关闭（Esc）'), onclick: closePanel }, icon('x', 16))),
      body, actions && actions.length ? h('div', { class: 'panel-actions' }, actions) : null);
  }
  const kvList = (rows) => h('dl', { class: 'kv' }, rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));

  function renderPanel(c) {
    if (!st.panel || !['member', 'room'].includes(st.panel.kind)) return null;
    if (st.panel.kind === 'member') {
      const m = c.members.find((x) => x.agent === st.panel.agent) || { agent: st.panel.agent, state: 'unbound' };
      const due = dueNow(m.agent);
      const mv = due ? reconnectView(m) : memberView(m);
      const rows = [[t('状态'), h('span', { class: `kv-state tone-${mv.tone}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), mv.text)]];
      if (m.binding) {
        rows.push([t('会话'), t('{0}（{1}）', m.binding.label, m.binding.source === 'native_verified' ? t('已核实原生会话') : t('手动登记'))]);
        rows.push([t('进群时间'), fmtTime(m.binding.joinedAt)]);
      }
      const deadlineShown = m.state === 'ready' && m.route === 'claude-pull' && m.wait && m.wait.state === 'armed';
      if (m.wait && m.wait.deadlineAt && !deadlineShown) rows.push([t('待命期限'), fmtTime(m.wait.deadlineAt)]);
      if (m.openWork && (m.openWork.queued || m.openWork.possibleRunning)) rows.push([t('手上的事'), t('排队 {0} 条 · 可能在生成 {1} 条', m.openWork.queued, m.openWork.possibleRunning)]);
      const actions = [];
      if (c.room.lifecycle === 'open') {
        if (due) actions.push(reconnectButton(m));
        // The hint exists while any reply is owed; offered once the wait is as long as the one that
        // offers giving up on it, not during every ordinary reply.
        if (m.binding && m.recoveryHint && !due && minutesSince(m.recoveryHint.waitingSince) >= ABANDON_SHOW_MIN) {
          actions.push(btn([icon('copy', 14), t('复制恢复口令')], () => copyResume(m), { title: t('它没回的消息，让它接着回') }));
        }
        actions.push(btn([icon('copy', 14), m.binding ? t('复制换会话的进群口令') : t('复制进群口令')], async () => {
          if (await copyText(joinLine(m))) flash(t('已复制。把它贴到 {0} 的原会话里。', NAMES[m.agent]));
        }));
        if (m.binding && m.actions && m.actions.remove) {
          actions.push(m.actions.remove.enabled ? (actionState(rk(`remove:${m.agent}`)) || btn(t('移出群聊'), () => removeMember(m), { danger: true }))
            : h('span', { class: 'hint' }, reasonText(m.actions.remove.reason, m.agent)));
        }
      }
      return panelCard('member', [avatar(m.agent), h('strong', null, NAMES[m.agent])], kvList(rows), actions);
    }
    if (st.panel.kind === 'room') {
      const a = c.room.actions;
      const actions = [];
      if (a.rename && a.rename.enabled) actions.push(actionState(rk('rename')) || btn(t('改名'), renameRoom));
      if (c.room.lifecycle === 'open') {
        actions.push(a.archive && a.archive.enabled ? (actionState(rk('archive')) || btn(t('归档本群'), archiveRoom, { danger: true }))
          : h('span', { class: 'hint' }, t('不能归档：{0}', reasonText(a.archive && a.archive.reason))));
      } else if (a.restore) {
        actions.push(a.restore.enabled ? (actionState(rk('restore')) || btn(t('恢复本群'), restoreRoom)) : h('span', { class: 'hint' }, reasonText(a.restore.reason)));
      }
      actions.unshift(st.exporting === c.room.id ? h('span', { class: 'hint' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('导出中…'))
        : btn([icon('download', 14), t('导出为 Markdown')], () => exportRoom(c)));
      const summary = st.catalog.rooms.get(c.room.id) || {};
      return panelCard('room', [h('span', { class: `room-av ra-${roomHue(c.room.name)}`, 'aria-hidden': 'true' }, roomInitial(c.room.name)), h('strong', null, c.room.name)],
        [notesSection(c), kvList([[t('房间 ID'), h('code', null, c.room.id)], [t('创建于'), summary.createdAt ? fmtTime(summary.createdAt) : '']])], actions);
    }
    return null;
  }

  function renderHeader() {
    const c = control();
    const head = $('room-head');
    // The room list button is there with or without an open room: on a narrow window the list is
    // off screen, and a first start has no room yet.
    const listToggle = h('button', { class: 'sidebar-toggle icon-btn', type: 'button', 'aria-label': t('群列表'), onclick: () => { st.sidebarOpen = !st.sidebarOpen; render(); } }, icon('menu', 18));
    if (!c) { fill(head, listToggle, h('div', { class: 'room-title' }, st.currentRoomId ? t('正在打开…') : t('选一个群，或新建一个'))); return; }
    fill(head, ...[
      listToggle,
      h('button', { type: 'button', class: 'room-title', title: t('群设置：改名、归档'), 'aria-expanded': String(Boolean(st.panel && st.panel.kind === 'room')), onclick: () => { st.panel = st.panel && st.panel.kind === 'room' ? null : { kind: 'room' }; render(); } },
        h('span', { class: `room-av sm ra-${roomHue(c.room.name)}`, 'aria-hidden': 'true' }, roomInitial(c.room.name)),
        h('span', { class: 'room-title-text' }, c.room.name), c.room.lifecycle === 'archived' ? h('span', { class: 'tag muted' }, t('已归档')) : null, icon('chevronDown', 16)),
      renderStatusChips(c),
      h('button', {
        type: 'button', class: 'icon-btn head-btn', title: t('搜索本群'), 'aria-label': t('搜索本群'),
        'aria-expanded': String(Boolean(st.panel && st.panel.kind === 'search')),
        onclick: () => { st.panel = st.panel && st.panel.kind === 'search' ? null : { kind: 'search' }; render(); },
      }, icon('search', 17)),
      renderMembers(c),
    ].filter(Boolean));
    const extras = $('room-extras');
    // A popover that was already open is rebuilt on every render; only a newly opened one animates.
    const openKind = extras.firstElementChild ? extras.firstElementChild.dataset.kind : null;
    const nodes = [renderReconnect(c), renderPendingKickoff(c), renderPanel(c), renderAttention(c), renderWorkPanel(c), searchPanel()].filter(Boolean);
    for (const n of nodes) if (n.dataset.kind === openKind) n.classList.add('steady');
    // Put back only what changed: the search panel is the same node, and re-adding it would take
    // the focus out of its input.
    if (nodes.length !== extras.children.length || nodes.some((n, i) => extras.children[i] !== n)) fill(extras, ...nodes);
  }

  // ---- Rendering: sidebar ------------------------------------------------------------

  function roomItem(r) {
    const current = r.id === st.currentRoomId;
    const typing = (r.members || []).filter((m) => ['busy', 'notified'].includes(m.state)).map((m) => NAMES[m.agent]);
    const unready = (r.members || []).filter((m) => m.state === 'unbound').length === 2;
    const preview = typing.length
      ? h('span', { class: 'room-preview is-typing' }, t('{0} 正在回复…', typing.join(t('、'))))
      : h('span', { class: 'room-preview' }, r.latestPreview ? snippet(r.latestPreview, 60) : unready ? t('还没有人进群') : t('还没有消息'));
    return h('li', null, h('button', {
      type: 'button', class: `room-item${current ? ' current' : ''}`, onclick: () => openRoom(r.id), 'aria-current': current ? 'page' : null,
    },
      h('span', { class: `room-av ra-${roomHue(r.name)}`, 'aria-hidden': 'true' }, roomInitial(r.name)),
      h('span', { class: 'room-main' },
        h('span', { class: 'room-row' },
          h('span', { class: 'room-name' }, r.name),
          h('span', { class: 'ts' }, fmtShort(r.lastActivityAt))),
        h('span', { class: 'room-sub' },
          r.work ? h('span', { class: 'work-badge small' }, t('任务')) : null,
          preview,
          r.needsAttention ? h('span', { class: 'attn-dot', title: t('需要你处理（{0}）', r.needsAttentionCount || '') }) : null,
          r.unreadReplyCount ? h('span', { class: 'badge', title: t('{0} 条新回复', r.unreadReplyCount) }, r.unreadReplyCount > 99 ? '99+' : String(r.unreadReplyCount)) : null))));
  }

  // Two small segmented switches: appearance (applies at once) and language (reloads the page).
  function segmented(label, options, current, onPick) {
    return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label },
      options.map(([value, content, title]) => h('button', {
        type: 'button', class: 'seg-opt', role: 'radio', 'aria-checked': String(value === current), title,
        onclick: () => { if (value !== current) onPick(value); },
      }, content)));
  }
  function renderThemeSwitch() {
    const theme = window.AgentChatTheme ? window.AgentChatTheme.get() : 'light';
    return segmented(t('外观'), [['light', icon('sun', 15), t('浅色')], ['dark', icon('moon', 15), t('深色')]], theme,
      (value) => { if (window.AgentChatTheme) window.AgentChatTheme.set(value); render(); });
  }
  function renderLangSwitch() {
    return segmented(t('语言'), [['en', 'EN', 'English'], ['zh', '中', '中文']], EN_UI ? 'en' : 'zh',
      (value) => { if (I18N) I18N.setLang(value); });
  }

  // The sidebar keeps three parts. The middle one shows the rooms, or the archived rooms as their
  // own view (a name filter and paging), so a long archive never stretches the list; its filter
  // keeps the focus while the rest re-renders.
  let sidebarParts = null;
  let archivedHead = null;
  function renderSidebar() {
    const sb = $('sidebar');
    if (!sidebarParts || sidebarParts.top.parentNode !== sb) {
      sidebarParts = { top: h('div', { class: 'sidebar-top' }), main: h('div', { class: 'sidebar-main' }), foot: h('div', { class: 'sidebar-foot' }) };
      fill(sb, sidebarParts.top, sidebarParts.main, sidebarParts.foot);
    }
    const archived = st.sidebarMode === 'archived';
    const notifyOn = st.notify.enabled && 'Notification' in window && Notification.permission === 'granted';
    const creating = actionState('create-room');
    fill(sidebarParts.top,
      h('button', { type: 'button', class: 'sidebar-brand', title: t('关于 {0}', PRODUCT), onclick: openSettings },
        brandMark(), h('span', { class: 'brand-text' }, h('strong', null, PRODUCT), h('span', null, t('AI 同席 · Codex & Claude')))),
      archived ? null : h('div', { class: 'sidebar-new' }, creating || h('button', { type: 'button', class: 'new-room', onclick: createRoom, disabled: !connected(), title: t('新建一个群聊') }, icon('plus', 16), t('新建群聊'))));
    if (archived) renderArchivedPane(sidebarParts.main);
    else {
      const rooms = [...st.catalog.rooms.values()].filter((r) => r.lifecycle === 'open').sort((a, b) => b.createdOrder - a.createdOrder);
      fill(sidebarParts.main,
        h('div', { class: 'sidebar-label' }, h('span', null, t('群聊')), rooms.length ? h('span', { class: 'count' }, String(rooms.length)) : null),
        h('ul', { class: 'room-list' }, rooms.length ? rooms.map(roomItem) : h('li', { class: 'room-empty' }, connected() ? t('还没有群，点上面「新建群聊」。') : t('正在连接…'))),
        st.catalog.nextCursor ? h('button', { type: 'button', class: 'sidebar-more', onclick: loadMoreRooms }, t('加载更多群')) : null);
    }
    fill(sidebarParts.foot,
      'Notification' in window ? h('button', {
        type: 'button', class: 'foot-row', role: 'switch', 'aria-checked': String(notifyOn), onclick: toggleNotify,
        title: t('只在需要你处理、任务完成或卡住时提醒；普通回复不弹窗'),
      }, icon('bell', 16), h('span', { class: 'foot-label' }, t('桌面通知')), h('span', { class: 'switch', 'aria-hidden': 'true' })) : null,
      h('button', { type: 'button', class: `foot-row${archived ? ' is-open' : ''}`, 'aria-pressed': String(archived), onclick: toggleArchived },
        icon('archive', 16), h('span', { class: 'foot-label' }, t('已归档的群')), icon('chevronRight', 14)),
      h('button', { type: 'button', class: 'foot-row', onclick: openSettings },
        icon('settings', 16), h('span', { class: 'foot-label' }, t('设置与关于')), icon('chevronRight', 14)),
      EXIT_SUPPORTED ? h('button', { type: 'button', class: 'foot-row foot-quit', onclick: askQuit, title: t('停止 ThreadCrew（所有群）。只关窗口的话它会在后台继续运行。') },
        icon('power', 16), h('span', { class: 'foot-label' }, t('退出 ThreadCrew'))) : null,
      h('div', { class: 'prefs' }, renderThemeSwitch(), renderLangSwitch()));
  }

  function toggleArchived() {
    st.sidebarMode = st.sidebarMode === 'archived' ? 'rooms' : 'archived';
    if (st.sidebarMode === 'archived' && !st.archived) loadArchived();
    render();
  }

  function renderArchivedPane(main) {
    if (!archivedHead || archivedHead.parentNode !== main) {
      const input = h('input', { type: 'search', class: 'archive-filter', placeholder: t('按群名筛选'), 'aria-label': t('按群名筛选归档的群') });
      input.value = st.archivedFilter;
      input.addEventListener('input', () => { st.archivedFilter = input.value; renderArchivedPane(main); });
      archivedHead = h('div', { class: 'archive-head' },
        h('button', { type: 'button', class: 'archive-back', onclick: toggleArchived }, icon('chevronLeft', 16), t('返回群聊')),
        h('div', { class: 'sidebar-label' }, h('span', null, t('已归档的群')), h('span', { class: 'count' })),
        input);
      fill(main, archivedHead, h('ul', { class: 'room-list archived' }), h('div', { class: 'archive-more' }));
    }
    const a = st.archived;
    const q = st.archivedFilter.trim();
    const rooms = a ? a.rooms.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase())) : [];
    archivedHead.querySelector('.count').textContent = a && a.rooms.length ? `${a.rooms.length}${a.nextCursor ? '+' : ''}` : '';
    fill(main.querySelector('.room-list.archived'), !a ? h('li', { class: 'room-empty' }, t('正在读取…'))
      : rooms.length ? rooms.map(roomItem)
      : h('li', { class: 'room-empty' }, a.rooms.length ? t('没有名字里带「{0}」的归档群。', q) : t('没有归档的群')));
    fill(main.querySelector('.archive-more'), a && a.nextCursor
      ? h('button', { type: 'button', class: 'sidebar-more', onclick: () => loadArchived(true) }, q ? t('还有没加载的归档群，加载后一起筛选') : t('加载更多归档的群'))
      : null);
  }

  // ---- Rendering: timeline -----------------------------------------------------------

  function anchorInfo(tl) {
    const box = tl.getBoundingClientRect();
    for (const el of tl.querySelectorAll('[data-id]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > box.top) return { id: el.dataset.id, offset: r.top - box.top };
    }
    return null;
  }

  // SVG drawn with the DOM like the icons; attributes as given (colours come from CSS variables).
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs = {}, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
    for (const kid of kids.flat(Infinity)) if (kid) el.append(kid);
    return el;
  }
  const svgStop = (offset, color) => svgEl('stop', { offset, style: `stop-color: ${color}` });

  // The logo: Codex and Claude as two nodes on one line, a light in the middle (static).
  let svgSeq = 0;
  function brandMark() {
    const id = `bm${++svgSeq}`;
    return h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, svgEl('svg', { viewBox: '0 0 42 42' },
      svgEl('defs', {}, svgEl('linearGradient', { id: `${id}-l`, gradientUnits: 'userSpaceOnUse', x1: 11, y1: 0, x2: 31, y2: 0 },
        svgStop(0, 'var(--codex)'), svgStop(1, 'var(--claude)'))),
      svgEl('path', { d: 'M12 21H30', stroke: `url(#${id}-l)`, 'stroke-width': 2, 'stroke-linecap': 'round' }),
      svgEl('circle', { cx: 11, cy: 21, r: 5.5, class: 'bm-codex' }),
      svgEl('circle', { cx: 31, cy: 21, r: 5.5, class: 'bm-claude' }),
      svgEl('circle', { cx: 21, cy: 21, r: 2.3, class: 'bm-hub' })));
  }

  // The connection mark on an empty room (the "signal line" Ryan picked): Codex and Claude as two
  // nodes on one straight line. When both are in, the line runs from Codex's colour to Claude's and
  // a light travels both ways. While one is missing, the line lights up only from the side that is
  // in, its tip blinks, and the missing node is a hollow circle. With neither (an archived room)
  // it rests. Kept per state so re-renders do not restart the motion; none with reduced motion.
  // The nodes are the same size everywhere. Above the connect cards (`wide`) the mark spans the
  // cards row, 620 wide with a 16px gap (style.css), so each node sits over its own card's centre.
  const heroCache = new Map();
  function linkHero(on = { codex: true, claude: true }, wide = false) {
    const still = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const key = `${on.codex ? 1 : 0}${on.claude ? 1 : 0}${still ? 's' : 'm'}${wide ? 'w' : 'n'}`;
    if (heroCache.has(key)) return heroCache.get(key);
    const id = `lh${++svgSeq}`;
    const W = wide ? 620 : 400, C1 = wide ? (620 - 16) / 4 : 64, C2 = W - C1;
    const Y = 40, X1 = C1 + 28, X2 = C2 - 28, MID = W / 2, GAP = 18;
    const anim = (tag, attrs) => (still ? null : svgEl(tag, { repeatCount: 'indefinite', ...attrs }));
    const line = `M${X1} ${Y}H${X2}`;
    const packet = (reverse, begin) => svgEl('circle', { r: 3.4, class: 'lh-packet', filter: `url(#${id}-glow)` },
      anim('animateMotion', { path: line, dur: '2.4s', begin, ...(reverse ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' } : {}) }));
    const from = on.codex && on.claude ? 'both' : on.codex ? 'codex' : on.claude ? 'claude' : null;
    const halves = { codex: `M${X1} ${Y}H${MID - GAP}`, claude: `M${MID + GAP} ${Y}H${X2}` };
    const link = from === 'both'
      ? [svgEl('path', { d: line, class: 'lh-live', stroke: `url(#${id}-l)` }), still ? null : [packet(false, '0s'), packet(true, '-1.2s')]]
      : [svgEl('path', { d: halves.codex, class: from === 'codex' ? 'lh-half lh-codex' : 'lh-idle' }),
        svgEl('path', { d: halves.claude, class: from === 'claude' ? 'lh-half lh-claude' : 'lh-idle' }),
        from ? svgEl('circle', { cx: from === 'codex' ? MID - GAP : MID + GAP, cy: Y, r: 3.4, class: `lh-tip lh-${from}`, filter: `url(#${id}-glow)` },
          anim('animate', { attributeName: 'opacity', values: '1;.25;1', dur: '1.8s' })) : null];
    const node = (agent, x) => svgEl('g', { class: `lh-node lh-${agent}${on[agent] ? ' is-on' : ''}` },
      svgEl('circle', { cx: x, cy: Y, r: on[agent] ? 26 : 25, class: 'lh-disc' }),
      svgEl('text', { x, y: Y + 1, class: 'lh-glyph' }, AVATAR[agent]));
    const svg = svgEl('svg', { viewBox: `0 0 ${W} 80`, class: `link-hero${wide ? ' is-wide' : ''}`, 'aria-hidden': 'true' },
      svgEl('defs', {},
        svgEl('linearGradient', { id: `${id}-l`, gradientUnits: 'userSpaceOnUse', x1: X1, y1: 0, x2: X2, y2: 0 }, svgStop(0, 'var(--codex)'), svgStop(1, 'var(--claude)')),
        svgEl('filter', { id: `${id}-glow`, x: '-100%', y: '-100%', width: '300%', height: '300%' },
          svgEl('feGaussianBlur', { stdDeviation: 2.2, result: 'b' }),
          svgEl('feMerge', {}, svgEl('feMergeNode', { in: 'b' }), svgEl('feMergeNode', { in: 'SourceGraphic' })))),
      link, node('codex', C1), node('claude', C2));
    heroCache.set(key, svg);
    return svg;
  }

  function emptyState(title, tips, on = { codex: true, claude: true }, action = null) {
    return h('div', { class: 'empty-state' },
      linkHero(on),
      h('div', { class: 'empty-title' }, title),
      h('ul', { class: 'empty-tips' }, tips.map((t) => h('li', null, t))),
      action);
  }

  // A new room: one card per agent to bring its native session in, with the live state, until both
  // are in. The join line itself says which manual to read first.
  function connectCards(c) {
    return h('div', { class: 'connect' },
      linkHero(Object.fromEntries(AGENTS.map((a) => [a, Boolean((c.members.find((m) => m.agent === a) || {}).binding)])), true),
      h('div', { class: 'empty-title' }, t('先把 Codex 和 Claude 连进来')),
      h('div', { class: 'connect-cards' }, AGENTS.map((a) => {
        const m = c.members.find((x) => x.agent === a) || { agent: a, state: 'unbound' };
        const mv = memberView(m);
        const app = a === 'claude' ? 'Claude Code' : 'Codex';
        return h('div', { class: `connect-card${m.binding ? ' is-in' : ''}` },
          h('div', { class: 'connect-head' }, avatar(a, 'sm'), h('strong', null, app),
            h('span', { class: `connect-state tone-${m.binding ? mv.tone : 'off'}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }),
              m.binding ? (mv.short || mv.text) : t('等待连接'))),
          h('p', { class: 'connect-text' }, m.binding ? t('已连接：{0}', m.binding.label)
            : t('复制进群口令，贴到你要用的那个 {0} 会话里，它会自己进群。', app)),
          m.binding ? null : btn([icon('copy', 14), t('复制进群口令')], async () => {
            if (await copyText(joinLine(m))) flash(t('已复制。把它贴到 {0} 的原会话里。', app));
          }));
      })),
      h('p', { class: 'connect-note' }, t('点上方群名可以写群说明，新进群的会话会先读到。')));
  }

  function renderTimeline(opts = {}) {
    const tl = $('timeline');
    const v = view();
    if (!v || !v.control) {
      fill(tl, h('div', { class: 'timeline-inner' }, st.currentRoomId
        ? h('div', { class: 'empty' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('正在读取…'))
        : emptyState(t('选一个群开始'), [t('从群列表选一个群，或新建一个。')], undefined,
          h('button', { type: 'button', class: 'primary empty-action', onclick: createRoom, disabled: !connected() }, icon('plus', 16), t('新建群聊')))));
      return;
    }
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 120;
    const anchor = opts.keepAnchor || !nearBottom ? anchorInfo(tl) : null;
    const c = v.control;
    const inner = h('div', { class: 'timeline-inner' });
    if (v.win.start > 0 || v.nextBeforeCursor || v.headTrimmed) {
      inner.append(h('div', { class: 'load-more' }, v.loading ? h('span', { class: 'hint' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('正在读取…')) : btn(t('加载更早的消息'), () => olderStep(v))));
    }
    const dayOf = (e) => (e && e.at ? new Date(e.at).toDateString() : null);
    let lastDay = v.win.start > 0 ? dayOf(v.sorted[v.win.start - 1]) : null;
    const unreadAt = firstUnread(v);
    for (let i = v.win.start; i < v.win.end; i++) {
      const e = v.sorted[i];
      const day = dayOf(e);
      if (day && day !== lastDay) inner.append(h('div', { class: 'day-divider', role: 'separator' }, h('span', null, dayLabel(e.at))));
      if (day) lastDay = day;
      if (e === unreadAt) inner.append(h('div', { class: 'unread-divider', role: 'separator', id: 'unread-divider' }, h('span', null, t('以下是新消息'))));
      const node = cachedNode(v, e);
      if (node) inner.append(node);
    }
    if (v.win.end < v.sorted.length || v.detached) {
      inner.append(h('div', { class: 'load-more' }, btn(t('加载更新的消息'), () => newerStep(v))));
    }
    if (!v.detached && c.activeExchange) inner.append(renderExchangeStatus(c.activeExchange));
    // Until the first real message (join lines do not count), with the whole history loaded: the
    // connect cards while someone is missing, then the start tips under the live connection mark.
    const talk = v.sorted.some((e) => e.kind === 'message' || e.kind === 'reply' || e.kind === 'work');
    if (!talk && !v.nextBeforeCursor && !v.headTrimmed && !v.detached) {
      inner.append(c.room.lifecycle === 'archived' ? emptyState(t('这个群已归档'), [t('可以看历史；点上方群名可以恢复。')], { codex: false, claude: false })
        : c.members.some((m) => !m.binding) ? connectCards(c)
          : emptyState(t('开始聊天'), [t('直接写需求，默认发给 Codex 和 Claude 两位。'), t('输入 @ 可以只发给其中一位。'),
            t('发消息是先讨论；要他们动手改，直接说明，或者点输入框下面的「开工」。'), t('点上方群名可以写群说明，新进群的会话会先读到。')]));
    }
    fill(tl, inner);
    if (v.stick && !v.detached) tl.scrollTop = tl.scrollHeight;
    else if (anchor) {
      const el = tl.querySelector(`[data-id="${CSS.escape(anchor.id)}"]`);
      if (el) tl.scrollTop += el.getBoundingClientRect().top - tl.getBoundingClientRect().top - anchor.offset;
    }
    if (tailObserver) { tailObserver.disconnect(); tailObserver.observe(inner); tailObserver.observe(tl); }
    updateJumps();
    renderRail();
    landUnread(v);
    scheduleReadPosition(); // what is on screen now counts, without waiting for a scroll
  }

  // A room opened with unread replies shows the first of them. Until it has landed there, nothing is
  // counted as read (postReadPosition): not while the entries or an around page are still coming,
  // not after that fetch failed, and never because time passed. Only the reader's own navigation
  // ends a landing early (readerMoved), and reading then goes on from where they are.
  // v.unreadLanding: null, or { state: 'waiting' | 'jumping' | 'fetching' | 'failed' }.
  function landUnread(v) {
    const landing = v.unreadLanding;
    if (!landing || landing.state !== 'waiting') return;
    const first = firstUnread(v);
    if (first) {
      landing.state = 'jumping';
      setTimeout(() => {
        if (view() !== v || v.unreadLanding !== landing) return;
        jumpToEntry(v, first.id, { instant: true });
        showUnreadLine();
        v.unreadLanding = null;
        scheduleReadPosition();
      }, 0);
      return;
    }
    // The broker's locator points past what is loaded: fetch around it, still counting nothing.
    const loc = v.unreadLoc;
    if (loc && loc.aroundCursor && v.sorted.length) {
      landing.state = 'fetching';
      setTimeout(async () => {
        if (view() !== v || v.unreadLanding !== landing) return;
        await jumpTo(v, loc.aroundCursor, loc.timelineItemId);
        if (v.unreadLanding !== landing) return; // the reader moved on meanwhile
        if (view() === v && v.entries.has(loc.timelineItemId)) { v.unreadLanding = null; scheduleReadPosition(); }
        else landing.state = 'failed'; // stays guarded until the reader moves
      }, 0);
    }
  }

  // Show the "new messages" line itself at the top, not just below the edge.
  function showUnreadLine() {
    const tl = $('timeline');
    const line = $('unread-divider');
    if (tl && line) tl.scrollTop += line.getBoundingClientRect().top - tl.getBoundingClientRect().top - 12;
  }

  // Where the reader's own scrolling, keys and jumps happen (see wire); the unread pill is excluded.
  const READER_NAV = '#timeline, .jumps, #rail, #outline, #room-extras';

  // The reader scrolled, pressed a scrolling key or used a jump in the open room: a landing still on
  // its way gives way, and what they now see can count as read.
  function readerMoved() {
    const v = view();
    if (v && v.unreadLanding) { v.unreadLanding = null; scheduleReadPosition(); }
  }

  // Content can still grow after a render (late font or layout work, long replies): while the
  // view follows the tail, keep it pinned to the bottom.
  const tailObserver = 'ResizeObserver' in window ? new ResizeObserver(() => {
    const v = view();
    const tl = $('timeline');
    if (v && v.stick && !v.detached && tl) tl.scrollTop = tl.scrollHeight;
    updateJumps();
  }) : null;

  // Round buttons at the bottom right: to the start of the conversation, and back to the latest
  // (with the count of new messages). Each shows only when it would move the view.
  function updateJumps() {
    const top = $('jump-top');
    const latest = $('jump-latest');
    const badge = $('jump-badge');
    const v = view();
    const tl = $('timeline');
    if (!top || !v || !v.control || !v.sorted.length) { if (top) { top.hidden = true; latest.hidden = true; $('jump-unread').hidden = true; } return; }
    // Keep the buttons and the rail over the timeline, whatever height the composer has now.
    const app = tl.parentElement.getBoundingClientRect();
    const box = tl.getBoundingClientRect();
    tl.parentElement.style.setProperty('--jb', `${Math.round(app.bottom - box.bottom + 18)}px`);
    $('rail').style.top = `${Math.round(box.top - app.top + box.height / 2)}px`;
    const atBottom = !v.detached && v.win.end >= v.sorted.length && tl.scrollHeight - tl.scrollTop - tl.clientHeight < 120;
    const atTop = v.win.start === 0 && !v.nextBeforeCursor && !v.headTrimmed && tl.scrollTop < 40;
    top.hidden = atTop && !st.jumping;
    top.classList.toggle('is-busy', Boolean(st.jumping));
    top.disabled = Boolean(st.jumping);
    latest.hidden = atBottom && !v.newCount;
    badge.hidden = !v.newCount;
    badge.textContent = v.newCount > 99 ? '99+' : String(v.newCount);
    latest.title = v.newCount ? t('有 {0} 条新消息', v.newCount) : t('回到最新');
    // While the room has unread replies, a pill at the top says how many and jumps to the first of
    // them (see jumpToUnread). It goes once they are read.
    const pill = $('jump-unread');
    const summary = st.catalog.rooms.get(v.roomId);
    const unread = summary ? summary.unreadReplyCount || 0 : 0;
    const reachable = Boolean(unread && ((summary.firstUnread && summary.firstUnread.aroundCursor) || firstUnread(v)));
    pill.hidden = !reachable;
    if (reachable) {
      pill.style.top = `${Math.round(box.top - app.top + 12)}px`;
      pill.textContent = t('{0} 条未读 · 跳到第一条', unread > 99 ? '99+' : unread);
    }
  }

  // Conversation rail (as agreed with Codex, after Codex Desktop): faint short ticks on the left,
  // one per message Ryan sent in the loaded range (sampled to RAIL_TICKS). Pointing at a tick
  // lengthens it and its neighbours and shows a small preview of that turn beside it; it never
  // scrolls. A click jumps there. The full list lives in the outline, opened by its own button.
  const RAIL_TICKS = 24;
  const RAIL_MIN_TURNS = 4;
  let railIndex = new Map(); // turn id -> position among Ryan's messages
  function renderRail() {
    const rail = $('rail');
    const outline = $('outline');
    const v = view();
    const turns = v && v.control ? v.sorted.filter((e) => e.kind === 'message' && e.message) : [];
    const older = Boolean(v && (v.nextBeforeCursor || v.headTrimmed));
    const show = turns.length >= RAIL_MIN_TURNS;
    $('jump-outline').hidden = !show;
    if (!show) {
      rail.hidden = true; rail.dataset.sig = ''; outline.hidden = true;
      $('timeline').parentElement.classList.remove('has-rail');
      return;
    }
    rail.hidden = false;
    $('timeline').parentElement.classList.add('has-rail');
    const sig = `${EN_UI}|${older}|${turns.map((e) => `${e.id}:${e.version}`).join(',')}`;
    if (rail.dataset.sig === sig) { refreshPeek(); updateRailActive(); return; }
    rail.dataset.sig = sig;
    const step = Math.max(1, Math.ceil(turns.length / RAIL_TICKS));
    railIndex = new Map(turns.map((e, i) => [e.id, i]));
    const ticks = turns.filter((_, i) => i % step === 0 || i === turns.length - 1);
    fill(rail, 
      h('div', { class: 'rail-ticks' }, ticks.map((e) => h('button', {
        type: 'button', class: 'rail-tick', 'data-rail': e.id, 'aria-label': snippet(e.message.content.previewText, 40),
        onclick: () => { hidePeek(0); jumpToEntry(v, e.id); },
      }))),
      h('div', { id: 'rail-peek', class: 'rail-peek', 'aria-hidden': 'true', hidden: true }));
    fill(outline, ...[
      h('div', { class: 'outline-head' }, h('span', null, t('对话导航')), h('span', { class: 'outline-count' }, t('{0} 条', turns.length))),
      older ? h('button', { type: 'button', class: 'outline-older', onclick: () => { setOutlineOpen(false); jumpToStart(v); } }, icon('toTop', 14), t('更早的还没加载 · 跳到开头')) : null,
      h('div', { class: 'outline-items' }, turns.map((e) => h('button', {
        type: 'button', class: 'rail-item', 'data-rail': e.id, onclick: () => { setOutlineOpen(false); jumpToEntry(v, e.id); },
      },
        h('span', { class: 'rail-time' }, fmtTime(e.message.createdAt)),
        h('span', { class: 'rail-text' }, snippet(e.message.content.previewText, 80)),
        h('span', { class: 'rail-dots', 'aria-hidden': 'true' }, (e.deliveries || []).slice()
          .sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent))
          .map((d) => h('span', { class: `rail-dot tone-${deliveryView(d).tone}`, title: `${NAMES[d.agent]} ${deliveryView(d).text}` })))))),
    ].filter(Boolean));
    refreshPeek();
    updateRailActive();
  }

  // An open peek follows the data: same question, new content and position; it closes only if the
  // question is gone (room switch, trimmed) or the pointer left.
  function refreshPeek() {
    if (!peekId || (!railPointer && !$('rail').contains(document.activeElement))) return;
    const tick = $('rail').querySelector(`.rail-tick[data-rail="${CSS.escape(peekId)}"]`);
    const v = view();
    if (!tick || !v || !v.entries.has(peekId)) { hidePeek(0); return; }
    showPeek(tick, true);
  }

  function setOutlineOpen(open) {
    const outline = $('outline');
    outline.hidden = !open;
    $('jump-outline').setAttribute('aria-expanded', String(open));
    if (open) {
      const active = outline.querySelector('.rail-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  }

  // Which of Ryan's questions an entry belongs to, by message relation (not by position: replies
  // to earlier questions can arrive after later ones). Discussion replies belong to the question
  // the discussion was started from; ordinary replies to the message their delivery carried.
  function ownerQuestion(e) {
    if (!e) return null;
    if (e.kind === 'message' && e.message) return e.id;
    if (e.kind !== 'reply') return null;
    const ref = e.baseQuestion && e.baseQuestion.kind === 'message' ? e.baseQuestion
      : e.replyTo && e.replyTo.kind === 'message' ? e.replyTo : null;
    return ref && ref.timelineItemId ? ref.timelineItemId : null;
  }
  // question entry id -> { agent -> that agent's last loaded reply entry for the question }
  function turnReplies(v) {
    const map = new Map();
    for (const e of v.sorted) {
      if (e.kind !== 'reply' || !e.reply) continue;
      const q = ownerQuestion(e);
      if (!q) continue;
      const byAgent = map.get(q) || {};
      const prev = byAgent[e.reply.agent];
      if (!prev || prev.order < e.order) byAgent[e.reply.agent] = e;
      map.set(q, byAgent);
    }
    return map;
  }

  // The peek: the question and, for each recipient, the start of its last loaded reply to it;
  // "reply not loaded" when the delivery is answered but the reply is outside the loaded range;
  // the delivery state when it has not answered. Nothing is fetched and nothing is generated.
  function renderPeek(v, id) {
    const entry = v.entries.get(id);
    if (!entry || !entry.message) return null;
    const m = entry.message;
    const replies = turnReplies(v).get(id) || {};
    const lines = AGENTS.filter((a) => m.recipients.includes(a)).map((a) => {
      const r = replies[a] && replies[a].reply;
      const d = (entry.deliveries || []).find((x) => x.agent === a);
      const late = r && LATE.find(([key]) => (r.lateReasons || []).includes(key));
      const text = r ? snippet(r.content.previewText, 140)
        : d && d.finalReplyId ? t('回复未加载')
        : d ? deliveryView(d).text : '';
      return h('div', { class: `peek-reply${r ? '' : ' is-waiting'}` }, avatar(a, 'xs'),
        h('span', { class: 'peek-name' }, NAMES[a]),
        h('span', { class: 'peek-text' }, late ? h('span', { class: 'peek-late' }, late[1]) : null, text));
    });
    return [h('div', { class: 'peek-time' }, fmtTime(m.createdAt)), h('div', { class: 'peek-q' }, snippet(m.content.previewText, 200)), lines];
  }

  // First peek waits 250 ms; while one is open (or just closed) moving along the ticks switches at
  // once. The hovered tick and three neighbours each side lengthen by distance.
  let peekTimer = null;
  let peekHideTimer = null;
  let peekWarmUntil = 0;
  let peekId = null; // the question whose peek is open
  let railPointer = false; // the pointer is over the rail
  function showPeek(target, immediate) {
    clearTimeout(peekTimer);
    clearTimeout(peekHideTimer);
    const id = target.dataset.rail;
    const open = () => {
      const v = view();
      const peek = $('rail-peek');
      // The rail may have been rebuilt since the pointer arrived: use the current tick for the id.
      const tick = target.isConnected ? target : $('rail').querySelector(`.rail-tick[data-rail="${CSS.escape(id)}"]`);
      if (!v || !peek || !tick) return;
      const content = renderPeek(v, id);
      if (!content) return;
      fill(peek, ...[].concat(content).flat());
      peek.hidden = false;
      const rail = $('rail').getBoundingClientRect();
      const box = $('timeline').getBoundingClientRect();
      const r = tick.getBoundingClientRect();
      const height = peek.offsetHeight;
      const top = Math.max(box.top + 8, Math.min(r.top + r.height / 2 - height / 2, box.bottom - height - 8));
      peek.style.top = `${Math.round(top - rail.top)}px`;
      peekWarmUntil = Infinity;
      peekId = tick.dataset.rail;
      const ticks = [...$('rail').querySelectorAll('.rail-tick')];
      const at = ticks.indexOf(tick);
      ticks.forEach((el, k) => {
        const d = Math.abs(k - at);
        el.classList.remove('d0', 'd1', 'd2', 'd3');
        if (d <= 3) el.classList.add(`d${d}`);
      });
      $('rail').classList.add('peeking');
    };
    if (immediate || Date.now() < peekWarmUntil) open();
    else peekTimer = setTimeout(open, 250);
  }
  function hidePeek(delay = 100) {
    clearTimeout(peekTimer);
    clearTimeout(peekHideTimer);
    peekHideTimer = setTimeout(() => {
      const peek = $('rail-peek');
      const rail = $('rail');
      if (peek) peek.hidden = true;
      peekId = null;
      if (rail) {
        rail.classList.remove('peeking');
        for (const el of rail.querySelectorAll('.rail-tick')) el.classList.remove('d0', 'd1', 'd2', 'd3');
      }
      peekWarmUntil = Date.now() + 300; // coming straight back skips the wait
    }, delay);
  }

  // The current question: the one the entry at the reading line belongs to (see below).
  let railFrame = 0;
  function updateRailActive() {
    if (railFrame) return;
    // A short timer rather than requestAnimationFrame: it also runs while the window is not
    // painting, and 60 ms is quick enough for a highlight that follows scrolling.
    railFrame = setTimeout(() => {
      railFrame = 0;
      const rail = $('rail');
      const tl = $('timeline');
      if (!rail || rail.hidden) return;
      // The entry at the reading line (64 px under the top), then the question it belongs to;
      // entries without an owner (system lines, work notes) look back to the nearest one that
      // has one. If nothing resolves, no question is marked rather than guessing the next one.
      const v = view();
      const line = tl.getBoundingClientRect().top + 64;
      let anchor = null;
      for (const el of tl.querySelectorAll('[data-id]')) {
        if (el.getBoundingClientRect().bottom > line) { anchor = el.dataset.id; break; }
      }
      let current = null;
      if (v && anchor) {
        const at = v.sorted.findIndex((e) => e.id === anchor);
        for (let k = at; k >= 0 && k > at - 200; k--) {
          const q = ownerQuestion(v.sorted[k]);
          if (q) { current = q; break; }
        }
      }
      for (const el of $('outline').querySelectorAll('.rail-item')) el.classList.toggle('active', el.dataset.rail === current);
      // Ticks are sampled: light the last tick at or before the current message.
      const at = railIndex.has(current) ? railIndex.get(current) : -1;
      let lit = null;
      for (const el of rail.querySelectorAll('.rail-tick')) {
        el.classList.remove('active');
        if ((railIndex.get(el.dataset.rail) ?? Infinity) <= at) lit = el;
      }
      if (lit) lit.classList.add('active');
    }, 60);
  }

  function olderStep(v) {
    if (v.win.start > 0) {
      v.win.start = Math.max(0, v.win.start - 100);
      v.win.end = Math.min(v.sorted.length, v.win.start + WINDOW);
      v.stick = false;
      render({ keepAnchor: true });
    } else loadOlder(v);
  }

  function newerStep(v) {
    if (v.win.end < v.sorted.length) {
      v.win.end = Math.min(v.sorted.length, v.win.end + 100);
      v.win.start = Math.max(0, v.win.end - WINDOW);
      render({ keepAnchor: true });
    } else loadNewer(v);
  }

  function onScroll() {
    const v = view();
    const tl = $('timeline');
    if (!v) return;
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 120;
    v.stick = nearBottom && !v.detached && v.win.end >= v.sorted.length;
    if (v.stick && v.newCount) v.newCount = 0;
    updateJumps();
    updateRailActive();
    schedulePosition();
    if (tl.scrollTop < 150 && !v.loading && (v.win.start > 0 || v.nextBeforeCursor || v.headTrimmed)) olderStep(v);
    else if (nearBottom && !v.loading && (v.win.end < v.sorted.length || v.detached)) newerStep(v);
    scheduleReadPosition();
  }

  // ---- Rendering: composer and notices -----------------------------------------------

  function renderComposer() {
    const c = control();
    AGENTS.forEach((a) => $(`to-${a}`).setAttribute('aria-pressed', String(st.composer.to.has(a))));
    $('to-hint').textContent = st.composer.to.size ? '' : t('至少选一位');
    const input = $('input');
    const sendOp = st.ops.get(rk('send'));
    input.readOnly = Boolean(sendOp);
    input.disabled = !c || c.room.lifecycle !== 'open';
    const only = st.composer.to.size === 1 ? NAMES[[...st.composer.to][0]] : null;
    input.placeholder = !c ? t('先在左边选一个群') : c.room.lifecycle !== 'open' ? t('这个群已归档')
      : st.composer.work ? t('写清楚要他们一起完成什么，发出后两位会先接单')
      : only ? t('只发给 {0}…', only) : t('给 Codex 和 Claude 发消息，输入 @ 可以只发给一位');
    const workToggle = $('work-toggle');
    workToggle.setAttribute('aria-pressed', String(st.composer.work));
    renderDiscussButton(c);
    $('work-row').hidden = !st.composer.work;
    const card = $('composer-card');
    card.classList.toggle('is-work', st.composer.work);
    card.classList.toggle('is-disabled', input.disabled);
    const reason = st.composer.work ? workBlocker() : null;
    // One button, like the desktop apps: while something is queued or running and the input is
    // empty it is Stop; as soon as Ryan types it is Send again (the message queues behind the
    // reply in progress). Enter never stops.
    const sendBtn = $('send');
    const stopOp = st.ops.get(rk('stop'));
    const files = view() ? view().attach : [];
    const uploading = files.some((a) => a.state === 'uploading');
    const failed = files.some((a) => a.state === 'failed');
    const empty = !input.value.trim() && !files.length;
    renderAttachStrip();
    $('attach').disabled = input.disabled;
    const stopMode = !st.composer.work && !sendOp && Boolean(c) && c.room.lifecycle === 'open'
      && (Boolean(stopOp) || (empty && c.room.actions.stop.enabled));
    sendBtn.dataset.mode = stopMode ? 'stop' : 'send';
    // Icon-only (round) for plain Send/Stop; a pill when the button has to say something.
    if (stopMode) {
      const guarded = Date.now() < st.composer.stopGuardUntil;
      const label = stopOp ? (stopOp.state === 'sending' ? t('正在停止…') : t('重试停止')) : null;
      sendBtn.className = `stop${stopOp ? (stopOp.state === 'sending' ? '' : ' pending') : ' armed'}${label ? ' wide' : ''}`;
      fill(sendBtn, label || icon('stop', 18));
      sendBtn.setAttribute('aria-label', label || t('停止'));
      sendBtn.disabled = stopOp ? stopOp.state === 'sending' || !connected() : !writable() || guarded;
      sendBtn.title = stopOp ? t('用原来的操作 ID 再确认一次') : t('停止：取消还没发出的消息和讨论。已经在生成的回复要到原应用里停。');
    } else {
      const label = sendOp && sendOp.state === 'sending' ? t('发送中…') : st.composer.work ? t('开工') : null;
      sendBtn.className = `primary${label ? ' wide' : ''}`;
      fill(sendBtn, label || icon('send', 18));
      sendBtn.setAttribute('aria-label', label || t('发送'));
      sendBtn.title = label ? '' : t('发送（Enter）');
      sendBtn.disabled = empty || uploading || failed || (st.composer.work ? Boolean(reason) || !writable() || Boolean(sendOp) : !canSend());
    }
    if (st.composer.work) {
      $('work-preset').value = st.composer.preset;
      $('work-hours').value = String(st.composer.hours);
      const obj = $('work-objective');
      if (!obj.value && input.value) obj.placeholder = snippet(input.value.split('\n')[0], 60);
    }
    // The line under the card: grey for information, amber when something needs Ryan.
    const note = $('composer-note');
    let content = '';
    let tone = 'info';
    const count = codePoints(input.value);
    if (sendOp && sendOp.state === 'unknown') {
      tone = 'warn';
      content = [t('发送结果待确认。'), link(t('用原 ID 重试'), () => retryOp(rk('send'))), ' · ',
        link(t('不重试，改草稿'), () => dropOp(rk('send'), t('这条可能已经发出，请看时间线再决定是否重发。')))];
    } else if (!c) {
      content = '';
    } else if (c.room.lifecycle !== 'open') {
      content = t('这个群已归档：可以看历史，不能收发。点上方群名可以恢复。');
    } else if (stopOp) {
      tone = stopOp.state === 'sending' ? 'info' : 'warn';
      content = stopOp.state === 'sending' ? t('正在停止，暂不能发送。') : t('停止结果待确认：按「重试停止」用原来的操作 ID 再确认一次，之后才能发送。');
    } else if (!writable()) {
      tone = 'warn';
      content = c.room.health !== 'ok' ? t('broker 需要恢复，暂不能发送。') : st.conn.catalog === 'auth' ? t('凭证失效：请点上方「重新载入页面」。') : t('没有连上 broker，暂不能发送。');
    } else if (failed) {
      tone = 'warn';
      content = t('有附件没传上：重试或移除后才能发送。');
    } else if (uploading) {
      content = t('附件上传中…');
    } else if (st.composer.work && reason) {
      tone = 'warn';
      content = t('不能开工：{0}', reason);
    } else if (st.composer.work) {
      const [rq, wk] = PRESETS[st.composer.preset];
      content = t('开工后两位可以在本群直接互相请求、审查：最多 {0} 条请求、{1} 次额外唤醒，{2} 小时内有效，随时可以停止。', rq, wk, st.composer.hours);
    } else if (c.room.state === 'stopped') {
      content = t('已停止。发新消息会开始新的一段，已取消的消息不会恢复。');
    } else {
      const off = [...st.composer.to].map((a) => c.members.find((m) => m.agent === a)).filter((m) => m && !m.canReceive);
      const busy = AGENTS.filter((a) => st.composer.to.has(a) && (c.possibleRunningAgents || []).includes(a));
      if (off.length) {
        tone = off.some((m) => m.state !== 'busy') ? 'warn' : 'info';
        content = off.map((m) => memberBlockText(m, false, dueNow(m.agent))).join(t('；'));
      } else if (!empty && busy.length) {
        content = t('{0} 还在回复上一条：这条会排在后面，等{1}回完再收到。', busy.map((a) => NAMES[a]).join(t('、')), busy.length > 1 ? t('它们') : t('它'));
      } else {
        content = discussFirstHint(c);
      }
    }
    if (count > 32000 * 0.9) { tone = 'warn'; content = [].concat(content || [], t(' {0} / 32,000 字', count.toLocaleString())); }
    note.className = `composer-note tone-${tone}`;
    fill(note, ...[].concat(content || []));
  }

  // Discussion or Working, from the room's current work session only (no "ready" is guessed): a message
  // asks for views, and only a kickoff lets them make changes. A message sent during the work is
  // discussed too; it never widens the work that is running.
  function discussFirstHint(c) {
    const w = c.currentWork;
    const working = Boolean(w && ['active', 'paused_budget'].includes(w.coordinationState));
    return [h('span', { class: `mode-tag${working ? ' is-work' : ''}` }, working ? t('开工中') : t('讨论')),
      working ? t('新消息也是先讨论；除非你明确说，不会扩大进行中的任务。') : t('发送是先讨论；要他们动手改，直接说明，或者用「开工」。')];
  }

  function renderNotice() {
    const bar = $('notice');
    let content = null;
    let tone = 'info';
    const c = control();
    if (c && c.room.health !== 'ok') { tone = 'bad'; content = t('broker 需要恢复，所有操作已暂停。请按 BROKER_USAGE.md 的故障恢复处理。'); }
    else if (st.conn.catalog === 'auth' || st.conn.room === 'auth') { tone = 'bad'; content = [t('凭证失效（broker 可能重启过）。'), link(t('重新载入页面'), () => location.reload())]; }
    else if (st.conn.catalog === 'offline') { tone = 'warn'; content = t('连不上 broker，正在重试…'); }
    else if (st.conn.catalog === 'connecting') content = t('正在连接 broker…');
    else if (st.notice) { tone = st.notice.tone; content = st.notice.text; }
    else {
      const un = updateNotice();
      if (un) { tone = un.tone; content = un.content; } else content = backgroundNotice();
    }
    bar.hidden = !content;
    bar.className = `notice tone-${tone}`;
    fill(bar, ...(content ? [].concat(content) : []));
  }

  function updateTitle() {
    const t = st.catalog.totals || {};
    const unread = t.unreadReplyCount || 0;
    const attention = t.needsAttentionCount || 0;
    document.title = `${attention ? '● ' : ''}${unread ? `(${unread}) ` : ''}${PRODUCT}`;
  }

  // ---- Notifications (off by default; only needs_human / work_completed / work_blocked) ----

  async function toggleNotify() {
    if (st.notify.enabled) { st.notify.enabled = false; store.set('agentchat.notify', 'off'); render(); return; }
    if (!('Notification' in window)) return;
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    st.notify.enabled = permission === 'granted';
    store.set('agentchat.notify', st.notify.enabled ? 'on' : 'off');
    if (!st.notify.enabled) flash(t('浏览器没有允许通知。'), 'warn');
    render();
  }

  function showNotice(notice) {
    if (st.notify.seen.has(notice.id)) return;
    st.notify.seen.add(notice.id);
    store.sset('agentchat.notices', JSON.stringify([...st.notify.seen].slice(-200)));
    if (!st.notify.enabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const room = st.catalog.rooms.get(notice.roomId);
    const title = notice.kind === 'reconnect' ? t('{0} 需要重新连接', NAMES[notice.agent])
      : notice.kind === 'work_completed' ? t('任务完成') : notice.kind === 'work_blocked' ? t('有人卡住了') : t('需要你处理');
    try {
      const n = new Notification(`${title} · ${room ? room.name : PRODUCT}`, { body: notice.previewText || '', tag: notice.id });
      n.onclick = () => { window.focus(); openRoom(notice.roomId); n.close(); };
    } catch (err) { /* notifications not available in this context */ }
  }

  // ---- Composer input ----------------------------------------------------------------

  function autoGrow() {
    const t = $('input');
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
    t.style.overflowY = t.scrollHeight > 200 ? 'auto' : 'hidden';
    updateJumps();
  }

  // Typing @ (or ＠) offers Codex and Claude; ↑↓ choose, Enter or Tab insert, Esc closes.
  const MENTION_KEYS = { codex: ['codex', 'cx'], claude: ['claude', 'cl'] };
  function mentionQuery() {
    const t = $('input');
    if (t.selectionStart !== t.selectionEnd) return null;
    const before = t.value.slice(0, t.selectionStart);
    const m = /(?<![A-Za-z0-9_.])[@＠]([A-Za-z\u4e00-\u9fff]{0,12})$/.exec(before); // not inside an e-mail address
    if (!m) return null;
    const query = m[1].toLowerCase();
    const items = AGENTS.filter((a) => !query || NAMES[a].toLowerCase().startsWith(query) || MENTION_KEYS[a].some((k) => k.startsWith(query)));
    // A name typed out in full needs no menu, so Enter sends straight away.
    if (items.length === 1 && NAMES[items[0]].toLowerCase() === query) return null;
    return items.length ? { start: before.length - m[1].length - 1, query, items } : null;
  }
  function updateMention() {
    const t = $('input');
    const q = !st.composer.composing && !t.readOnly && !t.disabled && document.activeElement === t ? mentionQuery() : null;
    if (!q) { hideMention(); return; }
    const prev = st.mention;
    st.mention = { ...q, active: prev && prev.items.join() === q.items.join() ? prev.active : 0 };
    renderMention();
  }
  function hideMention() {
    if (!st.mention) return;
    st.mention = null;
    renderMention();
  }
  function renderMention() {
    const menu = $('mention-menu');
    const input = $('input');
    const m = st.mention;
    menu.hidden = !m;
    input.setAttribute('aria-expanded', String(Boolean(m)));
    if (!m) { input.removeAttribute('aria-activedescendant'); fill(menu); return; }
    const c = control();
    fill(menu, 
      h('div', { class: 'mention-head' }, t('只发给')),
      ...m.items.map((agent, i) => {
        const mv = memberView(c && c.members.find((x) => x.agent === agent));
        return h('div', {
          id: `mention-${agent}`, class: `mention-item${i === m.active ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === m.active),
          onmousedown: (ev) => { ev.preventDefault(); pickMention(agent); },
          onmousemove: () => { if (st.mention && st.mention.active !== i) { st.mention.active = i; renderMention(); } },
        }, avatar(agent, 'sm'), h('span', { class: 'mention-name' }, NAMES[agent]),
          h('span', { class: `mention-state tone-${mv.tone}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), mv.text));
      }),
      h('div', { class: 'mention-foot' }, h('kbd', null, '↑'), h('kbd', null, '↓'), t('选择'), h('kbd', null, 'Enter'), t('确认'), h('kbd', null, 'Esc'), t('关闭')));
    input.setAttribute('aria-activedescendant', `mention-${m.items[m.active]}`);
  }
  function pickMention(agent) {
    const t = $('input');
    const m = st.mention;
    if (!m) return;
    t.setRangeText(`@${NAMES[agent]} `, m.start, t.selectionStart, 'end');
    st.mention = null;
    renderMention();
    t.focus();
    onInput();
  }

  function onInput() {
    const text = $('input').value;
    const mentioned = AGENTS.filter((a) => new RegExp(`[@＠]${NAMES[a]}(?![A-Za-z])`, 'i').test(text));
    if (mentioned.length) { st.composer.to = new Set(mentioned); st.composer.toTouched = false; }
    else if (!st.composer.toTouched) st.composer.to = new Set(AGENTS);
    const v = view();
    if (v) v.draft = text;
    store.sset(`agentchat.draft.${st.currentRoomId}`, text);
    autoGrow();
    renderComposer();
    updateMention();
  }

  function onKeydown(e) {
    const composing = e.isComposing || e.keyCode === 229 || st.composer.composing;
    if (st.mention && !composing) {
      const m = st.mention;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        m.active = (m.active + (e.key === 'ArrowDown' ? 1 : m.items.length - 1)) % m.items.length;
        renderMention();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickMention(m.items[m.active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideMention(); return; }
    }
    if (e.key !== 'Enter') return;
    if (composing || Date.now() - st.composer.compositionEndedAt < 80) return;
    if (e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (e.repeat) return;
    send();
  }

  // ---- Page --------------------------------------------------------------------------

  let rendering = false;
  function render(opts = {}) {
    if (rendering) return;
    rendering = true;
    try {
      renderNotice();
      renderSidebar();
      renderHeader();
      renderTimeline(opts);
      renderComposer();
      updateTitle();
      document.querySelector('.shell').classList.toggle('sidebar-open', st.sidebarOpen);
    } finally {
      rendering = false;
    }
  }

  function buildLayout() {
    fill(document.body, h('div', { class: 'shell' },
      h('aside', { id: 'sidebar', class: 'sidebar', 'aria-label': t('群聊列表') }),
      h('div', { class: 'app' },
        h('header', { id: 'room-head', class: 'topbar' }),
        h('div', { id: 'room-extras', class: 'room-extras' }),
        h('div', { id: 'notice', class: 'notice', role: 'status', hidden: true }),
        h('main', { class: 'timeline', id: 'timeline', role: 'log', 'aria-live': 'polite', 'aria-label': t('聊天记录') }),
        h('button', { id: 'jump-unread', class: 'unread-pill', type: 'button', hidden: true }),
        h('nav', { id: 'rail', class: 'rail', 'aria-label': t('对话导航'), hidden: true }),
        h('div', { id: 'outline', class: 'outline-card', role: 'dialog', 'aria-label': t('对话导航'), hidden: true }),
        h('div', { class: 'jumps' },
          h('button', { id: 'jump-outline', class: 'jump jump-outline', type: 'button', hidden: true, title: t('目录'), 'aria-label': t('目录'), 'aria-expanded': 'false' }, icon('list', 18)),
          h('button', { id: 'jump-top', class: 'jump', type: 'button', hidden: true, title: t('跳到开头'), 'aria-label': t('跳到开头') }, icon('toTop', 18)),
          h('button', { id: 'jump-latest', class: 'jump', type: 'button', hidden: true, title: t('回到最新'), 'aria-label': t('回到最新') },
            icon('toLatest', 18), h('span', { id: 'jump-badge', class: 'jump-badge', hidden: true }))),
        h('footer', { class: 'composer' }, h('div', { class: 'composer-inner' },
          h('div', { id: 'mention-menu', class: 'mention-menu', role: 'listbox', 'aria-label': t('选择要 @ 的成员'), hidden: true }),
          h('div', { id: 'discuss-pop', class: 'discuss-pop', role: 'dialog', 'aria-label': t('让他们讨论'), hidden: true }),
          h('div', { id: 'composer-card', class: 'composer-card' },
            h('div', { id: 'work-row', class: 'work-row', hidden: true },
              h('span', { class: 'work-row-label' }, icon('zap', 14), t('开工设置')),
              h('input', { id: 'work-objective', type: 'text', maxlength: '240', placeholder: t('任务目标（一句话，默认取消息第一行）'), 'aria-label': t('任务目标') }),
              h('select', { id: 'work-preset', 'aria-label': t('协作额度') }, Object.entries(PRESETS).map(([k, [rq, wk, label]]) => h('option', { value: k }, t('{0}额度 · {1} 条请求 / {2} 次唤醒', label, rq, wk)))),
              h('select', { id: 'work-hours', 'aria-label': t('有效期') }, [2, 4, 10].map((n) => h('option', { value: String(n), selected: n === 10 }, t('{0} 小时内有效', n)))),
              h('button', { type: 'button', id: 'work-close', class: 'icon-btn', 'aria-label': t('取消开工'), title: t('取消开工') }, icon('x', 14))),
            h('div', { id: 'attach-strip', class: 'attach-strip', hidden: true }),
            h('textarea', { id: 'input', rows: '1', 'aria-label': t('消息，Enter 发送，Shift+Enter 换行'), 'aria-autocomplete': 'list', 'aria-controls': 'mention-menu', 'aria-expanded': 'false' }),
            h('div', { class: 'composer-bar' },
              h('button', { type: 'button', id: 'attach', class: 'icon-btn attach-btn', title: t('添加附件：图片、PDF、文本，也可以拖进来或粘贴截图'), 'aria-label': t('添加附件') }, icon('clip', 18)),
              h('input', { type: 'file', id: 'attach-input', multiple: true, accept: UPLOAD_ACCEPT, hidden: true }),
              h('div', { class: 'recipients', role: 'group', 'aria-label': t('发给谁') },
                h('span', { class: 'recipients-label' }, t('发给')),
                AGENTS.map((a) => h('button', { id: `to-${a}`, class: `to to-${a}`, type: 'button', 'aria-pressed': 'true', title: t('点一下切换是否发给 {0}', NAMES[a]) }, avatar(a, 'xs'), NAMES[a])),
                h('span', { id: 'to-hint', class: 'to-hint', 'aria-live': 'polite' })),
              h('span', { class: 'bar-sep', 'aria-hidden': 'true' }),
              h('button', { type: 'button', id: 'discuss-toggle', class: 'tool-toggle', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, icon('chat', 14), h('span', { id: 'discuss-label' }, t('让他们讨论'))),
              h('button', { type: 'button', id: 'work-toggle', class: 'tool-toggle', 'aria-pressed': 'false', title: t('开工：让 Codex 和 Claude 在本群直接互相请求、审查，带额度和期限') }, icon('zap', 14), t('开工')),
              h('span', { class: 'bar-spacer' }),
              h('span', { class: 'kbd-hint', 'aria-hidden': 'true' }, t('Enter 发送 · Shift+Enter 换行')),
              h('button', { id: 'send', class: 'primary', type: 'button', disabled: true, 'aria-label': t('发送') }, icon('send', 18)))),
          h('div', { class: 'composer-note tone-info', id: 'composer-note', 'aria-live': 'polite' }))))));
  }

  function wire() {
    AGENTS.forEach((a) => $(`to-${a}`).addEventListener('click', () => {
      if (st.composer.to.has(a)) st.composer.to.delete(a); else st.composer.to.add(a);
      st.composer.toTouched = true;
      renderComposer();
    }));
    const input = $('input');
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown);
    input.addEventListener('compositionstart', () => { st.composer.composing = true; });
    input.addEventListener('compositionend', () => { st.composer.composing = false; st.composer.compositionEndedAt = Date.now(); updateMention(); });
    input.addEventListener('click', updateMention);
    input.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMention(); });
    input.addEventListener('blur', hideMention);
    $('attach').addEventListener('click', () => $('attach-input').click());
    $('attach-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    // A pasted screenshot becomes an attachment; pasted text stays text.
    input.addEventListener('paste', (e) => {
      const cd = e.clipboardData;
      if (cd && cd.files && cd.files.length && !cd.getData('text/plain')) { e.preventDefault(); addFiles(cd.files, true); }
    });
    // Files dropped anywhere on the conversation or the composer.
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    for (const zone of [$('timeline'), $('composer-card')]) {
      zone.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); $('composer-card').classList.add('is-drop'); });
      zone.addEventListener('dragleave', () => $('composer-card').classList.remove('is-drop'));
      zone.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        $('composer-card').classList.remove('is-drop');
        addFiles(e.dataTransfer.files);
      });
    }
    $('discuss-toggle').addEventListener('click', () => setDiscussOpen(!st.composer.discussOpen));
    document.addEventListener('mousedown', (e) => {
      if (st.composer.discussOpen && !document.querySelector('.modal') && !e.target.closest('#discuss-pop, #discuss-toggle')) setDiscussOpen(false);
    });
    window.addEventListener('resize', () => { if (st.composer.discussOpen) placeDiscussPop(); });
    $('work-toggle').addEventListener('click', () => { st.composer.work = !st.composer.work; renderComposer(); if (st.composer.work) $('work-objective').focus(); else focusInput(); });
    $('work-close').addEventListener('click', () => { st.composer.work = false; renderComposer(); focusInput(); });
    document.addEventListener('mousedown', (e) => {
      if (document.querySelector('.modal')) return;
      if (st.panel && !e.target.closest('.panel, .member, .room-title, .status-chip, .head-btn')) { st.panel = null; render(); }
      if (st.sidebarOpen && !e.target.closest('.sidebar, .sidebar-toggle')) { st.sidebarOpen = false; render(); }
    });
    // Esc closes the open detail panel (dialogs and the @ menu handle Esc themselves first).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal')) return;
      if (st.composer.discussOpen) { e.preventDefault(); setDiscussOpen(false, true); return; }
      if (st.panel) { st.panel = null; render(); }
    });
    $('work-preset').addEventListener('change', (e) => { st.composer.preset = e.target.value; renderComposer(); });
    $('work-hours').addEventListener('change', (e) => { st.composer.hours = Number(e.target.value); renderComposer(); });
    $('send').addEventListener('click', onSendButton);
    $('timeline').addEventListener('scroll', onScroll, { passive: true });
    // Anything the user does to scroll cancels a pending landing (not the page loads it starts).
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) $('timeline').addEventListener(type, cancelLanding, { passive: true });
    $('jump-latest').addEventListener('click', () => { const v = view(); if (v) jumpToLatest(v); });
    $('jump-unread').addEventListener('click', () => { const v = view(); if (v) jumpToUnread(v); });
    // The reader's own navigation in the open room (not typing in the composer). The unread pill is
    // not one: it goes to the first unread under its own guard (jumpToUnread).
    const inRoom = (target) => Boolean(target && target.closest && target.closest(READER_NAV)
      && !target.closest('#jump-unread'));
    const SCROLL_KEYS = ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '];
    document.addEventListener('wheel', (e) => { if (inRoom(e.target)) readerMoved(); }, { passive: true });
    document.addEventListener('touchstart', (e) => { if (inRoom(e.target)) readerMoved(); }, { passive: true });
    document.addEventListener('pointerdown', (e) => { if (inRoom(e.target)) readerMoved(); });
    document.addEventListener('keydown', (e) => { if (inRoom(e.target) && SCROLL_KEYS.includes(e.key)) readerMoved(); });
    // Coming back to the window counts what is on screen as read.
    window.addEventListener('focus', scheduleReadPosition);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleReadPosition(); });
    $('jump-top').addEventListener('click', () => { const v = view(); if (v) jumpToStart(v); });
    $('jump-outline').addEventListener('click', () => setOutlineOpen($('outline').hidden));
    document.addEventListener('mousedown', (e) => {
      if (!$('outline').hidden && !e.target.closest('#outline, #jump-outline')) setOutlineOpen(false);
    });
    const rail = $('rail');
    rail.addEventListener('pointerover', (e) => { const tick = e.target.closest('.rail-tick'); if (tick) showPeek(tick); });
    rail.addEventListener('pointerenter', () => { railPointer = true; });
    rail.addEventListener('pointerleave', () => { railPointer = false; hidePeek(); });
    rail.addEventListener('focusin', (e) => { const tick = e.target.closest('.rail-tick'); if (tick) showPeek(tick, true); });
    rail.addEventListener('focusout', () => hidePeek(0));
    window.addEventListener('focus', scheduleReadPosition);
    window.addEventListener('pagehide', savePosition);
    document.addEventListener('visibilitychange', () => {
      const v = view();
      if (document.visibilityState === 'hidden') {
        if (roomStream) { roomStream.close(); roomStream = null; roomStreamGen += 1; }
    st.conn.room = 'idle';
      } else if (v && v.control) {
        resyncRoom(v);
      }
    });
    // Minute counters and lease times only; no network.
    setInterval(() => { if (control()) render({ keepAnchor: true }); }, 30000);
  }

  async function init() {
    buildLayout();
    wire();
    render();
    // A page loaded while this instance is stopping shows that, not an unreachable service.
    if (boot.shutdown) { applyShutdown(boot.shutdown, 'event'); return; }
    if (!(await loadCatalog())) { render(); return; }
    loadSettings();
    // The cached state only: the broker checks by itself when that is switched on.
    if (UPDATES_SUPPORTED) {
      loadUpdates().then(() => followFirstCheck());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshUpdatesIfStale(); });
      window.addEventListener('focus', refreshUpdatesIfStale);
    }
    await restorePending();
    st.conn.catalog = 'polling';
    connectCatalog();
    const remembered = store.get('agentchat.room');
    const rooms = [...st.catalog.rooms.values()].sort((a, b) => b.createdOrder - a.createdOrder);
    const first = rooms.find((r) => r.id === remembered) || rooms[0];
    if (first) {
      const v = touchView(first.id);
      v.draft = store.sget(`agentchat.draft.${first.id}`) || '';
      await openRoom(first.id);
    } else render();
  }

  init();
})();
