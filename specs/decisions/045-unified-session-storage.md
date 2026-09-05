<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-045: One Durable Session Across Desktop and CLI

## Status

Proposed (2026-09-04); would amend:

- [DR-036](036-file-state-store.md): storage ownership, default locations, local data and Git synchronization.
- [DR-037](037-playbook-12-adoption.md): host integration and effect-ledger durability.
- [DR-042](042-sessions-continue.md): recovery authority, cross-interface continuation, local provider hints, and deletion.

## Context

- Desktop and CLI share replay but have separate lifecycles; only CLI has durable write-ahead effect recovery.
- Historical graphs and complete CLI player metadata are missing; provider conversations live outside Spex.
- Goal: shared management and portable storage with minimal mechanisms and explicit assumptions.
- The [storage inventory](../../docs/design/unified-storage.md) describes current files and encodings.

## Decision

### Ownership and format

- Spex owns home and application data; Playbook owns session schemas, validation, migration, continuation and deletion for both interfaces.
- Spex-owned durable data defaults to `${SPEX_HOME:-~/.spex}`, including `sessions/`; explicit config/store overrides prevail.
- One core per root, one writer per session; all mutations, including migration and deletion, require the applicable lease.

| Portable session file | Authority |
| --- | --- |
| `<id>.json` | Identity, project locator, versioned checkpoint, recovery journal, uncertain work, effect ledger, and replay cursor/completeness |
| `<id>.records.jsonl` | Ordered presentation history, visibility, roles and context in the v1 envelope |

- Persist recovery authority before external effects; reconcile interruptions independently of transcript completeness.
- Bind checkpoints to durable replay prefixes by sequence and digest; recording failures preserve uncertainty.
- Keep recovery journals, snapshots and effect evidence independently of replay; defer ledger compaction.
- Derive summaries, usage and graph activity; read liveness from leases/runtime.
- History remains readable and deletable without executable modules or supported checkpoints; older writers preserve unknown versions unchanged.
- At cutover, stop old writers, convert sidecars to manifests once while retaining sources, retire sidecar writers and default both interfaces to the root's `sessions/`.
- CLI schemas 2–5 and incompatible desktop checkpoints remain history only.

### Portability

- Before Git tracking, Playbook extracts local hints from all recovery bindings and migrates supported CLI manifests/sidecars to validated token-free bundles. Original/unsupported inputs stay untracked and ignored; shared Git ancestry starts after migration.
- Track project identities (`id`, `name`, `registeredAt`) in `projects.json`; map IDs to absolute paths in ignored `local/project-paths.json`. Manifests use project IDs; rebinding preserves IDs, and unbound projects permit history only.
- Migrate and write managed `playbooks.<id>.from` as config-relative paths; both hosts share resolution for loading, validation and artifact lookup. Preserve bare package specifiers; validate remaining explicit paths on the destination.
- Only Playbook-defined relocation may adapt checkpoint project/module locators; never substitute paths in opaque snapshots or effect receipts. Unsupported relocation permits history only.
- Retain library sources; generated files must be relocatable or rebuilt locally before use.
- Move browser-local preferences into ignored `prefs.json`; viewed markers remain device-local and reset when history is replaced.

### Replay compatibility

- The frozen v1 `record` is an opaque JSON object; `type` and `timestamp` are optional.
- Preserve valid unknown records, including headerless legacy records, in sequence/digest accounting; skip unsupported presentation without marking damage.
- New execution-context kinds require a string `type` and finite numeric `timestamp`; unknown required recovery context permits history only.
- Both hosts adopt shared framing and compatible readers before writers emit new kinds.

### Presentation and provider continuity

- Store immutable Captain/player identities, roster, settings, bindings and graph definitions as replay context records; checkpoints and events reference them so history renders without installed playbook modules.
- Provider tokens are disposable local hints bound to participant and exact checkpoint. Exclude them from portable state, including deferred-effect bindings; retain logical operation identities and receipts.
- Missing hints start fresh conversations. Definite pre-execution session rejection invalidates the hint and permits one fresh attempt within the same logical call.
- Cligent classifies rejection; Playbook supplies Captain's recovery journal or the player's complete task prompt, preserves effect authority and records the reset.
- Ambiguous execution failures never auto-retry; provider-only knowledge is unrecoverable.
- Repositories, provider credentials and provider histories remain external.

### Git synchronization

- Sync only through Git with shared ancestry: one branch per device/root, merged to/from `main`; desktop and CLI share both.
- Stop all local writers during commit, checkout and merge. Execute each session on one device at a time; leases are local.
- Keep `local/`, `prefs.json`, provider hints, leases/retired guards, caches and migration inputs/receipts untracked and ignored; overrides outside the Git root do not participate.
- Compare whole session bundles from pre-merge tips against their Git common ancestor, treating absence as deletion:

| Session changes | Result |
| --- | --- |
| Neither changed, or tips agree | Keep the agreed bundle or deletion. |
| One side changed | Take its bundle or deletion. |
| Both changed differently | Choose whole-session ours or theirs, even after a clean text merge. |

- Manifest and stream are indivisible; Git hunk preferences do not enforce this.
- Apply the same rule to other structured files, including `intents/<projectId>.jsonl`. Divergence requires an explicit whole-file choice; unselected acts leave active state but remain recoverable through Git ancestry.
- Validate the store before reopening, including intent source uniqueness, queue order and acyclic links against selected session histories. Selection preserves uncertainty and cannot undo external effects; reconcile omitted executed work before continuation.

### Deletion

- Under the shared lease, delete replay, local hints, active legacy sidecar and derived state, then the manifest last. Retry interrupted cleanup; incomplete bundles cannot resume.
- Refuse active or unprovable ownership; retain retired lease directories against delayed reclaimers.
- Git tracks deletions; delete-versus-modify uses whole-session selection. No application tombstones or conflict copies.

### Contracts required before cutover

Define each encoding once in its owning spec package, enforced by shared validators:

| Owner | Required definition |
| --- | --- |
| Playbook | Manifest/context versions and fields; token extraction, migration and token-free validation; record headers/unknown-kind rules; context references, digest encoding, hints and supported locator relocation. |
| Spex | Git selection/store validation; project identities/local bindings; config-relative module resolution; local UI preferences and migration receipts; library rebuilding before omitting generated outputs. |

## Consequences

- Shared recovery replaces sidecar authority, separate restoration and the in-memory substitute ledger.
- History is portable; exact resumption requires compatible runtimes, with fresh provider conversations as fallback.
- Align Spex, Playbook and Cligent contracts before rollout; Git supplies ancestry and recovery history without a separate sync engine.
- Record accepted requirements in their owning spec packages; keep the inventory descriptive.
