// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The intent-ledger fold (DR-035): every visible intent state derives
// here, deterministically, from intent rows, the persisted record
// stream, and the viewed markers — arrival-order-independent and
// restart-identical. This is the one derivation the Dashboard, the
// sidebar, and the dock badge consume; nothing else computes attention.

import type {
  AttentionEntry,
  DerivedIntent,
  IntentInfo,
  IntentStats,
  LedgerState,
  StoredRecord,
} from "./protocol.js";
import type { Store } from "./store.js";

/** What the session manager knows live: the lanes and their activity. */
export interface LiveLane {
  sessionId: string;
  projectId: string;
  turnActive: boolean;
}

/** The intent's display title: the first line of its text. */
export function intentTitle(intent: IntentInfo): string {
  const line = intent.text.split(/\r?\n/, 1)[0]?.trim();
  return line && line.length > 0 ? line : intent.text.trim();
}

interface Turn {
  turnId: number;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  status: string | null;
}

/** A session's standing needs-you conditions, folded from its visible
 * records exactly as the run view folds them (dashboard-10). */
interface SessionConditions {
  /** The captain parked at awaitBossReply and nothing moved since. */
  question?: { since: number; turnId: number | null };
  /** A player awaits a permission decision in the current turn. */
  permission?: { since: number; turnId: number | null };
}

function foldConditions(records: StoredRecord[]): SessionConditions {
  let question: SessionConditions["question"];
  // Runs parked on a question, by trace session id: a run disposed
  // while parked — dismissed by the Captain — takes its question with
  // it (dashboard-10).
  const parkedRuns = new Set<string>();
  const permissions = new Map<
    string,
    { since: number; turnId: number | null }
  >();
  for (const { record } of records) {
    switch (record.type) {
      case "turn_finished":
      case "turn_aborted":
        permissions.clear();
        break;
      case "captain_telemetry": {
        const telemetry = record as {
          topic?: string;
          payload?: { from?: unknown; to?: unknown; state?: unknown };
          turnId: number | null;
          timestamp: number;
        };
        if (telemetry.topic === "playbook.trace") {
          const trace = telemetry.payload as unknown as {
            sessionId?: unknown;
            type?: unknown;
            payload?: { to?: unknown; from?: unknown };
          };
          if (typeof trace?.sessionId !== "string") break;
          if (trace.type === "fsm.transition") {
            if (trace.payload?.to === "awaitBossReply") parkedRuns.add(trace.sessionId);
            else if (trace.payload?.from === "awaitBossReply") parkedRuns.delete(trace.sessionId);
          } else if (trace.type === "session.disposed") {
            // Outside a turn — no turn id — the host is releasing the
            // runtime at settlement, a pause the parked run survives
            // (core-service-93); inside one, the Captain dismissed it.
            if (telemetry.turnId !== null && parkedRuns.delete(trace.sessionId)) question = undefined;
          }
          break;
        }
        if (telemetry.topic !== "playbook.fsm.state") break;
        const stateText = (value: unknown): string | undefined => {
          if (typeof value === "string") return value;
          if (value && typeof value === "object") {
            const shape = value as { stateId?: unknown; value?: unknown };
            if (typeof shape.stateId === "string") return shape.stateId;
            if (typeof shape.value === "string") return shape.value;
          }
          return undefined;
        };
        const state =
          stateText(telemetry.payload?.to) ?? stateText(telemetry.payload?.state);
        if (state === "awaitBossReply") {
          question = question ?? {
            since: telemetry.timestamp,
            turnId: telemetry.turnId,
          };
        } else if (stateText(telemetry.payload?.from) === "awaitBossReply") {
          // Only the parked machine leaving its park answers the
          // question; the Captain's own machine reports its states
          // after the park and must not clear it (dashboard-10).
          question = undefined;
        }
        break;
      }
      case "player_event": {
        const event = record as {
          playerId: string;
          event?: { type?: string };
          turnId: number | null;
          timestamp: number;
        };
        if (event.event?.type === "permission_request") {
          if (!permissions.has(event.playerId)) {
            permissions.set(event.playerId, {
              since: event.timestamp,
              turnId: event.turnId,
            });
          }
        } else {
          // A later record for the same player answers the request
          // (dashboard-10).
          permissions.delete(event.playerId);
        }
        break;
      }
      case "player_finished":
        permissions.delete((record as { playerId: string }).playerId);
        break;
      default:
        break;
    }
  }
  const first = [...permissions.values()].sort((a, b) => a.since - b.since)[0];
  return {
    ...(question ? { question } : {}),
    ...(first ? { permission: first } : {}),
  };
}

