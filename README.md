<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Spex: the spec-first IDE

[![npm version](https://img.shields.io/npm/v/@sublang/spex)](https://www.npmjs.com/package/@sublang/spex)
[![Node.js](https://img.shields.io/node/v/@sublang/spex)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/spex/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/spex/actions/workflows/ci.yml)

*Specs are the source.*

## Why Spex

When programming shifts from code to specifications, four problems keep
showing up:

1. **Flat, lengthy spec text** burdens people and AI alike. Ambiguity,
   redundancy, and inconsistency hide in prose.
2. **Skills written in natural language drift.** Editing and managing them
   is unpredictable, so long-running tasks are hard to trust.
3. **A single agent's work is often defective** and cannot be delivered with
   confidence.
4. **Supervising several agents is exhausting.** Attention scatters, intents
   get forgotten, and the mental burden grows.

Spex answers each with one systematic design:

1. **Structured specs.** Requirements become itemized, normalized statements,
   grouped into spec packages that cite one another. The structure exposes
   ambiguity and redundancy, drives out inconsistency, and gives the system's
   concept design high cohesion and loose coupling: the ground for long-term
   maintainability.
2. **A natural-language compiler.** A workflow described in prose compiles
   into a state machine whose predefined states and transitions form a
   deterministic control mechanism. Agents act within those boundaries, so
   long tasks run reliably.
3. **Playbooks of mutually checking agents.** Several agents on several LLMs
   challenge and verify each other, cutting hallucinations and defects before
   delivery.
4. **A Dashboard that decouples intents from sessions.** Work is organized
   around what you intend rather than around chats, which sharply lowers the
   mental burden.

## Getting started

Requires Node.js 20 or later.

**1. Scaffold `specs/` in your project.**

```sh
npx @sublang/spex scaffold                        # create specs/
npx @sublang/spex scaffold --agents=claude,codex  # choose coding agents
npx @sublang/spex scaffold --lang zh              # Chinese templates where available
npx @sublang/spex scaffold --update               # refresh the scaffold
npx @sublang/spex lint                            # check the tree
```

The scaffold holds decision records, intent records, and one Markdown file
per spec package, each stating its intent, External Behavior, optional
Internal Behavior, and Verification
([meta-30](specs/meta.md#meta-30),
[DR-000](specs/decisions/000-spec-structure-format.md)).
It also installs a managed specs section in the instruction file of each
chosen agent: `CLAUDE.md`, `AGENTS.md`, or `GEMINI.md`
([scaffold-5](specs/packages/scaffold.md#scaffold-5)).
`spex lint` checks layout, sections, IDs, citations, records, and the map
([lint-3](specs/packages/lint.md#lint-3)).
`--update` needs a clean `specs/` tree, refreshes Spex-owned files, and
prints an agent prompt for the judgment work, including migration of a
spex 0.x tree ([scaffold-11](specs/packages/scaffold.md#scaffold-11),
[scaffold-26](specs/packages/scaffold.md#scaffold-26)).

**2. Develop through playbook workflows that keep the specs in sync.**
Use the built-ins, typically `/decide` to record a decision and `/code` to
implement an intent under review, or compile your own workflow from prose
with [`slc`](https://github.com/sublang-ai/slc).

**3. Work in the Spex IDE**, where specs, playbook runs and compilation, and
the intent Dashboard live together. Desktop and server hosts require macOS
or Linux and a filesystem that enforces private POSIX permissions. Windows
supports the scaffold CLI and browser access to a Spex server.
Run the app from source:

```sh
git clone https://github.com/sublang-ai/spex.git
cd spex
npm ci
npm start
```

`npm start` builds the workspaces and launches the desktop app. Real
playbook runs need a ready coding-agent adapter; issue and PR panels need
an authenticated `gh` CLI; compiling playbooks needs `slc`.
App releases on [GitHub Releases](https://github.com/sublang-ai/spex/releases)
(`app-v*` tags) ship as source with a changelog: check out the tag and run
the commands above.

To use Spex from another machine, run the server shell instead. It serves
the UI and the core on one port behind a token in the URL, binds loopback by
default, and prints an SSH tunnel line; a public bind needs
`--tls-cert`/`--tls-key`
([server-shell-1](specs/packages/server-shell.md#server-shell-1),
[server-shell-2](specs/packages/server-shell.md#server-shell-2)).

```sh
npm run start:server     # prints http://127.0.0.1:8137/?token=...
```

## Repository

| Path | Purpose |
| --- | --- |
| [`specs/`](specs) | Source of truth for this repository; start at the [spec map](specs/map.md) |
| [`scaffold/`](scaffold), [`packages/cli`](packages/cli) | Shipped templates and the npm CLI |
| [`packages/core`](packages/core), [`packages/ui`](packages/ui) | Headless service and protocol-only web UI |
| [`apps/desktop`](apps/desktop) | Electron shell |
| [`apps/server`](apps/server) | Server shell for remote browser access |
| [`demo/`](demo) | Academy example and spec-package case study |

For development: `npm ci`, `npm run build`, `npm test`; `npm run e2e` drives
the served UI through its user journeys in Chromium (after a one-time
`npx playwright install chromium`). Maintainers also use the
[release smoke checklist](docs/release-smoke.md).

Contributions are welcome through
[issues](https://github.com/sublang-ai/spex/issues),
[pull requests](https://github.com/sublang-ai/spex/pulls), and
[Discord](https://discord.gg/XxTPjNqy9g).

Licensed under [Apache-2.0](LICENSE).
