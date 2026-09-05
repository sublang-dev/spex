// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The file state (DR-036, CORE-15): plain files under one state root
// are the durable truth, and every in-memory index rebuilds from them
// at startup. The core package is the only writer of the Spex-owned
// files. Sessions persist as one record-stream JSONL plus a project-
// binding sidecar per session; turns, titles, and usage fold from the
// stream and are never separately stored (CORE-10). The sidecar also
// carries the token-free Captain snapshot a message continues the
// session from (DR-042). Intents persist
// as per-project append-only act logs (CORE-52). Hidden records ride
// the stream with their visibility, so replay filters identically to
// live streaming. A root lease admits one core per root (CORE-61),
// and a legacy SQLite store imports once (CORE-64) through
// better-sqlite3 — the import path's only remaining use.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type {
  ForgeState,
  IntentInfo,
  IntentSource,
  IntentSourceKind,
  ProjectInfo,
  SessionInfo,
  StoredRecord,
  TmuxPlayRecord,
} from "./protocol.js";
import { hasPresentationHeader } from "./protocol.js";
import {
  foldTurnEvent,
  foldUsage,
  sanitizeRecord,
  type TurnEvent,
  type UsageEntry,
  type UsageTotals,
} from "./stream-fold.js";

export type { UsageEntry, UsageTotals } from "./stream-fold.js";

const META_VERSION = 1;

/**
 * The Captain's durable state at the session's last settled point
 * (DR-042), persisted in the sidecar: the Captain shell's own export
 * with every provider token stripped. `shell` is absent for a Captain
 * that exports no state — continuation then starts it fresh, the
 * stream still carrying the conversation.
 */
export interface CaptainSnapshot {
  v: 1;
  shell?: unknown;
}

/** Who holds a session's lease in the shared session store (DR-042). */
export interface SessionLeaseHolder {
  pid: number;
  hostname: string;
}

/** Another core instance holds the state root (CORE-61). */
export class StateRootHeldError extends Error {
  constructor(
    readonly holder: { pid: number; hostname: string; acquiredAt: number },
    dir: string,
  ) {
    super(
      `state root ${dir} is held by pid ${holder.pid} on ${holder.hostname}; ` +
        "one core serves a root at a time (DR-036)",
    );
    this.name = "StateRootHeldError";
  }
}

export interface StoreOptions {
  /** State root directory; unset runs the store in memory only. */
  dir?: string;
  /** Sessions directory; defaults to `<dir>/sessions`. */
  sessionsDir?: string;
  /** A legacy SQLite store to import once (CORE-64). */
  legacyDbPath?: string;
}

interface SessionMeta {
  id: string;
  projectId: string;
  createdAt: number;
  endedAt: number | null;
  live: boolean;
  players: SessionInfo["players"];
  initialVisible: string[];
  /** Set when an append failed: the file is a complete prefix only up
   * to this sequence; later records lived in memory only (DR-036). */
  streamIncompleteAfterSeq?: number;
  /** Set on a session another host wrote into the shared store: this
   * core serves it and writes none of its files (core-service-65),
   * deleting them only on request (core-service-70). In memory only —
   * we write no sidecar for it. */
  foreign?: true;
  /** The directory a foreign session's files were found in — where a
   * deletion reaches them and where their vanishing is noticed
   * (DR-042). In memory only. */
  originDir?: string;
  /** The Captain snapshot a message continues the session from
   * (DR-042); absent until a turn or the session's end persisted one. */
  snapshot?: CaptainSnapshot;
}

interface TurnRow {
  turnId: number;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  status: string | null;
}

interface StoreMeta {
  version: number;
  importedLegacy?: string[];
}

type IntentAct =
  | { act: "queue"; intent: IntentInfo }
  | { act: "edit"; id: string; text: string }
  | { act: "move"; id: string; rank: string }
  | { act: "link"; id: string; afterId: string | null }
  | { act: "dispatch"; id: string; sessionId: string; turnId: number; at: number }
  | { act: "close"; id: string; as: "done" | "dropped"; at: number }
  | { act: "remove"; id: string; at: number };

function isHidden(record: TmuxPlayRecord): boolean {
  return (
    "visibility" in record &&
    (record as { visibility?: string }).visibility === "hidden"
  );
}

/** One session's listing row plus its folded summary, in the single
 * shape every listing and broadcast shares (core-service-32). */
function sessionInfo(
  meta: SessionMeta,
  path: string,
  title: string | undefined,
  turns: number,
  failed: boolean,
  costUsd: number | undefined,
): SessionInfo {
  return {
    id: meta.id,
    projectId: meta.projectId,
    projectPath: path,
    createdAt: meta.createdAt,
    live: meta.live,
    endedAt: meta.endedAt,
    players: meta.players,
    initialVisible: meta.initialVisible,
    ...(title !== undefined ? { title } : {}),
    turns,
    failed,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(meta.streamIncompleteAfterSeq !== undefined
      ? { streamIncompleteAfterSeq: meta.streamIncompleteAfterSeq }
      : {}),
    // Served, never written or continued here (core-service-32, DR-042).
    ...(meta.foreign ? { foreign: true } : {}),
    // Ended, this core's own, holding a snapshot, and whole: a Boss
    // message continues it (core-service-32, core-service-73).
    ...(!meta.live &&
    !meta.foreign &&
    meta.snapshot !== undefined &&
    meta.streamIncompleteAfterSeq === undefined
      ? { continuable: true }
      : {}),
  };
}

/** Atomic whole-file replace: a reader never sees a torn file. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/**
 * JSONL as a reader that owns nothing: the complete newline-terminated
 * prefix is the readable content, damage is tolerated by stopping at
 * it, and the file is never mutated — the contract a lease-free reader
 * of another host's stream must honor (DR-036).
 */
