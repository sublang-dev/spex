<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-035: The Intent Ledger

## Status

Accepted (2026-08-28) after two owner reviews: the first named the outcomes interrupted / finished / confirmed, merged confirmation into the attention queue, allowed several intents per session, made history per-project, and deferred usage to a future Insights surface; the second added finished-entry run stats, the tabbed paged Sources band, and visible forge labels.
Extends [DR-009](009-at-hand-interaction.md) and [DR-029](029-session-history-home.md); amends [DR-011](011-project-workspace.md)'s Dashboard content row and the attention queue's kind table; evolves the Dashboard's work lists ([DR-027](027-linked-views-contract.md)'s routing of work to work surfaces stands).
Storage form amended by [DR-036](036-file-state-store.md): the intents table becomes an append-only act log; the fields, the no-state-column law, and every fold contract stand.
Amended by [DR-038](038-history-is-done-work.md): an intent dropped before it was worked leaves the ledger without a trace, verdicts confirm on one click, and History lists finished intent records beside worked intents.
Amended (2026-09-02) on the owner's review: the running sessions list again as their own band below the attention queue — a summons and a glance at what is working are two focuses, so the Now band's absorption of the running-sessions section is reversed for the sessions no entry summons; the attention queue stays the summons and the badge still counts it alone.
Amended (2026-09-02): the permanent deletion deferred below is decided — a remove act retires a closed intent from every band, so a row the Boss no longer wants on the record leaves History behind the inline confirm ([DR-010](010-interface-craft.md) §4) while its acts stay in the append-only log and no state column returns.
Amended by [DR-051](051-runtime-held-for-a-turn.md): the lane Start reuses is the project's current conversation — derived from stored state — and the fresh lane is the start tab, since no session is ended any more.

## Context

- The owner's direction (2026-08-28): managing multiple agents across several projects loses the thread — what are the agents working on and in which sessions, what is recently done or awaits confirmation, what is blocked, and what comes next, without rediscovering the answer after every finish.
  Intents are fine-grained, far finer than tracker tickets, so managing one must cost less than the work it names.
  Issues and PRs are sources of intents but not the only ones; one gesture should turn either into an intent to address now or later, and the moving pieces should stay visibly connected.
