<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-032: Session Players

## Status

Accepted; both floors since superseded by [DR-037](037-playbook-12-adoption.md).
Raises the [DR-025](025-playbook-7-adoption.md) floors to playbook 8 and cligent 0.22, amending [DR-023](023-runtime-compatibility-from-cligent.md).
Rewrites the per-role agent placement of [DR-019](019-inline-agent-configuration.md) — an agent block belongs to a player, and a role binds to one — and its null-unsets patch rule.
Replaces [DR-003](003-runtime-reuse.md)'s pane roster: panes are player lanes, not the launch-time union of enabled playbooks' roles.

Amended by [DR-052](052-runtime-model-options.md): role editors use runtime choices and expose fast-mode inheritance.

## Context

- Playbook 8 separates two things Spex has always conflated, and its own record says why: "player" named both a playbook-local work function and a host agent conversation, so session sharing depended on spelling, and a nested role's configured agent could be silently replaced by an ancestor's.
- The released model (playbook DR-032):
  - a **role** is a playbook-local slot — `coder`, `reviewer` — declared by a manifest's `requiredRoleIds`, and `Roles:` replaces `Players:` in authored source and emitted GEARS;
  - a **player** is an explicit session identity in one flat top-level `players` map, its adapter part of its identity, its remaining fields defaults;
  - `playbooks.<id>.roles` binds every required role to a player, as a scalar id or a block carrying `player` with optional `model` and `effort` overrides — adapter, permissions, and workspace belong to the player and are never role-overridable;
  - **equal player ids deliberately share one provider conversation**, across playbooks and nested runs, for the life of the session; distinct ids never share, even when their settings are identical.
- Spex today generates the identities v8 abolishes: composition mints `<playbookId>-<role>` per role, so `code-coder` and `review-coder` are two agents with two conversations that no configuration can unify.
  The pane roster is that generated list, so a coder's context ends when `/code` hands off to `/review` and the reader watches a second coder start cold.
- The break reaches further than the config. Every playbook a user compiled through the Library is a generated registry whose wrapper passes a `players` map v8 no longer accepts and proxies a `callPlayer` argument that is now a role id; v8 requires `artifactSchema: 2` and rejects schema 1 at construction.
- cligent 0.22 rewrote `DoneUsage` in the same window: the `inputTokens`/`outputTokens`/`totalCostUsd`/`tokenAvailability` fields Spex reads are gone, replaced by an optional `tokens` report with inclusive totals and an optional `cost` carrying a `source` — `provider-reported`, `account-estimate`, or `agent-estimate`.
  Spex reads the retired names off an untyped payload, so on this floor every real turn would record zero tokens silently.
- Playbook refuses to migrate a legacy config: it "cannot know whether the two old `coder` blocks were meant to share one conversation or remain isolated", so a surviving `playbooks.<id>.players` block rejects with `PLAYBOOK_LEGACY_PLAYERS` before any work.
  That is right for a CLI, which has nobody to ask.

## Decision

### The adoption's boundary

Six pieces, and omitting any one makes the app lie:
composition mirroring the launcher exactly; the registry contract and compile wrapper rebuilt for artifact schema 2; a pane per player; the machine card naming role and player; the usage rewrite; and the seeded template in the released shape.
Migrating a legacy config is deliberately not among them.

### Composition mirrors the launcher; Spex invents no dialect

Core's floors rise to `@sublang/playbook` ^8.0.0 and `@sublang/cligent` ^0.22.0.
Composition reproduces the launcher's rules — flat `players`, exact `roles` coverage of `requiredRoleIds`, the reserved `captain` id, the segmented id grammar carried unmangled through protocol, store keys, and DOM ids, and each manifest's `concurrentRoleSets` binding to pairwise-distinct players — and emits the shell's `sessionAgents` shape.
Generated `<playbook>-<role>` identities are removed with nothing in their place.

Spex drops its own "at least one visible role" rule: v8 makes a roleless playbook legal, contributing no player, and a config the launcher accepts must never be one Spex rejects ([DR-004](004-config-and-persistence.md) parity).
An empty roster is therefore a legal session, and the run view renders it with no player panes rather than treating it as broken.
The pairwise-distinct rule is enforced at composition, so it fails closed with the launcher's wording, and again in the binding editor, so a user is stopped before saving rather than at the next run.

### Tuning is three states, and the editor forks

A role binding's `model` and `effort` are tri-state: omitted inherits the player's default, `false` selects the provider's current default, and a string pins a value.
Composition carries that distinction end to end rather than flattening it to an optional string, because "inherit `dev.coder`'s model" and "this provider's default" are different instructions to the runtime.
[DR-019](019-inline-agent-configuration.md)'s rule that a null patch key unsets a pin is amended here: on a player it still means "return to the adapter's default"; on a binding it means "inherit the player", and selecting the provider default is a positive choice with its own control.

DR-019's one-shared-editor law survives as a law about grammar, not a single component: a **player editor** owns adapter, model, effort, instruction, and permissions, and a **binding editor** owns a player choice plus model and effort.
A control that would change adapter or permissions from inside a binding does not exist, because in the released model it cannot.

