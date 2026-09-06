<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-074: Unified Storage

## Status

Done (2026-09-06): released as Spex app 0.5.0 on Playbook 13.0.0 and Cligent 0.25.0.

## Intent

Implement [DR-045](../decisions/045-unified-session-storage.md) using Playbook-owned shared sessions and Cligent's definite resume-rejection classification.

## Deliverables

- [x] Route desktop sessions through the shared codec/lifecycle and retire sidecar authority.
- [x] Migrate application files, local bindings/viewed markers and managed library locators.
- [x] Add whole-unit Git selection and pre-reopen validation.
- [x] Render historical context/graphs and manage sessions from either host.
- [x] Complete the owning packages' integration matrices against the packed candidate.
- [x] Adopt published Playbook in the registry lockfile.
- [x] Complete coordinated release acceptance and publication.

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
- The baseline packed candidate passed 833 tests and 40 browser journeys across bounded runs; core round-trip, packed CLI, Electron render and native ABI restoration passed.
- Updated replay handling passed 88 core checks and 18 browser journeys; the final Playbook `3444353` changes only the native-session-ID sanitizer alias, covered by three owning-package regressions, and all 99 installed files match.
- Playbook passed 1,743 tests, exact-candidate CI and all six live cases; publication awaits its manual terminal UX check, then Spex's registry adoption.
- Native navigation, settings, themes, saved graph/recovery controls and Dashboard attention passed; OS badges and notification banners remain unobserved.
- The provider-free waiting-question fixture passed its UI reply and ledger badge `1` to `0` transition, then quit cleanly and restored the Node ABI.
- The earlier Spex attempt counted initialization as output and failed its manual watchdog; it is not a valid live result. Four regressions verify the corrected output gate.
- Corrected Spex live acceptance passed on `0f73693` with Playbook `3444353`: actual provider text before abort, valid replay, process exit `0` and restored Node ABI.
- Supplied-review fixes add damaged-store isolation, migration/CLI and activity regressions, plus saved-context and Git effect-recovery checks; the preceding release runs are historical, and the changed final candidate still requires release acceptance.
- Final acceptance on the published closure passed: CI for the tagged candidate, the hermetic smoke with the desktop stage, the live desktop smoke, and the manual checklist on migrated data.
- Detailed results are recorded in [release preparation](../../docs/releases/0.5.0-preparation.md).
