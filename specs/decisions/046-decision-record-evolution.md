<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-046: Decision Record Evolution

## Status

Accepted (2026-09-04).
Extends [DR-000](000-spec-structure-format.md) with an accepted-decision lifecycle; amends [DR-012](012-spec-package-files.md)'s in-place framework DR evolution for future changes.

## Context

- The spec format defines DR structure but leaves amendment practice implicit.
- Packages describe current intended behavior; DRs preserve the decisions and rationale behind it.

## Decision

- Proposed DRs may be revised in place; accepted DRs permit editorial corrections that leave the decision and rationale unchanged.
- Substantive changes use a new DR, with reciprocal status links and explicit scope upon acceptance [[meta-35](../meta.md#meta-35)]; link only directly affected predecessors.
- Proposals identify their intended amendment scope; predecessor statuses change when the successor is accepted.
- Acceptance records design agreement: update affected current spec items in the same change; implementation progress belongs in IRs [[meta-5](../meta.md#meta-5)].
- Framework DRs follow the same convention.

## Consequences

- Current packages remain readable without reconstructing a decision chain.
- Earlier DR bodies remain historical; adopting this convention requires no retrospective rewrite.