function rangeOf(
  turns: Turn[],
  fromTurnId: number,
  endTurnId: number | null,
): Turn[] {
  return turns.filter(
    (turn) =>
      turn.turnId >= fromTurnId &&
      (endTurnId === null || turn.turnId < endTurnId),
  );
}

/** Whether a finished turn already received its ruling (DR-035): it
 * sits in some dispatch's range whose intent is still open (the open
 * intent carries the summons itself), or started before that intent's
 * verdict — a ruled turn never re-summons as a review stand-in, while
 * plain chat after a verdict is un-ledgered again. */
function turnIsRuled(store: Store, sessionId: string, turn: Turn): boolean {
  const dispatches = store.listSessionDispatches(sessionId);
  for (let i = 0; i < dispatches.length; i += 1) {
    const dispatch = dispatches[i];
    const end = dispatches[i + 1]?.turnId ?? Number.POSITIVE_INFINITY;
    if (turn.turnId < dispatch.turnId || turn.turnId >= end) continue;
    if (dispatch.open) return true;
    return (
      dispatch.closedAt !== undefined && turn.startedAt <= dispatch.closedAt
    );
  }
  return false;
}

export interface LedgerSources {
  store: Store;
  lanes: LiveLane[];
  now: () => number;
}

/** Derive the whole ledger (DR-035): open intents with states, the
 * two-band attention queue, and the badge. */
