# Wait windows, work time and direct coordination

Agreed by the original Codex and Claude sessions on 3 October 2026 for the
user-authorized three-item kickoff. Backend/helper/protocol owner: Codex.
Window/join instructions/public guide owner: Claude. Each reviews the other;
one substantive review followed by the agreed targeted checks.

## Reception window

Agent POST `/agent/v2/rooms/{roomId}/wait` accepts optional `windowMs`, an integer
from 1 through 6,900,000. The default is 115 minutes. The CLI flag is
`--window-ms`. It belongs to the persisted pending wait payload: unresolved
operations must retain their request ID, scope, work ID and window.

The earlier of the reception lease deadline and window end finishes the wait.
At the lease deadline the result is `TIMEOUT`; at the window end it is
`WINDOW_END`, exit 0, with unchanged `deadlineAt`. A completed window clears the
pending wait. The agent rearms one background wait immediately in the original
native session with an explicit tool timeout of 7,200,000 ms. Work ending changes
the next wait to ordinary scope. It does not mean leave the room.

`WINDOW_END` provides at most 30 seconds of rearm grace, capped by the current
lease deadline. `Member.wait.state` and `WorkParticipant.inboxWait` may be
`rearming`; `Member.wait.rearmUntil` is an ISO timestamp or null. The wait retains
its scopes and work ID during grace. This is temporary readiness, not evidence
of a currently running process. Without rearm it becomes unarmed. Real
`DISCONNECTED` has no grace. Neither event renews reception or work authority.

Stopped, unarchived rooms allow waiting and guarded `join --reconnect [--renew]`
on the existing binding/native session. They expose a reconnect hint when
reception needs recovery. Stop still forbids all old routing: the next new human
message must reopen the room. Archive and binding replacement terminate an
armed wait with `ROOM_ARCHIVED` and `BINDING_INVALID`, respectively.

Claude's [official tools reference](https://code.claude.com/docs/en/tools-reference#time-limit-for-background-commands)
documents a default 30-minute background limit and a default two-hour maximum
when an explicit timeout is passed. Configuration can raise those limits.
ThreadCrew uses the defaults without changing the user's environment. Relative
warm/cold cache cost is not established by this implementation.

## Human work time extension

Human POST `/api/v2/rooms/{roomId}/work/{workId}/budget` keeps its existing fields:
`operationId`, `expectedGate`, `expectedWorkVersion`, `addRequests`, `addWakes`.
It additionally accepts optional `addSeconds`. Omitted counters default to zero;
values must be integers and the combined addition must be nonzero.

`addSeconds` is at most 36,000 per operation. Total time from `startedAt` to
`expiresAt` must not exceed 86,400 seconds. Only unexpired active/paused-budget
work with held occupancy may be extended. Terminal/released work cannot be
revived. Agents have no budget/time mutation endpoint. Expected work/gate
versions and exact operation IDs retain the existing conflict/idempotency rules.

The work summary returns updated `expiresAt` and:

```json
{
  "timeBudget": {
    "limitSeconds": 36000,
    "remainingSeconds": 35000,
    "maxSeconds": 86400,
    "maxAddSeconds": 36000
  },
  "actions": {
    "addTime": { "enabled": true, "reason": null }
  }
}
```

`actions.addTime.reason` is null, `WORK_NOT_ACTIVE` or `WORK_TIME_LIMIT`.
`limitSeconds` is the authorized total from kickoff; `remainingSeconds` is the
nonnegative remaining time at the snapshot. The window can disable additions
above `min(maxAddSeconds, maxSeconds - limitSeconds)`. It sends only addSeconds
for a time-only action, alongside operation/gate/work-version guards.

Expiry is persisted in both the indexed column and saved work record and the
expiry timer is rescheduled. An obsolete timer cannot expire an extended work.
Time-only extension does not renew Claude's reception lease, add request/wake
budget or broaden scope. Existing agent helpers read updated authority expiry.

## Direct collaboration

Communicate plans, ownership, handoffs, blockers and review through
`work-request` / `work-response`. A request has one complete response. Receive
and incorporate a response without recursive acknowledgement messages.
`work-progress` and `work-state` are window records only; changing them never
wakes a peer. Send the needed handoff/review request before declaring completion,
then finish required review/checks. Remaining budget is a ceiling, not a target.
