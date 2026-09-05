<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-003: Playbook Runtime Reuse and Run Interaction Model

## Status

Accepted; failed-disposal ownership is amended by [DR-048](048-failed-session-cleanup.md).

## Context

- [DR-002](002-desktop-app-architecture.md) fixes a web-first core that embeds the existing headless orchestration stack; this DR fixes how that embedding works and what the Boss can do during a run.
- `@sublang/cligent` (0.13.0) exports a headless runtime, `createTmuxPlayRuntime` from `@sublang/cligent/tmux-play`, with the lifecycle `addObserver` / `initialize` / `runBossTurn` / `abortActiveTurn` / `dispose` [[1]]; despite the name, it is UI-agnostic — the tmux host is just one consumer.
- Its `RecordObserver` stream already carries every UI-relevant event: turn lifecycle (`turn_started` / `turn_finished` / `turn_aborted`), player prompt/event/finished, captain prompt/event/finished/status/telemetry, `player_view_changed`, and `runtime_error`; player events wrap the full `CligentEvent` stream [[1]].
- Records carry a `visibility` field; `hidden` records (judge and router traffic) do reach observers — the playbook repo's DR-007 hides them from the Boss at the presentation layer, not at the source [[2]].
- `@sublang/playbook` exports `createPlaybookCaptainShell(options, deps?)` with type-only cligent coupling, an injectable `deps.loadModule`, a playbook registry, and a one-active-engagement-per-session rule [[2]].
- Product decisions (owner, 2026-07-10): player panes are read-only, the Boss has a single composer, and there is no direct player chat in v1.

## Decision

### Runtime embedding

- The core creates one headless runtime instance per project session, with `cwd` set to the project root.
- The captain is the Playbook Captain shell, composed from the shared config exactly as the playbook launcher composes it (see [DR-004](004-config-and-persistence.md)); Spex introduces no alternate composition path.
- The core injects `deps.loadModule` so bundled environments (Electron packaging) resolve compiled registry modules (see [DR-005](005-compilation-integration.md)) without relying on ambient module resolution.

### Record stream as the single source

- The `RecordObserver` stream is the single source for all panes; no pane renders state that did not arrive as a record.
- The core filters `visibility: 'hidden'` records out of every Boss-facing channel, preserving the hidden-judge principle of the playbook repo's DR-007 [[2]].
- Hidden records are retained on a separate opt-in debug channel and in persistence (see [DR-004](004-config-and-persistence.md)); filtering is a channel property, not data loss.
- The Captain pane renders the shell's stream as-is, including the upstream glyph vocabulary [[2]]; Spex assigns no new glyph semantics.

### Interaction model

- The single Boss composer is the only input surface of a session; submitting maps to `runBossTurn`.
- Player panes are strictly read-only streaming transcripts; v1 has no reply-in-pane and no direct player chat.
- `awaitBossReply` questions surface twice: in the Captain pane (where the shell emits them) and as a banner on the composer, so a blocked run cannot go unnoticed.
- Turn abort maps to `abortActiveTurn`.
- Boss turns are serialized per session; a new turn cannot start while one is active.

### Pane roster and visibility

- Pane show/hide follows `player_view_changed` records; the UI does not invent layout state.
- The pane roster is fixed at session start as the launch-time union of the enabled playbooks' roles.
- Enabling an additional playbook therefore requires a session restart in v1.

### Verification strategy

- cligent's `tmux-play` host is the behavioral twin: the same config and the same Boss inputs must produce the same record stream in both hosts.
- Spex adds no orchestration semantics of its own; any behavioral divergence between the hosts is a Spex rendering bug or an upstream change, never a Spex-side policy.

## Consequences

- No direct player chat in v1; the Boss steers players only through the captain. Reintroducing direct chat would be an upstream and protocol change, not a UI patch.
- The roster restart limitation is accepted for v1: enabling another playbook mid-work costs a session restart.
- The captain shell's single-engagement rule shapes the UX: switching playbooks means finishing or dismissing the active engagement, which the Captain itself can do on Boss request, so the UI needs no bypass affordance.
- The record contract bounds UI fidelity: any new pane need becomes an upstream record-type request, not a Spex-side hook into runtime internals.
- Hidden records exist in persistence and on the debug channel, so Boss-facing filtering must be enforced at the channel boundary in the core; the UI receives hidden records only when the debug channel is explicitly opened.
- Renaming `createTmuxPlayRuntime` upstream is future work; Spex imports it under the tmux-flavored name until then [[1]].

## References

[1]: https://github.com/sublang-ai/cligent "sublang-ai/cligent — CLI-agent runtime and adapters"
[2]: https://github.com/sublang-ai/playbook "sublang-ai/playbook — Playbook Captain shell and playbook specs"
