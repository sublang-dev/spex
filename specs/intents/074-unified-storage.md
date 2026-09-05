<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-074: Unified Storage

## Status

Planned; no runtime implementation before the owner reviews the coordinated storage specifications and catalog.

## Intent

Implement [DR-045](../decisions/045-unified-session-storage.md) using Playbook-owned shared sessions and Cligent's definite resume-rejection classification.

## Deliverables

- [ ] Adopt the released shared session codec/lifecycle and retire desktop sidecar authority.
- [ ] Migrate application files, local bindings/preferences and managed library locators.
- [ ] Add whole-unit Git selection and pre-reopen validation.
- [ ] Render historical context/graphs and manage sessions from either host.
- [ ] Complete the owning packages' integration matrices.

## Tasks

1. Adopt Playbook's shared lifecycle and durable checkpoint/effect ownership.
2. Implement application-file migrations and local project rebinding.
3. Move UI preferences and implement config-relative library rebuilding.
4. Implement Git selection/validation and explicit orphan recovery.
5. Expose historical context and shared session management through the protocol/UI.
6. Verify cross-host, crash, migration and Git workflows before rollout.

## Verification

- Required acceptance behavior is specified in storage, core-service, projects, run-view and playbook-library.
- No implementation tests or builds have run for this intent; historical results do not verify the new contract.
