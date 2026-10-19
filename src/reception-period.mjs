// Claude's receiving period: how long its seat keeps receiving after its last real answer in the room
// (an ordinary reply, a kickoff acceptance, or a work request or response). The person chooses it per
// room; rearming, receipts, checkpoints, progress and state never start it again.
export const RECEPTION_SECONDS = Object.freeze({ '10h': 36000, '24h': 86400, unlimited: null });
export const RECEPTION_MODES = Object.freeze(Object.keys(RECEPTION_SECONDS));
export const DEFAULT_RECEPTION = '10h';
// "Until I stop it" keeps a far-future deadline, so deadline_at stays a sortable ISO time for every
// existing comparison, timer and query. Public views report the mode next to it.
export const UNLIMITED_DEADLINE = '9999-12-31T23:59:59.999Z';

export function receptionMode(room) {
  return RECEPTION_MODES.includes(room?.claude_reception) ? room.claude_reception : DEFAULT_RECEPTION;
}

export function receptionDeadline(room, nowMs) {
  const seconds = RECEPTION_SECONDS[receptionMode(room)];
  return seconds === null ? UNLIMITED_DEADLINE : new Date(nowMs + seconds * 1000).toISOString();
}

export function receptionView(room) {
  const mode = receptionMode(room);
  return { mode, seconds: RECEPTION_SECONDS[mode], unlimited: mode === 'unlimited', options: [...RECEPTION_MODES] };
}
