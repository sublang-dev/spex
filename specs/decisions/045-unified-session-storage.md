<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-045: One Durable Session Across Desktop and CLI

## Status

Accepted (2026-09-05).
Amends:

- [DR-036](036-file-state-store.md): storage ownership, default locations, local data and Git synchronization.
- [DR-037](037-playbook-12-adoption.md): host integration and effect-ledger durability.
- [DR-042](042-sessions-continue.md): recovery authority, cross-interface continuation, local provider hints, and deletion.

## Context

- Desktop and CLI shared replay but used separate recovery lifecycles; only CLI persisted recovery evidence before external effects.
- History lacked graph definitions and complete CLI player metadata; provider conversations remained external.
- Goal: shared management and portable storage with minimal mechanisms and explicit assumptions.
- The [storage catalog](../../docs/storage.md) describes the shared layout and links its owning definitions.

## Decision

### Ownership and format

- **Spex home** is the application data directory, defaulting to `~/.spex` or the value of `SPEX_HOME`. Explicit configuration and session-store paths replace their respective defaults.
- Spex owns application data; Playbook owns session formats, validation, migration, continuation and deletion for desktop and CLI.
- One core serves each Spex home; one writer owns each session. Writes, migration and deletion require the corresponding lease.

| Portable session file | Contents |
| --- | --- |
| `<id>.json` (manifest) | Identity, `cwd`, versioned checkpoint, recovery journal, uncertain work, effect ledger and replay boundary/completeness |
| `<id>.records.jsonl` (replay stream) | Ordered presentation records, visibility, roles and execution context in the v1 envelope |

- The manifest and matching replay stream form one **session bundle**.
- Persist recovery evidence before external effects; reconcile interruptions independently of transcript completeness.
- Bind each checkpoint to an exact durable replay prefix by sequence and digest; recording failures preserve uncertainty.
- Retain recovery journals, snapshots and effect evidence independently of replay; defer ledger compaction.
- Derive summaries, usage and graph activity from records; determine liveness from leases and runtime.
- History remains readable and deletable without executable modules or supported checkpoints; older writers preserve unknown versions unchanged.
- At migration, stop old writers, convert sidecars to manifests once, retain originals and retire sidecar writers. Both interfaces default to Spex home's `sessions/`.
- CLI schemas 2–5 and incompatible desktop checkpoints remain history only.

### Portability

- Before Git tracking, Playbook converts supported CLI manifests and desktop sidecars to validated bundles without provider tokens in recovery fields. Legacy tokens cannot prove checkpoint continuity and are not reused as hints; originals remain ignored. Git history starts after migration.
- Track project IDs, names and registration times in `projects.json`. Ignored `local/project-paths.json` maps each ID to its current local path and recorded working directories (aliases).
- Both interfaces record `cwd`; CLI needs no registry access. Spex resolves it through local bindings and rescans after registration or rebinding. Aliases associate history with projects but do not authorize execution at changed paths.
- Assume each recorded `cwd` identifies one project across devices; unresolved or conflicting bindings require explicit selection. Rebinding preserves the ID, restores its registry entry from Git ancestry if absent, and assigns the local path.
- Migrate and write managed `playbooks.<id>.from` paths relative to the primary configuration directory. Both interfaces share resolution for loading, validation and artifact lookup. Preserve package specifiers; validate other explicit paths on the destination.
- Only Playbook-defined relocation may change checkpoint paths; never substitute paths inside opaque snapshots or effect receipts. Unsupported relocation permits history only.
- Retain library sources; generated files must be relocatable or rebuilt locally before use.
- Browser layout preferences stay in browser storage. Core viewed markers stay in ignored `prefs.json` and reset when history is replaced.

### Replay compatibility

