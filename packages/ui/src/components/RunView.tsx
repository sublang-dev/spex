// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The project session run view (RUN-1..12): Captain column with the
// Boss composer docked below, player panes for the visible roster.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DerivedIntent,
  IntentSource,
  PlaybookSummary,
  SessionInfo,
} from "@sublang/spex-core/protocol";

import type { SessionView } from "../state/reducer.js";
import type { ComposerState } from "../state/store.js";
import {
  CaptainPane,
  type ReadinessHint,
  type ThreadExtra,
} from "./CaptainPane.js";
import {
  CAPTAIN_SPLIT_DEFAULT,
  CAPTAIN_SPLIT_MAX,
  CAPTAIN_SPLIT_MIN,
  useAppStore,
} from "../state/store.js";
import { SessionRecovery } from "./SessionRecovery.js";
import { Composer } from "./Composer.js";
import { DeliveryCard } from "./DeliveryCard.js";
import { InlineConfirm } from "./InlineConfirm.js";
import { PlayerPane } from "./PlayerPane.js";
import { WorkingLine } from "./WorkingLine.js";


/** The Captain/players divider (DR-030). A machine drawing has a
 * natural width that reflowing text does not, so the reader sets the
 * split: drag it, nudge it by arrow key, or double-click to restore
 * the default. */