### A pane is a player, and every call says which role it served

The run view shows one pane per player the session's bindings reference, keyed and titled by the player id — a user-authored name, so it is prose under [DR-010](010-interface-craft.md) §2 rather than an internal id to be hidden.
That pane accumulates every call to that player across every playbook and nested run: the visible half of "equal ids share one conversation".

A shared lane must never read as one voice talking to itself, so **each call in a player's transcript names the role it served**.
The record stream alone cannot say this — cligent's player records carry only a player id — so the core resolves it: within one player lane, a `player.call.started` trace opens a call and its `player.call.finished` closes it, and the player records between them belong to that call's role.
The bracket is unambiguous by construction, because v8 rejects simultaneous calls resolving to one player rather than forking or serializing them.
Core stamps the resolved role onto the player record envelope as a first-class protocol field; where a trace carries no resolved player, no label is invented.
This is core's own correlation of two streams it already owns, not orchestration semantics ([DR-003](003-runtime-reuse.md)) and not a renderer heuristic — the suffix match that turned "coder" into "code-coder" is deleted, not ported.

### Settings owns players; the Playbooks surface owns bindings

Settings owns the player roster — identity and defaults — because that is the lane a user signs in and pays for.
The Playbooks surface owns each playbook's bindings, and may create a player in place rather than sending the user away ([DR-009](009-at-hand-interaction.md)); a minted id is proposed as `dev.<role>` and is editable before it is written, because the id is the sharing decision.
Wherever a player is bound by more than one playbook, both surfaces say so.

Player lifecycle is guarded, because each operation is a continuity decision:
renaming or deleting a bound player states what happens to the conversation and to the bindings that name it, and never silently orphans one;
changing a bound player's adapter is an identity change, not tuning, and takes effect in the next session rather than the live one;
an unreferenced roster entry stays listed, marked unused, and enters neither the host roster nor readiness.

### There is no migration path, and that is the decision

Spex does not migrate a v7 config and does not carry v7 sessions forward.
The owner's call, and the right one: this is a pre-1.0 app whose config is a handful of lines and whose local history is disposable, so the cost of a guided merge flow — a surface, a merge-precedence rule, an ordering contract against the profiles migrator, and a permanent branch through composition — buys less than reseeding buys.

A surviving `playbooks.<id>.players` block therefore fails closed exactly as the launcher fails, carrying its `PLAYBOOK_LEGACY_PLAYERS` text rather than a paraphrase, with the error in the Captain thread and a link to Settings ([[run-view-44](../packages/run-view.md#run-view-44)]).
The remedy is the released shape, which the seeded template already demonstrates.
Nothing in Spex reinterprets that file, because choosing player ids would choose which conversations merge — the reason playbook refused the same rewrite.

### Usage tells the truth the runtime told

The new `DoneUsage` is adopted as it is: token totals are inclusive, so cached reads are never re-added; an absent `tokens` report means unreported and renders as nothing, never as zero.
Cost returns, because 0.22 gives it provenance — but only labeled with it, and an `agent-estimate` is never presented as a bill.
Usage attributes to the player lane, so a shared player's rollup deliberately spans the playbooks that share it; roles do not get their own totals, because the spend was one conversation's.

**Considered and declined:**

- multiplexing one player's transcript into per-role panes: it redraws the very conflation v8 removed, and one reply would have to appear twice;
- any automatic legacy rewrite, including the "obvious" one where role names become player ids: both readings are guesses about which conversations merge, and playbook declined them for that reason;
- a guided migration flow that asks the user which conversations merge: buildable, and genuinely the one thing a GUI can offer over a CLI, but it prices a whole surface and a permanent composition branch against a config a user can retype in a minute;
- per-call role labels by arrival-order heuristic: exactly as fragile as the suffix match this decision deletes;
- a general player CRUD with merge and split semantics: Spex would be inventing continuity operations the runtime does not offer;
- keeping "at least one visible role" to avoid a zero-pane layout: it would make Spex refuse a file the launcher accepts.

## Consequences

- The core-service, run-view, settings, playbook-library, shared-config-roundtrip, and dashboard packages all gain items; those asserting per-role agent blocks, generated player ids, the retired usage fields, or the readiness position string are rewritten rather than reinterpreted, since [[meta-12](../meta.md#meta-12)] binds an id to its concern.
- Readiness positions stop being a parsed `<playbook>.<role>` string — the dot is now part of an id — and become structured: the captain, and each referenced player with the roles it serves.
- The registry contract marker bumps: a playbook compiled by an earlier Spex fails closed with recompilation guidance, and the compile form asks for roles, emitting `Roles:` source.
- `SessionInfo.players` becomes the bound player roster; stored v7 sessions are discarded with the store rather than reinterpreted, since their generated ids name lanes the new model has no place for.
- The seeded template ships the released shape with `dev.coder` and `dev.reviewer` shared across the three built-ins — the configuration that makes a coder's context survive a handoff.