function readRecordsPrefix(file: string, retainSequenceGaps = false): { records: StoredRecord[]; incompleteAfterSeq?: number } {
  if (!existsSync(file)) return { records: [] };
  const lines = readFileSync(file, "utf8").split("\n");
  // A parseable last line is still uncommitted until its newline lands.
  const unterminated = lines.pop() !== "";
  const records: StoredRecord[] = [];
  let lastSeq = 0;
  let incompleteAfterSeq: number | undefined;
  const markIncomplete = (): void => { incompleteAfterSeq ??= lastSeq; };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      const entry = value as Partial<StoredRecord> & { v?: unknown };
      if (
        !entry || typeof entry !== "object" ||
        entry.v !== 1 || typeof entry.seq !== "number" ||
        !Number.isSafeInteger(entry.seq) || entry.seq <= lastSeq ||
        Object.keys(entry).some((key) => !["v", "seq", "role", "record"].includes(key)) ||
        (entry.role !== undefined && typeof entry.role !== "string") ||
        !entry.record || typeof entry.record !== "object" ||
        Array.isArray(entry.record)
      ) {
        markIncomplete();
        break;
      }
      if (entry.seq !== lastSeq + 1) {
        markIncomplete();
        // Legacy native imports can have gaps. Their later increasing
        // records stay readable, but never certify safe continuation.
        if (!retainSequenceGaps) break;
      }
      // Payloads are opaque in v1; only their presenters require a
      // type and timestamp. Unknown records still consume a sequence.
      const { v: _v, ...kept } = entry;
      records.push(kept as StoredRecord);
      lastSeq = entry.seq;
    } catch {
      markIncomplete();
      break;
    }
  }
  if (unterminated) markIncomplete();
  return { records, ...(incompleteAfterSeq !== undefined ? { incompleteAfterSeq } : {}) };
}

/**
 * JSONL lines of a file this store owns and appends, healing crash
 * damage in place: a torn trailing line is dropped and the file
 * rewritten to its recovered content, and a file missing its final
 * newline is completed — so a later append can never glue onto damage
 * and turn a tolerated tail into permanent corruption. Only lawful
 * under the root lease: a reader without the lease uses
 * `readRecordsPrefix` and mutates nothing.
 */
function readLinesHealing<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const out: T[] = [];
  const good: string[] = [];
  let torn = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
      good.push(line);
    } catch (error) {
      if (i === lines.length - 1) {
        torn = true;
        break;
      }
      throw error;
    }
  }
  if (torn || !text.endsWith("\n")) {
    writeAtomic(file, good.length > 0 ? `${good.join("\n")}\n` : "");
  }
  return out;
}

function usageTotals(entries: UsageEntry[]): UsageTotals {
  const sources = new Set<string>();
  const totals = { inputTokens: 0, outputTokens: 0, toolUses: 0, totalCostUsd: 0 };
  for (const entry of entries) {
    totals.inputTokens += entry.inputTokens ?? 0;
    totals.outputTokens += entry.outputTokens ?? 0;
    totals.toolUses += entry.toolUses;
    totals.totalCostUsd += entry.totalCostUsd ?? 0;
    if (entry.costSource) sources.add(entry.costSource);
  }
  return { ...totals, costSources: [...sources].sort() };
}


/**
 * The Boss-level history a pre-stream captain-session record holds,
 * as the records a stream would carry: each `boss` journal entry opens
 * a turn with its prompt, each `reply` is the Captain's reply, and a
 * turn closes when the next opens or the journal ends. Timestamps are
 * the record's own — its creation for the first turn, its last update
 * for the final close — since the journal carries none.
 */
function journalRecords(record: {
  createdAt?: unknown;
  updatedAt?: unknown;
  snapshot?: { journal?: unknown };
}): StoredRecord[] {
  const journal = record.snapshot?.journal;
  if (!Array.isArray(journal)) return [];
  const createdAt = Date.parse(String(record.createdAt)) || 0;
  const updatedAt = Date.parse(String(record.updatedAt)) || createdAt;
  const out: StoredRecord[] = [];
  let openTurn: number | undefined;
  const close = (timestamp: number): void => {
    if (openTurn === undefined) return;
    out.push({
      seq: out.length + 1,
      record: { type: "turn_finished", turnId: openTurn, timestamp } as TmuxPlayRecord,
    });
    openTurn = undefined;
  };
  for (const entry of journal as { turnId?: unknown; kind?: unknown; payload?: unknown }[]) {
    if (typeof entry?.turnId !== "number" || typeof entry.payload !== "string") continue;
    if (entry.kind === "boss") {
      close(createdAt);
      openTurn = entry.turnId;
      out.push({
        seq: out.length + 1,
        record: {
          type: "turn_started",
          turnId: entry.turnId,
          timestamp: createdAt,
          turn: { id: entry.turnId, prompt: entry.payload },
        } as TmuxPlayRecord,
      });
    } else if (entry.kind === "reply" && openTurn === entry.turnId) {
      out.push({
        seq: out.length + 1,
        record: {
          type: "captain_reply",
          turnId: entry.turnId,
          timestamp: createdAt,
          text: entry.payload,
        } as TmuxPlayRecord,
      });
    }
  }
  close(updatedAt);
  return out;
}

export class Store {
  private readonly dir?: string;
  private readonly sessionsDir?: string;
  private lockDir?: string;
  private leaseToken = "";

  private meta: StoreMeta = { version: META_VERSION };
  private readonly projects = new Map<string, ProjectInfo>();
  private readonly prefs = new Map<string, unknown>();
  private readonly forgeCache = new Map<string, { at: number; state: ForgeState }>();
  private readonly intents = new Map<string, IntentInfo>();
  /** Intents a remove act retired (DR-038): their acts stay in the
   * log, and every read passes them by. */
  private readonly removedIntents = new Set<string>();
  private readonly sessions = new Map<string, SessionMeta>();
  private readonly records = new Map<string, StoredRecord[]>();
  private readonly turns = new Map<string, Map<number, TurnRow>>();
  private readonly usage = new Map<string, UsageEntry[]>();

