<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-038: History Is Done Work

## Status

Accepted (2026-09-02) on the owner's review of the Dashboard and Workspace; session deletion is extended to sessions another host wrote by [DR-042](042-sessions-continue.md).
Amended (2026-09-02): the History band caps at eight rows and scrolls inside that frame, its "Older…" control at the frame's end, so a long history is browsed in place and the groups below never move.
Amended (2026-09-02): the Dashboard carries a Running band between the attention queue and the project groups, listing every live session whose turn is in flight and whose session no attention entry summons — the queue answers "what needs me", the band answers "what is working".
Amended by [DR-051](051-runtime-held-for-a-turn.md): a session's delete control waits only on a turn in flight, since the runtime is held for a turn and nothing is ended.
Amends [DR-035](035-intent-ledger.md) (a never-worked intent leaves the ledger without a trace; history lists done work, records included), [DR-011](011-project-workspace.md) (the Repo tab becomes the project's Overview), and [DR-029](029-session-history-home.md) (session deletion is decided); playbook 12.1 and 12.2's published host-capabilities facade was tried against the Captain shell and refused — its repository object lacks `acquire` and `runCohort`, and its per-playbook ledgers diverge where the shell requires one — so [DR-037](037-playbook-12-adoption.md)'s by-path builder stands.

Amended by [DR-052](052-runtime-model-options.md): model and tuning choices come from runtime discovery.

## Context

- The owner's review (2026-09-02), on the live app: History listed nine crossed-out "dropped" rows for intents that were queued from issues and removed before any work; the Sources band counted 29 "open records" for a project whose records are nearly all complete; dropping a queued intent asked for a confirmation; the row's provenance action read "Open source"; the Workspace's Repo tab repeated the Dashboard's issue and pull-request lists; a queued intent could not be removed from the Workspace; a session could not be deleted anywhere.
- Underneath: [DR-035](035-intent-ledger.md) made dropping a verdict on any open intent and kept every closed row as history, so un-queueing was indistinguishable from abandoning work; the record status read recognized only the word "Done", while real records say "Complete", "Completed", "Superseded", or "In progress"; the strike-through meant "dropped", which the eye reads as "gone" rather than "fixed".
- The owner's law for the band: History is what was really done.
  A bug fixed reads best crossed out — the bug is gone — under an unmistakable bug tag; everything else done wears a check; a decision to stop work is a verdict worth showing, quietly; taking an intent back out of the queue is nothing at all.
- Every project's intent records are exactly that history, already written and reviewed; a fresh project's History need not be empty when its records tree is full.

## Decision

### History is done work

- A project's History band lists two kinds of rows, one timeline newest first: intents that were worked and then closed, and finished intent records from the project's specs tree — each record under its ID tag, ordered by its file's last change.
  A record that a closed intent already names as its provenance appears once, as that intent.
- The row grammar: done work wears a check; a fixed bug — an intent captured from an issue carrying a bug label, closed done — is struck through under a red bug tag and wears no check; work dropped after it ran wears a quiet "dropped" tag, dimmed, never struck; a record whose status reads superseded or cancelled wears that word as its tag.
- An intent dropped before any turn of it ran leaves the ledger without a trace: no history row, no verdict — the act stays in the append-only log, and every read excludes it.
  "Worked" means a turn the intent attributes ended finished.
- A record's status is classified, not matched: the status line's leading word decides — done, complete, completed, closed, shipped, released, and finished are finished; superseded, cancelled, dropped, abandoned, and withdrawn are finished and superseded; anything else, or no status, is open.
  Open records stay in the Sources band as capture seeds; finished ones list in History; every record lands in exactly one.
- The classification lives in the core's records read, so the Sources counts, the Sources tab, and History agree by construction.

### Removing is not dropping

- A queued intent's row action is Remove, and it acts on the click: no confirmation, no history — the cost of a mistaken removal is retyping one line.
- Drop on a finished or interrupted intent stays a verdict and lands in History, also without a confirmation: a verdict is one click by design, and the row it produces is the record of it.
- The provenance action names what it opens — "Issue #42", "PR #7", "IR-⟨N⟩", "Session" — and an issue or pull request opens in the browser as before; the label "Open source" retires.
- Capture keeps the source's labels beside its number and URL, so the bug tag derives from provenance rather than from a later forge read.

### The project's Overview

- The Workspace's Repo tab becomes the Overview tab: the project's own ledger group — History, Now, Up next, Sources — as the Dashboard renders it, under a repository header carrying branch, dirty state, ahead/behind, the GitHub binding with its setup guidance, refresh, and the remove-project control.
- One component draws the ledger group in both places ([DR-027](027-linked-views-contract.md)); the Overview pins one project, so the Dashboard's project filter has no counterpart there.
- Naming: the sidebar's Dashboard is every project; a tab's Overview is this project — a fresh user meets two words for two scopes, never the same word twice.
- Queue-instead-of-send's acknowledgement points at Up next in the Overview, where the queued intent has its Remove.

### Sessions can be deleted

- A session row in the sidebar carries a delete control while the session is ended and this core owns its files; a live session ends first, and a session another host wrote is served, never deleted ([DR-036](036-file-state-store.md)).
- Deletion is destructive and irreversible, so it keeps one inline confirmation in place ([DR-010](010-interface-craft.md) §4) — the one guardrail this record keeps.
- Deleting removes the session's files and every in-memory trace, forgets its viewed marker, closes its tab, and announces the removal; an open intent it was serving re-derives as queued, and a closed one keeps its verdict.

### Fast mode is visible

- Where an agent's chip reads adapter, model, and effort, an agent running in fast mode wears a lightning mark after them, with "fast mode" in its tooltip — the Captain chip, the roster rows, the player pane's label alike.
- The agent editor offers a fast-mode switch for the adapters the embedded runtime declares as supporting it, and no switch for the rest.

### Considered and declined

- a "Remove" that also strikes the act from the log: the log is append-only by [DR-036](036-file-state-store.md), and an excluded row costs nothing;
- listing open records in History too: a record not yet done is a seed for the queue, not history — the Sources band is its place;
- a modal for session deletion: destructive, but one inline confirmation at the row is the guardrail the run view's End session already uses;
- keeping "Repo" as a second tab beside Overview: its repository header is four facts and one control, which the Overview header carries.

## Consequences

- The dashboard package rewrites the History, Sources, capture, and Up next items and their coverage; the core-service package amends the close command, the history read, the act-log item, and the records read, and gains session deletion; the projects, run-view, spec-view, and settings packages amend to the Overview tab, the provenance label, the status classification, and the fast-mode mark.
- The protocol carries provenance labels, a session's foreign origin, a record's classification and last change, fast mode on agent summaries, `session.delete`, and a session-removed broadcast; the version bumps.
- The owner's existing never-worked "dropped" rows vanish from History by derivation alone; no data moves.
- Session deletion of a Spex session leaves the shared session store's foreign records untouched, by the same write prohibition as before.
