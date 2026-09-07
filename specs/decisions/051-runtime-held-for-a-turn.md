<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-051: The Runtime Is Held Only For A Turn

## Status

Accepted (2026-09-07) on the owner's two questions: why a session must be ended when a message continues it, and how settings can be changed once a session has started.
Amends [DR-042](042-sessions-continue.md) (ending retires: a session is continued, never ended), [DR-029](029-session-history-home.md) (the ending control and the "ended" vocabulary), [DR-035](035-intent-ledger.md) (the lane Start reuses is the project's current conversation, not a live session), [DR-038](038-history-is-done-work.md) (the delete control waits only on a turn in flight), and [DR-002](002-desktop-app-architecture.md) (one working turn per project replaces one live session per project).

## Context

- Since [DR-042](042-sessions-continue.md) an ended session is a paused conversation a message continues, so "End" kept only two duties: releasing the project's one-live-session slot — a rule Spex enforces itself; Playbook claims a worktree per governed call only — and releasing the Playbook session lease so the terminal can continue the same session.
  Both duties exist only because the runtime is held while the session is idle.
- Holding the runtime while idle also freezes settings: the Playbook host takes its execution projection when it opens and offers no reconfiguration, so an edit in Settings reached a live session never.
  Playbook's own law is that a reopen reads current config, projected onto the session's stored playbooks and referenced players, applies compatible model, effort, and fast-mode changes on the next call, and fails closed on structural drift — adapter, instruction, permissions, roster, bindings, catalog membership.
  The playbook CLI reads config at every `playbook run` and holds the lease only for the turn.
- Spex projected the whole enabled catalog at continuation, so enabling any playbook made every existing session's continuation a structural refusal.
- Measured on the real shell: a dispose after a settled turn appends one trace carrying no turn id, leaves the manifest untouched, and keeps the provider hints bound, so the Captain and players resume their conversations on the next open; reopening validates the replay three times and observes the repository, sub-second on the largest local session.
  Playbook restores a parked run's frames from retained generations, so a question parked when the runtime detaches is answered where it waited.
- Claude Code and Codex hold no ending concept: a conversation is durable, a process attaches while one works in it, and continuing later is a message away.
- Alternatives reviewed adversarially: keeping the control under another name ("Pause", "Release to terminal") keeps a control whose one job is releasing a lease the user cannot see; holding the runtime while a tab is open with pausing on tab close and on displacement couples the core lifecycle to one client's view state — wrong under several clients ([DR-033](033-remote-gui-serving.md)) — makes attachment user-facing, and is not atomic with turn admission; an idle timeout adds nondeterminism and is dominated by a timeout of zero.

## Decision

### The runtime is held for a turn

- A session is a durable conversation.
  The core holds its runtime — the Playbook lease, the Captain shell, the players — only for a Boss turn: acquired when a message arrives, through the continuation path that already existed, and released when the turn settles, fails, or aborts.
  "Live" means a turn is in flight or settling.
- The one exception is a settled checkpoint the core could not continue from disk — unresolved repository effects: the runtime then stays held until a turn leaves the checkpoint continuable, because a conversation is never detached into a state it cannot re-enter.
- There is no ending control and no "ended" state in the interface; `session.dispose` stays as the protocol's abort-and-detach primitive for shells, drivers, and tests.

### Every message applies the current settings

- A message opens the runtime with the settings the core holds when the message arrives, projected onto the session's stored members — its playbooks, and its referenced players in stored order — so an unrelated new playbook or player never invalidates a conversation.
- Tuning changes — model, effort, fast mode of the Captain, a player, or a binding — apply on the next call.
  Structural changes — adapter, instruction, permissions, a player's presence or place, a binding's player, a session playbook disabled or changed, its options — are refused before the runtime opens, naming the fields that changed and offering a new session.
- A turn in flight keeps the settings it opened with; while the config is invalid, a message is refused naming the error.

### One working turn per project

- A message to a session is refused only while another session of its project has a turn in flight — named, so the way forward is plain — or while another host holds it.
  Deleting a session, rebinding or removing a project wait on the same condition and nothing else.

### The current conversation

- A project's current conversation is derived from stored state: the session with a turn in flight, else the most recently active session that continues and no other host owns.
  It is the lane the ledger folds for conditions and stand-ins, what the Now band shows, and where Start on an intent stages; the start tab is the fresh lane.
- The host's dispose trace outside a turn — carrying no turn id — is a pause, never the Captain dismissing a parked run: a parked question survives it and still summons.

### Presentation

- A session is working, waiting on you, idle, history the core cannot continue (its reason shown), uncertain, or in use elsewhere.
  The sidebar orders a project's sessions by last activity, the working one first; only history is named on a tab.
- A paused conversation's composer is an ordinary composer; its send reads "Sending…" until the turn starts, and a refusal lands in the composer's frame with the draft kept.
- Drafts clear only on send; closing a tab files the session away and touches nothing ([DR-029](029-session-history-home.md) stands); quitting asks only about turns in flight; a launch still opens the start tab.

## Consequences

- The core detaches at settle behind the continuable guard, narrows the projection to stored members and names drift, derives current-conversation lanes, reads a dispose trace outside a turn as a pause, awaits a pending config reload before opening, and refuses by name.
- The run view loses its End control, confirm, and ended notice; tabs, sidebar rows, and headers lose the word "ended"; the Now band and intent staging follow the current conversation; queued messages dispatch after the turn settles although the session is no longer live.
- The terminal can continue any Spex conversation between turns, and the desktop refuses a message while the terminal holds a turn — the shared store's promise ([DR-045](045-unified-session-storage.md)) without a gesture.
- Every message pays a reopen: sub-second today, growing with the replay's length through Playbook's three digest passes — an upstream cost to watch.
- `run-view-47` retires with its ID reserved; items across core-service, run-view, dashboard, projects, and app-shell are reworded; four browser journeys and the release smoke driver change their ending steps.
- Left open: reopening the last conversation at launch, and aligning Spex's unresolved-effects continuation gate with Playbook's own admission.
