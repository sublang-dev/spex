// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Pure record reducer (RUN-14..18): folds the session record stream
// into view state. Everything the run view renders derives from
// protocol messages — no other inputs (RUN-13).

import {
  hasPresentationHeader,
  type TmuxPlayRecord,
} from "@sublang/spex-core/protocol";

import { plainFailure } from "../lib/labels.js";

/** What one call reported spending, in tokens and tool uses. Every
 * figure is optional because cligent 0.22 reports each independently,
 * and an absent report means unreported — never zero (DR-032). A cost
 * the runtime reported stays in the record and never reaches the
 * view (DR-044). */
export interface UsageView {
  inputTokens?: number;
  outputTokens?: number;
  toolUses: number;
}

/** Reads a cligent 0.22 `done` usage payload. Totals are inclusive of
 * cached reads, so they are taken as given and never re-added; the
 * payload's cost is left where it lies. */
export function readDoneUsage(payload: unknown): UsageView | undefined {
  const usage = (payload as { usage?: unknown } | undefined)?.usage as
    | {
        toolUses?: number;
        tokens?: { totals?: { input?: { total?: number }; output?: { total?: number } } };
      }
    | undefined;
  if (!usage) return undefined;
  const totals = usage.tokens?.totals;
  return {
    ...(typeof totals?.input?.total === "number"
      ? { inputTokens: totals.input.total }
      : {}),
    ...(typeof totals?.output?.total === "number"
      ? { outputTokens: totals.output.total }
      : {}),
    toolUses: usage.toolUses ?? 0,
  };
}

/** Stable identity + wall-clock for every transcript entry. */
export interface SegmentMeta {
  /** Record seq that created the segment (stable React key). */
  seq: number;
  /** Record timestamp, ms epoch. */
  at: number;
}

export type TranscriptSegment = SegmentMeta &
  (
    | { kind: "prompt"; text: string; role?: string }
    | { kind: "text"; text: string; streaming: boolean }
    | { kind: "thinking"; summary: string }
    | {
        kind: "tool";
        toolName: string;
        toolUseId: string;
        input: unknown;
        status?: "success" | "error" | "denied";
        output?: unknown;
        durationMs?: number;
      }
    | { kind: "error"; message: string }
    | {
        kind: "result";
        status: "ok" | "aborted" | "error";
        error?: string;
        usage?: UsageView;
      }
  );

export interface PlayerView {
  id: string;
  running: boolean;
  segments: TranscriptSegment[];
  turnUsage?: UsageView;
}

import {
  foldTrace,
  type MachineFrame,
} from "../lib/machine-frames.js";

export type { MachineFrame };

export interface CaptainLine {
  /** boss: the user's own message, echoed into the thread (RUN-30).
   * question: a player asking the Boss — a first-class incoming
   * message, not a log line (RUN-9, DR-010 §1). */
  kind: "status" | "speech" | "error" | "boss" | "question" | "machine";
  /** The settled frame a "machine" line carries (run-view-62). */
  frame?: MachineFrame;
  text: string;
  turnId: number | null;
  at: number;
  data?: unknown;
  /** question lines: the asking player (pane id when resolvable). */
  player?: string;
  /** error lines: how many identical failures the line stands for —
   * a repeat that follows it in the same turn folds into it, so a
   * retry loop reads as one line with a count (run-view-2). */
  count?: number;
  /** error lines: what the runtime actually said, kept when the
   * shown text is its plain-spoken form (run-view-2, DR-010 §2). */
  raw?: string;
}

export interface SessionView {
  captain: CaptainLine[];
  /** Streaming captain speech accumulated from visible deltas. */
  captainDraft: string;
  players: Record<string, PlayerView>;
  turnActive: boolean;
  currentTurnId: number | null;
  /** True while a history replay is loading after (re)subscription. */
  loading?: boolean;
  fsmState?: string;
  captainMode?: string;
  /** Live machine frames, parents before children (run-view-60/63). */
  frames: MachineFrame[];
  /** Trace sessions whose run has settled — the tombstones that keep
   * a finished run's trailing reports from reviving it (run-view-74). */
  settledRuns: string[];
  /** Set while the playbook is parked awaiting a Boss reply. */
  pendingQuestion?: string;
  /** The asking player for the parked question (pane id). */
  pendingQuestionPlayer?: string;
  lastSeq: number;
}

