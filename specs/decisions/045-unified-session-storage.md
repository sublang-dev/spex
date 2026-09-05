<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-045: One Durable Session Across Desktop and CLI

## Status

Proposed (2026-09-04); would amend:

- [DR-036](036-file-state-store.md): session file ownership, default location, and portable backup rules.
- [DR-037](037-playbook-12-adoption.md): host integration and effect-ledger durability.
- [DR-042](042-sessions-continue.md): recovery authority, cross-interface continuation, local provider hints, and deletion.

## Context

- Desktop and CLI share a replay format but use separate session lifecycles; only CLI has durable write-ahead effect recovery.
- Historical graph definitions and complete CLI player metadata are missing; provider conversations live outside Spex.
- The owner wants shared management, portable storage, and minimal mechanisms under explicit assumptions.
- The [current storage inventory](../../docs/design/unified-storage.md) describes existing files and encodings.

## Decision

### Ownership and format

- Spex owns home and application-data contracts; Playbook owns shared session schemas, validation, migration and lifecycle, including continuation and deletion regardless of the creating interface.
- All Spex-owned durable data defaults to `${SPEX_HOME:-~/.spex}`, including `sessions/`; explicit config/store overrides remain authoritative.
- One core per state root and one writer per session; mutations require the applicable lease, including import and deletion.
- Cross-machine transfer uses quiescent exports; concurrent multi-machine writing is unsupported.

| Portable session file | Authority |
| --- | --- |
| `<id>.json` | Identity, project locator, versioned checkpoint, recovery journal, uncertain work, effect ledger, and replay cursor/completeness |
| `<id>.records.jsonl` | Ordered presentation history in the existing v1 envelope, including visibility, roles, and context |

- Persist recovery authority before external effects; interrupted work requires reconciliation, never inference from missing transcript output.
- Checkpoints identify a durably recorded replay prefix by sequence and digest; recording failure preserves uncertainty rather than inventing history.
- Preserve the recovery journal independently of replay; derive summaries, usage and graph activity, and observe liveness from the lease/runtime.
- Retain Playbook's recovery snapshots and effect evidence; ledger compaction is deferred and must preserve recovery without presentation history.
- History remains readable, exportable and deletable without executable modules or a supported checkpoint; older writers preserve unknown versions without rewriting them.
- Cutover stops old writers, imports desktop sidecars once into common manifests, retires the sidecar writer, and moves both defaults to `${SPEX_HOME:-~/.spex}/sessions`; explicit overrides stand.
- Validate bundles before activation and retain sources; CLI schemas 2–5 and incompatible desktop checkpoints remain history only, without inventing missing recovery authority.

### Presentation and provider continuity

- Persist immutable Captain/player identities, roster, settings, bindings and graph definitions as execution-context records in the replay stream; checkpoints and events identify their context, so historical rendering needs no installed playbook module.
- Provider tokens are disposable local hints bound to the participant and exact checkpoint; omit them from portable state, including deferred-effect bindings, while preserving logical operation identities and receipts.
- Missing hints start fresh conversations; definite pre-execution session rejection permits one fresh attempt inside the same logical call, invalidating the rejected hint.
- Cligent classifies rejection; Playbook supplies Captain's recovery journal or the player's complete task prompt, preserves effect authority, and records the continuity reset.
- Ambiguous execution failures receive no automatic retry; provider-only knowledge is not recoverable.
- Repositories, provider credentials and provider histories remain external; leases, hints and caches are excluded from exports.

### Merge

Local shared storage needs no merge.
Offline import compares validated session bundles—manifest and stream together—never timestamps or independently selected files.

| Copies | Result |
| --- | --- |
| Different session IDs | Keep both. |
| Equivalent bundles | Deduplicate. |
| Same checkpoint/context, compatible replay prefix extension | Keep the longer validated prefix, preserving gap markers. |
| One bundle unchanged from a known common baseline; the other's history unchanged or extended | Take the changed whole bundle. |
| Divergent histories, conflicting checkpoints, or insufficient evidence | Preserve both as a conflict outside the active session namespace; no automatic resumption. |

- Divergence overrides baseline selection; a baseline is optional backup/import evidence, not permanent checkpoint ancestry.
- Never concatenate branches, renumber turns, merge effect ledgers, or authorize execution merely by selecting a bundle; conflicting effects require reconciliation.

| Other data | Rule |
| --- | --- |
| Projects and saved sources | Union distinct identities; deduplicate equals; select one-sided baseline changes; preserve conflicts. |
| Intent logs | Equal or strict-prefix merge only. |
| Config | Whole validated document; select one-sided baseline changes, otherwise resolve conflicts; preserve comments. |
| Preferences | Union distinct keys; select one-sided baseline changes; unresolved differences keep destination values. |
| Viewed markers | Furthest viewed turn on identical history only. |

### Deletion

Missing files do not imply deletion.
A session tombstone records its ID and deleted-bundle digest: suppress matching old copies, conflict with changed copies, and retain deletion evidence until its backup horizon is deliberately forgotten.

- Under the shared lease, deletion removes the manifest, replay stream, local provider hints, any active legacy sidecar, and derived session state; the tombstone, preserved backups and unresolved conflict copies remain.
- Publish deletion evidence before removing files; interrupted cleanup is recoverable, and normal lease refusal rules include active or unprovable ownership.
- Retired lease directories remain as guards against delayed reclaimers; removing them requires fencing all prior owners and contenders, which the current session lease does not establish.

### Contracts required before cutover

Each encoding has one authoritative definition in its owning spec package, enforced by shared validators.
The remaining definitions are:

| Owner | Required definition |
| --- | --- |
| Playbook | Manifest/context versions and fields, context references and digest encoding, and hint/tombstone/staging/conflict paths and encodings. |
| Spex | Destination project bindings; core-managed portable UI preferences; destination-local import receipts and backup retention; library source preservation and rebuilding before generated outputs are omitted. |

## Consequences

- Shared recovery replaces desktop's sidecar authority, separate restoration and in-memory substitute ledger.
- History is portable; exact workflow resumption remains runtime-compatible, with fresh provider conversations as a fallback.
- Coordinated Spex, Playbook and Cligent contracts precede rollout; no database, distributed merge engine, or permanent checkpoint history is added.
- Accepted storage requirements belong in their owners' spec packages; the inventory remains descriptive.
