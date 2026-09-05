<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-045: One Durable Session Across Desktop and CLI

## Status

Proposed (2026-09-04); would amend:

- [DR-036](036-file-state-store.md): session file ownership, default location, and Git synchronization.
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
- One core per state root and one writer per session; mutations require the applicable lease, including migration and deletion.

| Portable session file | Authority |
| --- | --- |
| `<id>.json` | Identity, project locator, versioned checkpoint, recovery journal, uncertain work, effect ledger, and replay cursor/completeness |
| `<id>.records.jsonl` | Ordered presentation history in the existing v1 envelope, including visibility, roles, and context |

- Persist recovery authority before external effects; interrupted work requires reconciliation, never inference from missing transcript output.
- Checkpoints identify a durably recorded replay prefix by sequence and digest; recording failure preserves uncertainty rather than inventing history.
- Preserve the recovery journal independently of replay; derive summaries, usage and graph activity, and observe liveness from the lease/runtime.
- Retain Playbook's recovery snapshots and effect evidence; ledger compaction is deferred and must preserve recovery without presentation history.
- History remains readable and deletable without executable modules or a supported checkpoint; older writers preserve unknown versions without rewriting them.
- Cutover stops old writers, converts desktop sidecars once into common manifests while retaining migration sources, retires the sidecar writer, and moves both defaults to `${SPEX_HOME:-~/.spex}/sessions`; explicit overrides stand.
- CLI schemas 2–5 and incompatible desktop checkpoints remain history only, without inventing missing recovery authority.

### Replay compatibility

- The frozen v1 envelope accepts an opaque JSON object as `record`; neither `type` nor `timestamp` is universally required.
- Readers preserve structurally valid unknown records, including legacy records without timestamps, count their sequences and digest contribution, and skip unsupported presentation; unfamiliar content alone is not corruption.
- Every new execution-context kind defines a string `type` and finite numeric `timestamp`; unknown required recovery context prevents continuation without damaging history.
- Both hosts adopt shared framing and compatible readers before new writers emit additional record kinds.

### Presentation and provider continuity

- Persist immutable Captain/player identities, roster, settings, bindings and graph definitions as execution-context records in the replay stream; checkpoints and events identify their context, so historical rendering needs no installed playbook module.
- Provider tokens are disposable local hints bound to the participant and exact checkpoint; omit them from portable state, including deferred-effect bindings, while preserving logical operation identities and receipts.
- Missing hints start fresh conversations; definite pre-execution session rejection permits one fresh attempt inside the same logical call, invalidating the rejected hint.
- Cligent classifies rejection; Playbook supplies Captain's recovery journal or the player's complete task prompt, preserves effect authority, and records the continuity reset.
- Ambiguous execution failures receive no automatic retry; provider-only knowledge is not recoverable.
- Repositories, provider credentials and provider histories remain external.

### Git synchronization

- Git is the only synchronization path: one repository with shared ancestry, one branch per device/root, merged to and from `main`; desktop and CLI share that root and branch.
- Stop all local writers throughout commit, checkout and merge; only one device executes a given session at a time, since leases do not coordinate devices.
- Keep provider hints, leases and retired guards, caches, migration receipts and destination path bindings untracked and ignored; overrides outside the Git root do not participate.
- Resolve session changes relative to Git's common ancestor as whole bundles from the pre-merge branch tips, including absence:

| Session changes | Result |
| --- | --- |
| Neither side changed, or both tips agree | Keep the agreed bundle or deletion. |
| One side changed | Take that side's complete bundle or deletion. |
| Both sides changed differently | Choose whole-session ours or theirs, even when Git reports a clean text merge. |

- Never independently merge a session's manifest and stream; hunk preferences such as `-X ours` are not whole-session selection.
- Other structured files use the same three-way rule per file, including whole-file choice despite a clean text merge; retain merge ancestry so discarded versions remain recoverable in Git.
- Validate the selected store before reopening; bundle selection neither clears uncertainty nor undoes external effects, and omitted executed work requires reconciliation before continuation.

### Deletion

- Under the shared lease, remove the replay stream, local hints, any active legacy sidecar and derived session state, then the manifest last; interrupted cleanup is safe to retry and cannot authorize continuation from an incomplete bundle.
- Active or unprovable ownership refuses deletion; retired lease directories remain as guards against delayed reclaimers.
- Git records deletion as tracked file removal; delete-versus-modify follows whole-session selection, without application tombstones or conflict copies.

### Contracts required before cutover

Each encoding has one authoritative definition in its owning spec package, enforced by shared validators.
The remaining definitions are:

| Owner | Required definition |
| --- | --- |
| Playbook | Manifest/context versions and fields; record headers and unknown-kind rules; context references, digest encoding and local hint format. |
| Spex | Whole-session Git selection and store validation; ignored local data and destination bindings; portable UI preferences; local migration receipts; library source preservation and rebuilding before generated outputs are omitted. |

## Consequences

- Shared recovery replaces desktop's sidecar authority, separate restoration and in-memory substitute ledger.
- History is portable; exact workflow resumption remains runtime-compatible, with fresh provider conversations as a fallback.
- Coordinated Spex, Playbook and Cligent contracts precede rollout; Git supplies ancestry and recovery history, with no separate synchronization engine.
- Accepted storage requirements belong in their owners' spec packages; the inventory remains descriptive.
