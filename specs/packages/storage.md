<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# storage: Portable Spex State

## Intent

This package defines Spex-owned file encodings, project binding, migration and offline Git selection under [DR-045](../decisions/045-unified-session-storage.md).
Playbook owns the session bundle and its recovery rules [[1]]; this package treats that bundle as one selection unit.

## External Behavior

### storage-1

The store shall place its default core-owned durable data under `${SPEX_HOME:-~/.spex}`, with explicit config/store overrides taking precedence and each path below relative to that root:

| Path | Authority | Git |
| --- | --- | --- |
| `playbook/playbook.config.yaml` | Shared launcher configuration | Tracked |
| `projects.json` | Project identities [[storage-2](#storage-2)] | Tracked |
| `intents/<projectId>.jsonl` | Ordered intent acts [[storage-4](#storage-4)] | Tracked |
| `sessions/<id>.json`, `sessions/<id>.records.jsonl` | Playbook manifest and replay bundle [[1]] | Tracked together |
| `playbooks/<id>/` | Library sources and outputs [[storage-8](#storage-8)] | Sources tracked; outputs omitted only with rebuilding |
| `local/project-paths.json` | Local bindings [[storage-3](#storage-3)] | Ignored |
| `prefs.json` | Core preferences and viewed markers [[storage-5](#storage-5)] | Ignored |
| `meta.json`, `local/migrations/` | Migration receipts and retained inputs [[storage-9](#storage-9)] | Ignored |
| `forge-cache.json` | Rebuildable forge cache | Ignored |
| `sessions/<id>.hints.json`, leases, retired guards, staging and atomic-write temporary files | Local continuity and coordination [[1]] | Ignored |

### storage-2

The registry shall encode `projects.json` as exactly `{v:2,projects:[{id,name,registeredAt}]}`, where IDs are unique canonical lowercase UUIDs, names are nonempty strings, and registration times are finite nonnegative integer Unix milliseconds.

### storage-3

The binding store shall encode `local/project-paths.json` as exactly `{v:1,bindings:[{id,path,aliases}]}`, where each registered project ID has at most one binding, `path` is its normalized absolute local repository path, and `aliases` is a unique array of normalized absolute recorded working directories:

- current paths and aliases resolve to at most one ID; ambiguity is reported, never resolved by array order;
- a missing registry ID is reported as an orphan, without deleting the binding or restoring a registration;
- recorded paths are assumed to identify the same project across devices; aliases establish presentation identity, never permission to relocate recovery evidence.

### storage-4

The intent store shall encode each newline-terminated act as a closed JSON object with `v:1` and exactly the fields of its case, folding acts in file order according to the intent lifecycle [[core-service-52](core-service.md#core-service-52)]:

| `act` | Other fields |
| --- | --- |
| `queue` | `intent`: the complete intent fields defined by the lifecycle, with UUID `id` and `projectId` matching the filename |
| `edit` | `id`, string `text` |
| `move` | `id`, string `rank` |
| `link` | `id`, UUID or null `afterId`; null clears the link |
| `dispatch` | `id`, UUID `sessionId`, positive integer `turnId`, timestamp `at` |
| `close` | `id`, `as: 'done' \| 'dropped'`, timestamp `at` |
| `remove` | `id`, timestamp `at` |

- IDs are canonical lowercase UUIDs; timestamps use the registry's millisecond encoding [[storage-2](#storage-2)]; malformed completed lines are reported without truncation, and an incomplete final line is not an act.
- `queue` creates an identity once; later acts address that identity, removed identities stay removed, and unknown targets or duplicate queues make the selected log invalid.

### storage-5

The preference store shall encode `prefs.json` as exactly `{v:1,prefs:{...}}`, with JSON-valued core preferences and `viewed:<sessionId>` nonnegative integer turn markers, resetting a session's viewed marker when its history is replaced.

### storage-6

When a project is registered or explicitly rebound, the core shall resolve its identity through the registry and local bindings [[storage-2](#storage-2)] [[storage-3](#storage-3)] and rescan session `cwd` values:

- an already bound path selects its existing identity;
- rebinding chooses an existing identity, optionally restoring its exact registry entry from a user-selected Git ancestor before assigning the local path;
- an unresolved or conflicting identity requires explicit selection; only registration of a new project mints an ID;
- an unresolved session stays on disk and is reported unlisted; a resolved session joins that project's history without a manifest rewrite.

### storage-7

Where a configured module locator is path-shaped, the config loader shall resolve it relative to the primary config file for loading, validation and artifact lookup, preserving bare package specifiers and applying the same resolution as the shared launcher [[2]].

### storage-8

When the Library publishes a managed playbook, it shall retain its sources under `playbooks/<id>/` and write its `playbooks.<id>.from` relative to the shared config, making generated files relocatable or rebuilding them locally before use:

- omitting generated files from Git requires enough retained source and configuration to regenerate them;
- a failed rebuild or unresolved explicit locator leaves the playbook unavailable with its cause, never substitutes a different module.

### storage-9

Before admitting writers to the unified layout, the migration shall complete under the root lease [[core-service-61](core-service.md#core-service-61)] with old writers stopped:

1. Preserve original bytes under ignored `local/migrations/<migrationId>/inputs/<n>`, with zero-based input indexes and `receipt.json` encoded as `{v:1,id,inputs:[{path,sha256}],complete}`: UUID `id` matches the directory, source paths are absolute, digests are lowercase SHA-256, and `complete` is boolean.
2. Split registry v1 into registry v2 and local bindings without changing IDs, and rewrite managed module locators only when the relative spelling resolves to the same module.
3. Use Playbook's lease-bound migration for session manifests and sidecars [[1]], retaining unsupported inputs ignored and preserving their readable history.
4. Validate every output before setting the receipt's `complete` to true; a restart verifies completed outputs or retries incomplete work without overwriting divergent destinations.

- an unknown version is preserved unchanged and reported; it is never guessed, downgraded or tracked as validated portable data;
- shared Git ancestry starts only after token-free session validation, never by retaining token-bearing migration inputs in earlier commits;
- config backups, local state and every ignored family in the catalog [[storage-1](#storage-1)] are excluded by the root's tracked `.gitignore` before tracking begins.
- tracked `.gitattributes` disables line-ending conversion for portable JSON/JSONL files, so Git preserves the bytes used by checkpoint digests.
- existing `meta.json` remains `{version:1,importedLegacy?:string[]}` for completed legacy database imports; new migrations use their own receipts.

### storage-10

When state is synchronized through Git, the workflow shall use shared ancestry with one branch per device/root, shared by desktop and CLI and merged to/from `main`, while all local writers are stopped and each session executes on at most one device at a time:

- reopening uses Playbook's shared preparation to remove excess permissions from verified user-owned session entries before strict validation [[1]]; a private `077` Git umask avoids exposure before reopening.

### storage-11

When Git selects stored state, the validator shall compare the pre-merge tips with their common ancestor by complete file bytes and existence, using the pair of manifest and stream as one session unit [[1]] and every other tracked structured file as its own unit:

| Comparison | Selection |
| --- | --- |
| Neither side changed, or tips agree | Agreed bytes or deletion |
| Exactly one side changed | That side's entire unit or deletion |
| Both changed differently | Explicit whole-unit ours or theirs, even after a clean text merge |

- absence means deletion; a missing member of a present session bundle is invalid, not a partial choice;
- no common ancestor or unresolved choice refuses selection;
- unselected history remains recoverable from Git, but its acts and registrations leave active state;
- ordinary hunk preferences, record concatenation and automatic intent-log unions do not satisfy this contract.

### storage-12

Before reopening selected state, the validator shall validate the complete selected tree without changing file contents, after permission preparation [[storage-10](#storage-10)]:

- file versions, closed encodings and session checkpoint/digest relationships are valid [[storage-2](#storage-2)] [[storage-3](#storage-3)] [[storage-4](#storage-4)] [[storage-5](#storage-5)] [[1]];
- open intent source identities and ranks are unique within a project, after-links name existing intents and form no cycle, and extant dispatch targets belong to the same project with valid turn boundaries;
- deleted session targets retain the existing ledger re-derivation behavior [[core-service-70](core-service.md#core-service-70)]; a missing session alone is not permission to discard a verdict or repeat work;
- missing registry IDs and unresolved `cwd` values produce an orphan report and remain unlisted, without blocking unrelated valid projects or automatically restoring registrations;
- incompatible modules or unsupported checkpoint relocation permit history only; invalid structured state refuses writer admission with the failing file and reason.

### storage-13

When continuing after a Git selection, the host shall require Playbook's repository/effect reconciliation [[1]] before any external action, preserving unresolved evidence because choosing or deleting stored history cannot undo executed work.

### storage-14

The core shall remain the sole writer of Spex-owned files through atomic same-directory replacement or intent-log append under the root lease [[core-service-61](core-service.md#core-service-61)], while session mutations use Playbook's per-session lease and shared store [[1]].

## Verification

### storage-15

When an integration suite migrates a stopped legacy root and opens it through desktop and CLI hosts, it shall verify the root/override layout [[storage-1](#storage-1)], unchanged project identities [[storage-2](#storage-2)], local alias resolution [[storage-3](#storage-3)], exact act folds [[storage-4](#storage-4)], core preferences and viewed markers [[storage-5](#storage-5)], late binding and identity restoration [[storage-6](#storage-6)], shared locator resolution [[storage-7](#storage-7)], source-backed library rebuilding [[storage-8](#storage-8)], and restart-safe migration with token-free Git ancestry [[storage-9](#storage-9)].

### storage-16

When an integration suite merges two real Git branches containing sessions, projects and intent logs, it shall verify the stopped-writer workflow and reopening after a real Git checkout with umask `022` [[storage-10](#storage-10)], every whole-unit selection case including clean text merges and deletion [[storage-11](#storage-11)], orphan reporting and rejection of duplicate sources/ranks, cycles, invalid dispatches and damaged bundles [[storage-12](#storage-12)], no replay of omitted effects [[storage-13](#storage-13)], and lease exclusion of competing mutations [[storage-14](#storage-14)].

## References

[1]: https://github.com/sublang-ai/playbook/blob/main/specs/packages/session-storage.md "Shared Playbook session storage"
[2]: https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md "Shared launcher configuration"
