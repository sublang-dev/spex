<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# playbook-library: Playbook Library

## Intent

This spec covers the Spex Library surface — presented to the user as **Playbooks** — across its user-visible behavior, the implementation behind it, and the integration coverage that verifies it: browsing and enabling configured playbooks, mapping playbook roles to player agents, and compiling new playbooks, backed by compile execution, registry generation, and shared-config writes.
Playbook entries live in the shared playbook config file, which remains the source of truth under its fail-closed validation rules; compilation runs the external `slc` toolchain with its Node.js version floor and compiled outputs.
Verification requires integration coverage of the Library surface's compile, registration, and shared-config write paths, where correctness spans the external `slc` process, generated registry artifacts, and the shared config file.

## External Behavior

### Playbook List

#### playbook-library-1

When the Library surface is opened, the Library shall list every playbook configured in the shared config's `playbooks` map ([DR-004](../decisions/004-config-and-persistence.md)), showing for each entry its id, command, intent, each required role with the session player bound to it and what that binding effectively runs, and enabled state ([DR-032](../decisions/032-session-players.md)).

#### playbook-library-2

Where a configured playbook entry fails the fail-closed config validation ([DR-004](../decisions/004-config-and-persistence.md)) — for example, an unresolved required role or a duplicate command — the Library shall list the entry marked invalid with the specific validation failure, rather than hiding it.

### Enable and Disable

#### playbook-library-3

When the user toggles a playbook's enabled state, the Library shall persist the new state to that playbook's entry in the shared config file (state encoding per [DR-004](../decisions/004-config-and-persistence.md)), shall modify no other entry, and shall reflect the new state in the list:

- Disabling does not remove the playbook's entry or its role bindings from the shared config.

### Role Binding

#### playbook-library-4

When the user edits a role's binding, the Library shall write which session player answers that role together with that role's own model, effort, and fast mode ([DR-032](../decisions/032-session-players.md)), and shall reject an edit the shared-config write path refuses, naming the affected role:

- The players offered are the shared config's roster [[settings-26](settings.md#settings-26)]; the editor mints none and offers no adapter or permissions, which belong to the player's envelope.
- Model and effort are inherit-the-player, the provider's current default, or a pinned value, written as omission, `false`, and the value respectively; pinned values use the player's runtime model and effort choices [[settings-34](settings.md#settings-34)].
- Clearing a pinned value keeps it pinned and shows a validation message; only an explicit mode change selects inheritance or provider default.
- Fast mode is inherit, on, or off for adapters accepting fast-mode requests; an unsupported adapter permits only clearing an existing override.
- Saving preserves omitted tuning fields and clears only explicit resets.
- Known model support is checked against effective tuning, including inherited effort and fast mode, with only Cligent's unreported adapter choices supplementing known efforts; unsupported values require explicit correction [[settings-34](settings.md#settings-34)].
- Choosing a player another binding already names states which bindings those are, because equal ids deliberately share one conversation.
- The editor is a popover anchored at the role's control, following the house popover idiom ([DR-010](../decisions/010-interface-craft.md) §6): focus enters it on open and returns to the control on close, and Escape, an outside click, and Cancel close it.

#### playbook-library-43

While the role-binding editor [[playbook-library-4](#playbook-library-4)] stands open, the Library shall keep it inside the box that must show it — the surface's own scroll box — at every width down to the 320-pixel floor ([DR-041](../decisions/041-chrome-that-fits.md)):

- that box bounds the editor's width, and a control late in a wrapping roles row moves the editor along the box's edge rather than past it, so a form surface never scrolls sideways to reach it.

#### playbook-library-38

Where a role's bound player is named by more than one binding, the Library shall mark that role's binding as shared and name the other positions holding the lane ([DR-032](../decisions/032-session-players.md)), so a shared conversation is never mistaken for two separate ones.

### Compile Flow

#### playbook-library-5

When the user starts the compile flow, the Library shall accept the playbook source as either a picked markdown file or in-app markdown text, and shall require the playbook's role names before compilation starts:

- A role name that does not match `^[a-z][a-z0-9_-]*$` is rejected before compilation starts.

#### playbook-library-6

While a compile is running, the Library shall display each phase of the compile pipeline ([DR-005](../decisions/005-compilation-integration.md)) with its name and live status — running, succeeded, or failed — updating as phases complete.

#### playbook-library-7

When the compile pipeline succeeds, the Library shall present a registry form with fields for command, intent, and summary policy, prefilled where derivable from the playbook source and compiled output, and shall resolve each submission of the form by the cases below:

- Submission passes registry validation [[playbook-library-15](#playbook-library-15)]: the Library registers the playbook by writing its entry — including a role binding per required role [[playbook-library-4](#playbook-library-4)], with any player the submission names but the roster lacks written first — into the shared config's `playbooks` map.
- Submission rejected: the rejection names the violated rule and causes no config write.

#### playbook-library-8

Where the compile toolchain cannot be resolved — no `slc`, or no Node.js meeting the version floor [[playbook-library-11](#playbook-library-11)] — the Library shall mark the compile flow unavailable, shall show guidance naming each missing prerequisite and how to install or configure it, and shall not start a compile.

#### playbook-library-9

While a compile is running, when a pipeline phase fails, the Library shall mark that phase failed, shall surface that phase's captured output, shall write nothing to the shared config, and shall allow the user to retry the compile after editing the source.

#### playbook-library-10

When a compiled playbook is registered, the Library shall list it with its registry fields and enabled state, and shall indicate that project sessions started before registration must be restarted before the playbook is available in them.

### Pipeline Artifacts

#### playbook-library-22

While a configured playbook is listed, the Library shall carry that playbook's compilation stages as a permanent row of toggles — Source (the workflow markdown the playbook was compiled from) → Gears (the GEARS spec items) → State machine (the compiled FSM) — whose pressed stage opens its artifact beneath the row:

- Pressing a closed stage opens it and closes the stage that was open, so one stage at a time stands open for that playbook; pressing the open stage closes it.
- The first open requests that playbook's artifacts [[playbook-library-24](#playbook-library-24)], which the card holds for its later opens; the open stage reads as loading until they arrive, and a failed request leaves its message in the open stage until a later press asks again.
- A markdown stage renders as formatted text; the State machine stage renders the FSM as code, with the derived state list standing outside the box as its pinned header, chips wrapping ([DR-041](../decisions/041-chrome-that-fits.md) §9), so the states hold their place at every scroll position and every height.
- The Gears stage stands instead as the outline's read-only item rows [[spec-view-3](spec-view.md#spec-view-3)] over the parse the playbook's artifacts carry [[playbook-library-24](#playbook-library-24)]: every row collapsed until pressed, an expanded row rendering the item's body, a citation of an item in the same artifact previewing it at hand [[spec-view-61](spec-view.md#spec-view-61)] and landing on that item within the box [[spec-view-6](spec-view.md#spec-view-6)], no control that edits, and the rendered markdown wherever that parse is absent.
- The open stage's artifact sits in a box that caps its height and scrolls, whose bottom edge carries the house's grip turned horizontal ([DR-030](../decisions/030-workspace-chrome.md)): dragged, or moved a step per arrow key while focused, it sets the box between 8rem and 48rem, a double-click restores the default 24rem, and the height is remembered for that playbook across launches, one height serving its stages.
- The grip stands only while the artifact runs past the box — a stage the box fits has nothing to page through, so the box takes the artifact's height and shows no edge to pull.

#### playbook-library-23

Where the artifacts a playbook served name a stage absent, the Library shall render that stage struck out and inactive in the playbook's stage row [[playbook-library-22](#playbook-library-22)] — its tooltip saying the stage was not found next to that playbook's registry — and shall name the absent stages inside the open stage, leaving every located stage open-able:

- Until a playbook's artifacts arrive, the row marks no stage absent.

### Pipeline Artifact Handling

#### playbook-library-24

When a client requests a playbook's artifacts, the core package shall resolve them from the registry module's location: the compiled library layout (`<id>.md`, `<id>.playbook/<id>.gears.md`, `<id>.playbook/<id>.fsm.ts`) and the published-package layout used by `@sublang/playbook` registries, serving each stage's content, the Gears stage also parsed into the item shape the outline's rows read [[spec-view-3](spec-view.md#spec-view-3)] — carried only where that parse yields an item, so a stage the parser cannot read serves its markdown alone — the state ids derived from the FSM, and the machine graph [[playbook-library-36](#playbook-library-36)] over the protocol, and naming absent stages without failing the request.

#### playbook-library-36

When the core package derives the current Library playbook's artifacts from its FSM, the core package shall serve the machine graph beside the state ids, derived from the machine's own config rather than its source text ([DR-028](../decisions/028-run-machine-view.md)):

- nodes carry the state id, its parent for a nested state, its kind (a final state named as such), the player role the state invokes when its meta names one, and its tags;
- edges carry a stable identity of owner state, event, branch index, and target index — guarded sibling branches staying distinct — with the event name as the label and an empty event naming the always transition;
- a target naming a state's declared id resolves to that state, wherever it sits in the tree — never assumed to be machine-id-prefixed ([DR-031](../decisions/031-machine-call-tree.md));
- a compound state's own done transition is an edge out of that state ([DR-031](../decisions/031-machine-call-tree.md));
- a machine-level transition, having no single source state, is no edge;
- the graph names its initial state;
- a machine that cannot be loaded serves a null graph, named among the absent stages without failing the request.

### Naming and Copy

#### playbook-library-26

The Library surface shall be presented to the user as "Playbooks": the navigation entry and the surface's user-facing copy shall say "Playbooks" or "playbook", reserving the word "library" for the on-disk compiled-artifact store, and shall name actions by their outcome — a built-in is enabled, a configured playbook is removed behind a confirm whose choices read "Remove" and "Keep" — never by the config write behind them ([DR-010](../decisions/010-interface-craft.md) §2).

#### playbook-library-29

While a configured playbook is listed, the Library shall label the playbook's registry source path with a muted "from" prefix that stays visible outside any truncation, and shall expose the full, untruncated path — introduced as the source the playbook was loaded from — in the entry's tooltip.

### Built-ins and Example

#### playbook-library-34

When the Library surface is opened, the Library shall list each known built-in playbook absent from the shared config ([DR-015](../decisions/015-reference-content.md)) with its command, intent, required roles, and browsable source markdown, and shall offer an enable flow — one "Enable" action per built-in, acknowledging while it writes — that gives each role a player and registers the playbook through the shared-config write path [[playbook-library-16](#playbook-library-16)]:

- Browsing a built-in's source requires no config change.
- With no playbook configured, the configured list says so and points at enabling a built-in below or compiling one.
- A role's proposed player id is `dev.<role>`, editable before it is written, because the id is the sharing decision ([DR-032](../decisions/032-session-players.md)).
- A proposed id the roster lacks is written to the roster first, carrying the agent block chosen for that role, so no binding is written dangling.

#### playbook-library-35

When the Library surface is opened, the Library shall present the slc demo workflow as a read-only example ([DR-015](../decisions/015-reference-content.md)) in the same permanent stage row a configured playbook wears [[playbook-library-22](#playbook-library-22)], over four stages held in memory rather than requested — source, normalized text, gears, and state machine — and shall offer a prefill action that fills the compile form with the example's normalized text and judgment fields — giving each of the example's roles the default agent block — without starting a compile:

- Sources and gears served for display drop their leading maintainer comment headers.

### Compile Cancellation

#### playbook-library-27

While a compile is running, the Library shall render a secondary cancel control beside the streamed compile progress and shall keep the compile start control disabled for the whole time the compile runs:

- Activating the cancel control requests that the core abort the compile ([DR-010](../decisions/010-interface-craft.md) §5), with the cancellation recorded in the compile progress log.

### Config Gate

#### playbook-library-28

While the shared config is missing or invalid, the Library shall replace its content with a gate that (1) explains that the Captain can only run playbooks listed on this surface, (2) states that playbooks need a valid config and directs the user to fix it in Settings, and (3) renders "Settings" as a navigation control when the host app provides surface navigation, falling back to plain text otherwise.

## Internal Behavior

### Toolchain Resolution

#### playbook-library-11

When toolchain resolution is requested, the toolchain resolver shall locate `slc` and `node` in this order — (1) an explicitly configured toolchain path in app settings ([DR-004](../decisions/004-config-and-persistence.md)), then (2) the captured login-shell `PATH` ([DR-004](../decisions/004-config-and-persistence.md)) — and shall verify that the resolved Node.js satisfies the version floor required by `slc` ([DR-005](../decisions/005-compilation-integration.md)):

- Any prerequisite unresolvable: the resolver returns an unavailability result naming that prerequisite and the locations attempted, and spawns no process.

### Compile Execution

#### playbook-library-12

When a compile is started for playbook id `<id>`, the compile runner shall run `slc` as an external child process in a per-playbook directory `<library-root>/<id>/` under the app-managed library root ([DR-004](../decisions/004-config-and-persistence.md)) — materializing in-app source text as a markdown file there and linking the app-bundled runtime contract ([DR-005](../decisions/005-compilation-integration.md)) — and shall capture the process output per pipeline phase, reporting phase transitions for progress [[playbook-library-6](#playbook-library-6)] and the failing phase's output on failure [[playbook-library-9](#playbook-library-9)]:

- Compiled outputs of a previously successful compile for the same id are replaced only after the new compile succeeds.

### Registry Generation

#### playbook-library-13

When `slc` completes successfully, the registry generator shall derive `idleStateId`, `finalStateId`, and `parkStateIds` by introspecting the emitted machine definition ([DR-005](../decisions/005-compilation-integration.md)), each derived id naming a state present in that machine, and shall report them as compile metadata for display [[playbook-library-22](#playbook-library-22)] — never as registry-entry fields ([DR-014](../decisions/014-released-toolchain.md)):

- Ambiguous derivation: the registry generator surfaces the candidate state ids for user selection in the registry form [[playbook-library-7](#playbook-library-7)] instead of choosing silently.

#### playbook-library-14

When the registry form [[playbook-library-7](#playbook-library-7)] is submitted with valid entries, the registry generator shall emit a registry manifest module into the playbook's library directory as a thin wrapper over the `slc`-emitted registry entry ([DR-014](../decisions/014-released-toolchain.md)), returning the manifest path for the config entry's `from` key and the derived role ids:

- the user's command and intent override the entry's;
- every other member of the entry passes through unchanged, including the role ids in their authored casing and the artifact schema the entry advertises — under artifact schema 2 a role is a playbook-local slot a user binds to a player, not a host player id ([DR-032](../decisions/032-session-players.md));
- the module carries the registry-contract marker;
- two role ids colliding fails the compile naming the offending role.

### Registry Validation

#### playbook-library-15

When a registry entry is about to be registered into the shared config, the registry validator shall apply the same fail-closed rules the playbook loader applies at load ([DR-004](../decisions/004-config-and-persistence.md)) — including: the `playbooks` key equals the manifest id; the manifest at `from` imports successfully; no duplicate id or command among configured playbooks; no reserved captain role among role names; every required role resolved; at least one visible role; every agent resolving a supported adapter — and shall reject a violating registration naming the violated rule, leaving the shared config file unmodified.

### Portable Library

#### playbook-library-46

When a compiled playbook is registered, the Library shall retain its source, write a config-relative managed locator, and ensure generated files relocate or rebuild before use [[storage-8](storage.md#storage-8)], resolving the same locator for loading, validation and artifact lookup [[storage-7](storage.md#storage-7)].

### Config Writes

#### playbook-library-32

When a registration writes the `playbooks.<id>` entry after a compile, the compile flow shall re-key the submitted role bindings onto the derived role ids [[playbook-library-14](#playbook-library-14)] by case-insensitive name match:

- A derived role matching no binding: the compile flow fails naming the derived roles and the unmatched ones, writes no config change, and keeps the compiled artifacts so a corrected submission can register without recompiling.

#### playbook-library-33

When playbook loading imports a config `from` module that is a file path, and the module carries no registry-contract marker [[playbook-library-14](#playbook-library-14)], the registry validator shall treat the config as invalid with guidance naming the playbook and recompilation as the remedy ([DR-014](../decisions/014-released-toolchain.md)):

- A package specifier `from` does not require the marker.

#### playbook-library-16

When the config writer updates the shared config file — enabled state [[playbook-library-3](#playbook-library-3)], role-binding edits [[playbook-library-4](#playbook-library-4)], or registration [[playbook-library-7](#playbook-library-7)] — it shall preserve comments, key order, and formatting of untouched content byte-for-byte, shall modify only the targeted keys, and shall replace the file atomically so an interrupted write cannot leave a partially written config.

## Verification

### Compile Coverage

#### playbook-library-17

Where a stub `slc` executable that emits a valid compiled playbook output is placed on the toolchain resolution path, when the compile flow is driven end to end — source provided [[playbook-library-5](#playbook-library-5)], role names entered, registry form submitted [[playbook-library-7](#playbook-library-7)] — the test suite shall assert that the stub ran as an external process in the per-id library directory [[playbook-library-12](#playbook-library-12)], that a registry manifest was emitted whose entry passes the fail-closed registry validation [[playbook-library-15](#playbook-library-15)], that the shared config gained a `playbooks.<id>` entry whose `from` resolves to that manifest [[playbook-library-14](#playbook-library-14)] and whose role bindings are keyed by the entry's derived role ids however the submission cased them [[playbook-library-32](#playbook-library-32)], and that the Library lists the new playbook [[playbook-library-10](#playbook-library-10)].

#### playbook-library-18

Where no `slc` is resolvable, or the resolved Node.js fails the version floor [[playbook-library-11](#playbook-library-11)], the test suite shall assert that the compile flow is reported unavailable with guidance naming the missing prerequisite [[playbook-library-8](#playbook-library-8)], that no external process is spawned, and that the shared config file is unmodified.

#### playbook-library-19

Where a stub `slc` fails at a known pipeline phase with error output, when a compile is run, the test suite shall assert that the failing phase is identified, that the phase's captured output is surfaced [[playbook-library-9](#playbook-library-9)], that no config write occurs, and that previously compiled outputs for the same playbook id remain unchanged [[playbook-library-12](#playbook-library-12)].

### Registration and Config Coverage

#### playbook-library-20

When the registry form [[playbook-library-7](#playbook-library-7)] is submitted with an entry violating a fail-closed rule, covering at least a command duplicating an existing playbook's and an id failing the `^[a-z][a-z0-9_-]*$` character rule ([DR-004](../decisions/004-config-and-persistence.md)), the test suite shall assert that each submission is rejected naming the violated rule [[playbook-library-15](#playbook-library-15)] and that the shared config file bytes are unchanged.

#### playbook-library-21

Where the shared config file contains comments and entries unrelated to the toggled playbook, when a playbook is disabled and then re-enabled [[playbook-library-3](#playbook-library-3)], the test suite shall assert after each write that comments and unrelated entries are byte-identical to the original [[playbook-library-16](#playbook-library-16)] and that the list reflects the new state, and after the round trip that the playbook's entry is enabled again.

#### playbook-library-25

Where a playbook was compiled into the library directory, when its artifacts are requested over the protocol, the test suite shall assert the response carries the source markdown, the gears markdown, the FSM code [[playbook-library-22](#playbook-library-22)], the derived state ids, and that gears markdown parsed into items in document order, each with its first line, body, and citations [[playbook-library-24](#playbook-library-24)]:

- A stage file removed: the test suite asserts the response names the missing stage while still serving the others [[playbook-library-24](#playbook-library-24)].
- Gears the parser reads no item from: the test suite asserts the markdown still serves, with no parsed items beside it [[playbook-library-24](#playbook-library-24)].

#### playbook-library-44

When each installed built-in playbook's artifacts are requested, the test suite shall assert that built-in's shipped gears file is served parsed [[playbook-library-24](#playbook-library-24)]: at least one item, every item carrying an ID of the authored casing, a non-empty first line, and a body, with the markdown the rows fall back to still served beside them.

#### playbook-library-37

When each installed built-in playbook's artifacts are requested, the test suite shall assert the served graph is whole [[playbook-library-36](#playbook-library-36)]: every edge's ends name served nodes, the edge set is non-empty for every built-in, declared-id targets resolve — the review machine's opening transition and a boss-reply resume transition among the resolved — and a compound state's done transition appears as an edge.

### Binding Coverage

#### playbook-library-39

Where a configured playbook binds two roles, one to a player another playbook also names, the test suite shall assert the Library prints each role's bound player with what that binding effectively runs [[playbook-library-1](#playbook-library-1)], marks the shared role and names the other position holding it [[playbook-library-38](#playbook-library-38)], and leaves the unshared role unmarked; and that rebinding through the editor offers exactly the config's roster, writes the chosen player with pinned effort and inherit/on/off fast mode while preserving untouched tuning and comments, checks effective inherited tuning against known model support, keeps a cleared pin in pin mode with an inline error and no write, and surfaces a refusal inline while keeping the editor open [[playbook-library-4](#playbook-library-4)]; and that the editor opens with focus inside and closes on Escape, on an outside click, and on Cancel with focus back on the role's control [[playbook-library-4](#playbook-library-4)].

#### playbook-library-40

When a built-in whose roles the roster does not cover is added, the test suite shall assert the missing player is written to the roster first, carrying the block chosen for its role, and only then the playbook entry binding that role to it [[playbook-library-34](#playbook-library-34)].

### Cancellation and Gate Coverage

#### playbook-library-45

Where a configured playbook's artifacts carry a parsed Gears stage of two items, one citing the other, when the Gears stage is opened, the test suite shall assert the card draws the outline's rows [[playbook-library-22](#playbook-library-22)]: each row collapsed on its ID, group, and first line with no edit control, a pressed row rendering its body, a settled hover on the citation previewing the cited item and its jump dismissing that preview, the citation landing on the cited row expanded and highlighted without leaving the card, and — where the parse is absent — the gears markdown rendered instead.

#### playbook-library-30

While a compile driven through the app store is running, the test suite shall assert that a cancel control is rendered beside the compile progress output, that activating it issues the compile abort command for the running playbook id [[playbook-library-27](#playbook-library-27)], that the recorded cancellation appears in the progress log, and that the compile start control stays disabled until the compile settles.

#### playbook-library-31

Where the shared config state is missing or invalid, the test suite shall assert that the Library renders the config gate — the Captain-scope explanation and the fix-it-in-Settings direction [[playbook-library-28](#playbook-library-28)] — with "Settings" as an activatable navigation control when a navigation callback is supplied and as plain text when it is not, and that no playbook list or compile form is rendered.

### Browser Journeys

#### playbook-library-41

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell on the demo config, when the journey works the Playbooks surface through the page, the test suite shall assert:

- every configured playbook lists with its command, intent, and role bindings [[playbook-library-1](#playbook-library-1)];
- the built-ins absent from the config list beside them, and enabling one writes it to the config and lists it among the configured playbooks, after which the Captain home's slash menu offers its command [[playbook-library-34](#playbook-library-34)];
- a playbook's stage row opens the stage pressed, swaps to another pressed beside it, and closes on a second press of the open one [[playbook-library-22](#playbook-library-22)];
- the Gears stage stands as item rows carrying the artifact's own IDs, one of which expands to its body [[playbook-library-22](#playbook-library-22)];
- the State machine stage's state list stays in view with its box scrolled to the bottom [[playbook-library-22](#playbook-library-22)];
- the open stage's box carries a grip that names the stage, and a drag of it leaves the box taller with the height still standing after a reload [[playbook-library-22](#playbook-library-22)];
- removing a configured playbook asks for the inline confirm — Remove or Keep [[playbook-library-26](#playbook-library-26)] — then leaves the config without it [[playbook-library-16](#playbook-library-16)];
- a role's binding editor opened at the 320-pixel viewport floor stands wholly inside the surface's box, which scrolls in neither direction [[playbook-library-43](#playbook-library-43)].

#### playbook-library-47

When the integration suite copies a registered library to a differently located Spex root, it shall verify config-relative module and artifact resolution, retained sources and successful local rebuilding or an explicit unavailable result [[playbook-library-46](#playbook-library-46)].