export function foldLedger(sources: LedgerSources): LedgerState {
  const { store, lanes, now } = sources;
  const live = new Map(lanes.map((lane) => [lane.sessionId, lane]));
  const open = store.listOpenIntents();
  const openById = new Map(open.map((intent) => [intent.id, intent]));

  // Per-session context, loaded once per session the fold touches.
  const turnsBySession = new Map<string, Turn[]>();
  const conditionsBySession = new Map<string, SessionConditions>();
  const sessionTurns = (sessionId: string): Turn[] => {
    let turns = turnsBySession.get(sessionId);
    if (!turns) {
      turns = store.listTurns(sessionId);
      turnsBySession.set(sessionId, turns);
    }
    return turns;
  };
  const sessionConditions = (sessionId: string): SessionConditions => {
    let conditions = conditionsBySession.get(sessionId);
    if (!conditions) {
      conditions = live.has(sessionId)
        ? foldConditions(store.getRecords(sessionId))
        : {};
      conditionsBySession.set(sessionId, conditions);
    }
    return conditions;
  };

  const derived: DerivedIntent[] = [];
  const attention: AttentionEntry[] = [];
  /** Turn ranges owned by open intents, per session, for stand-ins. */
  const ownedTurns = new Map<string, Set<number>>();

  for (const intent of open) {
    const blockedTarget = intent.afterId
      ? openById.get(intent.afterId)
      : undefined;
    const blockedBy = blockedTarget
      ? {
          intentId: blockedTarget.id,
          title: intentTitle(blockedTarget),
          projectId: blockedTarget.projectId,
        }
      : undefined;

    const bound = intent.dispatched;
    if (!bound) {
      derived.push({ intent, state: "queued", ...(blockedBy ? { blockedBy } : {}) });
      continue;
    }

    const turns = sessionTurns(bound.sessionId);
    const dispatchTurn = turns.find((turn) => turn.turnId === bound.turnId);
    const laneLive = live.has(bound.sessionId);
    // A dispatch whose turn aborted — or died with its session —
    // releases the intent by derivation (DR-035): back to its kept
    // rank, text editable again.
    const released =
      !dispatchTurn ||
      dispatchTurn.status === "aborted" ||
      (dispatchTurn.endedAt === null && !laneLive);
    if (released) {
      derived.push({ intent, state: "queued", ...(blockedBy ? { blockedBy } : {}) });
      continue;
    }

    const dispatches = store.listSessionDispatches(bound.sessionId);
    const nextDispatch = dispatches.find(
      (dispatch) =>
        dispatch.turnId > bound.turnId && dispatch.intentId !== intent.id,
    );
    const endTurnId = nextDispatch ? nextDispatch.turnId : null;
    const range = rangeOf(turns, bound.turnId, endTurnId);
    const owned = ownedTurns.get(bound.sessionId) ?? new Set<number>();
    for (const turn of range) owned.add(turn.turnId);
    ownedTurns.set(bound.sessionId, owned);

    const lastTurn = range[range.length - 1];
    const finishedTurns = range.filter((turn) => turn.status === "finished");
    const lastFinished = finishedTurns[finishedTurns.length - 1];
    const stats: IntentStats = {
      turns: range.length,
      ...(lastFinished || lastTurn
        ? {
            elapsedMs:
              (lastFinished?.endedAt ?? lastTurn?.endedAt ?? now()) - bound.at,
          }
        : {}),
    };
    const reviewRounds = store.countRolePrompts(
      bound.sessionId,
      "reviewer",
      bound.turnId,
      endTurnId,
    );
    if (reviewRounds > 0) stats.reviewRounds = reviewRounds;

    // Interruptions, red first (DR-035): an unacknowledged failure in
    // the range with no later Boss turn in the session; then a player
    // permission; then the parked question — the latter two only while
    // the lane is live, attributed to this intent when their turn
    // falls in its range (the newest open intent owns the tail).
    // Failure and permission are checked before working: each stands
    // only while no later Boss turn acknowledges it (a permission only
    // ever stands while its own turn is still open), so ranking
    // working above them would keep them out of the attention queue
    // for exactly as long as they summon the Boss.
    const errors = store.runtimeErrors(bound.sessionId, bound.turnId, endTurnId);
    const lastError = errors[errors.length - 1];
    const failureStands =
      lastError !== undefined &&
      !turns.some((turn) => turn.startedAt > lastError.timestamp);
    if (failureStands) {
      derived.push({
        intent,
        state: "interrupted",
        reason: "failure",
        stats,
        ...(blockedBy ? { blockedBy } : {}),
      });
      attention.push({
        band: "interrupted",
        kind: "failure",
        intentId: intent.id,
        title: intentTitle(intent),
        projectId: intent.projectId,
        sessionId: bound.sessionId,
        ...(lastError.turnId !== null ? { turnId: lastError.turnId } : {}),
        since: lastError.timestamp,
        stats,
      });
      continue;
    }
    const conditions = laneLive ? sessionConditions(bound.sessionId) : {};
    const owns = (turnId: number | null): boolean =>
      turnId === null ||
      (turnId >= bound.turnId && (endTurnId === null || turnId < endTurnId));
    if (conditions.permission && owns(conditions.permission.turnId)) {
      derived.push({
        intent,
        state: "interrupted",
        reason: "permission",
        stats,
        ...(blockedBy ? { blockedBy } : {}),
      });
      attention.push({
        band: "interrupted",
        kind: "permission",
        intentId: intent.id,
        title: intentTitle(intent),
        projectId: intent.projectId,
        sessionId: bound.sessionId,
        ...(conditions.permission.turnId !== null
          ? { turnId: conditions.permission.turnId }
          : {}),
        since: conditions.permission.since,
        stats,
      });
      continue;
    }

    const working =
      laneLive && lastTurn !== undefined && lastTurn.endedAt === null;
    if (working) {
      derived.push({
        intent,
        state: "working",
        stats,
        ...(blockedBy ? { blockedBy } : {}),
      });
      continue;
    }

    // The parked question, after the working check: a question is
    // acknowledged by the Boss's next turn, so a turn already running
    // means the Boss has replied and the park no longer stands.
    if (conditions.question && owns(conditions.question.turnId)) {
      derived.push({
        intent,
        state: "interrupted",
        reason: "question",
        stats,
        ...(blockedBy ? { blockedBy } : {}),
      });
      attention.push({
        band: "interrupted",
        kind: "question",
        intentId: intent.id,
        title: intentTitle(intent),
        projectId: intent.projectId,
        sessionId: bound.sessionId,
        ...(conditions.question.turnId !== null
          ? { turnId: conditions.question.turnId }
          : {}),
        since: conditions.question.since,
        stats,
      });
      continue;
    }

    if (lastFinished) {
      derived.push({
        intent,
        state: "finished",
        stats,
        ...(blockedBy ? { blockedBy } : {}),
      });
      attention.push({
        band: "finished",
        kind: "finish",
        intentId: intent.id,
        title: intentTitle(intent),
        projectId: intent.projectId,
        sessionId: bound.sessionId,
        turnId: lastFinished.turnId,
        since: lastFinished.endedAt ?? bound.at,
        stats,
      });
      continue;
    }

    // Every turn in the range aborted after a re-dispatchable start:
    // nothing delivered, nothing running — released.
    derived.push({ intent, state: "queued", ...(blockedBy ? { blockedBy } : {}) });
  }

  // Session stand-ins (DR-035): a live session whose condition no open
  // intent owns still summons — the same bands, the session's own
  // words as the title.
  for (const lane of lanes) {
    const owned = ownedTurns.get(lane.sessionId) ?? new Set<number>();
    const turns = sessionTurns(lane.sessionId);
    const lastTurn = turns[turns.length - 1];
    const title = lastTurn?.prompt ?? "";
    const conditions = sessionConditions(lane.sessionId);
    const standsIn = (turnId: number | null): boolean =>
      turnId === null ? owned.size === 0 : !owned.has(turnId);
    const errors = store.runtimeErrors(lane.sessionId, 0, null);
    const lastError = errors[errors.length - 1];
    if (
      lastError &&
      standsIn(lastError.turnId) &&
      !turns.some((turn) => turn.startedAt > lastError.timestamp)
    ) {
      attention.push({
        band: "interrupted",
        kind: "failure",
        title,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        ...(lastError.turnId !== null ? { turnId: lastError.turnId } : {}),
        since: lastError.timestamp,
      });
    } else if (conditions.permission && standsIn(conditions.permission.turnId)) {
      attention.push({
        band: "interrupted",
        kind: "permission",
        title,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        ...(conditions.permission.turnId !== null
          ? { turnId: conditions.permission.turnId }
          : {}),
        since: conditions.permission.since,
      });
    } else if (conditions.question && standsIn(conditions.question.turnId)) {
      attention.push({
        band: "interrupted",
        kind: "question",
        title,
        projectId: lane.projectId,
        sessionId: lane.sessionId,
        ...(conditions.question.turnId !== null
          ? { turnId: conditions.question.turnId }
          : {}),
        since: conditions.question.since,
      });
    } else if (
      lastTurn &&
      lastTurn.status === "finished" &&
      !owned.has(lastTurn.turnId) &&
      !turnIsRuled(store, lane.sessionId, lastTurn) &&
      !lane.turnActive
    ) {
      // The un-ledgered finished turn clears on viewing, exactly as
      // today (dashboard-10): the persisted marker decides.
      const viewed =
        store.getPref<number>(`viewed:${lane.sessionId}`) ?? -1;
      if (lastTurn.turnId > viewed) {
        attention.push({
          band: "finished",
          kind: "review",
          title,
          projectId: lane.projectId,
          sessionId: lane.sessionId,
          turnId: lastTurn.turnId,
          since: lastTurn.endedAt ?? lastTurn.startedAt,
        });
      }
    }
  }

  // Two bands, longest waiting first within each (DR-035).
  attention.sort((a, b) => {
    if (a.band !== b.band) return a.band === "interrupted" ? -1 : 1;
    return a.since - b.since;
  });

  return { intents: derived, attention, badge: attention.length };
}

