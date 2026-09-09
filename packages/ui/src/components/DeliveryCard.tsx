// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The intent delivery card (run-view-87, DR-035): a first-class
// settled card at the intent's final finished turn — title, provenance
// chip, run stats, Confirm foremost with Drop beside — resolving in
// place into the project's next queued intent once the verdict lands.
// The source chip (run-view-89) lives here too, shared with the Boss
// bubble that dispatched the intent.

import { useState } from "react";
import type {
  DerivedIntent,
  IntentInfo,
  IntentSource,
  IntentStats,
} from "@sublang/spex-core/protocol";

import { duration } from "../lib/time.js";

/** The first line of the intent's text is its display title (DR-035). */
export function intentTitle(intent: IntentInfo): string {
  return intent.text.split(/\r?\n/, 1)[0] ?? intent.text;
}

const SOURCE_LABEL: Record<IntentSource["kind"], (ref: string) => string> = {
  issue: (ref) => `#${ref}`,
  pr: (ref) => `PR ${ref}`,
  record: (ref) => ref,
  chat: () => "chat",
};

/** The intent's provenance chip: the source ref as the label, the raw
 * kind/ref/url in the tooltip. With a canonical URL it activates as a
 * link that opens outside the page — a new tab when served, the system
 * browser on the desktop — so the session never navigates away
 * (run-view-89); without one it is a plain marker — provenance is a
 * category, never a status hue. */
export function SourceChip({
  source,
  onDark,
}: {
  source?: IntentSource;
  /** Rendered on the brand-toned Boss bubble. */
  onDark?: boolean;
}) {
  if (!source) return null;
  const label = SOURCE_LABEL[source.kind](source.ref);
  const tooltip = `${source.kind} ${source.ref}${source.url ? ` — ${source.url}` : ""}`;
  const base =
    "inline-flex max-w-full items-center truncate rounded-full border px-1.5 text-xs font-medium";
  if (source.url) {
    // Interaction wears the brand hue (DR-013); on the Boss bubble the
    // bubble itself is brand, so the chip inverts.
    return (
      <a
        data-testid="intent-source-chip"
        href={source.url}
        target="_blank"
        rel="noreferrer"
        title={tooltip}
        className={`${base} ${
          onDark
            ? "border-white/40 text-white hover:bg-white/10"
            : "border-brand-300 text-brand-600 hover:bg-brand-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950"
        }`}
      >
        {label}
      </a>
    );
  }
  return (
    <span
      data-testid="intent-source-chip"
      title={tooltip}
      className={`${base} ${
        onDark
          ? "border-white/40 text-white"
          : "border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
      }`}
    >
      {label}
    </span>
  );
}

/** Review rounds foremost (omitted when zero), then turns, then
 * elapsed in the app's one duration vocabulary — the verdict is
 * informed before the click (run-view-87). */
export function statsLine(stats?: IntentStats): string | undefined {
  if (!stats) return undefined;
  const parts: string[] = [];
  if (stats.reviewRounds) {
    parts.push(
      `${stats.reviewRounds} review round${stats.reviewRounds === 1 ? "" : "s"}`,
    );
  }
  parts.push(`${stats.turns} turn${stats.turns === 1 ? "" : "s"}`);
  if (stats.elapsedMs !== undefined) parts.push(duration(stats.elapsedMs));
  return parts.join(" · ");
}