  constructor(options: StoreOptions = {}) {
    this.dir = options.dir;
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    this.sessionsDir = options.sessionsDir ?? join(this.dir, "sessions");
    // Sessions are private, and the playbook store refuses a sessions
    // directory that is not 0700 — so a config pointing both hosts at
    // this one works rather than failing at the CLI's first launch.
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.dir, "intents"), { recursive: true });
    this.acquireRootLease();
    try {
      this.meta = readJson<StoreMeta>(this.metaFile()) ?? { version: 0 };
      this.importLegacy(options.legacyDbPath);
      this.meta.version = META_VERSION;
      writeAtomic(this.metaFile(), JSON.stringify(this.meta));
      this.load();
    } catch (error) {
      this.releaseRootLease();
      throw error;
    }
  }

  // -- root lease (CORE-61) -------------------------------------------------

  /** The lock's owner file, or undefined when absent or unparsable —
   * the lease paths must classify damage, never crash on it. */
  private readLeaseOwner(
    lock: string,
  ): { pid: number; hostname: string; acquiredAt: number; token?: string } | undefined {
    try {
      return readJson(join(lock, "owner.json"));
    } catch {
      return undefined;
    }
  }

  private acquireRootLease(): void {
    const dir = this.dir as string;
    const lock = join(dir, ".lock");
    this.leaseToken = randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Stage-then-rename: the lock is published atomically with its
      // owner file inside, so a reader never sees an ownerless lock.
      const stage = join(dir, `.lock.stage.${this.leaseToken}`);
      try {
        mkdirSync(stage);
        writeFileSync(
          join(stage, "owner.json"),
          JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            acquiredAt: Date.now(),
            token: this.leaseToken,
          }),
        );
        renameSync(stage, lock);
        this.lockDir = lock;
        return;
      } catch {
        rmSync(stage, { recursive: true, force: true });
        const owner = this.readLeaseOwner(lock);
        if (!owner) {
          // A published lock always carries its owner; an unreadable
          // one is fail-closed — deleting it is the operator's call.
          throw new Error(
            `state root ${dir} holds an unreadable lock at ${lock}; ` +
              "delete it if no other Spex core is running (DR-036)",
          );
        }
        // A foreign host's lease is never broken (DR-036): liveness
        // cannot be probed across machines.
        if (owner.hostname !== hostname()) throw new StateRootHeldError(owner, dir);
        if (processAlive(owner.pid)) throw new StateRootHeldError(owner, dir);
        // Same host, dead pid: retire by rename-aside, which only one
        // contender can win — the loser just loops and re-reads.
        const retired = join(dir, `.lock.retired.${owner.token ?? randomUUID()}`);
        try {
          renameSync(lock, retired);
          rmSync(retired, { recursive: true, force: true });
        } catch {
          // Another contender retired it first.
        }
      }
    }
    throw new Error(`state root ${dir} lease could not be acquired`);
  }

  private releaseRootLease(): void {
    if (!this.lockDir) return;
    // Release only a lease this instance still owns: a stale loser
    // must never delete the winner's lock.
    const owner = this.readLeaseOwner(this.lockDir);
    if (owner?.token === this.leaseToken) {
      rmSync(this.lockDir, { recursive: true, force: true });
    }
    this.lockDir = undefined;
  }

  // -- files ----------------------------------------------------------------

  private metaFile(): string {
    return join(this.dir as string, "meta.json");
  }

  private sidecarFile(sessionId: string): string {
    return join(this.sessionsDir as string, `${sessionId}.spex.json`);
  }

  private recordsFile(sessionId: string): string {
    return join(this.sessionsDir as string, `${sessionId}.records.jsonl`);
  }

  private intentsFile(projectId: string): string {
    return join(this.dir as string, "intents", `${projectId}.jsonl`);
  }

  // Every file kind carries its version marker (core-service-15):
  // whole files as a `v` wrapper, JSONL files as a `v` on each line.
  private saveProjects(): void {
    if (!this.dir) return;
    writeAtomic(
      join(this.dir, "projects.json"),
      JSON.stringify({ v: 1, projects: [...this.projects.values()] }),
    );
  }

  private savePrefs(): void {
    if (!this.dir) return;
    writeAtomic(
      join(this.dir, "prefs.json"),
      JSON.stringify({ v: 1, prefs: Object.fromEntries(this.prefs) }),
    );
  }

  private saveForgeCache(): void {
    if (!this.dir) return;
    writeAtomic(
      join(this.dir, "forge-cache.json"),
      JSON.stringify({ v: 1, entries: Object.fromEntries(this.forgeCache) }),
    );
  }

  private saveSidecar(meta: SessionMeta): void {
    // Another host owns its own session's files (core-service-65).
    if (!this.sessionsDir || meta.foreign) return;
    const { originDir: _origin, ...persisted } = meta;
    writeAtomic(this.sidecarFile(meta.id), JSON.stringify({ v: 1, ...persisted }));
  }

  private appendIntentAct(projectId: string, act: IntentAct): void {
    if (!this.dir) return;
    appendFileSync(
      this.intentsFile(projectId),
      `${JSON.stringify({ v: 1, ...act })}\n`,
    );
  }

  // -- load (the restart fold, CORE-10/52) ----------------------------------

  private load(): void {
    const dir = this.dir as string;
    for (const project of readJson<{ projects: ProjectInfo[] }>(
      join(dir, "projects.json"),
    )?.projects ?? []) {
      this.projects.set(project.id, project);
    }
    for (const [key, value] of Object.entries(
      readJson<{ prefs: Record<string, unknown> }>(join(dir, "prefs.json"))
        ?.prefs ?? {},
    )) {
      this.prefs.set(key, value);
    }
    for (const [projectId, entry] of Object.entries(
      readJson<{ entries: Record<string, { at: number; state: ForgeState }> }>(
        join(dir, "forge-cache.json"),
      )?.entries ?? {},
    )) {
      this.forgeCache.set(projectId, entry);
    }
    for (const file of readdirSync(join(dir, "intents"))) {
      if (!file.endsWith(".jsonl")) continue;
      for (const act of readLinesHealing<IntentAct>(join(dir, "intents", file))) {
        this.foldIntentAct(act);
      }
    }
    const sessionsDir = this.sessionsDir as string;
    for (const file of readdirSync(sessionsDir)) {
      if (!file.endsWith(".spex.json")) continue;
      const meta = readJson<SessionMeta>(join(sessionsDir, file));
      if (!meta) continue;
      this.sessions.set(meta.id, meta);
      const { records: stored, incompleteAfterSeq } = readRecordsPrefix(this.recordsFile(meta.id), true);
      if (incompleteAfterSeq !== undefined) {
        meta.streamIncompleteAfterSeq = Math.min(meta.streamIncompleteAfterSeq ?? incompleteAfterSeq, incompleteAfterSeq);
        // Keep the raw damaged stream for inspection. The existing
        // continuation gate refuses it instead of appending onto damage.
        this.saveSidecar(meta);
      }
      this.records.set(meta.id, stored);
      // Turns, titles, and usage are never separately stored: the
      // stream is the truth and the restart folds it (core-service-10).
      for (const entry of stored) {
        this.foldRecord(meta.id, entry.record);
      }
    }
  }

  /**
   * Adopt every session another host wrote into the shared session
   * store's directory (core-service-60): a playbook captain-session
   * record `<id>.json` names the working directory, and the replay
   * stream `<id>.records.jsonl` beside it carries the history. A
   * session binds to the registered project whose path is that working
   * directory. Foreign sessions refresh from the readable prefix;
   * sessions this core owns are never replaced. Returns changes only,
   * with new records to stream where the prior history is a prefix.
   */
  adoptForeignSessions(sessionsDir: string): { id: string; appended: StoredRecord[] }[] {
    if (!existsSync(sessionsDir)) return [];
    const changed: { id: string; appended: StoredRecord[] }[] = [];
    for (const file of readdirSync(sessionsDir)) {
      // Our own sidecars end `.spex.json`; a captain-session record is
      // `<id>.json`, and every other file in the directory is theirs.
      if (!file.endsWith(".json") || file.endsWith(".spex.json")) continue;
      const id = file.slice(0, -".json".length);
      const previousMeta = this.sessions.get(id);
      if (previousMeta && !previousMeta.foreign) continue;
      let record: {
        sessionId?: unknown;
        cwd?: unknown;
        createdAt?: unknown;
        updatedAt?: unknown;
        snapshot?: { journal?: unknown };
      } | undefined;
      let stored: StoredRecord[];
      try {
        record = readJson(join(sessionsDir, file));
        const stream = join(sessionsDir, `${id}.records.jsonl`);
        // A legacy record with no replay stream carries the Boss
        // conversation in its journal. An unfinished stream is not
        // permission to replace its history with synthetic records.
        stored = [];
        if (existsSync(stream)) {
          stored = readRecordsPrefix(stream).records;
        } else if (record) {
          stored = journalRecords(record);
        }
      } catch {
        // A malformed or concurrently replaced neighbor cannot hide
        // healthy sessions, or erase its own last readable history.
        continue;
      }
      if (
        !record ||
        typeof record.cwd !== "string" ||
        record.sessionId !== id
      ) {
        continue;
      }
      const project = this.getProjectByPath(record.cwd);
      if (!project) continue;
      if (stored.length === 0) continue;
      let folds: { turn: TurnEvent | undefined; usage: UsageEntry | undefined }[];
      try {
        folds = stored.map((entry) => ({
          turn: foldTurnEvent(entry.record),
          usage: foldUsage(id, entry.record),
        }));
      } catch {
        // A malformed event payload is isolated before replacing any
        // already served metadata or folds for this session.
        continue;
      }
      const players = [
        ...new Set(
          stored
            .filter((entry) => hasPresentationHeader(entry.record) &&
              (entry.record.type === "player_prompt" || entry.record.type === "player_event" || entry.record.type === "player_finished"))
            .map((entry) => (entry.record as { playerId?: unknown }).playerId)
            .filter((playerId): playerId is string => typeof playerId === "string"),
        ),
      ];
      const timestamps = stored.map((entry) => entry.record.timestamp).filter(Number.isFinite);
      const createdAt = timestamps[0] ?? (Date.parse(String(record.createdAt)) || 0);
      const endedAt = timestamps.at(-1) ?? (Date.parse(String(record.updatedAt)) || createdAt);
      const meta: SessionMeta = {
        id,
        projectId: project.id,
        createdAt,
        endedAt,
        // Liveness belongs to the core that runs a session; a session
        // another host wrote is never live here (core-service-10).
        live: false,
        players: players.map((playerId) => ({ id: playerId })) as SessionInfo["players"],
        initialVisible: players,
        // Read-only: this core writes none of another host's files
        // (core-service-65); a deletion reaches them here (DR-042).
        foreign: true,
        originDir: sessionsDir,
      };
      const previous = this.records.get(id) ?? [];
      const previousLines = previous.map((entry) => JSON.stringify(entry));
      const nextLines = stored.map((entry) => JSON.stringify(entry));
      const extendsPrefix = previousLines.every((line, index) => line === nextLines[index]);
      if (
        previousMeta &&
        extendsPrefix && previous.length === stored.length &&
        JSON.stringify(previousMeta) === JSON.stringify(meta)
      ) continue;
      this.sessions.set(id, meta);
      this.records.set(id, stored);
      // Re-fold replacement history from zero, so re-reading a CLI
      // session never counts its previous usage a second time.
      this.turns.delete(id);
      this.usage.delete(id);
      for (const fold of folds) this.applyRecordFold(id, fold.turn, fold.usage);
      changed.push({ id, appended: extendsPrefix ? stored.slice(previous.length) : [] });
    }
    return changed;
  }

  /**
   * Forget every foreign session whose record left the shared session
   * store while this core runs (core-service-76): the CLI's own
   * removal, or a deletion from elsewhere. Returns what was dropped,
   * with its project so the removal can be announced.
   */
  forgetVanishedForeignSessions(): { id: string; projectId: string }[] {
    const gone: { id: string; projectId: string }[] = [];
    for (const meta of [...this.sessions.values()]) {
      if (!meta.foreign || !meta.originDir) continue;
      if (existsSync(join(meta.originDir, `${meta.id}.json`))) continue;
      this.dropSession(meta.id);
      gone.push({ id: meta.id, projectId: meta.projectId });
    }
    return gone;
  }

  /**
   * The live holder of a foreign session's lease, if any (DR-042): the
   * CLI guards its writers with `.<id>.lock/owner.json` naming a pid
   * and host. A lease on another host can never be probed, so it
   * always counts as held; a lease on this host is held while its pid
   * is alive. No lease, or a dead pid on this host, holds nothing.
   */
  sessionLeaseHolder(id: string): SessionLeaseHolder | undefined {
    const meta = this.sessions.get(id);
    if (!meta?.foreign || !meta.originDir) return undefined;
    const owner = this.readLeaseOwner(join(meta.originDir, `.${id}.lock`));
    if (!owner || typeof owner.pid !== "number") return undefined;
    if (owner.hostname !== hostname() || processAlive(owner.pid)) {
      return { pid: owner.pid, hostname: owner.hostname };
    }
    return undefined;
  }

  private foldIntentAct(act: IntentAct): void {
    if (act.act === "queue") {
      this.intents.set(act.intent.id, { ...act.intent });
      return;
    }
    const intent = this.intents.get(act.id);
    if (!intent) return;
    switch (act.act) {
      case "edit":
        intent.text = act.text;
        break;
      case "move":
        intent.rank = act.rank;
        break;
      case "link":
        if (act.afterId === null) delete intent.afterId;
        else intent.afterId = act.afterId;
        break;
      case "dispatch":
        intent.dispatched = { sessionId: act.sessionId, turnId: act.turnId, at: act.at };
        break;
      case "close":
        intent.closedAt = act.at;
        intent.closedAs = act.as;
        break;
      case "remove":
        this.removedIntents.add(act.id);
        break;
    }
  }

  private foldRecord(sessionId: string, record: TmuxPlayRecord): void {
    this.applyRecordFold(sessionId, foldTurnEvent(record), foldUsage(sessionId, record));
  }

  private applyRecordFold(sessionId: string, turnEvent: TurnEvent | undefined, usage: UsageEntry | undefined): void {
    if (turnEvent) {
      if (turnEvent.kind === "start") {
        this.startTurnInMemory(sessionId, turnEvent.turnId, turnEvent.prompt, turnEvent.at);
      } else {
        this.endTurnInMemory(sessionId, turnEvent.turnId, turnEvent.status, turnEvent.at);
      }
    }
    if (usage) this.usageOf(sessionId).push(usage);
  }

  // -- legacy import (CORE-64) ----------------------------------------------

  private importLegacy(legacyDbPath: string | undefined): void {
    if (!legacyDbPath || !existsSync(legacyDbPath)) return;
    if (this.meta.importedLegacy?.includes(legacyDbPath)) return;
    try {
      this.runLegacyImport(legacyDbPath);
      this.meta.importedLegacy = [
        ...(this.meta.importedLegacy ?? []),
        legacyDbPath,
      ];
    } catch (error) {
      // An unreadable legacy store must not brick every startup: the
      // import stays unmarked (a repaired file imports on a later
      // start), the failure is reported, and serving proceeds. Every
      // write in the import is idempotent, so a retry re-clobbers
      // nothing.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `spex: legacy store ${legacyDbPath} could not be imported (${message}); ` +
          "continuing without it",
      );
    }
  }

  private runLegacyImport(legacyDbPath: string): void {
    // better-sqlite3's only remaining use: reading the store a
    // pre-DR-036 release left behind, which stays in place untouched.
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as new (
      path: string,
      options?: { readonly?: boolean },
    ) => {
      prepare(sql: string): { all(...args: unknown[]): Record<string, unknown>[] };
      close(): void;
    };
    const db = new Database(legacyDbPath, { readonly: true });
    try {
      const rows = (sql: string): Record<string, unknown>[] => {
        try {
          return db.prepare(sql).all();
        } catch {
          // A table an older release never created imports as empty.
          return [];
        }
      };
      const dir = this.dir as string;
      // The import merges into whatever the root already holds — a
      // second shell's legacy store must never clobber the first's
      // imported state or anything written since.
      const existingProjects =
        readJson<{ projects: ProjectInfo[] }>(join(dir, "projects.json"))
          ?.projects ?? [];
      const takenIds = new Set(existingProjects.map((project) => project.id));
      const takenPaths = new Set(existingProjects.map((project) => project.path));
      const mergedProjects = [...existingProjects];
      for (const row of rows("SELECT id, path, name, registered_at FROM projects")) {
        if (takenIds.has(row.id as string) || takenPaths.has(row.path as string)) {
          continue;
        }
        mergedProjects.push({
          id: row.id as string,
          path: row.path as string,
          name: row.name as string,
          registeredAt: row.registered_at as number,
        });
      }
      writeAtomic(
        join(dir, "projects.json"),
        JSON.stringify({ v: 1, projects: mergedProjects }),
      );
      const prefs: Record<string, unknown> = {};
      for (const row of rows("SELECT key, value_json FROM prefs")) {
        prefs[row.key as string] = JSON.parse(row.value_json as string);
      }
      // Existing preferences win over imported ones: they are newer.
      Object.assign(
        prefs,
        readJson<{ prefs: Record<string, unknown> }>(join(dir, "prefs.json"))
          ?.prefs ?? {},
      );
      writeAtomic(
        join(dir, "prefs.json"),
        JSON.stringify({ v: 1, prefs }),
      );
      for (const row of rows("SELECT * FROM intents ORDER BY created_at, id")) {
        const source: IntentSource | undefined =
          row.source_kind != null && row.source_ref != null
            ? {
                kind: row.source_kind as IntentSource["kind"],
                ref: row.source_ref as string,
                ...(row.source_url != null ? { url: row.source_url as string } : {}),
              }
            : undefined;
        const intent: IntentInfo = {
          id: row.id as string,
          projectId: row.project_id as string,
          text: row.text as string,
          ...(source ? { source } : {}),
          rank: row.rank as string,
          ...(row.after_id != null ? { afterId: row.after_id as string } : {}),
          createdAt: row.created_at as number,
          ...(row.dispatched_session_id != null && row.dispatched_turn_id != null
            ? {
                dispatched: {
                  sessionId: row.dispatched_session_id as string,
                  turnId: row.dispatched_turn_id as number,
                  at: row.dispatched_at as number,
                },
              }
            : {}),
          ...(row.closed_at != null ? { closedAt: row.closed_at as number } : {}),
          ...(row.closed_as != null
            ? { closedAs: row.closed_as as "done" | "dropped" }
            : {}),
        };
        this.appendIntentAct(intent.projectId, { act: "queue", intent });
      }
      for (const row of rows(
        "SELECT id, project_id, created_at, ended_at, players_json, initial_visible_json FROM sessions",
      )) {
        // A session the root already holds is never overwritten: the
        // file state is newer than any legacy copy of it.
        if (existsSync(this.sidecarFile(row.id as string))) continue;
        const meta: SessionMeta = {
          id: row.id as string,
          projectId: row.project_id as string,
          createdAt: row.created_at as number,
          endedAt: (row.ended_at as number | null) ?? null,
          // A session live when the legacy store last closed is not
          // live now (core-service-10).
          live: false,
          players: JSON.parse(row.players_json as string) as SessionInfo["players"],
          initialVisible: JSON.parse(row.initial_visible_json as string) as string[],
        };
        this.saveSidecar(meta);
        const lines: string[] = [];
        let recordRows: Record<string, unknown>[];
        try {
          recordRows = db
            .prepare("SELECT seq, payload_json, role FROM records WHERE session_id = ? ORDER BY seq")
            .all(meta.id);
        } catch {
          recordRows = db
            .prepare("SELECT seq, payload_json FROM records WHERE session_id = ? ORDER BY seq")
            .all(meta.id);
        }
        for (const rec of recordRows) {
          const stored: StoredRecord = {
            seq: rec.seq as number,
            // Legacy payloads carry resume tokens (results and
            // playbook.trace); the projection strips them on import.
            record: sanitizeRecord(
              JSON.parse(rec.payload_json as string) as TmuxPlayRecord,
            ),
            ...(rec.role != null ? { role: rec.role as string } : {}),
          };
          lines.push(JSON.stringify({ v: 1, ...stored }));
        }
        if (lines.length > 0) {
          writeAtomic(this.recordsFile(meta.id), `${lines.join("\n")}\n`);
        }
      }
    } finally {
      db.close();
    }
  }

  close(): void {
    this.releaseRootLease();
  }

  // -- projects -------------------------------------------------------------

  registerProject(path: string, name: string, at: number): ProjectInfo {
    const existing = this.getProjectByPath(path);
    if (existing) return existing;
    const project: ProjectInfo = { id: randomUUID(), path, name, registeredAt: at };
    this.projects.set(project.id, project);
    this.saveProjects();
    return project;
  }

  listProjects(): ProjectInfo[] {
    return [...this.projects.values()].sort((a, b) => a.registeredAt - b.registeredAt);
  }

  getProject(id: string): ProjectInfo | undefined {
    return this.projects.get(id);
  }

  getProjectByPath(path: string): ProjectInfo | undefined {
    return this.listProjects().find((project) => project.path === path);
  }

  removeProject(id: string): boolean {
    const removed = this.projects.delete(id);
    if (removed) this.saveProjects();
    return removed;
  }

  // -- sessions -------------------------------------------------------------

  createSession(session: SessionInfo): void {
    const meta: SessionMeta = {
      id: session.id,
      projectId: session.projectId,
      createdAt: session.createdAt,
      endedAt: session.endedAt,
      live: session.live,
      players: session.players,
      initialVisible: session.initialVisible,
    };
    this.sessions.set(meta.id, meta);
    this.saveSidecar(meta);
  }

  endSession(id: string, endedAt: number): void {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.live = false;
    meta.endedAt = endedAt;
    this.saveSidecar(meta);
  }

  /** A message continued the ended session (core-service-73): live
   * again on the same id, its end time cleared, its roster the lanes
   * now running. */
  reopenSession(id: string, players: SessionInfo["players"]): void {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.live = true;
    meta.endedAt = null;
    meta.players = players;
    this.saveSidecar(meta);
  }

  /** Persist the Captain's settled state (core-service-72). */
  setSnapshot(id: string, snapshot: CaptainSnapshot): void {
    const meta = this.sessions.get(id);
    if (!meta || meta.foreign) return;
    meta.snapshot = snapshot;
    this.saveSidecar(meta);
  }

  getSnapshot(id: string): CaptainSnapshot | undefined {
    return this.sessions.get(id)?.snapshot;
  }

  /**
   * Delete a stored session (core-service-70): its files and every
   * in-memory trace — records, turns, usage, and the viewed marker.
   * A session another host wrote loses its record and stream where
   * they were found and nothing else — never a lease directory; the
   * caller has checked the lease (core-service-75).
   */
  deleteSession(id: string): void {
    const meta = this.sessions.get(id);
    if (!meta) return;
    if (meta.foreign) {
      if (meta.originDir) {
        rmSync(join(meta.originDir, `${id}.json`), { force: true });
        rmSync(join(meta.originDir, `${id}.records.jsonl`), { force: true });
      }
    } else if (this.sessionsDir) {
      rmSync(this.sidecarFile(id), { force: true });
      rmSync(this.recordsFile(id), { force: true });
    }
    this.dropSession(id);
  }

  /** Every in-memory trace of a session, gone. */
  private dropSession(id: string): void {
    this.sessions.delete(id);
    this.records.delete(id);
    this.turns.delete(id);
    this.usage.delete(id);
    if (this.prefs.delete(`viewed:${id}`)) this.savePrefs();
  }

  /** Startup recovery (CORE-10): a session live at shutdown is no
   * longer live. Its snapshot stays, so it lists continuable
   * (DR-042). */
  markAllSessionsNotLive(): void {
    for (const meta of this.sessions.values()) {
      if (!meta.live) continue;
      meta.live = false;
      this.saveSidecar(meta);
    }
  }

  /** One session's listing row, carrying the same conversation
   * summary a listing carries (core-service-32) — what the broadcasts
   * that must stay truthful between listings send (core-service-34). */
  describeSession(id: string): SessionInfo | undefined {
    const meta = this.sessions.get(id);
    if (!meta) return undefined;
    const project = this.projects.get(meta.projectId);
    if (!project) return undefined;
    return this.summarize(meta, project.path);
  }

  private summarize(meta: SessionMeta, path: string): SessionInfo {
    const turns = [...(this.turns.get(meta.id)?.values() ?? [])].sort(
      (a, b) => a.turnId - b.turnId,
    );
    const failed = (this.records.get(meta.id) ?? []).some(
      (entry) => hasPresentationHeader(entry.record) && entry.record.type === "runtime_error",
    );
    const costed = (this.usage.get(meta.id) ?? []).filter(
      (entry) => entry.totalCostUsd !== undefined,
    );
    const cost =
      costed.length > 0
        ? costed.reduce((sum, entry) => sum + (entry.totalCostUsd ?? 0), 0)
        : undefined;
    return sessionInfo(meta, path, turns[0]?.prompt, turns.length, failed, cost);
  }

  listSessions(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const meta of [...this.sessions.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    )) {
      const project = this.projects.get(meta.projectId);
      // A session whose project left the registry stays on disk but
      // out of the listing (DR-036).
      if (!project) continue;
      out.push(this.summarize(meta, project.path));
    }
    return out;
  }

  // -- turns ----------------------------------------------------------------

  private turnsOf(sessionId: string): Map<number, TurnRow> {
    let map = this.turns.get(sessionId);
    if (!map) {
      map = new Map();
      this.turns.set(sessionId, map);
    }
    return map;
  }

  private startTurnInMemory(
    sessionId: string,
    turnId: number,
    prompt: string,
    at: number,
  ): void {
    this.turnsOf(sessionId).set(turnId, {
      turnId,
      prompt,
      startedAt: at,
      endedAt: null,
      status: null,
    });
  }

  private endTurnInMemory(
    sessionId: string,
    turnId: number,
    status: string,
    at: number,
  ): void {
    const turn = this.turnsOf(sessionId).get(turnId);
    if (!turn) return;
    turn.status = status;
    turn.endedAt = at;
  }

  startTurn(sessionId: string, turnId: number, prompt: string, at: number): void {
    this.startTurnInMemory(sessionId, turnId, prompt, at);
  }

  endTurn(sessionId: string, turnId: number, status: string, at: number): void {
    this.endTurnInMemory(sessionId, turnId, status, at);
  }

  /** Every turn a session held, in order — the ledger fold's turn
   * ranges and statuses come from here (DR-035). */
  listTurns(sessionId: string): TurnRow[] {
    return [...(this.turns.get(sessionId)?.values() ?? [])].sort(
      (a, b) => a.turnId - b.turnId,
    );
  }

  /** The highest turn id the session's stream holds — a continued
   * session's runtime numbers past it (core-service-74). */
  maxTurnId(sessionId: string): number {
    let max = 0;
    for (const turnId of this.turns.get(sessionId)?.keys() ?? []) {
      if (turnId > max) max = turnId;
    }
    return max;
  }

  /** Reviewer-role player calls inside a turn range — the review
   * rounds a finished intent reports (DR-035). An open upper bound
   * (`toTurnId` null) runs to the session's end. */
  countRolePrompts(
    sessionId: string,
    role: string,
    fromTurnId: number,
    toTurnId: number | null,
  ): number {
    let count = 0;
    for (const entry of this.records.get(sessionId) ?? []) {
      if (!hasPresentationHeader(entry.record)) continue;
      const turnId = entry.record.turnId;
      if (entry.role !== role || entry.record.type !== "player_prompt") continue;
      if (turnId === null || turnId < fromTurnId) continue;
      if (toTurnId !== null && turnId >= toTurnId) continue;
      count += 1;
    }
    return count;
  }

  /** Runtime-error records inside a turn range, oldest first — the
   * failure condition and its onset time (DR-035). */
  runtimeErrors(
    sessionId: string,
    fromTurnId: number,
    toTurnId: number | null,
  ): { turnId: number | null; timestamp: number }[] {
    const out: { turnId: number | null; timestamp: number }[] = [];
    for (const entry of this.records.get(sessionId) ?? []) {
      if (!hasPresentationHeader(entry.record)) continue;
      if (entry.record.type !== "runtime_error") continue;
      const turnId = entry.record.turnId;
      // A null-turn error belongs to no turn range, exactly as the
      // SQL `turn_id >= ?` excluded it — returning it for every
      // intent's range would flip ledger verdicts.
      if (turnId === null || turnId < fromTurnId) continue;
      if (toTurnId !== null && turnId >= toTurnId) continue;
      out.push({ turnId, timestamp: entry.record.timestamp });
    }
    return out;
  }

  // -- records --------------------------------------------------------------

  private recordsOf(sessionId: string): StoredRecord[] {
    let list = this.records.get(sessionId);
    if (!list) {
      list = [];
      this.records.set(sessionId, list);
    }
    return list;
  }

  private usageOf(sessionId: string): UsageEntry[] {
    let list = this.usage.get(sessionId);
    if (!list) {
      list = [];
      this.usage.set(sessionId, list);
    }
    return list;
  }

  /** `role` is the resolved role a player record's call served, kept
   * beside the record so a replay reads exactly as the live stream did
   * (DR-032). */
  appendRecord(
    sessionId: string,
    seq: number,
    record: TmuxPlayRecord,
    role?: string,
  ): void {
    const stored: StoredRecord = {
      seq,
      // The stream is a token-free replay projection (DR-036): resume
      // tokens never reach memory or disk through this door.
      record: sanitizeRecord(record),
      ...(role !== undefined ? { role } : {}),
    };
    this.recordsOf(sessionId).push(stored);
    const meta = this.sessions.get(sessionId);
    // Another host owns its own session's stream (core-service-65).
    if (!this.sessionsDir || meta?.foreign) return;
    // Once latched, the file stays a clean durable prefix: memory-only
    // records after the latch are served live but never claimed stored.
    if (meta?.streamIncompleteAfterSeq !== undefined) return;
    try {
      appendFileSync(
        this.recordsFile(sessionId),
        `${JSON.stringify({ v: 1, ...stored })}\n`,
      );
    } catch (error) {
      // Fail soft (DR-036): record I/O must not kill the turn, and
      // truncated history must not be presented as complete — latch
      // the incompleteness at the last durable sequence.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `spex: session ${sessionId} record stream write failed (${message}); ` +
          `stream is complete only up to seq ${seq - 1}`,
      );
      if (meta) {
        meta.streamIncompleteAfterSeq = seq - 1;
        try {
          this.saveSidecar(meta);
        } catch {
          // The latch still holds in memory; the sidecar write shares
          // whatever ails the disk.
        }
      }
    }
  }

  getRecords(
    sessionId: string,
    options: { afterSeq?: number; includeHidden?: boolean } = {},
  ): StoredRecord[] {
    const after = options.afterSeq ?? 0;
    return (this.records.get(sessionId) ?? []).filter(
      (entry) =>
        entry.seq > after && (options.includeHidden || !isHidden(entry.record)),
    );
  }

  maxSeq(sessionId: string): number {
    const list = this.records.get(sessionId);
    return list && list.length > 0 ? list[list.length - 1].seq : 0;
  }

  // -- usage ----------------------------------------------------------------

  addUsage(entry: UsageEntry): void {
    this.usageOf(entry.sessionId).push(entry);
  }

  usageByDay(): { day: string; totals: UsageTotals }[] {
    const byDay = new Map<string, UsageEntry[]>();
    for (const entries of this.usage.values()) {
      for (const entry of entries) {
        // UTC day bucketing, as the SQLite rollup bucketed it.
        const day = new Date(entry.at).toISOString().slice(0, 10);
        const list = byDay.get(day);
        if (list) list.push(entry);
        else byDay.set(day, [entry]);
      }
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 30)
      .map(([day, entries]) => ({ day, totals: usageTotals(entries) }));
  }

  sessionUsage(sessionId: string): UsageTotals {
    return usageTotals(this.usage.get(sessionId) ?? []);
  }

  // -- intents (DR-035, the act log of CORE-52) -----------------------------

  addIntent(intent: IntentInfo): void {
    this.intents.set(intent.id, { ...intent });
    this.appendIntentAct(intent.projectId, { act: "queue", intent });
  }

  getIntent(id: string): IntentInfo | undefined {
    const intent = this.removedIntents.has(id)
      ? undefined
      : this.intents.get(id);
    return intent ? { ...intent } : undefined;
  }

  /** The open intent holding a source artifact, if any (DR-035). */
  openIntentBySource(
    projectId: string,
    kind: IntentSourceKind,
    ref: string,
  ): IntentInfo | undefined {
    for (const intent of this.intents.values()) {
      if (
        intent.projectId === projectId &&
        intent.closedAt === undefined &&
        !this.removedIntents.has(intent.id) &&
        intent.source?.kind === kind &&
        intent.source.ref === ref
      ) {
        return { ...intent };
      }
    }
    return undefined;
  }

  /** Every open intent across projects, in project rank order. */
  listOpenIntents(): IntentInfo[] {
    return [...this.intents.values()]
      .filter(
        (intent) =>
          intent.closedAt === undefined && !this.removedIntents.has(intent.id),
      )
      .sort((a, b) =>
        a.projectId === b.projectId
          ? a.rank < b.rank
            ? -1
            : 1
          : a.projectId < b.projectId
            ? -1
            : 1,
      )
      .map((intent) => ({ ...intent }));
  }

  /** One History page: closed intents newest first (DR-035), those
   * `include` admits — the filter runs before paging, so an excluded
   * intent never shortens a page (DR-038). */
  listClosedIntents(
    projectId: string,
    limit: number,
    before?: { closedAt: number; intentId: string },
    include: (intent: IntentInfo) => boolean = () => true,
  ): IntentInfo[] {
    return [...this.intents.values()]
      .filter(
        (intent): intent is IntentInfo & { closedAt: number } =>
          intent.projectId === projectId &&
          intent.closedAt !== undefined &&
          !this.removedIntents.has(intent.id) &&
          include(intent),
      )
      .filter(
        (intent) =>
          !before ||
          intent.closedAt < before.closedAt ||
          (intent.closedAt === before.closedAt && intent.id < before.intentId),
      )
      .sort((a, b) =>
        a.closedAt === b.closedAt
          ? a.id < b.id
            ? 1
            : -1
          : b.closedAt - a.closedAt,
      )
      .slice(0, limit)
      .map((intent) => ({ ...intent }));
  }

  /** Every dispatch stamped into a session — open and closed intents
   * alike, because a closed dispatch still bounds its neighbours' turn
   * ranges (DR-035). */
  listSessionDispatches(
    sessionId: string,
  ): { intentId: string; turnId: number; open: boolean; closedAt?: number }[] {
    return [...this.intents.values()]
      .filter((intent) => intent.dispatched?.sessionId === sessionId)
      .sort(
        (a, b) =>
          (a.dispatched as { turnId: number }).turnId -
          (b.dispatched as { turnId: number }).turnId,
      )
      .map((intent) => ({
        intentId: intent.id,
        turnId: (intent.dispatched as { turnId: number }).turnId,
        open: intent.closedAt === undefined,
        ...(intent.closedAt !== undefined ? { closedAt: intent.closedAt } : {}),
      }));
  }

  setIntentText(id: string, text: string): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    intent.text = text;
    this.appendIntentAct(intent.projectId, { act: "edit", id, text });
  }

  setIntentRank(id: string, rank: string): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    intent.rank = rank;
    this.appendIntentAct(intent.projectId, { act: "move", id, rank });
  }

  setIntentLink(id: string, afterId: string | null): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    if (afterId === null) delete intent.afterId;
    else intent.afterId = afterId;
    this.appendIntentAct(intent.projectId, { act: "link", id, afterId });
  }

  /** The dispatch binding, stamped when the turn starts and re-written
   * by a later dispatch (DR-035). */
  stampIntentDispatch(
    id: string,
    sessionId: string,
    turnId: number,
    at: number,
  ): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    intent.dispatched = { sessionId, turnId, at };
    this.appendIntentAct(intent.projectId, { act: "dispatch", id, sessionId, turnId, at });
  }

  /** The remove act (core-service-79, DR-038): a closed intent retires
   * from every read — History, the queue, the source binding,
   * attention — while its acts stay in the append-only log and its
   * dispatch keeps bounding its neighbours' turn ranges, so no other
   * intent's derived state moves. */
  removeIntent(id: string, at: number): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    this.removedIntents.add(id);
    this.appendIntentAct(intent.projectId, { act: "remove", id, at });
  }

  closeIntent(id: string, as: "done" | "dropped", at: number): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    intent.closedAt = at;
    intent.closedAs = as;
    this.appendIntentAct(intent.projectId, { act: "close", id, as, at });
  }

  // -- prefs ----------------------------------------------------------------

  setPref(key: string, value: unknown): void {
    this.prefs.set(key, value);
    this.savePrefs();
  }

  getPref<T>(key: string): T | undefined {
    return this.prefs.has(key) ? (this.prefs.get(key) as T) : undefined;
  }

  // -- forge cache (dashboard-14) -------------------------------------------

  getForgeCache(projectId: string): { at: number; state: ForgeState } | undefined {
    return this.forgeCache.get(projectId);
  }

  setForgeCache(projectId: string, entry: { at: number; state: ForgeState }): void {
    this.forgeCache.set(projectId, entry);
    this.saveForgeCache();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM answers "alive but not ours"; only ESRCH proves death.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
