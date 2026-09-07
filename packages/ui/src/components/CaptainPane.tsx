// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Captain thread (RUN-1, RUN-30): an IM-style conversation — the
// user's messages as their own bubbles, Captain speech as
// counterpart bubbles, player questions as first-class incoming
// messages, shell status lines as compact system lines between them.

import { useEffect, useState, type ReactNode } from "react";

import type { CaptainLine, SessionView } from "../state/reducer.js";
import { stateLabel } from "../lib/labels.js";
import { absoluteTitle, clockTime, duration } from "../lib/time.js";
import { useClock } from "../lib/useClock.js";
import { useStickToBottom, jumpPillClasses } from "../lib/useStickToBottom.js";
import { latestCall } from "./PlayerPane.js";
import { Markdown } from "./Markdown.js";
import { MachineCard } from "./MachineCard.js";
import { SourceChip } from "./DeliveryCard.js";
import type { IntentSource, MachineGraph } from "@sublang/spex-core/protocol";

/** A node the thread hosts after a given line — the run view anchors
 * an intent's delivery card at its final turn's end (run-view-87). */
export interface ThreadExtra {
  key: string;
  afterIndex: number;
  /** Focus/highlight identity for attention activation (run-view-91). */
  focusKey?: string;
  node: ReactNode;
}

/** The way to Settings a failure line offers while the Captain's
 * adapter reports not ready (run-view-2): the likely cause sits one
 * step from its remedy instead of behind a sidebar entry. */
export interface ReadinessHint {
  /** The unmet requirement, named in the link's tooltip. */
  requirement?: string;
  onOpenSettings(): void;
}

function Line({
  line,
  graphs,
  source,
  readiness,
}: {
  line: CaptainLine;
  graphs?: Record<string, MachineGraph | null>;
  /** The dispatched intent's provenance, worn by the bound turn's
   * Boss bubble (run-view-89). */
  source?: IntentSource;
  /** Present while the Captain's adapter is not ready: every failure
   * line then carries the link to Settings (run-view-2). */
  readiness?: ReadinessHint;
}) {
  const time = new Date(line.at).toLocaleString();
  switch (line.kind) {
    case "machine":
      // A finished run's drawn record settles into the thread
      // (run-view-62); without its frame it degrades to a plain line
      // per run-view-17.
      return line.frame ? (
        <div title={time}>
          <MachineCard
            frame={line.frame}
            graph={graphs?.[line.frame.playbookId]}
            graphs={graphs}
            settled
          />
        </div>
      ) : (
        <SystemLine text={line.text} title={time} />
      );
    case "boss":
      return (
        <div className="flex items-end justify-end gap-2" title={time}>
          <Stamp at={line.at} />
          <div
            data-testid="boss-bubble"
            className="min-w-0 max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-3 py-1.5 text-sm text-white"
          >
            {source ? (
              <div className="mb-0.5 flex justify-end">
                <SourceChip source={source} onDark />
              </div>
            ) : null}
            {/* The chip already carries the source's URL, so a trailing
                line that only repeats it stays out of the bubble
                (run-view-89); an unbroken token wraps rather than
                widening the pane. */}
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {withoutTrailingUrl(line.text, source?.url)}
            </span>
          </div>
        </div>
      );
    case "speech":
      return (
        <div className="flex items-end justify-start gap-2" title={time}>
          <div className="min-w-0 max-w-[85%] rounded-2xl rounded-bl-md bg-neutral-100 px-3 py-1.5 dark:bg-neutral-800">
            <Markdown text={line.text} links="web-only" />
          </div>
          <Stamp at={line.at} />
        </div>
      );
    case "question":
      // A player asking the Boss — the moment the product is built
      // around — renders as an incoming message from a named sender.
      return (
        <div className="flex items-end justify-start gap-2" title={time}>
          <div
            data-testid="question-bubble"
            className="min-w-0 max-w-[85%] rounded-2xl rounded-bl-md border-l-4 border-amber-400 bg-neutral-100 px-3 py-1.5 dark:border-amber-500 dark:bg-neutral-800"
          >
            {line.player ? (
              <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                {line.player}
              </div>
            ) : null}
            <div className="text-sm">
              <Markdown text={line.text} links="web-only" />
            </div>
          </div>
          <Stamp at={line.at} />
        </div>
      );
    case "error":
      // One line per failure (run-view-2): a repeat folds into a
      // count, and while the Captain's adapter is not ready the line
      // carries the way to the remedy.
      return (
        <div
          title={time}
          data-testid="failure-line"
          className="mx-auto flex max-w-[90%] flex-wrap items-baseline gap-x-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <span
            className="min-w-0 [overflow-wrap:anywhere]"
            title={line.raw}
            data-testid="failure-text"
          >
            {line.text}
          </span>
          {line.count !== undefined && line.count > 1 ? (
            <span
              data-testid="failure-count"
              title={`The same failure ${line.count} times in this turn`}
              className="shrink-0 font-medium"
            >
              <span aria-hidden="true">×{line.count}</span>
              <span className="sr-only">, {line.count} times</span>
            </span>
          ) : null}
          {readiness ? (
            <button
              type="button"
              data-testid="failure-readiness-link"
              onClick={readiness.onOpenSettings}
              title={readiness.requirement}
              className="shrink-0 font-medium text-brand-600 hover:underline dark:text-brand-300"
            >
              Check agent readiness
            </button>
          ) : null}
        </div>
      );
    default:
      return <SystemLine text={line.text} title={time} />;
  }
}

