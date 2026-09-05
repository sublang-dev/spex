<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-049: Supported App Hosts

## Status

Accepted (2026-09-05).
Amends [DR-002](002-desktop-app-architecture.md) for supported host platforms.

## Context

Shared session storage requires private POSIX permissions: directories `0700`, files `0600` ([DR-045](045-unified-session-storage.md)).
Node's Windows permission API cannot enforce that boundary [[1]].

## Decision

- Desktop and server hosts support macOS and Linux on filesystems that enforce these permissions.
- Other native hosts refuse startup before creating or migrating config or storage.
- Windows supports the scaffold CLI and browser access to a supported server.
- CI builds every workspace on Windows and tests the scaffold CLI, browser UI, and native startup refusal; macOS and Linux retain the complete test suite.

## Consequences

Native Windows hosting requires a separate storage-permission design before support can be added.
Portable history may still contain paths recorded on other platforms.

## References

[1]: https://nodejs.org/api/fs.html#fschmodpath-mode-callback "Node.js filesystem permissions on Windows"
