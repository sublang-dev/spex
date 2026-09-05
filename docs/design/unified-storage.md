<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Current storage inventory

Writers inspected on 2026-09-05; this inventory defines no new contract.
[DR-045](../../specs/decisions/045-unified-session-storage.md) holds the proposed decisions and open format definitions.

## Paths

`H` is `${SPEX_HOME:-~/.spex}`.
`S` is the shared config's `sessions` path, defaulting to `${XDG_STATE_HOME:-~/.local/state}/playbook/sessions`; relative overrides resolve beside the config.

| Path | Contents and encoding | Role and portability |
| --- | --- | --- |
| `H/playbook/playbook.config.yaml` | Shared YAML config; no schema-version field. Captain, players, playbooks, layout, notifications, theme, sessions locator. | Durable; locators can name machine-local paths. |
| Config `.bak`, `.bak.<n>` | Original YAML. | Retained migration inputs. |
| `H/projects.json` | `{v:1, projects:[{id,path,name,registeredAt}]}` | Durable identities; repository paths may need relocation. |
| `H/intents/<projectId>.jsonl` | `{v:1,...act}` per line; `queue`, `edit`, `move`, `link`, `dispatch`, `close`, `remove`. | Durable ordered history; queue state is folded. |
| `H/prefs.json` | `{v:1,prefs:{...}}`; includes `viewed:<sessionId>` turn markers. | Durable preferences; viewed markers depend on matching history. |
| `H/playbooks/<id>/` | Library source and compiler-produced modules, registry, and FSM bundles. | Durable source; enabled config references generated registry files. |
| `H/meta.json` | `{version:1,importedLegacy?:string[]}`; paths record completed imports. | Migration bookkeeping; machine-local paths. |
| `H/forge-cache.json` | `{v:1,entries:{[projectId]:{at,state}}}` | Disposable cache. |
| `H/.lock/owner.json` | `{pid,hostname,acquiredAt,token}`; staging and retired lock directories accompany it. | Local coordination. |
| `S/<id>.json` | CLI Captain-session manifest; schema 6. | Durable recovery authority; includes provider tokens. |
| `S/<id>.spex.json` | Desktop session sidecar. | Desktop authority; token-free export is not guaranteed. |
| `S/<id>.records.jsonl` | Both interfaces' replay stream. | Durable presentation history, including hidden records. |
| `S/.<id>.lock/owner.json` | Playbook schema-1 lease: session identity, owner token, host, PID, acquisition time; accompanying staging and retired directories. | Local coordination; retired paths guard against delayed reclaimers and persist after session deletion. |

Temporary atomic-write files serve publication, not additional authoritative data.
Sources: [core file writers](../../packages/core/src/store.ts), [path resolution](../../packages/core/src/config.ts), [library compiler](../../packages/core/src/compile.ts), [protocol data types](../../packages/core/src/protocol.ts).
Playbook owns its session contract [[1]].

Outside `H`: repositories and their effect claims, provider data, and Electron's browser profile.
Browser local storage holds selected-project, rail, expansion, pane-layout, frame, and onboarding preferences; session storage holds the core access token.
Composer drafts are memory-only.

## Session encodings

### Replay stream

Each complete UTF-8 JSON line has the closed envelope:

```json
{"v":1,"seq":1,"role":"coder","record":{"type":"player_prompt","timestamp":1788566400000,"playerId":"dev.coder","turnId":1,"prompt":"Review the change"}}
```

- `v`: envelope version `1`.
- `seq`: writer-assigned, positive contiguous sequence from `1` across the session.
- `role`: optional local playbook role, distinct from the participant identity in `record`.
- `record`: token-free opaque JSON object; v1 requires neither `type` nor `timestamp`. Known presentation records carry these fields for Captain messages, player prompts/results, visibility, usage, and machine traces.
- Readers consume complete newline-terminated records. Legacy gaps may remain viewable without proving safe continuation.

The stream records presentation and observations, not permission to repeat external effects.
Runtime traces identify graph activity but omit historical graph definitions.
Graphs have `initial`, `nodes`, and `edges`; nodes describe hierarchy, kind, role, description and tags; edges describe endpoints and events.

### CLI manifest

Required fields:

| Fields | Meaning |
| --- | --- |
| `schemaVersion:6`, `kind:"captain-session"` | Manifest encoding identity. |
| `sessionId`, `createdAt`, `updatedAt`, `cwd` | Session identity, ISO timestamps, and working directory. |
| `state` | `settled` or `uncertain`; independent of whether the lease is held. |
| `structuralProjection` | Configuration structure required for compatible restoration. |
| `lastAppliedExecutionProjection` | Settings used at the recorded execution boundary. |
| `snapshot` | Captain conversation/journal, counters, player continuity, and active runtime frames. |
| `effectLedger`, `unresolvedEffects` | Durable effect authority and unresolved work. |

Optional `retainedGenerations` holds resumable execution checkpoints; it is not a graph archive.
Optional `settledAbandonment` records abandonment recovery.
An uncertain manifest adds `uncertain` with `baseUpdatedAt`, `input`, `attemptId`, `attemptNumber`, `markedAt`, `attemptedExecutionProjection`, and optional `abandonment`.
Playbook validates nested payloads, versions, and relationships; field presence alone does not prove resumability.

### Desktop sidecar

Encoding: `{v:1,id,projectId,createdAt,endedAt,live,players,initialVisible,streamIncompleteAfterSeq?,snapshot?}`.
Timestamps are numeric; `endedAt` can be null.
`snapshot` is `{v:1,shell?}`; token removal covers known Captain/player/frame fields, not every nested recovery payload.
`players` contains `{id,adapter,model?,fastMode?}` entries, without the full settings or binding context proposed for the unified format.
`live` is reset after restart; `streamIncompleteAfterSeq` blocks continuation without discarding readable history.
The sidecar lacks the CLI's complete recovery contract.

## References

[1]: https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md#shared-session-store "Playbook shared session store contract"
