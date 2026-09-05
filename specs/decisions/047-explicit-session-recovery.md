<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-047: Explicit Session Recovery

## Status

Accepted (2026-09-05).
Amends [DR-045](045-unified-session-storage.md) with desktop access to uncertain-turn recovery.

## Context

Playbook already offers explicit CLI recovery for interrupted turns.
Shared storage must make the same recovery available in desktop without making normal submission retry uncertain work.

## Decision

- Expose Retry and Discard for uncertain sessions, regardless of their originating host.
- Retry uses the recorded input and attempted configuration after Playbook's reconciliation; it accepts no replacement input.
- Discard restores the preceding settled checkpoint only if the effect ledger has not advanced; a never-settled fresh session may be removed under that same rule.
- Both operations use Playbook's exclusive session lease and recovery lifecycle. Discard loads no agents or configuration.
- Show the saved input and action consequences before confirmation; preserve history and the refusal reason when recovery is unsafe.
- Block normal submissions and queued sends until uncertainty is resolved.

## Consequences

Desktop and CLI share recovery decisions and effect evidence.
Discard cannot undo external work, and Retry is not permission to repeat effects.