/** A message's time stamp (run-view-41): the clock time at the
 * bubble's outer foot, the way chat clients keep it — quiet, tabular,
 * outside the text's measure so it never reflows a message — with the
 * exact date and time in its tooltip and on the element for machines.
 * Narration lines keep their moment in the tooltip alone: a stamp on
 * every glyph line would be noise beside the messages. */
function Stamp({ at }: { at: number }) {
  if (!Number.isFinite(at)) return null;
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={absoluteTitle(at)}
      data-testid="message-time"
      className="shrink-0 pb-1 text-xs tabular-nums text-neutral-500 dark:text-neutral-400"
    >
      {clockTime(at)}
    </time>
  );
}

/** A Boss text without a last line that only repeats the intent
 * source's URL — the chip says it already (run-view-89). */
export function withoutTrailingUrl(text: string, url?: string): string {
  if (!url) return text;
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1].trim() === url) {
    return lines.slice(0, -1).join("\n").trimEnd();
  }
  return text;
}

/** The glyphs the captain shell narrates with (run-view-1). */
const NARRATION_GLYPH = /^([\u25c7\u25c6\u25b8\u2b95\u2937\u2192])\s?/u;

/** A shell status line as a system line (run-view-1, DR-010 §8): the
 * small type step, left-aligned like the conversation it sits in, the
 * glyph standing as an icon in a fixed slot — never a centered grey
 * mono whisper the room cannot read. The text keeps its glyph, so the
 * line reads the same to a screen reader and a test. */
function SystemLine({ text, title }: { text: string; title: string }) {
  const match = NARRATION_GLYPH.exec(text);
  const glyph = match?.[1];
  const body = glyph ? text.slice(glyph.length) : text;
  return (
    <div
      title={title}
      data-testid="system-line"
      className="flex items-start text-xs leading-5 text-neutral-600 dark:text-neutral-400"
    >
      <span
        aria-hidden={glyph ? undefined : true}
        className="flex w-4 shrink-0 justify-center text-neutral-500 dark:text-neutral-500"
      >
        {glyph}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {body}
      </span>
    </div>
  );
}

const TEN_MINUTES = 10 * 60 * 1000;

/** Visible time separator before the first line, after >10 minute
 * gaps, and on day boundaries — so a reopened transcript reads in
 * time without hovering line by line (DR-010 §2). */
export function timeSeparator(
  previousAt: number | undefined,
  at: number,
): string | undefined {
  if (!Number.isFinite(at)) return undefined;
  const current = new Date(at);
  if (previousAt === undefined) {
    return formatSeparator(current, true);
  }
  const previous = new Date(previousAt);
  const dayChanged = current.toDateString() !== previous.toDateString();
  if (dayChanged) return formatSeparator(current, true);
  if (at - previousAt > TEN_MINUTES) return formatSeparator(current, false);
  return undefined;
}