- The diagnosis, in order of harm:
  - the unit mismatch: the Boss thinks in intents, but the app tracks sessions — work is scattered across attention entries, running-session rows, forge lists, and record lists with no thread from want to verdict;
  - nothing holds "what's next": every confirmation ends in rediscovery, and the only queue is the per-session composer queue, whose contents die with their session [[run-view-8](../packages/run-view.md#run-view-8)];
  - "awaiting confirmation" has no durable home: a glance clears the turn-awaiting-review summons, and then nothing remembers a verdict is owed — while the evidence on agent fleets says verification, not generation, is the bottleneck [[1]];
  - issue and PR rows dead-end in the external browser [[projects-6](../packages/projects.md#projects-6)], so capture is retyping by hand;
  - the intents-to-finish list [[dashboard-24](../packages/dashboard.md#dashboard-24)] reads no record status, so long-done records list as work forever;
  - attention is derived three times over — the Dashboard selector, the sidebar row marks, the desktop dock tracker — by separate client code that can disagree, while the core-side derivation the law demands [[dashboard-10](../packages/dashboard.md#dashboard-10)] remains unbuilt.
- The vocabulary already names the unit ([DR-017](017-intent-records.md)): the Boss intent is the episodic want.
  What is missing is a row for it between the moment of wanting and the moment of confirming.
- Grounding: shipped agent fleets converge on session lists and triage inboxes, never boards [[2]] [[3]] [[4]]; an inbox is driven to empty, not watched [[5]]; kanban's durable content is the pull system and the WIP limit [[6]] [[7]], and the product already has the limit structurally — one live session per project [[core-service-4](../packages/core-service.md#core-service-4)], serialized turns [[core-service-5](../packages/core-service.md#core-service-5)]; a next action is decided in advance, once [[8]]; delegation to an agent leaves the human the accountable assignee [[9]]; context switches leave residue, so re-entry must be answerable at a glance [[10]] [[11]].

## Decision

**An intent is a staged Boss turn.**
The one new entity is the intent: the text of a Boss turn not yet sent, plus where it came from.
The stored row is the Boss intent itself — the episodic want of [DR-017](017-intent-records.md), captured before its turn instead of only inside one — so no fourth referent joins the vocabulary.
Its fields are acts and provenance only: project, text (the first line is the display title), source (issue, PR, intent record, chat, or none), queue position, an optional after-link, and timestamps for capture, dispatch (session and turn, re-written by a later dispatch), and close (done or dropped).
There is no stored state column.
Every visible state folds deterministically from intent rows, the record stream, and review state — arrival-order-independent and restart-identical, the attention law extended [[dashboard-10](../packages/dashboard.md#dashboard-10)] [[dashboard-11](../packages/dashboard.md#dashboard-11)]:

| Derived state | Holds while | Tone |
| --- | --- | --- |
| Queued | not closed and not bound to a dispatch | neutral; a blocked row renders its Start gray-disabled with the reason — disablement earned, not category color ([DR-026](026-data-graphics-craft.md) §2) |
| Working | its latest attributed turn is active | the session's own tone, never recomputed |
| Interrupted | its execution stands stopped on the Boss — a pending question, a permission request, or an unacknowledged failure among its turns | amber; red for the unacknowledged failure |
| Finished | its last attributed turn completed and no verdict yet | amber, waiting on the human |
| Done / Dropped | closed, by the verdict acts alone | quiet history |

A session serves several intents over its life: an intent's turns run from its dispatch until the next intent's dispatch in that session, so the newest open intent owns the conversation — a follow-up turn returns it to Working — while its elders keep their own outcomes and await their verdicts.
Answering the question, deciding the permission, or acknowledging the failure resolves an interruption in place: the fold re-derives, and the run continues or the intent finishes.
An aborted dispatch releases the intent: the binding clears, the text is editable again, and the row reappears at its kept rank — a session dying mid-turn releases the same way, so restart re-derives the same answer.
Issues and PRs are provenance, never mirrored state: the row keeps number, title, and URL, and the agents in the session reach the rest themselves with `gh` in the project cwd.
Intent records stay legally untouched: the app never depends on a record's content, a record-sourced intent's text is just text if the record is deleted, and no spec cites an IR [[meta-18](../meta.md#meta-18)].

**Capture is one gesture from every source.**

- Issue rows and PR rows — Repo tab and Dashboard alike, one representation [[forge-work-lists-1](../packages/forge-work-lists.md#forge-work-lists-1)] — gain a Queue control seeding editable text (`Address #123: <title>` / `Review PR #45: <title>`, URL included); the title keeps opening the canonical page.
- Open intent-record rows gain the same control (`Resume IR-<N>: <title>`); the records listing learns to read each record's Status line so only unfinished records count as work — curing the done-records-forever flaw.
- In a session, the composer gains one secondary action — queue instead of send — capturing the typed text as a queued intent: the mid-run "we should also fix that later," shelved without derailing the run.
- Each project's queue ends in an inline add row.
- At most one open intent per source artifact — issue, PR, or record, per project — so nothing sourced is captured twice; chat and unsourced intents are unconstrained.
  A captured source row shows its open intent's state in place of the control, and regains the control once that intent closes; provenance reads in both directions.
- Queueing shows the shelf: the new row is revealed and briefly highlighted where it landed.

**The queue is the plan.**
One manually ordered queue per project — the project is the execution lane, so only its order has dispatch meaning.
Position is priority; there is no priority field to groom.
Sequence is the dependency model within a project; the one extension is a single optional after-link to an open intent in any project, because waits genuinely cross repos (a downstream repo blocked on an upstream release).
The link is set and cleared in the capture and row popovers; a link to a closed intent is refused, cycles are refused fail-closed, and the link clears itself when the predecessor closes.
A blocked intent stays visible in its queue with "after ⟨title⟩" — the predecessor's project named when it lives elsewhere — is never offered as next, and releases with a shelf highlight when its predecessor closes.
The head unblocked intent is the project's next; reorder works by drag and by keyboard alike.

**Dispatch is sending, into the lane that exists.**
Start on an intent stages its text into the project's composer, focused — the live session's, or the Captain home's, where sending creates the session in the same motion [[run-view-26](../packages/run-view.md#run-view-26)].
Reusing the live session is the default policy: the lane's accumulated Captain and player context is the point of a session, and a fine-grained intent must not pay a cold start; a fresh lane stays an explicit act — end the session, then start, with the guardrail it always had ([DR-029](029-session-history-home.md)).
The Boss reads, appends context, and presses Enter: the submission carries the intent's id, keeping the Boss the sender of every turn and Spex free of orchestration semantics ([DR-003](003-runtime-reuse.md)).
The staged text wears the intent's chip; emptying the composer or dismissing the chip detaches the id, and sending then stamps nothing — the intent simply stays queued.
The dispatch binds when the turn starts, not when Enter falls: a submission waiting in the composer queue [[run-view-8](../packages/run-view.md#run-view-8)] leaves the intent queued with its chip on the pending bubble, so a discarded queue discards no intent.
Text is editable while queued; from binding on it is history.

**Execution has three outcomes, and attention lists two of them.**
A dispatched intent works, then either stands interrupted on the Boss or finishes; only a verdict — Confirm or Drop — closes it, because a finish is a claim and the Boss rules on claims.
The attention queue lists interrupted intents first, then finished ones, longest waiting first within each band.
This amends the four-kind table [[dashboard-1](../packages/dashboard.md#dashboard-1)] [[dashboard-2](../packages/dashboard.md#dashboard-2)]: the old kinds survive as the interruption reasons — question, permission, failure — and the finished band absorbs turn-awaiting-review.
A session running outside the ledger still summons: its question, failure, or finished turn enters the same bands as a session entry, cleared as today — viewing for the finished chat turn [[dashboard-4](../packages/dashboard.md#dashboard-4)] — while an intent entry clears only with its state: resolution for interrupted, verdict for finished.
The badge counts the queue [[dashboard-9](../packages/dashboard.md#dashboard-9)], so a finished intent is attention until ruled on; red still means chase this ([DR-029](029-session-history-home.md)).
Activating an entry opens the session at the intent's place — the pending question, the failure, or the end of its final turn.
A finished entry carries the run's basic stats, folded from the same records as everything else — the review rounds its turns held foremost — so the verdict is informed before the click.
A turn that finishes reporting an engagement failure interrupts rather than finishes: the Boss rules on it or continues with a follow-up turn, and the red clears the moment the Boss responds.
Drop is legal on any open intent; Done requires a finish, because confirming work that never ran would falsify the ledger.

**Confirming pulls the next.**
Each finished intent's delivery card sits at its own turn's end in the thread — the intent's title, its provenance chip, Confirm foremost, Drop beside — and on either verdict it resolves in place into the project's next intent with Start, staged one Enter away.
The pull lives at the verdict sites — the delivery card and the attention entry's row — and at the two doorways: the Captain home names the queue head with Start, and the attention queue's all-clear state names the globally next unblocked head, first by sidebar order, with plain all-clear copy when nothing is unblocked [[dashboard-8](../packages/dashboard.md#dashboard-8)].

**The Dashboard reads as one question, top to bottom.**
"What needs me — interrupted, then finished — and where is each project."

| Section | Content |
| --- | --- |
| Attention queue | interrupted intents, then finished ones, longest waiting first within each; entries lead with the intent's title, session entries standing in where no intent is bound; activating one opens the session at the intent's place |
| Projects | one group per project in fixed sidebar order, four bands: **History** — closed intents newest first in a compact scroll that fetches older pages as the reader goes; **Now** — the session's mark, playbook, human state, and elapsed (absorbing the running-sessions section, quiet when no session is live) with the open intent the lane serves, or the latest Boss turn for plain chat, which stays un-ledgered and free; **Up next** — the queue; **Sources** — a collapsed issues · PRs · open-records line with data age [[dashboard-14](../packages/dashboard.md#dashboard-14)], expanding in place to three tabs — issues, PRs, open records — each paginated, rows carrying their forge labels and Queue controls |

Usage leaves the Dashboard; its rollups stay in the core read model for the planned Insights surface.
A list, not a board: every state here is the consequence of a real act — send, finish, verdict — so a card dragged between columns could only lie or duplicate the act.
The project filter stays visibility-only with the ghost grammar ([DR-027](027-linked-views-contract.md)); empty sections keep instructive guidance [[dashboard-8](../packages/dashboard.md#dashboard-8)].
In the session, the bound turn's bubble wears the intent's source chip, and while an intent is open a slim line above the composer names what the lane is working on — re-entry answered where the eye lands.

**One derivation, one law.**
The intent fold and the attention fold become one core-side read model — the derivation the law always demanded [[dashboard-10](../packages/dashboard.md#dashboard-10)] — and every consumer reads it.
The store gains one table whose only writers are Boss commands (queue, edit, move, link, close) plus the dispatch binding on the existing submit; one per-project broadcast announces ledger changes.
Intent rows are never deleted — dropping keeps the struck row, and permanent deletion waits for its own decision, like session deletion before it ([DR-029](029-session-history-home.md)).

**Considered and declined**, so the alternatives cannot re-enter piecemeal:

- a kanban board: the columns exist only as derived bands, WIP is already limited structurally, and fine-grained intents churn faster than card ceremony tolerates — a board would be state grooming wearing the costume of control [[6]];
- auto-capturing engagements or turns as intents: the ledger means something because entering it is a Boss act; auto-minted rows would demand verdicts nobody asked for, flood a fine-grained ledger, and turn the record fold into a second writer of stored state;
- auto-send dispatch: saves one Enter and costs the Boss's standing as the sender of record; the composer stays the only input into a session;
- a session per intent, the cloud-fleet shape: every fine-grained intent would pay a cold Captain start, against the lane law of one live session per project [[core-service-4](../packages/core-service.md#core-service-4)]; the live session is reused by default and a fresh lane stays an explicit end-then-start;
- a priority field: position already is priority, a stale P1 is grooming debt, and the status palette has no hue to give it ([DR-026](026-data-graphics-craft.md) §2);
- multi-predecessor or graph dependencies and a stored cross-project interleave: a graph the Boss maintains instead of a list reordered in seconds; the single after-link covers the real cross-repo wait;
- the first draft's summons-and-ledger split — view-cleared attention entries beside a separate To-confirm section: two places answering "what needs me"; the owner merged them, so finished work is attention until ruled on and the queue's two bands carry it;
- a global done-recently section: history is read per project, where re-entry happens, and the attention queue is already the one cross-project ranking;
- a fifth navigation surface: the Dashboard is deliberately the one cross-project surface ([DR-011](011-project-workspace.md));
- a work-item entity unifying issues, PRs, and IRs: a sync engine against two systems of record, and app law depending on records no spec may cite [[meta-18](../meta.md#meta-18)];
- capturing from selected thread text: prefills what the composer's queue-instead-of-send already captures; it earns its place if dogfooding shows mid-run capture losing to retyping;
- ledger text search: bounded queues plus the project filter suffice at today's volumes; search earns a decision when volume demands it, as with sessions ([DR-029](029-session-history-home.md)).

## Consequences

- The dashboard package is rewritten around the two sections: the intent read model and its derived states land as items, the attention items become the two-band intent-titled queue with the amended clearing rules, the History band's paging lands as read-model items, and the usage section retires from the Dashboard while the usage rollup read model stays core-side for the planned Insights surface; [[dashboard-24](../packages/dashboard.md#dashboard-24)] evolves into the Sources contract with capture controls and the record-status read.
- On acceptance, [DR-011](011-project-workspace.md)'s Dashboard content row is rewritten in place — attention queue and project groups — so no record still describes the retired sections.
- The core-service package gains the intents table, the five intent commands, the dispatch binding on submit, the per-project broadcast, the turn-attribution rule, the one-open-source-artifact invariant, the history paging read, and fixture-stream coverage of every derived state in the dashboard package's style.
- The run-view package gains the delivery card at each intent's final turn with confirm-pulls-next, attention activation focusing the session at the intent's place, the composer's queue-instead-of-send and staged-intent chip, the working line, and the Captain home next card.
- The projects and forge-work-lists packages amend so Repo-tab rows and Dashboard source rows share the Queue control and representation; the forge adapter itself is untouched.
- [[spec-view-14](../packages/spec-view.md#spec-view-14)]'s records listing gains the Status read; the records reader is otherwise unchanged.
- The Dashboard attention selector, the sidebar row marks, and the desktop dock tracker re-source to the one core fold, ending the three-derivations drift named in Context; the ledger lives in the core store, so remote serving carries it unchanged ([DR-033](033-remote-gui-serving.md)).
- Delivery binds to the [DR-026](026-data-graphics-craft.md) §9 design check: both themes, realistic multi-project data, contrast composites pinned by tests.

## References

[1]: https://addyo.substack.com/p/the-80-problem-in-agentic-coding "A. Osmani, The 80% Problem in Agentic Coding"
[2]: https://github.blog/news-insights/company-news/welcome-home-agents/ "GitHub, Introducing Agent HQ: mission control for agent tasks"
[3]: https://cursor.com/docs/cloud-agent "Cursor, Cloud Agents documentation"
[4]: https://developers.openai.com/codex/cloud "OpenAI, Codex cloud task list"
[5]: https://github.blog/changelog/2019-11-12-notifications-beta/ "GitHub Changelog, Notifications inbox beta: triage, respond, clear"
[6]: https://djaa.com/revisiting-the-principles-and-general-practices-of-the-kanban-method/ "D. J. Anderson, Revisiting the Principles and General Practices of the Kanban Method"
[7]: https://businessmap.io/continuous-flow/littles-law "Businessmap, What Is Little's Law?"
[8]: https://gettingthingsdone.com/2011/02/how-is-a-next-action-list-different-from-a-to-do-list/ "David Allen Co., How is a Next Action List Different from a To Do List?"
[9]: https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk "Linear, Our approach to building the Agent Interaction SDK (assignment vs delegation)"
[10]: https://ics.uci.edu/~gmark/chi08-mark.pdf "G. Mark, D. Gudith, U. Klocke, The Cost of Interrupted Work, CHI 2008"
[11]: https://ideas.repec.org/a/eee/jobhdp/v109y2009i2p168-181.html "S. Leroy, Why is it so hard to do my work? Attention residue in task switching, OBHDP 109(2), 2009"
