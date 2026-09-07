// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Machine frames (run-view-60..64, 74..78, DR-031): the pure model
// behind the Captain pane's call tree. A frame opens only on evidence
// its run is underway, moves with every fsm.transition, carries the
// player activity of its active state and the call it delegates to,
// and settles under its caller — or into chat history for a root run.
// A settled run is tombstoned, so the reports that trail a finished
// run cannot resurrect it. Folding is pure over the record stream, so
// a replayed session reproduces identical cards (run-view-14).

import type { MachineGraph } from "@sublang/spex-core/protocol";

export interface MachineTransition {
  from: string | null;
  to: string;
  event: string;
  at: number;
}

export interface MachineFrame {
  /** The trace's own session identity — the frame key. */
  traceSessionId: string;
  /** Frozen definition from this run's recorded context; null means observed only. */
  historicalGraph?: MachineGraph | null;
  playbookId: string;
  depth: number;
  parentSessionId?: string;
  /** Active state id (single-region machines; the trace's value). */
  active: string | null;
  /** Every state the run has visited, in first-visit order. */
  visited: string[];
  /** Observed transitions, in order. */
  transitions: MachineTransition[];
  /** The edge fired last, for the flash (owner::event derived). */
  lastFired?: { from: string; to: string; event: string; at: number };
  /** The player the active state runs, when the trace attributes one. */
  /** The call a state is running: the playbook-local role it invokes
   * and, where the host resolved one, the session player answering it
   * (DR-032). A card names both, because the role is what the machine
   * asked for and the player is who is actually talking. */
  activePlayer?: {
    stateId: string;
    role: string;
    playerId?: string;
    running: boolean;
  };
  /** The nested run this frame's active state is delegating to, while
   * the call is open (run-view-63). */
  delegating?: { stateId: string; playbookId: string };
  /** Every call this run has made, in order — the calling states stay
   * labeled with their callees after settle (run-view-63). */
  calls: { stateId: string; playbookId: string }[];
  /** The caller's state that started this run, when the pane knows it
   * — the anchor the child settles under (run-view-62/63). */
  callerStateId?: string;
  /** Park/failure coloring hints from the trace's state tags. */
  activeTags: string[];
  /** Runs this frame called that have settled, in invocation order
   * (run-view-62); each carries its own settled calls in turn. */
  settledCalls: MachineFrame[];
  outcome?: "done" | "failed" | "stopped";
  openedAt: number;
  closedAt?: number;
}

/** A closed frame as it settles into the thread (run-view-62). */
export interface MachineHistory {
  frame: MachineFrame;
}

type TraceLike = {
  schemaVersion?: unknown;
  sessionId?: unknown;
  playbookId?: unknown;
  parentSessionId?: unknown;
  depth?: unknown;
  type?: unknown;
  timestamp?: unknown;
  payload?: unknown;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** The state value a trace payload names, tolerant of shape drift:
 * strings, {value}, {stateId} all appear across schema versions. */
function stateValue(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (value && typeof value === "object") {
    const shaped = value as { value?: unknown; stateId?: unknown };
    if (typeof shaped.value === "string") return shaped.value || undefined;
    if (typeof shaped.stateId === "string") return shaped.stateId || undefined;
  }
  return undefined;
}

function stateTags(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const tags = (value as { tags?: unknown }).tags;
  return Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === "string")
    : [];
}

function stateStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return asString((value as { status?: unknown }).status);
}

/** Which frames draw: real playbook runs. The captain shell's own
 * control loop at depth 0 stays the chip's business (DR-028). */
function drawable(playbookId: string, depth: number): boolean {
  return !(depth === 0 && playbookId === "captain");
}

export interface FrameFoldState {
  open: MachineFrame[];
  /** Trace sessions whose run has settled. A finished run keeps being
   * talked about — its closing status line, its turn settlement, its
   * disposal — and none of that may raise it again (run-view-74). */
  settled: readonly string[];
  /** Set when a fold call settled a root frame: the history entry the
   * reducer turns into a thread line (run-view-62). */
  closed?: MachineFrame;
}

/** The trace types that are evidence a run is underway. Everything
 * else only reports on a run and never opens a frame (run-view-74). */
