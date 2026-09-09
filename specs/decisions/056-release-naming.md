<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-056: Release Naming

## Status

Accepted (2026-09-09).
Amends [DR-002](002-desktop-app-architecture.md) for the CLI release tag namespace.

## Context

App release titles repeat the channel (`Spex app app-v0.1.0`), while CLI titles such as `v3.0.0` omit it.
Both channels need a consistent identity without breaking published source references.

## Decision

- GitHub release titles use `Spex App v<version>` and `Spex CLI v<version>`, including existing releases.
- Future tags use `app-v<version>` and `cli-v<version>`; published tags, including legacy CLI `v<version>` tags, retain their names and targets.
- The CLI remains `@sublang/spex` on npm with plain Semantic Versioning; the internal core is not a release channel.

## Consequences

Titles identify the product and channel once, while tag names identify the channel without repeating the product name.
Existing release URLs remain stable, and CLI release-history checks include both tag namespaces in version order.
The CLI publishing workflow adopts the new prefix without republishing any npm version.