function formatSeparator(date: Date, withDay: boolean): string {
  // The separator speaks the stamps' clock (DR-010 §2): one time
  // vocabulary down the thread.
  const time = clockTime(date.getTime());
  if (!withDay) return time;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

const STATE_TONE_CLASSES: Record<string, string> = {
  amber:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  emerald:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  neutral:
    "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
};

export function CaptainPane({
  view,
  machineGraphs,
  bossSources,
  extras,
  readiness,
  focusKey,
  onFocusHandled,
}: {
  view: SessionView;
  /** Served machine definitions by playbook id (run-view-64: absent
   * definitions degrade to the observed drawing). */
  machineGraphs?: Record<string, MachineGraph | null>;
  /** Intent provenance by dispatched turn id (run-view-89). */
  bossSources?: Map<number, IntentSource>;
  /** Nodes anchored after specific lines (run-view-87). */
  extras?: ThreadExtra[];
  /** The Captain's adapter is not ready: failure lines link to
   * Settings (run-view-2). */
  readiness?: ReadinessHint;
  /** Scroll to and briefly highlight this line ("line-<index>") or
   * extra (its focusKey) — attention activation lands at the intent's
   * place (run-view-91). */
  focusKey?: string;
  onFocusHandled?: () => void;
}) {
  const { scrollRef, onScroll, newBelow, jump } = useStickToBottom(
    view.captain.length +
      view.captainDraft.length +
      (view.turnActive ? 1 : 0) +
      (extras?.length ?? 0),
  );
  const [highlightKey, setHighlightKey] = useState<string>();

  // Attention focus (run-view-91): land at the intent's place and
  // light it briefly, so the reader sees why they were summoned. The
  // target may fold in a render later than the request (a delivery
  // card mounts after the ledger settles), so an unfound key waits for
  // more content instead of being consumed.
  useEffect(() => {
    if (!focusKey) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-focus-key="${focusKey}"]`,
    );
    if (!target) return;
    target.scrollIntoView?.({ block: "center" });
    setHighlightKey(focusKey);
    onFocusHandled?.();
    // The scroll ref and callback are stable for a mounted pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, view.captain.length, extras]);

  useEffect(() => {
    if (!highlightKey) return;
    const timer = setTimeout(() => setHighlightKey(undefined), 2400);
    return () => clearTimeout(timer);
  }, [highlightKey]);

  /** Focusable wrapper: identity plus the brief reveal highlight. */
  function focusProps(key: string | undefined): {
    "data-focus-key"?: string;
    "data-focused"?: string;
    className: string;
  } {
    const focused = key !== undefined && highlightKey === key;
    return {
      ...(key !== undefined ? { "data-focus-key": key } : {}),
      ...(focused ? { "data-focused": "1" } : {}),
      className: focused
        ? "rounded-lg ring-2 ring-brand-400 dark:ring-brand-500"
        : "",
    };
  }

  // Who is at work, and since when (DR-010 §5): the running lanes'
  // latest calls, named by the role each serves, the span since the
  // earliest open call ticking so a minutes-long call never reads as
  // a hang.
  const working = Object.values(view.players)
    .filter((playerView) => playerView.running)
    .map((playerView) => ({
      who: latestCall(playerView)?.role ?? playerView.id,
      at: latestCall(playerView)?.at,
    }));
  const anyPlayerRunning = working.length > 0;
  const since = working
    .map((entry) => entry.at)
    .filter((at): at is number => at !== undefined)
    .reduce<number | undefined>(
      (earliest, at) => (earliest === undefined ? at : Math.min(earliest, at)),
      undefined,
    );
  const now = useClock(anyPlayerRunning && since !== undefined);
  const status = stateLabel(view.fsmState, {
    pendingQuestion: view.pendingQuestion !== undefined,
    turnActive: view.turnActive,
    playersRunning: Object.values(view.players).some(
      (playerView) => playerView.running,
    ),
  });
  // The live call tree's roots: a frame with no caller the pane knows
  // (run-view-63/78).
  const roots = view.frames.filter(
    (frame) =>
      !frame.parentSessionId ||
      !view.frames.some(
        (other) => other.traceSessionId === frame.parentSessionId,
      ),
  );

  return (
    <section
      data-testid="captain-pane"
      className="flex min-h-0 flex-1 flex-col rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">
          C
        </span>
        <span className="text-sm font-semibold">Captain</span>
        {view.fsmState || view.turnActive ? (
          <span
            data-testid="state-chip"
            title={view.fsmState ? `state: ${view.fsmState}` : undefined}
            className={`ml-auto rounded px-1.5 py-0.5 text-xs ${STATE_TONE_CLASSES[status.tone]}`}
          >
            {status.text}
          </span>
        ) : null}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2"
        >
          {view.captain.map((line, index) => {
            const separator = timeSeparator(
              index > 0 ? view.captain[index - 1].at : undefined,
              line.at,
            );
            const lineFocus = focusProps(`line-${index}`);
            return (
              <div key={index} className="flex flex-col gap-2">
                {separator ? (
                  <div
                    data-testid="time-separator"
                    className="pl-4 text-xs leading-5 text-neutral-500 dark:text-neutral-500"
                  >
                    {separator}
                  </div>
                ) : null}
                <div
                  data-focus-key={lineFocus["data-focus-key"]}
                  data-focused={lineFocus["data-focused"]}
                  className={lineFocus.className}
                >
                  <Line
                    line={line}
                    graphs={machineGraphs}
                    source={
                      line.kind === "boss" && line.turnId !== null
                        ? bossSources?.get(line.turnId)
                        : undefined
                    }
                    readiness={readiness}
                  />
                </div>
                {extras
                  ?.filter((extra) => extra.afterIndex === index)
                  .map((extra) => {
                    const extraFocus = focusProps(extra.focusKey);
                    return (
                      <div
                        key={extra.key}
                        data-focus-key={extraFocus["data-focus-key"]}
                        data-focused={extraFocus["data-focused"]}
                        className={extraFocus.className}
                      >
                        {extra.node}
                      </div>
                    );
                  })}
              </div>
            );
          })}
          {view.frames.length > 0 ? (
            // The live call tree: roots here, each card owning its own
            // children — including a child whose caller the pane never
            // saw, which renders at the top level rather than vanishing
            // (run-view-63/78).
            <div data-testid="live-machines" className="flex flex-col gap-2">
              {roots.map((frame) => (
                <MachineCard
                  key={frame.traceSessionId}
                  frame={frame}
                  graph={machineGraphs?.[frame.playbookId]}
                  graphs={machineGraphs}
                  openFrames={view.frames}
                  openChildren={view.frames.filter(
                    (other) =>
                      other.parentSessionId === frame.traceSessionId,
                  )}
                  onlyRoot={roots.length === 1}
                />
              ))}
            </div>
          ) : null}
          {view.captainDraft ? (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-neutral-100 px-3 py-1.5 dark:bg-neutral-800">
                <Markdown text={view.captainDraft} links="web-only" />
              </div>
            </div>
          ) : view.turnActive ? (
            // Life sign while agents work and the Captain is silent
            // (DR-010 §3): the thread is never inert mid-turn.
            <div
              className="flex justify-start"
              data-testid="working-indicator"
            >
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
                <span className="flex gap-1">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 [animation-delay:300ms]" />
                </span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {anyPlayerRunning
                    ? `${working.map((entry) => entry.who).join(", ")} working${
                        since !== undefined ? ` · ${duration(now - since)}` : "…"
                      }`
                    : "Captain is thinking…"}
                </span>
              </div>
            </div>
          ) : null}
          {view.captain.length === 0 &&
          !view.captainDraft &&
          !view.turnActive ? (
            <div className="m-auto text-xs text-neutral-500">
              The Captain will report here.
            </div>
          ) : null}
        </div>
        {newBelow ? (
          <button type="button" onClick={jump} className={jumpPillClasses()}>
            ↓ Latest
          </button>
        ) : null}
      </div>
    </section>
  );
}
