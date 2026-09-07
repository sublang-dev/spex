<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-029: Sessions In The Sidebar

## Status

Accepted; session deletion, declined below, is decided by [DR-038](038-history-is-done-work.md); an ended session becomes a paused conversation that a message continues by [DR-042](042-sessions-continue.md).
Amended by [DR-051](051-runtime-held-for-a-turn.md): the ending control and the "ended" vocabulary retire — closing still files a session away and stops nothing, and a launch still opens the start tab.
Realizes [DR-009](009-at-hand-interaction.md)'s "nothing the user produced becomes unreachable" as first-class law; extends [DR-007](007-conversational-session-start.md)'s start view into the session home.

## Context

- Ended sessions are already browsable — the Captain home lists them, and opening one replays its full read-only transcript — yet the product's own owner could not find a finished session minutes after watching it run.
  A feature the owner cannot find is not discoverable by anyone.
- The diagnosis, in order of harm:
  - the list lives behind the `+` tab — a door labeled "new", not "history" — and while a session runs, its own tab fronts and the home stays hidden;
  - entries carry no scent: a project name and an absolute timestamp, so no conversation is recognizable — every row reads alike;
  - a just-ended session gives the eye no handoff to its new home, so the mental model "ended sessions live on the home" never forms;
  - the read-only replay's header names the project, not the conversation.
- The thread itself became the run's record — bubbles and settled machine cards replaying identically ([DR-028](028-run-machine-view.md)) — so an ended session is now a complete, legible artifact worth shelving properly.
- The instant messenger is the pane's stated form (DR-010 §1), and messengers — like editors before them — put the navigator in the sidebar and the working set in tabs: the sidebar says what exists, tabs say what is open.
- The four navigation entries were peers, which said the app has four equal places; in truth one of them (Dashboard) answers "what needs me anywhere" and another (Workspace) answers "what am I doing in this project" — a difference the flat list hid.

## Decision

- **The sidebar is the navigator; tabs are the working set.**
  The sidebar lists what exists — every project, and under each its sessions; the tab strip holds what is open.
  Activating a session anywhere in the sidebar makes the workspace show that session's project and opens the session as a tab, so one gesture crosses projects ([DR-011](011-project-workspace.md)'s project-first workspace stands: the sidebar is now how a project is chosen).
- **Attention sits at the top, globally.**
  Dashboard is the sidebar's first entry and carries the app's attention count across every project — the aggregate view owning the aggregate signal ([DR-009](009-at-hand-interaction.md)); the Workspace section below it is the project perspective.
  A project whose sessions need a human shows that on its own row, so a collapsed project never hides a waiting question.
- **Sessions read as conversations.**
  Each row carries its session's title — the first Boss turn — its relative time, and a status mark.
  The mark speaks attention first and life second, in the app's one status palette: a session waiting on the human is amber and an unacknowledged failure is red, exactly as its tab and its Dashboard row already say; running, ended, and never-spoken are the quieter rest.
  A failure a session ended holding is history, not a summons: it wears a quieter mark and counts toward no badge, so red always means "chase this".
  The fuller scent — turn count and cost — rides in the row's accessible description, reachable by pointer, keyboard, and screen reader alike, because a sidebar is too narrow to print it and hover is not a channel ([DR-026](026-data-graphics-craft.md) §5).
  The active row wears the app's interaction hue, the same treatment the navigation entries already use, so what is open is unmistakable.
- **Disclosure is its own axis.**
  A project's chevron discloses; its row selects.
  Expansion is never a function of which project is current, so history in another project is browsable without moving the workspace into it — the axis split [DR-027](027-linked-views-contract.md) already legislated for the spec view, applied to the same shapes here.
- **Closing is not ending.**
  A tab's close control files the session back to the sidebar and never stops an agent; ending a session is its own named control with the guardrail it always had.
  One live session per project stands as the core states it, so a project's "new session" control opens that project's start tab rather than racing a conflict.
- **Every project shows a recent window, never an unbounded list.**
  A project lists its most recent sessions with one control that reveals the rest in place, so the sidebar's height stays a function of attention rather than of history's age.
- **Ending a session moves nothing, but shows where it landed.**
  The transcript stays where the eye already is, transitioning read-only with a fresh-session affordance in the composer's place, while its rows — in the sidebar and on its tab — mark it ended.
  The sidebar row is revealed and briefly highlighted, because when an action shelves something the house shows the shelf.
  Closing its tab files it back to the sidebar, where it stays reachable forever.
- **The working set belongs to this launch.**
  Which tabs are open is per project and not persisted: a launch restores the current project and opens its live session if it has one, and the sidebar — which is durable — is how everything else comes back.
  Persisting a working set would restore tabs whose sessions died at shutdown, buying nothing the sidebar does not already give.
- **The chrome folds, and folding costs nothing.**
  The sidebar collapses to an icon rail and restores under [DR-030](030-workspace-chrome.md), keeping the Dashboard badge and every accessible name; its width is fixed at each state, because two good widths beat a knob.
  Collapse is chrome only: the open tabs remain the reach, so nothing becomes unreachable behind it.
- **The project bar retires.**
  The sidebar carries project identity, so the bar above the tabs would be a second, quieter answer to the same question; the project palette stays the keyboard's fast path, and the affordances the bar carried — adding and creating projects — move into the sidebar's Workspace section beside the projects they make.

**Considered and declined**, so the alternatives cannot re-enter piecemeal:

- a session list inside the Captain home (the first design): history sat behind the same door that hid it, and vanished the moment a session filled the surface;
- a History dropdown on the tab strip (the second): a labeled door is still a door, and it left the strip owning two different jobs;
- a separate sessions column beside the sidebar: two navigators competing for the same axis, when the sidebar was already there;
- sessions as tabs alone (the shipped design): tabs are a working set, not an archive — everything unopened was invisible;
- motion replay or scrubbing of a past run: the thread and its settled machine cards are the record; animating history is its own future decision;
- session deletion and retention: destructive, and wants its own guardrail design (DR-010 §4);
- searching history: the recent window plus titles suffices at today's volumes; search earns a decision when volume demands it;
- persisting the open tabs across launches: the sessions behind them are dead by then, and the sidebar already restores everything.

## Consequences

- The core-service package gains the session-listing contract item — the reply's lifecycle fields plus title, turn count, failure marker, and cost — with coverage, and the matching contract for the state a running session broadcasts, since a row watched live must not blank when its session ends.
- The run-view package gains items for the sidebar's structure, its session rows, the session-to-tab gesture, and the in-place read-only transition, with fixture coverage; the tab strip's item widens from live sessions to the working set, and the end-session guardrail moves off the tab's close control onto a control of its own.
- [DR-009](009-at-hand-interaction.md)'s badge and browsability bullets and [DR-011](011-project-workspace.md)'s bar-shaped text are rewritten in place, so no record still describes the bar.
- The `spex-academy` demo flow becomes self-evidencing: a finished demo run is findable by its own first message minutes later.