- The frozen v1 envelope contains an opaque JSON `record`; `type` and `timestamp` are optional.
- Count valid unknown kinds and headerless legacy records in sequence and digest checks; skip unsupported presentation without reporting damage.
- New execution-context records require a string `type` and finite numeric `timestamp`; unsupported context required for recovery permits history only.
- Both interfaces adopt shared framing and compatible readers before writers emit new kinds.

### Presentation and provider continuity

- Store immutable Captain/player identities, roster, settings, bindings and graph definitions as replay context records. Checkpoints and events reference them so history renders without installed playbook modules.
- Provider tokens are disposable local hints bound to participant and exact checkpoint. Delete and sync each hint before use. Deferred operations retain player/operation identity and receipts without provider tokens.
- Missing hints start fresh conversations. Definite rejection before execution invalidates the hint and permits one fresh attempt within the same logical call.
- Cligent classifies rejection; Playbook supplies the Captain's recovery journal or the player's complete task prompt, preserves effect authority and records the reset.
- Ambiguous execution failures never retry automatically; provider-only knowledge is unrecoverable.
- Repositories, provider credentials and provider histories remain external.

### Git synchronization

- Use Git with shared ancestry: one branch per device's Spex home, merged to or from `main`; desktop and CLI share the directory and branch.
- Stop local writers during commit, checkout and merge; preserve exact file bytes. Reopening tightens session permissions before strict validation and rejects unsafe paths. Execute each session on one device at a time; leases are local.
- Ignore `local/`, `prefs.json`, provider hints, lease directories, caches and migration inputs/receipts. Files stored outside the Git repository do not participate.
- Compare complete session bundles at both pre-merge revisions with their common ancestor; absence means deletion:

| Changes | Selection |
| --- | --- |
| Neither changed, or both agree | Agreed session or deletion |
| One side changed | That session or deletion |
| Both changed differently | Explicit whole-session choice, even after a clean text merge |

- Select both bundle files from the same revision or delete both. Git's per-file merges and hunk preferences do not enforce this relationship.
- Apply the same rule per structured file, including intent logs. Unselected changes leave active state but remain recoverable from Git ancestry.
- Before reopening, report unresolved session working directories and project IDs absent from the registry. Retain their files unlisted without automatic registration.
- Validate intent source uniqueness, queue order and acyclic links against selected histories. Preserve uncertainty and reconcile omitted executed work before continuation; Git cannot undo external effects.

### Deletion

- Under the session lease, delete replay, local hints, active legacy sidecar and derived state, then the manifest last. Interrupted cleanup is retryable; incomplete bundles cannot continue.
- Active or unprovable ownership blocks deletion. Retain retired lease directories against delayed reclaimers.
- Git records deletions; delete-versus-modify requires whole-session selection. No application tombstones or conflict copies.

### Contract ownership

- Spex defines home files, project bindings and Git selection [[storage-1](../packages/storage.md#storage-1)] [[storage-6](../packages/storage.md#storage-6)] [[storage-11](../packages/storage.md#storage-11)].
- Playbook defines schema-7 manifests, context, byte digests, hints and migration [[1]]; schema 7 does not relocate checkpoint paths.
- Cligent defines definite pre-execution resume rejection [[2]].
- The catalog links the owning definitions; each project owns implementation and integration evidence.

## Consequences

- Shared recovery replaces sidecar authority, separate restoration code and the in-memory substitute ledger.
- History is portable; exact resumption needs compatible runtimes, with fresh provider conversations as fallback.
- Different repository or module paths permit history only under schema 7, even with fresh conversations. Cross-device continuation at changed paths requires a versioned Playbook relocation contract.
- Align the three projects' contracts before rollout; Git supplies ancestry and recovery history without a separate synchronization engine.
- Current requirements belong in spec packages; the inventory remains descriptive.

## References

[1]: https://github.com/sublang-ai/playbook/blob/main/specs/packages/session-storage.md "Shared durable session contract"
[2]: https://github.com/sublang-ai/cligent/blob/main/specs/packages/engine.md#engine-84 "Definite provider session rejection"
