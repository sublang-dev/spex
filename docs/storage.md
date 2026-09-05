<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# The `~/.spex` catalog

**Spex home** is the shared data directory for desktop and CLI.
It defaults to `~/.spex`; `SPEX_HOME` selects another directory.
Explicit paths for configuration and session storage replace their respective defaults.
All paths below are relative to Spex home; files stored elsewhere are outside its Git repository.

## File catalog

A **session bundle** is one session's manifest and matching replay stream.
Synchronization selects both files from the same revision or deletes both; it never merges them independently.
Git does not enforce this relationship.

Ignored files can contain durable local state.

| Path | Contents | Git |
| --- | --- | --- |
| `playbook/playbook.config.yaml` | Shared Captain, player, playbook and presentation settings; session directory. | Tracked |
| `projects.json` | Project IDs, names and registration times. | Tracked |
| `intents/<projectId>.jsonl` | Ordered intent changes. | Tracked |
| `sessions/<id>.json` | Schema-7 manifest: identity, `cwd`, checkpoint and recovery evidence. | Tracked |
| `sessions/<id>.records.jsonl` | Captain/player records, historical settings, role bindings and graphs. | Tracked |
| `playbooks/<id>/` | Library sources and generated modules/artifacts. | Sources tracked; outputs omitted only if rebuildable locally |
| `local/project-paths.json` | Project IDs mapped to local paths and recorded `cwd` aliases. | Ignored |
| `prefs.json` | Core preferences, including the last viewed turn per session. | Ignored |
| `forge-cache.json` | Rebuildable issue and pull-request cache. | Ignored |
| `meta.json`, `local/migrations/<id>/` | Migration receipts and original inputs. | Ignored |
| Config backups | Original configuration files. | Ignored |
| `sessions/<id>.hints.json` | Provider resume tokens for the current checkpoint. | Ignored |
| `.lock/`, `sessions/.<id>.lock/`, staging and retired lease directories | Exclusive writer ownership and safe stale-lock recovery. | Ignored |
| Atomic-write temporary files | Pending file replacements. | Ignored |

Spex owns application data; Playbook owns session validation, migration, continuation and deletion.
One core serves each Spex home; one writer owns each session.
Writes require the corresponding lease.

## Session contents

The **manifest** stores recovery state: the checkpoint, journal, unresolved work and effect ledger used to reconcile external actions.
Recovery evidence is durable before external actions run, independently of transcript writes.
The checkpoint identifies an exact replay prefix by sequence and digest.
Its state is `settled`, `uncertain` or `history-only`; transcript completeness alone does not establish safe continuation.

A turn is marked `uncertain` before execution and stays so until settlement.
If its writer stops first, desktop or CLI requires explicit recovery:

- **Retry** reconciles completed work, then retries the saved input with its saved configuration.
- **Discard** restores the preceding checkpoint only if the effect ledger has not advanced; a fresh session with no settled checkpoint may be removed.

Neither action authorizes repeating completed effects or erasing unresolved evidence.

The **replay stream** contains Captain/player records, including hidden records, and immutable execution context: participants, settings, role bindings and state-machine definitions.
Events and checkpoints reference that context, allowing recorded graphs to render without installed playbook modules.
When a host has no graph definition, history shows only observed states and transitions.
Activity, summaries and usage are derived from records.
Valid unknown record kinds and headerless legacy records are not corruption.
Unsupported recovery versions allow history viewing and deletion, but no continuation; older writers preserve their bytes.

**Provider hints** are local resume tokens bound to one participant and the exact manifest bytes.
A hint is deleted and the deletion synced before use; replacement hints are written only after the resulting checkpoint.
This prevents stale reuse after a crash or rollback.
Missing hints start fresh conversations from the Captain's journal or the player's complete task prompt.
Definite rejection before execution permits one fresh attempt; ambiguous failures never retry automatically.
Provider-only knowledge is unavailable, while pending operations retain their player identity and effect evidence.

