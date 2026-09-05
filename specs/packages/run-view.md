<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# run-view: Run View

## Intent

This spec covers the project session run view — the Spex screen that renders one live playbook session — spanning its user-visible behavior, its implementation requirements, and its integration coverage.
The view presents a Captain pane, read-only player panes, and the single Boss composer.
Everything the view displays derives from the session record stream, which it renders exclusively from the WebSocket protocol that carries it, and the captain glyph vocabulary follows the embedded Playbook Captain shell.
Coverage replays recorded record-stream fixtures through that protocol, exercising the record-driven rendering contract without live agents.

## External Behavior

### Captain Pane

#### run-view-1

While a project session is live, when the session record stream delivers a captain status line or captain speech, the Captain pane shall append it in arrival order — preserving each status line's glyph, and rendering speech text as chat-style prose, visually distinct from glyph lines:

| Glyph | Line kind |
| --- | --- |
| ◇ | engagement start, stop, and finished status |
| ◆ | failure and await-Boss-reply notices |
| ▸ ⮕ ⤷ | playbook state-machine progress stream — absorbed by the machine card while its run's frame is open [[run-view-60](#run-view-60)] |

- a status line, a time separator [[run-view-41](#run-view-41)], and a question's sender line [[run-view-9](#run-view-9)] are system lines at the type scale's small step — 12px, left-aligned like the conversation, the glyph standing as an icon in a fixed slot before the words — never a smaller, centered, monospace whisper ([DR-010](../decisions/010-interface-craft.md) §8).

#### run-view-2

While a project session is live, when the session record stream delivers a failure, the Captain pane shall display one ◆ line carrying both the failure name and the failure message, so no delivered failure is left without a visible line:

- a failure identical to the line just before it, within the same turn, folds into that line as a visible count (×2, ×3, …) whose meaning is also in text — never suppressed, never merged with a different failure or across turns;
- the line speaks plain ([DR-010](../decisions/010-interface-craft.md) §2): a leading "Error:" and doubled periods are stripped, a known runtime message — a sign-in that expired, a rate limit, a timeout, an agent process that exited, a command not installed, an unknown adapter or player, a repository reconciliation that failed — reads as its plain phrase, and whenever the words changed the runtime's own text stays in the line's tooltip;
- while the Captain agent's adapter readiness reports not ready [[core-service-9](core-service.md#core-service-9)], each failure line carries a "Check agent readiness" link that opens Settings in place, its tooltip naming the unmet requirement.

### Player Panes

#### run-view-3

While a project session is live, when the session record stream delivers text or text deltas for a visible player, that player's pane shall render the accumulating message as formatted Markdown, appending each delta as it arrives rather than waiting for turn completion:

- A player pane is read-only — no text input, reply, or edit affordance — since Boss input happens only in the Boss composer [[run-view-8](#run-view-8)];
- rendered text wraps inside its pane — an unbroken token such as a long URL breaks anywhere rather than scrolling the pane sideways, in a player pane, a call's prompt, and the Captain thread's bubbles alike ([DR-041](../decisions/041-chrome-that-fits.md)) — and a code block wraps its long lines the same way, so nothing in a transcript scrolls sideways or traps the keyboard.

#### run-view-4

When the session record stream delivers a tool-use event for a visible player, that player's pane shall render it as a collapsed card labeled with the tool name and the subject read from the tool's own input, expanding on demand to the full input and, once delivered, the paired tool result:

| The tool input is | The card's subject is |
| --- | --- |
| a string | that string |
| an object holding a string at one of `command`, `file_path`, `path`, `pattern`, `url`, `query`, `prompt`, `description` | the first such value in that key order |
| anything else | nothing — the label is the tool name alone, never a guessed field |

- a subject is presented as one line — outer whitespace trimmed, inner whitespace runs collapsed to single spaces, elided where the card's width ends — so the collapsed card carries what the call acts on and never its payload;
- a command a runner wrapped as `<shell> -lc <command>` — a login-shell wrapper with its quoting — presents the inner command as it was typed, and a runner's wire name for its shell tool reads "shell" with the wire name in the label's tooltip, so the coder's rows read as commands whichever agent runs them;
- the expanded body prints each string-valued field — a command, a patch, an old and new string, a file's content, the result's text — verbatim under the field's name, and only a value that is not a string as JSON, every line wrapping inside the card so it never widens the pane;
- a delivered result's span shows in the app's one duration vocabulary — "<1s", "12s", "3m 12s" — never as raw milliseconds ([DR-010](../decisions/010-interface-craft.md) §2).

#### run-view-83

Where a rendered agent message carries a Markdown link — in a player pane [[run-view-3](#run-view-3)] or the Captain thread [[run-view-1](#run-view-1)] — the run view shall present it as a link only where the shell can open it [[app-shell-21](app-shell.md#app-shell-21)], presenting every other target as its own text with the target named in its tooltip:

- an agent cites a repo path or a spec item as freely as it cites a URL, and a citation nothing can open must not wear the affordance of one;
- a link opens outside the page — a new browsing context, with no referrer — so the served page never navigates away from the session.

#### run-view-5

When the session record stream delivers thinking content for a visible player, that player's pane shall render it collapsed by default, with an affordance that expands the full thinking text on demand.

#### run-view-6

When a player turn completes, that player's pane shall report the turn's usage by what the turn delivered, showing token totals only where the turn reported them and never a monetary figure ([DR-032](../decisions/032-session-players.md), [DR-044](../decisions/044-no-money-in-the-interface.md)):

| The turn reported | The pane shows |
| --- | --- |
| tokens | the turn's token totals, taken as given because they are inclusive of cached reads |
| a cost, with or without tokens | nothing for it — no amount in any currency, whatever its provenance |
| neither | no usage line — an unreported figure is silence, never a zero nobody measured |

### Pane Visibility

#### run-view-7

The run view shall show exactly one player pane per player in the session's bound roster, standing for the session's whole life ([DR-032](../decisions/032-session-players.md)):

- a pane is a player's lane, so it stands whether or not that player is engaged in the call now running, and a finished call's transcript stays where the reader last read it;
- the pane's header carries a collapse control, and a collapsed pane stands in its place as a rail [[run-view-116](#run-view-116)] that opens itself when its call opens [[run-view-117](#run-view-117)] — a folded lane is still a lane;
- the runtime's report of which players a call engages adds no pane and removes none — a lane the reader is following never leaves under them — and when a lane's call opens while its pane lies beyond the grid's visible edge, the grid scrolls just far enough to show that pane, side by side or stacked alike, so the working lane never hides behind idle ones;
- a roster with no players renders no player pane, and the Captain column then stands alone at the Captain home's reading width with no divider — a division with nothing on its far side reads as a pane that failed to load;
- the pane's header names the lane and, from its first call on, the role its latest call served [[run-view-79](#run-view-79)] — "coder · dev.coder" — with the player's model chip beside it, and a lane no call has reached yet reads "Idle until the playbook calls ⟨lane⟩";
- while the lane's call is open, the header carries "⟨role⟩ working · ⟨elapsed⟩" beside the running mark — the span since the call's prompt, ticking each second, hidden first in a narrow pane ([DR-041](../decisions/041-chrome-that-fits.md)) — so a minutes-long call never reads as a hang ([DR-010](../decisions/010-interface-craft.md) §5).

#### run-view-116

When the reader activates a player pane's collapse or expand control — an icon button labelled "Collapse ⟨lane⟩" in the pane's header, "Expand ⟨lane⟩" on the rail — the run view shall fold that lane to a rail, or unfold the rail to its pane, remembering the session's collapsed lanes while the app runs ([DR-030](../decisions/030-workspace-chrome.md): collapse never hides a duty):

- the rail is a column about 2.25rem wide at the pane's full height, holding the expand control, the lane's running mark while its call is open, and the lane's name read down its length — truncated with its whole in a tooltip rather than leaving the rail — and is exempt from the pane floor ([DR-041](../decisions/041-chrome-that-fits.md));
- the remaining panes share the freed width;
- focus lands on the rail's expand control after a collapse and on the pane's collapse control after an expand, never on the document body;
- the collapsed set is the session's own, kept across tab switches for the app's run and never persisted, so a new launch opens every lane.

#### run-view-117

While a lane's pane is collapsed, when that lane's call opens, the run view shall unfold the rail to its pane in place — moving focus only when it sat on the rail's control, then to the pane's collapse control — so the working player never hides in a rail ([DR-010](../decisions/010-interface-craft.md) §5):

- the rule holds whether or not the session's tab is shown when the call opens;
- a lane folded while its call is already open stays folded, its rail wearing the running mark, until its next call opens.

#### run-view-79

While a player pane holds a call the core resolved to a role [[core-service-36](core-service.md#core-service-36)], that call shall be labelled with its role where the call opens ([DR-032](../decisions/032-session-players.md)), so a lane several roles share reads as a sequence of calls rather than one voice:

- A call the core resolved no role for is labelled with none: the view invents no label.

### Boss Composer

#### run-view-8

The Boss composer shall accept free text and `/`-prefixed command text, be the only input control in the run view, and dispatch or queue each Boss submission by turn state:

- while no turn is active, a submission dispatches without queueing, the primary control reading "Send";
- while a turn is active, a submission queues with a visible queued indicator until the queued submission is dispatched, the primary control reading "Send next" ([DR-041](../decisions/041-chrome-that-fits.md));
- when the active turn ends, the queued submission dispatches;
- the primary control's tooltip names its keys — Enter sends, Shift+Enter adds a line — and, while a turn is active, opens by saying the message sends when this turn ends.

#### run-view-106

The Boss composer — on the Captain home and in a session alike — shall take one shape ([DR-041](../decisions/041-chrome-that-fits.md)):

| Part | Form |
| --- | --- |
| Field | on top at full width, one row when empty and never shorter whatever height the viewport reports, growing with its text to eight lines or two fifths of the viewport and scrolling past that, refitted whenever the viewport or the field's own box resizes — a divider dragged or a sidebar folded rewraps the draft with no window resize behind it — with no native resize grip |
| Caption | one line under the field reading "/ for playbooks · Enter sends", which an acknowledgment or the staged intent chip occupies instead of stacking above the box |
| Action row | beneath, wrapping: the secondary action at the left, then Abort while a turn runs, and the primary control last at the right |
| Placeholder | at most 24 characters — "Message the Captain…", "Reply to ⟨player⟩…" for a waiting question, "Sends after this turn…" while a turn runs, "Connecting…" without the core |
| Queued indicator | above the field, the queued submissions [[run-view-8](#run-view-8)] in their own positioned scrolling frame a few entries tall, kept at its end so the newest shows; the composer yields around it, so the field, the caption, and the action row keep their place at any queue length and the pane the composer sits in is never pushed out of the window |

#### run-view-9

While an engagement awaits a Boss reply, the run view shall present the waiting question as a first-class chat moment and route the next Boss submission to it:

- the Captain thread renders the question as a first-class incoming message bubble naming the asking player (one identity: the player's pane id), replacing — not duplicating — the runtime's status-line narration of the same question;
- a compact banner above the Boss composer names the waiting player without repeating the question;
- when the Boss submits, the Boss composer sends the submission as the reply to the waiting question — not as a new Boss prompt — and clears the banner;
- the question stands until the parked machine itself leaves its park — a state report of any other machine, the Captain's own controller machine included, never clears it.

### Turn Control

#### run-view-10

The run view shall provide an abort control bound to the active turn:

- while a turn is active, the abort control is presented; while no turn is active, it is hidden or disabled;
- when the abort control is activated, the run view requests abortion of the active turn;
- when the session record stream then delivers the turn-aborted record, the run view displays a visible aborted marker on the interrupted turn.

### Turn Summaries

#### run-view-11

When a turn completes, the run view shall show turn summaries exactly as the active playbook declares:

- a summary policy declared — the run view displays the turn summary produced for that turn;
- no summary policy declared — the run view shows no summary entry.

### Layout and Theme

#### run-view-12

The run view shall provide light and dark color themes and size the Captain and player panes from the shared configuration (see [DR-004](../decisions/004-config-and-persistence.md)):

- layout weights declared — the panes are sized proportionally to those weights;
- no layout configured — built-in default weights apply;
- a theme configured — the configured theme is selected;
- no theme configured — the view follows the OS appearance.

#### run-view-119

The app shell shall fill the window at every size, giving the surface it shows a box of the window's height that the surface scrolls its own content inside, so the page itself never scrolls and a window resized shorter or taller re-fits with no reload ([DR-041](../decisions/041-chrome-that-fits.md)):

- the Captain home [[run-view-25](#run-view-25)] and a session's panes [[run-view-107](#run-view-107)] fill that box and scroll inside it rather than growing it;
- every box that scrolls — a pane, the sidebar [[run-view-67](#run-view-67)], the tab strip [[run-view-48](#run-view-48)] — is a positioned box, so the screen-reader-only text and other positioned content it holds is contained by that box instead of being carried by the page.

### Session Start

#### run-view-25

Where no session tab is active, when the Workspace is shown, the run view shall present the Captain home: a chat thread opened by a Captain greeting, a chat composer, and the captain's adapter, model, and effort — with a lightning mark after them while the captain runs in fast mode, "fast mode" in its tooltip, as every agent chip and player label wears it ([DR-038](../decisions/038-history-is-done-work.md)) — with a gear control opening the in-place agent editor, per [DR-007](../decisions/007-conversational-session-start.md) and [DR-011](../decisions/011-project-workspace.md):

- the greeting names the current project and asks what to do with it, since the reader is already inside one and the question is the work, not the place, and says in one clause what a playbook is — a scripted workflow the AI players run — so the first sentence needs no glossary;
- with no project current, the greeting names the remedy the workspace actually has — picking one where projects exist, adding one where none do — never sending the reader to a sidebar holding nothing;
- with no project registered, the greeting itself carries the two ways in — a control opening the project palette [[run-view-42](#run-view-42)] and one seeding the Academy example through the same action the palette uses [[projects-27](projects.md#projects-27)] — acknowledging in place while it seeds and reporting a refusal in the thread;
- Project choice lives in the sidebar and palette, not in the composer row.

#### run-view-26

While the Captain home is shown, when the user submits composer text, the run view shall act by whether the workspace has a current project:

- a current project — the run view creates a session for that project, dispatches the text as the session's first Boss turn, and switches to the new session's tab;
- no project chosen — the workspace opens the project palette instead of dispatching, keeping the draft intact, and the draft equally survives a project arriving through the greeting's own controls [[run-view-25](#run-view-25)], so the text goes the moment there is somewhere to send it;
- the send control's tooltip says how to send — Enter, with Shift+Enter for a new line — and, with no project, what to do first, naming the palette's binding the platform's way [[run-view-49](#run-view-49)].

#### run-view-27

The run view shall make configured playbooks discoverable at the composer:

- when the user types `/` at the start of a composer, the run view shows the configured playbooks filtered by the typed prefix, each with its intent as the hint, and inserts the selected command into the composer without dispatching it;
- the Captain home shows highlighted playbooks as a quick start card that the user can dismiss, with the dismissal persisting across launches.

#### run-view-30

The run view shall present conversations in instant-messaging form:

- the user's submitted messages appear as their own chat bubbles in the Captain thread;
- Captain speech appears as counterpart bubbles;
- shell status lines appear as compact system lines between them.

### At-Hand Operations

#### run-view-32

When the user opens the captain identity's editor control (or another agent's editor control elsewhere in the run view), the run view shall show an anchored popover in place — offering the embedded runtime's adapters with their readiness, and editing the agent's model, its adapter's effort vocabulary, and permissions ([DR-019](../decisions/019-inline-agent-configuration.md)) — writing changes as a merge patch through the shared configuration's validated edit path per [DR-009](../decisions/009-at-hand-interaction.md), without leaving the current surface:

- the popover opens on the side of its anchor with the more room and takes at most what the window can show there, scrolling inside that bound, so it never lies past an edge the reader cannot scroll to and never grows the page ([DR-041](../decisions/041-chrome-that-fits.md)) — the Captain home's control sits at the foot of the surface, where the room above and below changes with the window's height;
- a window resized while the popover is open re-decides its side and its room.

#### run-view-33

When an ended session is opened [[run-view-68](#run-view-68)], the run view shall show a loading note while its stored transcript loads and, once it is shown, an ended notice whose "New session" control starts a new session for the same project — nothing the user produced becomes unreachable ([DR-009](../decisions/009-at-hand-interaction.md)):

- for a session the core lists as continuable ([DR-042](../decisions/042-sessions-continue.md)) the notice reads "Ended · a message continues it" above the enabled composer; otherwise it reads "Ended — this session can't be continued" in the composer's place;
- the notice wraps its control under its words when its pane is too narrow for both ([DR-041](../decisions/041-chrome-that-fits.md));
- when the transcript fails to load, the run view says so and offers a retry that reloads it — a failed load never presents as an empty run.

#### run-view-34

The run view shall keep cross-project attention and playbook creation at hand:

- while the Dashboard's published attention count [[dashboard-9](dashboard.md#dashboard-9)] is non-zero, the sidebar's Dashboard entry shows a badge with that count across all projects ([DR-029](../decisions/029-session-history-home.md)), surviving the sidebar's collapse [[run-view-71](#run-view-71)];
- while a non-current project needs a human, that project's sidebar row carries a dot in the most severe color [[run-view-67](#run-view-67)];
- the slash menu ends with a compile-a-new-playbook entry that opens the Playbooks surface's compile flow.

### Conversation Life (DR-010 §1/§3)

#### run-view-37

While a turn is active and the Captain is not streaming speech, the Captain thread shall show a working indicator naming what runs — "⟨role⟩ working · ⟨elapsed⟩" while any player runs, the roles of the running lanes' latest calls [[run-view-7](#run-view-7)] and the span since the earliest open call's prompt ticking each second, "Captain is thinking…" otherwise — so the thread is never inert mid-turn and a long call reports its progress ([DR-010](../decisions/010-interface-craft.md) §5).

#### run-view-38

A queued Boss submission shall never read as sent:

- queued submissions render as pending outgoing bubbles in full, each captioned "sends when this turn ends" and each individually removable by a control of full hit size [[run-view-50](#run-view-50)];
- while a turn is active, the composer placeholder reads "Sends after this turn…" — the caption's words, and the primary control's tooltip's [[run-view-8](#run-view-8)].

#### run-view-39

Composer drafts (per session and on the Captain home) shall survive switching tabs and surfaces, clearing only on send or when their session is ended by the user.

#### run-view-40

When the abort control is activated, it shall acknowledge instantly — disabled with an "Aborting…" label until the turn ends or the failure is shown:

- The abort control is disabled while the core connection is down.

#### run-view-41

The Captain thread shall render visible time separators before the first message, after gaps of more than ten minutes, and on day boundaries, with exact timestamps staying available on hover.

#### run-view-59

The session state chip shall show a human-readable label (amber while waiting on the Boss, red for failure) with the raw state id in its tooltip, never as the primary copy ([DR-010](../decisions/010-interface-craft.md) §2):

- while a turn is active and the state names no leaf — no state yet, or the shell's own rest state — the chip reads "working" while a player runs and "deciding" while the Captain has the floor, never "idle".

#### run-view-46

When new content arrives below the fold of a scrolled-up Captain or player pane, the pane shall show a jump-to-latest pill that scrolls to the bottom and resumes following.

#### run-view-120

While a Captain or player pane is following its end, when the pane's own box changes size, the pane shall stay at its end: chrome moving — the sidebar folding, the divider dragged [[run-view-81](#run-view-81)], panes stacking [[run-view-107](#run-view-107)], a lane unfolding [[run-view-117](#run-view-117)] — is never the reader scrolling away, so the run keeps following itself and no pill is owed ([DR-041](../decisions/041-chrome-that-fits.md)).

### Machine Cards

#### run-view-60

While a playbook run's trace records flow in a live session, the Captain pane shall draw that run as a live statechart card — one labeled box per state, one directed edge per transition, laid out top to bottom from the initial state, deterministically per machine ([DR-031](../decisions/031-machine-call-tree.md)):

- the card renders read-only, never intercepting the composer;
- the card takes the form its disclosure assigns — the full drawing or the strip [[run-view-75](#run-view-75)];
- while the run's frame is open, the glyph progress lines of that run fold into the card instead of the thread [[run-view-1](#run-view-1)], while failure lines always stay in the thread [[run-view-2](#run-view-2)];
- state labels are the human labels with raw ids in tooltips, matching the chip's law [[run-view-59](#run-view-59)] — a nested state, whose id carries its parent's path as a region of a parallel state does, goes by its own last segment, wears its parent's name as its caption when no role captions it, and keeps its whole path in its tooltip, in its exit labels' tooltips, and in the card's status line;
- a state name reads at 13px and its caption at 12px — the type scale's small step ([DR-010](../decisions/010-interface-craft.md) §8) — and a box is as wide as its column's longest name or caption needs, from a 132px floor to a 240px cap, so a name such as "reported review failure" reads whole; a name past the cap is trimmed with its whole in the box's tooltip.

#### run-view-61

While a machine card is live, the Captain pane shall show the run's state through the status palette, one voice per state kind ([DR-031](../decisions/031-machine-call-tree.md)):

- the active state carries the running emphasis with the app's one running mark — the pulsing dot the sidebar's running rows wear [[run-view-73](#run-view-73)], worn identically by the running player's pane — static under the reduced-motion preference;
- a parked state awaiting the Boss carries the attention emphasis and a failed state the failure emphasis, the derivations of the attention count [[run-view-34](#run-view-34)], and every other state stays quiet ink;
- a firing transition flashes once and decays in well under a second, instantly under reduced motion;
- every transition shows its direction at rest with a constant-size glyph, drawn lines and exit labels alike [[run-view-76](#run-view-76)];
- the active state names the player it runs — the role the machine asked for and the player answering it — and shows that player's running activity, when the trace attributes one; where the pair does not fit its box, the caption falls back to the role alone with the pair in the box's tooltip.

#### run-view-62

When a playbook run's trace settles, the Captain pane shall settle that run where it belongs — a child run as a strip under its calling state's position, in invocation order among that state's calls, a root run into the thread at the position of the record that settled it [[run-view-75](#run-view-75)] — and shall empty the live region of that frame ([DR-031](../decisions/031-machine-call-tree.md)):

- the settled run carries its own reported final status: a finished run "done", a failed one "failed", and "stopped" reserved for a run that ended unfinished;
- a disposal report closes only a frame still open, with that same status rule.

#### run-view-63

While a machine frame has a caller the pane knows, the Captain pane shall draw the call as containment ([DR-031](../decisions/031-machine-call-tree.md)):

- the child card nests indented under its caller's card, joined by a drawn connector that leaves the calling state itself, so the line reads "this state is running that machine";
- from the call onward, the calling state names its callee in the call voice — in the live drawing and the settled one — carrying the running mark while the call is open, and the child card's header names its calling state in return;
- while the caller renders as a strip [[run-view-75](#run-view-75)], the strip names the calling state and its callee and the connector leaves the strip — the containment never disappears with the fold;
- nesting recurses by the trace's parent link, never by depth arithmetic;
- each card stays live and independently drawn.

#### run-view-64

Where a run's machine definition is unavailable over the artifacts contract [[playbook-library-36](playbook-library.md#playbook-library-36)], the machine card shall draw the observed truth alone — the states and transitions the trace has delivered — and never block, error, or drop the card for the missing definition ([DR-028](../decisions/028-run-machine-view.md)).

#### run-view-74

While trace records fold into the run view's state [[run-view-14](#run-view-14)], a machine frame shall exist exactly for a playbook run underway ([DR-031](../decisions/031-machine-call-tree.md)):

- a frame opens only on evidence that a run is underway — its start, a transition, or a call it makes;
- events that merely report on a run — statuses, turn settlements, disposal — never open one;
- a settled run's trace session is tombstoned in the folded state, so later records for it change nothing, in live folding and replay alike;
- the captain shell's own frame is not a playbook run and never draws a card.

#### run-view-75

While machine cards are shown, each card shall render as either its full drawing or a one-line strip — the playbook, its current state or outcome, its calling state for a child, and its status mark — with defaults partitioning the whole tree ([DR-031](../decisions/031-machine-call-tree.md)):

- every running leaf card is expanded, and so is a running root while it is the tree's only root — the one drawing never folds the moment it calls; every other card — a running ancestor beside another root, and settled runs — is a strip;
- a disclosure toggle on each card overrides the default for that card, altering no fold state — a replay renders identically whatever was expanded ([DR-027](../decisions/027-linked-views-contract.md));
- expanding a settled strip shows the machine's final drawing with its settled descendants in place, identical under replay;
- a strip carries an accessible name stating the run, its status, and its caller, so the relation never depends on the connector alone.

#### run-view-76

When a machine card draws its edges, an edge shall render as a drawn line only between layout neighbours — one rank apart or side by side with nothing between — and every other transition shall render as an exit label inside its source state, a constant direction glyph naming its target with the event in its tooltip ([DR-031](../decisions/031-machine-call-tree.md)):

- a drawn head touches the target's border at a port no other head shares, and no drawn path crosses a state box;
- reciprocal drawn pairs stay offset;
- a state's exit labels stack inside its box without overlap, and its box grows to hold them;
- exit labels walk, fire, and dash exactly as drawn edges do;
- an exit label reads at 11px — the one text on the card a step under the small step, since a box and not a line carries its meaning ([DR-010](../decisions/010-interface-craft.md) §8);
- a state's unwalked exits into rest states — a parked state, or a failure state — fold into one "+N" marker whose tooltip lists them, each unfolding as it is walked and all of them while the box is hovered, so a box's every escape hatch never shouts over its work.

#### run-view-78

Where a frame's trace names a caller the pane does not know, the frame's card shall render at the top level rather than vanishing ([DR-031](../decisions/031-machine-call-tree.md)).

#### run-view-65

When the session record stream delivers a captain turn result reporting an error, the Captain pane shall display the synthesized failure line naming the underlying cause [[core-service-30](core-service.md#core-service-30)] as a ◆ failure line [[run-view-2](#run-view-2)], never only the captain's composed reply.

### Session Home

#### run-view-67

While the app is connected, the sidebar shall present navigation as surface entries around a Workspace section listing every registered project ([DR-029](../decisions/029-session-history-home.md)) [[core-service-32](core-service.md#core-service-32)]:

- Dashboard stands first, then the Workspace section, then Playbooks and Settings;
- each project node discloses its sessions on a control of its own, an axis independent of which project is current ([DR-027](../decisions/027-linked-views-contract.md)) — the current project starts disclosed, and thereafter the reader's arrangement stands;
- activating a project row makes it the current project and changes no disclosure;
- a disclosed project lists its live session, then its five most recent ended sessions by end time, with one control revealing the rest in place and one control opening that project's start tab — a project holds at most one live session [[core-service-4](core-service.md#core-service-4)], so starting one is a composer away, never a conflict away;
- a project whose sessions need a human carries a dot in the most severe of their colors on its own row, disclosed or not [[run-view-73](#run-view-73)];
- the section header carries the control that opens the project palette [[run-view-42](#run-view-42)], where projects are added and created;
- the surface entries are a navigation list publishing the current surface, and the projects and their sessions are one tree publishing disclosure, selection, and a single focus stop;
- the tree's selection follows the surface: the current project's row and the session row whose tab is shown are selected only while the Workspace is the surface — on the Dashboard, Playbooks, or Settings no row is selected and that surface's entry alone reads as current — and choosing the Workspace again selects the remembered project once more.


#### run-view-73

Each session row in the sidebar shall read as its conversation — its title (the first Boss turn, or a never-spoken marker), its age in the app's compact form with the exact moment in its tooltip, and a status mark — with its turn count and its age in words in the row's accessible description [[core-service-32](core-service.md#core-service-32)] ([DR-029](../decisions/029-session-history-home.md)):

- the mark speaks attention first and life second, in the app's one status palette: amber while the session waits on the human, red while it holds an unacknowledged failure — the same derivation the Dashboard entry's count uses [[run-view-34](#run-view-34)] — then running, then ended;
- a session that ended holding a failure wears a quieter historical mark that counts toward no attention signal;
- every mark's meaning is in the row's accessible description, so color is never the only channel;
- the active session's row carries the app's interaction hue, the treatment the surface entries already use;
- the row's own controls — the project's disclosure caret above it and every non-live session's delete control — are 24px targets, the delete control revealed on hover and on keyboard focus alike; a session the terminal wrote asks its inline confirm in those words, its history going too ([DR-042](../decisions/042-sessions-continue.md)).


#### run-view-68

When a session is activated in the sidebar, the workspace shall show that session's project and open the session as a tab, whatever project was current before ([DR-029](../decisions/029-session-history-home.md)):

- a live session opens as its running tab, an ended one as its ended tab — a paused conversation a message continues, or read-only where it cannot ([DR-042](../decisions/042-sessions-continue.md));
- a session already open is focused rather than opened twice;
- the project the switch made current is named where a new session would be dispatched [[run-view-25](#run-view-25)], so the target is never guessed;
- the tab's close control files the session back to the sidebar without ending it [[run-view-47](#run-view-47)], where it stays reachable.


#### run-view-69

While a session's tab is shown, the run view shall render it live, ended, or read-only by the session's own state, never navigating on that change ([DR-029](../decisions/029-session-history-home.md)):

- ending the live session keeps its transcript on screen, transitioned to the ended notice [[run-view-33](#run-view-33)] — the composer staying for a continuable session and leaving otherwise — and marks it ended on its tab and on its sidebar row, which is revealed and briefly highlighted so the reader sees where the conversation landed;
- a read-only session renders the identical fold of its stored records [[run-view-14](#run-view-14)], settled machine cards included [[run-view-62](#run-view-62)], headed by its title and ended time;
- each open session keeps its own scroll position as tabs change.


#### run-view-71

The sidebar shall collapse between its two states — the tree, and the icon rail alone — behind a control at its foot and a keyboard binding, persisting across launches ([DR-030](../decisions/030-workspace-chrome.md)):

- collapsed entries keep their accessible names and gain tooltips, the config-and-playbooks foot indicator and the Workspace section's palette control [[run-view-42](#run-view-42)] included — the control stays under the Workspace entry in icon-only form, since collapse never hides a duty;
- the attention count survives on the collapsed Dashboard entry [[run-view-34](#run-view-34)];
- collapse is chrome only: the open tabs remain the reach [[run-view-48](#run-view-48)], so it makes nothing unreachable;
- collapsing never strands focus.

#### run-view-108

While the attention count [[run-view-34](#run-view-34)] exceeds nine, the sidebar's Dashboard badge shall print "9+" — in the collapsed rail [[run-view-71](#run-view-71)] a positioned badge of at most two characters that never covers the entry's glyph — with the count itself in the entry's accessible name and tooltip ([DR-041](../decisions/041-chrome-that-fits.md)).

#### run-view-81

The run view shall divide the Captain column from the player panes at a divider the reader sets, persisting across launches ([DR-030](../decisions/030-workspace-chrome.md)):

- the divider drags — landing under the pointer, the share read against the same box it resolves against, so the rule never trails the hand that moves it — nudges by arrow key, and restores its default on a double-click or Home;
- the split is bounded so neither side can be squeezed away;
- a machine drawing [[run-view-60](#run-view-60)] wider than its column by less than a quarter scales down to the column — the drawing's own container decides, as a container query and never a width hook ([DR-041](../decisions/041-chrome-that-fits.md)) — and one wider than that keeps its size and scrolls, the column showing that more lies beyond its edge — a drawing cut without a sign reads as broken rather than scrollable — the sign following the column's width as well as the reader's scrolling, so a drawing read to its end regains it when the column narrows behind more drawing;
- the default is a 45% share, at which the built-in machines' drawings scale into a 1280px window's Captain column rather than scroll, and it holds whether or not a drawing is up — chrome never moves by itself ([DR-030](../decisions/030-workspace-chrome.md)).

#### run-view-107

While a session's tab is shown, the run view shall lay the Captain column and the player grid by the split's own container width — layout, never chrome moving by itself ([DR-041](../decisions/041-chrome-that-fits.md)): side by side with the divider [[run-view-81](#run-view-81)] between them from 42rem, and below that stacked, the Captain column above the player grid with the divider hidden and the split's setting kept for the wider form.

### Keyboard and Guardrails (DR-010 §4/§6)

#### run-view-42

The project palette shall be fully keyboard-operable ([DR-011](../decisions/011-project-workspace.md)):

- it opens from Cmd/Ctrl+P, the sidebar's Workspace section — in the expanded tree and the collapsed rail alike [[run-view-71](#run-view-71)] — the Captain home's greeting where nothing is registered [[run-view-25](#run-view-25)], or submitting a composer with no project chosen;
- its filter input holds focus — the path field where no project is registered, the palette then being an add flow [[projects-22](projects.md#projects-22)];
- arrow keys move the highlight over the Academy row where it leads the list, the project rows, and "Open folder…";
- Enter picks, in an empty path field too, while a typed path adds;
- the palette announces itself modal, and Tab and Shift+Tab wrap inside it;
- Escape closes from anywhere inside the palette and returns focus to the opener with any composer draft intact, never auto-sending.

#### run-view-43

While a slash menu is open, when Escape is pressed, the slash menu shall hide without touching the composer draft, with typing reopening it:

- The slash menu exposes listbox semantics (options with selection state reflected to assistive technology via the composer's active-descendant).

#### run-view-47

When the user ends a live session, the run view shall always use the inline confirm (safe default focused, Escape cancels) asking "End this session? A message can continue it later." with "End" and "Keep" ([DR-042](../decisions/042-sessions-continue.md)), naming the number of queued messages that would be discarded — the emergency abort control stays one-click:

- ending is a named control of its own, never the tab's close control, which stops no agent ([DR-029](../decisions/029-session-history-home.md));
- after a tab closes, focus moves to a neighboring tab, never to the document body.

#### run-view-48

The tab strip shall show the current project's open sessions, live and ended alike:

- the strip holds the sessions the reader has opened — the working set, not the archive, which the sidebar keeps [[run-view-67](#run-view-67)];
- session tabs are titled by the session's first Boss turn (truncated; "new session" before the first turn) with the full prompt and start time in the tooltip — never by the project name, which the sidebar carries ([DR-011](../decisions/011-project-workspace.md));
- tabs carry the shared attention signal: an amber dot for a waiting question and a red dot for a failure on background tabs (the active tab shows the banner instead), with the detail in the tab tooltip and the tab's accessible name ending in "needs your reply" or "failed" so the dot is never the only channel, and an ended session's tab says so;
- each tab's close control files the session out of the working set without ending it or confirming [[run-view-47](#run-view-47)];
- the strip scrolls horizontally when tabs overflow, keeps the new-session control — a plus glyph, its name in its accessible name and tooltip ([DR-041](../decisions/041-chrome-that-fits.md)) — reachable, exposes tab-list semantics, and keeps the active tab scrolled into view;
- the strip has one Tab stop — the active tab — and Arrow Left, Arrow Right, Home, and End move focus between session tabs, the new-session control, and the pinned tabs without activating any;
- a tab tooltip that names a shortcut prints it with the platform's own modifier (⌘ on a Mac, Ctrl elsewhere).

#### run-view-49

The app shall provide keyboard shortcuts implemented in the web UI (so they work identically in a browser), each preventing the host's own default: Cmd/Ctrl+1..4 switch surfaces in the sidebar's order [[run-view-67](#run-view-67)], Cmd/Ctrl+, opens Settings, Cmd/Ctrl+P opens the project palette, Cmd/Ctrl+N opens the new-session tab (or the palette when no project is chosen), Cmd/Ctrl+B collapses and restores the sidebar [[run-view-71](#run-view-71)], Cmd/Ctrl+Shift+S toggles the Specs tab with the previous tab, Cmd/Ctrl+Shift+[ and ] cycle the current project's open tabs including the pinned ones [[run-view-48](#run-view-48)], and a printable key pressed outside any input and outside the sidebar refocuses the Boss composer:

- every control that names its binding prints the platform's own modifier — ⌘ on a Mac, Ctrl elsewhere — from one shared table of the bindings;
- that table is listed as a sheet on the Settings surface [[settings-10](settings.md#settings-10)], the modifier bindings and the plain keys alike.

### First-Hour Integrity (DR-010 §5)

#### run-view-44

While the shared config is invalid or missing, the Captain home shall say so in the thread — listing the actual errors, or saying there is no config file yet where it is missing — with an in-place link to Settings, where the missing file's remedy waits [[settings-24](settings.md#settings-24)], never rendering the captain identity blank.

#### run-view-45

The not-ready heads-up shall offer an in-place re-check, with copy that is honest about env vars requiring a restart:

- the app re-checks readiness when its window regains focus while anything is not ready;
- readiness covers every adapter any configured agent names.

#### run-view-50

The app shall fail loudly and stay accessible:

- when the app is connected but its initial state failed to load, a banner says so and offers retry — never a silently empty app;
- when the page has never reached its core, a banner names the endpoint it keeps dialing with a Retry once eight seconds have passed since the page opened — a first connect is "Connecting", never "Reconnecting", and a slow core gets that long before the alarm;
- one persistent polite live region announces a player waiting for a reply, connection loss and restoration, and attention-count increases to assistive technology;
- icon-only controls carry accessible names and at-least-24px hit targets, and the navigation exposes the current surface and badge meaning to assistive technology;
- one glyph carries one meaning across the app ([DR-010](../decisions/010-interface-craft.md) §8): the gear names the Settings surface, and an in-place editor wears the pencil;
- color is never the only channel: a player pane's running mark says "running" in text, a tool card's outcome is a mark with its word — ✓ ok, ✗ failed, ✗ denied — and a failure count and a tab's attention dot each carry their meaning in text;
- no action strands focus on the document body: ending a session lands focus on the session's tab, backing out of the end confirm returns it to the end control, and aborting a turn keeps it in the composer.

#### run-view-51

Where the Captain home has nothing to report (no warnings or errors), it shall center its whole cluster — greeting, quick start, and composer — on the canvas, reverting to the bottom-docked chat layout once real content exists; session history lives in the sidebar [[run-view-67](#run-view-67)], never on the home.

### Project Workspace (DR-011)

#### run-view-56

The Workspace shall name the current project in the sidebar's Workspace section rather than in a bar of its own [[run-view-67](#run-view-67)] ([DR-029](../decisions/029-session-history-home.md)):

- the project palette opens from its keyboard binding [[run-view-49](#run-view-49)] and from the sidebar's Workspace section;
- while no project is chosen, the tab strip (including pinned tabs) is absent and the sidebar plus the Captain home's guidance is the whole surface.


#### run-view-57

Each project shall keep its own working set — the sessions open as tabs and which tab is active — restored when the project becomes current again, with only the current project persisting across launches ([DR-029](../decisions/029-session-history-home.md)):

- a session activated again is focused rather than opened twice, and removing a project discards its working set with it;
- when the user arrives via an attention affordance (a Dashboard row or a palette row with a needs-you signal), the workspace focuses the session that needs the human instead of the remembered tab;
- a fresh launch opens the current project's live session if it has one and the start tab otherwise — the sidebar, not the working set, is what carries history across launches [[run-view-67](#run-view-67)];
- a launch with no remembered project adopts one wherever the workspace holds any — a live session's project, else any registered one — so a workspace with projects never opens asking which.

#### run-view-58

The tab strip shall end with pinned Specs and Overview tabs — one spec view and one project overview [[projects-4](projects.md#projects-4)] per project — that participate in the tab list and the tab-cycling shortcut ([DR-038](../decisions/038-history-is-done-work.md)):

- Switching projects swaps the whole strip; sessions of other projects keep running and stay reachable through the sidebar [[run-view-67](#run-view-67)], the palette's live-state rows, and the Dashboard.

### Intent Ledger (DR-035)

#### run-view-85

When the composer's add-to-Up-next action is activated, the Boss composer shall capture the typed text as a queued intent for the session's project with chat provenance and acknowledge the capture in place, sending nothing ([DR-035](../decisions/035-intent-ledger.md)):

- the capture starts no turn and queues no submission [[run-view-8](#run-view-8)] — the text is shelved, not sent;
- the acknowledgment is an inline note in the composer's caption line [[run-view-106](#run-view-106)] naming where the row landed — "Added to Up next — see the project's Overview.", the project's Up next in its Overview tab, where the row's Remove waits [[dashboard-29](dashboard.md#dashboard-29)] — the run view's form of the shelf reveal;
- the action stands beside send as the composer's one secondary action, labeled "Add to Up next" — by where the text goes, never by a mechanism.

#### run-view-86

When Start is activated on a queued intent, the run view shall stage the intent's text into the project's composer, focused — the live session's, or the Captain home's where none is live — under a visible chip carrying the intent's title, and the chip governs what a send stamps ([DR-035](../decisions/035-intent-ledger.md)):

- emptying the composer or dismissing the chip detaches the intent, and a send then stamps nothing — the intent simply stays queued;
- sending with the chip attached passes the intent's id with the Boss submission [[core-service-5](core-service.md#core-service-5)];
- while the submission waits in the composer queue [[run-view-8](#run-view-8)], the chip rides the pending bubble [[run-view-38](#run-view-38)] and the intent stays queued until its turn starts.

#### run-view-87

When a dispatched intent's final turn ends finished, the run view shall render the intent's delivery card at that turn's end in the Captain thread — a first-class settled card carrying the intent's title, its provenance chip where the intent carries a source, a run-stats line, and a primary Confirm control with Drop beside it ([DR-035](../decisions/035-intent-ledger.md)):

- the run-stats line folds from the intent's own turns — its review rounds foremost, omitted when zero, then its turn count and its elapsed time from dispatch to the last turn's end, in the app's one duration vocabulary — so the verdict is informed before the click;
- the provenance chip with a canonical URL is a link that opens outside the page — a new browsing context, with no referrer — so the session never navigates away, and the same chip is the one the bound turn's bubble wears [[run-view-89](#run-view-89)];
- the card says visibly that a follow-up message continues the intent;
- when a verdict is given, the card resolves in place into the project's next queued intent with Start, or into an inline add affordance when the queue holds none;
- in an ended session the card replays identically from the stored fold [[run-view-14](#run-view-14)], its controls inert.

#### run-view-88

While the Captain home is shown and the current project's queue holds an unblocked intent, the Captain home shall present a next card naming the queue's head unblocked intent with Start, Remove beside it [[run-view-114](#run-view-114)], and a count of the remaining queued intents, coexisting with the quick start card [[run-view-27](#run-view-27)] ([DR-035](../decisions/035-intent-ledger.md)):

- Start stages the intent into the home composer under its chip [[run-view-86](#run-view-86)], where sending creates the session and dispatches the text in one motion [[run-view-26](#run-view-26)].

#### run-view-89

While a Boss turn is bound to an intent, that turn's outgoing bubble [[run-view-30](#run-view-30)] shall wear the intent's source chip, so the thread shows the provenance of what it dispatched ([DR-035](../decisions/035-intent-ledger.md)):

- the chip names the intent's source — issue, PR, record, or chat — and an unsourced intent's bubble wears none;
- a trailing line of the dispatched text that only repeats the source's URL stays out of the bubble, since the chip carries it.

#### run-view-90

While a session's lane holds an open dispatched intent, the run view shall show a slim working line above the Boss composer naming that intent — the newest open intent, which owns the conversation — with Drop beside it [[run-view-113](#run-view-113)], so re-entry is answered where the eye lands ([DR-035](../decisions/035-intent-ledger.md)).

#### run-view-91

When the workspace opens a session from an attention entry [[dashboard-1](dashboard.md#dashboard-1)] bound to an intent [[run-view-57](#run-view-57)], the run view shall focus the intent's place in the thread ([DR-035](../decisions/035-intent-ledger.md)):

| The entry stands on | The focused place |
| --- | --- |
| a pending question | the question's incoming bubble [[run-view-9](#run-view-9)] |
| an unacknowledged failure | the failure's ◆ line [[run-view-2](#run-view-2)] |
| a finish awaiting its verdict | the delivery card at the intent's final turn [[run-view-87](#run-view-87)] |

#### run-view-113

While the working line names an open intent [[run-view-90](#run-view-90)], the run view shall offer Drop on the line, which — behind an inline confirm, Drop or Keep, since work is underway ([DR-010](../decisions/010-interface-craft.md) §4) — closes that intent dropped over the protocol while the turn keeps running ([DR-035](../decisions/035-intent-ledger.md)):

- the outcome — the drop, or the refusal with its reason — announces in a status line where the working line stood, lasting six seconds;
- Keep returns focus to the control; a drop hands it to the composer once the line has left with its control ([DR-010](../decisions/010-interface-craft.md) §6).

#### run-view-114

While the next card names the queue's head [[run-view-88](#run-view-88)], the Captain home shall offer Remove beside Start, acting on the click with no confirmation and leaving no history ([DR-038](../decisions/038-history-is-done-work.md)), then a status line — "Removed “⟨title⟩” — Undo", taking focus and lasting six seconds beyond the last moment its control holds it — that re-queues the same text and provenance at the queue's head:

- the card stays while the Undo line stands, even once no queued intent is left behind it, and a restored intent's Start takes focus.

## Internal Behavior

### Protocol Boundary

#### run-view-13

Where the run view renders a project session, the run view shall consume only messages of the versioned WebSocket protocol defined in `packages/core` ([DR-002](../decisions/002-desktop-app-architecture.md)):

- the run view imports no Node-only modules and calls no `@sublang/cligent` or `@sublang/playbook` APIs directly;
- every record it renders arrives as a protocol message ([DR-003](../decisions/003-runtime-reuse.md)).

#### run-view-14

Where the run view receives a session's ordered record stream, the run view shall render pane structure and content as a function of the received messages alone, so that replaying a recorded stream reproduces an identical view with no live runtime attached:

- Records lacking a string `type` or finite numeric `timestamp`, and unknown record types, advance the sequence cursor without changing pane state or triggering record-driven actions.

### Transcript Rendering

#### run-view-15

Where a player transcript exceeds the visible viewport, the transcript view shall mount only the entries in and near the viewport, keeping the mounted entry count bounded regardless of transcript length:

- When the user scrolls, the transcript view reveals previously unmounted entries with content identical to an unvirtualized render.

#### run-view-16

While consecutive text deltas for the same player message are pending within one render frame, the transcript view shall coalesce them into a single append, preserving delta order and content byte-for-byte and never merging deltas across different messages or players.

### Captain Pane Rendering

#### run-view-17

When the session record stream delivers a captain record whose kind is outside the glyph vocabulary of [[run-view-1](#run-view-1)], the Captain pane shall render the record's text as a plain line rather than dropping the record.

### Pane Management

#### run-view-18

The pane manager shall key each pane by its player id [[run-view-7](#run-view-7)] and route no record carrying `hidden` visibility to any pane, so judge and router traffic reaches no transcript.

### Session Start Rendering

#### run-view-28

The start view shall obtain projects, playbooks, captain identity, and readiness exclusively through existing protocol commands and broadcasts, detecting the native picker by feature-testing the shell bridge ([DR-008](../decisions/008-native-shell-bridge.md)) and falling back to manual path entry when the bridge is absent so the identical build serves browser deployments.

## Verification

### Fixture Replay Coverage

#### run-view-20

Where a recorded fixture stream of a completed playbook session is replayed into the run view over the protocol [[run-view-14](#run-view-14)], the test suite shall assert that the rendered result matches the fixture's expectations: the Captain pane holds the expected glyph lines in arrival order [[run-view-1](#run-view-1)], one pane exists per roster player and a record narrowing the engaged players removes none [[run-view-7](#run-view-7)], player transcripts render the expected Markdown text [[run-view-3](#run-view-3)], tool-use entries appear as collapsed cards labeled by tool name and input subject, with a subject-less input labeled by name alone, their bodies printing string fields verbatim and other values as JSON with the result's span in the duration vocabulary [[run-view-4](#run-view-4)], each pane's header naming its latest call's role and an unprompted lane saying whom it waits for [[run-view-7](#run-view-7)], a transcript's Markdown link to a target the shell cannot open renders as plain text while an `https` one stays a link [[run-view-83](#run-view-83)], every completed turn with a token report shows its token totals and no pane shows a monetary figure though the fixture records a cost [[run-view-6](#run-view-6)], opaque records advance the cursor without changing panes or dispatching queued submissions before later supported records render [[run-view-14](#run-view-14)], and the machine card assertions of [[run-view-66](#run-view-66)] hold over the same replay.

#### run-view-66

Where a fixture stream carries a playbook run's trace records — an invocation start, transitions, a player call attributed to a state, a nested invocation carrying the parent link, a settled finish, and the post-terminal reports a real runtime emits (a status, a turn settlement, and a disposal after the closing transition) — the test suite shall assert the machine cards over a replay [[run-view-14](#run-view-14)]:

- a live card opens with the frame and draws the machine with the active state emphasized and wearing the running mark, static when reduced motion is preferred [[run-view-60](#run-view-60)] [[run-view-61](#run-view-61)];
- the glyph progress lines of the framed run leave the thread while failure lines stay [[run-view-60](#run-view-60)];
- the active state names its attributed player while that player runs [[run-view-61](#run-view-61)] and its callee while the nested run is open [[run-view-63](#run-view-63)];
- the nested invocation renders nested directly under the card of the run that called it, with the connector and the mutual naming [[run-view-63](#run-view-63)];
- while the child runs, the caller — the tree's only root — stays drawn with its calling state in the call voice, and its accessible name states its run, status, and callee [[run-view-75](#run-view-75)];
- collapsing the drawn caller while the child runs is arrangement only: the strip stands with the connector, the child is unchanged, and the fold state is untouched [[run-view-75](#run-view-75)];
- the boxes take their column's longest label's width with names at 13px, captions at 12px, and exit labels at 11px, and a role-and-player caption no box holds falls back to the role with the pair in the tooltip [[run-view-60](#run-view-60)] [[run-view-61](#run-view-61)] [[run-view-76](#run-view-76)];
- a state's unwalked exits into rest states fold to one counted marker listing them, unfolding while the box is hovered, while an exit into a working state stays a label [[run-view-76](#run-view-76)];
- the child's settled finish lands as a strip under its calling state, and the root's settles into the thread as a strip whose expansion shows the final drawing [[run-view-62](#run-view-62)] [[run-view-75](#run-view-75)];
- the post-terminal reports open no frame and change no settled card — exactly one card per run, its outcome "done" [[run-view-74](#run-view-74)] [[run-view-62](#run-view-62)];
- a second fixture run that ends by disposal alone, without a terminal transition, settles exactly one card with the outcome "stopped" [[run-view-62](#run-view-62)] [[run-view-74](#run-view-74)];
- a fixture child naming an unknown caller renders at the top level [[run-view-78](#run-view-78)];
- with no machine definition served, the same replay still renders the card from observed states alone [[run-view-64](#run-view-64)];
- a fixture captain reply record renders as Captain speech in the thread [[run-view-1](#run-view-1)];
- a fixture captain result reporting an error renders the synthesized cause as a failure line [[run-view-65](#run-view-65)].

#### run-view-77

Where a fixture machine holds a neighbour edge, a same-rank pair, a rank-skipping edge, a backward edge, and a fan of transitions into one state, the test suite shall assert the solved geometry of [[run-view-76](#run-view-76)] over the card's computed drawing — the same solved layout the replayed card renders [[run-view-14](#run-view-14)] — and over each installed built-in machine's served graph: every transition is exactly one drawn line or one exit label, every drawn head lies on its target's border at an unshared port, no drawn path intersects any state box, reciprocal drawn pairs yield distinct paths, and each exit label names its target from an unshared slot in its source.

#### run-view-70

Where a fixture store holds two projects — the current one with a live titled session awaiting a Boss reply, more ended sessions than the recent window holds (one of them having held a failure), and a session with no turns; the other with a live session awaiting a reply and an ended session — the test suite shall assert the sidebar contract: Dashboard stands first carrying the attention count [[run-view-34](#run-view-34)], the current project's rows carry their titles, relative times, and attention-first marks with the turn counts in their accessible descriptions and the ended failure marked as history rather than attention [[run-view-73](#run-view-73)], and the other project's row carries its own attention signal [[run-view-67](#run-view-67)]; disclosing that project leaves the current project unchanged [[run-view-67](#run-view-67)]; activating its session shows that project and opens the session as a read-only tab, and activating it again focuses rather than duplicates [[run-view-68](#run-view-68)]; ending the live session keeps its transcript on screen read-only and reveals its now-ended row [[run-view-69](#run-view-69)]; closing that tab leaves the session listed and running nothing [[run-view-68](#run-view-68)]; the rest-revealing control lists the sessions the recent window omitted [[run-view-67](#run-view-67)]; and, with the Workspace showing the live session's tab, the current project's row and that session's row are selected, showing Playbooks leaves no row selected with its own entry current, and the Workspace selects the remembered project again [[run-view-67](#run-view-67)].


#### run-view-84

Where a fixture launch reports registered projects with nothing remembered and no live session, the test suite shall assert the workspace adopts one of them as current [[run-view-57](#run-view-57)].

#### run-view-72

Where the workspace renders with the sidebar expanded, the test suite shall assert the chrome contract of [[run-view-71](#run-view-71)]: the binding collapses the sidebar to icons that keep their accessible names and the Dashboard attention count, the state survives a remount, and the foot control restores the tree.

#### run-view-21

Where a fixture stream contains records marked hidden (judge or router traffic), when the fixture is replayed into the run view, the test suite shall assert that no rendered pane contains the hidden records' content [[run-view-18](#run-view-18)] and that a player named only by hidden records — being no roster player — has no pane [[run-view-7](#run-view-7)].

### Interaction Coverage

#### run-view-22

Where a replayed fixture stream ends in an await-Boss-reply state carrying a player question, the test suite shall assert the await-reply round trip:

- the question appears above the Boss composer and inside the asking player's pane [[run-view-9](#run-view-9)];
- when text is then submitted in the composer, the submission is sent over the protocol as the reply to the waiting question — not as a new Boss prompt — and the question display clears [[run-view-9](#run-view-9)].

#### run-view-23

While a replayed fixture stream holds a turn active, when the abort control is activated and the turn-aborted record is then delivered, the test suite shall assert that an abort command was sent over the protocol [[run-view-10](#run-view-10)], that the interrupted turn shows a visible aborted marker, and that a submission made after the abort is dispatched immediately rather than queued [[run-view-8](#run-view-8)].

#### run-view-24

While a replayed fixture stream holds a turn active, the test suite shall assert the queue-and-release flow:

- when text is submitted in the Boss composer, the submission is queued with a visible queued indicator and no Boss prompt is dispatched over the protocol [[run-view-8](#run-view-8)];
- when the turn-finished record is then delivered, the queued submission is dispatched and the indicator clears [[run-view-8](#run-view-8)].

#### run-view-29

Where no session is live, when the Workspace renders with a fixture config of one project and one playbook, the test suite shall assert the Captain home's one-motion start:

- the Captain home shows the greeting naming the current project, the chat composer, and the captain identity [[run-view-25](#run-view-25)];
- with no project current, the greeting offers picking one where the workspace holds projects and adding one where it holds none [[run-view-25](#run-view-25)];
- when text is submitted with a current project, a session is created for that project and the text is dispatched as its first Boss turn [[run-view-26](#run-view-26)];
- when text is submitted with no project chosen, the palette opens and the draft survives [[run-view-26](#run-view-26)].

#### run-view-31

When the Captain home composer and thread render against the fixture playbook, the test suite shall assert playbook discovery and IM presentation:

- when `/` is typed at the start of the composer, the slash menu lists the fixture playbook with its intent, filters as more is typed, and inserts the command without dispatching on selection [[run-view-27](#run-view-27)];
- when the quick start card is dismissed and the view is remounted, the card stays dismissed [[run-view-27](#run-view-27)];
- when a fixture stream containing a boss turn is replayed, the submitted text renders as a user bubble in the Captain thread [[run-view-30](#run-view-30)].

#### run-view-35

When the captain editor popover is opened from the Captain home with a fixture captain block, the test suite shall assert it offers the runtime's adapters with their readiness, that changing the adapter or model issues a captain merge patch through the configuration edit path, that the patch carries the editor's surfaced fields and never a hand-written one, and that the popover opens on the roomier side of its gear under a cap of the room the window can show there — all without a surface change [[run-view-32](#run-view-32)].

#### run-view-36

Where a fixture holds one ended session with a stored transcript and one live session awaiting a Boss reply, the test suite shall assert that opening the ended session shows a loading note and then its transcript with a start-a-new-session affordance, that a failed load offers a retry instead of an empty run [[run-view-33](#run-view-33)], and that the Dashboard navigation badge shows the count 1 [[run-view-34](#run-view-34)].

#### run-view-52

When the awaitBossReply fixture stream is replayed, the test suite shall assert the question renders as one incoming bubble naming the asking player by its pane id, that no status-line duplicate of the question survives — in either arrival order of the narration and the telemetry — and that the banner names the player without repeating the question [[run-view-9](#run-view-9)].

#### run-view-80

Where a fixture stream calls one player under two roles, the test suite shall assert each call carries its own role label where it opens and an unresolved call carries none [[run-view-79](#run-view-79)].

#### run-view-82

Where the run view renders with its default split, the test suite shall assert the divider contract of [[run-view-81](#run-view-81)]: an arrow key moves the split and a double-click restores the default of 45%, the split survives a remount, a nudge past either bound stops at that bound, a drag against a padded container leaves the rule within a pixel of the pointer rather than the padding's width away from it, and a machine drawing carries the scale-or-scroll rule — its natural width, the floor at four fifths of it, and the container query choosing between them — inside a scrolling box that masks its edge, which a box read to its end and then narrowed masks again.

#### run-view-53

While a fixture turn is active, the test suite shall assert the Captain thread shows the working indicator — the Captain thinking while no player runs, and a running player's role with the ticking span since its prompt, the same span in that player's pane header [[run-view-37](#run-view-37)] [[run-view-7](#run-view-7)] — queued entries render in full with the sends-when-this-turn-ends caption [[run-view-38](#run-view-38)] inside a frame kept at its end that the composer's own box holds its place beside [[run-view-106](#run-view-106)], the composer renders a store-provided draft and reports edits to the store [[run-view-39](#run-view-39)], and activating Abort disables it with an "Aborting…" label [[run-view-40](#run-view-40)].

#### run-view-54

The test suite shall assert time separators appear before the first line, after >10-minute gaps, and on day changes [[run-view-41](#run-view-41)]; that known states map to human labels with unknown ids humanized [[run-view-59](#run-view-59)]; that the project palette is driven end-to-end by keyboard (opens focused, arrows highlight, Enter picks, Escape closes with the composer draft intact) [[run-view-42](#run-view-42)]; and that Escape hides the slash menu without touching the draft [[run-view-43](#run-view-43)].

#### run-view-55

The test suite shall assert first-hour failures surface at hand:

- where a fixture config is invalid, the Captain home thread lists the errors with a Settings link [[run-view-44](#run-view-44)];
- where a fixture readiness entry is not ready, the heads-up bubble offers a re-check that invokes the readiness refresh [[run-view-45](#run-view-45)].

### Intent Ledger Coverage

#### run-view-92

While a replayed fixture stream holds a live session, when text is typed and the composer's queue-instead-of-send action is activated, the test suite shall assert the capture flow: a queue-intent command carrying the typed text and chat provenance for the session's project is sent over the protocol, no Boss turn is dispatched and no submission queues [[run-view-85](#run-view-85)], and an inline acknowledgment names where the row landed in the project's queue [[run-view-85](#run-view-85)].

#### run-view-93

Where a fixture project holds a queued intent and a live session, the test suite shall assert the staging flow:

- activating Start stages the intent's text into the session's composer, focused, under a chip carrying the intent's title [[run-view-86](#run-view-86)];
- emptying the composer detaches the chip, and a subsequent send carries no intent id [[run-view-86](#run-view-86)];
- staging again and sending passes the intent's id with the submission [[run-view-86](#run-view-86)];
- while a fixture turn is active, a staged send queues with the chip riding the pending bubble [[run-view-86](#run-view-86)] [[run-view-38](#run-view-38)].

#### run-view-94

Where a replayed fixture stream dispatches a queued intent whose turn then ends finished, the test suite shall assert the delivery flow:

- the bound turn's bubble wears the intent's source chip, and a trailing line repeating the source's URL leaves the bubble [[run-view-89](#run-view-89)];
- while the intent is open, the working line above the composer names it [[run-view-90](#run-view-90)];
- Drop on the working line asks the inline confirm — Keep leaves the intent open with focus back on the control; Drop sends the close command as dropped, the line leaves with the outcome announced where it stood and focus in the composer; a refused drop keeps the line and names the refusal [[run-view-113](#run-view-113)];
- the delivery card at the final turn's end carries the intent's title, its provenance chip, its review rounds, turn count, and elapsed time, a primary Confirm with Drop beside, and the visible follow-up note [[run-view-87](#run-view-87)];
- giving a verdict sends a close command over the protocol and resolves the card in place into the project's next queued intent with Start [[run-view-87](#run-view-87)];
- with an empty fixture queue, the card resolves into the inline add affordance instead [[run-view-87](#run-view-87)];
- replaying the same stream as an ended session renders the identical card with its controls inert [[run-view-87](#run-view-87)] [[run-view-14](#run-view-14)].

#### run-view-95

Where a fixture project holds a queue whose unblocked head intent has more intents behind it, when the Captain home renders, the test suite shall assert the next card names the head intent with Start and counts the rest while the quick start card stands beside it [[run-view-88](#run-view-88)], and that activating Start stages the intent into the home composer under its chip [[run-view-88](#run-view-88)] [[run-view-86](#run-view-86)], and that Remove closes the head intent dropped on the click with the Undo line taking focus, the card standing on that line alone once no next is served, and Undo re-queuing the same text and provenance at the head with the restored intent's Start focused [[run-view-114](#run-view-114)].

#### run-view-96

Where fixture streams hold one intent standing on a pending question, one holding an unacknowledged failure, and one finished awaiting its verdict, when each session is opened from its attention entry, the test suite shall assert the run view focuses the question's bubble, the failure's line, and the delivery card respectively [[run-view-91](#run-view-91)].

### Protocol Boundary Coverage

#### run-view-19

Where the run view's production modules are inspected, the test suite shall assert that project-session records reach the run view only as versioned protocol messages:

- the modules import no Node-only modules and call no `@sublang/cligent` or `@sublang/playbook` APIs [[run-view-13](#run-view-13)];
- every write to the rendered record state originates from the protocol client's message handling [[run-view-13](#run-view-13)].

### Browser Journeys

#### run-view-97

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell on an empty state root with no config and opens its token URL, the test suite shall assert the first run through the page alone:

- the Captain home greets and offers adding a project, with the quick start listing the seeded playbooks [[run-view-25](#run-view-25)] [[run-view-27](#run-view-27)];
- submitting composer text with no project opens the palette and keeps the draft [[run-view-26](#run-view-26)];
- once the Academy example seeds from the palette, the greeting names the project and the sidebar lists it [[run-view-25](#run-view-25)] [[run-view-67](#run-view-67)];
- typing `/` lists the configured playbooks, Escape hides the menu with the draft intact, and typing reopens it [[run-view-27](#run-view-27)] [[run-view-43](#run-view-43)].

#### run-view-98

Where the harness boots the served shell with the demo project registered and the scripted Captain, when the journey sends a task from the Captain home, the test suite shall assert the first session through the page:

- a session tab opens titled by the task and the sidebar row reads the same title [[run-view-48](#run-view-48)] [[run-view-73](#run-view-73)];
- the Captain pane shows the run's status lines and a machine card for the code run with its review call nested [[run-view-1](#run-view-1)] [[run-view-60](#run-view-60)] [[run-view-63](#run-view-63)];
- one pane per roster player stands, the coder's streaming text and collapsed tool cards, then its usage [[run-view-7](#run-view-7)] [[run-view-3](#run-view-3)] [[run-view-4](#run-view-4)] [[run-view-6](#run-view-6)];
- a message sent during the turn reads queued, never sent, and goes out when the turn ends [[run-view-38](#run-view-38)];
- ending the session asks the inline confirm, and the tab then renders read-only with the ended note [[run-view-47](#run-view-47)] [[run-view-69](#run-view-69)].

#### run-view-99

Where the harness boots with the demo project registered, when the journey sends a prompt the scripted Captain parks on a player question, the test suite shall assert the reply round trip through the page: the question renders as an incoming bubble naming the player with the composer inviting the answer [[run-view-9](#run-view-9)], the state chip reads waiting in amber [[run-view-59](#run-view-59)], and the reply goes out as the next turn, after which the chip settles [[run-view-9](#run-view-9)].

#### run-view-100

Where the harness boots the served shell, the test suite shall assert the page fails loudly when the core is out of reach [[run-view-50](#run-view-50)]:

- opened with a wrong token, the page names the core it cannot reach and offers retry, and the composer does not read ready;
- with the shell stopped while the page is open, the page says it is reconnecting; started again on the same root and port, the page recovers with its project list intact.

#### run-view-101

Where the harness boots with the demo project registered, the test suite shall assert the keyboard journey [[run-view-49](#run-view-49)]:

- the platform modifier with P opens the palette, arrow keys move its selection, Enter picks, Escape closes [[run-view-42](#run-view-42)];
- the modifier with 1 through 4 switches surfaces, and the modifier with B collapses and restores the sidebar [[run-view-71](#run-view-71)];
- in the composer Enter sends while Shift+Enter inserts a line break [[run-view-8](#run-view-8)];
- a Tab sequence from the page start reaches the composer, and no shortcut leaves focus stranded on the document body.

#### run-view-102

Where the harness boots with the demo project registered and a finished session, when each surface — Captain home, a session, the Dashboard, the Overview, the Specs tab, Playbooks, and Settings — is scanned by axe-core at WCAG 2.1 AA in the light and the dark theme, the test suite shall assert no serious or critical violation [[run-view-50](#run-view-50)] [[run-view-12](#run-view-12)].

#### run-view-103

Where the harness boots with the demo project registered, when the journey breaks the shared config on disk while the page is open and then repairs it, the test suite shall assert the Captain home lists the actual error with its in-place Settings link while broken, and returns to its greeting once repaired [[run-view-44](#run-view-44)].

#### run-view-104

Where the live lane runs with the machine's signed-in agents ([DR-039](../decisions/039-browser-acceptance-journeys.md)), when the journey sends a minimal no-change `/code` task, the test suite shall assert through the page that a player pane shows the coder's live output, that the abort control acknowledges instantly and the turn ends aborted [[run-view-10](#run-view-10)] [[run-view-40](#run-view-40)], and that ending the session leaves the tab read-only [[run-view-47](#run-view-47)].

#### run-view-115

Where the harness boots with the demo project registered and the scripted Captain, when the journey starts a queued intent and drops it from the session's working line, the test suite shall assert through the page that the confirm names work underway and Keep returns focus to the control, and that Drop removes the line with the outcome announced in its place and focus in the composer [[run-view-113](#run-view-113)].

#### run-view-118

Where the harness boots with the demo project registered and the scripted Captain, when the journey parks a session on a player question, collapses the reviewer's idle lane, and replies so the Captain narrates the code run with its nested review, the test suite shall assert through the page that the reviewer's rail stands at its narrow width with the lane's name inside its box and the expand control focused while the coder's pane widened [[run-view-116](#run-view-116)] [[run-view-7](#run-view-7)], that the coder's pane is in view while its call runs [[run-view-7](#run-view-7)], and that the reviewer's lane unfolded itself when the review's call opened, its transcript then filling [[run-view-117](#run-view-117)].

#### run-view-109

Where the hermetic lane's demo shell has run a task to its end ([DR-039](../decisions/039-browser-acceptance-journeys.md)), the test suite shall assert through the page that ending the session leaves the composer in place reading as a paused conversation, that a message sent there continues the session on the same tab — the Captain narrating again, the end control back — and that after the shell restarts underneath the page the same tab continues once more [[run-view-68](#run-view-68)]; and, with a session the terminal wrote listed for the project, that its sidebar row's delete control and inline confirm — worded for the terminal's history — remove it from the listing and its record and stream from the shared session store [[run-view-73](#run-view-73)].

#### run-view-105

Where the harness boots with the demo project registered and carrying closed work, the scripted Captain, and ten further projects each holding a live session parked on a player question, when the journey shows each surface — the Captain home, a session with a turn in flight, the Dashboard, the project's Overview, the Specs tab with the graph shown, Playbooks, and Settings — at the widths 320, 480, 640, 800, 1024, and 1280 pixels, each at 800 and 400 pixels tall, with the sidebar collapsed and, from 480 pixels, open ([DR-041](../decisions/041-chrome-that-fits.md): the open sidebar is 224 pixels wide), the test suite shall assert fit through the page, naming every offending element:

- the page never scrolls sideways, and no element outside a sideways-scrolling canvas is wider than its box [[run-view-106](#run-view-106)] [[run-view-107](#run-view-107)] [[run-view-48](#run-view-48)];
- the page never scrolls vertically, no scrolling box ends past the bottom of the viewport, and no positioned element lies past it with no scrolling box containing it — at either height, and again after the window is made short and tall within one page life [[run-view-119](#run-view-119)];
- within every tab list, toolbar, header, list row, and composer box, no two visible siblings overlap and every child lies inside its parent [[run-view-106](#run-view-106)] [[run-view-71](#run-view-71)];
- every control's accessible name is the same at every width [[run-view-8](#run-view-8)] [[run-view-85](#run-view-85)] [[run-view-47](#run-view-47)];
- the collapsed sidebar's Dashboard badge prints "9+" with the count in the entry's accessible name [[run-view-108](#run-view-108)];
- the Captain home's agent popover, opened at each height, lies inside the window with its adapter picker reachable and the page unmoved [[run-view-32](#run-view-32)];
- a composer standing behind six queued submissions keeps its frame a few entries tall and its primary control inside the window at every width and height [[run-view-106](#run-view-106)].

#### run-view-121

Where the harness boots with the demo project registered and the scripted Captain, when the journey types a draft and shows the sidebar in a window too short for the thread — chrome moving with no window resize behind it — the test suite shall assert through the page that the narrowed field still stands as tall as the rewrapped draft needs [[run-view-106](#run-view-106)] and that the Captain thread is still at its end [[run-view-120](#run-view-120)].

#### run-view-122

Where the harness boots with the demo project registered, when the journey leaves the Workspace for the Dashboard and for Playbooks and then returns, the test suite shall assert through the page that the sidebar names one place at a time [[run-view-67](#run-view-67)]: the project's row is selected on the Workspace, neither other surface leaves any row in the tree selected while its own entry reads as current, and the Workspace selects the remembered project's row again.