function SplitDivider({
  percent,
  onChange,
  containerRef,
}: {
  percent: number;
  onChange(next: number): void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [dragging, setDragging] = useState(false);

  // The share is a percentage width on a flex child, so it resolves
  // against the container's content box and is then carried right by
  // the gap before the divider. Measuring the border box instead left
  // the rule up to 40px from the hand that was dragging it, which
  // reads as a control that refuses to follow (DR-030, DR-041 §9).
  function fromClientX(clientX: number): number | undefined {
    const el = containerRef.current;
    if (!el) return undefined;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const gap = parseFloat(style.columnGap) || 0;
    const content = box.width - padLeft - padRight;
    if (content <= 0) return undefined;
    return ((clientX - box.left - padLeft - gap) / content) * 100;
  }

  return (
    <div
      data-testid="captain-divider"
      data-dragging={dragging ? "1" : "0"}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the Captain pane"
      aria-valuenow={percent}
      aria-valuemin={CAPTAIN_SPLIT_MIN}
      aria-valuemax={CAPTAIN_SPLIT_MAX}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const next = fromClientX(event.clientX);
        if (next !== undefined) onChange(next);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onDoubleClick={() => onChange(CAPTAIN_SPLIT_DEFAULT)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onChange(percent - 2);
        else if (event.key === "ArrowRight") onChange(percent + 2);
        else if (event.key === "Home") onChange(CAPTAIN_SPLIT_DEFAULT);
        else return;
        event.preventDefault();
      }}
      // A 12px hit target around a 2px rule: reachable without
      // becoming a visible bar (DR-010 §6).
      className="group relative -mx-1.5 w-3 shrink-0 cursor-col-resize touch-none focus:outline-none"
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded ${
          dragging
            ? "bg-brand-500"
            : "bg-transparent group-hover:bg-neutral-300 group-focus:bg-brand-500 dark:group-hover:bg-neutral-700"
        }`}
      />
    </div>
  );
}

export function RunView({
  session,
  view,
  composer,
  connected,
  error,
  playbooks,
  readOnly,
  ending,
  onEnd,
  onStartNew,
  onCompileNew,
  onRetryLoad,
  onRecover,
  onDraftChange,
  onSubmit,
  onAbort,
  onRemoveQueued,
  onDismissError,
  readinessHint,
  focusTurn,
  onFocusHandled,
}: {
  session: SessionInfo;
  view: SessionView;
  composer: ComposerState;
  connected: boolean;
  error?: string;
  playbooks?: PlaybookSummary[];
  /** Set while the Captain's adapter reports not ready: a live
   * session's failure lines then link to Settings (run-view-2). */
  readinessHint?: ReadinessHint;
  /** Ended-session transcript browsing (RUN-33): input replaced. */
  readOnly?: boolean;
  /** The end request is in flight — the agents are shutting down. */
  ending?: boolean;
  /** End this session. Guarded here, never on the tab's close
   * control, which stops nothing (run-view-47). */
  onEnd?: () => void;
  onStartNew?: () => void;
  onCompileNew?: () => void;
  /** Retry a failed transcript load (read-only view). */
  onRetryLoad?: () => void;
  onRecover?: (action: "retry" | "discard") => Promise<void>;
  onDraftChange?: (draft: string) => void;
  onSubmit: (text: string) => Promise<void>;
  onAbort: () => void;
  onRemoveQueued: (index: number) => void;
  onDismissError: () => void;
  /** Attention activation (run-view-91): land at this turn's place —
   * its question bubble, failure line, or delivery card. */
  focusTurn?: number;
  onFocusHandled?: () => void;
}) {
  const externalWriter = session.externalWriter;
  readOnly ||= !!externalWriter;
  // Stop animation without closing the record fold's open text segment:
  // another host can append its next delta while ownership is unknown.
  const activityView = useMemo(() => view.turnActive ? view : {
    ...view,
    players: Object.fromEntries(Object.entries(view.players).map(([id, player]) => [id, {
      ...player,
      running: false,
      segments: player.segments.map((segment) => segment.kind === "text"
        ? { ...segment, streaming: false }
        : segment),
    }])),
  }, [view]);
  const machineGraphs = useAppStore((state) => state.machineGraphs);
  const captainSplit = useAppStore((state) => state.captainSplit);
  const setCaptainSplit = useAppStore((state) => state.setCaptainSplit);
  const ledger = useAppStore((state) => state.ledger);
  const staged = useAppStore((state) => state.stagedIntents[session.id]);
  const clearStagedIntent = useAppStore((state) => state.clearStagedIntent);
  const queueIntent = useAppStore((state) => state.queueIntent);
  const closeIntent = useAppStore((state) => state.closeIntent);
  const stageDispatch = useAppStore((state) => state.stageDispatch);
  const collapsedLanes = useAppStore((state) => state.collapsedLanes[session.id]);
  const setLaneCollapsed = useAppStore((state) => state.setLaneCollapsed);
  const splitRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Backing out of the end confirm returns focus to the control that
  // opened it, never to <body> (run-view-50).
  const endButtonRef = useRef<HTMLButtonElement>(null);
  const [refocusEnd, setRefocusEnd] = useState(false);
  useEffect(() => {
    if (!refocusEnd || confirmEnd) return;
    endButtonRef.current?.focus();
    setRefocusEnd(false);
  }, [refocusEnd, confirmEnd]);

  // The intents this session's turns are bound to (DR-035): the open
  // fold serves them; a closed one survives below as a snapshot so its
  // delivery card can resolve in place rather than vanish.
  const bound = useMemo(
    () =>
      (ledger?.intents ?? []).filter(
        (entry) => entry.intent.dispatched?.sessionId === session.id,
      ),
    [ledger, session.id],
  );

  // Finished intents seen here, kept after their verdict closes them
  // (run-view-87: the card resolves in place). A released or re-worked
  // intent leaves the map — its card no longer belongs in the thread.
  const [delivered, setDelivered] = useState<Record<string, DerivedIntent>>({});
  useEffect(() => {
    if (!ledger) return;
    setDelivered((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const entry of bound) {
        if (entry.state === "finished") {
          next[entry.intent.id] = entry;
          changed = true;
        } else if (previous[entry.intent.id]) {
          delete next[entry.intent.id];
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [ledger, bound]);

  // An intent's turn range runs from its dispatch turn up to the next
  // dispatch in this session (DR-035).
  const dispatchTurns = useMemo(() => {
    const turns = new Set<number>();
    for (const entry of bound) {
      if (entry.intent.dispatched) turns.add(entry.intent.dispatched.turnId);
    }
    for (const entry of Object.values(delivered)) {
      if (entry.intent.dispatched) turns.add(entry.intent.dispatched.turnId);
    }
    return [...turns].sort((a, b) => a - b);
  }, [bound, delivered]);

  function rangeOf(entry: DerivedIntent): [number, number] {
    const from = entry.intent.dispatched?.turnId ?? 0;
    const to =
      dispatchTurns.find((turn) => turn > from) ?? Number.POSITIVE_INFINITY;
    return [from, to];
  }

  // The working line (run-view-90): the newest open dispatched intent
  // owns the conversation.
  const workingIntent = useMemo(() => {
    const open = bound.filter(
      (entry) => entry.state === "working" || entry.state === "interrupted",
    );
    open.sort(
      (a, b) => (b.intent.dispatched?.at ?? 0) - (a.intent.dispatched?.at ?? 0),
    );
    return open[0];
  }, [bound]);

  // The bound turn's Boss bubble wears the intent's source chip
  // (run-view-89).
  const bossSources = useMemo(() => {
    const map = new Map<number, IntentSource>();
    for (const entry of [...Object.values(delivered), ...bound]) {
      const dispatched = entry.intent.dispatched;
      if (dispatched && entry.intent.source) {
        map.set(dispatched.turnId, entry.intent.source);
      }
    }
    return map;
  }, [bound, delivered]);

  // The project's next queued unblocked intent, the pull the delivery
  // card resolves into (run-view-87).
  const nextUp = useMemo(
    () =>
      (ledger?.intents ?? []).find(
        (entry) =>
          entry.intent.projectId === session.projectId &&
          entry.state === "queued" &&
          !entry.blockedBy,
      ),
    [ledger, session.projectId],
  );

  // Delivery cards anchored at each intent's final turn's end.
  const extras = useMemo<ThreadExtra[]>(() => {
    const list: ThreadExtra[] = [];
    for (const entry of Object.values(delivered)) {
      const [from, to] = rangeOf(entry);
      let anchor = -1;
      view.captain.forEach((line, index) => {
        if (line.turnId !== null && line.turnId >= from && line.turnId < to) {
          anchor = index;
        }
      });
      if (anchor < 0) continue;
      const stillOpen =
        ledger?.intents.some((open) => open.intent.id === entry.intent.id) ??
        true;
      list.push({
        key: `delivery-${entry.intent.id}`,
        afterIndex: anchor,
        focusKey: `card-${entry.intent.id}`,
        node: (
          <DeliveryCard
            derived={entry}
            closed={!stillOpen}
            live={session.live && !externalWriter}
            next={nextUp}
            onClose={(as) => closeIntent(entry.intent.id, as)}
            onStartNext={(intent) => void stageDispatch(intent)}
            onQueueNext={async (text) => {
              await queueIntent({ projectId: session.projectId, text });
            }}
          />
        ),
      });
    }
    return list;
    // rangeOf reads only state derived in this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivered, dispatchTurns, view.captain, ledger, nextUp, session]);

  // Where an attention activation should land (run-view-91): the
  // delivery card, the question bubble, or the failure line of the
  // named turn — a boss bubble as the last resort.
  const focusKey = useMemo(() => {
    if (focusTurn === undefined) return undefined;
    // Finished intents straight from the ledger count before their
    // card has folded into the delivered map, so the focus never
    // lands on the wrong element in the interim.
    const cards = new Map<string, DerivedIntent>();
    for (const entry of bound) {
      if (entry.state === "finished") cards.set(entry.intent.id, entry);
    }
    for (const entry of Object.values(delivered)) {
      cards.set(entry.intent.id, entry);
    }
    for (const entry of cards.values()) {
      const [from, to] = rangeOf(entry);
      if (focusTurn >= from && focusTurn < to) return `card-${entry.intent.id}`;
    }
    for (const kind of ["question", "error", "boss"] as const) {
      for (let index = view.captain.length - 1; index >= 0; index -= 1) {
        const line = view.captain[index];
        if (line.kind === kind && line.turnId === focusTurn) {
          return `line-${index}`;
        }
      }
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTurn, bound, delivered, dispatchTurns, view.captain]);
  // A pane is a player lane, not a moment (DR-032): the session's
  // bound roster is the pane set for the session's whole life, so a
  // call that ends leaves its transcript where the reader last saw it.
  const lanes = session.players.map((player) => player.id);
  // The lanes the reader folded to rails (run-view-116): this
  // session's, kept while the app runs. The store unfolds one whose
  // call opens as it folds the record (run-view-117), so the pane
  // that comes into view below is already whole.
  const collapsed = new Set(collapsedLanes ?? []);
  // A lane whose call just opened comes into view (run-view-7): the
  // grid scrolls only as far as it must and only when the pane is
  // out of sight, so a lane the reader is following never leaves
  // under them and the working one never hides beyond the edge.
  const runningLanes = lanes
    .filter((playerId) => activityView.players[playerId]?.running)
    .join("\u0000");
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !runningLanes) return;
    const box = grid.getBoundingClientRect();
    for (const playerId of runningLanes.split("\u0000")) {
      const pane = Array.from(
        grid.querySelectorAll<HTMLElement>('[data-testid^="player-pane-"]'),
      ).find((el) => el.dataset.testid === `player-pane-${playerId}`);
      if (!pane || typeof pane.scrollIntoView !== "function") continue;
      const rect = pane.getBoundingClientRect();
      const hidden =
        rect.right > box.right + 1 ||
        rect.left < box.left - 1 ||
        rect.bottom > box.bottom + 1 ||
        rect.top < box.top - 1;
      if (hidden) pane.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [runningLanes]);
  // No lane, no split (run-view-7): a session whose roster binds no
  // player — a record the CLI wrote — reads as the Captain home does,
  // one column at the home's measure, with no divider to nowhere.
  const soloCaptain = lanes.length === 0;
  const metaById = new Map(session.players.map((player) => [player.id, player]));
  const title = session.title ?? "new session";
  const queued = composer.queued.length;
  // Ended is the session's own state; read-only is the host's verdict
  // on it — a continuable session is ended yet keeps its composer
  // (run-view-33, DR-042).
  const ended = !externalWriter && (readOnly || !session.live);
  const uncertain = !externalWriter && !!session.recovery && !session.turnActive;
  const loadError = view.loadError ?? (readOnly && !uncertain ? error : undefined);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The conversation names itself, and ending it is a control of
          its own (run-view-69, run-view-47). */}
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-1.5 text-sm dark:border-neutral-800">
        <span className="min-w-0 truncate font-medium" title={title}>
          {title}
        </span>
        {externalWriter ? (
          <span
            role="status"
            data-testid="session-external-owner"
            className="text-xs text-neutral-500 dark:text-neutral-400"
          >
            {externalWriter === "active"
              ? "Session is in use elsewhere"
              : "Session ownership is unknown · controls are unavailable"}
          </span>
        ) : ended ? (
          <span
            data-testid="session-ended-at"
            className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400"
          >
            Ended{" "}
            {session.endedAt ? new Date(session.endedAt).toLocaleString() : ""}
          </span>
        ) : confirmEnd ? (
          <span className="ml-auto">
            <InlineConfirm
              question={
                "End this session? A message can continue it later." +
                (queued > 0
                  ? ` ${queued} queued message${queued === 1 ? "" : "s"} will be discarded.`
                  : "")
              }
              confirmLabel="End"
              cancelLabel="Keep"
              onConfirm={() => {
                setConfirmEnd(false);
                onEnd?.();
              }}
              onCancel={() => {
                setConfirmEnd(false);
                setRefocusEnd(true);
              }}
            />
          </span>
        ) : onEnd ? (
          <button
            type="button"
            ref={endButtonRef}
            data-testid="end-session"
            disabled={ending}
            onClick={() => setConfirmEnd(true)}
            title="Stop this session's agents"
            className="ml-auto shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:border-red-300 hover:text-red-600 disabled:animate-pulse dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-red-800 dark:hover:text-red-400"
          >
            {ending ? "Ending…" : "End session"}
          </button>
        ) : null}
      </div>
      {/* The split is layout by its own width (run-view-107): panes
          side by side with the divider from 42rem, stacked below it
          with the divider hidden and the reader's split kept. The
          container is the wrapper, never the flex box itself — an
          element cannot answer its own container query, and a split
          that carried both stacked at every width. */}
      <div
        data-testid="split-container"
        className="@container flex min-h-0 flex-1 flex-col"
      >
      <div
        ref={splitRef}
        className="flex min-h-0 flex-1 flex-col gap-3 p-3 @2xl:flex-row"
      >
        <div
          data-testid="captain-column"
          style={{ "--captain-split": `${captainSplit}%` } as React.CSSProperties}
          className={`flex min-h-0 min-w-0 flex-1 flex-col gap-2 ${
            soloCaptain
              ? "mx-auto w-full max-w-2xl"
              : "@2xl:w-(--captain-split) @2xl:min-w-[280px] @2xl:flex-none"
          }`}
        >
          <CaptainPane
            view={activityView}
            machineGraphs={machineGraphs}
            bossSources={bossSources}
            extras={extras}
            readiness={readOnly ? undefined : readinessHint}
            focusKey={focusKey}
            onFocusHandled={onFocusHandled}
          />
          {!readOnly ? (
            // The working line (run-view-90) with its Drop
            // (run-view-113): the verdict closes the intent over the
            // protocol while the turn keeps running.
            <WorkingLine
              intent={workingIntent?.intent}
              onDrop={(intent) => closeIntent(intent.id, "dropped")}
            />
          ) : null}
          {uncertain ? (
            <SessionRecovery
              input={session.recovery!.input}
              connected={connected && !session.live}
              onRecover={onRecover}
            />
          ) : null}
          {loadError ? (
            <div
              role="alert"
              data-testid="past-load-error"
              className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              <span className="min-w-0 flex-1">{loadError}</span>
              {onRetryLoad ? (
                <button
                  type="button"
                  onClick={onRetryLoad}
                  className="font-medium text-brand-600 hover:underline dark:text-brand-300"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {ended && !uncertain ? (
            <>
              {/* The ended notice (run-view-33): a paused conversation
                  when a message can continue it, read-only otherwise;
                  its control wraps under the words in a narrow pane. */}
              <div
                data-testid="ended-notice"
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <span className="min-w-0 flex-1 basis-40">
                  {readOnly
                    ? (session.continuationReason ?? "Ended — this session can't be continued")
                    : "Ended · a message continues it"}
                </span>
                {onStartNew ? (
                  <button
                    type="button"
                    onClick={onStartNew}
                    title="Start a new session in this project"
                    className="ml-auto shrink-0 rounded-md border border-brand-300 px-2.5 py-1 text-xs text-brand-600 hover:bg-brand-50 dark:border-brand-800 dark:text-brand-300 dark:hover:bg-brand-950"
                  >
                    New session
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
          {readOnly && !uncertain ? null : (
            <Composer
              view={view}
              composer={composer}
              connected={connected}
              blockedReason={uncertain ? "Recover the interrupted turn before sending." : undefined}
              error={error}
              playbooks={playbooks}
              staged={staged}
              onCompileNew={onCompileNew}
              onDraftChange={onDraftChange}
              onSubmit={onSubmit}
              onAbort={onAbort}
              onRemoveQueued={onRemoveQueued}
              onDismissError={onDismissError}
              onDetachStaged={() => clearStagedIntent(session.id)}
              onQueueInstead={async (text) => {
                // Queue instead of send (run-view-85): chat provenance
                // names this session; nothing is dispatched.
                await queueIntent({
                  projectId: session.projectId,
                  text,
                  source: { kind: "chat", ref: session.id },
                });
              }}
            />
          )}
        </div>
        {soloCaptain ? null : (
          <>
            <div className="hidden @2xl:contents">
              <SplitDivider
                percent={captainSplit}
                onChange={setCaptainSplit}
                containerRef={splitRef}
              />
            </div>
            <div
              ref={gridRef}
              data-testid="player-grid"
              className="relative flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto"
            >
              {lanes.map((playerId) => (
                <PlayerPane
                  key={playerId}
                  view={
                    activityView.players[playerId] ?? {
                      id: playerId,
                      running: false,
                      segments: [],
                    }
                  }
                  meta={metaById.get(playerId)}
                  collapsed={collapsed.has(playerId)}
                  onCollapsedChange={(next) =>
                    setLaneCollapsed(session.id, playerId, next)
                  }
                />
              ))}
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
