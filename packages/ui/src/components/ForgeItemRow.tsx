// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// One issue/PR row for the Repo tab and the Dashboard's Sources band
// alike (forge-work-lists-1): number, title opening the canonical
// page, forge labels as neutral tags, and the one-gesture Queue
// control — or the open intent's derived state once its artifact is
// captured (projects-6, dashboard-30). Labels are category data, so
// they wear neutral tags, never status hues (DR-013).

import { useState } from "react";
import type {
  DerivedIntent,
  ForgeItem,
  LedgerState,
} from "@sublang/spex-core/protocol";

/** Human words for a derived intent state (DR-010 §2): the raw enum
 * rides in tooltips, never as primary copy. */
export function intentStateText(derived: DerivedIntent): string {
  switch (derived.state) {
    case "queued":
      return derived.blockedBy ? "queued — blocked" : "queued";
    case "working":
      return "working";
    case "interrupted":
      return derived.reason === "failure"
        ? "failed"
        : derived.reason === "permission"
          ? "awaiting permission"
          : "needs your reply";
    case "finished":
      return "finished — confirm?";
    default:
      return derived.state;
  }
}

/** Open intents keyed by source artifact (`kind:ref`) for one project
 * — the dedup read that swaps a row's Queue control for its intent's
 * state and hands it back on close (dashboard-30, forge-work-lists-1).
 * The ledger serves open intents only, so no closed filtering here. */
export function openSourceIntents(
  ledger: LedgerState | undefined,
  projectId: string,
): Map<string, DerivedIntent> {
  const map = new Map<string, DerivedIntent>();
  for (const derived of ledger?.intents ?? []) {
    const source = derived.intent.source;
    if (!source || derived.intent.projectId !== projectId) continue;
    map.set(`${source.kind}:${source.ref}`, derived);
  }
  return map;
}

/** The capture seed the spec table pins (dashboard-30): the title is
 * the first line, the canonical URL rides in the text and again as
 * provenance. */
export function forgeSeedText(kind: "issue" | "pr", item: ForgeItem): string {
  if (kind === "issue") {
    return [
      `Address #${item.number}: ${item.title}`,
      "Read the issue and comments. Work on a new branch from the current default-branch commit, implement the requested change, and run relevant checks. " +
        `Push the branch and open a PR against the default branch with a summary, test results, and \`Closes #${item.number}\` in its description so merging it closes the issue.`,
      item.url,
    ].join("\n\n");
  }
  return `Review PR #${item.number}: ${item.title}\n${item.url}`;
}

/** The one capture control (DR-035): acknowledges in-frame with a
 * busy state while the queue write is in flight. */
export function QueueControl({
  ariaLabel,
  onQueue,
}: {
  ariaLabel: string;
  onQueue: () => void | Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={ariaLabel}
      onClick={() => {
        setBusy(true);
        void Promise.resolve(onQueue()).finally(() => setBusy(false));
      }}
      className="min-h-6 shrink-0 rounded border border-brand-300 px-2 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950"
    >
      {busy ? "Queuing…" : "Queue"}
    </button>
  );
}

/** A captured artifact's stand-in for the Queue control: the open
 * intent's derived state, raw enum in the tooltip (dashboard-30). */
export function CapturedState({
  derived,
  testId,
}: {
  derived: DerivedIntent;
  testId?: string;
}) {
  const text = intentStateText(derived);
  return (
    <span
      data-testid={testId}
      // No chip refuses to shrink past about 6rem (DR-041): the words
      // truncate, and the tooltip carries them whole — with the raw
      // enum beside them where the two differ.
      title={text === derived.state ? text : `${text} (${derived.state})`}
      className="min-w-0 max-w-24 truncate rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
    >
      {text}
    </span>
  );
}

export function ForgeItemRow({
  item,
  kind,
  captured,
  onQueue,
  testId,
}: {
  item: ForgeItem;
  kind: "issue" | "pr";
  /** The open intent already sourced from this artifact, when one
   * exists — it replaces the Queue control (dashboard-30). */
  captured?: DerivedIntent;
  onQueue: (item: ForgeItem) => void | Promise<unknown>;
  testId?: string;
}) {
  const labels = item.labels ?? [];
  return (
    // The row is its own container (DR-041): its labels are
    // at-a-glance duplicates and leave first, so a labelled row never
    // widens the band it lists in.
    <li
      className="@container flex min-w-0 items-center gap-2 text-sm"
      data-testid={testId}
    >
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        // Every label rides the row's own title, so the tags can go.
        title={labels.length > 0 ? `${item.title} — ${labels.join(", ")}` : item.title}
        className="min-w-0 flex-1 truncate text-left hover:underline"
      >
        <span className="text-brand-600 dark:text-brand-300">
          #{item.number}
        </span>{" "}
        {item.title}
      </a>
      {/* At most two labels show (DR-041); the rest fold into one
          "+N" tag whose title lists every label. Below 28rem of row
          the tags hide, their words kept in the row's title. */}
      {labels.slice(0, 2).map((label) => (
        <span
          key={label}
          title={label}
          className="hidden max-w-24 shrink-0 truncate rounded-full bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 @md:inline-block dark:bg-neutral-800 dark:text-neutral-400"
        >
          {label}
        </span>
      ))}
      {labels.length > 2 ? (
        <span
          data-testid={testId ? `${testId}-more-labels` : undefined}
          title={labels.join(", ")}
          aria-label={`${labels.length - 2} more labels: ${labels.slice(2).join(", ")}`}
          className="hidden shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 @md:inline-block dark:bg-neutral-800 dark:text-neutral-400"
        >
          +{labels.length - 2}
        </span>
      ) : null}
      {captured ? (
        <CapturedState
          derived={captured}
          testId={testId ? `${testId}-state` : undefined}
        />
      ) : (
        <QueueControl
          ariaLabel={`Queue ${kind === "pr" ? "PR" : "issue"} #${item.number} as an intent`}
          onQueue={() => onQueue(item)}
        />
      )}
    </li>
  );
}