export function DeliveryCard({
  derived,
  closed,
  live,
  ownsConversation,
  next,
  onClose,
  onStartNext,
  onQueueNext,
}: {
  /** The finished intent as the ledger last derived it. */
  derived: DerivedIntent;
  /** True once the verdict landed and the intent left the open fold:
   * the card resolves in place into the project's next intent. */
  closed: boolean;
  /** False in an ended session's replay: the card renders inert. */
  live: boolean;
  /** Only the latest dispatch owns subsequent Boss messages. */
  ownsConversation: boolean;
  /** The project's next queued unblocked intent, for the pull. */
  next?: DerivedIntent;
  onClose(as: "done" | "dropped"): Promise<void>;
  onStartNext(intent: IntentInfo): void | Promise<void>;
  onQueueNext(text: string): Promise<void>;
}) {
  const [busy, setBusy] = useState<"done" | "dropped">();
  const [starting, setStarting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState("");
  const title = intentTitle(derived.intent);
  const stats = statsLine(derived.stats);
  const inertTitle = live
    ? undefined
    : "This session has ended — the replay is read-only";

  function verdict(as: "done" | "dropped"): void {
    if (busy || !live) return;
    setBusy(as);
    void onClose(as)
      .catch(() => {})
      .finally(() => setBusy(undefined));
  }

  if (closed) {
    // The verdict landed: the pull, in place (run-view-87).
    return (
      <div
        data-testid={`delivery-card-${derived.intent.id}`}
        data-settled="1"
        className="mx-auto flex w-full max-w-[95%] flex-col gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span className="min-w-0 truncate" title={derived.intent.text}>
            Settled — {title}
          </span>
          <SourceChip source={derived.intent.source} />
        </div>
        {next ? (
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate text-sm"
              title={next.intent.text}
            >
              Up next: <span className="font-medium">{intentTitle(next.intent)}</span>
            </span>
            <button
              type="button"
              data-testid="upnext-start"
              disabled={starting || !live}
              title={inertTitle}
              onClick={() => {
                setStarting(true);
                void Promise.resolve(onStartNext(next.intent))
                  .catch(() => {})
                  .finally(() => setStarting(false));
              }}
              className="shrink-0 rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-40"
            >
              {starting ? "Starting…" : "Start"}
            </button>
          </div>
        ) : (
          // An empty queue is an invitation, never a blank (DR-010 §5).
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = addText.trim();
              if (!trimmed || adding || !live) return;
              setAdding(true);
              void onQueueNext(trimmed)
                .then(() => setAddText(""))
                .catch(() => {})
                .finally(() => setAdding(false));
            }}
          >
            <input
              data-testid="upnext-add-input"
              value={addText}
              disabled={!live}
              title={inertTitle}
              onChange={(event) => setAddText(event.target.value)}
              placeholder="Nothing queued — name the next intent…"
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-400"
            />
            <button
              type="submit"
              data-testid="upnext-add"
              disabled={addText.trim().length === 0 || adding || !live}
              title={inertTitle}
              className="shrink-0 rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {adding ? "Queuing…" : "Queue"}
            </button>
          </form>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={`delivery-card-${derived.intent.id}`}
      data-settled="0"
      className="mx-auto flex w-full max-w-[95%] flex-col gap-1.5 rounded-lg border border-neutral-200 border-l-4 border-l-amber-400 bg-white px-3 py-2 dark:border-neutral-800 dark:border-l-amber-500 dark:bg-neutral-900"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
          Finished
        </span>
        <SourceChip source={derived.intent.source} />
      </div>
      <div
        className="min-w-0 truncate text-sm font-medium"
        title={derived.intent.text}
      >
        {title}
      </div>
      {stats ? (
        <div
          data-testid="delivery-stats"
          className="text-xs text-neutral-500 dark:text-neutral-400"
        >
          {stats}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="delivery-confirm"
          disabled={Boolean(busy) || !live}
          title={inertTitle}
          onClick={() => verdict("done")}
          className="rounded-md bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-40"
        >
          {busy === "done" ? "Confirming…" : "Confirm"}
        </button>
        <button
          type="button"
          data-testid="delivery-drop"
          disabled={Boolean(busy) || !live}
          title={inertTitle}
          onClick={() => verdict("dropped")}
          className="rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {busy === "dropped" ? "Dropping…" : "Drop"}
        </button>
        {ownsConversation ? (
          <span className="min-w-0 truncate text-xs text-neutral-500 dark:text-neutral-500">
            A follow-up message continues this intent.
          </span>
        ) : null}
      </div>
    </div>
  );
}
