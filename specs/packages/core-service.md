<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# core-service: Core Service

## Intent

This spec covers the Spex core service — the headless Node service in `packages/core` (the private workspace package `@sublang/spex-core`): its observable behavior, its implementation requirements, and its end-to-end integration coverage.
The service owns config, project sessions, the intent ledger, the embedded playbook runtime, and persistence behind one WebSocket API: it embeds the headless cligent runtime and the playbook captain shell, and it shares the playbook launcher's config file, its session store ([DR-036](../decisions/036-file-state-store.md)), and its adapter readiness rules.
Every behavior in this package is observable over the WebSocket protocol; the service serves no HTML, and integration coverage runs end to end against a scripted fake adapter.

## External Behavior

### Endpoint

#### core-service-89

When started on a native platform other than macOS or Linux, the core service shall refuse before creating or migrating config or storage, naming the supported hosts and Windows' scaffold CLI and browser alternatives ([DR-049](../decisions/049-supported-app-hosts.md)):

- Supported hosts require a filesystem that enforces the shared store's private permissions [[1]].

#### core-service-1

Where the core service is started by a host shell, when startup completes, the core service shall accept WebSocket connections on its endpoint — a loopback-only socket the service binds itself by default, or a shell-supplied HTTP server the service attaches to, leaving binding and transport security to that shell ([DR-033](../decisions/033-remote-gui-serving.md)) — and report the endpoint address to the host:

- When a client connects, the core service sends a hello message carrying the protocol version before any other message, so clients can detect a protocol mismatch before issuing commands.

#### core-service-24

The core package shall reject WebSocket handshakes that do not present the service's session token, and handshakes whose Origin header names a foreign web origin, so that neither arbitrary local web pages nor remote pages can drive the control plane; embedding shells receive the token at startup and pass it to the UI:

An Origin is not foreign only in these cases:

| Origin | Admitted as |
| --- | --- |
| absent | a non-browser client |
| `null`, or a `file://` origin | the packaged renderer |
| `http(s)://localhost` or `http(s)://127.0.0.1`, any port | a local dev page |
| the host the handshake request itself addressed | a page the embedding shell serves ([DR-033](../decisions/033-remote-gui-serving.md)) |

### Configuration

#### core-service-2

Where the shared config file exists at the path defined by [DR-004](../decisions/004-config-and-persistence.md), when the core service starts, the core service shall load and validate the config, reloading and revalidating it without a restart whenever the file's content changes on disk while the service runs.

On every load and reload:

- On success, the resulting config state is broadcast to all connected clients.
- On failure, a config error naming the offending entry and the violated rule is broadcast, and session creation requests are rejected while no valid config is active.
- A turn in flight keeps the config it opened with; the next message opens with the current config, or is refused naming the config error [[core-service-73](#core-service-73)] ([DR-051](../decisions/051-runtime-held-for-a-turn.md)).
- Where the file is a profiles-era config, the load migrates it in place per the launcher's semantics ([DR-019](../decisions/019-inline-agent-configuration.md)): named profiles inline into agent blocks, the `profiles` map is deleted, the pre-migration file is backed up beside the config with comments surviving, and a `profile` naming a missing entry is a config error that leaves the file untouched.
- Validation fails closed on the same defect classes as the playbook launcher [[core-service-16](#core-service-16)].

#### core-service-3

Where no config file exists at the shared config path, when the core service starts, the core service shall write the installed playbook package's own starter template to that path, adopt it as the active config, and report the seeding to connected clients ([DR-037](../decisions/037-playbook-12-adoption.md)):

- When seeding, the core service does not overwrite an existing config file.
- The template is read from the installed package, so both hosts' first-run config is identical by construction.

#### core-service-66

Where the shared config path is the default one and holds nothing, when the core service starts and a config file exists at the previous XDG location, the core service shall relocate it once into the shared config path before seeding — bytes and permission bits preserved, published with an exclusive link so a canonical file appearing concurrently wins, the previous file left in place ([DR-037](../decisions/037-playbook-12-adoption.md)):

- An explicit config path given by the shell moves nothing.
- A previous file naming a relative sessions directory is left where it is and reported, since moving it would retarget the locator.

### Sessions

#### core-service-4

Where a project is registered ([DR-006](../decisions/006-projects-and-forge.md)) and the active config is valid, when a client requests a session for that project, the core service shall create a live session whose embedded runtime is initialized with the project directory as its working directory, and shall report the new session to subscribed clients:

- After waiting for any settlement in progress [[core-service-91](#core-service-91)], while a session of the project remains live or another host holds one, a further session request for the same project is rejected `busy` naming that session, and creates no session ([DR-051](../decisions/051-runtime-held-for-a-turn.md)).
- Live sessions for distinct projects run concurrently.
- While a session is live, a client's disposal request aborts its turn, persists the session's Captain snapshot [[core-service-72](#core-service-72)], disposes the session's runtime, and reports the session as no longer live; a Boss message continues it [[core-service-73](#core-service-73)].
- Where disposal fails, the core reports the error and retains the session's lease and project reservation until cleanup is confirmed; stopping the owning process allows later recovery through the shared lease checks ([DR-048](../decisions/048-failed-session-cleanup.md)).

#### core-service-91

When a Boss turn settles on a live session, the core service shall release the session's runtime — the Playbook lease with it — and report the session as no longer live, so the runtime is held only for a turn and every later message opens it again with the current config [[core-service-73](#core-service-73)] ([DR-051](../decisions/051-runtime-held-for-a-turn.md)):

- a settled checkpoint the core could not continue from disk — unresolved repository effects — keeps its runtime held until a later turn leaves it continuable;
- a failed or aborted turn releases the runtime as before, the session's recovery state reported [[core-service-32](#core-service-32)];
- the release preserves the local provider hints written at settlement, so the next open resumes the Captain's and the players' provider conversations where they exist;
- session and project admission wait through release and the resulting stored-summary refresh and publication, on successful and failed turns alike.

#### core-service-92

When a session's runtime is opened for a message [[core-service-73](#core-service-73)], the core service shall project the current config onto the session's stored members — the playbooks of its stored structure, and its referenced players in stored order — and shall compare that projection's structure with the stored one before opening ([DR-051](../decisions/051-runtime-held-for-a-turn.md)):

| Case | Outcome |
| --- | --- |
| Same structure, same tuning | the runtime opens on the stored projection |
| Same structure, changed model, effort, or fast mode | the runtime opens on the new projection, applied from the next call |
| A stored playbook disabled, or changed in its source, command, options, or a binding's player; the Captain's or a stored player's adapter, instruction, or permissions changed; a stored player gone | refused `invalid_config` naming each changed field and offering a new session, the runtime never opened |

- a playbook or player the session never had is left out of the projection and changes nothing;
- a pending config reload is awaited before the projection is taken, so the settings applied are the file's latest.

#### core-service-93

When a client requests the session list or the ledger, the core service shall derive each project's current conversation from stored state — its live session, else its most recently active session that continues [[core-service-32](#core-service-32)] and no other host owns — and shall fold that conversation as the project's lane: its standing conditions and stand-ins [[core-service-49](#core-service-49)] ([DR-051](../decisions/051-runtime-held-for-a-turn.md)):

- a disposal trace the runtime emits outside a turn — carrying no turn id — is a pause, never the Captain dismissing a parked run, so a question parked at that moment stands until the next Boss turn starts.

#### core-service-72

When a Boss turn or live session ends, the core service shall checkpoint through Playbook's shared lifecycle [[1]], preserving its token-free recovery journal, snapshot, effect ledger, uncertainty and durable replay binding in the shared manifest ([DR-045](../decisions/045-unified-session-storage.md)):

- the pre-effect write-ahead boundary remains authoritative; inability to export or settle leaves that evidence intact and never fabricates success;
- provider continuity is optional local hint state; missing hints use Captain's journal or the player's complete task, while ambiguous failures never auto-retry;
- a session without supported recovery remains history-only, with the reason reported by continuation admission [[core-service-73](#core-service-73)].

#### core-service-70

When a client sends `session.delete` for a stored session, the core service shall delete the session's files and every in-memory trace of it — its records, turns, usage, and viewed marker — and broadcast the removal to subscribed clients, announcing `intents.changed` for its project [[core-service-51](#core-service-51)] ([DR-038](../decisions/038-history-is-done-work.md)):

- a live session is refused with a `busy` error naming it: its turn finishes or is aborted first [[core-service-4](#core-service-4)] ([DR-051](../decisions/051-runtime-held-for-a-turn.md));
- a session from either interface is deleted through the same shared-store operation and lease check [[core-service-75](#core-service-75)];
- an open intent the session served re-derives as queued, and a closed one keeps its verdict [[core-service-49](#core-service-49)].

#### core-service-75

When a client requests deletion of any stored session, the core service shall obtain Playbook's exclusive session lease through the shared deletion operation [[1]] and refuse `busy` on active ownership or a diagnostic refusal on unprovable ownership before changing files:

- deletion removes replay, hints, active legacy sidecar and derived state, then the manifest last; incomplete cleanup is retryable;
- retired lease guards remain; the core never recursively clears a session lock directory to force admission.

#### core-service-32

When a client requests the session list, the core service shall reply with every stored session's lifecycle fields and its conversation summary ([DR-029](../decisions/029-session-history-home.md)):

- each entry carries the session's resolved project, its creation time, its last activity — the wire field `endedAt`, null while live — liveness and `turnActive`, which stays true until the turn transaction settles or fails; host of origin is not an admission condition;
- a non-live session has no active turn; historical records alone never establish liveness, and a session acquired by this core is never reported as externally owned;
- each entry says whether a Boss message continues it, using the shared checkpoint, replay and execution checks [[core-service-73](#core-service-73)], with a reason when history-only;
- each uncertain entry carries `recovery: {state: "uncertain", input}` with the exact saved input; uncertainty is never reported as normal continuability;
- external session leases are observed through Playbook's shared API [[1]]: an active writer reports liveness, and active or unprovable ownership reports `externalWriter` and withholds recovery controls until ownership is idle;
- each entry carries a title — the first Boss turn's text — absent when the session held no turn;
- each entry carries its turn count and whether it ended holding a failure record.

#### core-service-34

When the core service reports a session's state to subscribed clients — at each turn's start and end, when its runtime is released [[core-service-91](#core-service-91)] or opened by a message [[core-service-73](#core-service-73)], and after recovery [[core-service-82](#core-service-82)] [[core-service-83](#core-service-83)] — the report shall carry that session's conversation summary as the listing carries it [[core-service-32](#core-service-32)] ([DR-029](../decisions/029-session-history-home.md)), never the summary the session was created with:

- A session is named from the turn that starts, not the turn that finishes, so a running session is never listed as having said nothing.

#### core-service-87

When a rescan replaces an indexed session's history, the core shall publish `session.history-replaced` with its `sessionId` before its updated summary, allowing clients to reload instead of combining incompatible histories [[storage-11](storage.md#storage-11)].

#### core-service-85

When a client sends `project.rebind` with `projectId`, local `path`, optional recorded `aliases` and optional Git `revision`, the core shall apply the existing-identity binding rules [[storage-6](storage.md#storage-6)] after verifying that the path is a repository root and the project has no live session — no turn in flight ([DR-051](../decisions/051-runtime-held-for-a-turn.md)).

#### core-service-86

When a client sends `storage.diagnostics`, the core shall report each unresolved binding or invalid stored file as `{file, reason, blocking}`, preserving the data and distinguishing history-only limitations from write-blocking damage [[storage-12](storage.md#storage-12)]:

- after verified migration, damaged application or session files do not refuse startup; affected commands return `invalid_request` with the failing file and reason, while unrelated operations remain available.

### Boss Turns

#### core-service-5

While a session is live and no boss turn is active on it, when a client submits Boss composer text for that session, the core service shall start a boss turn on the session's runtime and stream the turn-started record to subscribed clients:

- While a boss turn is active on a session, a further Boss submission for that session is rejected with a busy error and starts no turn, so boss turns on one session run strictly one at a time.
- A submission for a session that is not live opens its runtime first [[core-service-73](#core-service-73)], then starts the turn as above.

#### core-service-73

While a session is not live, when a client submits Boss text for it, the core service shall request continuation through Playbook's shared lifecycle [[1]] with the current config projected onto the session's stored members [[core-service-92](#core-service-92)], restore the same logical session identity and checkpoint [[core-service-74](#core-service-74)], and report it live before starting the turn [[core-service-34](#core-service-34)], or refuse by these cases:

| Case | Reply |
| --- | --- |
| Another session of the project is live, or a session lease is active | `busy`, naming the session working or the holder |
| Unsupported recovery, no checkpoint, incomplete stream or digest mismatch | `invalid_request`, history-only with the failing condition |
| Uncertain work | `invalid_request`, use explicit Retry or Discard [[core-service-82](#core-service-82)] [[core-service-83](#core-service-83)] |
| Unresolved repository effects | `invalid_request`, reconcile the stored work before continuation |
| Missing/ambiguous project binding | `invalid_request`, bind an existing project identity first |
| Changed checkpoint repository/module paths | `invalid_request`, relocation unsupported; history remains readable |
| Missing or invalid config | `invalid_config`, as for creation |
| Structural or runtime mismatch | `invalid_config`, naming each changed field and offering a new session [[core-service-92](#core-service-92)] |

- desktop and CLI checkpoints use the same cases; missing provider hints alone do not refuse continuation;
- parked questions resume in their retained frames; a refusal starts no turn and stamps no intent [[core-service-47](#core-service-47)].

#### core-service-6

While a boss turn is active on a session, when a client requests an abort for that session, the core service shall abort the active turn, stream the turn-aborted record to subscribed clients, and admit further input only after the shared lifecycle establishes a settled checkpoint, otherwise reporting uncertainty [[core-service-32](#core-service-32)].

#### core-service-82

When a client sends `session.retry` with only a `sessionId`, the core shall retry that session's uncertain turn through Playbook's shared lifecycle [[1]] under the same project and session admission checks as continuation [[core-service-73](#core-service-73)] ([DR-047](../decisions/047-explicit-session-recovery.md)):

- acquire the exclusive session lease and re-read the saved uncertainty before any effects;
- reconcile repository evidence, restore the saved checkpoint and exact attempted configuration, and retry the recorded input without creating another intent dispatch;
- reject a non-uncertain session or unsafe recovery with its cause, starting no replacement turn;
- publish records and the resulting session state, retaining uncertainty if the attempt does not settle.

#### core-service-83

When a client sends `session.discard` with only a `sessionId`, the core shall discard that session's uncertain attempt through Playbook's shared lifecycle [[1]] under its exclusive lease, without loading configuration, modules or agents ([DR-047](../decisions/047-explicit-session-recovery.md)):

- refuse live or unprovably owned sessions and any attempt whose effect ledger has advanced;
- restore the exact preceding settled checkpoint, or remove a never-settled fresh session when Playbook authorizes removal;
- publish the restored summary or session removal and refreshed intent state; a refusal preserves evidence and reports its cause.

### Intent Ledger

#### core-service-42

When a client sends `intent.queue` for a registered project ([DR-006](../decisions/006-projects-and-forge.md)), the core service shall store a new open intent — the request's text, its optional source (kind, reference, URL, and labels), its optional after-link, and its queue position — reply with the stored intent, and announce the write [[core-service-51](#core-service-51)] ([DR-035](../decisions/035-intent-ledger.md)):

- the request places the intent at the head or the tail of the project's queue as it asks, tail when it says nothing;
- where the source kind is issue, PR, or record and the project already holds an open intent with the same source kind and reference, the request is rejected with a `conflict` error naming that intent and stores nothing — at most one open intent per source artifact per project;
- a chat-sourced or unsourced intent is never deduplicated.

#### core-service-43

While an intent is queued [[core-service-47](#core-service-47)], when a client sends `intent.edit` for it, the core service shall replace the intent's text and announce the write [[core-service-51](#core-service-51)]:

- an edit of a dispatched or closed intent is rejected: from its dispatch binding on, the text is history ([DR-035](../decisions/035-intent-ledger.md)).

#### core-service-44

When a client sends `intent.move` for an intent, the core service shall reorder the intent within its own project's queue — to the position after a named intent of that project, or to the head when none is named — and announce the write [[core-service-51](#core-service-51)]:

- a move naming an intent of another project is rejected: only a project's own order has dispatch meaning ([DR-035](../decisions/035-intent-ledger.md)).

#### core-service-45

When a client sends `intent.link` for an intent, the core service shall set the intent's single after-link to the named open intent — of any project — or clear it when the request names none, and announce the write [[core-service-51](#core-service-51)]:

- a link to a closed intent is rejected;
- a link that would close a cycle of after-links is rejected fail-closed;
- while its after-link names a still-open intent, the intent is blocked — ineligible for dispatch [[core-service-47](#core-service-47)] — and the block lifts by derivation when that predecessor closes, with nothing written.

#### core-service-46

When a client sends `intent.close` for an open intent with a verdict of `done` or `dropped`, the core service shall record the verdict and its time on the intent — the act appended, never rewritten [[core-service-52](#core-service-52)] — and announce the write [[core-service-51](#core-service-51)]:

- `done` is accepted only while a turn the intent attributes [[core-service-47](#core-service-47)] ended finished with none later active, and is otherwise rejected — confirming work that never ran would falsify the ledger ([DR-035](../decisions/035-intent-ledger.md));
- `dropped` is legal on any open intent; dropped before any turn the intent attributes [[core-service-47](#core-service-47)] ended finished, the intent is removed — the history read excludes it [[core-service-50](#core-service-50)] and no verdict shows anywhere ([DR-038](../decisions/038-history-is-done-work.md));
- a close of an already-closed intent is rejected.

#### core-service-79

While an intent is closed [[core-service-46](#core-service-46)], when a client sends `intent.remove` for it, the core service shall append a remove act retiring that intent from every read — no queue row, no source binding, no attention entry [[core-service-49](#core-service-49)], and no history page [[core-service-50](#core-service-50)] — and announce the write [[core-service-51](#core-service-51)] ([DR-038](../decisions/038-history-is-done-work.md)):

- a remove of an open intent is rejected with a `conflict` error: the ledger still owns work that is not ruled on;
- a remove naming an intent no read knows — never stored, or already removed — is rejected `not_found`;
- the intent's acts stay in the append-only log [[core-service-52](#core-service-52)], and its dispatch stamp keeps bounding its neighbours' turn ranges [[core-service-47](#core-service-47)], so no other intent's derived state moves.

#### core-service-47

While a session is live, when a Boss submission for it — from a client [[core-service-5](#core-service-5)] or automatic advancement [[core-service-94](#core-service-94)] — carries an intent id, the core service shall validate the intent at submission — open, of the session's project, queued, and unblocked [[core-service-45](#core-service-45)] — and stamp the dispatch (session, turn, and time) onto the intent when and only when the submitted turn starts, announcing the write [[core-service-51](#core-service-51)] ([DR-035](../decisions/035-intent-ledger.md)):

- a submission whose intent fails validation is rejected and starts no turn;
- a submission that never starts a turn stamps nothing, and the intent stays queued;
- a later dispatch of the same intent re-writes the stamps;
- the stamp attributes turns: an intent's turns run from its dispatch turn up to, not including, the next turn in the session that is another intent's dispatch turn, so the newest dispatched open intent owns follow-up turns;
- an intent is queued while it is open and holds no standing dispatch — never dispatched, its dispatch turn ended aborted, or its dispatching session stopped before that turn finished — the release derived, never written: the stamps remain and the queue position keeps its rank.

#### core-service-94

When a locally owned intent-attributed turn completes full settlement [[core-service-91](#core-service-91)], the core service shall automatically submit the project's first queued, unblocked intent in current rank order into the same conversation only when the settled turn proves successful governed-root completion ([DR-055](../decisions/055-queue-advancement.md)):

- proof is a stored `captain_telemetry` record on `playbook.trace` in that turn, whose trace has `schemaVersion: 4` and is `boss.input.settled` with `outcome: terminal` and `terminal.kind: success`, from a non-Captain root (`depth: 0`, `sessionId` equal to `rootSessionId`, no parent session), with no later unfinished governed work, root trace of an unsupported version or standing interruption;
- completion follows the root playbook's declared success, including a concluded DEV discussion with no repository changes;
- child completion, ordinary Captain replies, missing terminal evidence, unsupported or missing trace versions, failure, abort, questions and permissions do not prove success;
- selection and submission use the intent's current text, identity and rank, retaining explicit after-link blocking [[core-service-45](#core-service-45)], normal admission [[core-service-5](#core-service-5)], and actual-start dispatch stamping and attribution [[core-service-47](#core-service-47)]; a refused admission causes no automatic retry;
- the settled intent remains finished and awaiting its human verdict [[core-service-46](#core-service-46)] [[core-service-49](#core-service-49)], and a manual follow-up attributed to it may supply the successful settlement;
- each eligible settlement initiates at most one next dispatch, only while the conversation and attributed turn remain current; no next eligible intent starts nothing;
- queue capture or edits, ledger reads, confirmation, adoption and restart initiate no advancement, and no runner state is retained.

#### core-service-48

When a client sends `session.viewed` naming a session and a turn, the core service shall persist that turn as the session's last-viewed marker in the state root's preferences file [[core-service-15](#core-service-15)], so review state derives from stored data alone [[core-service-49](#core-service-49)] and survives a restart.

#### core-service-49

When a client sends `ledger.get`, the core service shall reply with the cross-project ledger read model, derived solely from the stored intents, turns, records, and viewed markers — the same stored data yielding an identical reply after a restart [[core-service-10](#core-service-10)] ([DR-035](../decisions/035-intent-ledger.md)):

| Part | Content |
| --- | --- |
| Attention entries | two bands — intents standing interrupted on the Boss (a pending question, a permission request, or an unacknowledged failure among their turns), then intents finished and awaiting a verdict — each band ordered longest waiting first by condition onset |
| Run stats | each finished entry carries stats folded from its intent's attributed turns [[core-service-47](#core-service-47)]: turn count, elapsed time, and the review rounds when any |
| Session stand-ins | a session bound to no intent enters the same bands for its own question, permission request, failure, or finished turn past the viewed marker [[core-service-48](#core-service-48)] |
| Project groups | per project: the current conversation's state [[core-service-93](#core-service-93)], the queue in rank order with each blocked intent marked [[core-service-45](#core-service-45)], and the open intents' source-artifact references [[core-service-42](#core-service-42)] |
| Badge | the count of all attention entries |

#### core-service-50

When a client sends `ledger.history` for a project, the core service shall reply with one page of that project's worked closed intents — closed done, or closed dropped after a turn of theirs ended finished ([DR-038](../decisions/038-history-is-done-work.md)) — newest-closed first, the same stored data yielding identical pages after a restart [[core-service-10](#core-service-10)]:

- a page holds at most twenty rows and carries a cursor naming its last row's close time and id;
- a request carrying a prior page's cursor returns the page after it, overlapping nothing.

#### core-service-51

When the intents table is written [[core-service-52](#core-service-52)], or a session event lands that can change a derived intent state — a turn's start, finish, or abort, a runtime's release, or an interruption-condition record — the core service shall broadcast an `intents.changed` message naming the affected project to subscribed clients, so every consumer re-reads the one core-side fold [[core-service-49](#core-service-49)] instead of deriving its own ([DR-035](../decisions/035-intent-ledger.md)).

### Intent Storage

#### core-service-52

The core package shall hold intents in one per-project append-only act log of acts and provenance only — no state or status field, every visible state derived at read time by folding the acts [[core-service-49](#core-service-49)] — kept in the state root [[core-service-15](#core-service-15)] and appended solely by the intent commands ([[core-service-42](#core-service-42)] [[core-service-43](#core-service-43)] [[core-service-44](#core-service-44)] [[core-service-45](#core-service-45)] [[core-service-46](#core-service-46)] [[core-service-79](#core-service-79)]) and the dispatch stamp [[core-service-47](#core-service-47)] ([DR-035](../decisions/035-intent-ledger.md), [DR-036](../decisions/036-file-state-store.md)):

| Field(s) | Content |
| --- | --- |
| `id` | the intent's identifier |
| `projectId` | the owning project |
| `text` | the staged Boss turn text; its first line is the display title |
| `source` (`kind`, `ref`, `url`) | provenance — issue, PR, record, or chat, with reference and URL — absent when unsourced |
| `rank` | the per-project lexicographic order key |
| `afterId` | the single optional predecessor intent, of any project |
| `createdAt` | the capture time |
| `dispatched` (`sessionId`, `turnId`, `at`) | the dispatch stamp, re-written by a later dispatch |
| `closedAt`, `closedAs` | the close time and verdict — `done` or `dropped` |

- Within a local history, an act is never deleted or rewritten: an edit, move, link, dispatch, close, or remove appends, and the fold takes each field's latest act; an intent removed before it was worked, and one a remove act retired [[core-service-79](#core-service-79)], keep their acts in the log while every read excludes them ([DR-038](../decisions/038-history-is-done-work.md)).

- Offline Git selection replaces a complete act log under the explicit whole-file rule [[storage-11](storage.md#storage-11)]; file-order folding does not merge divergent logs.

### Record Streaming

#### core-service-7

While a session is live, when the embedded runtime emits a record not marked hidden, the core service shall deliver that record to every client subscribed to the session, preserving the runtime's emission order for each subscriber.

#### core-service-8

While a session is live, when the embedded runtime emits a record marked hidden (for example judge or router traffic), the core service shall deliver it only to clients subscribed to the debug channel and shall not deliver it on any session subscription, per [DR-003](../decisions/003-runtime-reuse.md).

#### core-service-30

While a session is live, when the embedded runtime emits a captain result record marked hidden whose result reports an error, the core service shall synthesize a visible failure record carrying the underlying error text into the session stream ([DR-028](../decisions/028-run-machine-view.md)) — the cause reaches every session subscriber [[core-service-7](#core-service-7)] while the hidden record itself stays off the session channel [[core-service-8](#core-service-8)].

#### core-service-36

While a session is live, when the embedded runtime emits a player record, the core service shall deliver and persist it carrying the role of the call it belongs to ([DR-032](../decisions/032-session-players.md)), so a player several roles share is read as a sequence of calls rather than one voice:

- a `player.call.started` trace opens a call on the player it names, and that player's `player.call.finished` closes it;
- a player record between them carries the opening trace's role, and the closing record carries it too;
- a trace naming no resolved player opens nothing, and a player record outside any open call carries no role;
- a replayed record carries the same role the live stream carried [[core-service-10](#core-service-10)].

### Historical Context

#### core-service-80

When serving a stored session, the core service shall resolve its immutable participant/settings/binding/graph context through Playbook's replay references [[1]] and expose that context over the protocol without loading the historical executable module:

- absent legacy context or an unknown graph/context version is reported unavailable, never replaced with current settings or a guessed graph;
- graph activity is derived from the session's trace, and current configuration changes do not alter prior history.

### Readiness

#### core-service-9

When a client requests adapter readiness, the core service shall report one deduplicated entry per adapter the active config references, each entry naming the positions using that adapter — `captain`, and each session player as `<player>` followed by the `<playbook>.<role>` bindings it answers ([DR-032](../decisions/032-session-players.md)) — and carrying a readiness status derived from the same adapter readiness rules as the playbook launcher — the runtime half and the credential half together ([DR-024](../decisions/024-app-supplied-agent-runtimes.md), [DR-004](../decisions/004-config-and-persistence.md)) — naming the unmet requirement for each adapter that is not ready and reporting null readiness with verify-yourself guidance for an adapter with no preflight rule:

- When the active config changes, refreshed readiness is broadcast to connected clients; a reload superseded by a newer one — before committing, or while its runtime probes are in flight — commits and broadcasts nothing, so the state and readiness clients hold always correspond to the newest configuration read.

### Persistence

#### core-service-10

The core service shall persist and replay sessions through Playbook's common manifest/stream contract [[1]], using the shared root and explicit overrides [[storage-1](storage.md#storage-1)] ([DR-045](../decisions/045-unified-session-storage.md)):

- restart serves the same records and visibility filtering [[core-service-8](#core-service-8)], deriving turns, summaries and usage; liveness comes from runtime/leases rather than stored flags;
- valid opaque v1 records, including unknown/headerless objects, remain in sequence/digest accounting; unsupported presentation is skipped without damage;
- record-write failure preserves live presentation and durable recovery, marks the manifest's replay incomplete and refuses later continuation [[core-service-73](#core-service-73)]; a restart cannot clear the marker merely because the retained bytes parse;
- a reader serves the valid complete prefix with the damaged boundary reported, without altering files during a read;
- token-free presentation includes synthesized visible failures [[core-service-30](#core-service-30)]; provider hints never enter the portable stream or manifest;
- historical participants, settings, bindings and graphs come from stored context [[core-service-80](#core-service-80)], not today's installed modules.

#### core-service-60

The core service shall serve every session present in the shared session store's directory — the directory the shared config's `sessions` key names, defaulting to the shared home layout [[storage-1](storage.md#storage-1)] — whether found there at startup or written by another host while the service runs:

- session `cwd` resolves through local project bindings [[storage-6](storage.md#storage-6)]; resolved sessions list with shared continuation eligibility [[core-service-73](#core-service-73)], while unresolved sessions are reported unlisted;
- a record beside no replay stream lists from its Boss journal: each Boss entry opens a turn with its prompt, each Captain reply follows it, and the record's own timestamps bound them ([DR-037](../decisions/037-playbook-12-adoption.md));
- an arrival or change while the service runs is announced to subscribed clients as a session-state report, with `intents.changed` where a derived intent state can change [[core-service-51](#core-service-51)]; a record's disappearance is forgotten [[core-service-76](#core-service-76)];
- a stream append also reaches that session's subscribers through the record visibility filter [[core-service-8](#core-service-8)], once per appended record, without waiting for directory activity to stop; a replacement history is served on the next history request;
- each session is read independently from its complete newline-terminated stream prefix, so an unfinished final line waits for its newline and an unreadable manifest preserves its previous served history without hiding healthy neighbors;
- preserve opaque records [[core-service-10](#core-service-10)]; summary times use first/last finite record timestamps, otherwise manifest creation/update times or zero;
- registration or rebinding rescans existing session paths [[storage-6](storage.md#storage-6)], without waiting for a new record.

#### core-service-76

While the core service serves a session another host wrote [[core-service-60](#core-service-60)], when that session's record leaves the shared session store's directory, the core service shall forget the session — its listing entry [[core-service-32](#core-service-32)] and its served history — and broadcast the removal to subscribed clients, announcing `intents.changed` for its project [[core-service-51](#core-service-51)] ([DR-042](../decisions/042-sessions-continue.md)).

#### core-service-65

The core service shall mutate a session from either interface only through Playbook's shared lease-bound lifecycle [[1]], retaining lease-free reads and never maintaining a host-specific manifest or recovery sidecar ([DR-045](../decisions/045-unified-session-storage.md)).

#### core-service-61

When the core service starts against a state root that another core instance holds, the core service shall refuse to serve, reporting the holding instance to the host — one core per state root at a time ([DR-036](../decisions/036-file-state-store.md)).

#### core-service-64

Where the host shell names a legacy SQLite store, when the core service starts on a state root that has not yet imported it, the core service shall import the store's rows into the file state once, before serving — the imported data served identically to data written natively [[core-service-10](#core-service-10)], and the legacy file left in place ([DR-036](../decisions/036-file-state-store.md)):

- The same import relocates a legacy library directory into the state root, rewriting the shared config's `from` paths that point into it with the comment-preserving targeted edit ([DR-005](../decisions/005-compilation-integration.md)).

### Shutdown

#### core-service-39

When a host shell stops the core service, the core service shall persist every live session's Captain snapshot [[core-service-72](#core-service-72)] and attempt disposal of its runtime, close its endpoint and its store, and report the disposal failures to the host once every session has been attempted:

- One session's disposal failure neither skips another session's disposal nor leaves the endpoint or the store open.
- Successful cleanup reports the session as no longer live; failed cleanup retains its ownership evidence [[core-service-4](#core-service-4)].
- Shutdown waits for settlement bookkeeping already in progress before closing the store.

## Internal Behavior

### Package Layout

#### core-service-11

The `packages/core` workspace package shall build as a headless Node package that imports no UI framework, no Electron module, and no DOM API, so the identical package serves the desktop shell and a cloud server deployment without change.

### Protocol

#### core-service-12

The core package shall define the WebSocket protocol — message schemas, protocol version, and TypeScript message types — in one module and export the types from a dedicated entry point free of Node-only runtime imports, so the UI package consumes the protocol as type-only imports and never redefines it:

- When the protocol changes incompatibly, the protocol version carried by the hello message [[core-service-1](#core-service-1)] is bumped.

#### core-service-13

When an inbound protocol message is received, the core package shall validate it against the message schema before acting on it:

- When a message fails validation or carries an unknown type, the core package sends an error response identifying the failure, makes no state change, and leaves the connection open.

### Record Routing

#### core-service-14

The core package shall filter records by visibility [[core-service-8](#core-service-8)] at the protocol boundary, before dispatch to any subscription, applying the same filter to live streaming and to stored-record replay [[core-service-10](#core-service-10)], so that no message on a session subscription ever carries a hidden record and clients need no client-side filtering.

### Persistence Internals

#### core-service-15

The core package shall own Spex application files through the versioned encodings and root-lease writer contract [[storage-1](storage.md#storage-1)] [[storage-14](storage.md#storage-14)], using the staged migration before admitting clients [[storage-9](storage.md#storage-9)]:

- session schemas and migrations remain Playbook-owned [[1]];
- failed migration reports its cause and admits no writer to partially migrated data;
- released migrations remain immutable; a format change adds a new migration.

### Runtime Composition

#### core-service-16

The core package shall compose the session-player roster, the playbook registry, and runtime options from the shared config with the same fail-closed validation rules as the playbook launcher — as recorded in [DR-004](../decisions/004-config-and-persistence.md) and amended by [DR-019](../decisions/019-inline-agent-configuration.md) and [DR-032](../decisions/032-session-players.md) — so that any config the launcher accepts or rejects is accepted or rejected identically by the core package:

| Rule | Composition |
| --- | --- |
| Roster | a top-level `players` map of player id to inline agent block; a scalar adapter id normalizes to a bare-adapter block; an id outside `^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$`, or the reserved `captain`, is refused |
| Bindings | `playbooks.<id>.roles` maps every id in the entry's `requiredRoleIds` to a roster player, as a bare player id or a block naming `player` with `model`/`effort`; a role left unbound, or bound to an absent player, is refused naming it |
| Binding keys | `adapter`, `permissions`, `instruction` and `workspace` inside a binding are refused: they belong to the player's envelope |
| Tuning | an omitted `model`/`effort` inherits the player's, `false` selects the provider's current default, and a string pins it; the composed selection is complete on every call |
| Concurrency | every group in the entry's `concurrentRoleSets` must bind to pairwise-distinct players, refused naming the group otherwise |
| Roster scope | only players some binding references reach the composed session, so an unused roster entry gates no run |
| Legacy | a surviving `playbooks.<id>.players` block is refused in the launcher's own words |

#### core-service-17

When a session is created, the core package shall instantiate the engagement host through the playbook captain shell factory with a core-provided module loader, the session's host construction capabilities [[core-service-67](#core-service-67)], and its unresolved-effect settlement hooks injected via the shell's dependency options, keeping playbook module resolution under core control and the shell's coupling to the core type-only.

#### core-service-67

When creating or continuing a session, the core package shall obtain the shared Playbook host lifecycle and repository capabilities [[1]], backed by that session's lease and durable effect ledger rather than an in-memory replacement ([DR-045](../decisions/045-unified-session-storage.md)):

- a project that is not a Git worktree refuses before execution;
- repository/effect reconciliation precedes each turn, and a failure starts no turn;
- settlement and abandonment preserve the shared durable authority; no core-side snapshot can replace it.

#### core-service-74

When a session continues, the core package shall restore through Playbook's shared lifecycle [[1]], preserving logical session, turn, trace, operation and journal identities while appending to the existing stream:

- a fresh runtime restores the saved state rather than reinitializing completed work;
- the checkpoint's ledger must agree with the authoritative durable ledger before effects;
- intent dispatch uses the continued logical turn ID [[core-service-47](#core-service-47)], without an independent host-owned counter offset.

#### core-service-29

Where a configured playbook's registry entry accepts a `cwd` option and the config block leaves it unset, when a session is created, the core package shall pass the session project's directory as that playbook's `cwd` option in the captain options ([DR-014](../decisions/014-released-toolchain.md)):

- A `cwd` set in the config block passes through unchanged.

### Contract Testing

#### core-service-18

The core contract test suite shall exercise the service end to end through the WebSocket protocol against a scripted fake adapter that replays a predetermined record script, using no network access and no real agent credentials, so protocol behavior is verified deterministically in CI.

### Compile Lifecycle

#### core-service-25

The core package shall run at most one compile per playbook id at a time and accept a `compile.abort` command that cancels the in-flight compile for a playbook id:

- While a compile is in flight for a playbook id, a further `compile.run` for that id is rejected fail-closed with a `busy` error naming the id, per [DR-010](../decisions/010-interface-craft.md) principle 5.
- `compile.abort` cancels the in-flight compile by terminating the toolchain child process, emits a final canceled progress line, and makes the pending `compile.run` reply with an `aborted` error; no further progress output follows the canceled line.
- When `compile.abort` names a playbook id with no compile in flight, the core package rejects it with a `not_found` error.

### Readiness Reporting

#### core-service-26

The readiness report of [[core-service-9](#core-service-9)] shall be keyed by adapter: the core package shall resolve every configured position — the captain and each referenced session player, whether an inline agent block or a scalar adapter id, under the same resolution rule as the launcher [[core-service-16](#core-service-16)] — to its adapter and emit exactly one entry per distinct adapter listing those positions, so that no referenced adapter's unmet requirement is hidden by deduplication and a hand-written scalar still surfaces its adapter's requirements before the first turn fails.

## Verification

### Session Coverage

#### core-service-19

Where the core service runs with a valid config and the scripted fake adapter [[core-service-18](#core-service-18)], the test suite shall connect a WebSocket client, create a session for a temporary project directory, submit a Boss turn, and assert that:

- the session's runtime working directory is the project directory [[core-service-4](#core-service-4)];
- every non-hidden scripted record arrives on the session subscription in script order [[core-service-7](#core-service-7)];
- the turn ends with a finished record;
- a second Boss submission during the turn is rejected with a busy error and starts no turn [[core-service-5](#core-service-5)];
- no network connection is opened during the run [[core-service-18](#core-service-18)].

#### core-service-31

Where a session's captain finishes a turn with a hidden result reporting an error, the test suite shall assert the synthesized surfacing of [[core-service-30](#core-service-30)]: a session subscriber receives a visible failure record carrying the underlying error text with the turn's id, and no hidden record reaches the session channel [[core-service-8](#core-service-8)].

#### core-service-37

Where a scripted captain calls one player twice within a turn, bracketing each call with the trace that names a different role, the test suite shall assert that the prompt and result records of the first call carry the first role and those of the second carry the second, that the trace records themselves carry none, and that reading the session back from the store yields the same roles [[core-service-36](#core-service-36)].

#### core-service-33

Where a stored session held two turns and a failure record, and a second stored session held neither, the test suite shall assert the listing contract of [[core-service-32](#core-service-32)]: the first entry carries the first turn's text as its title, a turn count of two, and the failure marker; the second entry carries no title, a zero count, and no marker.

#### core-service-35

Where a client subscribes to a session that then runs a fake-adapter turn, the test suite shall assert the broadcast contract of [[core-service-34](#core-service-34)]: the state reported at the turn's start already carries the session's title, and the states reported at the turn's end and at the runtime's release [[core-service-91](#core-service-91)] each carry the title and turn count, not the zeros the session was created with.

#### core-service-40

Where a live session's runtime fails its disposal, the test suite shall request that session's disposal over the protocol during its turn and assert the failing-disposal case of [[core-service-4](#core-service-4)]: the request reports the failure and a fresh session request for the same project remains blocked.

### Shutdown Coverage

#### core-service-41

Where two sessions are live and the first one's runtime fails its disposal, the test suite shall stop the core service and assert the stop contract of [[core-service-39](#core-service-39)]:

- the second session's runtime is disposed even though the first one's disposal failed;
- the stop reports the first session's failure to the host after both sessions have been attempted;
- the endpoint accepts no further connection once the stop has returned.

### Record Visibility Coverage

#### core-service-20

Where the fake adapter script contains records marked hidden, the test suite shall subscribe one client to the session and a second client to the debug channel, and assert that the session subscriber receives no hidden record [[core-service-8](#core-service-8)] while the debug subscriber receives every hidden record [[core-service-14](#core-service-14)].

### Configuration Coverage

#### core-service-21

Where the config file carries a defect from each launcher fail-closed defect class recorded in [DR-004](../decisions/004-config-and-persistence.md) as amended by [DR-019](../decisions/019-inline-agent-configuration.md) [[core-service-16](#core-service-16)], the test suite shall assert, per defect, that the core service reports a config error naming the offending entry and rejects a session creation request while that config is active [[core-service-2](#core-service-2)].

### Persistence Coverage

#### core-service-22

Where a session has completed a Boss turn, the test suite shall stop the core service, start it again on the same state root and sessions directory [[core-service-15](#core-service-15)], and assert that the session, its turns, its records (content and order), and its usage totals are served identically after restart [[core-service-10](#core-service-10)], and that a session live at shutdown is reported as no longer live:

- Where the root carries an earlier release's file versions, the suite shall assert startup migrates forward, keeps every row, and serves the migrated data identically [[core-service-15](#core-service-15)].
- Where records carry provider resume tokens — in a result and in a `playbook.trace` payload — the suite shall assert the persisted and replayed stream carries none of them [[core-service-10](#core-service-10)].
- Where the stream file becomes unappendable mid-session, the suite shall assert the fail-soft contract of [[core-service-10](#core-service-10)]: the record is still served from memory, the listing marks the stream incomplete after the last durable sequence, and the mark survives a restart.
- Where a native stream is damaged before restart, the suite shall assert its valid history remains readable, its persisted incomplete marker keeps any earlier boundary [[core-service-10](#core-service-10)], and a Boss submission refuses continuation without appending to the damaged stream [[core-service-73](#core-service-73)].
- With opaque v1 objects interspersed, restart preserves records, sequences, later turn/usage folds and stream bytes without marking incompleteness [[core-service-10](#core-service-10)].
- Where the shell names a legacy SQLite store holding sessions and intents, beside a legacy library directory the shared config's `from` paths point into, the suite shall assert the one-time import of [[core-service-64](#core-service-64)]: the rows serve identically from the file state, the library relocates with its `from` paths rewritten and comments kept, the legacy store file is untouched, and a second startup imports nothing twice.

#### core-service-62

Where a fixture session — manifest naming a registered project's directory as its working directory, record-stream file, and no Spex sidecar — sits in the sessions directory before the core service starts, and the test suite writes a second such fixture session while the service runs, the test suite shall assert the foreign-session contract of [[core-service-60](#core-service-60)]:

- both sessions appear in the listing bound to that project, non-live, with titles and turn counts folded from their streams [[core-service-32](#core-service-32)];
- their records are served with hidden records filtered from the session subscription [[core-service-10](#core-service-10)];
- a session-state report announcing the second session reaches a subscribed client [[core-service-60](#core-service-60)];
- after the terminal appends to an already listed session's stream without replacing its manifest, the listing and history reflect the new title and turns, and the session subscriber receives each appended visible record once even during continuous directory activity, with the complete but unterminated final record withheld until its newline arrives [[core-service-60](#core-service-60)];
- rescanning the same streams leaves their turn and usage folds unchanged, replacing a stream refreshes its title and history, and a malformed neighboring manifest hides no healthy session [[core-service-60](#core-service-60)];
- leading, interspersed and trailing opaque v1 objects preserve history without inventing players, turns or failures; summary times stay finite even for wholly opaque streams [[core-service-60](#core-service-60)];
- a fixture session whose working directory matches no registered project is absent from the listing [[core-service-60](#core-service-60)];
- a fixture record with a Boss journal and no stream lists with the first Boss entry as its title, its Boss turns counted, and a history of turn starts, Captain replies, and turn finishes [[core-service-60](#core-service-60)];
- every fixture file is byte-identical once the service stops, and no sidecar joins them while only reads are requested [[core-service-65](#core-service-65)].

#### core-service-71

Where a stored session is idle and a second session holds a turn in flight, the test suite shall assert the deletion contract of [[core-service-70](#core-service-70)]: `session.delete` on the idle session removes its files, drops it from the listing [[core-service-32](#core-service-32)] and its history from `history.get`, and a subscribed client receives the removal; the same command on the live session is refused `busy`; and on a fixture session another host wrote [[core-service-60](#core-service-60)] whose lease names this live process it is refused `busy` naming the holder [[core-service-75](#core-service-75)], with the files byte-identical afterwards.

#### core-service-78

Where fixture sessions another host wrote [[core-service-60](#core-service-60)] sit in the sessions directory — one leased to a dead process on this host beside a retired lease, one leased to another host, and one unleased — the test suite shall assert the cross-host deletion contract: `session.delete` on the dead-leased session removes its record and stream through the shared lease, preserves retired guards, drops it from the listing, and reaches a subscribed client as a removal [[core-service-70](#core-service-70)] [[core-service-75](#core-service-75)]; on the session leased to another host it is refused `busy` naming that host, its files intact [[core-service-75](#core-service-75)]; and removing the unleased session's files while the service runs makes it leave the listing with a removal broadcast [[core-service-76](#core-service-76)].

#### core-service-88

When an integration suite changes stored history and project bindings through a running core, it shall verify removal and restoration of a recorded-path alias [[core-service-85](#core-service-85)], diagnostics preserving unresolved files [[core-service-86](#core-service-86)], and history-replacement notification before the updated summary [[core-service-87](#core-service-87)].

#### core-service-77

When the integration suite settles and restarts a shared-store session, it shall verify that either a desktop- or CLI-created supported checkpoint lists continuable [[core-service-32](#core-service-32)], that its runtime was released at settlement with the provider hints kept [[core-service-91](#core-service-91)], continues with the same identities and stream [[core-service-74](#core-service-74)], and persists recovery without provider tokens [[core-service-72](#core-service-72)]; that a message opens it on the current tuning while an added playbook changes nothing and a structural change is refused naming the field [[core-service-92](#core-service-92)]; and that active leases and turns in flight, history-only recovery, damaged digests, uncertain work, missing bindings and path/config drift shall refuse before a turn or intent stamp [[core-service-73](#core-service-73)]:

- a session parked on a question keeps its summons across the release and answers where it waited [[core-service-93](#core-service-93)];
- with release-time summary refresh held after runtime disposal, a next-message or new-session request waits for publication before admission [[core-service-91](#core-service-91)], and shutdown keeps the store open until refresh completes [[core-service-39](#core-service-39)]; a successful turn permits continuation, an aborted turn requires recovery, and no waiting message stamps an intent [[core-service-47](#core-service-47)].

#### core-service-63

While a core service is serving a state root, the test suite shall start a second core service against the same root and assert the admission contract of [[core-service-61](#core-service-61)]: the second start refuses to serve reporting the holder, and after the first service stops [[core-service-39](#core-service-39)], a fresh start on that root succeeds.

#### core-service-68

Where a config file with a comment and a non-default mode sits at the previous XDG location and the shared config path is absent, the test suite shall start the core service with a default config path and assert the relocation contract of [[core-service-66](#core-service-66)]: the shared path holds the same bytes and mode, the previous file is untouched, the active config is reported valid and not seeded, and an edit to the shared file survives a second start.

#### core-service-69

Where the core service runs with the installed playbook's real captain shell and registries over a git-initialized project, the test suite shall create a session and assert the capability contract of [[core-service-67](#core-service-67)]: the session starts with a capability covering every enabled playbook [[core-service-17](#core-service-17)], and a Boss turn round-trips the Captain's reply after reconciliation.

### Intent Ledger Coverage

#### core-service-53

Where the core service runs with a valid config and the scripted fake adapter [[core-service-18](#core-service-18)], the test suite shall drive intents through their lives over the protocol — queue, edit, reorder, dispatch on a session's turn, finish, and close — and assert that:

- a queued intent comes back from `ledger.get` in its project's queue at the requested position [[core-service-42](#core-service-42)] [[core-service-49](#core-service-49)];
- an edit lands while the intent is queued, and the same edit after dispatch is rejected [[core-service-43](#core-service-43)];
- a move reorders the queue within the project, and a move naming another project's intent is rejected [[core-service-44](#core-service-44)];
- closing the dispatched intent as `done` before its turn finishes is rejected, succeeds after the finish, and `dropped` is accepted on a second, still-queued intent, which then appears in no `ledger.history` page while the done one does [[core-service-46](#core-service-46)] [[core-service-50](#core-service-50)];
- removing the closed done intent takes it out of every `ledger.history` page and leaves the rest of the ledger as it was, while the same request against a still-open intent is refused `conflict` and against an unknown or already-removed one `not_found` [[core-service-79](#core-service-79)];
- an `intents.changed` broadcast naming the project arrives for each write and for the turn's start and finish [[core-service-51](#core-service-51)].

#### core-service-54

Where a store holds queued, dispatched, finished, and closed intents from a completed run, the test suite shall stop the core service, start it again on the same state root [[core-service-15](#core-service-15)], and assert that `ledger.get` replies identically to its pre-restart reply [[core-service-49](#core-service-49)] and that the intent act log carries no state or status field [[core-service-52](#core-service-52)].

#### core-service-55

Where a project holds an open issue-sourced intent, the test suite shall send a second `intent.queue` with the same source kind and reference and assert the dedup contract of [[core-service-42](#core-service-42)]: the reply is a `conflict` error naming the existing intent, no intent is stored, and once the existing intent closes [[core-service-46](#core-service-46)] the same request is accepted.

#### core-service-56

Where two open intents are linked one after the other, the test suite shall assert the link guards of [[core-service-45](#core-service-45)]: a reverse link closing the cycle is rejected fail-closed, a link to a closed intent is rejected, and closing the predecessor [[core-service-46](#core-service-46)] lifts the successor's blocked mark in the next `ledger.get` reply [[core-service-49](#core-service-49)].

#### core-service-57

Where a session is live on the fake adapter, the test suite shall submit Boss text carrying an intent id and assert the stamping contract of [[core-service-47](#core-service-47)]:

- when the submitted turn starts, the intent carries that session, that turn, and a dispatch time;
- a submission carrying the id of a blocked intent, or of another project's intent, is rejected and starts no turn;
- a submission rejected busy while a turn is active [[core-service-5](#core-service-5)] stamps nothing and leaves the intent queued;
- a dispatch turn that is aborted [[core-service-6](#core-service-6)] keeps its stamps while the next `ledger.get` re-derives the intent as queued at its kept rank [[core-service-49](#core-service-49)].

#### core-service-95

Where the integration suite starts intent-attributed work through real core commands with substitute agents, it shall verify automatic advancement [[core-service-94](#core-service-94)] across the following settlement cases:

- successful governed-root completion in schema version four starts the next unblocked intent exactly once after release and publication, using its latest queued text and rank, while the first remains finished and unconfirmed;
- a child success, ordinary Captain response, missing completion evidence, unsupported or missing trace version (including after an earlier valid success), failed root, aborted turn or standing question or permission starts no successor; a later manual follow-up with proven root success can advance, including a concluded DEV discussion with no repository changes;
- an explicit after-link to the unconfirmed predecessor remains blocked, and a competing manual submission or admission refusal creates no duplicate turn or dispatch stamp;
- adding or editing queued work during the active turn affects the next selection, while capture or edits after settlement, ledger reads, confirmation, adoption and restart start no work;
- subsequent dispatch bounds the first intent's attribution, and confirming that first intent changes neither the second intent nor its active turn.

#### core-service-58

Where a project's store holds twenty-five closed intents, the test suite shall page through `ledger.history` and assert the paging contract of [[core-service-50](#core-service-50)]: the first page holds the twenty newest-closed intents newest-first, the second page — requested with the first page's cursor — holds the remaining five with no overlap, and both pages reply identically after a restart on the same store [[core-service-15](#core-service-15)].

#### core-service-59

Where a session finishes a turn bound to no intent, the test suite shall assert the review-state contract of [[core-service-48](#core-service-48)]: `ledger.get` lists a finished-band stand-in entry for the unviewed turn [[core-service-49](#core-service-49)], a `session.viewed` naming that turn clears the entry from the next reply, and the entry stays cleared after a restart on the same store.

### Readiness Coverage

#### core-service-23

Where the config's agent blocks reference both an adapter whose readiness requirements are satisfied and one whose requirements are not (via controlled environment variables and home-directory fixtures), the test suite shall assert that readiness reporting marks each adapter's entry accordingly and names the unmet requirement for the not-ready adapter [[core-service-9](#core-service-9)].

### Compile Lifecycle Coverage

#### core-service-27

Where the core service runs with an injected compile spawner whose toolchain run blocks until canceled, the test suite shall start a compile over the protocol and assert that:

- a second `compile.run` for the same playbook id is rejected with a `busy` error naming the id while the first is in flight [[core-service-25](#core-service-25)];
- `compile.abort` for that id makes the pending `compile.run` reply with an `aborted` error, and the final progress line broadcast for the playbook is the canceled marker [[core-service-25](#core-service-25)];
- `compile.abort` for a playbook id with no compile in flight is rejected with a `not_found` error;
- after cancellation, a new `compile.run` for the same id is accepted.

### Endpoint Coverage

#### core-service-90

Where CI runs on Windows, the integration suite shall invoke core startup in a native Node process and assert the platform refusal leaves its absent config and data paths uncreated [[core-service-89](#core-service-89)].

#### core-service-38

Where the core service attaches to a test-supplied HTTP server [[core-service-1](#core-service-1)], the test suite shall connect real WebSocket clients to that server's port and assert the admissions and rejections of [[core-service-24](#core-service-24)]:

- a token-bearing handshake whose Origin is the server's own host succeeds and receives the hello with the protocol version, with the endpoint address reported to the host [[core-service-1](#core-service-1)];
- a handshake with a wrong or missing token is rejected;
- a token-bearing handshake from a foreign web origin is rejected;
- a token-bearing handshake with no Origin, and one from a `file://` origin, each succeed.

### Readiness Dedup Coverage

#### core-service-28

Where the config references one adapter from several positions — as the captain and as a session player, including a hand-written scalar adapter id — the test suite shall assert that readiness reporting includes exactly one entry for that adapter [[core-service-26](#core-service-26)], naming each referencing position, marked per the adapter readiness rules with the unmet requirement named when the adapter is not ready [[core-service-9](#core-service-9)].

#### core-service-81

When the integration suite opens recorded Captain/player work after removing its playbook modules and changing current configuration, it shall verify historical context and graphs are still served, activity derives from recorded traces, and absent/unknown context is reported without substitution [[core-service-80](#core-service-80)].

### core-service-84

When an integration suite interrupts CLI-created and desktop-created sessions and recovers them through core commands, it shall verify explicit recovery [[core-service-82](#core-service-82)] [[core-service-83](#core-service-83)]:

- listing and broadcasts expose the saved input and disable ordinary continuation [[core-service-32](#core-service-32)] [[core-service-34](#core-service-34)];
- an active external writer withholds recovery, and releasing its lease reveals uncertainty without another replay write [[core-service-32](#core-service-32)];
- Retry reuses saved configuration and input, preserves logical identities and intent dispatch, and refuses unsafe reconciliation;
- Discard restores the prior checkpoint or removes a fresh attempt without loading agents, and ledger advancement refuses without evidence loss;
- competing leases and repeated requests start no duplicate turn;
- aborted turns require recovery whenever the shared checkpoint remains uncertain [[core-service-6](#core-service-6)].

## References

[1]: https://github.com/sublang-ai/playbook/blob/main/specs/packages/session-storage.md "Shared session format and host lifecycle"
