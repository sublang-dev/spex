// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The Dashboard (DR-035, dashboard-1..38): one question, top to
// bottom — what needs me, interrupted then finished, and where is
// each project. The two-band attention queue renders the core's one
// ledger fold as served; under it the Running band answers the other
// question — what is working right now, with nothing to answer
// (dashboard-50) — and below both, one ledger group per project, the
// same component the Overview tab draws (DR-038). Every state here is
// derived — the surface writes nothing but Boss acts (queue, close).

import { useEffect, useRef, useState } from "react";
import type {
  AttentionEntry,
  DerivedIntent,
  IntentInfo,
  IntentStats,
  ProjectInfo,
  SessionInfo,
} from "@sublang/spex-core/protocol";

import { useAppStore } from "../state/store.js";
import { absoluteTitle, duration, relativeAge } from "../lib/time.js";
import { RunningMark } from "./RunningMark.js";
import {
  ProjectGroup,
  TONE_CHIP,
  firstLine,
  queueOf,
  runningPlayer,
  sessionStatus,
  turnStartedAt,
  useCaptureReveal,
  useForgeAge,
  useGroupInputs,
  useNow,
} from "./ProjectGroup.js";

// ---------------------------------------------------------------------------
// Copy and formatting
// ---------------------------------------------------------------------------

/** Human reason labels for attention entries (DR-010 §2). */
const REASON_LABEL: Record<AttentionEntry["kind"], string> = {
  question: "needs your reply",
  permission: "awaiting permission",
  failure: "failed",
  finish: "finished — confirm?",
  review: "turn to review",
};

/** Band tones (DR-029): amber waits on the human, red means chase
 * this — only the unacknowledged failure wears it. */
function entryTone(entry: AttentionEntry): "amber" | "red" {
  return entry.kind === "failure" ? "red" : "amber";
}

const TONE_ROW: Record<"amber" | "red", string> = {
  amber:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200",
  red: "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
};

/** The finished entry's stats line (dashboard-35): review rounds
 * foremost, omitted when absent. */
