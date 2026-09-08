<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-053: Model Options Adoption

## Status

Accepted.
Amends [DR-050](050-shared-storage-cutover.md) for dependency floors.

## Context

Runtime model discovery and revised clarification prompts require the reviewed Cligent and Playbook releases.

## Decision

- Require `@sublang/cligent` ^0.26.0 and `@sublang/playbook` ^13.1.0, installed from the public registry.
- Require Cligent's discovery export; runtime discovery failures still leave configuration editing available [DR-052](052-runtime-model-options.md).

## Consequences

A clean install supplies both features without local package replacements.
