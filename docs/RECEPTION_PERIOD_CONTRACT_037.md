# Claude's receiving period — 0.3.7

Ryan asked on 19 October 2026 that Claude can keep receiving for longer, and that a long work session
never cuts Claude off while the two agents are still talking.

## The period

Each room has `claude_reception`: `10h` (default for existing and new rooms), `24h` or `unlimited`.
Claude's reception lease (`bindings.deadline_at`) is set to now plus that period whenever it starts
again:

- a committed ordinary reply (not one to a delivery the person gave up waiting for);
- a kickoff acceptance;
- 0.3.7: a work request or a non-duplicate work response from this Claude seat, unless the response
  answers a request the person abandoned;
- the person's reconnect with `--renew` (only for an expired lease, as before);
- a new Claude seat.

Never renewed by receipts, checkpoints, progress, state reports, rearming, `WINDOW_END` or Codex's
actions. Work messages and a change of period never revive an expired lease, and work messages never
shorten a running one. Unchanged from 0.3.6: a committed ordinary reply renews even an expired lease
(Claude finished answering a message it had already claimed), which matches "after its last reply".
Otherwise an expired lease waits for the person's reconnect. `lastRenewedByReplyId` may now hold the
work request or final reply ID that renewed it; nothing reads it.

`unlimited` stores the sortable sentinel `9999-12-31T23:59:59.999Z`, so every existing comparison,
timer and query keeps working. Public views report the mode next to it; the helper and agents see
the sentinel as `deadlineAt`, and the window decides "no limit" from that deadline, not from the
mode (an expired lease keeps its real date after a switch). Claude keeps receiving until the person
chooses 10 or 24 hours (a fresh period from then), removes the seat or archives the room. The choice
belongs to the room: it stays after a seat is removed or the room is archived and restored, and a
new Claude seat starts with it.

## Changing it

Human only: `POST /api/v2/rooms/{roomId}/members/claude/reception` with `{operationId, mode}`.
No gate: it is a room setting, valid in a stopped room too, not in an archived one (`ROOM_ARCHIVED`).
Unknown fields `UNKNOWN_FIELD`, an unknown mode `INVALID_INPUT`, and the same operation ID replays the
first result.

When the mode changes and the current Claude lease is still running, it becomes now plus the new
period (shorter or longer). An expired lease is left as it is; the next reconnect uses the new period.
One `reception_changed` system entry is logged per actual change, `{agent, mode, previous}`.
Result: `{reception, deadlineAt}`.

`control.members[claude].reception` = `{mode, seconds, unlimited, options:['10h','24h','unlimited']}`
(`seconds` is null for `unlimited`). Codex has no reception lease and no such field.

## Waits

A wait whose timer was the lease (lease shorter than its window) reads the current deadline when the
timer fires. If the lease was renewed or changed meanwhile it ends with `WINDOW_END` (rearm), not a
stale `TIMEOUT`; an unchanged lease keeps the original decision. The 30-second rearm grace is bounded
by the current deadline.

## Cost

`unlimited` keeps an idle Claude session waking once per wait window (115 minutes at most) for as long
as the setting holds. The window says so next to the choice. Nothing else adds model calls.

## Known limits

- The wait timer reads the deadline outside the mutation lock. A renewal committed in the same
  milliseconds as the lease's expiry can still end that wait with `TIMEOUT`; the next reconnect or
  reply recovers it. As before 0.3.7.
- A late work response after Stop renews, like an ordinary reply in a stopped segment, unless the
  person abandoned that request.
- Work renewals bump the binding version, so a remove with stale control data may get
  `BINDING_CHANGED` and need a refresh.

## Checks

`tests/reception-period.test.mjs` (9) and `ui/tests/reception.test.mjs` (4), plus the existing suites.
