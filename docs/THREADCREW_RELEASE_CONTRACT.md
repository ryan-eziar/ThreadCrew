# ThreadCrew first release: implementation contract

Status: accepted by both agents for the authorized work grant. No usage statistics. Existing
API version and persisted role IDs remain compatible; `ryan` means the human
role internally, with its display label supplied by settings.

All JSON endpoints below use the existing authenticated `/api/v2` envelope.
Writes require same Origin and stable `operationId`; retry the identical payload
after unknown outcomes. Settings and notes use their own expectedVersion, not a
room gate. Conflicts return `VERSION_CONFLICT` and require a refresh.

## Settings and onboarding

- GET `/settings` -> `{settings:{version,displayName,backgroundNoticeAcknowledged}}`. Empty displayName means
  localized You/你. POST `/settings` body `{operationId,expectedVersion,displayName}`
  -> `{...,settings}`. Trimmed name maximum 80 Unicode characters.
  `backgroundNoticeAcknowledged` defaults to false. Either mutable field can be
  supplied alone; partial updates preserve the other. An empty update is invalid.
- GET `/diagnostics` -> safe `{product,version,nodeVersion,platform,
  supportedPlatform,checks,capabilities}`. Never credentials, paths or native IDs.
- Existing `control.members[].joinHint` supplies actual `projectDir`, runtimeDir,
  `protocolPath` and helperPath, room/binding/gate identity. UI builds a quoted
  command using these values, asking the native session to read protocolPath.

## Room notes

- GET `/rooms/:room/notes` -> `{notes:{version,text,updatedAt}}`.
- POST same path body `{operationId,expectedVersion,text}` -> `{...,notes}`.
  Text maximum 8000 Unicode characters, empty clears it. Plain text, editable by
  the user; notes are background, not a new task or authority. New joins receive
  the current notes. Normal deliveries also carry a bounded current notes field.

## Attachments

- POST `/rooms/:room/attachments` body `{operationId,name,mediaType,dataBase64}`
  -> `{...,attachment:{id,name,mediaType,bytes,sha256,previewAvailable}}`.
  Maximum 10 MiB decoded per file, maximum 20 IDs per message. Supported uploads:
  PNG/JPEG/WebP, PDF, UTF-8 TXT/MD/CSV/JSON/LOG. Server validates type/content and
  generates its own storage path. No client local-path parameter.
- GET `/rooms/:room/attachments/:id/download` returns authenticated binary bytes,
  Content-Disposition attachment. Use fetch + blob/object URL for previews and
  user downloads; never put credentials into URLs. No general HTML/SVG preview.
- Text attachment paging remains `/attachments/:id/text` for text/plain,
  text/markdown, text/csv and application/json files.
- Composer uploads first, then includes completed IDs in the existing message
  or work `attachmentIds`. Removing a draft means removing its ID from the draft,
  not deleting a file already attached to another message. Upload failures remain
  visible and prevent sending that file; sending must never silently omit it.

## Search and export

- GET `/rooms/:room/search?q=...&limit=20&cursor=...` ->
  `{items:[{id,order,at,author,previewText,aroundCursor}],nextCursor}`.
  q: literal substring, 1..200 characters; max limit 50. Search human messages,
  agent replies and work text, newest first, only this room. Use existing around
  navigation for a selected result. No model calls.
- GET `/rooms/:room/export?lang=en|zh` returns a Markdown download, taking a snapshot of
  the room's current last order. Includes speaker/time, full text, current notes,
  and attachment names/size only. Does not bundle binary attachments or expose
  their disk paths, routing credentials, binding IDs or native session IDs.
  Downloads provide UTF-8 `filename*` in Content-Disposition.
  Language defaults to English; the UI supplies its explicitly selected language.
  Only generated labels change. User text, names and original replies stay exact.

## Exit and background service

Closing a browser window leaves the service running. The window explains this
and persists acknowledgement in settings, across changes of the local port.
Exit is an explicit action affecting every room, with local draft/upload warnings.
Bootstrap `capabilities.shutdown` explicitly states whether Exit is supported.

- GET `/admin/shutdown-preview` returns `{instanceId,capturedAt,counts}` from one
  global snapshot. Counts are `activeWorkRooms`, `queuedDeliveries`,
  `pendingWorkRequests`, `pendingWorkResponses`, `inFlightDeliveries` and
  `uncertainDeliveries`; these count records rather than distinct human messages.
- POST `/admin/shutdown` accepts `{expectedInstanceId,shutdownId}` with human
  authentication and same Origin. Repeating the same ID is safe; another ID
  cannot replace an accepted exit. A stale instance is rejected.
- The initial 202, SSE `service.shutdown`, and authenticated GET
  `/admin/shutdown-status?expectedInstanceId=...&shutdownId=...` use
  `{instanceId,shutdownId,status,requestedAt,completedAt,errorCode}`. Status is
  `SHUTTING_DOWN|STOPPED|FAILED`. A 202 or lost connection is not completion.

New routing/mutations are fenced, accepted operations settle, then SQLite closes
and its writer lock is released before STOPPED. HTTP acknowledgement remains
briefly available; a lost terminal acknowledgement leaves an unknown outcome.
Native generation already running must be stopped in its original application.
The launcher recognizes a verified stopped instance without a lock and safely
starts a new writer. The existing backup/verification crash recovery remains.
After FAILED, the production owner keeps the acknowledgement briefly, then exits
without deleting an unreleased lock. Reopening uses the existing verified
dead-owner recovery rather than reusing a permanently fenced process.

## Discussion and approved scope

Ordinary native messages have `mode: discussion`, even while the room has a work
grant. Kickoff and work inbox deliveries have `mode: work` and a compact
`authorizedScope` reference to their original human kickoff. `work-status`
returns the complete original text, SHA-256 and verified attachment manifest.
New requirements default to discussion; clear user approval in natural language
is accepted without keywords or repeated confirmation. Before implementing a
shared plan, agree scope, one implementation owner per item, reviewer and checks.
The user can select one complete reply for kickoff; the UI does not infer mutual
agreement or automatically merge plans. Plans exceeding the existing message
limit are rejected visibly rather than truncated.

## Ownership and verification

Claude owns ui/, UI tests, brand visuals and public-facing README/help drafts.
Codex owns src/, chat.mjs, launch scripts, backend tests, LICENSE, protocol and
public export tooling. Public docs go under docs/public/; private review/proof
history stays in this repository. Coordinate shared file changes explicitly.

One substantive cross-review, one targeted repair verification. Verify normal
settings/onboarding/notes/attachment/search/export flows, same-room scoping,
portable installation and preservation of existing history. Public export is a
separate allowlisted directory with no runtime or old Git history; publishing
is a later concrete action. Do not start extra native conversations.
