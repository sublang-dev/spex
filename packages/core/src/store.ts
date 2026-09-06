// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Application files belong to Spex; session files and mutations belong
// to Playbook. These maps are rebuilt projections for UI and intent folds.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { createSessionStore, validateSessionContext, type SharedSessionStore, type SessionManifest } from "@sublang/playbook/session-store";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import {
  ApplicationRegistry, foldIntentActs, parseIntentLog, parsePrefs, parseRegistry,
  readJsonFile, StorageFormatError, validateIntentRelations, validateIntentDispatches,
  type IntentAct, type RebindProjectOptions, type StorageDiagnostic,
} from "./app-storage.js";
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
  externalWriter?: "active" | "unknown";
  players: SessionInfo["players"];
  initialVisible: string[];
  /** Set when an append failed: the file is a complete prefix only up
   * to this sequence; later records lived in memory only (DR-036). */
  streamIncompleteAfterSeq?: number;
  /** Legacy presentation label, never recovery authority. */
  foreign?: true;
  /** Shared directory used to detect removal by another host. */
  originDir?: string;
  continuable?: boolean;
  continuationReason?: string;
  recovery?: SessionInfo["recovery"];
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
    live: meta.live || meta.externalWriter === "active",
    endedAt: meta.externalWriter ? null : meta.endedAt,
    ...(meta.externalWriter ? {externalWriter: meta.externalWriter, turnActive: meta.externalWriter === "active" && !!meta.recovery} : {}),
    players: meta.players,
    initialVisible: meta.initialVisible,
    ...(title !== undefined ? { title } : {}),
    turns,
    failed,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(meta.streamIncompleteAfterSeq !== undefined
      ? { streamIncompleteAfterSeq: meta.streamIncompleteAfterSeq }
      : {}),
    ...(meta.foreign ? { foreign: true } : {}),
    ...(!meta.live && !meta.externalWriter && meta.continuable ? { continuable: true } : {}),
    ...(meta.externalWriter ? {continuationReason: meta.externalWriter === "active" ? "Session is active in another host" : "Session ownership cannot be verified"}
      : meta.continuationReason ? { continuationReason: meta.continuationReason } : {}),
    ...(meta.recovery && !meta.externalWriter ? { recovery: meta.recovery } : {}),
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


export class Store {
  private readonly dir?: string;
  private readonly sessionsDir?: string;
  private lockDir?: string;
  private leaseToken = "";

