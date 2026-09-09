// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// One project's ledger group (dashboard-26..30, DR-035): History,
// Now, Up next, and Sources, drawn by this one component wherever the
// group appears — the Dashboard lists every project's, the Overview
// tab pins one (projects-4, DR-038, DR-027). Every state here is
// derived; the group writes nothing but Boss acts (queue, move,
// close, remove).

import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  ClosedIntent,
  DerivedIntent,
  IntentInfo,
  IntentSource,
  ProjectInfo,
  SessionInfo,
  SpecRecordInfo,
  SpecTreeState,
} from "@sublang/spex-core/protocol";

import { useAppStore, type ProjectMeta } from "../state/store.js";
import type { SessionView } from "../state/reducer.js";
import { stateLabel, type StatusTone } from "../lib/labels.js";
import { absoluteTitle, relativeAge } from "../lib/time.js";
import { usePopover } from "../lib/usePopover.js";
import { activatedByKeyboard, useUndoLine } from "../lib/useUndoLine.js";
import { currentSessionOf } from "../lib/sessions.js";
import { RunningMark } from "./RunningMark.js";
import { SourcesBand } from "./SourcesTabs.js";
import { openSourceIntents } from "./ForgeItemRow.js";
import { Icon } from "./Icon.js";
import { InlineConfirm } from "./InlineConfirm.js";
import { RecordRow } from "./RecordRow.js";
import { ResizableFrame } from "./ResizableFrame.js";

// ---------------------------------------------------------------------------
// Copy and formatting
// ---------------------------------------------------------------------------

export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? text;
}

/** A project's queue in served (rank) order. */
export function queueOf(
  intents: DerivedIntent[],
  projectId: string,
): DerivedIntent[] {
  return intents.filter(
    (derived) =>
      derived.intent.projectId === projectId && derived.state === "queued",
  );
}

/** What a session is doing, in the one status vocabulary
 * (dashboard-28, dashboard-50, DR-010 §2): the label the Now band
 * shows, with activity supplied by the caller — a live turn with no leaf
 * state says "working" while a player runs and "deciding" while the
 * Captain has the floor (run-view-59). */
export function sessionStatus(
  view: SessionView | undefined,
  turnActive: boolean | undefined,
): { text: string; tone: StatusTone } {
  return stateLabel(view?.fsmState, {
    pendingQuestion: view?.pendingQuestion !== undefined,
    turnActive,
    playersRunning: runningPlayer(view) !== undefined,
  });
}

/** The player holding the floor, when one runs: the Running band
 * names it beside the state (dashboard-50). */
export function runningPlayer(view: SessionView | undefined): string | undefined {
  return Object.values(view?.players ?? {}).find((player) => player.running)?.id;
}

/** When the session's turn in flight began — the first line it drew,
 * so its span reads without new state (dashboard-50). */
export function turnStartedAt(view: SessionView | undefined): number | undefined {
  if (!view?.turnActive) return undefined;
  return view.captain.find((line) => line.turnId === view.currentTurnId)?.at;
}

/** Session-state chip classes per tone (DR-013: brand purple stays
 * interactive, so status chips tint amber/red/neutral only; running
 * aliveness is the emerald mark, not a chip hue). */
export const TONE_CHIP: Record<StatusTone, string> = {
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  emerald:
    "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  neutral:
    "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
};

const TAG = "shrink-0 rounded-full px-1.5 py-0.5 text-xs";
const NEUTRAL_TAG = `${TAG} bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400`;
/** The band's one red tag (DR-038): a fixed bug, gone. */
const BUG_TAG = `${TAG} bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300`;

const MENU_ITEM =
  "flex min-h-6 items-center gap-3 rounded px-2 py-1 text-left hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-neutral-800";

const TEXT_LINK =
  "min-h-6 rounded px-1 text-brand-600 hover:underline dark:text-brand-300";

/** How long a dropped intent's outcome line stands. */
const NOTE_MS = 6_000;

export interface CaptureInput {
  projectId: string;
  text: string;
  source?: IntentSource;
}

/** The ledger's read state, so an empty queue is never claimed before
 * the ledger has been read (dashboard-8). */
type LedgerState = "loading" | "failed" | "ready";

// ---------------------------------------------------------------------------
// The group's inputs, shared by every surface that draws one
// ---------------------------------------------------------------------------

/** A slow clock for the age labels: honest during quiet periods,
 * never a re-render storm. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The one fold, plus each group's inputs — meta, specs tree, History
 * first page — load on demand once connected. */
