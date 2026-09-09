<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to the Spex app — the desktop and server shells over
one core and one interface — are documented in this file. The scaffold
CLI keeps its own changelog under `packages/cli`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
App releases ship as source under `app-v*` tags; run them with `npm ci`
and `npm start` (desktop) or `npm run start:server` (server).

## [Unreleased]

### Fixed

- Require supported Playbook trace evidence before advancing the intent queue.
- Keep Running and interrupted attention consistent for sessions whose
  transcripts have not loaded or are stale.

## [0.6.0] - 2026-09-09

### Added

- Runtime model selection in Settings and role bindings, with model-specific
  effort and fast-mode options, canonical IDs recognized through aliases,
  explicit custom pins, and refresh. Adapter efforts supplement model lists
  only where Cligent's discovery interface cannot report them.
- Every message in the Captain thread — yours, the Captain's, and a
  player's question — carries its clock time at the bubble's outer
  foot, quiet and tabular, with the exact date and time on hover; the
  thread's time separators speak the same clock.

### Changed

- Successful playbook completion starts the next unblocked intent in the
  project's queue while keeping the finished intent's Confirm reminder.
  Questions, failures, and replies without explicit completion pause the
  queue; explicit after-links still wait for a human verdict.
- New issue intents request work on a new branch, relevant checks, and a PR
  whose description closes the issue when the Boss merges it.
- Require Cligent 0.26 and Playbook 13.1 from the public registry.
  Clarification replies identify the player as the questioner, avoid
  repeating its question on resume, and retain task context for a fresh
  provider session.
- Refresh the app's SDK runtimes to Claude Code 2.1.263 and Codex 0.153.4.
- **Nothing ends.** The runtime is held only for a turn: a session's
  agents and its Playbook lease are released when a turn settles and
  taken up again by the next message, so there is no End control, no
  "ended" state, and the terminal can continue any Spex conversation
  between turns. A session reads working, waiting on you, idle, or
  history the core cannot continue; the sidebar orders sessions by
  last activity; the Now band and Start on an intent follow the
  project's current conversation.
- **Settings apply on the next message.** Every message opens the
  runtime on the settings the file holds, projected onto the session's
  own playbooks and players — enabling another playbook no longer
  invalidates a conversation. Model, effort, and fast-mode changes apply
  on the next call; a structural change (adapter, permissions, roster,
  bindings) is refused naming the fields that changed and offering a new
  session.
- A message to a project whose other session is mid-turn is refused
  naming that session; delete, rebind, and remove wait only on a turn in
  flight.
- Settings presents the Captain as a row of the players' shape: its
  chip opens the shared agent editor with Save and Cancel, one row's
  editor open at a time.

### Fixed

- Prevent a checkpoint error when a message arrives during turn cleanup.
- Keep agent and binding popovers inside the window as their options load
  or change.
- Preserve role tuning and comments when editing bindings, including an
  explicit fast-mode Off override.
- A player's failure shows once per call: an adapter that says the
  same failure as prose, as repeated error events, and again in its
  result now yields one failure line with a count, and a result line
  that reads "failed" with the words in its tooltip.
- Removing an Up next intent with the pointer no longer leaves the Undo
  line standing until the next click: only a keyboard removal hands
  focus to Undo, so the line lapses on schedule.

## [0.5.0] - 2026-09-06

### Added

- Desktop and Playbook 13 CLI share session history, continuation,
  recovery and deletion through one storage format. History preserves
  Captain and player records, saved settings and recorded graphs.
- Interrupted sessions offer **Retry** for the saved input and **Discard**
  to restore the preceding checkpoint when effect evidence allows it.
  Drafts and queued messages remain available while recovery is pending.