export function statsLine(stats: IntentStats): string {
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

/** The globally next unblocked queue head, first by sidebar order
 * (dashboard-8): the all-clear state's pull. */
function nextUnblockedHead(
  intents: DerivedIntent[],
  projects: ProjectInfo[],
): DerivedIntent | undefined {
  for (const project of projects) {
    const head = queueOf(intents, project.id).find(
      (derived) => !derived.blockedBy,
    );
    if (head) return head;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Attention queue
// ---------------------------------------------------------------------------

function AttentionRow({
  entry,
  projectName,
  now,
  onOpen,
  onClose,
  onClosed,
}: {
  entry: AttentionEntry;
  projectName: string;
  now: number;
  onOpen: () => void;
  onClose: (as: "done" | "dropped") => Promise<void>;
  /** The verdict landed and this row is leaving: the parent hands
   * focus on (DR-010 §6). */
  onClosed: () => void;
}) {
  const [busy, setBusy] = useState<"done" | "dropped">();
  const [error, setError] = useState<string>();
  const tone = entryTone(entry);
  // A verdict is one click by design (DR-038): Confirm and Drop both
  // act on the click, and the History row is the record of it.
  const close = (as: "done" | "dropped") => {
    setBusy(as);
    setError(undefined);
    void onClose(as)
      .then(onClosed, (cause: Error) => setError(cause.message))
      .finally(() => setBusy(undefined));
  };
  const finishedIntent = entry.kind === "finish" && entry.intentId;
  return (
    <div
      data-testid={`attention-${entry.intentId ?? entry.sessionId}-${entry.kind}`}
      data-band={entry.band}
      data-tone={tone}
      // The row fits its pane (dashboard-1, DR-041): the title owns
      // the slack; the project name hides below @xs and the age
      // below @md.
      className={`@container flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm ${TONE_ROW[tone]}`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${entry.title} — ${REASON_LABEL[entry.kind]}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="shrink-0 rounded-full border border-current px-2 py-0.5 text-xs font-medium">
          {REASON_LABEL[entry.kind]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{entry.title}</span>
          {entry.stats ? (
            <span
              className="block truncate text-xs opacity-70"
              data-testid={`attention-stats-${entry.intentId ?? entry.sessionId}`}
            >
              {statsLine(entry.stats)}
            </span>
          ) : null}
          {error ? (
            <span className="block truncate text-xs" role="alert">
              Couldn't record the verdict: {error}
            </span>
          ) : null}
        </span>
        <span
          className="hidden min-w-0 max-w-40 truncate text-xs opacity-70 @xs:inline"
          title={projectName}
        >
          {projectName}
        </span>
        <span
          className="hidden shrink-0 text-xs opacity-70 @md:inline"
          title={absoluteTitle(entry.since)}
        >
          {relativeAge(entry.since, now)}
        </span>
      </button>
      {finishedIntent ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={busy !== undefined}
            data-testid={`attention-confirm-${entry.intentId}`}
            onClick={() => close("done")}
            className="min-h-6 rounded border border-current px-2 py-0.5 text-xs font-medium hover:bg-white/40 disabled:opacity-50 dark:hover:bg-black/20"
          >
            {busy === "done" ? "Confirming…" : "Confirm"}
          </button>
          <button
            type="button"
            disabled={busy !== undefined}
            data-testid={`attention-drop-${entry.intentId}`}
            onClick={() => close("dropped")}
            className="min-h-6 rounded px-1.5 py-0.5 text-xs opacity-70 hover:opacity-100 disabled:opacity-40"
          >
            {busy === "dropped" ? "Dropping…" : "Drop"}
          </button>
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Running band
// ---------------------------------------------------------------------------

/** One live session with a turn in flight and nothing to answer
 * (dashboard-50): the glance at what is working, in the same status
 * vocabulary the Now band speaks. */
function RunningRow({
  session,
  projectName,
  now,
  onOpen,
}: {
  session: SessionInfo;
  projectName: string;
  now: number;
  onOpen: () => void;
}) {
  const view = useAppStore((state) => state.views[session.id]);
  const status = sessionStatus(view);
  const player = runningPlayer(view);
  const startedAt = turnStartedAt(view);
  // The sidebar's title rule: the session's own words, a plain
  // stand-in until its first Boss turn lands.
  const title = session.title ?? "no messages yet";
  return (
    <button
      type="button"
      data-testid={`running-session-${session.id}`}
      data-project-id={session.projectId}
      onClick={onOpen}
      // The name holds still while the run advances (DR-041 §9): the
      // state is live content, read from the row, not from its name.
      aria-label={`Open ${title} — running in ${projectName}`}
      // The row fits its pane (dashboard-1's grammar, DR-041): the
      // title owns the slack, the state chip truncates beside it, and
      // the yield ladder drops the running player below @sm, the
      // project name below @xs, the elapsed span below @md.
      className="@container flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-2.5 text-left text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <RunningMark running />
      <span
        className="hidden min-w-0 max-w-40 shrink-0 truncate text-xs text-neutral-500 @xs:inline"
        title={projectName}
      >
        {projectName}
      </span>
      {player ? (
        <span className="hidden shrink-0 text-xs text-neutral-500 @sm:inline">
          {player}
        </span>
      ) : null}
      <span
        data-testid={`running-state-${session.id}`}
        className={`min-w-0 truncate rounded px-1.5 py-0.5 text-xs ${TONE_CHIP[status.tone]}`}
        title={view?.fsmState}
      >
        {status.text}
      </span>
      <span className="min-w-0 flex-1 truncate" title={title}>
        {title}
      </span>
      {startedAt !== undefined ? (
        <span
          className="hidden shrink-0 text-xs text-neutral-500 @md:inline"
          title={absoluteTitle(startedAt)}
        >
          {duration(Math.max(0, now - startedAt))}
        </span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export function DashboardSurface({
  onOpenSession,
  onOpenIntent,
  onStartIntent,
  onNavigate,
}: {
  /** Open a session; with a turnId, land at that turn's place. */
  onOpenSession: (sessionId: string, turnId?: number) => void;
  /** Open an intent record in its project's records reader. */
  onOpenIntent: (projectId: string, path: string, anchor: string) => void;
  /** Stage an intent's dispatch (the App wires this to the store's
   * stageDispatch and switches to the Workspace). */
  onStartIntent: (intent: IntentInfo) => Promise<void> | void;
  /** Optional Workspace navigation for empty-state guidance
   * (dashboard-8); plain copy stands in when the App leaves it
   * unwired. */
  onNavigate?: (surface: "Workspace") => void;
}) {
  const projects = useAppStore((state) => state.projects);
  const sessions = useAppStore((state) => state.sessions);
  const views = useAppStore((state) => state.views);
  const ledger = useAppStore((state) => state.ledger);
  const ledgerError = useAppStore((state) => state.ledgerError);
  const loadLedger = useAppStore((state) => state.loadLedger);
  const closeIntent = useAppStore((state) => state.closeIntent);

  const [projectFilter, setProjectFilter] = useState<string>("all");
  const now = useNow();
  useGroupInputs(projects);
  const fetchedAt = useForgeAge(projects);
  const { highlightId, capture } = useCaptureReveal();

  const filtered =
    projectFilter === "all"
      ? projects
      : projects.filter((project) => project.id === projectFilter);
  const intents = ledger?.intents ?? [];
  const attention = (ledger?.attention ?? []).filter(
    (entry) =>
      projectFilter === "all" || entry.projectId === projectFilter,
  );
  // Only an interruption of the current work replaces its running
  // row (dashboard-50). Earlier deliveries can still owe a verdict
  // while a later intent runs in the same conversation. Read the
  // unfiltered set so a project filter changes visibility alone.
  const summoned = new Set(
    (ledger?.attention ?? [])
      .filter((entry) =>
        entry.band === "interrupted" &&
        (entry.turnId === undefined || entry.turnId === views[entry.sessionId]?.currentTurnId),
      )
      .map((entry) => entry.sessionId),
  );
  const running = filtered.flatMap((project) =>
    sessions.filter(
      (session) =>
        session.live &&
        session.projectId === project.id &&
        views[session.id]?.turnActive === true &&
        !summoned.has(session.id),
    ),
  );
  const nextHead = nextUnblockedHead(intents, filtered);
  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? projectId;

  // A verdict removes its row; focus moves on to the entry that took
  // its place, else the previous one, else the all-clear — never the
  // page body (DR-010 §6).
  const queueRef = useRef<HTMLDivElement>(null);
  const [handOff, setHandOff] = useState<{ index: number }>();
  useEffect(() => {
    if (!handOff) return;
    const box = queueRef.current;
    if (!box) return;
    const rows = Array.from(box.querySelectorAll<HTMLElement>("[data-band]"));
    const row = rows[handOff.index] ?? rows[rows.length - 1];
    const target =
      row?.querySelector<HTMLElement>("button") ??
      box.querySelector<HTMLElement>('[data-testid="all-clear-start"]') ??
      box.querySelector<HTMLElement>('[data-testid="attention-all-clear"]') ??
      box.querySelector<HTMLElement>("button");
    target?.focus();
    setHandOff(undefined);
  }, [handOff]);

  const workspaceLink = (label: string) =>
    onNavigate ? (
      <button
        type="button"
        onClick={() => onNavigate("Workspace")}
        className="text-brand-600 hover:underline dark:text-brand-300"
      >
        {label}
      </button>
    ) : (
      <>{label}</>
    );

  // The Sources guidance points at the project's Overview, where the
  // repository header shows the GitHub binding (dashboard-8, DR-038).
  const openOverview = (projectId: string) => () => {
    const state = useAppStore.getState();
    state.setCurrentProject(projectId);
    state.setWorkspaceTab(projectId, "overview");
    onNavigate?.("Workspace");
  };

  return (
    // The surface root is the box the Dashboard scrolls in (DR-041
    // §9): height-constrained, and the containing block for its own
    // positioned content, so the page itself never scrolls.
    <div className="relative mx-auto flex w-full min-h-0 max-w-4xl flex-1 flex-col gap-5 overflow-y-auto p-6">
      {ledgerError ? (
        <div
          role="alert"
          data-testid="ledger-error"
          className="flex items-center gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <span className="min-w-0 flex-1 truncate">
            The ledger could not be loaded: {ledgerError}
          </span>
          <button
            type="button"
            onClick={() => void loadLedger()}
            className="min-h-6 shrink-0 rounded border border-current px-2 py-0.5 text-xs"
          >
            Retry
          </button>
        </div>
      ) : null}

      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-neutral-500">
            Needs attention
          </h2>
          <select
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            className="ml-auto rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            title="Filter by project (visibility only)"
            aria-label="Filter by project"
          >
            <option value="all">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div
          ref={queueRef}
          className="flex flex-col gap-2"
          data-testid="attention-queue"
        >
          {attention.map((entry, index) => (
            <AttentionRow
              key={`${entry.intentId ?? entry.sessionId}-${entry.kind}`}
              entry={entry}
              projectName={projectName(entry.projectId)}
              now={now}
              onOpen={() => onOpenSession(entry.sessionId, entry.turnId)}
              onClose={(as) =>
                entry.intentId
                  ? closeIntent(entry.intentId, as)
                  : Promise.resolve()
              }
              onClosed={() => setHandOff({ index })}
            />
          ))}
          {/* No false all-clear (dashboard-8): the box says it is
              loading until the ledger has been read, and says nothing
              beside the failure strip while a load has failed. */}
          {!ledger && !ledgerError ? (
            <div
              role="status"
              data-testid="attention-loading"
              className="rounded-lg border border-dashed border-neutral-300 px-4 py-4 text-center text-sm text-neutral-500 dark:border-neutral-700"
            >
              Loading…
            </div>
          ) : null}
          {ledger && !ledgerError && attention.length === 0 ? (
            <div
              data-testid="attention-all-clear"
              tabIndex={-1}
              className="flex items-center gap-3 rounded-lg border border-dashed border-neutral-300 px-4 py-4 text-sm text-neutral-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 dark:border-neutral-700"
            >
              {nextHead ? (
                <>
                  <span className="min-w-0 flex-1 truncate">
                    All clear. Next up:{" "}
                    <span className="font-medium text-neutral-700 dark:text-neutral-200">
                      {firstLine(nextHead.intent.text)}
                    </span>{" "}
                    <span className="text-neutral-500">
                      ({projectName(nextHead.intent.projectId)})
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid="all-clear-start"
                    onClick={() => void onStartIntent(nextHead.intent)}
                    className="min-h-6 shrink-0 rounded bg-brand-600 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-400"
                  >
                    Start
                  </button>
                </>
              ) : (
                <span className="flex-1 text-center">
                  All clear — nothing waiting, nothing queued to start.
                </span>
              )}
            </div>
          ) : null}
        </div>
      </section>

      {/* What is working, with nothing to answer (dashboard-50): the
          band keeps its place whether or not anything runs. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-500">Running</h2>
        <div className="flex flex-col gap-2" data-testid="running-band">
          {running.map((session) => (
            <RunningRow
              key={session.id}
              session={session}
              projectName={projectName(session.projectId)}
              now={now}
              onOpen={() => onOpenSession(session.id)}
            />
          ))}
          {running.length === 0 ? (
            <div
              data-testid="running-empty"
              className="rounded-lg border border-dashed border-neutral-300 px-4 py-4 text-center text-sm text-neutral-500 dark:border-neutral-700"
            >
              Nothing running.
            </div>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-500">Projects</h2>
        {projects.length === 0 ? (
          <div
            data-testid="projects-empty"
            className="rounded-lg border border-dashed border-neutral-300 px-4 py-5 text-center text-sm text-neutral-500 dark:border-neutral-700"
          >
            No projects yet — register a repository in the{" "}
            {workspaceLink("Workspace")} to put its work here.
          </div>
        ) : (
          filtered.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              now={now}
              fetchedAt={fetchedAt(project.id)}
              highlightId={highlightId}
              onOpenSession={onOpenSession}
              onOpenIntent={onOpenIntent}
              onStartIntent={onStartIntent}
              onCapture={capture}
              onOpenOverview={onNavigate ? openOverview(project.id) : undefined}
            />
          ))
        )}
      </section>
    </div>
  );
}