/** The turns a dispatched intent attributes (DR-035): from its
 * dispatch turn up to the next dispatch of another intent in the
 * session, or the session's end. */
function attributedTurns(
  store: Store,
  intent: IntentInfo,
  bound: NonNullable<IntentInfo["dispatched"]>,
): { range: Turn[]; endTurnId: number | null } {
  const dispatches = store.listSessionDispatches(bound.sessionId);
  const next = dispatches.find(
    (dispatch) =>
      dispatch.turnId > bound.turnId && dispatch.intentId !== intent.id,
  );
  const endTurnId = next ? next.turnId : null;
  return {
    range: rangeOf(store.listTurns(bound.sessionId), bound.turnId, endTurnId),
    endTurnId,
  };
}

/** Whether an intent was worked (DR-038): dispatched, with a turn it
 * attributes ended finished. A closed intent that never was leaves the
 * ledger without a trace — the history read excludes it. */
export function wasWorked(store: Store, intent: IntentInfo): boolean {
  const bound = intent.dispatched;
  if (!bound) return false;
  return attributedTurns(store, intent, bound).range.some(
    (turn) => turn.status === "finished",
  );
}

/** The run stats of a closed intent, for History rows (DR-035). */
export function closedStats(
  store: Store,
  intent: IntentInfo,
): IntentStats | undefined {
  const bound = intent.dispatched;
  if (!bound) return undefined;
  const { range, endTurnId } = attributedTurns(store, intent, bound);
  const lastEnded = [...range]
    .reverse()
    .find((turn) => turn.endedAt !== null);
  const stats: IntentStats = {
    turns: range.length,
    ...(lastEnded?.endedAt
      ? { elapsedMs: lastEnded.endedAt - bound.at }
      : {}),
  };
  const reviewRounds = store.countRolePrompts(
    bound.sessionId,
    "reviewer",
    bound.turnId,
    endTurnId,
  );
  if (reviewRounds > 0) stats.reviewRounds = reviewRounds;
  return stats;
}
