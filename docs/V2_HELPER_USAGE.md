# v2 native-session helper

`src/v2-cli.mjs` exports `runV2Cli(args, { stdout, signal, projectDir, runtimeDir })`. The parent `chat.mjs` launcher dispatches v2 commands to it. Every v2 command requires an explicit `--room`; no selected window room or recent room is inferred. The helper uses `runtime/connection-{codex|claude}.json` with `apiVersion=agent-chat.window.v2`, `workspaceId`, `instanceId`, loopback `baseUrl`, and agent enrollment token. A binding's credential is stored under the same SHA-256 binding-ID client filename as v1, in a separate `v2` member so existing v1 late-final data is retained. Do not replace the v1 descriptor until its late-post compatibility route is provided by the parent launcher.

```text
node chat.mjs join --room ROOM --as claude --session EXACT_NATIVE_ID --expected-binding null --gate-segment SEGMENT --gate-version 4
node chat.mjs join --room ROOM --as codex --session EXACT_NATIVE_ID --expected-binding OLD_BINDING --gate-segment SEGMENT --gate-version 5 --renew
node chat.mjs join --room ROOM --as claude --session EXACT_NATIVE_ID --expected-binding EXISTING_BINDING --gate-segment SEGMENT --gate-version 5 --reconnect --renew
node chat.mjs status --room ROOM --as claude --binding BINDING
node chat.mjs resume --room ROOM --as codex --binding BINDING --runtime-dir RUNTIME
node chat.mjs wait --room ROOM --as claude --binding BINDING
node chat.mjs wait --room ROOM --as claude --binding BINDING --scope work --work WORK
node chat.mjs wait --room ROOM --as claude --binding BINDING --scope all --work WORK
node chat.mjs read --room ROOM --as claude --binding BINDING [--batch BATCH] [--request READ_ID] [--claim CLAIM]
node chat.mjs post --room ROOM --as claude --binding BINDING --delivery DELIVERY --claim CLAIM --file reply.txt [--done]
```

`--expected-binding null` is the explicit empty-seat expectation. Join uses `expectedGate:{segmentId,version}`. A repeated join keeps the exact binding identity; an unsafe room, workspace, role, session, or binding mismatch fails before state is overwritten. Ordinary wait sends `notificationScopes:['ordinary']`; work wait sends `notificationScopes:['work']` and the exact `workId`. `--scope all --work WORK` uses one wait with `notificationScopes:['ordinary','work']`, listening for ordinary messages and that exact authorized work inbox. It does not start a second waiter, extend the work grant, poll a model, or interrupt native generation. Unknown scope values are rejected. Read and wait save their request IDs before HTTP. A failed or uncertain request keeps its original local state for retry, including its exact scope and work ID; finish/retry the old wait before changing scope.

Empty-seat commands from 0.3.0 additionally supply `--join-version N`. Keep that
role-specific generation and the gate segment: the other role joining first
does not invalidate it. Replacement/reconnect omit it. Old commands keep their
strict gate behavior.

`resume` is binding-scoped and read-only. When `text` is null, read the exact
verified `fullTextAttachment.path`; there is no silent truncation. Active work
references require `work-status` for full scope. `latestHumanMessage` is context,
not an instruction to repost an already committed reply. A stopped/removed
binding may save its exact late final but cannot continue execution.

After both agents agree on user-authorized implementation, each runs:

```text
node chat.mjs confirm-start --room ROOM --as ROLE --binding BINDING --op OP --source-message HUMAN_MESSAGE --source-sha256 FULL_TEXT_SHA256 --file agreed-plan.txt --codex-binding CODEX_BINDING --claude-binding CLAUDE_BINDING --gate-segment SEGMENT --gate-version N --authorized --runtime-dir RUNTIME
```

The helper computes the plan SHA-256 from the complete UTF-8 file. The human
source SHA-256 comes from the complete original message. It must be the latest
human message delivered to both current original bindings. Post each ordinary
reply first and end any bounded discussion. A first confirmation is pending;
a second exact confirmation atomically starts one Standard work grant. Repeats
are idempotent. Changed source/plan/gate/bindings reject; no keyword matching or
automatic permission inference happens in the broker.

For everyday use, first run the read-only `start-context` command with the same
room/role/binding/runtime. It returns the complete original human message and
full pending plan, not just the window preview. Read both. The helper can then
fill the source hash, current gate and both binding IDs itself:

```text
node chat.mjs start-context --room ROOM --as ROLE --binding BINDING --runtime-dir RUNTIME
node chat.mjs confirm-start --room ROOM --as ROLE --binding BINDING --source-message HUMAN_MESSAGE --file agreed-plan.txt --authorized --runtime-dir RUNTIME
node chat.mjs confirm-start --room ROOM --as ROLE --binding BINDING --source-message HUMAN_MESSAGE --pending --plan-sha256 HASH_FROM_START_CONTEXT --authorized --runtime-dir RUNTIME
```

Use `--file` for the first confirmation; use `--pending` for the second after
reading that exact full plan. Keep the source ID explicit. Changes between the
read and confirmation reject rather than silently changing the plan.

During an explicit update, an already armed Claude wait can reconnect for at
most two minutes, preserving its exact room, scope, request and binding. It
verifies the new instance before adopting it and never extends the lease or
calls a model. If the helper reports `UPDATE_IN_PROGRESS`, `CLOSED` or a lost
connection for another action, retain its saved operation and retry that exact
command after ThreadCrew reopens; never rejoin a new seat or create another final.
An interrupted update reports `UPDATE_INTERRUPTED`; restart from the shortcut
and inspect the saved result. Recovery backups are retained under runtime/updates.

Optional Codex hook setup is a separate explicit command (quote exact paths):

```text
node scripts/configure-codex-recovery.mjs install --config CODEx_HOOKS_JSON --runtime-dir RUNTIME
node scripts/configure-codex-recovery.mjs remove --config CODEx_HOOKS_JSON --runtime-dir RUNTIME
```

Choose the Codex hooks.json for the intended configuration layer. Existing
definitions are preserved and backed up. Codex requires `/hooks` trust review
of the exact new definition; the installer cannot grant it. The hook is inert
for sessions without an exact registration created by a successful Codex join.

`join --reconnect` is the manual reconnect action for an existing seat. Verify the
instruction's expected native session against your actual session first. The
broker requires that same current binding, native session and gate; it cannot
create or replace a seat. A stopped but unarchived room allows this exact-seat
reconnect and waiting; stopped work and mail remain stopped. `--renew` renews Claude's
reception lease only when it has expired, following the user's explicit manual
reconnect request. It does not renew a work grant. A successful join alone does
not prove Claude is receiving: follow the protocol to drain any pending notice
and establish one background wait with the original unresolved request/scope.
On `BINDING_CHANGED` or `GATE_CHANGED`, refresh the room and copy a new instruction
instead of substituting identities or dropping the reconnect guard.

For combined wait, a `NEW` notification with `workId` and `requestIds` belongs to the work inbox: use `work-checkpoint`, then the corresponding receipt/response helpers. An ordinary `NEW` / `NOTICE_PENDING` with `batchId` uses `read` → `post`. After draining the notified batch, arm the combined wait again while the grant remains active; after work ends, ordinary waiting is sufficient. This choice changes which notifications are listened for, not the broker's delivery eligibility or queue order.

`wait` also accepts `--window-ms N`: a positive integer at most 6,900,000 ms,
the default 115-minute window. The HTTP field is optional `windowMs`. At window
end it returns `WINDOW_END` with the unchanged `deadlineAt`, clears the completed
pending wait and exits normally. Rearm one background wait immediately in the
same Claude session with tool timeout 7,200,000 ms. If the tool kills an unresolved
wait, retry its original request, window and scope first. `WINDOW_END` provides
at most 30 seconds of `rearming` grace with `rearmUntil`; `DISCONNECTED` does not.
Lease `TIMEOUT`, `BINDING_INVALID` and `ROOM_ARCHIVED` end rearming. A user stop of
the background tool also ends it. Work ending alone returns to ordinary waiting.
Read `AGENT_PROTOCOL.md` for authorization, bounded idle wakes and recovery errors.

All work commands require `--room ROOM --as ROLE --binding BINDING --work WORK`. `--op` is an optional stable operation ID; supply it when scripting. Without it the helper generates and persists one before HTTP, then reuses it after an unknown result. Until that operation is resolved, a changed payload or new ID for the same action is rejected. Text comes from a UTF-8 file and the exact payload is saved locally before sending.