export function initialSessionView(
  players: readonly { id: string }[],
): SessionView {
  return {
    captain: [],
    captainDraft: "",
    players: Object.fromEntries(
      players.map((player) => [
        player.id,
        { id: player.id, running: false, segments: [] },
      ]),
    ),
    turnActive: false,
    currentTurnId: null,
    frames: [],
    settledRuns: [],
    lastSeq: 0,
  };
}

function player(view: SessionView, playerId: string): PlayerView {
  const existing = view.players[playerId];
  if (existing) return existing;
  const created: PlayerView = { id: playerId, running: false, segments: [] };
  view.players[playerId] = created;
  return created;
}

function pushCaptain(view: SessionView, line: CaptainLine): void {
  // A failure identical to the line just before it, in the same turn,
  // is the same failure again: it counts rather than repeats, and no
  // delivered failure goes unshown (run-view-2).
  const last = view.captain[view.captain.length - 1];
  if (
    line.kind === "error" &&
    last?.kind === "error" &&
    last.text === line.text &&
    last.turnId === line.turnId
  ) {
    last.count = (last.count ?? 1) + 1;
    return;
  }
  view.captain.push(line);
}

/** The runtime sends either a plain string or a structured object
 * ({player, question, ...}); normalize both (RUN-9/30). */
export function parseBossQuestion(
  value: unknown,
): { question: string; player?: string } | undefined {
  if (typeof value === "string") return { question: value };
  if (typeof value === "object" && value !== null) {
    const shaped = value as { player?: unknown; question?: unknown };
    const question =
      typeof shaped.question === "string" ? shaped.question : undefined;
    if (question === undefined) return undefined;
    return typeof shaped.player === "string"
      ? { question, player: shaped.player }
      : { question };
  }
  return undefined;
}

/** A pane is a session player, named by its own id (DR-032). A name
 * that is already a lane is one; anything else — a local role the
 * trace has not resolved — is left as it came, never guessed into a
 * lane by spelling. */
export function resolvePlayerId(
  view: SessionView,
  player: string | undefined,
): string | undefined {
  if (!player) return undefined;
  return Object.keys(view.players).find((id) => id === player) ?? player;
}

/** Abort reasons are runtime plumbing; translate the known ones. */
function friendlyAbortReason(reason: string): string {
  if (reason === "runtime disposed") return "session ended";
  return reason;
}

function closeStreamingText(segments: TranscriptSegment[]): void {
  const last = segments[segments.length - 1];
  if (last && last.kind === "text" && last.streaming) last.streaming = false;
}

interface AgentEventLike {
  type: string;
  payload?: unknown;
}

function applyAgentEvent(
  target: PlayerView,
  event: AgentEventLike,
  meta: SegmentMeta,
): UsageView | undefined {
  const segments = target.segments;
  switch (event.type) {
    case "text_delta": {
      const delta = (event.payload as { delta?: string })?.delta ?? "";
      const last = segments[segments.length - 1];
      if (last && last.kind === "text" && last.streaming) {
        last.text += delta;
      } else {
        segments.push({ ...meta, kind: "text", text: delta, streaming: true });
      }
      return undefined;
    }
    case "text": {
      closeStreamingText(segments);
      const content = (event.payload as { content?: string })?.content ?? "";
      segments.push({ ...meta, kind: "text", text: content, streaming: false });
      return undefined;
    }
    case "thinking": {
      closeStreamingText(segments);
      segments.push({
        ...meta,
        kind: "thinking",
        summary: (event.payload as { summary?: string })?.summary ?? "",
      });
      return undefined;
    }
    case "tool_use": {
      closeStreamingText(segments);
      const payload = event.payload as {
        toolName?: string;
        toolUseId?: string;
        input?: unknown;
      };
      segments.push({
        ...meta,
        kind: "tool",
        toolName: payload?.toolName ?? "tool",
        toolUseId: payload?.toolUseId ?? "",
        input: payload?.input,
      });
      return undefined;
    }
    case "tool_result": {
      const payload = event.payload as {
        toolUseId?: string;
        status?: "success" | "error" | "denied";
        output?: unknown;
        durationMs?: number;
      };
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const segment = segments[i];
        if (
          segment.kind === "tool" &&
          segment.toolUseId === payload?.toolUseId
        ) {
          segment.status = payload?.status;
          segment.output = payload?.output;
          segment.durationMs = payload?.durationMs;
          break;
        }
      }
      return undefined;
    }
    case "error": {
      closeStreamingText(segments);
      segments.push({
        ...meta,
        kind: "error",
        message:
          (event.payload as { message?: string })?.message ?? "agent error",
      });
      return undefined;
    }
    case "done": {
      closeStreamingText(segments);
      return readDoneUsage(event.payload);
    }
    default:
      return undefined;
  }
}

