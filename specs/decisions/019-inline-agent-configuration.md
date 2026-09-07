<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-019: Inline Agent Configuration

## Status

Accepted; the seeded lineup is amended by [DR-025](025-playbook-7-adoption.md) — single-role CODE plus the review and decide blocks.

Amended by [DR-052](052-runtime-model-options.md): model and tuning choices come from runtime discovery.

## Context

- Playbook 3.0 removed the shared config's `profiles` map and the agent-block `profile` key: every `captain` and `players.<role>` value is an inline agent block (`adapter`, `model`, `effort`, `permissions`) or a scalar adapter shorthand, and the launcher migrates profiles-era configs in place once, with a backup.
  Playbook 3.1 and slc 0.2 are otherwise contract-stable for this host; slc's emitted entry and the registry wrapper of [DR-014](014-released-toolchain.md) carry over unchanged.
- The launcher now hands the Captain shell its own adapter (`captainOptions.captainAdapter`); the shell restricts control-call tools at the provider level only for adapters that enforce them, falling back to prompt-level restriction otherwise.
  Spex composes captain options itself, so it must supply the same field or Codex captains keep failing every turn.
- Effort vocabularies are adapter-scoped in the embedded runtime (Claude adds `ultracode`, Codex adds `ultra`, Kimi accepts only `off`/`on`); a single flat effort list both rejects valid configs and accepts ones that fail mid-turn.
- The runtime starts sessions only for its known adapter set (claude, codex, gemini, kimi, opencode); ids outside it fail at session start regardless of acceptance at load.
- The owner retires the shorthand concept from the product: seeded first-use defaults make it unnecessary, and per-playbook, per-run tuning is the norm.

## Decision

### Config model

- Spex validation accepts what the launcher accepts: inline agent blocks and scalar shorthands, with scalars normalizing to bare-adapter blocks during composition.
- Adapter ids are bounded by the embedded runtime's known set; an id outside it is rejected at composition with the runtime's own wording, since its session would fail to start.
- Effort validation is adapter-scoped, sourced from the embedded runtime's vocabulary; the protocol carries effort as plain text and composition is the gate.
- Composition emits the Captain's adapter alongside the playbook enablement in the captain options, matching the launcher.
- A profiles-era config migrates in place at load, matching the launcher's semantics: scalar profile references inline the named profile; a block's `profile` inlines with the block's own fields winning; a `profile` naming a missing entry is a hard error leaving the file untouched; an unmatched scalar stays as written; the `profiles` map is deleted after inlining; the pre-migration file is backed up beside the config; comments survive; migration runs once and no-ops when the launcher migrated first.
  Config edits never accept retired keys.

### Spex writes only blocks

- The seeded template is fully explicit inline blocks — no scalars — and keeps this host's recorded single-vendor seed: a Claude captain, coder, reviewer, host, and participant, with a commented second-vendor example.
  This deliberately diverges from the upstream starter's Codex reviewer (Spex has no launch gate to catch a cold second-vendor sign-in) and from its commented-out discuss (per [DR-015](015-reference-content.md)).
- Every config edit writes inline blocks.
  Captain and per-role player edits are merge patches over the existing block — only the provided keys change, so hand-written fields (`instruction`, granular permissions) survive.
  A patch key set to null unsets it, so a pinned model or effort can return to its adapter's default and a cleared field means what it shows.
  Registration flows (playbook add, compile) carry full blocks whose schema includes the optional hand-written fields.

### Protocol

- The profile surface leaves the protocol: no profile summaries, no profile edit operations.
  An agent summary (adapter, model, effort, permissions) describes the captain and each player; ops take agent blocks.
- Readiness is keyed by adapter, deduplicated, each entry naming the positions using it (captain, `<playbook>.<role>`); a supported adapter without a preflight rule reports unknown readiness with verify-yourself guidance.
- The version bumps; core and UI move together.

### UX

- One shared agent editor (adapter with readiness dot, model, adapter-scoped effort, permission mode and writable paths) and one agent chip (adapter · model @ effort, readiness dot) everywhere an agent is shown or edited.
- Settings replaces the profile section with the Captain's editor and a per-adapter readiness panel; player editing lives with the playbooks: role rows in the Library open the editor in place, per [DR-009](009-at-hand-interaction.md).
- The Captain-home popover carries the full editor, keeping the at-hand switch of [DR-007](007-conversational-session-start.md) and [DR-009](009-at-hand-interaction.md).
- First-use defaults: seeding covers every shipped role; a new role assignment defaults to a fixed neutral Claude block, with an explicit "same as Captain" action copying adapter, model, effort, and permissions only.
- The shorthand concept does not appear in the product: no shorthand options, no shorthand labels; a scalar read from a hand-edited config displays as its adapter's defaults and becomes a block on the next edit.

### Sources and toolchain

- The vendored built-in sources retire: playbook 3.1 ships `code.md` and `discuss.md`, and artifact resolution finds them in the installed package.
- Compiles invoke slc without an explicit link target (the canonical bare form); a compiled entry with no derived roles is refused with recompile guidance naming slc 0.2's fix.

## Consequences

- The launcher-parity boundary stays honest in both directions: everything the launcher accepts composes, and everything spex composes can actually start a session.
- Codex captains work through the prompt-level restriction; the composed captain options are the carrier, and a test pins it.
- Existing user configs keep composing through the load-time migration; the launcher and Spex can migrate interchangeably, whichever runs first.
- The single-vendor seed remains a first-hour protection; second-vendor setups keep working through the editor and readiness guidance.
- The settings, core-service, playbook-library, run-view, and app-shell package items and the affected decision records are amended; the settings editor's coverage intent (comment preservation, fail-closed edits) is re-established over the new operations.