- A Git workflow selects complete sessions or individual app files from
  either branch, validates the result, and restores existing project IDs
  with local path bindings. See the [storage catalog](https://github.com/sublang-ai/spex/blob/app-v0.5.0/docs/storage.md)
  and [Git commands](https://github.com/sublang-ai/spex/blob/app-v0.5.0/docs/storage-git.md).

### Changed

- Desktop, server and CLI default to `~/.spex`; `SPEX_HOME` and explicit
  config/session paths remain supported. Migration replaces desktop
  sidecars and imports the former default CLI store, removing validated
  source files after retaining their originals in local migration receipts.
  Stop old writers and snapshot both `~/.spex` and the former
  `$XDG_STATE_HOME/playbook` or `~/.local/state/playbook` before upgrading.
  Do not reopen converted data with older versions; unsupported legacy
  checkpoints remain readable history.
- Provider hints stay local; managed Library paths use relative locations
  and retain sources for rebuilding on another device.
- The core requires Playbook 13 and Cligent 0.25. Definite provider session
  rejection permits one fresh attempt; ambiguous failures retain recovery
  evidence instead of retrying automatically.
- Git synchronization requires an explicit whole-session choice when both
  branches changed it. Run a session on one device at a time. Schema 7 does not
  relocate repository or module paths: different paths permit history only.
- Failed runtime cleanup keeps the session's lease and project reservation
  until cleanup or owner shutdown is proven.
- Desktop and server hosts require macOS or Linux with private POSIX
  storage. Windows supports the scaffold CLI and browser client.
- Player usage displays tokens only. Provider-reported costs remain in
  stored records, without monetary figures in the interface.

### Fixed

- CLI history refresh stays responsive during continuous writes. Replaced
  history reloads without duplicate folds or stale viewed markers; queued
  sends wait for durable settlement and survive refused submissions.
- Desktop waits for active CLI writers before offering session recovery
  or management, and refreshes when their leases are released.
- The spec graph fills its pane and remains readable at short heights
  instead of collapsing packages onto one point.

## [0.4.0] - 2026-09-02

### Added

- **Player lanes fold.** Each pane's header carries a collapse control;
  a folded lane stands as a narrow rail with its name, running mark,
  and an expand control, the remaining panes take the freed width,
  and a folded lane unfolds itself when its call opens.
- **History in a frame.** The Dashboard's History band lists every
  loaded row inside a frame eight rows tall that scrolls, with
  "Older…" at its end fetching the next page, so the groups below
  never move.
- **Frames the reader can resize.** The History frame and the
  Playbooks stage box take the house divider idiom turned horizontal:
  a bottom grip drags the height within bounds, arrow keys step it,
  double-click restores the default, and the height is remembered per
  frame; the grip hides while the content fits.
- **The pipeline as a row.** Every Playbooks card shows
  "Source → Gears → State machine" in place of the Pipeline button;
  each stage toggles its artifact beneath, one at a time, with absent
  stages struck through and the state list under the State machine.
- **Sources open by default**, their three tabs in view; the fold is
  remembered per project while the app runs.
- **A done intent can be removed from History.** The row's remove
  control opens the inline confirm; confirming appends a remove act
  to the intent log, and the intent leaves every band without a
  trace, on this and any synced copy.
- **Gears as spec items.** The Playbooks Gears stage renders the
  compiled GEARS file with the Specs outline's own item rows —
  chip, group, first line, expandable body, in-artifact citation
  jumps — and the State machine stage keeps its state list pinned
  above the scrolling code.
- **Citations preview at hand.** Every citation in the Specs view —
  an entry in an item's cites row, a backlink, and a citation inline
  in a body — shows the cited item's chip, first line, and opening
  in a card after a short hover intent and at once on keyboard focus,
  replacing the browser's slow tooltip; the Playbooks Gears rows
  preview the same way. An item's citations sit in one block and its
  Edit control moved to the header row.
- **Running sessions listed again.** A Running band below Needs
  attention lists every live session with a turn in flight that
  needs nothing from the Boss — project, title, what it is doing —
  and reads "Nothing running." while empty; the attention queue stays
  the summons.

### Changed

- **The page never scrolls.** Every surface scrolls inside its own
  box, vertically as well as sideways, every scroll box is a
  positioned box so screen-reader-only text and popovers stay inside
  it, and the fit journey measures both at 400 and 800 pixels tall on
  every surface with a resize pass.

### Fixed

- **Back returns to where a record was opened.** A record opened from
  the Dashboard or a project's Overview reads behind
  "← Back to Dashboard" / "← Back to Overview", and Back lands on the
  row that opened it; a record picked in the Specs tree keeps its
  plain Back.
- **The working lane comes into view** when its call opens beyond the
  grid's edge, side by side or stacked.
- **A parked question stands** until the parked run itself leaves its
  park or is dismissed; the controller Captain's own state reports no
  longer clear it from the composer or the Dashboard.
- **The Sources tab row wraps** before it widens the band on narrow
  panes.
- **The sidebar's selection follows the surface**: on the Dashboard,
  Playbooks, or Settings no project row reads as selected; the lit
  entry alone says where you are, and Workspace restores the
  remembered project.
- **Queued Boss messages stay in their box.** The queue is a bounded
  frame that scrolls, so the transcript and the composer's field and
  actions keep their place at any queue length, and an unbroken URL
  in a queued message wraps instead of widening it.
- **The Captain agent popover opens where it fits**, below its anchor
  when there is no room above, with its own scroll in a short window.
- **The composer and the transcript follow their own pane**: the field
  refits when the pane resizes without a window resize, a transcript
  following its end keeps following after a resize, a machine drawing
  scrolled to its end regains its fade when the pane narrows, and the
  split divider lands under the pointer.
- **Anchored editors stay inside their box.** The agent editor and the
  role-binding popover are placed by one measured rule that keeps
  them within the pane at every width from the 320px floor and lets
  them scroll their own content.
- **Rows and chips yield before they widen**: a labelled issue or
  pull-request row folds its tags on a narrow pane, a long spec item
  id truncates in the outline, the outline keeps a readable height
  beside the graph, the graph's hover card stays inside its pane, and
  the project palette fits a short window with its message reachable.

## [0.3.0] - 2026-09-02

### Added

- **Records legible from a projector.** The type scale bottoms out at
  12px: every chip, age, caption, and badge reads at the small step,
  and the Captain thread's narration lines are left-aligned system
  lines with their glyph in an icon slot.
- **Machine cards that fit.** State names read at 13px in boxes as
  wide as their column's longest label, a nested state goes by its
  own segment with its parent as caption, unwalked exits into rest
  states fold to a "+N" marker until walked or hovered, and a drawing
  scales into a column it barely exceeds and scrolls behind a fade
  past that; the Captain split defaults to 45% and holds still.
- **Player panes tell the call.** Headers read "coder · dev.coder",
  an untouched lane reads "Idle until the playbook calls ⟨lane⟩", a
  running call ticks "coder working · 2m 13s" in the pane and the
  thread, tool rows read as commands whichever runner made them, and
  a finished call shows its span, tokens, and cost.
- **Failures speak plain**, with the runtime's words in the tooltip;
  agent text, prompts, bubbles, and code blocks wrap unbroken tokens.
- **The Dashboard never reads empty while loading**: History says
  "Loading…" until its first page and lists its newest eight rows
  under "Older…", Sources says it is loading rather than not
  connected, and the Now band reads "deciding" or "working" mid-turn.
- **The served page carries the shell's version**, so Settings
  never prints a dev placeholder over a remote connection.

### Changed

- **Playbook 12.2 with slc 0.7.** The core runs on `@sublang/playbook`
  12.2, the release whose runtime the `slc` 0.7 compiler links every
  compiled playbook against; the Playbooks example card shows slc
  0.7's own two-agent change-and-review demo, and the `dev` built-in's
  machine drawing gives each transition its own port.

### Fixed

- **Compiled playbooks register.** Registering a compiled playbook
  matched its bound roles case-sensitively against slc's capitalized
  role ids, so every compile ended in "no player was bound"; the
  bindings now match however the submission cased them, and the
  registry's absolute path imports as a file URL on Windows.
- **The composer keeps one row.** A window laid out before it was
  shown pinned the Boss field to no height, clipping its placeholder
  until a reload; the field never drops under one row and refits
  when the viewport resizes.
- **A session with no player lanes** — one the playbook terminal
  wrote — shows the Captain column alone at the home's reading width
  instead of a divider beside an empty half.
- **Nested machine states read by name.** A region of `/decide`'s
  parallel proposals drew under its whole dotted id, trimmed past the
  box; it now goes by its own segment with its parent as caption and
  the whole path in tooltips and the status line.
- **A codex coder's tool rows read as commands**: the login-shell
  wrapper is unwrapped and its shell tool reads "shell", as a Claude
  coder's rows already did.

## [0.2.0] - 2026-09-02

### Added

- **Sessions continue.** An ended session is a paused conversation: a
  message continues it, after the app restarts too, from a token-free
  Captain snapshot kept beside the session; the End confirm says so.
- **Every session can be deleted**, sessions run from the playbook
  terminal included, behind a lease check that refuses while a
  terminal still writes them.
- **Spec editing.** Packages, decision records, and intent records
  open in a plain-text editor with a markdown preview from the Specs
  tab; saves are atomic and refuse to clobber a file an agent changed
  meanwhile.
- **Intent controls.** A working intent can be dropped from the
  session's working line and the Dashboard's Now band; the Captain
  home's next card can remove its intent.

### Changed

- **Chrome that fits.** The composer is rebuilt — field on top, actions
  beneath, "Send" and "Send next", no native grip — and every row,
  toolbar, and header yields at narrow widths instead of overlapping;
  a browser journey now measures overlap at widths from 320px.
- Record rows look and act alike everywhere — Specs decisions, History,
  Sources — and open the record in the records reader.

### Fixed

- History and Sources record rows opened nothing; they now land in the
  records reader.
- A stale ledger reply could outlive a fresh one, leaving a started
  intent shown as still queued.

## [0.1.0] - 2026-09-02

### Added

- **Workspace.** Local git repositories as projects; Boss sessions with
  a Captain pane, one pane per session player, live machine cards for
  the playbook run, and a composer that queues messages during a turn
  and answers a player's question in place; the project palette, the
  Specs tab with outline, search, citations, and graph, and the
  project Overview.
- **Dashboard as the intent ledger.** An attention queue of questions,
  failures, and finished work awaiting a verdict; per-project History,
  Now, Up next, and Sources; one-gesture capture from GitHub issues,
  pull requests, intent records, or a typed line; Start stages an
  intent into the composer; Confirm or Drop closes it; History shows
  done work with fixed bugs crossed out.
- **Playbooks.** The `@sublang/playbook` built-ins (`/code`, `/review`,
  `/decide`, `/dev`), per-role inline agents with fast mode, the
  pipeline view, and a compile flow through `slc`.
- **Settings.** The Captain agent, session players, adapter readiness
  with in-place re-check, notifications, and comment-preserving edits
  of the shared playbook config.
- **Shared file state.** App state under `~/.spex` and sessions in the
  playbook CLI's own store, so a session run from a terminal appears
  in the app; the shared config lives under `~/.spex/playbook`.
- **Server shell.** The interface and the core served from one port
  behind a token URL, with optional TLS, for browsing a machine you own
  from another.
- **Desktop shell.** Single instance, OS notifications and dock badge,
  and a guarded source launch that rebuilds and restores the native
  module.
- **Acceptance.** Browser journeys driving the served interface in
  Chromium against a real core with substitute agents, including an
  accessibility scan of every surface in both themes.

[Unreleased]: https://github.com/sublang-ai/spex/compare/app-v0.6.0...HEAD
[0.6.0]: https://github.com/sublang-ai/spex/compare/app-v0.5.0...app-v0.6.0
[0.5.0]: https://github.com/sublang-ai/spex/compare/app-v0.4.0...app-v0.5.0
[0.4.0]: https://github.com/sublang-ai/spex/compare/app-v0.3.0...app-v0.4.0
[0.3.0]: https://github.com/sublang-ai/spex/compare/app-v0.2.0...app-v0.3.0
[0.2.0]: https://github.com/sublang-ai/spex/compare/app-v0.1.0...app-v0.2.0
[0.1.0]: https://github.com/sublang-ai/spex/releases/tag/app-v0.1.0
