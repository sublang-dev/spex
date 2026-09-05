<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Spec Map

Quick-reference index for locating decisions and spec packages.
Spec items are the source of truth.
Code can be inconsistent with specs during development.

## Authoring and reviewing specs

Know the rules in [`meta.md`](meta.md) before authoring, modifying, or reviewing a DR, IR, or item.

## Layout

```text
decisions/    Decision records (DRs)
intents/      Intent records (IRs)
packages/     Spec packages (one file per package)
map.md        This index
meta.md       The spec of specs
```

## Decisions

| ID | File | Summary |
| --- | --- | --- |
| [DR-000](decisions/000-spec-structure-format.md) | 000-spec-structure-format.md | Spec structure, format, and naming conventions |
| [DR-001](decisions/001-scaffold-localization.md) | 001-scaffold-localization.md | Scaffold localization via per-language overlays |
| [DR-002](decisions/002-desktop-app-architecture.md) | 002-desktop-app-architecture.md | Spex desktop app: web-first three-layer architecture, monorepo, release preservation |
| [DR-003](decisions/003-runtime-reuse.md) | 003-runtime-reuse.md | Embedded headless runtime + captain shell; record-driven read-only panes |
| [DR-004](decisions/004-config-and-persistence.md) | 004-config-and-persistence.md | Shared playbook config ownership, app-local SQLite store (superseded by DR-036), readiness |
| [DR-005](decisions/005-compilation-integration.md) | 005-compilation-integration.md | slc as external toolchain; in-app registry generation |
| [DR-006](decisions/006-projects-and-forge.md) | 006-projects-and-forge.md | Projects as local git repos; gh-CLI GitHub forge adapter |
| [DR-007](decisions/007-conversational-session-start.md) | 007-conversational-session-start.md | Sessions lands on a Captain-first start view; one motion to the first turn |
| [DR-008](decisions/008-native-shell-bridge.md) | 008-native-shell-bridge.md | Feature-detected `window.spexNative` bridge for OS pickers only |
| [DR-009](decisions/009-at-hand-interaction.md) | 009-at-hand-interaction.md | At-hand interaction: no forced surface switches; in-place popovers; global attention badge; browsable history |
| [DR-010](decisions/010-interface-craft.md) | 010-interface-craft.md | Interface craft: conversation-first, human status, honest async, guardrails, keyboard, accessibility, one visual grammar |
| [DR-011](decisions/011-project-workspace.md) | 011-project-workspace.md | Project-first workspace: four-surface taxonomy, project palette, per-project tabs + Specs/Repo, interactive spec view |
| [DR-012](decisions/012-spec-package-files.md) | 012-spec-package-files.md | One-file spec packages; spec linter; mechanical migration superseded by DR-022 |
| [DR-013](decisions/013-sublang-brand.md) | 013-sublang-brand.md | SubLang brand adoption: purple interaction hue, warm light neutrals, brand-recolored product logo and app icon |
| [DR-014](decisions/014-released-toolchain.md) | 014-released-toolchain.md | Released toolchain adoption: playbook 2.0 / cligent 0.16 host boundary (floor superseded by DR-023), effort key, slc-emitted registry wrapper, invalidation, session cwd |
| [DR-015](decisions/015-reference-content.md) | 015-reference-content.md | Reference content: built-in sources + catalog, slc demo example, Academy seed project, packages-layout spec view |
| [DR-016](decisions/016-relationship-presentation.md) | 016-relationship-presentation.md | Superseded by DR-000: classified relationship presentation gives way to one citation mechanism |
| [DR-017](decisions/017-intent-records.md) | 017-intent-records.md | Iterations become intents: disposable intent records, bare `IR-<N>` commit references; mechanical migration superseded by DR-022 |
| [DR-018](decisions/018-one-contract-per-item.md) | 018-one-contract-per-item.md | One requirement per item: one governing GEARS statement with per-kind attachments; advisory lint |
| [DR-019](decisions/019-inline-agent-configuration.md) | 019-inline-agent-configuration.md | Inline agent configuration: profile-less blocks, runtime-bounded adapters, adapter-scoped efforts, captain-adapter parity, no shorthand surface |
| [DR-020](decisions/020-desktop-live-smoke.md) | 020-desktop-live-smoke.md | Desktop live smoke: env-guarded handshake, real-run driver, split hermetic/live release gates |
| [DR-021](decisions/021-skill-based-migration.md) | 021-skill-based-migration.md | Superseded by DR-022: installable migration skill and guide |
| [DR-022](decisions/022-prompt-based-migration.md) | 022-prompt-based-migration.md | Prompt-based spec migration: one bundled agent-neutral prompt, `spex lint`, and human review |
| [DR-023](decisions/023-runtime-compatibility-from-cligent.md) | 023-runtime-compatibility-from-cligent.md | Runtime compatibility from cligent: playbook 4.0 / cligent 0.18 floor, no Spex-declared agent SDKs, live-run supply becomes an app-shell concern |
| [DR-024](decisions/024-app-supplied-agent-runtimes.md) | 024-app-supplied-agent-runtimes.md | App-supplied agent runtimes: desktop declares the claude/codex/opencode SDKs at `*`; readiness probes availability through cligent with per-tree repairs |
| [DR-025](decisions/025-playbook-7-adoption.md) | 025-playbook-7-adoption.md | Playbook 7 adoption: code/review/decide built-ins, single-role CODE, controller Captain, cligent 0.20 floor |
| [DR-026](decisions/026-data-graphics-craft.md) | 026-data-graphics-craft.md | Data-graphics craft: keyed honest encodings, computed contrast, content-driven density, d3 engine with live drag, permanent outline + graph toggle, design-check gate |
| [DR-027](decisions/027-linked-views-contract.md) | 027-linked-views-contract.md | Linked-views contract: shared axes with a seven-rule coupling card, solved density, root-less outline with a decisions branch, intents to the Dashboard |
| [DR-028](decisions/028-run-machine-view.md) | 028-run-machine-view.md | Run machines drawn: live statechart cards in the Captain pane, machine graph over the artifacts contract, trace-folded frames, captain failures surfaced whole |
| [DR-029](decisions/029-session-history-home.md) | 029-session-history-home.md | Sessions in the sidebar: Dashboard-first attention, projects with their sessions as the navigator, tabs as the working set, titled sessions over session.list |
| [DR-030](decisions/030-workspace-chrome.md) | 030-workspace-chrome.md | Workspace chrome: two-state rail collapse, the divider idiom as house law, chrome state as preference, collapse never hiding a duty |
| [DR-031](decisions/031-machine-call-tree.md) | 031-machine-call-tree.md | The run call tree: one card per run lifetime, calls drawn as containment with named call sites, cards breathing between drawing and strip, one aliveness grammar, neighbours-draw/distance-speaks edge law |
| [DR-032](decisions/032-session-players.md) | 032-session-players.md | Session players: roles bind to explicit player lanes, a pane per player with per-call role labels, forked player/binding editors, guided legacy migration, playbook 8 / cligent 0.22 floors |
| [DR-033](decisions/033-remote-gui-serving.md) | 033-remote-gui-serving.md | Remote GUI serving: server shell on one port, tokenized-URL auth, optional TLS, shell-attached core endpoint |
| [DR-034](decisions/034-playbook-9-adoption.md) | 034-playbook-9-adoption.md | Playbook 9 adoption: floor to ^9.0.0 (superseded by DR-037), cligent unchanged, recaptured machine fixtures, no product code change |
| [DR-035](decisions/035-intent-ledger.md) | 035-intent-ledger.md | The intent ledger: intents as staged Boss turns, one-gesture capture from issues/PRs/records/chat, per-project queues with one after-link, verdict-owed deliveries, confirm-pulls-next Dashboard |
| [DR-036](decisions/036-file-state-store.md) | 036-file-state-store.md | File state and the shared session store: SQLite retires for plain files under one state root, sessions shared with the playbook CLI, intents as an act log, file-sync-safe backup |
| [DR-039](decisions/039-browser-acceptance-journeys.md) | 039-browser-acceptance-journeys.md | Browser acceptance journeys: Playwright over the served UI against a real core with substitute agents, journeys as package test items, hermetic lane in CI, live lane opt-in |
| [DR-040](decisions/040-source-only-app-releases.md) | 040-source-only-app-releases.md | Source-only app releases: `app-v*` tags publish notes and run-from-source instructions with no binaries, one version across both shells, a root changelog, the CLI channel's gates |
| [DR-041](decisions/041-chrome-that-fits.md) | 041-chrome-that-fits.md | Chrome that fits: the pane as the unit of fit, three container steps, a 14-character label budget, the yield ladder, 280px/320px floors, the composer's shape, a browser journey that measures overlap |
| [DR-042](decisions/042-sessions-continue.md) | 042-sessions-continue.md | Sessions continue: a token-free Captain snapshot in the sidecar lets a message continue an ended session; every listed session, terminal-run ones included, can be deleted behind a lease check |
| [DR-043](decisions/043-minimal-spec-editing.md) | 043-minimal-spec-editing.md | Minimal spec editing: one confined atomic write with digest-token conflicts, a whole-file plain-text editor with preview in the spec view, drafts that survive navigation |
| [DR-044](decisions/044-no-money-in-the-interface.md) | 044-no-money-in-the-interface.md | No money in the interface: the usage line reports tokens only; a recorded cost is never rendered |
| [DR-045](decisions/045-unified-session-storage.md) | 045-unified-session-storage.md | Proposed: Shared desktop/CLI storage: one Spex home, portable history/graphs, local provider hints, Git with whole-session choices |
| [DR-046](decisions/046-decision-record-evolution.md) | 046-decision-record-evolution.md | Accepted-decision evolution: successor DRs, scoped reciprocal links, current spec items updated on acceptance |
| [DR-037](decisions/037-playbook-12-adoption.md) | 037-playbook-12-adoption.md | Playbook 12 adoption: floor ^12.2 (with slc 0.7) / cligent ^0.24, host capabilities from the shipped builder with an in-memory effect ledger, installed template and `dev` built-in, one-time config relocation, journal-listed history |
| [DR-038](decisions/038-history-is-done-work.md) | 038-history-is-done-work.md | History is done work: finished records as history seeds, removal without trace, verdict grammar, the project Overview tab, session deletion, the fast-mode mark |

