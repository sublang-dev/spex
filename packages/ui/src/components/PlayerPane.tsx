// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Read-only streaming player transcript (RUN-2/4/5): markdown text,
// collapsed tool-use cards, collapsed thinking, per-turn usage.

import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@sublang/spex-core/protocol";

import type { PlayerView, TranscriptSegment, UsageView } from "../state/reducer.js";
import { useStickToBottom, jumpPillClasses } from "../lib/useStickToBottom.js";
import { absoluteTitle, clockTime, duration } from "../lib/time.js";
import { inputBlocks, outputBlock } from "../lib/tool-body.js";
import { useClock } from "../lib/useClock.js";
import { FAST_MODE_MARK } from "./AgentChip.js";
import { Markdown } from "./Markdown.js";
import { RunningMark } from "./RunningMark.js";

const RENDER_WINDOW = 200;

function timeTitle(at: number): string {
  return Number.isFinite(at) ? new Date(at).toLocaleString() : "";
}

/** Prints only the tokens the call reported. A runtime that told us
 * nothing about tokens gets silence, not a zero it never measured
 * (DR-032); a cost it reported is never shown (DR-044). */
function Usage({ usage }: { usage: UsageView }) {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return null;
  }
  return (
    <span className="text-xs text-neutral-500">
      {`${(usage.inputTokens ?? 0).toLocaleString()}→${(
        usage.outputTokens ?? 0
      ).toLocaleString()} tok`}
    </span>
  );
}

/** The keys a tool call names its subject with, in the order the
 * card reads them (run-view-4). */
const SUBJECT_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "prompt",
  "description",
] as const;

/** What the call acts on, in one line: a collapsed card that says only
 * "Bash" leaves the reader guessing at every step of a run. */
/** The call a lane is on, or was last on: its latest prompt names the
 * role it served and when it opened (run-view-7). */
export function latestCall(
  view: PlayerView,
): { role?: string; at: number } | undefined {
  for (let i = view.segments.length - 1; i >= 0; i -= 1) {
    const segment = view.segments[i];
    if (segment.kind === "prompt") {
      return { at: segment.at, ...(segment.role ? { role: segment.role } : {}) };
    }
  }
  return undefined;
}

function toolSubject(input: unknown): string | undefined {
  const raw =
    typeof input === "string"
      ? input
      : input && typeof input === "object"
        ? SUBJECT_KEYS.map(
            (key) => (input as Record<string, unknown>)[key],
          ).find((value): value is string => typeof value === "string")
        : undefined;
  const line = unwrapShell(raw ?? "").trim().replace(/\s+/g, " ");
  return line ? line : undefined;
}

/** A command an agent's runner wrapped as `<shell> -lc <command>` —
 * codex runs every command through a login shell — is the inner
 * command as it was typed, its wrapper quotes gone (run-view-4). */
