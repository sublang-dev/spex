<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-048: Failed Session Cleanup

## Status

Accepted (2026-09-05).
Amends [DR-003](003-runtime-reuse.md) with failed-disposal ownership rules.

## Context

A disposal error does not prove that agent processes stopped.
Releasing the project could allow another session to act on the same repository.

## Decision

- Retain the session lease and project reservation until the shared lifecycle confirms cleanup.
- Report cleanup failures; shutdown still attempts every session and closes the endpoint.
- A restart may recover ownership only after the previous owner has stopped, using the existing lease checks in [DR-045](045-unified-session-storage.md).

## Consequences

A failed cleanup can require stopping the host process before the project becomes available again.
