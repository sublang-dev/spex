<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-025: Playbook 7 Adoption

## Status

Accepted
Amended by [DR-037](037-playbook-12-adoption.md): `dev` joins the built-in catalog.

## Context

- Core consumed `@sublang/playbook` ^4.0.0 and `@sublang/cligent` ^0.18.0 while the released toolchain reached playbook 7.0.0 and cligent 0.20.0.
- Playbook 6 replaced the DISCUSS built-in with REVIEW and DECIDE, made CODE single-role by delegating committed phases to REVIEW, and retired CODE's committer option.
- Playbook 5 rebuilt the Captain shell as a controller host: every Boss turn — bare registered commands included — settles through a session Captain model call, so the shell no longer emits canned replies of its own.

## Decision

- Core raises its floors to `@sublang/playbook` ^7.0.0 and `@sublang/cligent` ^0.20.0, amending the [DR-023](023-runtime-compatibility-from-cligent.md) floors; app-supplied agent runtimes ([DR-024](024-app-supplied-agent-runtimes.md)) are unchanged.
- The built-in catalog and the seeded config template carry `code`, `review`, and `decide`; CODE seeds one coder role and no options.
- Core's contract with the shell stays wiring-only: registry loading, session construction, and reply round-trip; behavior owned by the shell — replies, engagement, pane switching — is playbook's to verify.

## Consequences

- The Library shows three built-ins with sources shipped in the installed package; `/discuss` no longer exists anywhere in the app.
- A Boss turn always costs a captain model call, including bare commands.
- Config files carrying a `discuss` block or CODE `committer`/`reviewer` keys fail closed with launcher-identical errors, pointing users to update their config.

