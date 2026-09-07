<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-002: Spex Desktop App Architecture

## Status

Accepted; the Settings surface's profile inventory is amended by [DR-019](019-inline-agent-configuration.md) — agents carry inline settings, so Settings owns the Captain's agent and adapter readiness while per-role agents live with their playbooks; distribution is amended by [DR-040](040-source-only-app-releases.md) — app releases ship as source on GitHub Releases, with binaries deferred until signing exists.
Supported host platforms are amended by [DR-049](049-supported-app-hosts.md).
The project session's one-live-session rule is amended by [DR-051](051-runtime-held-for-a-turn.md): one working turn per project, the runtime held only for a turn.

## Context

- cligent's `tmux-play` host proved the playbook runtime end to end, but the tmux UI is limited: keystroke interaction, static pane text, no persistence, no dashboard.
- The product owner decided (2026-07-10) to build a downloadable desktop app for running playbooks, in this repo, keeping `tmux-play` as a verification fallback of the playbook logic.
- All orchestration already exists as headless Node libraries: `@sublang/cligent` exports a headless runtime (`createTmuxPlayRuntime`) whose `RecordObserver` stream carries every UI-relevant event, and `@sublang/playbook` exports the Playbook Captain shell with type-only coupling to the host.
- The app must port to a cloud web app with least effort.
- This repo currently is the `@sublang/spex` scaffold CLI, published from the repo root on `v*` tags with a CI-green gate, tag/version match, and changelog extraction.
- The `Spex` brand already fronts the tmux-play surface (its status-line heading); the product owner chose the desktop app as the brand's flagship: the app is Spex.

## Decision

### Product

- The app is named **Spex**: a desktop app to compile, configure, run, and monitor playbooks over local projects.
- Distribution is via GitHub Releases; the app itself is not published to npm.
- First platform target: macOS arm64, unsigned local/dev builds; Windows/Linux and code signing follow later.

### Three-layer, web-first architecture

- **Core** (`packages/core`): a headless Node service owning all state and side effects — config composition, project sessions, the embedded playbook host (see [DR-003](003-runtime-reuse.md)), compilation, forge access, and persistence.
  It exposes one typed WebSocket API and serves no HTML.
- **UI** (`packages/ui`): a pure web SPA (React + Vite + Tailwind + shadcn/ui) that renders core state and sends commands over the WebSocket API.
  It never imports Node-only modules; everything it knows arrives through the protocol.
- **Shell** (`apps/desktop`): an Electron [[1]] wrapper that boots the core in-process, loads the built UI, and adds OS integration (notifications, dock badge, file dialogs, login-shell environment capture).
- The cloud port is the same core behind a server socket and the same UI served as static assets; only the shell layer is replaced.
  Multi-tenant auth for the cloud variant is explicitly out of scope here.

### Protocol

- The WebSocket protocol is the single seam between core and UI: JSON messages, schema-validated at both ends, versioned, defined once in `packages/core` and imported by the UI as types.
- Commands flow UI→core; state snapshots, deltas, and record streams flow core→UI.
- The protocol shall stay transport-portable (plain WebSocket, no Electron IPC dependency) so the web port does not touch it.

### Concept model

```text
Spex
├── Workspace surfaces
│   ├── Dashboard  — attention queue, running sessions, issues to do / PRs to review, usage
│   ├── Projects   — local git repo + forge binding; a project is the run environment (cwd)
│   ├── Library    — playbooks: browse, enable, map players to profiles, compile new ones
│   └── Settings   — profiles, captain, layout, notifications, adapter readiness
├── Project session (at most one live session per project)
│   ├── Captain pane   — status glyphs, engagement state, captain chat
│   ├── Player panes   — read-only streaming transcripts, visibility-driven
│   ├── Boss composer  — the single input; slash commands and free text
│   └── Engagement     — one active playbook; parks and resumes; switch = finish or dismiss
└── Foundations
    ├── Core service   — config, sessions, record bus, persistence, WebSocket API
    └── Existing stack — cligent adapters and runtime, playbook captain shell, slc compiler
```

### Monorepo and release preservation

- The repo converts to npm workspaces:

| Path | Package | Published |
| --- | --- | --- |
| `packages/cli` | `@sublang/spex` (existing scaffold CLI) | npm, unchanged identity |
| `packages/core` | `@sublang/spex-core` | private for now |
| `packages/ui` | `@sublang/spex-ui` | private |
| `apps/desktop` | Spex Electron app | GitHub Releases |

- The root `package.json` becomes a private workspace root; `specs/` stays at the repo root and covers all packages.
- The CLI keeps its npm identity, bin, files whitelist, tests, and `CHANGELOG.md` (which moves with it to `packages/cli/`).
- `v*` tags keep releasing the CLI exactly as today; the release workflow is updated to build, validate, version-check, and publish from `packages/cli`.
  The CI-green gate ([[release-18](../packages/release.md#release-18)]) is unchanged and now covers all workspaces.
- Desktop app releases use a distinct tag namespace (`app-v*`) added in a later iteration, so CLI and app release cadences stay independent.

## Consequences

- The UI is portable by construction; the cloud web app is a deployment task, not a rewrite.
- Everything the panes show comes from one observer stream, so tmux-play and Spex render the same truth — tmux-play remains a faithful verification twin.
- Electron adds ~120 MB download weight; accepted for v1 in exchange for zero-glue reuse of the Node ecosystem (cligent, playbook, agent SDKs).
- Two release channels live in one npm-workspaces [[2]] repo; tag namespaces (`v*` vs `app-v*`) and workspace-scoped workflows must stay disjoint.
- The scaffold CLI move to `packages/cli` touches the release workflow; the npm tarball must be verified equivalent before the first post-move release.
- Native binaries spawned by agent SDKs constrain Electron packaging (asar unpacking); handled in the shell layer.

## References

[1]: https://www.electronjs.org/docs/latest "Electron documentation"
[2]: https://docs.npmjs.com/cli/v10/using-npm/workspaces "npm workspaces"
