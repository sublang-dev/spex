<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-012: One-File Spec Packages and Interactions

## Status

Accepted; the mechanical migration is superseded by [DR-022](022-prompt-based-migration.md) — the one-file package layout and the linter stand, but `--update` restructures no legacy content.
Amended by [DR-046](046-decision-record-evolution.md): future substantive changes to framework DRs use successor records; the earlier in-place rewrites remain historical.

## Context

- The three-folder layout (`specs/user/`, `specs/dev/`, `specs/test/`) split every package across up to three files; understanding one package meant reading three places, and the split invited drift between them.
- Behavior that emerges from packages working together had no home: cross-package scenarios lived implicitly in Where/While clauses and in test items filed under whichever package hosted them.
- Structure and citation hygiene were enforced only by review; nothing mechanical caught broken anchors, duplicate IDs, or layout drift.

## Decision

- Two item directories replace the three folders ([DR-000](000-spec-structure-format.md)):
  - `specs/packages/` — one file per package with `## External Behavior`, `## Internal Behavior`, and `## Verification` sections [[meta-30](../meta.md#meta-30)]; one read covers a package.
  - `specs/interactions/` — cross-package behaviors and scenarios, named after the behavior (never package-name concatenations), holding the integration/acceptance tests that span packages — superseded by `specs/compositions/` in the 0.4.0 composed-model port.
- Migration is mechanical, not manual: `spex scaffold --update` merges legacy trees with a real Markdown parser (byte-faithful slicing, heading demotion, reference renumbering), rewrites citations across `specs/`, and restructures a customized `map.md` (scaffold-39–scaffold-42). Agent prompts cover what a tool cannot infer: intent reconciliation and interactions content.
- `spex lint` guards the format from then on (the [lint](../packages/lint.md) package); this repo's own tree is lint-gated by the CLI test suite.
- The meta package's items evolve in place: meta-1/14/16/28/22 were rewritten for the new structure under their then-current IDs — following the precedent of the `specs/items/` flattening — because their roles (layout, package composition, naming, Verifies, test scope) are unchanged; anchors and citations stay valid. New rules use provisional IDs (the package-sections rule, now meta-30, and the since-retired compositions-directory rule); only IDs and concerns present in a published release are reserved. DR-000 likewise evolved in place, as the framework-owned living record of the current structure.
- The in-place rewrites were legal under the meta-12 released with v0.3.0, which locked item IDs against renumbering but not their wording; the stricter release-boundary [[meta-12](../meta.md#meta-12)] (a reserved ID keeps its concern) is itself part of this restructure and applies from its release onward, not retroactively. The root port landed with the 0.4.0 composed-model release, carrying the converged `meta.md`, the then-current `specs/compositions/` (since folded into `specs/packages/` by [DR-000](000-spec-structure-format.md)), and inline citations, gated by `spex lint`; the desktop spec-view adaptation followed in a later round.
- Citations inside iteration records were mechanically rewritten to the new paths: IRs are historical, but dead links serve nobody and the linter would flag them forever.
- At decision time the desktop app's spec view still parsed the legacy layout (the spec-view package); adapting `packages/core`'s parser, the protocol group triple, and the view was deferred to a follow-up iteration and later realized, until which the Specs tab could not render this repo's own migrated tree.

## Consequences

- One file answers "what does this package do, how, and how is it checked".
- Cross-package behavior is specified and tested where it belongs; the first three interaction specs (desktop session flow, shared-config round-trip, forge work lists) replace previously implicit contracts.
- Downstream repos migrate with one command and keep their history recoverable (clean-tree precondition, write-before-delete migration).
- The spec view of the desktop app lags the new layout until that follow-up completes.