```text
node chat.mjs work-accept --room ROOM --as ROLE --binding BINDING --work WORK --delivery DELIVERY --claim CLAIM --accept true --file acceptance.txt --op OP
node chat.mjs work-progress --room ROOM --as ROLE --binding BINDING --work WORK --file progress.txt --op OP
node chat.mjs work-request --room ROOM --as ROLE --binding BINDING --work WORK --to-binding PEER_BINDING --kind review_request --file request.txt --op OP
node chat.mjs work-checkpoint --room ROOM --as ROLE --binding BINDING --work WORK [--request REQUEST] --op OP
node chat.mjs work-status --room ROOM --as ROLE --binding BINDING --work WORK
node chat.mjs work-received --room ROOM --as ROLE --binding BINDING --work WORK --request REQUEST --claim CLAIM --op OP
node chat.mjs work-response --room ROOM --as ROLE --binding BINDING --work WORK --request REQUEST --claim CLAIM --file response.txt --op OP
node chat.mjs work-state --room ROOM --as ROLE --binding BINDING --work WORK --expected-version 3 --state working --file state.txt --op OP
```

`work-accept` also accepts `--accept false`. `work-request` optionally takes `--parent-request REQUEST` and `--review-ref REF`. `work-checkpoint --request` selects one request when the broker permits it. `work-state --expected-version` is the participant's version, not the work summary's version. The helper sends these to `/agent/v2/rooms/{roomId}/work/{workId}/{accept|progress|requests|checkpoint|received|responses|state}`. The broker remains authoritative for grant, budget, binding, gate, lease, claim, final, and version checks.

Use `work-request` / `work-response` for peer coordination, including plans,
handoffs, review and blockers. `work-state` / `work-progress` only update visible
records; they do not wake the peer and are not message substitutes.

Local lock files cover only read/modify/write of the client credential file. No local lock is held during HTTP or a long work wait. If a response is lost, rerun the same command with the same IDs and unchanged file content. Do not create another `--op` to guess whether the first operation committed.

Implemented optional fields:

- `post --format markdown` declares Markdown while preserving exact text. Omit it for the plain default. Native v2 Codex post prompts include it.
- `post`, `work-request` and `work-response` accept `--attachments-file PATH`, a UTF-8 JSON array of already registered IDs in this same room. It is not an upload command.
- `work-progress` and `work-state` accept `--references-file PATH`, a UTF-8 JSON display-reference array. Both array files are limited to 4096 bytes and 20 items.
- `--review-ref REF` sends the structured value `{itemId:REF}`.
- A work helper error with explicit `outcome: rejected` records that result and releases that pending-operation slot; corrected input may use a fresh ID. Unknown, network loss and invalid responses retain the original pending ID. The original payload record remains for conflict checking in both cases.
- Checkpoint may return `fullTextAttachmentId` when a peer reply exceeds the native frame budget. Read and verify that complete registered file; the accompanying text is explicitly only a preview.
- `work-status` is read-only and does not require `--op`. It returns the authorized work summary and current participant versions, including after Stop; use it to refresh `work-state --expected-version` after a conflict. It cannot inspect another binding's work.
- `work-status` also returns `mode: work` and `authorizedScope` with the exact original kickoff text, text SHA-256, source human message ID, objective, expiry and verified attachment manifest. Native work pushes and checkpoints carry the compact reference without duplicating its full text. Ordinary `read` deliveries carry `mode: discussion` and no work authority even if a separate grant is active. Read `AGENT_PROTOCOL.md` for discussion, explicit approval and agreed implementation ownership.

## Native receipt capability

Production `serve` separates native delivery from same-turn timing. Current completed evidence in `runtime/native-receive-proof.json` permits the timing claim `next_step`; missing, invalid or changed evidence falls back to `next_turn`, the normal native-message route with no promise of receipt during an active turn. `src/native-receive-proof.mjs` still validates actual receipt/continuation ordering, one response, the running Desktop version and the transport source hash before accepting same-turn evidence. App or adapter changes invalidate that timing claim without disabling authorized native delivery.

For each queued request/response, the coordinator rechecks the local timing mode and probes the exact original native session read-only before claiming or spending a wake. The adapter verifies the same target again immediately before its guarded write. An unavailable target leaves the original request queued with `deliveryBlockedReason`, a reconnect hint and an attention item; a later room/reconnect event checks it again. Startup explicitly drains untouched queued work. Already attempted uncertain writes are never automatically repeated. No empty-inbox, timer or model polling is introduced. `sent` means handed to the native application, not received by the agent: only the exact `work-received` helper records receipt. Explicit checkpoints remain available.

Contract receive modes are `unverified|next_step|next_turn|unavailable`; `native_push` is a member's routing label, not a `WorkParticipant.receiveMode`. Existing work summaries reflect the current verified mode after restart, rather than inheriting a stale stored capability.