/** Apply one record in stream order. Mutates and returns the view. */
export function applyRecord(
  view: SessionView,
  seq: number,
  record: TmuxPlayRecord,
  /** The role this record's call served, resolved by the core from the
   * trace (DR-032). A shared lane needs it to read as several calls
   * rather than one voice; the renderer never guesses it. */
  role?: string,
): SessionView {
  view.lastSeq = Math.max(view.lastSeq, seq);
  if (!hasPresentationHeader(record)) return view;
  const r = record as unknown as Record<string, unknown> & {
    type: string;
    turnId: number | null;
    timestamp: number;
  };
  const meta: SegmentMeta = { seq, at: r.timestamp };

  switch (r.type) {
    case "turn_started": {
      view.turnActive = true;
      const turn = r.turn as { id: number; prompt: string };
      view.currentTurnId = turn.id;
      pushCaptain(view, {
        kind: "boss",
        text: turn.prompt,
        turnId: turn.id,
        at: r.timestamp,
      });
      break;
    }
    case "turn_finished": {
      view.turnActive = false;
      break;
    }
    case "turn_aborted": {
      view.turnActive = false;
      const reason = r.reason
        ? `: ${friendlyAbortReason(String(r.reason))}`
        : "";
      pushCaptain(view, {
        kind: "status",
        text: `◆ turn aborted${reason}`,
        turnId: r.turnId,
        at: r.timestamp,
      });
      break;
    }
    case "player_prompt": {
      const target = player(view, String(r.playerId));
      target.running = true;
      target.turnUsage = undefined;
      target.segments.push({
        ...meta,
        kind: "prompt",
        text: String(r.prompt),
        ...(role !== undefined ? { role } : {}),
      });
      break;
    }
    case "player_event": {
      const target = player(view, String(r.playerId));
      const usage = applyAgentEvent(target, r.event as AgentEventLike, meta);
      if (usage) target.turnUsage = usage;
      break;
    }
    case "player_finished": {
      const target = player(view, String(r.playerId));
      target.running = false;
      const result = r.result as {
        status: "ok" | "aborted" | "error";
        error?: string;
      };
      target.segments.push({
        ...meta,
        kind: "result",
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
        ...(target.turnUsage ? { usage: target.turnUsage } : {}),
      });
      break;
    }
    case "captain_prompt":
      break;
    case "captain_event": {
      const event = r.event as AgentEventLike;
      if (event.type === "text_delta") {
        view.captainDraft +=
          (event.payload as { delta?: string })?.delta ?? "";
      } else if (event.type === "text") {
        view.captainDraft =
          (event.payload as { content?: string })?.content ?? "";
      }
      break;
    }
    case "captain_reply": {
      // The playbook-7 shell speaks through captain_reply records —
      // its durable calls (and their captain_finished) are hidden, so
      // this record IS the Captain's visible prose (run-view-1). It
      // was dropped before the case existed, which read as a normal
      // chat producing nothing at all.
      const text = String((r as { text?: unknown }).text ?? "");
      if (text) {
        pushCaptain(view, {
          kind: "speech",
          text,
          turnId: r.turnId,
          at: r.timestamp,
        });
      }
      view.captainDraft = "";
      break;
    }
    case "captain_finished": {
      const result = r.result as {
        finalText?: string;
        status: string;
        error?: string;
      };
      // A visible errored result is a failure to show, never speech
      // to pass off as the Captain's words (run-view-2, DR-010 §5).
      if (result.status === "error") {
        pushCaptain(view, {
          kind: "error",
          ...plainFailure(
            result.error ?? result.finalText ?? "the Captain's turn failed",
          ),
          turnId: r.turnId,
          at: r.timestamp,
        });
        view.captainDraft = "";
        break;
      }
      const text = result.finalText ?? view.captainDraft;
      if (text) {
        pushCaptain(view, { kind: "speech", text, turnId: r.turnId, at: r.timestamp });
      }
      view.captainDraft = "";
      break;
    }
    case "captain_status": {
      const message = String(r.message);
      // While a machine frame is open, the run's progress is drawn,
      // not narrated: the card absorbs it (run-view-60). Only the ◇
      // engagement and ◆ failure vocabularies stay in the thread
      // (run-view-1/2) — everything else a run narrates is machine
      // detail, including the bare event ids the runtime emits with
      // no glyph at all ("START_CODE", "→ noFindings").
      if (
        view.frames.length > 0 &&
        !/^[◇◆]/u.test(message.trimStart())
      ) {
        break;
      }
      // The runtime narrates the parked question as a status line too;
      // once it lives in the thread as a question bubble, the echo is
      // noise (DR-010 §1).
      if (
        view.pendingQuestion !== undefined &&
        message.includes(view.pendingQuestion)
      ) {
        break;
      }
      pushCaptain(view, {
        kind: "status",
        text: message,
        turnId: r.turnId,
        at: r.timestamp,
        data: r.data,
      });
      break;
    }
    case "captain_telemetry": {
      const topic = String(r.topic);
      const payload = r.payload as { from?: unknown; to?: unknown; state?: unknown; pendingBossQuestion?: unknown; };
      // The playbook 2.0 shell reports states as rich objects
      // ({stateId, value, tags, …}); the fake harness and older
      // playbooks report bare strings. Accept both — never hand a
      // non-string to the label pipeline.
      const stateText = (value: unknown): string | undefined => {
        if (typeof value === "string") return value;
        if (value && typeof value === "object") {
          const shape = value as { stateId?: unknown; value?: unknown };
          if (typeof shape.stateId === "string") return shape.stateId;
          if (typeof shape.value === "string") return shape.value;
        }
        return undefined;
      };
      if (topic === "playbook.fsm.state") {
        view.fsmState = stateText(payload?.to) ?? stateText(payload?.state);
        if (view.fsmState === "awaitBossReply") {
          const parsed = parseBossQuestion(payload?.pendingBossQuestion);
          view.pendingQuestion = parsed?.question ?? view.pendingQuestion ?? "";
          view.pendingQuestionPlayer = resolvePlayerId(view, parsed?.player);
          if (parsed) {
            // The status narration of the same question may have
            // landed just before this record: replace it with the
            // first-class question bubble.
            for (let i = view.captain.length - 1; i >= 0; i -= 1) {
              const line = view.captain[i];
              if (line.kind === "boss") break;
              if (
                line.kind === "status" &&
                line.text.includes(parsed.question)
              ) {
                view.captain.splice(i, 1);
                break;
              }
            }
            pushCaptain(view, {
              kind: "question",
              text: parsed.question,
              player: view.pendingQuestionPlayer,
              turnId: r.turnId,
              at: r.timestamp,
            });
          }
        } else if (stateText(payload?.from) === "awaitBossReply") {
          // Only the parked machine leaving its park answers the
          // question; the Captain's own machine reports its states
          // after the park and must not clear it (run-view-9).
          view.pendingQuestion = undefined;
          view.pendingQuestionPlayer = undefined;
        }
      } else if (topic === "playbook.captain.fsm.state") {
        view.captainMode = stateText(payload?.to);
      } else if (topic === "playbook.trace") {
        // The structured trace opens, moves, and settles the machine
        // frames the pane draws (run-view-60..63); folding is pure so
        // a replay reproduces the same cards (run-view-14).
        const fold = foldTrace(
          view.frames,
          r.payload,
          r.timestamp,
          view.settledRuns,
        );
        view.frames = [...fold.open];
        view.settledRuns = [...fold.settled];
        if (fold.closed?.active === "awaitBossReply") {
          // A run dismissed while parked takes its question with it
          // (run-view-9).
          view.pendingQuestion = undefined;
          view.pendingQuestionPlayer = undefined;
        }
        if (fold.closed) {
          pushCaptain(view, {
            kind: "machine",
            text: `${fold.closed.playbookId} ${fold.closed.outcome ?? "finished"}`,
            frame: fold.closed,
            turnId: r.turnId,
            at: r.timestamp,
          });
        }
      }
      break;
    }
    case "player_view_changed":
      // A lane is the session's, not the current call's: the runtime's
      // narrowing tells the reducer nothing a pane should act on
      // (run-view-7).
      break;
    case "runtime_error": {
      // The line speaks plain (DR-010 §2): a leading "Error:" and
      // doubled periods go, a known runtime message maps to its
      // phrase, and the raw text survives for the tooltip.
      pushCaptain(view, {
        kind: "error",
        ...plainFailure(String(r.message)),
        turnId: r.turnId,
        at: r.timestamp,
      });
      break;
    }
    default:
      break;
  }
  return view;
}

export function applyRecords(
  view: SessionView,
  records: readonly { seq: number; record: TmuxPlayRecord; role?: string }[],
): SessionView {
  for (const entry of records) {
    applyRecord(view, entry.seq, entry.record, entry.role);
  }
  return view;
}
