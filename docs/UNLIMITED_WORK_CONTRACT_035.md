# Unlimited Kick off — 0.3.5

The human can select Unlimited in Kick off. It removes the task's duration,
request and wake-up count limits. Work ends when both participants complete or
the room is stopped, closed, or its selected bindings change. Scope and original
native session identity remain fixed. Peers cannot enable or expand this mode.

## API and persistence

`POST /api/v2/rooms/{roomId}/work` accepts optional `unlimited: true`, with
requestLimit, wakeLimit and durationSeconds omitted or explicitly null. Numeric
limits combined with unlimited are rejected. Finite starts retain their existing
validation and caps. Automatic agreement confirmation still starts Standard.

An unlimited WorkSession and its authorizedScope expose `unlimited: true` and
`expiresAt: null`. Request and wake budgets have null limit and remaining, with
actual used counters still recorded. The time budget has null limit/remaining;
no expiry timer is installed. Budget extensions are unnecessary and rejected
with WORK_UNLIMITED. Existing finite grants are not silently converted.

The current SQLite expiry column is NOT NULL. Unlimited rows use a far-future
sortable storage sentinel while their data_json and all public authority expose
null. This preserves the existing schema and lets update/quit previews continue
to identify held active work. It does not create a fabricated public deadline.

## Reception, stopping and cost

Unlimited work does not renew native reception leases, replace a native session,
retry uncertain deliveries, or authorize unrelated tasks. Existing helper wait
windows/rearm and native capability checks remain. No additional periodic model
calls are introduced. Claude's existing background-wait rearm can still wake its
session under the desktop app's own time limits. Unlimited work removes spending
ceilings for task collaboration; model usage still comes from real requests and
responses. The UI displays used counts alongside infinity descriptions.

Stop cancels unsent forwarding and marks the grant stopped. Exact already-claimed
late replies remain recordable but cannot resume forwarding. Stop still cannot
interrupt generation already underway in either native desktop app.

## UI and validation

The Unlimited preset is offered only when the broker advertises unlimitedWork.
Its finite-hours selector is hidden. Time, request and wake meters show infinity,
without invalid dates, low-budget warnings or extension buttons. Both languages
describe the mode as lasting until completion or Stop for this authorized task.

Synthetic coverage includes authenticated human HTTP start and replay, four-day
clock advance, coordinator reattachment, counts beyond former caps, Stop/late
reply handling, completion, native prompt authority and finite-mode regression.
No production room, original model session or unrelated product is used.
