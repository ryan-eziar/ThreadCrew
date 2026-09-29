# v2 native-session helper

`src/v2-cli.mjs` exports `runV2Cli(args, { stdout, signal, projectDir, runtimeDir })`. The parent `chat.mjs` launcher dispatches v2 commands to it. Every v2 command requires an explicit `--room`; no selected window room or recent room is inferred. The helper uses `runtime/connection-{codex|claude}.json` with `apiVersion=agent-chat.window.v2`, `workspaceId`, `instanceId`, loopback `baseUrl`, and agent enrollment token. A binding's credential is stored under the same SHA-256 binding-ID client filename as v1, in a separate `v2` member so existing v1 late-final data is retained. Do not replace the v1 descriptor until its late-post compatibility route is provided by the parent launcher.

```text
node chat.mjs join --room ROOM --as claude --session EXACT_NATIVE_ID --expected-binding null --gate-segment SEGMENT --gate-version 4
node chat.mjs join --room ROOM --as codex --session EXACT_NATIVE_ID --expected-binding OLD_BINDING --gate-segment SEGMENT --gate-version 5 --renew
node chat.mjs join --room ROOM --as claude --session EXACT_NATIVE_ID --expected-binding EXISTING_BINDING --gate-segment SEGMENT --gate-version 5 --reconnect --renew
node chat.mjs status --room ROOM --as claude --binding BINDING
node chat.mjs wait --room ROOM --as claude --binding BINDING
node chat.mjs wait --room ROOM --as claude --binding BINDING --scope work --work WORK
node chat.mjs wait --room ROOM --as claude --binding BINDING --scope all --work WORK
node chat.mjs read --room ROOM --as claude --binding BINDING [--batch BATCH] [--request READ_ID] [--claim CLAIM]
node chat.mjs post --room ROOM --as claude --binding BINDING --delivery DELIVERY --claim CLAIM --file reply.txt [--done]
```

`--expected-binding null` is the explicit empty-seat expectation. Join uses `expectedGate:{segmentId,version}`. A repeated join keeps the exact binding identity; an unsafe room, workspace, role, session, or binding mismatch fails before state is overwritten. Ordinary wait sends `notificationScopes:['ordinary']`; work wait sends `notificationScopes:['work']` and the exact `workId`. `--scope all --work WORK` uses one wait with `notificationScopes:['ordinary','work']`, listening for ordinary messages and that exact authorized work inbox. It does not start a second waiter, extend the work grant, poll a model, or interrupt native generation. Unknown scope values are rejected. Read and wait save their request IDs before HTTP. A failed or uncertain request keeps its original local state for retry, including its exact scope and work ID; finish/retry the old wait before changing scope.

`join --reconnect` is the manual reconnect action for an existing seat. Verify the
instruction's expected native session against your actual session first. The
broker requires that same current binding, native session and gate; it cannot
create or replace a seat, or reconnect a stopped room. `--renew` renews Claude's
reception lease only when it has expired, following the user's explicit manual
reconnect request. It does not renew a work grant. A successful join alone does
not prove Claude is receiving: follow the protocol to drain any pending notice
and establish one background wait with the original unresolved request/scope.
On `BINDING_CHANGED` or `GATE_CHANGED`, refresh the room and copy a new instruction
instead of substituting identities or dropping the reconnect guard.

For combined wait, a `NEW` notification with `workId` and `requestIds` belongs to the work inbox: use `work-checkpoint`, then the corresponding receipt/response helpers. An ordinary `NEW` / `NOTICE_PENDING` with `batchId` uses `read` → `post`. After draining the notified batch, arm the combined wait again while the grant remains active; after work ends, ordinary waiting is sufficient. This choice changes which notifications are listened for, not the broker's delivery eligibility or queue order.

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

Production `serve` starts Codex work reception as `unverified` unless the local `runtime/native-receive-proof.json` contains a completed, same-original-turn acceptance record. `src/native-receive-proof.mjs` validates the actual receipt and continuation ordering, one response, the running Codex Desktop version and the native transport source hash. The coordinator repeats this local check only when a queued request/response is about to be claimed for native delivery, so an app update while the broker stays running cannot retain an old capability; no empty-inbox or model polling is introduced. Missing, invalid or changed evidence keeps explicit checkpoints available and disables automatic work push. A `sent` transport acknowledgment alone is insufficient. The startup result reports the mode and why proof was not accepted; it contains no credentials.

Contract receive modes are `unverified|next_step|next_turn|unavailable`; `native_push` is a member's routing label, not a `WorkParticipant.receiveMode`. Existing work summaries reflect the current verified mode after restart, rather than inheriting a stale stored capability.