export function unwrapShell(command: string): string {
  const match = /^\s*(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/.exec(
    command,
  );
  if (!match) return command;
  const inner = match[1].trim();
  const quote = inner[0];
  if ((quote === "'" || quote === '"') && inner.endsWith(quote) && inner.length >= 2) {
    const body = inner.slice(1, -1);
    return quote === '"' ? body.replace(/\\(["\\$`])/g, "$1") : body.replace(/'\\''/g, "'");
  }
  return inner;
}

/** The tool name as a person reads it: a runner's wire name for its
 * shell tool reads "shell"; every other name stands as the runner
 * gave it. */
export function toolLabel(name: string): string {
  return name === "command_execution" ? "shell" : name;
}

function Segment({ segment }: { segment: TranscriptSegment }) {
  switch (segment.kind) {
    case "prompt":
      return (
        <details
          title={timeTitle(segment.at)}
          className="rounded border border-neutral-200 bg-neutral-100/60 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-400"
        >
          <summary className="cursor-pointer select-none">
            {/* A lane answers several roles over a session, so the call
                that opens here says which one it served (DR-032). */}
            {segment.role ? (
              <span
                data-testid={`call-role-${segment.seq}`}
                className="mr-2 rounded bg-brand-50 px-1.5 py-0.5 font-mono text-xs text-brand-700 dark:bg-brand-950 dark:text-brand-300"
              >
                {segment.role}
              </span>
            ) : null}
            Prompt
            {/* The call's clock, in the thread's one vocabulary
                (run-view-41); the exact moment stays in the tooltip. */}
            <time
              dateTime={new Date(segment.at).toISOString()}
              className="ml-2 text-xs tabular-nums text-neutral-500"
            >
              {clockTime(segment.at)}
            </time>
          </summary>
          <pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs">
            {segment.text}
          </pre>
        </details>
      );
    case "text":
      return (
        <div>
          <Markdown text={segment.text} links="web-only" />
          {segment.streaming ? (
            <span className="inline-block h-3 w-1.5 animate-pulse bg-neutral-400 align-baseline" />
          ) : null}
        </div>
      );
    case "thinking":
      return (
        <details className="rounded border border-dashed border-neutral-300 px-2 py-1 text-xs italic text-neutral-500 dark:border-neutral-700">
          <summary className="cursor-pointer select-none not-italic">
            Thinking
          </summary>
          <div className="mt-1 whitespace-pre-wrap">{segment.summary}</div>
        </details>
      );
    case "tool": {
      const subject = toolSubject(segment.input);
      // The glyph's hue says how the call ended; the word and the
      // mark say it too, so color is never the only channel
      // (run-view-50).
      const outcome =
        segment.status === "success"
          ? { word: "ok", mark: "✓", tone: "text-emerald-700 dark:text-emerald-400" }
          : segment.status === "error"
            ? { word: "failed", mark: "✗", tone: "text-red-600 dark:text-red-400" }
            : segment.status === "denied"
              ? { word: "denied", mark: "✗", tone: "text-red-600 dark:text-red-400" }
              : undefined;
      return (
        <details className="rounded border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <summary className="cursor-pointer select-none font-mono">
            {/* The row stays one line: the subject takes the rest of it
                and elides, so a long command never widens the pane. */}
            <span className="inline-flex w-[calc(100%-1.25rem)] items-baseline gap-1.5 align-middle">
              <span
                aria-hidden="true"
                className={outcome?.tone ?? "text-neutral-500"}
              >
                ⚒
              </span>
              <span className="shrink-0" title={segment.toolName}>
                {toolLabel(segment.toolName)}
              </span>
              {outcome ? (
                <span
                  data-testid={`tool-status-${segment.seq}`}
                  title={outcome.word}
                  className={`shrink-0 ${outcome.tone}`}
                >
                  <span aria-hidden="true">{outcome.mark}</span>
                  <span className="sr-only">{outcome.word}</span>
                </span>
              ) : null}
              {segment.durationMs !== undefined ? (
                <span
                  data-testid={`tool-duration-${segment.seq}`}
                  className="shrink-0 text-neutral-500"
                >
                  · {duration(segment.durationMs)}
                </span>
              ) : null}
              {subject ? (
                <span
                  data-testid={`tool-subject-${segment.seq}`}
                  className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400"
                >
                  {subject}
                </span>
              ) : null}
            </span>
          </summary>
          {/* Each string field verbatim, the rest as JSON, every line
              wrapping inside the card (run-view-4). */}
          <div
            data-testid={`tool-body-${segment.seq}`}
            className="relative mt-1 flex max-h-64 flex-col gap-1.5 overflow-y-auto"
          >
            {[...inputBlocks(segment.input), outputBlock(segment.output)]
              .filter((block) => block !== undefined)
              .map((block, index) => (
                <div key={index} className="min-w-0">
                  {block.label ? (
                    <div className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                      {block.label}
                    </div>
                  ) : null}
                  <pre
                    data-kind={block.kind}
                    className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs text-neutral-600 dark:text-neutral-400"
                  >
                    {block.text}
                  </pre>
                </div>
              ))}
          </div>
        </details>
      );
    }
    case "error":
      // One line per failure (run-view-127): a repeat folds into a
      // count whose meaning is also in text (DR-010 §7).
      return (
        <div
          data-testid="player-failure"
          title={timeTitle(segment.at)}
          className="flex items-baseline gap-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{segment.message}</span>
          {segment.count !== undefined && segment.count > 1 ? (
            <span
              data-testid="player-failure-count"
              title={`The same failure ${segment.count} times in this call`}
              className="shrink-0 font-medium"
            >
              <span aria-hidden="true">×{segment.count}</span>
              <span className="sr-only">, {segment.count} times</span>
            </span>
          ) : null}
        </div>
      );
    case "result":
      return (
        <div
          title={timeTitle(segment.at)}
          className="flex items-center gap-2 border-t border-neutral-200 pt-1 text-xs dark:border-neutral-800"
        >
          <span
            data-testid="player-result"
            // An error the failure line above already carries is not
            // printed twice (run-view-127): the words stay in the tooltip.
            title={segment.errorAbove ? segment.error : undefined}
            className={
              segment.status === "ok"
                ? "text-emerald-700 dark:text-emerald-400"
                : segment.status === "aborted"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400"
            }
          >
            {segment.status === "ok"
              ? "✓ finished"
              : segment.status === "aborted"
                ? "◇ aborted"
                : segment.errorAbove
                  ? "✗ failed"
                  : `✗ ${segment.error ?? "error"}`}
          </span>
          {segment.usage ? <Usage usage={segment.usage} /> : null}
        </div>
      );
  }
}

export function PlayerPane({
  view,
  meta,
  collapsed = false,
  onCollapsedChange,
}: {
  view: PlayerView;
  meta?: SessionInfo["players"][number];
  /** The lane stands as a rail (run-view-116). */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const [windowSize, setWindowSize] = useState(RENDER_WINDOW);
  const { scrollRef, onScroll, newBelow, jump, stuckRef } = useStickToBottom(
    view.segments.length,
  );
  // The pane names the role its latest call served, and while that
  // call is open, how long the player has been at it — ticking, so a
  // minutes-long call never reads as a hang (DR-010 §5).
  const call = latestCall(view);
  const who = call?.role ?? view.id;
  const now = useClock(view.running);
  // The toggle hands focus to its counterpart once the pane has taken
  // its other form (run-view-116): on the reader's own gesture, or
  // when the control they were on left with the form — a lane that
  // opens itself for its call (run-view-117) otherwise steals none.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!refocus.current && !focused.current) return;
    refocus.current = false;
    toggleRef.current?.focus();
  }, [collapsed]);
  const toggleProps = {
    type: "button" as const,
    ref: toggleRef,
    onClick: () => {
      refocus.current = true;
      onCollapsedChange?.(!collapsed);
    },
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
    },
    className:
      "flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200",
  };

  if (collapsed) {
    // The rail (run-view-116): the way back, the lane's running mark,
    // and its name read down the rail's length — exempt from the pane
    // floor, since it holds no transcript to fit.
    return (
      <section
        data-testid={`player-pane-${view.id}`}
        data-collapsed="true"
        className="flex min-h-0 w-9 flex-none flex-col items-center gap-2 rounded-lg border border-neutral-200 bg-white py-1.5 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <button
          {...toggleProps}
          title={`Expand ${view.id}`}
          aria-label={`Expand ${view.id}`}
          aria-expanded={false}
        >
          <span aria-hidden="true">⇥</span>
        </button>
        {view.running ? (
          <RunningMark running data-testid="player-running" title="Running" />
        ) : null}
        <span
          data-testid={`player-name-${view.id}`}
          title={view.id}
          className="min-h-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm font-semibold [writing-mode:vertical-rl]"
        >
          {view.id}
        </span>
      </section>
    );
  }

  const segments = view.segments.slice(-windowSize);

  return (
    <section
      data-testid={`player-pane-${view.id}`}
      className="@container flex min-h-0 min-w-[280px] flex-1 flex-col rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      {/* One line at any pane width: the lane's name is never abridged,
          a long model name elides, and the at-a-glance usage — which
          the transcript's own result line repeats — gives way first. */}
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <span
          data-testid={`player-name-${view.id}`}
          className="shrink-0 text-sm font-semibold"
        >
          {call?.role ? (
            <>
              {call.role}
              <span className="font-normal text-neutral-400"> · </span>
            </>
          ) : null}
          <span className="font-mono">{view.id}</span>
        </span>
        {meta ? (
          <span
            title={meta.model ?? meta.adapter}
            className="min-w-0 truncate rounded bg-neutral-100 px-1.5 py-0.5 text-xs whitespace-nowrap text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
          >
            {meta.model ?? meta.adapter}
            {meta.fastMode ? (
              // The player label wears the mark every chip wears
              // (DR-038, run-view-25).
              <span
                data-testid="player-fast-mode"
                title="fast mode"
                aria-label="fast mode"
                className="ml-1 text-amber-500"
              >
                {FAST_MODE_MARK}
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {view.running ? (
            // The app's one running mark (run-view-61), its meaning in
            // text as well as in the pulse — and the elapsed span of
            // the open call beside it, hidden first in a narrow pane.
            <>
              <RunningMark
                running
                data-testid="player-running"
                title="Running"
              />
              {call ? (
                <span
                  data-testid="player-working"
                  title={`${who} working since ${absoluteTitle(call.at)}`}
                  className="hidden whitespace-nowrap text-xs text-neutral-500 @md:inline dark:text-neutral-400"
                >
                  {who} working · {duration(now - call.at)}
                </span>
              ) : null}
            </>
          ) : view.turnUsage ? (
            <span className="hidden whitespace-nowrap @md:inline">
              <Usage usage={view.turnUsage} />
            </span>
          ) : null}
        </span>
        <button
          {...toggleProps}
          title={`Collapse ${view.id}`}
          aria-label={`Collapse ${view.id}`}
          aria-expanded
        >
          <span aria-hidden="true">⇤</span>
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2"
        >
          {view.segments.length > windowSize ? (
            <button
              type="button"
              onClick={() => {
                stuckRef.current = false;
                setWindowSize((size) => size + RENDER_WINDOW);
              }}
              className="text-center text-xs text-neutral-500 hover:text-brand-500"
            >
              Show {Math.min(RENDER_WINDOW, view.segments.length - windowSize)}{" "}
              of {view.segments.length - windowSize} earlier entries
            </button>
          ) : null}
          {segments.map((segment) => (
            <Segment key={segment.seq} segment={segment} />
          ))}
          {view.segments.length === 0 ? (
            <div className="m-auto text-xs text-neutral-500">
              Idle until the playbook calls {view.id}
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
