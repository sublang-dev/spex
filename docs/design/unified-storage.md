<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Unified storage: catalog and format

Draft companion to [DR-045](../../specs/decisions/045-unified-session-storage.md), based on the writers inspected on 2026-09-05.
Current encodings below are an inventory; the proposed format is not yet a released contract.
On acceptance, move the agreed requirements into the owning spec packages and retire this draft, following [DR-046](../../specs/decisions/046-decision-record-evolution.md).

## Proposed contract ownership

- Spex owns the home-directory catalog and application data: projects, intents, preferences, and library sources.
- Playbook owns the shared session format, validation, migration, and recovery for both interfaces.
- Cligent owns provider-session rejection classification; provider credentials and conversation stores remain external.
- Each encoding has one authoritative definition in its owner's spec package; implementation validators enforce it. This document does not establish a second snapshot schema.

## Current directory catalog

`H` is `${SPEX_HOME:-~/.spex}`.
`S` is the shared config's `sessions` path, currently defaulting to `${XDG_STATE_HOME:-~/.local/state}/playbook/sessions`; relative overrides resolve beside the config.
DR-045 proposes `H/sessions` as both interfaces' default, preserving explicit overrides.

| Path | Contents and current encoding | Transfer treatment |
| --- | --- | --- |
| `H/playbook/playbook.config.yaml` | Shared YAML config; no schema-version field. Captain, players, playbooks, layout, notifications, theme, sessions locator. | Durable; module and filesystem locators must resolve on the destination. |
| Config `.bak`, `.bak.<n>` | Original YAML retained by migration. | Recovery copies; never an active config. |
| `H/projects.json` | `{v:1, projects:[{id,path,name,registeredAt}]}` | Durable identities; repository paths may need relocation. |
| `H/intents/<projectId>.jsonl` | `{v:1,...act}` per line; `queue`, `edit`, `move`, `link`, `dispatch`, `close`, `remove`. | Durable ordered history; queue state is folded. |
| `H/prefs.json` | `{v:1,prefs:{...}}`; includes `viewed:<sessionId>` turn markers. | Durable preferences; viewed markers depend on matching history. |
| `H/playbooks/<id>/` | Library source plus compiler-produced modules, registry, and FSM bundles. | Preserve source; generated files require a working rebuild path before omission. |
| `H/meta.json` | `{version:1,importedLegacy?:string[]}`; paths record completed imports. | Migration bookkeeping; copied machine paths must not decide destination imports. |
| `H/forge-cache.json` | `{v:1,entries:{[projectId]:{at,state}}}` | Disposable cache. |
| `H/.lock/owner.json` | `{pid,hostname,acquiredAt,token}`; staging and retired lock directories accompany it. | Local coordination; exclude from transfer. |
| `S/<id>.json` | CLI Captain-session manifest; current schema 6, described below. | Durable recovery authority; currently includes provider tokens. |
| `S/<id>.spex.json` | Desktop session sidecar, described below. | Preserve for migration; token-free export is not guaranteed. Retire its writer at cutover. |
| `S/<id>.records.jsonl` | Both interfaces' replay stream, described below. | Durable presentation history, including hidden records. |
| `S/.<id>.lock/owner.json` | Playbook schema-1 lease with session identity, owner token, host, PID, and acquisition time; staging and retired directories accompany it. | Local coordination; exclude from transfer, never delete as ordinary history. |

Temporary atomic-write files are publication machinery, not additional authoritative data.
The current [core file writers](../../packages/core/src/store.ts), [path resolution](../../packages/core/src/config.ts), [library compiler](../../packages/core/src/compile.ts), and [protocol data types](../../packages/core/src/protocol.ts) define the implementation inventory.
Playbook's storage spec [[1]] owns its session contract.

Outside `H`: repositories and their effect claims, provider data, and Electron's browser profile remain external.
Browser local storage currently holds selected-project, rail, expansion, pane-layout, frame, and onboarding preferences; session storage holds the core access token.
Composer drafts are currently memory-only.
Portable user preferences need an explicit migration into core-managed preferences; browser credentials and transport tokens stay local.

## Current session encodings

### Replay stream

Each complete UTF-8 JSON line has the closed envelope:

```json
{"v":1,"seq":1,"role":"coder","record":{"type":"player_prompt","timestamp":1788566400000,"playerId":"dev.coder","turnId":1,"prompt":"Review the change"}}
```

- `v`: envelope version, currently `1`.
- `seq`: positive contiguous sequence from `1` across the session, assigned by its writer.
- `role`: optional local playbook role; distinct from the participant identity inside `record`.
- `record`: token-free JSON event. Event types carry Captain messages, player prompts/results, visibility, usage, and machine traces; the envelope alone does not define their semantics.
- A reader consumes complete newline-terminated records. Legacy gaps may remain viewable without proving safe continuation.