## Packages

| File | Summary |
| --- | --- |
| [app-shell.md](packages/app-shell.md) | Desktop shell: guarded source launch and ABI restoration; single-instance window, notifications, dock badge, core-in-main over WebSocket, packaging; packaged-app acceptance |
| [core-service.md](packages/core-service.md) | Headless core service: WebSocket protocol, config load/seed/reload, session lifecycle with snapshot-backed continuation and lease-checked deletion, record streaming, persistence, readiness — with fake-adapter end-to-end coverage |
| [dashboard.md](packages/dashboard.md) | Dashboard as the intent ledger: two-band attention queue, Running band, per-project History/Now/Up next/Sources groups, one-gesture capture; one deterministic core fold |
| [desktop-session.md](packages/desktop-session.md) | A Boss session in the packaged app: shell process topology, core streaming, and run-view rendering over one protocol |
| [forge-work-lists.md](packages/forge-work-lists.md) | Repo tab and Dashboard render the same forge-adapter data |
| [git.md](packages/git.md) | Commit message format and AI co-authorship trailers |
| [licensing.md](packages/licensing.md) | SPDX header requirements, file-scope rules, and header presence checks |
| [lint.md](packages/lint.md) | `spex lint`: structure with the legacy-tree migration prompt pointer, package sections, item IDs, citation form and coverage, citation discipline, reference markers, records, map listing |
| [playbook-library.md](packages/playbook-library.md) | Playbook library: browse/enable, per-role inline agents, slc compile pipeline, registry validation, comment-preserving config writes |
| [projects.md](packages/projects.md) | Projects: register/create local git repos, repo state, gh forge binding and work lists, safe removal |
| [release.md](packages/release.md) | Versioning, changelog, release process, CI-green publish gate, package hygiene, end-user and live migration smokes |
| [run-view.md](packages/run-view.md) | Run view: Captain pane, read-only player transcripts, Boss composer, paused sessions a message continues, protocol-only rendering, fixture-stream and browser-journey coverage |
| [scaffold.md](packages/scaffold.md) | Scaffold CLI: target resolution, idempotent seeding, LICENSE emission, language selection, agent instructions, and --update prompts for reconciliation or legacy migration |
| [server-shell.md](packages/server-shell.md) | Server shell: one-command source launch; UI bundle with negotiated response compression and core WebSocket served from one port; token URL, TLS, bind safety, page connection |
| [storage.md](packages/storage.md) | Proposed: Spex home catalog, file encodings, local project bindings, migration and Git selection |
| [settings.md](packages/settings.md) | Settings: Captain agent editor with launcher-parity validation, adapter readiness, comment-preserving YAML round-trip |
| [shared-config-roundtrip.md](packages/shared-config-roundtrip.md) | One config file, one fail-closed rule set across Settings, core, and Library |
| [spec-view.md](packages/spec-view.md) | Spec view: package tree, filters + search, citation jumps, records reader, whole-file editor with digest-token saves; specs.get/specs.read/specs.write contract for the packages layout |
