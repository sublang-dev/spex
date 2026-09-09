<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# dashboard: Dashboard

## Intent

This spec defines the observable behavior, implementation constraints, and integration coverage of the Dashboard, the one cross-project surface carrying the intent ledger ([DR-035](../decisions/035-intent-ledger.md)): a two-band attention queue over a band of the sessions running unattended and per-project ledger groups.
Every visible state derives deterministically from stored intent rows, the session record stream, and review state persisted in the app store, and forge data flows only through the forge adapter.
Integration coverage drives fixture intent rows, record streams, persisted store state, and stubbed forge adapters through the core and asserts the derived Dashboard state, so that attention bands, intent-state derivation, capture, sources, history paging, and empty states are verified end to end rather than per unit.

## External Behavior

### Attention Queue

#### dashboard-1

While at least one attention entry derives across the registered projects' intents and sessions [[dashboard-10](#dashboard-10)], the Dashboard shall display an attention queue as its topmost section, in two bands:

| Band | Entries |
| --- | --- |
| Interrupted | one entry per interrupted intent, leading with the intent's title and showing its project, session, and interruption reason — question, permission, or failure — with a one-line summary, the unacknowledged failure in the red chase tone ([DR-029](../decisions/029-session-history-home.md)) |
| Finished | one entry per finished intent awaiting a verdict, leading with the intent's title and showing its project, session, and the run's stats [[dashboard-35](#dashboard-35)] with review rounds foremost |

- A project's current conversation [[core-service-93](core-service.md#core-service-93)] serving no intent stands in with session-level entries: its question, permission, and failure conditions — the same conditions, holding outside any intent's turn range — join the interrupted band, and at most one turn-to-review entry per session, for a finished Boss turn later than the session's persisted last-viewed marker, joins the finished band ([DR-051](../decisions/051-runtime-held-for-a-turn.md)).
- An entry's title owns its row's slack; the project name truncates at 10rem with the full name in its title, and in a row narrower than 28rem the age hides, the project name too below 20rem ([DR-041](../decisions/041-chrome-that-fits.md)).

#### dashboard-2

While the attention queue contains two or more entries, the Dashboard shall order the interrupted band entirely before the finished band, and order entries within each band longest waiting first, by the onset time of the condition each entry derives from.

#### dashboard-3

When the user activates an attention entry, the Dashboard shall open the entry's session focused at the entry's place:

| Entry | Place |
| --- | --- |
| Interrupted — question | the pending question bubble |
| Interrupted — permission | the originating player's pending request |
| Interrupted — failure | the failure record |
| Finished intent | the end of the intent's final turn |
| Session turn to review | the end of the finished turn |

#### dashboard-4

While an attention entry is displayed, when its clearing condition arrives, the Dashboard shall remove that entry without any user action on the Dashboard itself — and viewing alone never clears an intent entry:

| Entry | Clears on |
| --- | --- |
| Interrupted intent | its interruption resolving [[dashboard-10](#dashboard-10)], or a verdict closing the intent |
| Finished intent | a verdict — Confirm or Drop — closing the intent |
| Session question | the next Boss turn starting in the session |
| Session permission | the request being decided, or its turn ending |
| Session failure | the next Boss turn starting in the session, or another conversation becoming the project's current one [[core-service-93](core-service.md#core-service-93)] |
| Session turn to review | the session's persisted last-viewed marker advancing past the turn |

- Resolving one entry removes no other entry.
- A verdict taken on the Dashboard hands focus on as its entry leaves: to the entry now at its place, else the last entry, else the all-clear's Start — never to the page body ([DR-010](../decisions/010-interface-craft.md) §6).

### Attention Badge

#### dashboard-9

The Dashboard shall publish an attention count equal to the number of entries in the attention queue, from the one ledger fold [[dashboard-10](#dashboard-10)], for consumers such as the sidebar's Dashboard badge and the desktop shell's dock badge ([DR-002](../decisions/002-desktop-app-architecture.md)):

- When the queue changes, the published count updates to the new queue size.

### Running Band

#### dashboard-50

While a project's live session holds a turn in flight and no attention entry for its current work stands [[dashboard-1](#dashboard-1)], the Dashboard shall list that session in a Running band between the attention queue and the project groups, one row per session in the projects' fixed sidebar order:

| Row part | Content |
| --- | --- |
| Project | the session's project name |
| Title | the session's own words — its first Boss turn, as the sidebar names it, and a plain stand-in while it has none |
| Doing | its human-readable engagement state label in the Now band's vocabulary [[dashboard-28](#dashboard-28)] — "deciding" or "working" while a turn is active with no leaf state — with the running player named beside it and the turn's elapsed span |

- activating a row opens that session;
- an attention entry for the current work takes its row out of the band, the summons standing in the queue instead [[dashboard-1](#dashboard-1)], and the turn ending takes it out too [[dashboard-4](#dashboard-4)]; an older intent awaiting its verdict keeps its attention entry without hiding the newer running intent ([DR-055](../decisions/055-queue-advancement.md));
- the project filter hides the other projects' rows, changing nothing derived [[dashboard-32](#dashboard-32)];
- the band keeps its place while empty, carrying its note there [[dashboard-8](#dashboard-8)].

### Project Groups

#### dashboard-26

While projects are registered, the Dashboard shall display one ledger group per project below the attention queue and its Running band [[dashboard-50](#dashboard-50)], in the projects' fixed sidebar order, each group carrying four bands in order: History [[dashboard-27](#dashboard-27)], Now [[dashboard-28](#dashboard-28)], Up next [[dashboard-29](#dashboard-29)], and Sources [[dashboard-20](#dashboard-20)].

#### dashboard-27

Where a project has done work — intents closed after a turn of theirs ended finished, and finished intent records in its specs tree [[dashboard-24](#dashboard-24)] — the group's History band shall list it as one timeline newest first, every loaded row inside a frame eight rows tall by default that scrolls when the rows exceed it, with an "Older…" control at the end of the scrolled list that fetches the next intent page ([DR-038](../decisions/038-history-is-done-work.md)):

| Row | Rendering |
| --- | --- |
| an intent closed done | a check before its title |
| an intent closed done whose source labels include a bug label | its title struck through under a red "bug" tag, no check |
| an intent closed dropped | a quiet "dropped" tag, the row dimmed, never struck |
| a finished record | a check before its record row [[dashboard-40](#dashboard-40)]; a "superseded" tag after the title, the row dimmed and no check, where the status classifies so |

- an intent closed before any turn of it ended finished never lists — it left the queue without a trace;
- an intent row carries a remove control — named "Remove ⟨title⟩ from history", revealed on hover and on focus within the row, reachable by Tab regardless — which asks the inline confirm in the row's place, "Remove this intent from history?" with Remove and Keep ([DR-010](../decisions/010-interface-craft.md) §4): Keep and Escape back out to the control, Remove retires the intent from the ledger [[core-service-79](core-service.md#core-service-79)] so the row leaves at once and focus lands on the next intent row's control, or on the band where none follows ([DR-010](../decisions/010-interface-craft.md) §6);
- a record row carries no such control — a file in the specs tree is not the ledger's to remove;
- a finished record already named by a closed intent's provenance lists once, as that intent;
- a record orders by the date its status line carries ("Done (2026-09-02)"), else by its file's last change; an intent by its close time; and each row shows that time as an age with the absolute moment in its tooltip;
- every row is one frame unit tall, so the frame's rows fill it exactly and the group's height never grows past it, however many pages load;
- where the rows and the control exceed the frame, its cut edges are drawn and the frame itself takes keyboard focus, so it scrolls by keyboard as well as by tabbing through its rows to the control;
- the frame's bottom edge carries the house's grip turned horizontal ([DR-030](../decisions/030-workspace-chrome.md)) — dragged, or moved a row per arrow key while focused, it sets the frame between four and twenty-four rows, a double-click restores the eight, and the height is remembered for this project's group across launches;
- the grip stands only while the rows and the control exceed the frame — a frame they fit has nothing to page through, so it takes their height and shows no edge to pull;
- the control stands only while unfetched rows wait, and reads "Loading…" while a page is in flight.

#### dashboard-28

While the project has a current conversation [[core-service-93](core-service.md#core-service-93)], the group's Now band shall show that session's status mark, its active playbook once a run draws one (nothing in its place before), human-readable engagement state label — tinted by the state's tone, with the raw state id in the tooltip, reading "deciding" or "working" rather than "idle" while a turn is active with no leaf state [[run-view-59](run-view.md#run-view-59)] ([DR-010](../decisions/010-interface-craft.md) §2) — and the session's start as an age ("started 3m ago") with the absolute moment in its tooltip, together with the open intent the session serves, or the latest Boss turn's text for a session serving no intent:

- the band updates as session records arrive, without a manual refresh;
- the served intent carries Drop beside the session row [[dashboard-41](#dashboard-41)];
- the text owns the row's slack; in a row narrower than 28rem the start age hides, the playbook name too below 20rem, the mark and the state label staying ([DR-041](../decisions/041-chrome-that-fits.md));
- while the project has no current conversation, the band stays quiet with its empty-state note [[dashboard-8](#dashboard-8)] ([DR-051](../decisions/051-runtime-held-for-a-turn.md)).

#### dashboard-41

While the Now band shows the open intent the session serves [[dashboard-28](#dashboard-28)], the band shall carry Drop beside the session row, which — behind an inline confirm, Drop or Keep, since work is underway ([DR-010](../decisions/010-interface-craft.md) §4) — closes that intent dropped while the session keeps its turn:

- the outcome — the drop, or the refusal with its reason — announces in a status line lasting six seconds, and focus returns to the control, or to the session row once the control has left with the intent ([DR-010](../decisions/010-interface-craft.md) §6);
- the dropped intent lists in History once the turn it was dropped from ends finished [[dashboard-27](#dashboard-27)].

#### dashboard-29

The group's Up next band shall list the project's queued intents in rank order, ending in an inline add row that captures a new queued intent, with the head unblocked intent emphasized as the project's next and carrying Start:

- a blocked intent — one whose after-link names a still-open intent [[dashboard-10](#dashboard-10)] — stays visible at its place with "after ⟨title⟩", the predecessor's project named when it lives in another project, its Start disabled with the reason ([DR-026](../decisions/026-data-graphics-craft.md) §2), and is never presented as next;
- reorder works by drag — the grip at the row's left is the affordance — by keyboard (Alt+↑/↓ on the focused row), and by the row menu's Move up and Move down, which take the same step, are disabled at the queue's ends, and name the shortcut; a reorder changes only the queue's rank order;
- each row's actions live in a ⋯ menu that follows the house popover idiom ([DR-010](../decisions/010-interface-craft.md) §6) — focus moves into it on open and returns to the trigger on close, Escape and an outside click close it, at most one row menu is open — offering Move up, Move down, Edit text, Remove, and, for a sourced intent, a provenance action named after what it opens: "Issue #N" or "PR #N" opening the page, the record row [[dashboard-40](#dashboard-40)] opening the record, "Session" opening the capturing session;
- Remove acts on the click with no confirmation and leaves no history ([DR-038](../decisions/038-history-is-done-work.md)), then a status line — "Removed “⟨title⟩” — Undo", lasting six seconds beyond the last moment its control holds focus, which it takes from a keyboard-driven removal alone — re-queues the same text and provenance at the row's former place; a pointer removal leaves the pointer where it is, so the line lapses on schedule and never stands as a prompt.

### Record Rows

#### dashboard-40

Where a band or menu of the Dashboard lists a spec record, the row shall present as the one record row — the record's identifier as the chip the Specs outline's package rows wear [[spec-view-2](spec-view.md#spec-view-2)], its title truncated to one line, a hover background and a pointer over the whole row, named as an opener ("Open IR-N") — and activating it opens that record in the project's Specs surface's records reader [[spec-view-7](spec-view.md#spec-view-7)] with the row's surface, the Dashboard or the project's Overview, as the reader's origin [[spec-view-57](spec-view.md#spec-view-57)]:

- the brand-coloured underline link stays reserved for what leaves the app — an issue or pull-request page [[dashboard-6](#dashboard-6)] — so a record, which opens in place, never wears it ([DR-013](../decisions/013-sublang-brand.md));
- the origin's control is the row itself, except where the row leaves the surface with its activation: a row menu's record item names the menu's trigger, and an Open records row names the Sources band's summary line, since the band comes back on its first tab with that row no longer drawn [[dashboard-20](#dashboard-20)].

### Capture

#### dashboard-30

Where a Sources row names an issue, pull request, or open intent record with no open intent sourced from that artifact, the row shall carry a Queue control that captures a queued intent for the project with editable seeded text and the source's URL and labels kept as provenance ([DR-038](../decisions/038-history-is-done-work.md)):

| Source | First line |
| --- | --- |
| Issue #N | `Address #N: <title>` |
| Pull request #N | `Review PR #N: <title>` |
| Intent record IR-N | `Resume IR-<N>: <title>` |

- an issue seed adds a paragraph after a blank line: ``Read the issue and comments. Work on a new branch from the current default-branch commit, implement the requested change, and run relevant checks. Push the branch and open a PR against the default branch with a summary, test results, and `Closes #N` in its description so merging it closes the issue.`` ([DR-054](../decisions/054-issue-intent-delivery.md));
- issue and pull-request seeds end with the canonical source URL on its own line, separated from an issue's instruction paragraph by a blank line;
- a row whose source artifact already has an open intent shows that intent's derived state in place of the control, and regains the control when that intent closes.

#### dashboard-31

When an intent is captured from any Dashboard gesture — a Queue control or the inline add row — the Up next band shall reveal the new row and briefly highlight it where it landed.

### Sources

#### dashboard-20

While a project group renders, the group's Sources band shall present three tabs — Issues [[dashboard-6](#dashboard-6)], PRs [[dashboard-6](#dashboard-6)], and Open records [[dashboard-24](#dashboard-24)], each paginated in place — under a one-line summary of the issue, pull-request, and open-record counts with the age of the data, which folds the band to itself and unfolds it again:

- the band stands unfolded wherever a group first draws it, so the tabs are read rather than discovered, and a fold is the project's own — kept while the app runs, never on disk, and the same one the Dashboard's group and the project's Overview [[dashboard-26](#dashboard-26)] read;
- issue and pull-request rows carry their forge labels as tags, which yield with the row [[forge-work-lists-1](forge-work-lists.md#forge-work-lists-1)];
- while GitHub is not connected — no binding, or the adapter not ready — the summary says so in place of the issue and pull-request counts, so zero never reads as an empty tracker; while the project's forge state has not been read yet, the summary and the guidance read as loading, never as not connected;
- folding, switching tabs, and paging are visibility-only and change no ledger state.

#### dashboard-6

Where a project is bound to a forge repository and the forge adapter ([DR-006](../decisions/006-projects-and-forge.md)) reports ready, the group's Sources band shall carry the project's open issues and open pull requests in the one selection and representation the Repo tab shares [[forge-work-lists-1](forge-work-lists.md#forge-work-lists-1)]:

- each row shows its title and number, and activating the title opens its canonical forge URL in the external browser;
- the band shows the age of its data and refreshes when the user triggers a manual refresh [[dashboard-14](#dashboard-14)].

#### dashboard-24

Where a project's `specs/` tree lists intent records [[spec-view-14](spec-view.md#spec-view-14)], the group's Sources band shall carry the project's open records — an intent record is work to finish, not spec law ([DR-027](../decisions/027-linked-views-contract.md)) — listing only records the records read classifies as open [[spec-view-14](spec-view.md#spec-view-14)] ([DR-038](../decisions/038-history-is-done-work.md)):

- each row is the record row [[dashboard-40](#dashboard-40)];
- a record classified finished does not list here — it lists in History [[dashboard-27](#dashboard-27)] — so every record lands in exactly one band;
- a project whose tree lists no open records counts zero open records in the collapsed line.

### Project Filter

#### dashboard-32

When the user selects a project filter, the Dashboard shall show only that project's attention entries and ledger group until the filter is cleared, as pure visibility in the linked-views ghost grammar ([DR-027](../decisions/027-linked-views-contract.md)):

- no derived state, rank, or persisted data changes, and the published attention count [[dashboard-9](#dashboard-9)] stays the unfiltered queue's size.

### Empty States

#### dashboard-8

While a Dashboard section or band has no content, the Dashboard shall display guidance in place of that content, and shall not render it blank:

| Section | Empty condition | Guidance |
| --- | --- | --- |
| Attention queue | no entry, with the ledger read | all-clear copy naming the globally next unblocked queue head — first by sidebar order — with Start, or plain all-clear copy when no unblocked head exists |
| Running | no live session holds a turn in flight unattended by the queue [[dashboard-50](#dashboard-50)] | a quiet note that nothing is running |
| Project groups | no registered project | how to register a project, with a navigation control to the Workspace |
| History | no done work, once the first history page has answered | a note that nothing is done here yet — "Loading…" until then |
| Now | no current conversation [[core-service-93](core-service.md#core-service-93)] | a quiet idle note |
| Up next | no queued intent | the inline add row [[dashboard-29](#dashboard-29)] with capture guidance |
| Sources | no forge binding, or forge adapter not ready | the GitHub setup guidance naming the unmet condition [[projects-7](projects.md#projects-7)] in place ([DR-006](../decisions/006-projects-and-forge.md)) |

- until the ledger has been read, the attention queue and each Up next band show a quiet loading note in place of their empty-state copy, and the all-clear never renders unread;
- while a ledger read has failed, the failure strip with its Retry stands alone in the attention section — no all-clear, no loading note — and the Up next band names the failure with a Retry of its own.

### No Takeover

#### dashboard-21

While no project is registered, the Dashboard shall still render the attention queue and the projects area with their empty-state guidance [[dashboard-8](#dashboard-8)] and shall not replace the surface with a welcome takeover; first-run onboarding belongs to the Captain home as the single onboarding narrative ([DR-010](../decisions/010-interface-craft.md) §1).

### Surface Fit

#### dashboard-47

The Dashboard shall scroll its queue and its groups inside its own box, which fills the surface it is given and never grows past it, however many projects are registered ([DR-041](../decisions/041-chrome-that-fits.md)):

- that box and the History frame [[dashboard-27](#dashboard-27)] inside it are positioned boxes, so the screen-reader marks their rows carry are contained by the box they scroll in rather than being carried by the page;
- the group carries the same boxes wherever it is drawn [[dashboard-26](#dashboard-26)].

## Internal Behavior

### Ledger Derivation

#### dashboard-10

Where the core derives ledger and attention state, the derivation shall be one deterministic fold over the stored intent rows, the session record stream, and the review state persisted in the app store — the per-session last-viewed turn markers — with no stored state column: identical inputs yield identical derived states and an identical attention set, independent of record arrival order, and every consumer reads this one fold.

Each intent's state derives exactly as follows, over its turn range [[dashboard-33](#dashboard-33)]:

| State | Holds while |
| --- | --- |
| Queued | not closed and not bound: never dispatched, or released [[dashboard-34](#dashboard-34)] |
| Blocked (a Queued sub-condition) | its after-link names an intent that is still open; the block lifts by derivation when the predecessor closes |
| Working | bound, and the latest turn in its range is active |
| Interrupted — question | bound, not closed, captain telemetry `playbook.fsm.state` reached `awaitBossReply` in its range with no later report of that machine leaving it — another machine's state report, the Captain's own included, leaves the question standing — and no later Boss turn has started in the session |
| Interrupted — permission | bound, not closed, a player event in its range carried `permission_request` with no later record for that player in the same turn, and the turn has not ended |
| Interrupted — failure | bound, not closed, a `runtime_error` record — or a turn whose engagement settled failed — lies in its range, and no later Boss turn has started in the session; the Boss's next turn acknowledges it, and a verdict also clears it |
| Finished | bound, not closed, not interrupted, no turn in its range active, and a turn in its range ended finished — an aborted follow-up does not unseat a standing finish |
| Done / Dropped | its close verdict is recorded, done requiring a Finished intent and dropped legal on any open one |

- an intent a remove act retired [[core-service-79](core-service.md#core-service-79)] is absent from every state above: no History row, no source artifact held, no attention entry, and no band lists it ([DR-038](../decisions/038-history-is-done-work.md));
- the fold produces no attention entry from records with `hidden` visibility ([DR-003](../decisions/003-runtime-reuse.md));
- where several rows hold at once, the fold ranks failure, then permission, then working, then question, then finished — a standing summons is never masked by the running mark;
- the per-project next is the first queued, unblocked intent in rank order;
- a consumer reading the fold over the protocol applies replies in request order — an older read's reply landing after a newer one's is discarded — so a stale fold never overwrites a fresh one.

#### dashboard-33

Where turns attribute to intents, an intent's turn range shall run from its dispatch turn, inclusive, up to but not including the next turn in that session that is another intent's dispatch turn:

- the newest open dispatched intent owns subsequent turns in its session, so a follow-up Boss turn returns it to Working while elder intents keep their own outcomes;
- an intent is bound while its dispatch turn has started and stands unreleased [[dashboard-34](#dashboard-34)].

#### dashboard-34

While an intent's dispatch turn ended aborted, or its session stopped before the dispatch turn finished, the fold shall derive that intent released — Queued again — with nothing written:

- the dispatch stamps remain as history, and a later dispatch re-writes them;
- the row keeps its rank, and its text is editable again.

#### dashboard-35

Where an intent's attention entry carries run stats, the fold shall compute them from the intent's turn range [[dashboard-33](#dashboard-33)] alone: review rounds as the count of player prompts whose stored role stamp is reviewer ([DR-032](../decisions/032-session-players.md)), the turn count of the range, and the elapsed time from dispatch to the range's last turn end:

- review rounds are omitted when zero.

#### dashboard-11

While the app store's intent rows, record history, and review state are intact, when the core restarts, the fold shall produce, from persisted state alone, the same derived intent states and the same attention set that were live before the restart.

### Data Sources

#### dashboard-12

Where Dashboard state is assembled, the dashboard read model shall source live-session state — attention conditions, engagement state ids, the Now band's session facts — from the in-process record bus, and durable state — intent rows, closed-intent history, review markers — from the app store ([DR-036](../decisions/036-file-state-store.md)):

- It does not query the embedded runtime directly, and it does not reach a forge except through the forge adapter ([DR-006](../decisions/006-projects-and-forge.md)).

### Forge List Caching

#### dashboard-14

Where the Sources band's issue and pull-request tabs are served, the dashboard read model shall serve them from a per-project cache persisted in the app store and refreshed through the forge adapter ([DR-006](../decisions/006-projects-and-forge.md)):

- While the Dashboard is displayed, a cache entry older than 10 minutes triggers a background refresh; a fresher entry triggers no adapter call.
- When the user triggers a manual refresh, the read model calls the forge adapter regardless of cache age.
- When an adapter call fails, the read model retains the last cached entries and surfaces the failure together with the data age; it does not clear cached lists on failure.

## Verification

### Attention Coverage

#### dashboard-15

Where fixture intent rows and a fixture record stream span two projects — one intent standing interrupted on a question, one on a `runtime_error`, one finished with reviewer-stamped prompt records, plus an un-ledgered session holding a `permission_request` and a finished turn past its viewed marker, a second un-ledgered session running a turn with nothing to answer, and a `hidden`-visibility record — when Dashboard state is derived, the test suite shall assert that the interrupted band holds the question, failure, and session permission entries while the finished band holds the finished intent and the turn-to-review stand-in [[dashboard-1](#dashboard-1)], that the interrupted band precedes the finished band with longest waiting first within each [[dashboard-2](#dashboard-2)], that the finished entry carries stats whose review rounds equal the reviewer-stamped prompt count [[dashboard-1](#dashboard-1)] [[dashboard-35](#dashboard-35)], that activating the question entry opens its session at the pending question [[dashboard-3](#dashboard-3)], that the hidden record produced no entry [[dashboard-10](#dashboard-10)], that project groups render in sidebar order with the four bands [[dashboard-26](#dashboard-26)], that the Running band lists the session running with nothing to answer — its project, title, and state label — and opens it when activated, while the session summoned into the queue stays out of the band for a question, permission, or failure even with a missing or stale transcript, with session-summary activity controlling whether the row stands and an older finished intent retaining Confirm [[dashboard-50](#dashboard-50)], and that selecting a project filter leaves only that project's entries, running rows, and group visible with the published count unchanged [[dashboard-32](#dashboard-32)] [[dashboard-50](#dashboard-50)].

#### dashboard-16

While the attention queue holds interrupted and finished entries, when the fixture stream continues with a Boss turn in the question intent's session, a viewed-marker advance past the un-ledgered finished turn, and a verdict on the finished intent, the test suite shall assert that the Boss turn cleared the question entry even when dispatching another intent before any machine transition [[dashboard-4](#dashboard-4)], that the marker advance cleared the turn-to-review stand-in and no intent entry [[dashboard-4](#dashboard-4)], that the verdict cleared the finished entry and handed focus to the entry at its place, then to the all-clear's Start [[dashboard-4](#dashboard-4)], and that the published attention count tracked each removal [[dashboard-9](#dashboard-9)].

#### dashboard-17

Where fixture intent rows, records, and review state are persisted to the app store, when the fold is re-run from persisted state alone, as after a core restart, the test suite shall assert that the derived intent states and attention set equal those derived live from the same inputs [[dashboard-11](#dashboard-11)], with the fold reading only the store and the record bus [[dashboard-12](#dashboard-12)].

### Ledger Coverage

#### dashboard-36

Where a fixture project holds a queue of three intents, the second after-linked to the first, when the fixture stream dispatches the first, runs a follow-up Boss turn, dispatches the third into a turn that aborts, then finishes the first and closes it done, the test suite shall assert each derived state in sequence: Working on dispatch and again on the follow-up owned by the newest open intent [[dashboard-10](#dashboard-10)] [[dashboard-33](#dashboard-33)], the aborted dispatch releasing the third to Queued at its kept rank with its stamps intact and text editable [[dashboard-34](#dashboard-34)], Finished when its last turn ends finished [[dashboard-10](#dashboard-10)], the after-linked second blocked and never offered as next until the first closes, then unblocked as the project's next [[dashboard-10](#dashboard-10)] [[dashboard-29](#dashboard-29)], a reorder by keyboard and by the row menu's Move up and Move down — disabled at the ends — yielding the new rank order [[dashboard-29](#dashboard-29)], the row menu opening with focus inside and closing on Escape and on an outside click with focus back on its trigger, one menu open at a time [[dashboard-29](#dashboard-29)], and a Remove followed by Undo re-queuing the same text and provenance at the row's former place, the status line outlasting six seconds only while its control holds the focus a keyboard removal gave it, a pointer removal's line lapsing on schedule with focus untouched [[dashboard-29](#dashboard-29)], and each sourced row's provenance item named after what it opens, the record's drawn as the record row [[dashboard-29](#dashboard-29)] [[dashboard-40](#dashboard-40)].

#### dashboard-42

Where two ledger reads overlap and the older one's reply lands last, the test suite shall assert that the newer fold stays in place and the Up next band lists its queue, the older reply discarded [[dashboard-10](#dashboard-10)].

### Capture Coverage

#### dashboard-37

Where a fixture Sources row lists issue #7, when the user activates its Queue control, the test suite shall assert that a queued intent is captured with the exact editable issue seed and provenance [[dashboard-30](#dashboard-30)], that the Up next band reveals and briefly highlights the new row [[dashboard-31](#dashboard-31)], that the issue row shows the open intent's derived state in place of its Queue control [[dashboard-30](#dashboard-30)], and that the row regains the control when the intent closes [[dashboard-30](#dashboard-30)].

### Sources Coverage

#### dashboard-19

Where a stubbed forge adapter returns fixture open issues and pull requests with labels for two bound projects, when the group's Sources band is displayed, the test suite shall assert that the band stands unfolded under a summary line showing the counts and data age [[dashboard-20](#dashboard-20)], that its paginated Issues and PRs tabs render their rows' titles, numbers, and forge labels [[dashboard-20](#dashboard-20)] [[dashboard-6](#dashboard-6)], that the line folds one project's band and unfolds it again while the other's stands open, with the fold surviving a redraw on either surface [[dashboard-20](#dashboard-20)] [[dashboard-26](#dashboard-26)], that a manual refresh invokes the stub again [[dashboard-14](#dashboard-14)], and that a stub failure on refresh leaves the previously served lists in place with the failure and data age surfaced [[dashboard-14](#dashboard-14)].

#### dashboard-25

Where a fixture project's `specs/` tree lists one intent record whose status reads Done and one unfinished record, the test suite shall assert that the Open records tab lists only the unfinished record [[dashboard-24](#dashboard-24)] as the record row — chip, title, pointer, no brand link — that activating it opens the record in the Specs surface's records reader [[dashboard-40](#dashboard-40)], and that its Queue control seeds `Resume IR-<N>: <title>` [[dashboard-30](#dashboard-30)].

### History Coverage

#### dashboard-38

Where a fixture project holds more worked closed intents than one history page, one done intent from a bug-labeled issue, one dropped intent that never ran, and a specs tree with finished and open records, the test suite shall assert the History contract of [[dashboard-27](#dashboard-27)]: rows list newest first with the check, bug, dropped, and record renderings — each record as the record row that opens the reader [[dashboard-40](#dashboard-40)] — a dated status line placing its record before an undated newer file, and their ages with the absolute moment in the tooltip, the never-run drop is absent, the open record is absent, the band reads "Loading…" until the first page answers, every loaded row lists inside the frame, which draws its cut edges and takes focus only past eight rows, and the "Older…" control at the frame's end stands only while a page waits and fetches and appends the older intent page with the cursor of the last served row, and the frame's grip — absent while eight rows hold everything — sets the frame between four and twenty-four rows by arrow key, restores the eight on a double-click, and leaves that height remembered for the project's group [[dashboard-27](#dashboard-27)], and each intent row's remove control — the record row carrying none — opens the confirm whose Keep backs out to the control with nothing sent, while Remove retires the intent, drops its row at once, and hands focus to the next row's control [[dashboard-27](#dashboard-27)].

### Empty-State Coverage

#### dashboard-22

Where Dashboard state is derived across the empty conditions, the test suite shall assert the guidance of [[dashboard-8](#dashboard-8)] case by case:

- with no registered project, the attention queue and projects area render their empty-state guidance with an activatable navigation control to the Workspace [[dashboard-8](#dashboard-8)], and no welcome takeover replaces the surface [[dashboard-21](#dashboard-21)];
- with a registered project whose ledger is empty, each band renders its guidance in place, the Sources line reading as loading until the project's forge state has been read and as not connected after [[dashboard-8](#dashboard-8)] [[dashboard-20](#dashboard-20)];
- with one queued unblocked intent and no attention entry, the all-clear names that intent with Start [[dashboard-8](#dashboard-8)];
- before the ledger is read, the attention queue and the Up next band show their loading notes and no all-clear; with a failed read, the failure strip with Retry stands alone, and Retry reads the ledger again [[dashboard-8](#dashboard-8)].

### Now-Band Coverage

#### dashboard-23

Where a fixture stream holds a live session serving an open intent and carrying an engagement state id, the test suite shall assert that the Now band renders the session's status mark, playbook — nothing in its place while no run has drawn one — human-readable state label with the raw state id in the tooltip, reading "working" for an active turn with no leaf state while a player runs, the start as an age with the absolute moment in its tooltip, and the open intent's title [[dashboard-28](#dashboard-28)], that session-summary activity governs both the mark and the label on Dashboard and Project Overview even with missing or stale transcripts [[dashboard-28](#dashboard-28)] [[dashboard-26](#dashboard-26)], that the Drop beside it asks the inline confirm — Keep returning focus to the control, Drop closing the intent dropped over the protocol with the outcome announced, the control gone, and focus on the session row [[dashboard-41](#dashboard-41)] — and that a project with no live session renders its Now band quiet [[dashboard-28](#dashboard-28)] [[dashboard-8](#dashboard-8)].

### Browser Journeys

#### dashboard-39

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell with the demo project registered and the scripted Captain, when the journey works the ledger through the page, the test suite shall assert:

- every empty band carries its guidance, and the Sources line reads collapsed with the seeded example's open records behind it, each with a Queue control [[dashboard-8](#dashboard-8)] [[dashboard-20](#dashboard-20)] [[dashboard-24](#dashboard-24)] [[dashboard-30](#dashboard-30)];
- the inline add row captures a queued intent, revealing its row and clearing the field, and the all-clear names it next [[dashboard-29](#dashboard-29)] [[dashboard-31](#dashboard-31)];
- a queued intent removed before any turn leaves History untouched [[dashboard-27](#dashboard-27)];
- queuing from a record row lands a row wearing the record's identifier [[dashboard-30](#dashboard-30)] [[dashboard-31](#dashboard-31)];
- while the dispatched intent's session runs, the Now band shows it [[dashboard-28](#dashboard-28)];
- once its turn ends finished, the attention queue lists the finished entry with Confirm and the count badge reads one [[dashboard-1](#dashboard-1)] [[dashboard-9](#dashboard-9)];
- Confirm removes the entry, the badge clears, and History lists the intent as done [[dashboard-4](#dashboard-4)] [[dashboard-27](#dashboard-27)];
- in the row menu, Move down changes the queue's order, Escape closes the menu with focus back on its trigger, and Remove then Undo restores the row at its place [[dashboard-29](#dashboard-29)];
- an intent dropped from its running session leaves the Now band showing the session serving none, with no Drop beside it, and lists in History as dropped once that turn ends finished, no verdict owed [[dashboard-28](#dashboard-28)] [[dashboard-27](#dashboard-27)].

- in the row menu, Move down changes the queue's order, Escape closes the menu with focus back on its trigger, and Remove then Undo restores the row at its place [[dashboard-29](#dashboard-29)].

#### dashboard-43

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell with the demo project registered and holding more closed work than one History page, a queued intent with a second queued behind it, and ten further projects each holding a live session parked on a player question, when the journey shows the Dashboard and the project's Overview tab at the widths 320, 480, 640, 800, 1024, and 1280 pixels, each at 800 and 400 pixels tall, with the sidebar collapsed and, from 480 pixels, open ([DR-041](../decisions/041-chrome-that-fits.md)), the test suite shall assert fit through the page, naming every offending element: no element outside a sideways-scrolling canvas is wider than its box, the surface scrolls inside its own box with nothing positioned past the viewport uncontained [[dashboard-47](#dashboard-47)], within every list row and header no two visible siblings overlap and every child lies inside its parent [[dashboard-1](#dashboard-1)] [[dashboard-29](#dashboard-29)] [[dashboard-20](#dashboard-20)], and every control keeps its accessible name at every size [[dashboard-4](#dashboard-4)] [[dashboard-30](#dashboard-30)].

#### dashboard-44

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell with the demo project registered and more worked, closed intents in its state root than one intent page, when the journey shows the Dashboard and then the project's Overview tab, the test suite shall assert the History frame through the page: the first page's rows all list inside a frame exactly eight rows tall that scrolls, with "Older…" as its last item [[dashboard-27](#dashboard-27)]; "Older…" appends the next page while the frame's and the group's heights stay, the control leaving once nothing waits [[dashboard-27](#dashboard-27)]; every row is one frame unit tall [[dashboard-27](#dashboard-27)]; the frame takes keyboard focus and scrolls by key [[dashboard-27](#dashboard-27)]; and the Overview draws the same frame [[dashboard-26](#dashboard-26)] [[dashboard-27](#dashboard-27)].

#### dashboard-48

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell with the demo project registered and more worked, closed intents than the frame holds, when the journey drags the History frame's grip down by two rows and then reloads the page, the test suite shall assert the frame the reader set [[dashboard-27](#dashboard-27)]:

- the grip names itself, reports the frame's height in rows, and stands only while the rows run past the frame [[dashboard-27](#dashboard-27)];
- the drag leaves the frame exactly two rows taller, still scrolling its rows [[dashboard-27](#dashboard-27)];
- the reloaded page draws the frame at that height, chrome state being preference rather than project state [[dashboard-27](#dashboard-27)].

#### dashboard-51

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell with the demo project registered and the scripted Captain holding each call long enough for a turn to be watched, when the journey sends a task and shows the Dashboard, the test suite shall assert the Running band through the page:

- while the turn is in flight, the band lists one row naming the session's project, its title, and what it is doing [[dashboard-50](#dashboard-50)];
- an older intent awaiting confirmation in the same session retains its attention entry while the newer intent runs in this band [[dashboard-50](#dashboard-50)];
- activating that row opens the session [[dashboard-50](#dashboard-50)];
- once the turn ends, no row stands in the band, which reads its note in place [[dashboard-50](#dashboard-50)] [[dashboard-8](#dashboard-8)].

#### dashboard-52

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell with the demo project registered and worked, closed intents in its state root, when the journey removes one from History on the Dashboard, the test suite shall assert the removal through the page [[dashboard-27](#dashboard-27)]:

- the row's control opens the confirm, whose Keep leaves the row listed [[dashboard-27](#dashboard-27)];
- Remove drops that row from History while its neighbours stay, and the reloaded page still lists it nowhere [[dashboard-27](#dashboard-27)] [[dashboard-10](#dashboard-10)];
- the project's Overview tab draws the same row with the same control [[dashboard-26](#dashboard-26)] [[dashboard-27](#dashboard-27)].

#### dashboard-46

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell with the demo project registered and a finished intent record written into its specs tree, when the journey opens that record from a History row and activates the reader's Back, the test suite shall assert the round trip through the page:

- from the Dashboard, the History row lists the record and opens it in the Specs tab's records reader, whose Back control reads "← Back to Dashboard" [[dashboard-27](#dashboard-27)] [[dashboard-40](#dashboard-40)];
- Back shows the Dashboard with the project's group in view and the invoking row focused [[dashboard-40](#dashboard-40)];
- from the project's Overview tab, the same row opens the reader behind "← Back to Overview", and Back shows the Overview tab with the row focused [[dashboard-40](#dashboard-40)].

#### dashboard-49

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell with the demo project registered, a substitute forge adapter serving open issues that carry ordinary GitHub labels, and one of those issues captured as an intent standing behind another, when the journey shows the Dashboard's Sources rows at the 320-pixel viewport floor with the sidebar collapsed, the test suite shall assert through the page: the labelled row's every child lies inside the row with its label tags yielded and their words in the row's title [[dashboard-20](#dashboard-20)], the captured row wearing its intent's state where its Queue control stood [[dashboard-30](#dashboard-30)], and the Dashboard scrolling in neither direction [[dashboard-47](#dashboard-47)].