The stream records what was presented or observed; it does not authorize repeating external effects.
Current runtime traces identify graph activity but do not preserve the historical graph definitions.

### CLI manifest

Current required fields:

| Fields | Meaning |
| --- | --- |
| `schemaVersion:6`, `kind:"captain-session"` | Manifest encoding identity. |
| `sessionId`, `createdAt`, `updatedAt`, `cwd` | Session identity, ISO timestamps, and working directory. |
| `state` | `settled` or `uncertain`; independent of whether a process currently holds the lease. |
| `structuralProjection` | Configuration structure required for compatible restoration. |
| `lastAppliedExecutionProjection` | Settings used at the recorded execution boundary. |
| `snapshot` | Captain conversation/journal, counters, player continuity, and active runtime frames. |
| `effectLedger`, `unresolvedEffects` | Durable effect authority and unresolved work. |

Optional `retainedGenerations` holds resumable execution checkpoints; it is not a graph archive.
Optional `settledAbandonment` records abandonment recovery.
An uncertain record also carries `uncertain` with `baseUpdatedAt`, `input`, `attemptId`, `attemptNumber`, `markedAt`, `attemptedExecutionProjection`, and optional `abandonment`.
Playbook validates the nested versioned payloads and their relationships; Spex must not duplicate those schemas or infer resumability from this field inventory.

### Desktop sidecar

Current encoding: `{v:1,id,projectId,createdAt,endedAt,live,players,initialVisible,streamIncompleteAfterSeq?,snapshot?}`.
Its timestamps are numeric; `endedAt` can be null.
`snapshot` is `{v:1,shell?}`; the current desktop projection removes known Captain/player/frame token fields, without traversing every nested recovery payload.
`players` contains `{id,adapter,model?,fastMode?}` entries; it does not preserve the full settings or binding context proposed for the unified format.
`live` is reset after restart; `streamIncompleteAfterSeq` blocks continuation without discarding readable history.
The sidecar lacks the CLI's complete recovery contract, so conversion must not fabricate missing authority.

## Proposed shared session contract

| Component | Required content and authority |
| --- | --- |
| `<id>.json` | One Playbook-owned manifest: stable identity, portable project locator, versioned recovery payload, uncertainty/effect authority, and replay-prefix sequence plus digest. Existing recovery evidence remains independent of replay. |
| `<id>.records.jsonl` | The existing v1 envelope, with immutable execution-context records as well as events; checkpoint references bind to recorded context and history. |
| Execution context | Captain and all player identities, roster, settings, role bindings, and data-only machine graphs. Events identify their context so later config edits cannot rewrite historical views. |
| Local provider hints | Participant and exact-checkpoint binding plus opaque provider token. Optional, excluded from portable state; absence permits a fresh conversation. |
| Deletion evidence | Session ID and deleted-bundle digest, durably published before removal; distinguishes deletion from an absent copy. |
| Conflict copies | Complete conflicting bundles preserved outside the active session namespace; never combined into executable state. |

Graph data reuses the existing shape: `initial`, `nodes`, `edges`; nodes identify hierarchy, kind, role, description and tags, and edges identify endpoints and events.
Store definitions with session history so historical rendering needs no installed playbook module.
Runtime checkpoints remain Playbook-owned opaque payloads; exact resumption still requires compatible runtimes and repositories.

DR-045 supplies the [merge and deletion decisions](../../specs/decisions/045-unified-session-storage.md#merge).
Both files form one session bundle: imports validate and activate complete bundles under the applicable lease; failures preserve uncertainty and sources.
Unknown versions can be preserved without being executable; supported readers must distinguish readable history from valid recovery authority.

## Definition required before cutover

The catalog is complete for the known file kinds; the new wire format still needs these explicit owner decisions:

- Playbook: manifest version and exact added fields; context event discriminator/version, context references, and digest encoding; no independently invented Spex manifest schema.
- Playbook: paths and versioned encodings for hints, tombstones, staged imports and conflict bundles, with one shared reader/writer implementation.
- Spex: portable project identity versus destination path binding; browser-preference migration; treatment of import receipts and config backups; source-versus-generated library retention.
- Both: a quiescent export/import contract that preserves session identities and hidden history, excludes local coordination and hints, and validates compatibility before activation.

Initializing Git in `H` is not itself that contract: ordinary text merges cannot validate a manifest/stream pair, and local-only files require deliberate exclusion.
Do not promise a self-contained runnable clone until locator resolution and required artifact rebuilding are specified.

## References

[1]: https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#shared-session-store "Playbook shared session store contract"
