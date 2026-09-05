<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-042: Sessions Continue

## Status

Accepted (2026-09-02) on the owner's question why an ended session cannot take a new message, and why a session run from the terminal cannot be deleted.
Amends [DR-036](036-file-state-store.md) (the resume experience it deferred; deletion as the one write that crosses hosts), [DR-038](038-history-is-done-work.md) (a session another host wrote is deletable), and [DR-029](029-session-history-home.md) (an ended session is a paused conversation, not a closed one).

## Context

- Ending a session disposes its runtime, and the Captain shell's memory — its Boss journal, player ledger, and state machine — goes with it; every session is also marked not live when the app starts.
  An ended session is read-only, so the reader who wants to say one more thing must start over.
- The Captain shell is durable by design: it exports a JSON snapshot — journal, sequences, machine frames, optional provider tokens — and a fresh shell restores it; without tokens the Captain reseeds its context from a digest of the whole journal on its first call.
  The playbook CLI continues sessions exactly so: acquire the record, restore the snapshot into a fresh shell, build a new runtime.
- Spex's record stream is token-free by decision; provider tokens are machine-local and never leave the process.
  Players therefore start fresh on continuation, and only the Captain carries the story — which is the story the Boss told it.
- The runtime numbers turns from one per instance, so a continued session must offset turn ids; the host's effect ledger must match the snapshot's for a restore to be accepted.
- Sessions the playbook CLI wrote are served read-only and refused deletion: the store's law was that writing never crosses hosts.
  The CLI itself tells users to remove a session's files when a record cannot be resumed, tolerates a missing record, and guards its writers with a lease directory.

## Decision

### An ended session continues

- A session's runtime snapshot — the Captain shell's export, stripped of every provider token — is persisted in the session's sidecar at each turn's end and when the session ends, so a crash loses at most the turn underway.
- An ended session that is not foreign, holds a snapshot, and whose stream is whole is continuable: submitting Boss text to it restores the snapshot into a fresh shell, builds a new runtime for the same session id, offsets the runtime's turn ids past the stored turns, seeds the host effect ledger from the snapshot, marks the session live again, and appends the turn to the same stream.
  The composer of such a session reads as a paused conversation — "Ended · a message continues it" — never as read-only.
- Continuing keeps the one-live-session-per-project rule: while another session in the project is live, the message is refused with that reason and the way forward.
- A snapshot the current config no longer matches — playbooks or role bindings changed since — is refused with a message naming the drift and offering a new session; a session with no snapshot, or with a torn stream, stays read-only and says why.
- Players begin new conversations on continuation; the Captain's first call carries the journal digest.
  An engagement parked on a question resumes with its frames, so the reply lands where the question waited.
- Ending a session stays: it releases the project's live slot and pauses the conversation; the confirm says the session can be continued.

### Every listed session can be deleted

- Deleting is the one write that crosses hosts: a session the playbook CLI wrote is deleted from the shared store — its record, its stream, nothing else — at the user's explicit request, behind the same inline confirm, worded to say the terminal's history goes with it.
- The deletion is lease-checked: while the session's lease names a live process on this host, or any process on another host, the deletion is refused as busy with the holder named.
  Lease directories are never removed by Spex.
- A session that vanishes from the shared store while the app runs leaves the listing.

## Consequences

- The core gains the snapshot in the sidecar, a continuation path in session creation, the turn-id offset, ledger seeding, and the foreign-aware deletion; the protocol's session entry says whether a session is continuable.
- The run view drops its read-only framing for continuable sessions; the sidebar's delete control appears on every non-live session.
- Two histories may diverge for a session the CLI wrote — Spex still never continues those; they stay read-only and deletable.
- Provider tokens stay out of every file; true resume of player conversations waits for a decision on a private token store.
