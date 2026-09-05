<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-074: Unified Storage

## Status

Planned; no runtime implementation before the owner reviews the coordinated storage specifications and catalog.

## Intent

Implement [DR-045](../decisions/045-unified-session-storage.md) using Playbook-owned shared sessions and Cligent's definite resume-rejection classification.

## Deliverables

- [ ] Adopt the released shared session codec/lifecycle and retire desktop sidecar authority.
- [ ] Migrate application files, local bindings/viewed markers and managed library locators.
- [ ] Add whole-unit Git selection and pre-reopen validation.
- [ ] Render historical context/graphs and manage sessions from either host.
- [ ] Complete the owning packages' integration matrices.

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

## Verification

- Required acceptance behavior is specified in storage, core-service, projects, run-view and playbook-library.
- No implementation tests or builds have run for this intent; historical results do not verify the new contract.
