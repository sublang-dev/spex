<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-037: Playbook 12 Adoption

## Status

Accepted (2026-09-01); the floor moved to ^12.2.0 on 2026-09-02 in lockstep with slc 0.7.0, whose link contract has a linked runtime import `renderGovernedOutcomeContract` from the engine — an export playbook 12.2 introduces.
Playbook 12.1 and 12.2 publish `@sublang/playbook/host-capabilities`, but its repository object lacks two of the six members the Captain shell's exact-shape validator demands and its per-playbook ledgers diverge where the shell requires agreement, so the by-path builder below stands ([DR-038](038-history-is-done-work.md)).
Amends [DR-034](034-playbook-9-adoption.md) (the playbook floor moves to ^12.2.0), [DR-032](032-session-players.md) (the cligent floor moves to ^0.24.0), and [DR-036](036-file-state-store.md) (a captain-session record without a replay stream lists from its Boss journal).

## Context

- Playbook 10 through 12 change what an embedding host must do ([DR-003](003-runtime-reuse.md)): registry manifests advertise artifact schema 3; every host supplies live repository and effect-ledger capabilities for each enabled playbook, or no session starts; the shared config moves under the Spex root with a one-time relocation from the XDG location; both CLI presentations tee a token-free replay stream beside each session; a `dev` planning playbook joins the built-ins; the starter config names two vendors with fast mode; the cligent floor rises to ^0.24.
- The CLI's own capability builder — the git effect semantics behind exclusive and cohort runs, deferred continuation, and receipt classification — ships in the package but is not on its exports map, and the public session-store lease deliberately hides the private lease that builder takes.
  The shell validates supplied capabilities structurally, so a host may build them itself; it must then implement those semantics or reuse the shipped module.
- Spex's phase-one file state ([DR-036](036-file-state-store.md)) already reads the shared sessions directory with its own reader.
  The history on a working machine predates the replay stream: its captain-session records carry Boss journals and no stream, and the public session-store facade skips such records as pre-cutover — exactly the history worth listing.
- A Spex session never resumes after a restart ([DR-036](036-file-state-store.md)), so nothing would ever read a durable effect ledger back.

## Decision

### The floor

- `@sublang/playbook` ^12.2.0 and `@sublang/cligent` ^0.24.0: the compiler and the engine move together, since slc 0.7.0 links every compiled playbook against the installed engine's runtime contract and that contract imports `renderGovernedOutcomeContract`, which only 12.2 and later export.
- The artifact schemas a manifest may advertise are read from the installed package, never restated in Spex or its fixtures, so a release that moves the schema moves the check with it.

### Host capabilities from the shipped builder

- Each real-shell session builds its capabilities by loading the CLI's repository-effect module from the installed package's own files, resolved from an exported entry's location: the git semantics stay the CLI's, restated nowhere.
- Spex supplies what the builder leaves to the host: an in-memory effect ledger per session — the four command kinds applied in order, one attempt per Boss turn — the session's authority token under the core's root lease, and abandonment settlement that settles nothing durable.
- Before each Boss turn the session reconciles repository effects as the CLI does before each of its inputs; a failure there is a failure before the turn, surfaced as a runtime error record.
- The coupling to a shipped-but-unexported module is pinned by the floor and proven by the real-shell coverage over the real registries.

### Starter config and built-ins

- The seeded starter is the installed package's own template, read by path: both hosts' first-run config is identical by construction, with no copy to keep in sync.
- `dev` joins the built-in catalog beside code, review, and decide.

### Config relocation

- A config still at the pre-DR-043 XDG location relocates once into the canonical path exactly as the launcher relocates it: only when the canonical path is absent, bytes and permission bits preserved, published with an exclusive link, the legacy file left in place; an explicit `--config` moves nothing.
  Whichever host launches first performs the move, and neither seeds a starter over a config the user already had.

### History without a stream

- A captain-session record beside no replay stream lists from its Boss journal: each Boss entry opens a turn with its prompt, each Captain reply follows it, and the record's own timestamps bound them.
- Listing keeps Spex's own tolerant reader rather than the session-store facade, which rejects pre-cutover records.

### Considered and declined

- restating the builder in Spex: thousands of lines of git effect semantics the CLI already ships and tests;
- a durable per-session effect ledger: sessions never resume, so it would be written and never read; durability rides the resume decision [DR-036](036-file-state-store.md) defers;
- writing captain-session records so the CLI could list Spex sessions: the full turn lifecycle of the CLI's host, out of proportion to the one-directional sharing the goal names;
- staying on playbook 9: the shared stream, the `dev` playbook, and the relocated config all live past it.

## Consequences

- The core-service package amends the seeding item to name the installed template, the shell-instantiation item to carry the host capabilities and settlement hooks, and the foreign-session item to list journals; it gains the relocation and host-capability items with coverage.
- The playbook-library catalog gains `dev`; the Spex template asset is deleted.
- The two acceptance suites over the real shell and registries are the proof that the shipped builder loads and covers every enabled playbook; a playbook release that moves the module's path or shape fails them first.
- Effect-ledger durability and cross-restart resume stay one deferred decision; the in-memory ledger is the honest minimum until then.
