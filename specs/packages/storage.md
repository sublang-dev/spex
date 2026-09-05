<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# storage: Portable Spex State

## Intent

This package defines Spex's data files, project path mappings, migration and offline Git merge rules under [DR-045](../decisions/045-unified-session-storage.md).
**Spex home** is the application data directory; paths below are relative to it.
Playbook owns session files and recovery [[1]]; a **session bundle** consists of a manifest and its matching replay stream, selected from one revision or deleted as a unit during Git synchronization.
Intent **acts** record changes in file order; **closed** JSON objects permit only the declared fields.

## External Behavior

### storage-1

The store shall persist core-owned data in Spex home using these locations:

- Spex home defaults to `~/.spex`; a nonempty `SPEX_HOME` selects another directory.
- Explicit configuration and store paths replace their respective defaults.

| Path | Contents | Git |
| --- | --- | --- |
| `playbook/playbook.config.yaml` | Shared launcher configuration | Tracked |
| `projects.json` | Project identities [[storage-2](#storage-2)] | Tracked |
| `intents/<projectId>.jsonl` | Ordered intent changes [[storage-4](#storage-4)] | Tracked |
| `sessions/<id>.json`, `sessions/<id>.records.jsonl` | Playbook session bundle [[1]] | Tracked |
| `playbooks/<id>/` | Library sources and outputs [[storage-8](#storage-8)] | Track sources; omit outputs only if rebuildable |
| `local/project-paths.json` | Local bindings [[storage-3](#storage-3)] | Ignored |
| `prefs.json` | Core preferences and viewed markers [[storage-5](#storage-5)] | Ignored |
| `meta.json`, `local/migrations/` | Migration receipts and retained inputs [[storage-9](#storage-9)] | Ignored |
| `forge-cache.json` | Rebuildable forge cache | Ignored |
| `sessions/<id>.hints.json`, leases, retired guards, staging and atomic-write temporary files | Provider hints and writer coordination [[1]] | Ignored |

### storage-2

The registry shall encode `projects.json` as exactly `{v:2,projects:[{id,name,registeredAt}]}`, where IDs are unique canonical lowercase UUIDs, names are nonempty strings, and registration times are finite nonnegative integer Unix milliseconds.

### storage-3

The binding store shall encode `local/project-paths.json` as exactly `{v:1,bindings:[{id,path,aliases}]}`, with these binding constraints:

- each registered project ID has at most one binding;
- `path` is its normalized absolute local repository path;
- `aliases` is an array of unique normalized absolute working directories recorded in sessions;
- current paths and aliases resolve to at most one ID; ambiguity is reported, never resolved by array order;
- a binding to an absent registry ID is reported without deleting the binding or restoring the registration;
- recorded paths are assumed to identify the same project across devices; aliases associate history with a project but do not authorize checkpoint relocation.

### storage-4

The intent store shall encode each newline-terminated act as a closed JSON object with `v:1` and exactly the fields of its case, folding acts in file order under the intent lifecycle [[core-service-52](core-service.md#core-service-52)]:

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
- `queue` creates an identity once; later acts address that identity, removed identities stay removed, and acts targeting unknown IDs or duplicate `queue` acts make the selected log invalid.

### storage-5

The preference store shall encode `prefs.json` as exactly `{v:1,prefs:{...}}`, with these core preference values:

- each preference is a JSON value;
- `viewed:<sessionId>` stores the last viewed turn as a nonnegative integer and resets when that session's history is replaced.

### storage-6

When a project is registered or its local path mapping is explicitly set, the core shall resolve its identity through the registry and path mappings [[storage-2](#storage-2)] [[storage-3](#storage-3)] and rescan session `cwd` values:

- an already bound path selects its existing identity;
- rebinding selects an existing ID, optionally restoring its exact registry entry from a user-selected Git ancestor;
- an unresolved or conflicting ID requires explicit selection; only registering a new project creates an ID;
- an unmatched session stays on disk and is reported but not listed; a matched session joins the project's history without rewriting its manifest.

### storage-7

Where a configured module location is a file path, the config loader shall resolve it relative to the primary configuration directory for loading, validation and artifact lookup, leaving package names unchanged and using the shared launcher's resolution rules [[2]].

### storage-8

When the Library publishes a managed playbook, it shall retain its sources under `playbooks/<id>/` and write `playbooks.<id>.from` relative to the shared configuration directory, making generated files relocatable or rebuilding them locally before use:

- omitting generated files from Git requires enough retained source and configuration to regenerate them;
- a failed rebuild or unresolved module locator leaves the playbook unavailable with its cause; no module substitution.

### storage-9

Before admitting writers to the unified layout, migration shall complete under the Spex home lease [[core-service-61](core-service.md#core-service-61)] with old writers stopped:

1. Preserve original bytes under ignored `local/migrations/<migrationId>/inputs/<n>`, with zero-based input indexes and `receipt.json` encoded as `{v:1,id,inputs:[{path,sha256}],complete}`: UUID `id` matches the directory, source paths are absolute, digests are lowercase SHA-256, and `complete` is boolean.
2. Split registry v1 into registry v2 and local bindings without changing IDs, and rewrite managed module paths only when the relative path resolves to the same module.
3. Use Playbook's session migration with the session lease held [[1]]; retain unsupported manifests and sidecars ignored while preserving readable history.
4. Validate every output before setting the receipt's `complete` to true; a restart verifies completed outputs or retries incomplete work without overwriting divergent destinations.

- an unknown version is preserved unchanged and reported; it is never guessed, downgraded or tracked as validated portable data;
- Git history starts only after validation confirms session recovery fields contain no provider tokens; earlier commits must not contain token-bearing migration inputs;
- config backups, local state and every ignored family in the catalog [[storage-1](#storage-1)] are excluded by Spex home's tracked `.gitignore` before tracking begins.
- tracked `.gitattributes` disables line-ending conversion for portable JSON/JSONL files, so Git preserves the bytes used to verify saved recovery state.
- existing `meta.json` remains `{version:1,importedLegacy?:string[]}` for completed legacy database imports; new migrations use their own receipts.

### storage-10

When synchronizing stored data through Git, the workflow shall follow these rules:

- branches share Git ancestry, with one branch for each device's Spex home;
- desktop and CLI share that branch, merged to or from `main`;
- all local writers stop during commit, checkout and merge, and each session runs on at most one device at a time;
- reopening uses Playbook's shared preparation to remove excess permissions from verified user-owned session entries before strict validation [[1]]; `umask 077` keeps files created by Git private before reopening.

### storage-11

When selecting stored data during a Git merge, the validator shall compare both pre-merge revisions with their common ancestor:

- compare complete file bytes and existence;
- treat the manifest and matching replay stream as one session bundle [[1]], and each other tracked structured file as a separate unit.

| Comparison | Selection |
| --- | --- |
| Neither side changed, or both agree | Agreed bytes or deletion |
| Exactly one side changed | That side's entire unit or deletion |
| Both changed differently | Explicit choice of the entire unit from either branch, even after a clean text merge |

- absence means deletion; a present session bundle requires both files from the same selected revision, never a manifest from one branch and replay from another;
- no common ancestor or unresolved choice refuses selection;
- unselected history remains recoverable from Git, but its intent changes and project registrations leave current state;
- hunk-level preferences, record concatenation and automatic intent-log unions do not satisfy this contract.

### storage-12

Before reopening selected state, the validator shall validate the complete selected tree without modifying file contents, after permission preparation [[storage-10](#storage-10)]:

- file versions, closed encodings and checkpoint/digest relationships are valid [[storage-2](#storage-2)] [[storage-3](#storage-3)] [[storage-4](#storage-4)] [[storage-5](#storage-5)] [[1]];
- open artifact-source identities and ranks are unique within a project [[core-service-42](core-service.md#core-service-42)], `after` dependency links name existing intents and form no cycle, and dispatch targets still present belong to the same project with valid turn boundaries;
- deleted session targets retain the existing ledger re-derivation behavior [[core-service-70](core-service.md#core-service-70)]; a missing session alone is not permission to discard a verdict or repeat work;
- missing registry IDs and unresolved `cwd` values are reported and their records remain unlisted, without blocking unrelated valid projects or automatically restoring registrations;
- incompatible modules or unsupported checkpoint relocation permit history only; invalid structured data blocks writes and reports the failing file and reason.

### storage-13

When continuing after Git selection, the host shall require Playbook's repository/effect reconciliation [[1]] before any external action, preserving unresolved evidence because selecting or deleting history cannot undo executed work.

### storage-14

The core shall remain the sole writer of Spex-owned files, using atomic same-directory replacement or intent-log append under the Spex home lease [[core-service-61](core-service.md#core-service-61)], while session mutations use Playbook's per-session lease and shared store [[1]].

## Verification

### storage-15

When an integration suite migrates a legacy store with writers stopped and opens it through desktop and CLI, it shall verify:

- default and explicitly selected locations [[storage-1](#storage-1)];
- unchanged project IDs [[storage-2](#storage-2)];
- local alias resolution [[storage-3](#storage-3)];
- exact intent act folds [[storage-4](#storage-4)];
- core preferences and viewed markers [[storage-5](#storage-5)];
- session association after registration and restoration of existing project IDs [[storage-6](#storage-6)];
- shared module path resolution [[storage-7](#storage-7)];
- library rebuilding from retained sources [[storage-8](#storage-8)];
- restart-safe migration and token-free Git ancestry [[storage-9](#storage-9)].

### storage-16

When an integration suite merges two real Git branches containing sessions, projects and intent logs, it shall verify:

- stopped writers and reopening after a real Git checkout with umask `022` [[storage-10](#storage-10)];
- every whole-unit choice, including clean text merges and deletion [[storage-11](#storage-11)];
- reports of unmatched projects and sessions, and rejection of duplicate sources/ranks, cycles, invalid dispatches and damaged bundles [[storage-12](#storage-12)];
- no repetition of actions omitted from selected history [[storage-13](#storage-13)];
- leases blocking competing writes [[storage-14](#storage-14)].

## References

[1]: https://github.com/sublang-ai/playbook/blob/main/specs/packages/session-storage.md "Shared Playbook session storage"
[2]: https://github.com/sublang-ai/playbook/blob/main/specs/packages/playbook-cli.md "Shared launcher configuration"