export function useGroupInputs(projects: readonly ProjectInfo[]): void {
  const connection = useAppStore((state) => state.connection);
  const key = projects.map((project) => project.id).join("\n");
  useEffect(() => {
    if (connection !== "open") return;
    const state = useAppStore.getState();
    if (!state.ledger && !state.ledgerError) void state.loadLedger();
    for (const project of projects) {
      if (!state.projectMeta[project.id]) void state.loadProjectMeta(project.id);
      if (!state.specTrees[project.id]) void state.loadSpecs(project.id);
      if (!state.history[project.id]) void state.loadHistory(project.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, key]);
}

/** When this client observed each project's served forge data — the
 * Sources line's data age (dashboard-14). (The read model's own fetch
 * time is not on the wire yet — see the report.) */
export function useForgeAge(
  projects: readonly ProjectInfo[],
): (projectId: string) => number | undefined {
  const projectMeta = useAppStore((state) => state.projectMeta);
  const metaSeen = useRef(new Map<string, ProjectMeta>());
  const [fetchedAt, setFetchedAt] = useState<Record<string, number>>({});
  useEffect(() => {
    const updates: Record<string, number> = {};
    for (const project of projects) {
      const meta = projectMeta[project.id];
      if (meta && !meta.loading && metaSeen.current.get(project.id) !== meta) {
        metaSeen.current.set(project.id, meta);
        updates[project.id] = Date.now();
      }
    }
    if (Object.keys(updates).length > 0) {
      setFetchedAt((current) => ({ ...current, ...updates }));
    }
  }, [projectMeta, projects]);
  return (projectId) => fetchedAt[projectId];
}

/** Capture reveals the shelf (dashboard-31): the new row lands with
 * a brief highlight where it landed. */
export function useCaptureReveal(): {
  highlightId?: string;
  capture: (input: CaptureInput) => Promise<IntentInfo>;
} {
  const queueIntent = useAppStore((state) => state.queueIntent);
  const [highlightId, setHighlightId] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const capture = async (input: CaptureInput): Promise<IntentInfo> => {
    const intent = await queueIntent(input);
    setHighlightId(intent.id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlightId(undefined), 2500);
    return intent;
  };
  return { highlightId, capture };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function BandHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </h4>
  );
}

export type HistoryRow =
  | { kind: "intent"; id: string; at: number; intent: IntentInfo }
  | { kind: "record"; id: string; at: number; record: SpecRecordInfo };

/** The moment a finished record's status line dates it — "Done
 * (2026-09-02)" — when it carries one (dashboard-27). */
export function statusDate(status: string | undefined): number | undefined {
  const match = /\b(\d{4}-\d{2}-\d{2})\b/.exec(status ?? "");
  if (!match) return undefined;
  const at = Date.parse(match[1]);
  return Number.isFinite(at) ? at : undefined;
}

/** The band's one timeline (dashboard-27, DR-038): the served worked
 * closed intents and the tree's finished records, newest first — a
 * record a closed intent names as its provenance lists once, as that
 * intent. Intents order by close time, records by the date their
 * status line carries, else by their file's last change. */
export function historyRows(
  closed: readonly ClosedIntent[],
  records: readonly SpecRecordInfo[],
): HistoryRow[] {
  const named = new Set<string>();
  const rows: HistoryRow[] = [];
  for (const { intent } of closed) {
    if (intent.source?.kind === "record") named.add(intent.source.ref);
    rows.push({
      kind: "intent",
      id: intent.id,
      at: intent.closedAt ?? 0,
      intent,
    });
  }
  for (const record of records) {
    if (!record.finished || named.has(record.id)) continue;
    rows.push({
      kind: "record",
      id: record.id,
      at: statusDate(record.status) ?? record.updatedAt ?? 0,
      record,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

/** A fixed bug (DR-038): an intent closed done whose captured source
 * labels carry a bug label — provenance, never a later forge read. */
export function isBugFix(intent: IntentInfo): boolean {
  return (
    intent.closedAs === "done" &&
    (intent.source?.labels ?? []).some((label) => /bug/i.test(label))
  );
}

function Check() {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 text-emerald-700 dark:text-emerald-400"
    >
      ✓
    </span>
  );
}

/** An age in the one time vocabulary (DR-010 §2): "3m ago" with the
 * absolute moment in the tooltip. */
function Age({ at, now }: { at?: number; now: number }) {
  if (at === undefined) return null;
  return (
    <span
      className="shrink-0 text-xs text-neutral-500"
      title={absoluteTitle(at)}
    >
      {relativeAge(at, now)}
    </span>
  );
}

/** The row grammar (dashboard-27): done wears a check; a fixed bug is
 * struck through under the red tag and wears none; work dropped
 * after it ran wears a quiet tag, dimmed, never struck. The row also
 * carries its way off the record — revealed on hover and on focus,
 * behind the house confirm (DR-010 §4). */
function IntentHistoryRow({
  intent,
  now,
  confirming,
  onAsk,
  onKeep,
  onRemove,
}: {
  intent: IntentInfo;
  now: number;
  confirming: boolean;
  onAsk: () => void;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const verdict =
    intent.closedAs === "dropped"
      ? "dropped"
      : isBugFix(intent)
        ? "bug"
        : "done";
  const title = firstLine(intent.text);
  return (
    <li
      data-testid={`history-row-${intent.id}`}
      data-kind="intent"
      data-verdict={verdict}
      className={`group flex h-6 shrink-0 items-center gap-2 text-sm ${
        verdict === "dropped" ? "text-neutral-500" : ""
      }`}
    >
      {confirming ? (
        <span
          data-testid={`history-remove-confirm-${intent.id}`}
          className="min-w-0 flex-1"
        >
          <InlineConfirm
            question="Remove this intent from history?"
            confirmLabel="Remove"
            cancelLabel="Keep"
            onConfirm={onRemove}
            onCancel={onKeep}
          />
        </span>
      ) : (
        <>
          {verdict === "done" ? <Check /> : null}
          <span className="sr-only">
            {verdict === "bug" ? "bug fixed" : verdict}
          </span>
          {verdict === "bug" ? (
            <span data-testid="history-tag" className={BUG_TAG}>
              bug
            </span>
          ) : null}
          {verdict === "dropped" ? (
            <span data-testid="history-tag" className={NEUTRAL_TAG}>
              dropped
            </span>
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate ${
              verdict === "bug" ? "line-through" : ""
            }`}
            title={title}
          >
            {title}
          </span>
          <Age at={intent.closedAt} now={now} />
          <button
            type="button"
            data-testid={`history-remove-${intent.id}`}
            aria-label={`Remove ${title} from history`}
            title="Remove this intent from history"
            onClick={onAsk}
            className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 opacity-0 hover:text-red-600 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 dark:hover:text-red-400"
          >
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </li>
  );
}

/** A finished record (dashboard-27): a check before its record row
 * (dashboard-40), opening in the records reader; a superseded one
 * wears that word as a trailing tag, dimmed, with no check. */
function RecordHistoryRow({
  record,
  now,
  onOpen,
}: {
  record: SpecRecordInfo;
  now: number;
  onOpen: () => void;
}) {
  const superseded = record.finished === "superseded";
  return (
    <li
      data-testid={`history-row-${record.id}`}
      data-kind="record"
      data-verdict={superseded ? "superseded" : "done"}
      className={`flex h-6 shrink-0 items-center gap-2 text-sm ${
        superseded ? "text-neutral-500" : ""
      }`}
    >
      {superseded ? null : <Check />}
      <span className="sr-only">{superseded ? "superseded" : "done"}</span>
      <RecordRow
        record={record}
        onClick={onOpen}
        className="flex-1"
        trailing={
          superseded ? (
            <span data-testid="history-tag" className={NEUTRAL_TAG}>
              superseded
            </span>
          ) : undefined
        }
      />
      <Age at={statusDate(record.status) ?? record.updatedAt} now={now} />
    </li>
  );
}

/** The History frame's height in rows (dashboard-27): every loaded row
 * lists inside it, and it scrolls once the rows exceed it. Each row is
 * `h-6` (1.5rem) tall, so the frame's height counts in rows exactly —
 * eight by default, four to twenty-four once the reader has pulled its
 * bottom edge (DR-030). */
const HISTORY_ROW = 24;
const HISTORY_FRAME = 8;
const HISTORY_MIN = 4;
const HISTORY_MAX = 24;

function HistoryBand({
  project,
  tree,
  now,
  onOpenIntent,
}: {
  project: ProjectInfo;
  tree?: SpecTreeState;
  now: number;
  onOpenIntent: (projectId: string, path: string, anchor: string) => void;
}) {
  const history = useAppStore((state) => state.history[project.id]);
  const loadHistory = useAppStore((state) => state.loadHistory);
  const removeIntent = useAppStore((state) => state.removeIntent);
  /** The one row asking to leave the record (DR-010 §4). */
  const [confirming, setConfirming] = useState<string>();
  /** Where focus lands once the confirm closes (DR-010 §6): the named
   * row's control, or — for the empty name — the band itself. */
  const [refocus, setRefocus] = useState<string>();
  const band = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (refocus === undefined) return;
    setRefocus(undefined);
    const control = refocus
      ? band.current?.querySelector<HTMLElement>(
          `[data-testid="history-remove-${refocus}"]`,
        )
      : undefined;
    (control ?? band.current)?.focus();
  }, [refocus]);

  const more = history?.more ?? false;
  const rows = historyRows(history?.intents ?? [], tree?.intents ?? []);
  // Loading reads as loading until the page has answered
  // (dashboard-8): an unread band never claims nothing was done, and
  // the control says a page is in flight while records already show.
  const inFlight = history === undefined || history.loading === true;
  // "Older…" stands at the end of the scrolled list while unfetched
  // rows wait (dashboard-27): paging keeps its semantics, and the
  // group's height never grows past the frame.
  const older = more || inFlight;
  // The cut edges and the frame's own focus stand while the rows run
  // past it (dashboard-27); the frame measures that and says so, so a
  // frame the reader resized answers for its new height.
  const [overflowing, setOverflowing] = useState(false);
  const fetchOlder = () => {
    if (more && !inFlight) void loadHistory(project.id, true);
  };
  /** The row leaves at once, and focus lands where the reader was
   * working: the next row's control, or the band itself (DR-010 §6). */
  const remove = (intentId: string): void => {
    const intentIds = rows
      .filter((row) => row.kind === "intent")
      .map((row) => row.id);
    const next = intentIds[intentIds.indexOf(intentId) + 1] ?? "";
    setConfirming(undefined);
    void removeIntent(intentId).finally(() => setRefocus(next));
  };
  return (
    <div
      ref={band}
      tabIndex={-1}
      className="flex flex-col gap-1 focus:outline-none"
      data-testid={`history-${project.id}`}
    >
      <BandHeading>History</BandHeading>
      {rows.length === 0 ? (
        <div
          className="text-xs text-neutral-500"
          data-testid={`history-empty-${project.id}`}
        >
          {inFlight ? "Loading…" : "Nothing done here yet."}
        </div>
      ) : (
        // The cut edges draw only where the frame overflows, so a short
        // history reads as a plain list, and the grip beneath them is
        // the frame's own (DR-030).
        <ResizableFrame
          as="ul"
          frameId={`history:${project.id}`}
          label="Resize History"
          unit={HISTORY_ROW}
          defaultSteps={HISTORY_FRAME}
          minSteps={HISTORY_MIN}
          maxSteps={HISTORY_MAX}
          onOverflow={setOverflowing}
          data-testid={`history-frame-${project.id}`}
          aria-label="History"
          // A frame that scrolls is reachable by keyboard as well as
          // through the controls it holds (DR-010 §5).
          tabIndex={overflowing ? 0 : undefined}
          className={`flex flex-col rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
            overflowing
              ? "border-y border-neutral-200 dark:border-neutral-800"
              : ""
          }`}
        >
          {rows.map((row) =>
            row.kind === "intent" ? (
              <IntentHistoryRow
                key={`intent:${row.id}`}
                intent={row.intent}
                now={now}
                confirming={confirming === row.id}
                onAsk={() => setConfirming(row.id)}
                onKeep={() => {
                  setConfirming(undefined);
                  setRefocus(row.id);
                }}
                onRemove={() => remove(row.id)}
              />
            ) : (
              <RecordHistoryRow
                key={`record:${row.id}`}
                record={row.record}
                now={now}
                onOpen={() =>
                  onOpenIntent(
                    project.id,
                    row.record.path,
                    `record-row-${row.record.id}`,
                  )
                }
              />
            ),
          )}
          {older ? (
            <li className="flex h-6 shrink-0 items-center">
              <button
                type="button"
                data-testid={`history-older-${project.id}`}
                disabled={inFlight}
                onClick={fetchOlder}
                className={`${TEXT_LINK} text-xs disabled:opacity-50`}
              >
                {inFlight ? "Loading…" : "Older…"}
              </button>
            </li>
          ) : null}
        </ResizableFrame>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Now
// ---------------------------------------------------------------------------

function NowBand({
  project,
  session,
  intents,
  now,
  onOpenSession,
}: {
  project: ProjectInfo;
  session?: SessionInfo;
  intents: DerivedIntent[];
  now: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const view = useAppStore((state) =>
    session ? state.views[session.id] : undefined,
  );
  const closeIntent = useAppStore((state) => state.closeIntent);
  // Drop on the served intent (dashboard-41): behind the inline
  // confirm, since work is underway; the outcome line lasts six
  // seconds, and focus goes back to the control — or, once the
  // control has left with the intent, to the session row.
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [dropNote, setDropNote] = useState<string>();
  const [refocusDrop, setRefocusDrop] = useState(false);
  const dropRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!refocusDrop || confirmDrop) return;
    (dropRef.current ?? rowRef.current)?.focus();
    setRefocusDrop(false);
  }, [refocusDrop, confirmDrop]);
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );
  if (!session) {
    // Quiet when the project has no conversation yet (dashboard-8/28).
    return (
      <div className="flex flex-col gap-1" data-testid={`now-${project.id}`}>
        <BandHeading>Now</BandHeading>
        <div className="text-xs text-neutral-500">Idle — no conversation yet.</div>
      </div>
    );
  }
  const turnActive = session.turnActive ?? view?.turnActive;
  const label = sessionStatus(view, turnActive);
  // The open intent this lane serves: the newest open dispatch into
  // the session owns the conversation (dashboard-28/33).
  const served = intents
    .filter(
      (derived) =>
        derived.intent.dispatched?.sessionId === session.id &&
        (derived.state === "working" || derived.state === "interrupted"),
    )
    .sort(
      (a, b) =>
        (b.intent.dispatched?.at ?? 0) - (a.intent.dispatched?.at ?? 0),
    )[0];
  const bossTurns = view?.captain.filter((line) => line.kind === "boss") ?? [];
  const title = firstLine(
    served?.intent.text ??
      bossTurns[bossTurns.length - 1]?.text ??
      session.title ??
      "no messages yet",
  );
  const playbook = view?.frames[0]?.playbookId;

  const drop = async () => {
    if (!served) return;
    const dropped = served.intent;
    const droppedTitle = firstLine(dropped.text);
    setConfirmDrop(false);
    setDropping(true);
    try {
      // The verdict closes the intent; the session keeps its turn
      // (dashboard-41) — History lists the drop once that turn ends.
      await closeIntent(dropped.id, "dropped");
      setDropNote(`Dropped “${droppedTitle}” — the session keeps running.`);
    } catch (cause) {
      setDropNote(
        `Couldn't drop “${droppedTitle}”: ${(cause as Error).message}`,
      );
    } finally {
      setDropping(false);
      setRefocusDrop(true);
    }
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setDropNote(undefined), NOTE_MS);
  };

  return (
    <div className="flex flex-col gap-1" data-testid={`now-${project.id}`}>
      <BandHeading>Now</BandHeading>
      {/* The row fits its band (DR-041): the title owns the slack, the
          age hides below @md and the playbook name below @xs. */}
      <div className="@container flex items-center gap-2">
        <button
          ref={rowRef}
          type="button"
          data-testid={`now-session-${project.id}`}
          data-intent-id={served?.intent.id}
          onClick={() => onOpenSession(session.id)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <RunningMark running={turnActive ?? false} />
          {/* The playbook only once a run draws one: "no playbook" says
              nothing a reader can act on (dashboard-28). */}
          {playbook ? (
            <span className="hidden shrink-0 text-xs text-neutral-500 @xs:inline">
              {playbook}
            </span>
          ) : null}
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${TONE_CHIP[label.tone]}`}
            title={view?.fsmState}
          >
            {label.text}
          </span>
          <span className="min-w-0 flex-1 truncate" title={title}>
            {title}
          </span>
          <span
            className="hidden shrink-0 text-xs text-neutral-500 @md:inline"
            title={absoluteTitle(session.createdAt)}
          >
            started {relativeAge(session.createdAt, now)}
          </span>
        </button>
        {served ? (
          <button
            ref={dropRef}
            type="button"
            data-testid={`now-drop-${project.id}`}
            disabled={dropping}
            aria-label={`Drop ${title}`}
            title="Close this intent as dropped — the session keeps running"
            onClick={() => setConfirmDrop(true)}
            className="min-h-6 shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:border-red-300 hover:text-red-600 disabled:animate-pulse dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-red-800 dark:hover:text-red-400"
          >
            {dropping ? "Dropping…" : "Drop"}
          </button>
        ) : null}
      </div>
      {confirmDrop && served ? (
        <div data-testid={`now-drop-confirm-${project.id}`}>
          <InlineConfirm
            question={`Drop “${title}”? Work is underway.`}
            confirmLabel="Drop"
            cancelLabel="Keep"
            onConfirm={() => void drop()}
            onCancel={() => {
              setConfirmDrop(false);
              setRefocusDrop(true);
            }}
          />
        </div>
      ) : null}
      {dropNote ? (
        <div
          role="status"
          data-testid={`now-note-${project.id}`}
          className={`text-xs ${
            dropNote.startsWith("Couldn't")
              ? "text-red-600 dark:text-red-400"
              : "text-neutral-500"
          }`}
        >
          {dropNote}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Up next
// ---------------------------------------------------------------------------

/** One entry of the row menu: the label, and the keyboard shortcut
 * where one exists — shown for the eye, carried by aria-keyshortcuts
 * for the ear. */
function MenuItem({
  children,
  hint,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { hint?: string }) {
  return (
    <button type="button" role="menuitem" className={MENU_ITEM} {...props}>
      <span className="flex-1">{children}</span>
      {hint ? (
        <span aria-hidden="true" className="text-neutral-500">
          {hint}
        </span>
      ) : null}
    </button>
  );
}

/** The provenance action, named after what it opens (dashboard-29,
 * DR-038): an issue or PR page, the record, or the capturing session. */
function ProvenanceAction({
  intent,
  recordPath,
  sessionKnown,
  onOpenIntent,
  onOpenSession,
  onDone,
}: {
  intent: IntentInfo;
  recordPath?: string;
  sessionKnown: boolean;
  onOpenIntent: (projectId: string, path: string, anchor: string) => void;
  onOpenSession: (sessionId: string) => void;
  onDone: () => void;
}) {
  // The record's title for its row (dashboard-40), from the tree the
  // path came from.
  const record = useAppStore((state) =>
    intent.source?.kind === "record"
      ? state.specTrees[intent.projectId]?.intents.find(
          (entry) => entry.id === intent.source?.ref,
        )
      : undefined,
  );
  const source = intent.source;
  if (!source) return null;
  const testId = `upnext-source-${intent.id}`;
  if (source.kind === "issue" || source.kind === "pr") {
    if (!source.url) return null;
    return (
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer"
        role="menuitem"
        data-testid={testId}
        onClick={onDone}
        className={MENU_ITEM}
      >
        {source.kind === "issue" ? "Issue" : "PR"} #{source.ref} ↗
      </a>
    );
  }
  if (source.kind === "record") {
    // The one record row (dashboard-40), as a menu item.
    return (
      <RecordRow
        role="menuitem"
        data-testid={testId}
        record={{ id: source.ref, title: record?.title ?? "" }}
        disabled={!recordPath}
        title={
          recordPath
            ? `Open ${source.ref} in Specs`
            : "This record is not in the project's specs tree"
        }
        onClick={() => {
          onDone();
          // The menu closes with the pick: its trigger is what Back
          // returns to (spec-view-57).
          if (recordPath) {
            onOpenIntent(
              intent.projectId,
              recordPath,
              `upnext-menu-${intent.id}`,
            );
          }
        }}
        className="w-full px-2 py-1"
      />
    );
  }
  return (
    <MenuItem
      data-testid={testId}
      disabled={!sessionKnown}
      title={
        sessionKnown
          ? "Open the session this was captured from"
          : "The capturing session is gone"
      }
      onClick={() => {
        onDone();
        onOpenSession(source.ref);
      }}
    >
      Session
    </MenuItem>
  );
}

/** The drag affordance at the row's left (dashboard-29): six quiet
 * dots under a grab cursor; the row itself is what drags. */
function Grip() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-4 w-3 shrink-0 cursor-grab text-neutral-300 group-hover:text-neutral-500 active:cursor-grabbing dark:text-neutral-600 dark:group-hover:text-neutral-400"
    >
      <circle cx="5.5" cy="3.5" r="1.4" />
      <circle cx="10.5" cy="3.5" r="1.4" />
      <circle cx="5.5" cy="8" r="1.4" />
      <circle cx="10.5" cy="8" r="1.4" />
      <circle cx="5.5" cy="12.5" r="1.4" />
      <circle cx="10.5" cy="12.5" r="1.4" />
    </svg>
  );
}

function QueueRow({
  derived,
  index,
  queue,
  isNext,
  highlighted,
  menuOpen,
  projects,
  recordPath,
  sessionKnown,
  onMenuToggle,
  onStart,
  onMove,
  onEdit,
  onRemove,
  onOpenIntent,
  onOpenSession,
  onDragStart,
  onDropOn,
}: {
  derived: DerivedIntent;
  index: number;
  queue: DerivedIntent[];
  isNext: boolean;
  highlighted: boolean;
  /** Whether this row's menu is the band's one open menu. */
  menuOpen: boolean;
  projects: ProjectInfo[];
  /** The record path for a record-sourced row, when the tree knows it. */
  recordPath?: string;
  /** Whether a chat-sourced row's capturing session still exists. */
  sessionKnown: boolean;
  onMenuToggle: (open: boolean) => void;
  onStart: () => void;
  onMove: (afterIntentId: string | null) => void;
  onEdit: (text: string) => Promise<void>;
  /** Remove acts on the click; a keyboard-driven one hands focus to
   * the Undo line (dashboard-29). */
  onRemove: (byKeyboard: boolean) => Promise<void>;
  onOpenIntent: (projectId: string, path: string, anchor: string) => void;
  onOpenSession: (sessionId: string) => void;
  onDragStart: () => void;
  onDropOn: () => void;
}) {
  const [editing, setEditing] = useState<string>();
  const rowRef = useRef<HTMLLIElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnToRow = useRef(false);
  const menuRef = usePopover<HTMLDivElement>(menuOpen, {
    anchorRef: triggerRef,
    onClose: () => onMenuToggle(false),
    menu: true,
  });
  const intent = derived.intent;
  const title = firstLine(intent.text);
  const blocked = derived.blockedBy;
  const blockedForeign =
    blocked && blocked.projectId !== intent.projectId
      ? (projects.find((p) => p.id === blocked.projectId)?.name ??
        blocked.projectId)
      : undefined;

  // One move vocabulary (dashboard-29): the menu's Move up/down and
  // Alt+↑/↓ on the focused row take the same step.
  const canMoveUp = index > 0;
  const canMoveDown = index < queue.length - 1;
  const moveUp = () => onMove(index >= 2 ? queue[index - 2].intent.id : null);
  const moveDown = () => onMove(queue[index + 1].intent.id);
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (!event.altKey) return;
    if (event.key === "ArrowUp" && canMoveUp) {
      event.preventDefault();
      moveUp();
    } else if (event.key === "ArrowDown" && canMoveDown) {
      event.preventDefault();
      moveDown();
    }
  };

  // Leaving the edit — saved or cancelled — puts focus back on the
  // row it replaced, never on the page body (DR-010 §6).
  const leaveEdit = () => {
    returnToRow.current = true;
    setEditing(undefined);
  };
  useEffect(() => {
    if (editing === undefined && returnToRow.current) {
      returnToRow.current = false;
      rowRef.current?.focus();
    }
  }, [editing]);

  if (editing !== undefined) {
    return (
      <li className="flex items-center gap-2">
        <input
          // The edit replaces the row the user just acted on, so the
          // caret follows the action (same rationale as InlineConfirm).
          autoFocus
          data-testid={`upnext-edit-${intent.id}`}
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && editing.trim()) {
              void onEdit(editing).then(leaveEdit);
            } else if (event.key === "Escape") {
              leaveEdit();
            }
          }}
          aria-label="Edit intent text"
          className="min-h-6 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </li>
    );
  }

  const menuId = `upnext-menu-${intent.id}-items`;
  return (
    <li
      ref={rowRef}
      data-testid={`upnext-row-${intent.id}`}
      data-intent-id={intent.id}
      data-next={isNext ? "true" : undefined}
      data-blocked={blocked ? "true" : undefined}
      data-highlight={highlighted ? "true" : undefined}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDropOn();
      }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      title="Drag, Alt+↑/↓, or the row menu reorders"
      className={`group relative flex min-h-6 items-center gap-2 rounded px-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
        highlighted ? "ring-2 ring-brand-400" : ""
      }`}
    >
      <Grip />
      <span
        className={`min-w-0 flex-1 truncate ${isNext ? "font-medium" : ""} ${
          blocked ? "text-neutral-500" : ""
        }`}
        title={intent.text}
      >
        {title}
      </span>
      {blocked ? (
        <span
          className="min-w-0 max-w-[40%] truncate text-xs text-neutral-500"
          data-testid={`upnext-blocked-${intent.id}`}
          title={`after ${blocked.title}${blockedForeign ? ` (${blockedForeign})` : ""}`}
        >
          after {blocked.title}
          {blockedForeign ? ` (${blockedForeign})` : ""}
        </span>
      ) : null}
      {isNext ? (
        <button
          type="button"
          data-testid={`upnext-start-${intent.id}`}
          onClick={onStart}
          className="min-h-6 shrink-0 rounded bg-brand-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-400"
        >
          Start
        </button>
      ) : blocked ? (
        // Disablement earned, not category color (DR-026 §2): the
        // reason rides the control.
        <button
          type="button"
          disabled
          data-testid={`upnext-start-${intent.id}`}
          title={`Blocked — waiting on “${blocked.title}”`}
          className="min-h-6 shrink-0 rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500"
        >
          Start
        </button>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        data-testid={`upnext-menu-${intent.id}`}
        onClick={() => onMenuToggle(!menuOpen)}
        className="min-h-6 min-w-6 shrink-0 rounded px-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
      >
        ⋯
      </button>
      {menuOpen ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={`Actions for ${title}`}
          className="absolute right-0 top-full z-10 mt-0.5 flex min-w-44 flex-col rounded-md border border-neutral-200 bg-white p-1 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {/* A single-pointer alternative to dragging (WCAG 2.2 2.5.7). */}
          <MenuItem
            data-testid={`upnext-moveup-action-${intent.id}`}
            disabled={!canMoveUp}
            aria-keyshortcuts="Alt+ArrowUp"
            hint="Alt+↑"
            onClick={() => {
              onMenuToggle(false);
              moveUp();
            }}
          >
            Move up
          </MenuItem>
          <MenuItem
            data-testid={`upnext-movedown-action-${intent.id}`}
            disabled={!canMoveDown}
            aria-keyshortcuts="Alt+ArrowDown"
            hint="Alt+↓"
            onClick={() => {
              onMenuToggle(false);
              moveDown();
            }}
          >
            Move down
          </MenuItem>
          <MenuItem
            data-testid={`upnext-edit-action-${intent.id}`}
            onClick={() => {
              onMenuToggle(false);
              setEditing(intent.text);
            }}
          >
            Edit text
          </MenuItem>
          <MenuItem
            data-testid={`upnext-remove-action-${intent.id}`}
            // Remove acts on the click (dashboard-29, DR-038): no
            // confirmation, no history — the band's Undo line is the
            // way back.
            onClick={(event) => {
              onMenuToggle(false);
              void onRemove(activatedByKeyboard(event));
            }}
          >
            Remove
          </MenuItem>
          <ProvenanceAction
            intent={intent}
            recordPath={recordPath}
            sessionKnown={sessionKnown}
            onOpenIntent={onOpenIntent}
            onOpenSession={onOpenSession}
            onDone={() => onMenuToggle(false)}
          />
        </div>
      ) : null}
    </li>
  );
}

/** A removal held for Undo (dashboard-29): the row's text and
 * provenance, and the row it followed, so Undo puts it back where it
 * was. */
interface Removal {
  intent: IntentInfo;
  afterId: string | null;
  error?: string;
}

function UpNextBand({
  project,
  queue,
  ledgerState,
  projects,
  sessions,
  tree,
  highlightId,
  onStartIntent,
  onOpenIntent,
  onOpenSession,
  onCapture,
}: {
  project: ProjectInfo;
  queue: DerivedIntent[];
  ledgerState: LedgerState;
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  tree?: SpecTreeState;
  highlightId?: string;
  onStartIntent: (intent: IntentInfo) => Promise<void> | void;
  onOpenIntent: (projectId: string, path: string, anchor: string) => void;
  onOpenSession: (sessionId: string) => void;
  onCapture: (input: CaptureInput) => Promise<IntentInfo>;
}) {
  const moveIntent = useAppStore((state) => state.moveIntent);
  const editIntent = useAppStore((state) => state.editIntent);
  const closeIntent = useAppStore((state) => state.closeIntent);
  const loadLedger = useAppStore((state) => state.loadLedger);
  const [draft, setDraft] = useState("");
  // One row menu open at a time (dashboard-29): the band holds whose.
  const [menuFor, setMenuFor] = useState<string>();
  const [focusRowId, setFocusRowId] = useState<string>();
  const dragged = useRef<string | undefined>(undefined);
  const bandRef = useRef<HTMLDivElement>(null);
  // The six-second Undo line, taking focus only from a keyboard-driven
  // removal (dashboard-29).
  const { removed, undoRef, show, dismiss } = useUndoLine<Removal>();

  const nextId = queue.find((derived) => !derived.blockedBy)?.intent.id;

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    void onCapture({ projectId: project.id, text }).then(() => setDraft(""));
  };

  // A restored row gets focus once the ledger serves it again.
  useEffect(() => {
    if (!focusRowId) return;
    const row = Array.from(
      bandRef.current?.querySelectorAll<HTMLElement>("li[data-intent-id]") ??
        [],
    ).find((el) => el.dataset.intentId === focusRowId);
    if (!row) return;
    row.focus();
    setFocusRowId(undefined);
  }, [focusRowId, queue]);

  const remove = async (index: number, byKeyboard: boolean) => {
    const intent = queue[index].intent;
    const afterId = index > 0 ? queue[index - 1].intent.id : null;
    try {
      // A queued intent has never run, so the core's drop leaves no
      // trace (core-service-46): the row's Remove.
      await closeIntent(intent.id, "dropped");
      show({ intent, afterId }, { byKeyboard });
    } catch (cause) {
      show(
        {
          intent,
          afterId,
          error: `Couldn't remove “${firstLine(intent.text)}”: ${(cause as Error).message}`,
        },
        { byKeyboard },
      );
    }
  };

  const undo = async () => {
    if (!removed || removed.error) return;
    const { intent, afterId } = removed;
    dismiss();
    try {
      const restored = await onCapture({
        projectId: project.id,
        text: intent.text,
        source: intent.source,
      });
      if (queue.length > 0) {
        try {
          await moveIntent(restored.id, afterId);
        } catch {
          // The row is back; its former place is best effort.
        }
      }
      setFocusRowId(restored.id);
    } catch (cause) {
      show(
        { intent, afterId, error: `Couldn't undo: ${(cause as Error).message}` },
        { byKeyboard: true },
      );
    }
  };

  return (
    <div
      ref={bandRef}
      className="flex flex-col gap-1"
      data-testid={`upnext-${project.id}`}
    >
      <BandHeading>Up next</BandHeading>
      {queue.length === 0 ? (
        <div className="text-xs text-neutral-500">
          {ledgerState === "ready" ? (
            "Nothing queued — add an intent below, or Queue an issue, PR, or record from Sources."
          ) : ledgerState === "loading" ? (
            "Loading…"
          ) : (
            <>
              The queue could not be loaded.{" "}
              <button
                type="button"
                onClick={() => void loadLedger()}
                className={TEXT_LINK}
              >
                Retry
              </button>
            </>
          )}
        </div>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {queue.map((derived, index) => {
          const source = derived.intent.source;
          return (
            <QueueRow
              key={derived.intent.id}
              derived={derived}
              index={index}
              queue={queue}
              isNext={derived.intent.id === nextId}
              highlighted={derived.intent.id === highlightId}
              menuOpen={menuFor === derived.intent.id}
              projects={projects}
              recordPath={
                source?.kind === "record"
                  ? tree?.intents.find((record) => record.id === source.ref)
                      ?.path
                  : undefined
              }
              sessionKnown={
                source?.kind === "chat" &&
                sessions.some((session) => session.id === source.ref)
              }
              onMenuToggle={(open) =>
                setMenuFor((current) =>
                  open
                    ? derived.intent.id
                    : current === derived.intent.id
                      ? undefined
                      : current,
                )
              }
              onStart={() => void onStartIntent(derived.intent)}
              onMove={(afterIntentId) =>
                void moveIntent(derived.intent.id, afterIntentId)
              }
              onEdit={(text) => editIntent(derived.intent.id, text)}
              onRemove={(byKeyboard) => remove(index, byKeyboard)}
              onOpenIntent={onOpenIntent}
              onOpenSession={onOpenSession}
              onDragStart={() => {
                dragged.current = derived.intent.id;
              }}
              onDropOn={() => {
                const from = dragged.current;
                dragged.current = undefined;
                if (!from || from === derived.intent.id) return;
                // Dropping lands the dragged row at the target's place:
                // after the row above the target, skipping itself.
                const rest = queue.filter((entry) => entry.intent.id !== from);
                const at = rest.findIndex(
                  (entry) => entry.intent.id === derived.intent.id,
                );
                void moveIntent(from, at > 0 ? rest[at - 1].intent.id : null);
              }}
            />
          );
        })}
      </ul>
      {removed ? (
        <div
          role="status"
          data-testid={`upnext-removed-${project.id}`}
          className="flex items-center gap-1.5 text-xs text-neutral-500"
        >
          {removed.error ? (
            <span className="min-w-0 truncate text-red-600 dark:text-red-400">
              {removed.error}
            </span>
          ) : (
            <>
              <span className="min-w-0 truncate">
                Removed “{firstLine(removed.intent.text)}”
              </span>
              <span aria-hidden="true">—</span>
              <button
                ref={undoRef}
                type="button"
                onClick={() => void undo()}
                className={TEXT_LINK}
              >
                Undo
              </button>
            </>
          )}
        </div>
      ) : null}
      <input
        value={draft}
        data-testid={`add-intent-${project.id}`}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
        placeholder="Add intent…"
        aria-label={`Add an intent to ${project.name}`}
        className="min-h-6 w-full rounded border border-dashed border-neutral-300 bg-transparent px-2 py-1 text-sm placeholder:text-neutral-500 focus:border-solid focus:border-brand-400 focus:outline-none dark:border-neutral-700"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

export interface ProjectGroupProps {
  project: ProjectInfo;
  now: number;
  /** When this client observed the served forge data — the Sources
   * line's data age (dashboard-14). */
  fetchedAt?: number;
  /** The just-captured row to reveal (dashboard-31). */
  highlightId?: string;
  /** The Dashboard names each group; the Overview's header already
   * does, so it draws the group bare (projects-4). */
  heading?: boolean;
  /** Open a session; with a turnId, land at that turn's place. */
  onOpenSession: (sessionId: string, turnId?: number) => void;
  /** Open an intent record in its project's records reader. */
  onOpenIntent: (projectId: string, path: string, anchor: string) => void;
  /** Stage an intent's dispatch (run-view-86). */
  onStartIntent: (intent: IntentInfo) => Promise<void> | void;
  onCapture: (input: CaptureInput) => Promise<IntentInfo>;
  /** Navigation to the project's Overview tab, where the repository
   * header shows the GitHub binding (dashboard-8); absent on the
   * Overview itself. */
  onOpenOverview?: () => void;
}

export function ProjectGroup({
  project,
  now,
  fetchedAt,
  highlightId,
  heading = true,
  onOpenSession,
  onOpenIntent,
  onStartIntent,
  onCapture,
  onOpenOverview,
}: ProjectGroupProps) {
  const projects = useAppStore((state) => state.projects);
  const sessions = useAppStore((state) => state.sessions);
  const ledger = useAppStore((state) => state.ledger);
  const ledgerError = useAppStore((state) => state.ledgerError);
  const meta = useAppStore((state) => state.projectMeta[project.id]);
  const tree = useAppStore((state) => state.specTrees[project.id]);
  const loadProjectMeta = useAppStore((state) => state.loadProjectMeta);
  const intents = ledger?.intents ?? [];
  const ledgerState: LedgerState = ledger
    ? "ready"
    : ledgerError
      ? "failed"
      : "loading";
  // The Now band shows the project's current conversation
  // (dashboard-28, DR-051): working, waiting, or idle.
  const session = currentSessionOf(sessions, project.id);
  return (
    <div
      data-testid={`project-group-${project.id}`}
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
    >
      {heading ? <h3 className="text-sm font-semibold">{project.name}</h3> : null}
      <HistoryBand
        project={project}
        tree={tree}
        now={now}
        onOpenIntent={onOpenIntent}
      />
      <NowBand
        project={project}
        session={session}
        intents={intents}
        now={now}
        onOpenSession={onOpenSession}
      />
      <UpNextBand
        project={project}
        queue={queueOf(intents, project.id)}
        ledgerState={ledgerState}
        projects={projects}
        sessions={sessions}
        tree={tree}
        highlightId={highlightId}
        onStartIntent={onStartIntent}
        onOpenIntent={onOpenIntent}
        onOpenSession={onOpenSession}
        onCapture={onCapture}
      />
      <SourcesBand
        project={project}
        meta={meta}
        tree={tree}
        openSources={openSourceIntents(ledger, project.id)}
        fetchedAt={fetchedAt}
        now={now}
        onRefresh={() => void loadProjectMeta(project.id, true)}
        onQueue={(text, source) =>
          onCapture({ projectId: project.id, text, source })
        }
        onOpenIntent={onOpenIntent}
        onOpenOverview={onOpenOverview}
      />
    </div>
  );
}
