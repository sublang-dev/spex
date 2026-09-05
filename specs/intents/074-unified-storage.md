<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-074: Unified Storage

## Status

In progress; implementation verified against the packed candidate (2026-09-05).
Published Playbook adoption, live/manual acceptance and publication remain pending.

## Intent

Implement [DR-045](../decisions/045-unified-session-storage.md) using Playbook-owned shared sessions and Cligent's definite resume-rejection classification.

## Deliverables

- [x] Route desktop sessions through the shared codec/lifecycle and retire sidecar authority.
- [x] Migrate application files, local bindings/viewed markers and managed library locators.
- [x] Add whole-unit Git selection and pre-reopen validation.
- [x] Render historical context/graphs and manage sessions from either host.
- [x] Complete the owning packages' integration matrices against the packed candidate.
- [ ] Adopt published Playbook in the registry lockfile.
- [ ] Complete coordinated release acceptance and publication.

## Tasks

1. Route new desktop session creation/settlement through Playbook; verify durable effect ownership.
2. Route continuation and deletion through the shared lifecycle; verify CLI-created session management.
3. Migrate registry v1 to identities and local bindings; verify ID preservation and restart recovery.
4. Add explicit rebind and identity restoration; verify late binding and orphan reporting.
5. Add receipt-backed cutover orchestration; verify retained inputs, token-free outputs and interrupted retry.
6. Write config-relative managed locators; verify module and artifact resolution after copying the root.
7. Rebuild omitted Library outputs from retained sources; verify successful and failed regeneration.
8. Add whole-unit Git selection; verify divergent files, session bundles and delete/modify choices.
9. Add pre-reopen validation and viewed-marker reset; verify invalid ledgers and orphan preservation.
10. Serve stored context over the protocol; verify history without installed modules.
11. Render stored context in run views; verify graph stability after configuration changes.
12. Expose shared Retry/Discard commands and uncertainty summaries; verify CLI-created recovery through desktop.
13. Add recovery controls and confirmations; verify saved-input retry, discard refusal and draft preservation.
14. Run integrated release acceptance and publish the coordinated releases.

## Verification

- Required acceptance behavior is specified in storage, core-service, projects, run-view and playbook-library.
- Against packed Playbook `a6ff03b9` and published Cligent `0.25.0`, 833 tests and 40 browser journeys pass across bounded runs, including corrected fixture cases; core round-trip, packed CLI, Electron render and native ABI restoration pass.
- The installed Playbook files match the candidate; registry lockfile adoption awaits publication.
- Live checks await explicit approval after automatic review refused execution; manual desktop acceptance awaits an unlocked Mac.
- Detailed results and remaining release gates are recorded in [release preparation](../../docs/releases/0.5.0-preparation.md).
