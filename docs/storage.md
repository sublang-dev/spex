<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# The `~/.spex` catalog

This catalog describes the proposed storage contract in [DR-045](../specs/decisions/045-unified-session-storage.md).
Implementation is pending; the [current inventory](design/unified-storage.md) records today's layout.

One home holds Spex's durable core data and the sessions shared by desktop and CLI.
Paths below are relative to `${SPEX_HOME:-~/.spex}`; explicit config/store overrides prevail, and files outside this root do not participate in its Git history.

## Files at a glance

“Local” means untracked and ignored by Git, not necessarily disposable.

| Path or file family | Contents | Git |
| --- | --- | --- |
| `playbook/playbook.config.yaml` | Shared Captain, player and playbook settings; presentation settings; session location. | Track |
| `projects.json` | Version 2: project ID, name and registration time; no machine paths. | Track |
| `intents/<projectId>.jsonl` | Ordered acts: queue, edit, move, link, dispatch, close and remove. | Track |
| `sessions/<id>.json` | Schema 7: identity, recorded `cwd`, checkpoint, recovery evidence and replay digest. | Track with its stream |
| `sessions/<id>.records.jsonl` | Captain/player history, visibility, settings, bindings and graph definitions. | Track with its manifest |
| `playbooks/<id>/` | Library sources and generated modules/artifacts. | Track sources; omit outputs only with local rebuilding |
| `local/project-paths.json` | Project IDs mapped to current absolute paths and recorded-path aliases. | Local |
| `prefs.json` | Core preferences and per-session viewed markers. | Local |
| `forge-cache.json` | Version 1: cached forge work lists; rebuildable. | Local |
| `meta.json`, `local/migrations/<id>/` | Legacy import markers; new `receipt.json` and original bytes under `inputs/`. | Local |
| Config backups | Original configuration files. | Local |
| `sessions/<id>.hints.json` | Version 1: optional Captain/player tokens bound to the exact manifest digest. | Local |
| `.lock/`, `sessions/.<id>.lock/`, staging and retired lease directories | Writer coordination and protection against delayed reclaimers. | Local |
| Temporary atomic-write files | In-progress publication of a replacement file. | Local |

Spex owns application data; Playbook owns session validation, migration, continuation and deletion for both interfaces.
One core serves a root; one writer owns a session; mutations require the applicable lease.
Git also maintains its own `.git/` metadata.
Tracked `.gitignore` and `.gitattributes` enforce the exclusions and preserve JSON/JSONL bytes without line-ending conversion.

## What a session preserves

The **manifest** preserves the checkpoint, recovery journal, external-action evidence and unresolved work.
Recovery evidence is written before external actions and retained independently of the transcript.
The checkpoint binds to an exact history prefix by sequence and digest.
Its state is settled, uncertain, or history-only; a readable transcript alone cannot establish safe continuation.

The **stream** preserves Captain/player history, including hidden records, and immutable context: participants, settings, bindings and state-machine definitions.
Events and checkpoints reference that context; activity, summaries and usage are derived.
Historical graphs need no installed playbook module.

Each complete UTF-8 JSON line uses the closed v1 envelope; a record following context at sequence 1 can look like:

```json
{"v":1,"seq":2,"role":"coder","record":{"type":"player_prompt","timestamp":1788566400000,"contextSeq":1,"playerId":"dev.coder","prompt":"Review the change"}}
```

- `seq` increases contiguously from `1`; `role` is an optional string; no other envelope keys are allowed.
- `record` is a token-free JSON object. Legacy objects need no presentation header; new context/reset kinds require a string `type` and finite numeric `timestamp`.
- Unknown valid records count toward sequence/digest checks but may have no presentation; they are not damage.
- Unsupported recovery context/checkpoints permit history only; older writers leave unknown versions unchanged.

Local hints bind to an exact participant/checkpoint.
They are consumed durably before use and renewed only after the resulting checkpoint, preventing reuse after a crash or rollback.
Missing hints start fresh conversations from Captain's journal or the player's complete task prompt; provider-only knowledge is lost.
Definite pre-execution session rejection permits one fresh attempt; ambiguous failures never auto-retry.
Deferred operations retain player identity and effect evidence without a provider token.

## Sharing through Git

Start shared Git ancestry **after migration removes all provider tokens from portable recovery bindings**; originals and unsupported inputs stay ignored.
Use one branch per device/root, shared by desktop and CLI, merged to/from `main`.
Stop local writers during commit, checkout and merge; execute each session on one device at a time.
Reopening tightens verified user-owned session directories/files to `0700`/`0600` before strict validation; unsafe paths still refuse.
A private `077` Git umask avoids exposure before reopening.

Compare each complete session bundle with the common ancestor:

| Changes | Result |
| --- | --- |
| Neither side changed, or both agree | Keep the agreed bundle or deletion. |
| Only one side changed | Take that bundle or deletion. |
| Both changed differently | Explicitly choose the entire session from ours or theirs. |

The manifest and stream are inseparable, even after a clean text merge.
Apply the same rule per file to config, projects and intent logs.
Unselected history/acts leave active state but remain in Git ancestry; divergent conversations are never combined.
Git's text merge alone does not enforce these rules.

Before reopening, validate intent source uniqueness, queue order and acyclic links against the chosen histories.
Report unresolved paths and missing project IDs; preserve their files unlisted without automatic registration.
Reconcile omitted executed work before continuing: Git cannot undo external effects.

## Opening on another device

Bind existing project IDs to local paths and recorded-path aliases; restore missing identities from Git ancestry rather than minting replacements.
Assume each recorded path names one project across devices; unresolved or conflicting bindings require an explicit choice.

Managed playbook `from` paths are config-relative; bare package specifiers stay unchanged.
Validate other paths and rebuild nonportable generated files before use.

**Aliases bind history only.**
The initial format supports no checkpoint path relocation: different repository/module paths mean history only—even with fresh agent conversations.
Matching paths still require compatible runtimes and repository/effect reconciliation.

## Deletion and local data

Under the session lease, deletion removes the stream, hints, active legacy sidecar and derived state, then the manifest last.
Interrupted cleanup is retryable; incomplete bundles cannot resume.
Active or unprovable ownership refuses deletion; retired lease guards remain.
Git records deletions, including delete-versus-modify choices.

Project removal leaves session and intent files for explicit recovery.
Viewed markers reset when history is replaced.
Caches rebuild; preferences, bindings and migration records preserve local state outside Git.

Repositories and their effect claims, installed runtimes, provider credentials/history and browser-engine profiles remain external.
Rail, split, expansion, frame and other layout preferences stay in browser storage; no core preference API or migration is added.
Unsaved drafts and access tokens are not portable session state.

## Migration and contract owners

Stop old writers before replacing desktop sidecars with shared manifests; CLI schemas 2–5 and incompatible desktop checkpoints remain history only.
Legacy tokens are not promoted to usable hints because their checkpoint binding cannot be proven.

Each contract is defined once; this catalog explains their combined layout.

| Owner | Authoritative definition |
| --- | --- |
| Spex | [Home files, bindings, migration and Git selection](../specs/packages/storage.md) |
| Playbook | [Session schema, context, hints and recovery](https://github.com/sublang-ai/playbook/blob/main/specs/packages/session-storage.md) |
| Cligent | [Definite pre-execution resume rejection](https://github.com/sublang-ai/cligent/blob/main/specs/packages/engine.md#engine-84) |