## Git synchronization

Track portable files only after migration removes provider tokens from recovery fields.
Original migration inputs and unsupported files remain ignored.
Tracked `.gitignore` rules exclude local data; `.gitattributes` disables line-ending conversion for JSON/JSONL files.

Use one branch per device's Spex home, shared by desktop and CLI and merged to or from `main`.
The [Git workflow](storage-git.md) gives the selection and validation commands.
Stop local writers during commit, checkout and merge.
Run each session on at most one device at a time; leases are local.

Compare each session bundle in both pre-merge revisions with the common ancestor:

| Changes | Selection |
| --- | --- |
| Neither side changed, or both agree | Agreed session or deletion |
| Only one side changed | That session or deletion |
| Both changed differently | Explicit whole-session choice from either branch |

The bundle rule applies even after a clean text merge.
Apply the same selection rule to each configuration file, project registry and intent log as an individual file.
Unselected changes leave active state but remain recoverable from Git history.
Git's text merge alone does not enforce these rules.

Before reopening, validate the selected files and intent logs for duplicate artifact sources or queue ranks, dependency cycles and invalid session/turn references.
Report unresolved project paths and missing project IDs; retain their files unlisted without automatic registration.
Before continuing, reconcile repository state and completed external actions with the selected checkpoint.
Git selection cannot undo actions recorded only in the unselected history.

Reopening tightens verified user-owned session directories to `0700` and files to `0600` before strict validation; unsafe paths are rejected.
Use `umask 077` for Git writes to prevent exposure before reopening.

## Cross-device continuation

Map existing project IDs to local repository paths and aliases for recorded working directories.
Restore missing registrations from Git ancestry rather than creating replacement IDs.
Each recorded path must identify the same project across devices; unresolved or conflicting mappings require explicit selection.

Managed playbook `from` paths are relative to the primary configuration directory; package specifiers remain unchanged.
Validate other paths and rebuild nonportable generated files before use.

Aliases associate history with a project; they do not authorize checkpoint relocation.
**Schema 7 does not relocate checkpoint paths.**
Different repository or module paths permit history only, even with fresh provider conversations.
Matching paths still require compatible runtimes and repository/effect reconciliation.

## Deletion

With the session lease held, delete replay, hints, any active legacy sidecar and derived session state, then the manifest last.
Interrupted cleanup is retryable; incomplete bundles cannot continue.
Deletion fails if another writer is active or exclusive ownership cannot be proven.
Retired lease directories remain so delayed stale-lock recovery cannot affect a new owner.
If one branch deletes a session and another modifies it, synchronization requires an explicit choice between deletion and the complete modified bundle.

Project removal retains session and intent files for explicit recovery.
Replacing session history resets its last-viewed turn.
Local preferences, path bindings and migration records are excluded from Git; caches are rebuildable.

## External data

Project repositories and their effect claims, installed runtimes, provider credentials/history and browser profiles remain external.
Layout preferences stay in browser storage.
Unsaved drafts and access tokens are not portable session state.

## Migration and definitions

Stop legacy writers before replacing desktop sidecars with shared manifests.
Default-home startup imports the former XDG session directory and retains its original files in migration receipts.
Explicit homes or session directories are not auto-populated from that old store.
CLI schemas 2–5 and desktop checkpoints without compatible recovery data remain history only.
Legacy provider tokens cannot become usable hints because their checkpoint binding is unproven.

[DR-045](../specs/decisions/045-unified-session-storage.md) records the design and rationale.
Exact formats and behavior are defined by their owning packages:

| Owner | Definition |
| --- | --- |
| Spex | [Home files, project bindings, migration and Git selection](../specs/packages/storage.md) |
| Playbook | [Session format, context, hints and recovery](https://github.com/sublang-ai/playbook/blob/main/specs/packages/session-storage.md) |
| Cligent | [Definite provider session rejection](https://github.com/sublang-ai/cligent/blob/main/specs/packages/engine.md#engine-84) |
