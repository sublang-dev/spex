<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-076: Model Options Release

## Status

Upstream releases published; app preparation ready for Claude review.
App release remains on hold pending owner authorization and the remaining release gates.

## Intent

Deliver runtime model options and clarification fixes through registry dependencies before the next app release.

## Deliverables

- [x] Cligent 0.26.0 and Playbook 13.1.0 published with verified provenance.
- [x] Spex requires those versions and installs them from its registry lockfile.
- [ ] App 0.6.0 released after its release gates pass.

## Tasks

1. Cligent: prepare one version/changelog commit for 0.26.0, then publish through its CI-gated release workflow.
2. Playbook: prepare one version/changelog commit for 13.1.0, then publish through its CI-gated release workflow.
3. Spex: record the new dependency floors, require Cligent ^0.26.0 and Playbook ^13.1.0, refresh the registry lockfile, remove missing-export compatibility, replace the changelog's pending-IR note with shipped dependency versions, and prepare the app's 0.6.0 version/changelog commit.

## Verification

- Reuse unchanged passing checks; run affected release gates on the final inputs.
- Verify both public package versions and provenance before updating Spex's lockfile.
- Verify a clean `npm ci` resolves discovery and revised prompts, then run the real-reader and editor journeys.
- Follow each repository's release package; Spex also requires its desktop manual and live smoke results before tagging.
