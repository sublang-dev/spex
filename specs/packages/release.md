<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# release: Release Workflow

## Intent

This spec defines release workflow rules for the project.

## External Behavior

### Versioning

#### release-1

The project shall follow Semantic Versioning [[1]]: `MAJOR.MINOR.PATCH` where MAJOR indicates breaking changes, MINOR indicates new features, and PATCH indicates bug fixes.

#### release-2

The version in the released package's `package.json` (`packages/cli/package.json`) shall match the git tag (without the `cli-v` prefix):

- The release workflow verifies this match before publishing [[release-8](#release-8)].

### Changelog

#### release-3

All notable changes to a release channel shall be documented in that channel's `CHANGELOG.md` following the Keep a Changelog [[2]] format — `packages/cli/CHANGELOG.md` for the CLI, and the repository root `CHANGELOG.md` for the app ([DR-040](../decisions/040-source-only-app-releases.md)).

#### release-4

When preparing a release, the developer/agent shall review all commits since the last release and ensure all notable changes are documented in the `[Unreleased]` section of `CHANGELOG.md`.

#### release-5

When creating a release tag, the developer/agent shall move items from `[Unreleased]` to a new version section in `CHANGELOG.md` with the release date, and update the comparison links at the bottom of the file.

#### release-6

Changelog entries shall be grouped under these headings (in order): `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

### Release Process

#### release-7

CLI releases shall be triggered by pushing a git tag matching the pattern `cli-vMAJOR.MINOR.PATCH` (e.g., `cli-v3.1.0`) ([DR-056](../decisions/056-release-naming.md)).

#### release-8

When a release tag is pushed, the release workflow shall verify the tag version matches `package.json` version, build and validate the package, and extract release notes from `CHANGELOG.md`.

#### release-9

When the release workflow publishes to npm, it shall use the `--provenance` flag for supply chain security and authenticate via npm OIDC trusted publishing:

- provenance generates a signed attestation linking the package to its source repository and build;
- static npm tokens are not used.

#### release-10

When the release workflow publishes a scoped package, it shall use `--access public` to ensure public availability.

#### release-11

When the release workflow completes publishing, it shall create a GitHub release with the extracted changelog notes and the channel's title ([DR-056](../decisions/056-release-naming.md)):

- CLI: `Spex CLI vMAJOR.MINOR.PATCH`.
- App: `Spex App vMAJOR.MINOR.PATCH`.

#### release-18

When a release tag is pushed, the release workflow shall confirm the CI workflow concluded `success` for the tagged commit before publishing to npm or creating a GitHub release, waiting up to a bounded timeout for the CI workflow to complete:

- the CI workflow concludes `success` — publishing proceeds;
- the CI workflow concludes with any other result, or the timeout elapses without a successful conclusion — the release workflow fails without publishing to npm or creating a GitHub release.

#### release-19

Where the repo hosts multiple release channels ([DR-002](../decisions/002-desktop-app-architecture.md)), release tags shall use disjoint namespaces per channel ([DR-056](../decisions/056-release-naming.md)):

- tags matching `cli-vMAJOR.MINOR.PATCH` release only the `@sublang/spex` package from `packages/cli`;
- tags matching `app-vMAJOR.MINOR.PATCH` release the app — the desktop and server shells — as source ([DR-040](../decisions/040-source-only-app-releases.md)).
- historical `vMAJOR.MINOR.PATCH` CLI tags remain valid release-history evidence; published tags and their URLs are preserved when titles are normalized.

### Package Hygiene

#### release-12

The released package's `package.json` shall keep the published tarball to runtime files and gate publishing on a green build:

- the `files` field excludes test files and build artifacts not required at runtime from the published tarball;
- the `prepublishOnly` script builds and runs tests before publishing.

#### release-13

Where the release workflow validates the package, it shall verify that the tarball contains no test files and no source files that are not required at runtime.

#### release-14

The published package shall include a `README.md` that documents what the tool does, how to install it, and how to use it, kept up to date with the current feature set before each release.

### Pre-release Checklist

#### release-15

When preparing a release tag, the developer/agent shall verify that all changes are committed and pushed to `main` and that the CI workflow concluded `success` for the commit to be tagged:

- a local test run is not that verification: CI covers platforms and versions a developer's machine does not, and [[release-18](#release-18)] fails the release on a red commit, so tagging one only defers the failure.

#### release-16

When preparing a release tag, the developer/agent shall verify that the channel's `CHANGELOG.md` [[release-3](#release-3)] is updated with the new version and date, and the channel's `package.json` version is bumped — `packages/cli` for a CLI tag; `apps/desktop` and `apps/server` together for an app tag.

#### release-17

When preparing a release tag, the developer/agent shall verify that the tarball contains only production files (e.g., via `npm pack --dry-run`).

#### release-20

When preparing a release tag, the developer/agent shall run the automated smoke suite (`npm run smoke`, with the desktop stage for app releases) and see it pass every stage: build, spec lint, unit and integration tests, the browser journeys — the served UI driven in Chromium against a real core with substitute agents ([DR-039](../decisions/039-browser-acceptance-journeys.md)) — a core round-trip that seeds the bundled template, serves the built-in catalog and artifacts, and seeds and parses the example project, and an end-user CLI pass that packs the release tarball, installs it into an isolated prefix, and walks the published README's fresh-user and upgrading-user journeys through the installed `spex` bin:

- browser journeys default to one worker locally and in CI, and the smoke stage explicitly uses one worker so the gate's resource load does not scale with the machine's CPU count.

#### release-21

When preparing an app release tag, the developer/agent shall complete the manual smoke checklist (`docs/release-smoke.md`) — the desktop visuals automation cannot see — with a failing step blocking the tag until resolved:

- a CLI release tag is not gated on it: the checklist's only CLI step is the tarball inspection that [[release-17](#release-17)] already requires and [[release-23](#release-23)] verifies;
- the checklist's packaging pass is a local option, not a gate: an app release ships no binaries ([DR-040](../decisions/040-source-only-app-releases.md)).

#### release-22

When preparing an app release tag, the developer/agent shall run the live desktop smoke (`npm run smoke:desktop`) — the real desktop app walking config, example seeding, session, live playbook dispatch, and abort with signed-in agents ([DR-020](../decisions/020-desktop-live-smoke.md)) — and record its outcome with the tag:

- a provider-side failure may be retried or waived with the reason recorded;
- an app-side failure blocks the tag.

#### release-24

When preparing a CLI release tag, the developer/agent shall run the live migration smoke (`npm run smoke:migration`) — a real coding agent migrating the bundled previous-generation fixture with the packed CLI's printed prompt ([DR-022](../decisions/022-prompt-based-migration.md)) — and record its outcome with the tag:

- the run gates on `spex lint` clean, every fixture item surviving under its new id, intent-record checkbox states preserved, and no `compositions/` directory remaining;
- a provider-side failure may be retried or waived with the reason recorded;
- a failure of the CLI, the prompt-driven migration, or the gates blocks the tag.

## Verification

### Release Checks

#### release-23

When a release candidate tarball is inspected via `npm pack --dry-run`, the inspection shall find no test files and no source files that are not required at runtime in the file list, asserting the runtime-files hygiene of the `files` field [[release-12](#release-12)] and the workflow's package validation [[release-13](#release-13)].

## References

[1]: https://semver.org/spec/v2.0.0.html "Semantic Versioning 2.0.0"
[2]: https://keepachangelog.com/en/1.1.0/ "Keep a Changelog 1.1.0"
