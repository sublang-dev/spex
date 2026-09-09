<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-055: Queue Advancement Independent Of Confirmation

## Status

Accepted (2026-09-09) on the owner's request that completed queued work automatically starts the next intent while its finish confirmation remains visible.
Amends [DR-035](035-intent-ledger.md)'s manual-only successor dispatch and confirmation-pulls-next policy, preserving human verdicts and explicit after-links.

## Context

- Sending the next queued intent is unnecessary waiting after work has demonstrably completed; reviewing the delivery remains a separate human responsibility.
- A finished Boss turn does not prove completed work: ordinary Captain responses include clarification questions as well as answers.
- The shared record stream carries explicit governed-root terminal success, permitting a bounded completion decision without classifying prose or changing the upstream protocol.

## Decision

- After a locally owned intent-attributed turn fully settles with recorded successful completion of its governed root, the core submits the project's current first queued, unblocked intent into the same conversation through normal admission ([DR-051](051-runtime-held-for-a-turn.md)).
  The dispatch uses its current text and identity, and attribution changes only when the turn starts.
- The prior intent remains finished and unconfirmed, with its delivery card and attention entry retained until a human verdict ([DR-038](038-history-is-done-work.md)).
  An older delivery does not hide newer work in the Running band, and its follow-up promise appears only while that intent still owns the conversation.
- Questions, permissions, failures, aborts and unknown completion pause advancement.
  An ordinary manual follow-up that later produces proven success may advance the queue.
- Queue capture or edits, ledger reads, confirmation, adoption and restart never initiate advancement.
  There is no retained runner state or automatic retry of refused admission.
- Explicit after-links retain their verdict gate: a successful playbook delivery does not necessarily fulfill a cross-project dependency such as an upstream release.

## Consequences

- Completed work can accumulate pending confirmations while later queued work runs; only verdicts close intents and enter them into History.
- Ordinary Captain replies lack typed completion and therefore cannot automatically advance, even when their prose appears complete.
- Entries added while work runs participate in the next settlement selection; entries added after settlement wait for an explicit start.
- Follow-up messages belong to the newest dispatched intent, and confirming an older delivery neither dispatches work nor changes that attribution.
