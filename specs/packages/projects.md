<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# projects: Projects

## Intent

This spec covers project management in the Spex desktop app — its palette and Overview-tab behavior, the core-service implementation behind it, and the integration coverage that verifies both.
Users register and create local git projects in the project palette, and the workspace's Overview tab shows the project's ledger group under its repository and GitHub state: a project is a local git repository, with registry persistence in the app state root, repository state collected from local git only, and forge access exclusively through the forge adapter interface.
Integration coverage exercises registration and card state against fixture repositories, the create-project flow, forge panels against a stubbed gh CLI, and removal without touching the repository on disk.

## External Behavior

### Registration

#### projects-1

When the user confirms a directory in the project palette, the palette shall resolve the confirmed directory by the cases below:

- The top level of a git work tree: the palette registers the directory as a project and makes it the workspace's current project.
- Inside a work tree below its top level: the palette registers nothing and shows a message naming the work tree's top-level path.
- No git work tree at all: the palette registers nothing and shows a message naming the condition and pointing at the Create action [[projects-22](#projects-22)], which initializes the repository on the same path — an existing-repo action never initializes a repository on its own.

#### projects-2

While a project is already registered for a path, when the user confirms that same path in the project palette, the palette shall switch to the existing project and shall not create a second project entry.

### Creation

#### projects-3

Where the specs-scaffold option is backed by the spex scaffold generator [[scaffold-1](scaffold.md#scaffold-1)], when the user submits the project palette's create action with a path and the scaffold option on or off, the palette shall:

1. create the project directory under the parent directory,
2. initialize a git repository in it,
3. generate the spex specs scaffold in it when the scaffold option is on, and generate no scaffold when it is off,
4. create an initial commit containing the generated files, and
5. register the project and make it the workspace's current project.

- Any step failing: the palette reports the failure, does not register the project, and leaves already-created files on disk for inspection.

#### projects-27

When the user picks the palette's Academy-example action ([DR-015](../decisions/015-reference-content.md)), the palette shall create the project from the bundled Academy corpus — into a new or empty directory only — initialize a git repository with one seed commit of the corpus, and register the project and make it the workspace's current project:

- Target directory not empty: the palette reports the refusal and registers nothing.

### The Overview Tab

#### projects-4

While a project is the workspace's current project, the Overview tab shall show the project's ledger group — History, Now, Up next, and Sources exactly as the Dashboard draws it for that project [[dashboard-26](dashboard.md#dashboard-26)], with no project filter — under a repository header carrying the fields below ([DR-038](../decisions/038-history-is-done-work.md)):

| Field | Content |
| --- | --- |
| name | the project name |
| path | the absolute repository path |
| branch | the current branch name, or a detached-HEAD indicator |
| dirty | an indicator shown while the work tree has uncommitted changes, and hidden while it is clean |
| ahead/behind | commit counts relative to the upstream branch, hidden while no upstream is configured |

### Forge Binding

#### projects-5

Where a project's `origin` remote resolves to a GitHub repository, the forge panel shall show the bound `owner/repo` derived from the `origin` remote and the gh CLI authentication status: the authenticated account, or a not-authenticated indication.

#### projects-6

Where a project is bound to a GitHub repository, while the gh CLI is installed and authenticated, the forge panel shall show the repository's open issues and open pull requests in the row representation shared with the Dashboard's Sources rows [[forge-work-lists-1](forge-work-lists.md#forge-work-lists-1)] — each entry with its number, its title, its forge labels as tags, and a Queue control capturing the entry as an intent:

- Activating an entry's title opens that entry's GitHub page in the default browser.
- An entry whose issue or pull request already has an open intent shows that intent's state in place of the Queue control, and regains the control when that intent closes.

#### projects-7

Where a project has no GitHub binding, or the gh CLI is not installed or not authenticated, the forge panel shall show setup guidance naming the specific unmet condition — no GitHub `origin` remote, gh not installed, or gh not authenticated — instead of issue and pull-request lists:

- While the panel shows setup guidance, the Overview tab keeps showing repository state [[projects-4](#projects-4)] and its remove control remains functional.
- The Overview's header names the guidance beside the repository state, so the reason GitHub is empty is read without opening the Sources band.

### Session and Removal

#### projects-8

When the user picks a project from the palette or opens one of its sessions from the Dashboard, the workspace shall switch to that project, restoring its last-active tab — except when a session in it needs a human, in which case that session's tab shall be focused, per [DR-011](../decisions/011-project-workspace.md).

#### projects-9

When the user confirms removal in the Overview tab, the workspace shall forget the project and clear it from the sidebar, leaving the repository directory, its files, and its git state on disk unmodified:

- While a session of the project has a turn in flight, the Overview tab disables removal, stating that the running turn must finish or be aborted first ([DR-051](../decisions/051-runtime-held-for-a-turn.md)).
- Removal confirms inline with Remove and Keep ([DR-010](../decisions/010-interface-craft.md) §4); Keep returns focus to the Remove control, and a completed removal moves focus to the sidebar's Dashboard entry — never to the page body.

### Labels and Vocabulary

#### projects-22

The project palette's path row shall offer distinct "Add" (an existing repo) and "Create" (a new project) actions on the typed path, and the palette shall list projects with filter-as-you-type matching on name and path:

- With no project registered there is nothing to filter: the palette drops its filter, names itself an add flow, opens with the path field focused and its placeholder saying a project is added by path, and leads its list with the Academy-example action [[projects-27](#projects-27)].

#### projects-23

While a project has sessions with a turn in flight or sessions needing a human, its palette row shall show that state — a pulsing emerald dot with the running count, and an amber (question) or red (failure) dot with the needs-you count — with text labels alongside the colors ([DR-010](../decisions/010-interface-craft.md) §7/§8).

#### projects-24

Where the palette's create action offers the specs-scaffold option, the option shall be labeled to say it applies when creating, appear once a path is typed beside the actions it qualifies, and default to on.

#### projects-25

User-facing copy in the palette and the Overview tab shall use plain words — "GitHub" for the forge, "Add" and "Create" for the path actions, sentence case throughout — and shall not use an internal term such as "forge", "stamp", or "ledger" ([DR-010](../decisions/010-interface-craft.md) §2).

### Surface Fit

#### projects-30

While the project palette is open, the palette shall stand inside the window at every window height ([DR-041](../decisions/041-chrome-that-fits.md) §9), the project list yielding so the path row, its options, and any failure message [[projects-1](#projects-1)] keep their place:

- the palette is a fixed overlay that nothing can scroll, so what falls outside the window is unreachable;
- the gap above the palette is a proportion of a tall window and stops growing in a short one.

## Internal Behavior

### Registry

#### projects-10

Where the core manages projects, the registry shall persist stable identities separately from machine-local paths [[storage-2](storage.md#storage-2)] [[storage-3](storage.md#storage-3)], using explicit identity-preserving rebinding and Git restoration [[storage-6](storage.md#storage-6)] ([DR-045](../decisions/045-unified-session-storage.md)):

- removing a project removes its registration only; repository, session and intent files remain;
- unresolved or orphaned identities are reported without automatic registration or a replacement UUID.

### Repository State

#### projects-11

Where project repository state is collected — current branch or detached HEAD, dirty flag, ahead/behind counts, and `origin` remote URL — the repo-state provider shall obtain it exclusively by running local git commands against the project work tree:

- The repo-state provider performs no network operation while collecting state, so ahead/behind counts reflect the locally recorded upstream ref.

#### projects-12

While projects are registered, when the app window gains focus, and on a periodic interval bounded between 10 seconds and 5 minutes, the repo-state provider shall refresh the projects' repository state:

- A failed refresh attempt for a project keeps that project's last successfully collected state available, marked stale, and does not terminate the core service.

### Forge Access

#### projects-13

Where a project's `origin` remote URL matches a GitHub HTTPS or SSH remote form, the binding detector shall derive the bound `owner/repo` from the URL:

- No `origin` remote, or a URL matching neither form: the binding detector reports the project as unbound rather than guessing a binding.

#### projects-14

Where core code needs forge data or forge authentication status, the core service shall obtain it exclusively through the forge adapter interface of [DR-006](../decisions/006-projects-and-forge.md); no module outside adapter implementations shall invoke a forge CLI or forge HTTP API directly, so further forges can be added without changing callers.

#### projects-15

Where the GitHub forge adapter performs an operation — auth status, issue listing, or pull-request listing — it shall shell out to the locally authenticated `gh` CLI [[1]] requesting machine-readable JSON output, and parse that output:

- The GitHub forge adapter never reads, persists, or logs tokens or other credentials; authentication state remains solely in gh's own storage.

#### projects-16

When a forge adapter operation fails — executable missing, not authenticated, network failure, non-zero exit, or unparsable output — the forge adapter shall return a typed failure carrying a condition category and human-readable guidance:

- The core service forwards that guidance as the forge panel state for the affected project and neither crashes nor stops serving the project's other state.

## Verification

### Registration and Card Coverage

#### projects-17

Where a fixture git repository exists with a named branch checked out, an uncommitted change, and a local upstream remote that it is ahead of and behind by known commit counts, when the repository is registered through the registration flow [[projects-1](#projects-1)], the test suite shall assert that a project card appears showing the project name, the absolute path, the branch name, a dirty indicator, and the expected ahead/behind counts [[projects-4](#projects-4)], collected without any network access [[projects-11](#projects-11)], and shall assert the palette cases below:

- Confirming the same path again creates no duplicate entry [[projects-2](#projects-2)].
- Explicit rebinding selects an existing ID or restores its exact registration from Git ancestry; a missing or conflicting binding prompts selection without silently minting or registering an identity [[projects-10](#projects-10)].
- Confirming a directory inside a work tree below its top level is rejected with a message and creates no project entry [[projects-1](#projects-1)].
- Confirming a directory that is no Git work tree registers nothing and points to the Create action [[projects-1](#projects-1)].

#### projects-18

Where a temporary parent directory exists, when the create-project flow completes, the test suite shall assert the scaffold option's cases below:

- Scaffold option on: the project directory exists, is the top level of a git work tree, contains the generated specs scaffold, and has an initial commit containing the generated files, and a project card for it appears [[projects-3](#projects-3)].
- Scaffold option off: the directory, git repository, initial commit, and project card still result while no specs scaffold is generated [[projects-3](#projects-3)].

### Forge Coverage

#### projects-19

Where a registered fixture repository's `origin` remote points at a GitHub repository, and a stub `gh` executable on `PATH` reports an authenticated account and returns fixture JSON for issue and pull-request listings [[projects-15](#projects-15)], when the project's forge panel is loaded, the test suite shall assert that the panel shows the bound `owner/repo` derived from the remote [[projects-5](#projects-5)] [[projects-13](#projects-13)], the authenticated account, and the fixture issues and pull requests with their numbers, titles, forge labels as tags, and Queue controls [[projects-6](#projects-6)], and that activating an entry's title passes that entry's GitHub URL to the stubbed browser opener [[projects-6](#projects-6)].

#### projects-20

Where the stub `gh` reports a not-authenticated state, or `gh` is absent from `PATH`, or the registered repository has no GitHub `origin` remote, when the project's forge panel is loaded, the test suite shall assert that setup guidance naming the specific unmet condition is shown instead of issue and pull-request lists [[projects-7](#projects-7)], that the project card still shows repository state, and that the core keeps serving subsequent commands [[projects-16](#projects-16)].

### Removal Coverage

#### projects-21

Where a fixture repository is registered, when the project is removed and the core service is restarted, the test suite shall assert that no project card or registry entry for it remains, its session and intent files remain unlisted without automatic registration [[projects-10](#projects-10)], and the repository directory's files and git state are identical to their state before removal [[projects-9](#projects-9)].

### Label Coverage

#### projects-26

Where the project palette renders with one project holding a live session and one without, the test suite shall assert that the mode choices read "Add an existing repo" and "Create a new project" with the submit label mirroring the selected mode [[projects-22](#projects-22)], that the live project's open control reads "Open live session" and carries the pulsing status dot while the other project's reads "Open session" [[projects-23](#projects-23)], and that no user-facing string on the surface contains the word "forge" [[projects-25](#projects-25)].

### Browser Journeys

#### projects-28

Where the browser journey harness ([DR-039](../decisions/039-browser-acceptance-journeys.md)) boots the served shell with no project, the test suite shall assert the project journey through the page:

- the palette's Academy action seeds the example, which becomes the current project [[projects-27](#projects-27)];
- confirming a path that is no git work tree shows the guidance and registers nothing [[projects-1](#projects-1)];
- confirming an existing repository's path adds it and makes it current, and confirming the same path again switches to it without a duplicate [[projects-1](#projects-1)] [[projects-2](#projects-2)];
- the Overview tab shows the repository's branch and, for a project with no GitHub origin, the setup guidance naming that condition in GitHub terms [[projects-4](#projects-4)] [[projects-7](#projects-7)] [[projects-25](#projects-25)];
- confirming removal in the Overview forgets the project, clears it from the sidebar, and leaves the directory in place [[projects-9](#projects-9)];
- in a 400-pixel-tall window, a path the palette refuses shows its message inside the window, the palette's own box ending inside it [[projects-30](#projects-30)].

## References

[1]: https://cli.github.com/manual/ "GitHub CLI manual"