const OPENING_TYPES = new Set([
  "session.started",
  "fsm.transition",
  "player.call.started",
  "player.call.finished",
  "playbook.call.started",
  "playbook.call.finished",
]);

/** The outcome a reported state status names, if it names one. */
function outcomeOf(status: string | undefined): MachineFrame["outcome"] {
  if (status === "done") return "done";
  if (status === "error") return "failed";
  if (status === "stopped") return "stopped";
  return undefined;
}

/** Folds one playbook.trace payload into the frame tree. Returns the
 * next state; `closed` carries at most the one root frame this record
 * settled. */
export function foldTrace(
  open: readonly MachineFrame[],
  payload: unknown,
  at: number,
  settled: readonly string[] = [],
  turnId: number | null = null,
): FrameFoldState {
  const idle: FrameFoldState = { open: [...open], settled };
  const trace = payload as TraceLike;
  const traceSessionId = asString(trace?.sessionId);
  const playbookId = asString(trace?.playbookId);
  const type = asString(trace?.type);
  if (!traceSessionId || !playbookId || !type) return idle;
  const depth = typeof trace.depth === "number" ? trace.depth : 0;
  if (!drawable(playbookId, depth)) return idle;
  // A settled run is finished with: nothing said afterwards revives it.
  if (settled.includes(traceSessionId)) return idle;

  const index = open.findIndex((f) => f.traceSessionId === traceSessionId);
  const found = index >= 0 ? open[index] : undefined;
  // Only evidence that this run is underway may open its frame.
  if (!found && !OPENING_TYPES.has(type)) return idle;
  const body = (trace.payload ?? {}) as Record<string, unknown>;

  const withFrame = (frame: MachineFrame): FrameFoldState => {
    const next = [...open];
    if (index >= 0) next[index] = frame;
    else {
      next.push(frame);
      next.sort((a, b) => a.depth - b.depth || a.openedAt - b.openedAt);
    }
    return { open: next, settled };
  };

  /** Settle a frame and everything it still has running: a run cannot
   * outlive its caller, and an orphan card would be a lie. */
  const close = (
    frame: MachineFrame,
    outcome: MachineFrame["outcome"],
  ): FrameFoldState => {
    const remaining = open.filter((f) => f.traceSessionId !== traceSessionId);
    const descendants: MachineFrame[] = [];
    const collect = (parentId: string): void => {
      for (const candidate of remaining) {
        if (candidate.parentSessionId !== parentId) continue;
        descendants.push(candidate);
        collect(candidate.traceSessionId);
      }
    };
    collect(frame.traceSessionId);
    const orphaned = new Set(descendants.map((f) => f.traceSessionId));
    const adopt = (parent: MachineFrame): MachineFrame => ({
      ...parent,
      settledCalls: [
        ...parent.settledCalls,
        ...descendants
          .filter((f) => f.parentSessionId === parent.traceSessionId)
          .map((child) =>
            adopt({
              ...child,
              // Still running when its caller ended: unfinished.
              outcome: child.outcome ?? "stopped",
              closedAt: at,
              activePlayer: undefined,
              delegating: undefined,
            }),
          ),
      ],
    });

    const complete = adopt({
      ...frame,
      outcome: frame.outcome ?? outcome,
      closedAt: at,
      activePlayer: undefined,
      delegating: undefined,
    });
    const stillOpen = remaining.filter((f) => !orphaned.has(f.traceSessionId));
    const nextSettled = [
      ...settled,
      complete.traceSessionId,
      ...descendants.map((f) => f.traceSessionId),
    ];

    // A child settles under its caller; only a root run reaches the
    // thread (run-view-62).
    const parentIndex = complete.parentSessionId
      ? stillOpen.findIndex(
          (f) => f.traceSessionId === complete.parentSessionId,
        )
      : -1;
    if (parentIndex >= 0) {
      const parent = stillOpen[parentIndex];
      const next = [...stillOpen];
      next[parentIndex] = {
        ...parent,
        settledCalls: [...parent.settledCalls, complete],
        delegating: undefined,
      };
      return { open: next, settled: nextSettled };
    }
    return { open: stillOpen, settled: nextSettled, closed: complete };
  };

  const opened = (): MachineFrame => {
    if (found) return found;
    const parentSessionId = asString(trace.parentSessionId);
    // The caller records which of its states is delegating; the child
    // reads its anchor from there (run-view-63).
    const caller = parentSessionId
      ? open.find((f) => f.traceSessionId === parentSessionId)
      : undefined;
    const callerStateId =
      caller?.delegating?.playbookId === playbookId
        ? caller.delegating.stateId
        : undefined;
    return {
      traceSessionId,
      playbookId,
      depth,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(callerStateId ? { callerStateId } : {}),
      active: null,
      visited: [],
      transitions: [],
      activeTags: [],
      calls: [],
      settledCalls: [],
      openedAt: at,
    };
  };

  switch (type) {
    case "session.started":
      return withFrame(opened());
    case "fsm.transition": {
      const frame = opened();
      const from = stateValue(body.from) ?? null;
      const to = stateValue(body.to) ?? stateValue(body.state);
      if (!to) return withFrame(frame);
      const transitions = [
        ...frame.transitions,
        {
          from,
          to,
          event:
            asString((body.event as { type?: unknown } | undefined)?.type) ??
            asString(body.event) ??
            "",
          at,
        },
      ];
      const visited = frame.visited.includes(to)
        ? frame.visited
        : [...frame.visited, to];
      const status = stateStatus(body.state);
      const moved: MachineFrame = {
        ...frame,
        active: to,
        visited,
        transitions,
        activeTags: stateTags(body.state),
        ...(from
          ? {
              lastFired: {
                from,
                to,
                event: transitions[transitions.length - 1].event,
                at,
              },
            }
          : {}),
        // A player attributed to a previous state is stale once the
        // machine moves on.
        ...(frame.activePlayer && frame.activePlayer.stateId !== to
          ? { activePlayer: undefined }
          : {}),
      };
      const outcome = outcomeOf(status);
      return outcome ? close(moved, outcome) : withFrame(moved);
    }
    case "player.call.started": {
      const frame = opened();
      const stateId = asString(body.stateId) ?? frame.active ?? undefined;
      const role = asString(body.roleId);
      const playerId = asString(body.playerId);
      if (!stateId || !role) return withFrame(frame);
      return withFrame({
        ...frame,
        activePlayer: {
          stateId,
          role,
          ...(playerId ? { playerId } : {}),
          running: true,
        },
      });
    }
    case "player.call.finished": {
      const frame = opened();
      if (!frame.activePlayer) return withFrame(frame);
      return withFrame({
        ...frame,
        activePlayer: { ...frame.activePlayer, running: false },
      });
    }
    case "playbook.call.started": {
      const frame = opened();
      const stateId = asString(body.stateId) ?? frame.active ?? undefined;
      const callee = asString(body.playbookId);
      if (!stateId || !callee) return withFrame(frame);
      return withFrame({
        ...frame,
        delegating: { stateId, playbookId: callee },
        calls: [...frame.calls, { stateId, playbookId: callee }],
      });
    }
    case "playbook.call.finished": {
      const frame = opened();
      return withFrame({ ...frame, delegating: undefined });
    }
    case "session.disposed":
      // Outside a turn — no turn id — the host is releasing the runtime
      // at settlement (DR-051): a pause the parked run survives, so its
      // card stays as it stands. Inside a turn, disposal closes only a
      // frame still open, with the run's own reported status — a
      // finished run is not "stopped".
      if (turnId === null) return found ? withFrame(found) : idle;
      return found
        ? close(found, outcomeOf(stateStatus(body.state)) ?? "stopped")
        : idle;
    default:
      // Everything else only reports on a run already underway.
      return found ? withFrame(found) : idle;
  }
}

