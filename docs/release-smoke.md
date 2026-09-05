<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Release Smoke Checklist

Run before tagging an app release (release-20, release-21). The
automated suite comes first; the manual passes exercise what
automation cannot — real agents, packaging, and look-and-feel. A CLI
release runs `npm run smoke` (release-20) and the live migration
smoke (release-24), not this checklist.

App hosts require macOS or Linux with private POSIX storage. CI runs the
complete suite on both. Windows CI builds every workspace and tests the
scaffold CLI, browser UI, and refusal of native app startup (DR-049).

## 1. Automated suite (hermetic — the tagging gate)

```bash
npm run smoke -- --desktop
```

Stages: build → spec lint → unit and integration tests (one pass) →
browser journeys (the served UI in Chromium against a real core with
substitute agents: first run, palette, Specs, a session, the ledger,
Settings, Playbooks, the token URL, an unreachable core, keyboard,
accessibility in both themes, config repair) → core round-trip
(template composes with `/code`, `/review`, and `/decide` as inline
agent blocks, builtin catalog and artifacts served, Academy example
seeds and its tree parses) → packed CLI user journeys → Electron
render with screenshot (`--desktop` flips the native ABI to Electron
and restores it on every exit path).
Omit `--desktop` for a quick mid-development pass.
No provider or sign-in is involved, and the render boots on a scratch
state root, so a running Spex desktop does not block it; a failure
names its stage.

To resume after a corrected failure, use `--from=<stage>` only after every
earlier stage has passed on its current inputs. For example,
`npm run smoke -- --desktop --from=browser` resumes at browser setup.
Record the earlier results and any targeted reruns with the resumed run.

## 1b. Live desktop smoke (signed-in — the app-release gate)

```bash
npm run smoke:desktop
```

After a successful build, use `SPEX_SMOKE_BUILD_READY=1 npm run
smoke:desktop` only while its source, dependencies and build settings
remain unchanged. This reuses the build; ABI setup and restoration still run.

Boots the real desktop app against a scratch home and walks the
critical path over the app's own socket: seeded config valid →
Academy seeds and parses → session starts → a minimal `/code` turn
dispatches → the coder's live output is observed (real agents) →
abort → ended session → clean teardown, with the ABI flipped and
restored by the driver (release-22).
Needs a locally signed-in Claude adapter; budget ~5–8 minutes.
Provider-side flakes may be retried or waived with the reason
recorded beside the tag; app-side failures block.

## 2. Manual pass — desktop app

Launch: `npm start`.

| Step | Expect |
| --- | --- |
| First launch, fresh config (`SPEX_HOME` unset or pointing at a root without `playbook/playbook.config.yaml`) | Captain home greets; quick start lists `/code`, `/review`, and `/decide`; readiness names any signed-out agents |
| Palette (⌘P) → "Try the Academy example" | Project seeds, registers, and becomes current; repeat click reopens it without error |
| Specs tab over Academy | The Packages branch renders its collection directories (the migrated corpus has no compositions, so no Compositions branch appears); filters and search work; an item with citations shows outbound citation rows, cited items show grouped inbound backlinks, and jumps land and flash |
| Playbooks surface | `/code`, `/review`, and `/decide` pipelines show source, gears, and state machine; example card stages all four artifacts; prefill fills the compile form (roles pre-mapped) |
| (The live run is automated by `npm run smoke:desktop`; spot-check the dock badge and notification banners during it) | Badge counts parked/failed sessions; banners appear per prefs |
| Dashboard | The run's usage appears; attention queue lists any parked/aborted turn |
| Settings | A Captain agent edit round-trips (adapter, model, effort, permissions); config stays valid |
| Dark theme (OS toggle) | Sidebar mark, panes, and spec view stay legible |

## 3. Packaging — a local option, not a gate

App releases ship as source (DR-040); packaging stays available for
a local check and returns as a gate once the app can be signed.

```bash
npm run package -w apps/desktop
```

| Step | Expect |
| --- | --- |
| Open the zip in `apps/desktop/release/` | App bundle carries the sunset-rabbit icon |
| Launch the packaged app | Boots to Captain home; seeding and Specs tab work as in the dev pass |
| `npm pack --dry-run -w packages/cli` (CLI tags) | Tarball lists only production files (release-17) |

## 4. Record

Note the smoke run (date, commit, deviations) in the release PR or
tag message. Any red step blocks the tag (release-21).