  private meta: StoreMeta = { version: META_VERSION };
  private readonly projects = new Map<string, ProjectInfo>();
  private application = new ApplicationRegistry();
  private readonly prefs = new Map<string, unknown>();
  private readonly forgeCache = new Map<string, { at: number; state: ForgeState }>();
  private readonly intents = new Map<string, IntentInfo>();
  /** Intents a remove act retired (DR-038): their acts stay in the
   * log, and every read passes them by. */
  private readonly removedIntents = new Set<string>();
  private shared?: SharedSessionStore;
  private temporarySessions?: string;
  private readonly sessionProblems = new Map<string, StorageDiagnostic>();
  private readonly untrackedSessions = new Set<string>();
  private readonly localSessions = new Set<string>();
  private readonly intentProblems = new Map<string, StorageDiagnostic>();
  private prefsProblem?: StorageDiagnostic;
  private cacheProblem?: StorageDiagnostic;
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
      this.meta = existsSync(this.metaFile()) ? readJsonFile(this.metaFile()) as StoreMeta : { version: 0 };
      if (!this.meta || typeof this.meta !== "object" || Array.isArray(this.meta) || ![0, META_VERSION].includes(this.meta.version) || Object.keys(this.meta).some((key) => !["version", "importedLegacy"].includes(key)) ||
          (this.meta.importedLegacy !== undefined && (!Array.isArray(this.meta.importedLegacy) || !this.meta.importedLegacy.every((value) => typeof value === "string")))) {
        throw new StorageFormatError(this.metaFile(), "unsupported migration metadata; original bytes preserved");
      }
      this.importLegacy(options.legacyDbPath);
      this.meta.version = META_VERSION;
      writeAtomic(this.metaFile(), JSON.stringify(this.meta));
      this.application = new ApplicationRegistry(this.dir, true);
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
    return join(this.dir ?? "", "intents", `${projectId}.jsonl`);
  }

  // Every file kind carries its version marker (core-service-15):
  // whole files as a `v` wrapper, JSONL files as a `v` on each line.
  private saveProjects(): void {
    this.application.save();
  }

  private refreshProjects(): void {
    this.projects.clear();
    for (const id of this.application.identities.keys()) {
      const project = this.application.project(id);
      if (project) this.projects.set(id, project);
    }
  }

  private savePrefs(): void {
    if (!this.dir || this.prefsProblem) return;
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
    this.cacheProblem = undefined;
  }

  private appendIntentAct(projectId: string, act: IntentAct): void {
    if (!this.dir) return;
    const file = this.intentsFile(projectId);
    if (existsSync(file)) {
      const contents = readFileSync(file, "utf8");
      if (contents && !contents.endsWith("\n")) throw new StorageFormatError(file, "incomplete final act; restore or remove the incomplete tail before writing");
    }
    parseIntentLog(`${JSON.stringify({ v: 1, ...act })}\n`, projectId, file);
    appendFileSync(
      file,
      `${JSON.stringify({ v: 1, ...act })}\n`,
    );
  }

  // -- load (the restart fold, CORE-10/52) ----------------------------------

  private load(): void {
    const dir = this.dir as string;
    this.refreshProjects();
    const prefsFile = join(dir, "prefs.json");
    try {
      for (const [key, value] of Object.entries(existsSync(prefsFile) ? parsePrefs(readJsonFile(prefsFile), prefsFile) : {})) this.prefs.set(key, value);
    } catch (error) {
      if (!(error instanceof StorageFormatError)) throw error;
      this.prefsProblem = {file:error.file, reason:error.reason, blocking:true};
    }
    const cacheFile = join(dir, "forge-cache.json");
    try {
      for (const [projectId, entry] of Object.entries(
        readJson<{ entries: Record<string, { at: number; state: ForgeState }> }>(cacheFile)?.entries ?? {},
      )) this.forgeCache.set(projectId, entry);
    } catch (error) {
      this.cacheProblem = {file:cacheFile, reason:`Unreadable cache; refresh to rebuild: ${String(error)}`, blocking:false};
    }
    for (const file of readdirSync(join(dir, "intents"))) {
      if (!file.endsWith(".jsonl")) continue;
      const filename = join(dir, "intents", file);
      const projectId = file.slice(0, -6);
      try {
        const folded = foldIntentActs(parseIntentLog(readFileSync(filename, "utf8"), projectId, filename), filename);
        for (const [id, intent] of folded.intents) {
          const prior = this.intents.get(id);
          if (prior) {
            this.intentProblems.set(prior.projectId, {file:this.intentsFile(prior.projectId), reason:`duplicate queue ${id}`, blocking:true});
            throw new StorageFormatError(filename, `duplicate queue ${id}`);
          }
        }
        for (const [id, intent] of folded.intents) this.intents.set(id, intent);
        for (const id of folded.removed) this.removedIntents.add(id);
      } catch (error) {
        if (!(error instanceof StorageFormatError)) throw error;
        this.intentProblems.set(projectId, {file:error.file, reason:error.reason, blocking:true});
      }
    }
    const sessionsDir = this.sessionsDir as string;
    for (const file of readdirSync(sessionsDir)) {
      if (!file.endsWith(".spex.json")) continue;
      let meta: SessionMeta | undefined;
      try { meta = readJson<SessionMeta>(join(sessionsDir, file)); }
      catch { continue; } // Shared migration reports and preserves this sidecar.
      if (!meta || typeof meta !== "object" || Array.isArray(meta) || meta.id !== file.slice(0, -".spex.json".length) ||
          typeof meta.projectId !== "string" || !Array.isArray(meta.players) || !Array.isArray(meta.initialVisible)) continue;
      this.sessions.set(meta.id, meta);
      const { records: stored, incompleteAfterSeq } = readRecordsPrefix(this.recordsFile(meta.id), true);
      if (incompleteAfterSeq !== undefined) {
        meta.streamIncompleteAfterSeq = Math.min(meta.streamIncompleteAfterSeq ?? incompleteAfterSeq, incompleteAfterSeq);
        // Keep the raw damaged stream for inspection. The existing
        // continuation gate refuses it instead of appending onto damage.
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
  sessionStore(sessionsDir = this.shared?.sessionsDir ?? this.sessionsDir): SharedSessionStore {
    sessionsDir ??= this.temporarySessions ??= mkdtempSync(join(tmpdir(), "spex-memory-sessions-"));
    if (!this.shared || this.shared.sessionsDir !== sessionsDir) {
      this.shared = createSessionStore({ sessionsDir });
    }
    return this.shared;
  }

  async initializeSessions(sessionsDir = this.sessionsDir): Promise<void> {
    if (!sessionsDir) return;
    const shared = this.sessionStore(sessionsDir);
    await shared.prepare();
    for (const filename of readdirSync(sessionsDir)) {
      const sidecar = filename.endsWith(".spex.json");
      if (!sidecar && !/^[0-9a-f-]{36}\.json$/.test(filename)) continue;
      const id = filename.slice(0, -(sidecar ? ".spex.json" : ".json").length);
      const sourcePath = join(sessionsDir, filename);
      try {
        const source = readJson<Record<string, unknown>>(sourcePath);
        if (!source || (!sidecar && source.schemaVersion === 7)) continue;
        const cwd = sidecar && typeof source.projectId === "string"
          ? this.getProject(source.projectId)?.path : undefined;
        await shared.migrate(id, { sourcePath, ...(cwd ? { cwd } : {}) });
      } catch (error) {
        this.untrackedSessions.add(id);
        this.sessionProblems.set(id, {file:sourcePath, reason:String(error), blocking:false});
      }
    }
    await this.adoptForeignSessions(sessionsDir);
  }

  async adoptForeignSessions(sessionsDir: string): Promise<{ id: string; appended: StoredRecord[]; replaced?: boolean; unlistedProjectId?: string }[]> {
    if (!existsSync(sessionsDir)) return [];
    const shared = this.sessionStore(sessionsDir);
    const changed: { id: string; appended: StoredRecord[]; replaced?: boolean; unlistedProjectId?: string }[] = [];
    for (const filename of readdirSync(sessionsDir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(filename)) continue;
      const id = filename.slice(0, -5);
      if (this.localSessions.has(id) || this.sessions.get(id)?.live) continue;
      const update = await this.refreshSession(id, false);
      if (update) changed.push(update);
    }
    return changed;
  }

  async refreshSession(id: string, live?: boolean): Promise<{ id: string; appended: StoredRecord[]; replaced?: boolean; unlistedProjectId?: string } | undefined> {
    if (live === false && this.localSessions.has(id)) return;
    const shared = this.sessionStore();
    let manifest: SessionManifest;
    let stored: StoredRecord[];
    let continuable = false;
    let reason: string | undefined;
    let incompleteAfterSeq: number | undefined;
    let problem: StorageDiagnostic | undefined;
    try {
      const checked = await shared.validate(id);
      if (live === false && this.localSessions.has(id)) return;
      manifest = checked.manifest as SessionManifest;
      if (manifest.schemaVersion === 7 && !checked.integrityValid) problem = {file:join(shared.sessionsDir, `${id}.json`), reason:checked.reasons.join("; ") || "session checkpoint and replay disagree", blocking:true};
      stored = checked.history.entries.map(({ v: _v, ...entry }) => entry as unknown as StoredRecord);
      continuable = manifest.schemaVersion === 7 && checked.resumable && manifest.state === "settled" && manifest.unresolvedEffects.length === 0;
      reason = checked.reasons.join("; ") || (manifest.state === "uncertain" ? "Recover the interrupted turn with Retry or Discard" : manifest.schemaVersion === 7 && manifest.state === "settled" && manifest.unresolvedEffects.length ? "Reconcile unresolved effects before continuation" : undefined);
      if (checked.history.incomplete || checked.history.pendingTail || (manifest.schemaVersion === 7 && manifest.replay.incomplete)) {
        incompleteAfterSeq = Math.min(checked.history.lastReadableSeq, manifest.schemaVersion === 7 ? manifest.replay.seq : checked.history.lastReadableSeq);
      }
    } catch (error) {
      if (live === false && this.localSessions.has(id)) return;
      reason = error instanceof Error ? error.message : String(error);
      this.untrackedSessions.add(id);
      problem = {file:join(shared.sessionsDir, `${id}.json`), reason, blocking: !/unsupported.*version|version.*unsupported/i.test(reason)};
      this.sessionProblems.set(id, problem);
      // Unknown versions remain opaque and readable; these fields only
      // associate history, never authorize recovery or rewrite the file.
      let raw: Record<string, unknown> | undefined;
      try { raw = readJson<Record<string, unknown>>(join(shared.sessionsDir, `${id}.json`)); } catch { return; }
      if (!raw || raw.sessionId !== id || typeof raw.cwd !== "string") return;
      manifest = raw as unknown as SessionManifest;
      try {
        const history = await shared.readHistory(id);
        stored = history.entries.map(({ v: _v, ...entry }) => entry as unknown as StoredRecord);
        if (history.incomplete) incompleteAfterSeq = history.lastReadableSeq;
      } catch { return; }
    }
    if (live === false && this.localSessions.has(id)) return;
    if (manifest.schemaVersion === 7 && !problem) this.untrackedSessions.delete(id);
    if (typeof manifest.cwd !== "string") {
      this.sessionProblems.set(id, {file:join(shared.sessionsDir, `${id}.json`),reason:"session working directory is missing or invalid",blocking:manifest.schemaVersion === 7});
      return;
    }
    const project = this.getProjectByPath(manifest.cwd);
    if (!project) {
      this.sessionProblems.set(id, problem ?? {file:join(shared.sessionsDir, `${id}.json`), reason:`No project binding for ${manifest.cwd}`, blocking:false});
      const prior = this.sessions.get(id);
      if (prior) {
        this.sessions.delete(id);
        this.records.delete(id);
        this.turns.delete(id);
        this.usage.delete(id);
        return { id, appended: [], unlistedProjectId: prior.projectId };
      }
      return;
    }
    let players: SessionInfo["players"] = [];
    let initialVisible: string[] = [];
    let hasContext = false;
    for (const entry of stored) {
      if ((entry.record as {type?: unknown}).type !== "session_context") continue;
      try {
        const context = validateSessionContext(entry.record);
        hasContext = true;
        players = context.configuration.players.map((player) => ({
          id: player.id as string, adapter: player.adapter as SessionInfo["players"][number]["adapter"],
          ...(player.model?.kind === "value" ? { model: player.model.value as string } : {}),
          ...(typeof player.fastMode === "boolean" ? { fastMode: player.fastMode } : {}),
        }));
        initialVisible = [...context.initialVisible];
      } catch { /* Unsupported context does not invalidate other history. */ }
    }
    if (!hasContext) {
      const ids = new Set(stored.filter(({record}) => hasPresentationHeader(record) && ["player_prompt", "player_event", "player_finished"].includes(record.type)).map(({record}) => (record as {playerId?: unknown}).playerId).filter((value): value is string => typeof value === "string"));
      players = [...ids].map((id) => ({ id })) as SessionInfo["players"];
      initialVisible = [...ids];
    }
    const prior = this.sessions.get(id);
    const writer = live ? "idle" : await shared.readLeaseState(id);
    if (live === false && this.localSessions.has(id)) return;
    const meta: SessionMeta = {
      id, projectId: project.id,
      createdAt: Date.parse(manifest.createdAt) || stored.find(({record}) => hasPresentationHeader(record))?.record.timestamp || 0,
      endedAt: live ? null : Date.parse(manifest.updatedAt) || stored.reduce((last, entry) => Math.max(last, Number(entry.record.timestamp) || 0), 0),
      live: live ?? prior?.live ?? false,
      ...(writer !== "idle" ? {externalWriter: writer} : {}),
      players, initialVisible, originDir: shared.sessionsDir,
      ...(continuable ? { continuable: true } : {}),
      ...(reason ? { continuationReason: reason } : {}),
      ...(manifest.state === "uncertain" && manifest.uncertain
        ? { recovery: {state: "uncertain", input: manifest.uncertain.input} as const } : {}),
      ...(incompleteAfterSeq !== undefined ? { streamIncompleteAfterSeq: incompleteAfterSeq } : {}),
    };
    if (problem) this.sessionProblems.set(id, problem);
    else this.sessionProblems.delete(id);
    const previous = this.records.get(id) ?? [];
    const prefix = previous.every((entry,index) => isDeepStrictEqual(entry, stored[index]));
    if (prefix && previous.length === stored.length && JSON.stringify(prior) === JSON.stringify(meta)) return;
    if (!prefix && this.prefs.delete(`viewed:${id}`)) this.savePrefs();
    this.sessions.set(id, meta);
    this.records.set(id, stored);
    this.turns.delete(id);
    this.usage.delete(id);
    for (const entry of stored) this.foldRecord(id, entry.record);
    return { id, appended: prefix ? stored.slice(previous.length) : [], ...(!prefix && prior ? {replaced:true} : {}) };
  }

  sessionDiagnostics(): { file: string; reason: string; blocking: boolean }[] {
    return [...this.sessionProblems.values()];
  }

  untrackedSessionPaths(): string[] {
    if (!this.dir || !this.shared) return [];
    const directory = relative(this.dir, this.shared.sessionsDir);
    if (directory.startsWith("..") || isAbsolute(directory)) return [];
    return [...this.untrackedSessions].flatMap((id) => [join(directory, `${id}.json`), join(directory, `${id}.records.jsonl`)]);
  }

  /** Reserve local admission before any asynchronous host/scan work. */
  setLocalSession(id: string, owned: boolean): void {
    if (owned) this.localSessions.add(id); else this.localSessions.delete(id);
  }

  assertProjectsWritable(): void { this.application.assertWritable(); }

  assertWritable(scope: {projectId: string; sessionId?: never} | {projectId?: never; sessionId: string}): void {
    this.assertProjectsWritable();
    const sessionProblem = scope.sessionId ? this.sessionProblems.get(scope.sessionId) : undefined;
    if (sessionProblem?.blocking) throw new StorageFormatError(sessionProblem.file, sessionProblem.reason);
    const projectId = scope.projectId ?? (scope.sessionId ? this.sessions.get(scope.sessionId)?.projectId : undefined);
    const problem = projectId ? this.projectProblems().get(projectId) : undefined;
    if (problem) throw new StorageFormatError(problem.file, problem.reason);
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
      if (meta.live || !meta.originDir) continue;
      if (existsSync(join(meta.originDir, `${meta.id}.json`))) continue;
      this.dropSession(meta.id);
      gone.push({ id: meta.id, projectId: meta.projectId });
    }
    return gone;
  }

  foldStoredRecord(sessionId: string, record: TmuxPlayRecord): void { this.foldRecord(sessionId, record); }

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
      const current = readJson<{ v: number; projects: ProjectInfo[] }>(join(dir, "projects.json"));
      const portable = current?.v === 2 ? new ApplicationRegistry(dir) : undefined;
      if (current && current.v !== 1 && current.v !== 2) throw new StorageFormatError("projects.json", "unsupported registry version");
      const existingProjects = portable ? [...portable.identities.keys()].map((id) => portable.project(id)).filter((project): project is ProjectInfo => project !== undefined) : current?.projects ?? [];
      const takenIds = new Set(portable ? portable.identities.keys() : existingProjects.map((project) => project.id));
      const takenPaths = new Set(existingProjects.map((project) => project.path));
      const mergedProjects = [...existingProjects];
      for (const row of rows("SELECT id, path, name, registered_at FROM projects")) {
        if (takenIds.has(row.id as string) || takenPaths.has(row.path as string)) {
          continue;
        }
        const imported = { id: row.id as string, path: row.path as string, name: row.name as string, registeredAt: row.registered_at as number };
        if (portable) portable.bind({ id: imported.id, name: imported.name, registeredAt: imported.registeredAt }, imported.path);
        else mergedProjects.push(imported);
        takenIds.add(imported.id); takenPaths.add(imported.path);
      }
      if (!portable) writeAtomic(
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
        const existingLog = this.intentsFile(intent.projectId);
        const alreadyQueued = existsSync(existingLog) && parseIntentLog(readFileSync(existingLog, "utf8"), intent.projectId, existingLog).some((act) => act.act === "queue" && act.intent.id === intent.id);
        if (!alreadyQueued) this.appendIntentAct(intent.projectId, { act: "queue", intent });
      }
      for (const row of rows(
        "SELECT id, project_id, created_at, ended_at, players_json, initial_visible_json FROM sessions",
      )) {
        // A session the root already holds is never overwritten: the
        // file state is newer than any legacy copy of it.
        if (existsSync(this.sidecarFile(row.id as string)) || existsSync(join(this.sessionsDir!, `${row.id}.json`))) continue;
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
        writeAtomic(this.recordsFile(meta.id), lines.length ? `${lines.join("\n")}\n` : "");
        // Stage legacy metadata for Playbook's conversion, publishing it
        // after the complete replay so interrupted imports can retry.
        writeAtomic(this.sidecarFile(meta.id), JSON.stringify({v:1, ...meta}));
      }
    } finally {
      db.close();
    }
  }

  close(): void {
    if (this.temporarySessions) rmSync(this.temporarySessions, {recursive: true, force:true});
    this.releaseRootLease();
  }

  // -- projects -------------------------------------------------------------

  registerProject(path: string, name: string, at: number): ProjectInfo {
    const project = this.application.register(path, name, at);
    this.refreshProjects();
    return project;
  }

  rebindProject(options: RebindProjectOptions): ProjectInfo {
    let identity = this.application.identities.get(options.id);
    if (options.revision !== undefined) {
      if (!this.dir) throw new Error("restoring a project requires a disk store");
      const revision = execFileSync("git", ["-C", this.dir, "rev-parse", "--verify", `${options.revision}^{commit}`], { encoding: "utf8" }).trim();
      const ancestor = execFileSync("git", ["-C", this.dir, "merge-base", revision, "HEAD"], { encoding: "utf8" }).trim();
      if (ancestor !== revision) throw new Error("project restoration requires an ancestor of the current branch");
      const bytes = execFileSync("git", ["-C", this.dir, "show", `${revision}:projects.json`], { encoding: "utf8" });
      identity = parseRegistry(JSON.parse(bytes)).find((project) => project.id === options.id);
    }
    if (!identity) throw new Error(`project ${options.id} is absent; select its registry revision to restore it`);
    const project = this.application.bind(identity, options.path, options.aliases);
    this.refreshProjects();
    return project;
  }

  storageDiagnostics(): StorageDiagnostic[] {
    const reports = [...this.application.diagnostics(), ...this.projectProblems().values(), ...(this.prefsProblem ? [this.prefsProblem] : []), ...(this.cacheProblem ? [this.cacheProblem] : [])];
    const absent = new Set([...this.intents.values()].filter((intent) => !this.application.identities.has(intent.projectId)).map((intent) => intent.projectId));
    for (const id of absent) reports.push({ file: `intents/${id}.jsonl`, reason: `unregistered project ${id}`, blocking: false });
    return reports;
  }

  private projectProblems(intents = this.intents, removed = this.removedIntents): Map<string, StorageDiagnostic> {
    const problems = new Map(this.intentProblems);
    const sessions = new Map([...this.sessions.values()].map((session) => [session.id, {
      projectId: session.projectId, turns: new Set(this.turns.get(session.id)?.keys() ?? []),
    }]));
    for (const projectId of new Set([...intents.values()].map((intent) => intent.projectId))) {
      try {
        validateIntentRelations(intents, removed, this.intentsFile(projectId), projectId);
        validateIntentDispatches(intents, sessions, projectId);
      } catch (error) {
        if (!(error instanceof StorageFormatError)) throw error;
        problems.set(projectId, {file:error.file, reason:error.reason, blocking:true});
      }
    }
    // A queue cannot trust a predecessor whose own project's log is invalid.
    let changed = true;
    while (changed) {
      changed = false;
      for (const intent of intents.values()) {
        const predecessor = intent.afterId ? intents.get(intent.afterId) : undefined;
        const problem = predecessor ? problems.get(predecessor.projectId) : undefined;
        if (!removed.has(intent.id) && intent.closedAt === undefined && problem && !problems.has(intent.projectId)) {
          problems.set(intent.projectId, {file:this.intentsFile(intent.projectId), reason:`depends on invalid ${problem.file}: ${problem.reason}`, blocking:true});
          changed = true;
        }
      }
    }
    return problems;
  }

  validateStorage(): StorageDiagnostic[] { return this.storageDiagnostics(); }

  listProjects(): ProjectInfo[] {
    return [...this.projects.values()].sort((a, b) => a.registeredAt - b.registeredAt);
  }

  getProject(id: string): ProjectInfo | undefined { return this.projects.get(id); }

  getProjectByPath(path: string): ProjectInfo | undefined { return this.application.resolvePath(path); }

  removeProject(id: string): boolean {
    const removed = this.application.remove(id);
    if (removed) this.refreshProjects();
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

  }

  endSession(id: string, endedAt: number): void {
    const meta = this.sessions.get(id);
    if (!meta) return;
    meta.live = false;
    meta.endedAt = endedAt;

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

  }

  /** Shared lease and manifest-last deletion, followed by index cleanup. */
  async deleteSession(id: string): Promise<void> {
    if (this.sessions.get(id)?.live) throw new Error("end the session before deleting it");
    if (this.shared || this.sessionsDir) await this.sessionStore().delete(id);
    this.dropSession(id);
  }

  forgetSession(id: string): void { this.dropSession(id); }

  /** Every in-memory trace of a session, gone. */
  private dropSession(id: string): void {
    this.sessions.delete(id);
    this.sessionProblems.delete(id);
    this.untrackedSessions.delete(id);
    this.records.delete(id);
    this.turns.delete(id);
    this.usage.delete(id);
    if (this.prefs.delete(`viewed:${id}`)) this.savePrefs();
  }

  /** Local runtime liveness is never restored from stored history. */
  markAllSessionsNotLive(): void {
    for (const meta of this.sessions.values()) {
      if (!meta.live) continue;
      meta.live = false;
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

  private commitIntentAct(projectId: string, act: IntentAct): void {
    this.assertWritable({projectId});
    const next = new Map([...this.intents].map(([id, intent]) => [id, structuredClone(intent)]));
    const removed = new Set(this.removedIntents);
    foldIntentActs([act], `intents/${projectId}.jsonl`, next, removed);
    const problem = this.projectProblems(next, removed).get(projectId);
    if (problem) throw new StorageFormatError(problem.file, problem.reason);
    this.appendIntentAct(projectId, act);
    this.intents.clear(); for (const [id, intent] of next) this.intents.set(id, intent);
    this.removedIntents.clear(); for (const id of removed) this.removedIntents.add(id);
  }

  addIntent(intent: IntentInfo): void {
    this.commitIntentAct(intent.projectId, { act: "queue", intent });
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
          intent.closedAt === undefined && !this.removedIntents.has(intent.id) && this.projects.has(intent.projectId),
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
    this.commitIntentAct(intent.projectId, { act: "edit", id, text });
  }

  setIntentRank(id: string, rank: string): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    this.commitIntentAct(intent.projectId, { act: "move", id, rank });
  }

  setIntentLink(id: string, afterId: string | null): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    this.commitIntentAct(intent.projectId, { act: "link", id, afterId });
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
    this.commitIntentAct(intent.projectId, { act: "dispatch", id, sessionId, turnId, at });
  }

  /** The remove act (core-service-79, DR-038): a closed intent retires
   * from every read — History, the queue, the source binding,
   * attention — while its acts stay in the append-only log and its
   * dispatch keeps bounding its neighbours' turn ranges, so no other
   * intent's derived state moves. */
  removeIntent(id: string, at: number): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    this.commitIntentAct(intent.projectId, { act: "remove", id, at });
  }

  closeIntent(id: string, as: "done" | "dropped", at: number): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    this.commitIntentAct(intent.projectId, { act: "close", id, as, at });
  }

  // -- prefs ----------------------------------------------------------------

  setPref(key: string, value: unknown): void {
    if (this.prefsProblem) throw new StorageFormatError(this.prefsProblem.file, this.prefsProblem.reason);
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