// --- Layout and geometry (DR-031: solved once, tiny and fixed) --------------

export interface MachinePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MachineLayout {
  nodes: Map<string, MachinePlacement>;
  width: number;
  height: number;
  /** Every transition's rendering kind: a drawn line between layout
   * neighbours, or an exit label inside its source (run-view-76). */
  kinds: Map<string, "line" | "exit">;
}

export const STATE_W = 132;
/** Two text lines — title and caption — before any exit labels. */
export const STATE_BASE_H = 44;
export const EXIT_LINE_H = 13;
/** Ranks run top to bottom: the Captain pane is tall and narrow, so
 * the machine reads down the thread like the conversation does. */
export const RANK_GAP = 42;
export const ROW_GAP = 48;

/** The graph a frame draws when no definition is served: the observed
 * states and transitions alone (run-view-64). */
export function observedGraph(frame: MachineFrame): MachineGraph {
  const nodes = frame.visited.map((id) => ({
    id,
    kind: "state" as const,
    tags: [],
  }));
  const seen = new Set<string>();
  const edges = frame.transitions
    .filter((t) => t.from !== null)
    .map((t, i) => ({
      id: `${t.from}::${t.event}::${i}::0`,
      from: t.from as string,
      to: t.to,
      event: t.event,
    }))
    .filter((e) => {
      const key = `${e.from}>${e.to}>${e.event}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const initial = frame.transitions[0]?.from ?? frame.visited[0] ?? "";
  return { initial, nodes, edges };
}

/**
 * Top-to-bottom layered layout: BFS ranks from the initial state,
 * stable sibling order, one barycenter pass — deterministic per
 * machine, nothing physical, nothing tuned (DR-028).
 *
 * The layout also decides each transition's rendering kind. Only
 * layout neighbours draw as lines — one rank apart or side by side,
 * within one column; every other transition is an exit label inside
 * its source box, which grows to hold its labels. These machines run
 * three edges per state, and at that fan-in routed lanes always end
 * in a hairball; text cannot collide (run-view-76, DR-031).
 */
export function layoutMachine(graph: MachineGraph): MachineLayout {
  const ids = graph.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const out = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    const list = out.get(edge.from) ?? [];
    if (!list.includes(edge.to)) list.push(edge.to);
    out.set(edge.from, list);
  }

  // BFS ranks from the initial state; unreached states append as a
  // final rank in declaration order, so nothing is dropped.
  const rank = new Map<string, number>();
  if (idSet.has(graph.initial)) rank.set(graph.initial, 0);
  const queue = idSet.has(graph.initial) ? [graph.initial] : [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of out.get(current) ?? []) {
      if (rank.has(next)) continue;
      rank.set(next, (rank.get(current) ?? 0) + 1);
      queue.push(next);
    }
  }
  const maxRank = Math.max(0, ...rank.values());
  for (const id of ids) {
    if (!rank.has(id)) rank.set(id, maxRank + 1);
  }

  const ranks = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) as number;
    const list = ranks.get(r) ?? [];
    list.push(id);
    ranks.set(r, list);
  }

  // One barycenter pass orders each rank by the mean column of its
  // predecessors, ties by declaration order — stable and cheap.
  const colOf = new Map<string, number>();
  const orderedRanks = [...ranks.keys()].sort((a, b) => a - b);
  for (const r of orderedRanks) {
    const members = ranks.get(r) as string[];
    if (r === orderedRanks[0]) {
      members.forEach((id, i) => colOf.set(id, i));
      continue;
    }
    const keyed = members.map((id, declared) => {
      const preds = graph.edges
        .filter((e) => e.to === id && (rank.get(e.from) ?? 0) < r)
        .map((e) => colOf.get(e.from) ?? 0);
      const bary =
        preds.length > 0
          ? preds.reduce((a, b) => a + b, 0) / preds.length
          : declared;
      return { id, bary, declared };
    });
    keyed.sort((a, b) => a.bary - b.bary || a.declared - b.declared);
    keyed.forEach((entry, i) => colOf.set(entry.id, i));
    ranks.set(
      r,
      keyed.map((entry) => entry.id),
    );
  }

  // Kind decision from rank structure alone, so box heights (which
  // depend on exit counts) are known before placement.
  const kinds = new Map<string, "line" | "exit">();
  for (const edge of graph.edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    if (edge.from === edge.to) {
      kinds.set(edge.id, "line");
      continue;
    }
    const rankDiff = (rank.get(edge.to) as number) - (rank.get(edge.from) as number);
    const colDiff = Math.abs(
      (colOf.get(edge.to) ?? 0) - (colOf.get(edge.from) ?? 0),
    );
    const neighbour =
      (Math.abs(rankDiff) === 1 && colDiff <= 1) ||
      (rankDiff === 0 && colDiff === 1);
    kinds.set(edge.id, neighbour ? "line" : "exit");
  }

  const exitCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (kinds.get(edge.id) !== "exit") continue;
    exitCount.set(edge.from, (exitCount.get(edge.from) ?? 0) + 1);
  }

  // Boxes in a rank share the rank's height, so the bands between
  // ranks stay empty and a neighbour line can never clip a taller
  // sibling (run-view-76).
  const rankHeight = new Map<number, number>();
  for (const r of orderedRanks) {
    const members = ranks.get(r) as string[];
    const h = Math.max(
      ...members.map(
        (id) => STATE_BASE_H + (exitCount.get(id) ?? 0) * EXIT_LINE_H,
      ),
    );
    rankHeight.set(r, h);
  }

  const nodes = new Map<string, MachinePlacement>();
  let width = 0;
  let y = 0;
  for (const r of orderedRanks) {
    const members = ranks.get(r) as string[];
    const height = rankHeight.get(r) as number;
    for (const id of members) {
      const x = (colOf.get(id) ?? 0) * (STATE_W + ROW_GAP);
      nodes.set(id, { x, y, width: STATE_W, height });
      width = Math.max(width, x + STATE_W);
    }
    y += height + RANK_GAP;
  }
  const height = Math.max(1, y - RANK_GAP);
  return { nodes, width: Math.max(width, 1), height, kinds };
}

// --- Edge geometry (run-view-76: neighbours draw, distance speaks) ----------

export interface RoutedEdge {
  id: string;
  from: string;
  to: string;
  event: string;
  kind: "line" | "exit";
  /** Line: SVG path ending on the target's border. */
  path?: string;
  /** Line: the landing point, on the target's border by construction. */
  head?: { x: number; y: number };
  /** Exit: which slot in the source box the label occupies. */
  slot?: number;
  /** Exit: the label's text anchor inside the source box. */
  anchor?: { x: number; y: number };
}

/** Minimum gap between two heads sharing one border. */
const PORT_GAP = 14;
/** Reciprocal vertical pairs separate by this much. */
const PAIR_SHIFT = 7;

type Box = MachinePlacement;
const centerX = (b: Box): number => b.x + b.width / 2;

/**
 * Solve every transition's geometry over a layout: neighbour lines
 * land on borders at unshared ports, everything else becomes an exit
 * label at an unshared slot in its source (run-view-76). Pure over
 * the layout, so the law is assertable exactly (run-view-77).
 */
export function routeEdges(
  graph: MachineGraph,
  layout: MachineLayout,
): RoutedEdge[] {
  // Reserve one port per drawn head on each (target, border) pair.
  const portGroups = new Map<string, string[]>();
  const borderOf = (edge: { id: string; from: string; to: string }): string => {
    const from = layout.nodes.get(edge.from) as Box;
    const to = layout.nodes.get(edge.to) as Box;
    if (Math.abs(to.y - from.y) < 1) {
      return centerX(to) >= centerX(from) ? "left" : "right";
    }
    return to.y > from.y ? "top" : "bottom";
  };
  for (const edge of graph.edges) {
    if (layout.kinds.get(edge.id) !== "line" || edge.from === edge.to) continue;
    if (!layout.nodes.has(edge.from) || !layout.nodes.has(edge.to)) continue;
    const key = `${edge.to}|${borderOf(edge)}`;
    const list = portGroups.get(key) ?? [];
    list.push(edge.id);
    portGroups.set(key, list);
  }

  const exitSlots = new Map<string, number>();
  const routed: RoutedEdge[] = [];

  for (const edge of graph.edges) {
    const from = layout.nodes.get(edge.from);
    const to = layout.nodes.get(edge.to);
    if (!from || !to) continue;
    const base = { id: edge.id, from: edge.from, to: edge.to, event: edge.event };

    if (layout.kinds.get(edge.id) === "exit") {
      const slot = exitSlots.get(edge.from) ?? 0;
      exitSlots.set(edge.from, slot + 1);
      routed.push({
        ...base,
        kind: "exit",
        slot,
        anchor: {
          x: from.x + 10,
          y: from.y + STATE_BASE_H + 2 + slot * EXIT_LINE_H,
        },
      });
      continue;
    }

    if (edge.from === edge.to) {
      const head = { x: from.x + from.width, y: from.y + from.height * 0.66 };
      routed.push({
        ...base,
        kind: "line",
        head,
        path:
          `M ${from.x + from.width} ${from.y + from.height * 0.34}` +
          ` C ${from.x + from.width + 24} ${from.y + from.height * 0.2}` +
          ` ${from.x + from.width + 24} ${from.y + from.height * 0.8}` +
          ` ${head.x} ${head.y}`,
      });
      continue;
    }

    const lateral = Math.abs(to.y - from.y) < 1;
    if (lateral) {
      // Neighbours across the row meet on their facing borders, the
      // two directions offset above and below the midline. Several
      // heads on one facing border spread down it — a state whose
      // done and error branches both name its lateral neighbour
      // draws two lines, each at its own port.
      const leftToRight = centerX(to) >= centerX(from);
      const offset = leftToRight ? -6 : 6;
      const border = leftToRight ? "left" : "right";
      const group = portGroups.get(`${edge.to}|${border}`) ?? [edge.id];
      const slot = Math.max(0, group.indexOf(edge.id));
      const usable = Math.max(PORT_GAP, to.height - 2 * PORT_GAP);
      const portY =
        group.length <= 1
          ? to.y + to.height / 2
          : to.y + PORT_GAP + (usable * slot) / (group.length - 1);
      const headY = Math.min(
        to.y + to.height - 8,
        Math.max(to.y + 8, portY + offset),
      );
      const tail = leftToRight
        ? { x: from.x + from.width, y: from.y + from.height / 2 + offset }
        : { x: from.x, y: from.y + from.height / 2 + offset };
      const head = leftToRight
        ? { x: to.x, y: headY }
        : { x: to.x + to.width, y: headY };
      routed.push({
        ...base,
        kind: "line",
        head,
        path: `M ${tail.x} ${tail.y} L ${head.x} ${head.y}`,
      });
      continue;
    }

    // Vertical neighbours: forward lands on the top border, backward
    // on the bottom; the pair splits left/right of center so a
    // reciprocal never overlaps itself.
    const forward = to.y > from.y;
    const border = forward ? "top" : "bottom";
    const group = portGroups.get(`${edge.to}|${border}`) ?? [edge.id];
    const slot = Math.max(0, group.indexOf(edge.id));
    const usable = Math.max(PORT_GAP, to.width - 2 * PORT_GAP);
    const portX =
      group.length <= 1
        ? centerX(to) + (forward ? -PAIR_SHIFT : PAIR_SHIFT)
        : to.x + PORT_GAP + (usable * slot) / (group.length - 1);
    const head = {
      x: Math.min(to.x + to.width - 8, Math.max(to.x + 8, portX)),
      y: forward ? to.y : to.y + to.height,
    };
    const tail = {
      x: centerX(from) + (forward ? -PAIR_SHIFT : PAIR_SHIFT),
      y: forward ? from.y + from.height : from.y,
    };
    const bend = forward ? 14 : -14;
    routed.push({
      ...base,
      kind: "line",
      head,
      path:
        `M ${tail.x} ${tail.y}` +
        ` C ${tail.x} ${tail.y + bend} ${head.x} ${head.y - bend}` +
        ` ${head.x} ${head.y}`,
    });
  }
  return routed;
}

/** True when a routed line visibly crosses a state box it neither
 * starts nor ends at — the invariant run-view-76 forbids. */
export function edgeCrossesBox(
  edge: RoutedEdge,
  layout: MachineLayout,
): boolean {
  if (edge.kind !== "line" || !edge.path) return false;
  const points = samplePath(edge.path);
  for (const [id, box] of layout.nodes) {
    if (id === edge.from || id === edge.to) continue;
    for (const point of points) {
      if (
        point.x > box.x + 0.5 &&
        point.x < box.x + box.width - 0.5 &&
        point.y > box.y + 0.5 &&
        point.y < box.y + box.height - 0.5
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Flatten an SVG path of M/C/L commands into sample points — enough
 * to test containment without a DOM. */
export function samplePath(path: string): { x: number; y: number }[] {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i], y: numbers[i + 1] });
  }
  if (points.length < 2) return points;
  const dense: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    for (let step = 0; step <= 12; step += 1) {
      const t = step / 12;
      dense.push({
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      });
    }
  }
  return dense;
}
