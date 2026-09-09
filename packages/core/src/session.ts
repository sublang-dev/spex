// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createTmuxPlayRuntime, type Captain, type PlayerAdapterImports } from "@sublang/cligent/tmux-play";
import { openSessionHost, discardSessionUncertain, type SessionHostController } from "@sublang/playbook/session-host";
import {
  assertCaptainSessionExecutionCompatible,
  projectCaptainSessionStructure,
  validateCaptainSessionExecutionProjection,
  type SessionExecutionProjection,
  type SessionStructuralProjection,
  type ReplayStreamEntry,
} from "@sublang/playbook/session-store";
import { resolveArtifacts } from "./artifacts.js";
import type { ComposedConfig, LoadModule } from "./config.js";
import type { ProjectInfo, SessionInfo, TmuxPlayRecord } from "./protocol.js";
import { Store } from "./store.js";

export class CoreError extends Error {
  constructor(readonly code: "not_found" | "busy" | "aborted" | "conflict" | "invalid_config" | "invalid_request" | "internal", message: string) {
    super(message);
    this.name = "CoreError";
  }
}

/** Deterministic record fixtures; production uses Playbook's Captain
 * shell. The session id lets a fixture keep state across the runtime
 * releases the turn-held lifecycle makes (core-service-91). */
export type CaptainFactory = (composed: ComposedConfig, sessionId: string) => Promise<Captain>;
export interface SessionManagerOptions {
  store: Store;
  loadModule?: LoadModule;
  adapterImports?: PlayerAdapterImports;
  captainFactory?: CaptainFactory;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}
export interface RecordEnvelope {
  sessionId: string;
  seq: number;
  record: TmuxPlayRecord;
  hidden: boolean;
  role?: string;
}
interface LiveSession {
  info: SessionInfo;
  controller: SessionHostController;
  runtime: SessionHostController["host"];
  seq: number;
  turnActive: boolean;
  pendingIntentId?: string;
  operation?: Promise<void>;
}

/** The members a stored structure names: its playbooks, and its
 * referenced players in stored order (core-service-92). */
interface StoredMembers { playbookIds: string[]; playerIds: string[] }

function storedMembers(structure: SessionStructuralProjection): StoredMembers {
  return {
    playbookIds: Object.keys(structure.catalog),
    playerIds: structure.players.map((player) => String((player as {id: unknown}).id)),
  };
}

/** A drift the projection itself cannot express — a stored member the
 * current config no longer holds (core-service-92). */
export class SettingsDriftError extends Error {
  constructor(readonly changes: string[]) {
    super(`Settings changed since this session started: ${changes.join("; ")}. Start a new session for the new settings, or change them back.`);
    this.name = "SettingsDriftError";
  }
}

/** Construct the shared execution projection from the validated desktop
 * config — the whole enabled catalog for a new session, or the current
 * config projected onto a stored session's members so an unrelated
 * playbook or player never invalidates it (core-service-92, DR-051). */
function executionConfig(composed: ComposedConfig, cwd: string, members?: StoredMembers): SessionExecutionProjection {
  const playbooks = members
    ? members.playbookIds.map((id) => composed.playbooks.find((playbook) => playbook.id === id))
    : composed.playbooks;
  const missingPlaybooks = members ? members.playbookIds.filter((id, index) => !playbooks[index]) : [];
  const playerIds = members ? members.playerIds : composed.players.map(({id}) => id);
  const missingPlayers = playerIds.filter((id) => !composed.captainOptions.sessionAgents.players[id]);
  if (missingPlaybooks.length || missingPlayers.length) {
    throw new SettingsDriftError([
      ...missingPlaybooks.map((id) => `playbook ${id} is no longer enabled`),
      ...missingPlayers.map((id) => `player ${id} is no longer bound by the session's playbooks`),
    ]);
  }
  return validateCaptainSessionExecutionProjection({
    schemaVersion: 2,
    captain: composed.captainOptions.sessionAgents.captain,
    players: playerIds.map((id) => ({ id, ...composed.captainOptions.sessionAgents.players[id] })),
    catalog: Object.fromEntries((playbooks as ComposedConfig["playbooks"]).map((playbook) => {
      const block = composed.captainOptions.playbooks[playbook.id];
      return [playbook.id, {
        id: playbook.id, from: isAbsolute(playbook.from) ? pathToFileURL(playbook.from).href : playbook.from,
        manifestCommand: playbook.manifestCommand,
        command: playbook.command, intent: playbook.intent,
        artifactSchema: playbook.artifactSchema,
        requiredRoleIds: playbook.requiredRoleIds,
        concurrentRoleSets: playbook.concurrentRoleSets,
        roles: block.roles,
        options: { ...block.options, ...(playbook.acceptsCwdOption ? {cwd} : {}) },
      }];
    })),
  });
}

/** Name every structural field whose change makes the current projection
 * incompatible with the stored one — Playbook's own refusal names none
 * (core-service-92). */
export function describeStructuralDrift(stored: SessionStructuralProjection, current: SessionStructuralProjection): string[] {
  const changes: string[] = [];
  const agentDrift = (who: string, before: Record<string, unknown>, after: Record<string, unknown>): void => {
    for (const field of ["adapter", "instruction", "permissions"]) {
      if (!isDeepStrictEqual(before[field], after[field])) changes.push(`${who}'s ${field} changed`);
    }
  };
  agentDrift("the Captain", stored.captain, current.captain);
  const currentPlayers = current.players.map((player) => player as Record<string, unknown>);
  stored.players.forEach((entry, index) => {
    const before = entry as Record<string, unknown>;
    const after = currentPlayers.find((player) => player.id === before.id);
    if (!after) changes.push(`player ${String(before.id)} is gone`);
    else {
      agentDrift(`player ${String(before.id)}`, before, after);
      if (currentPlayers[index]?.id !== before.id) changes.push(`player ${String(before.id)} changed its place in the roster`);
    }
  });
  for (const player of currentPlayers) {
    if (!stored.players.some((entry) => (entry as {id: unknown}).id === player.id)) changes.push(`player ${String(player.id)} joined the roster`);
  }
  for (const [id, before] of Object.entries(stored.catalog as Record<string, Record<string, unknown>>)) {
    const after = (current.catalog as Record<string, Record<string, unknown>>)[id];
    if (!after) { changes.push(`playbook ${id} is no longer enabled`); continue; }
    for (const field of ["from", "manifestCommand", "command", "intent", "artifactSchema", "requiredRoleIds", "concurrentRoleSets", "options"]) {
      if (!isDeepStrictEqual(before[field], after[field])) changes.push(`playbook ${id}'s ${field} changed`);
    }
    const beforeRoles = (before.roles ?? {}) as Record<string, {playerId?: unknown}>;
    const afterRoles = (after.roles ?? {}) as Record<string, {playerId?: unknown}>;
    for (const [role, binding] of Object.entries(beforeRoles)) {
      const now = afterRoles[role]?.playerId;
      if (now !== binding.playerId) changes.push(`playbook ${id}'s ${role} role now binds ${String(now ?? "no one")} instead of ${String(binding.playerId)}`);
    }
  }
  for (const id of Object.keys(current.catalog)) {
    if (!(id in stored.catalog)) changes.push(`playbook ${id} joined the session`);
  }
  return changes.length ? changes : ["the session's structure no longer matches its stored one"];
}

/** A project's current conversation (core-service-93, DR-051): its live
 * session, else the most recently active one that continues and no
 * other host owns. */
export function currentSession(sessions: SessionInfo[], projectId: string): SessionInfo | undefined {
  const own = sessions.filter((session) => session.projectId === projectId);
  return own.find((session) => session.live) ?? own
    .filter((session) => session.continuable && !session.externalWriter)
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))[0];
}

export class SessionManager {
  private readonly store: Store;
  private readonly loadModule: LoadModule;
  private readonly live = new Map<string, LiveSession>();
  // Settlement outlives the runtime: admission must also wait for the
  // released checkpoint's refreshed metadata and publication.
  private readonly settling = new Map<string, {projectId: string; done: Promise<void>}>();
  private readonly opening = new Set<string>();
  private readonly recovering = new Set<string>();
  private readonly now: () => number;
  onRecord: (envelope: RecordEnvelope) => void = () => {};
  onSessionState: (session: SessionInfo) => void = () => {};
  onLedgerChange: (projectId: string) => void = () => {};

  constructor(private readonly options: SessionManagerOptions) {
    this.store = options.store;
    this.loadModule = options.loadModule ?? ((specifier) => import(specifier));
    this.now = options.now ?? Date.now;
  }

  listSessions(): SessionInfo[] {
    return this.store.listSessions().map((session) => {
      const live = this.live.get(session.id);
      return {...session, ...(live ? {externalWriter:undefined} : {}), live: !!live || session.live, turnActive: live?.turnActive ?? (session.live ? session.turnActive ?? false : false)};
    });
  }
  /** One lane per project: its current conversation (core-service-93). */
  listLanes(): { sessionId: string; projectId: string; turnActive: boolean }[] {
    const sessions = this.listSessions();
    const lanes: { sessionId: string; projectId: string; turnActive: boolean }[] = [];
    for (const projectId of new Set(sessions.map((session) => session.projectId))) {
      const current = currentSession(sessions, projectId);
      if (current) lanes.push({sessionId: current.id, projectId, turnActive: current.turnActive ?? false});
    }
    return lanes;
  }
  getLive(sessionId: string): LiveSession | undefined { return this.live.get(sessionId); }
  /** Wait out a settling turn's release, so a caller sees the session
   * either held or released — never in between (core-service-91). */
  async settled(sessionId: string): Promise<void> {
    await this.settling.get(sessionId)?.done;
  }
  /** Wait out every release in flight across a project's sessions. */
  async projectSettled(projectId: string): Promise<void> {
    for (const entry of this.settling.values()) {
      if (entry.projectId === projectId) await entry.done;
    }
  }

  async createSession(project: ProjectInfo, composed: ComposedConfig): Promise<SessionInfo> {
    return this.open(project, composed, randomUUID(), "new");
  }
  async continueSession(project: ProjectInfo, composed: ComposedConfig, session: SessionInfo): Promise<SessionInfo> {
    return this.open(project, composed, session.id, "continue");
  }
  async retrySession(project: ProjectInfo, sessionId: string): Promise<void> {
    await this.open(project, undefined, sessionId, "retry");
    this.startTurn(this.requireLive(sessionId), undefined, true);
  }
  async discardSession(sessionId: string): Promise<{removed: boolean}> {
    if (this.live.has(sessionId) || this.recovering.has(sessionId)) throw new CoreError("busy", "the session is active");
    const info = this.store.describeSession(sessionId);
    if (!info) throw new CoreError("not_found", `no session ${sessionId}`);
    this.recovering.add(sessionId);
    try {
      const restored = await discardSessionUncertain(this.store.sessionStore(), sessionId);
      if (!restored) this.store.forgetSession(sessionId);
      else { await this.store.refreshSession(sessionId, false); this.publish(sessionId); }
      this.onLedgerChange(info.projectId);
      return {removed: !restored};
    } catch (error) { throw this.failure(error); }
    finally { this.recovering.delete(sessionId); }
  }

  private async open(project: ProjectInfo, composed: ComposedConfig | undefined, sessionId: string, mode: "new" | "continue" | "retry"): Promise<SessionInfo> {
    // One working turn per project (core-service-4, DR-051): only a
    // session whose runtime is held — a turn in flight or settling — or
    // one another host holds stands in the way, and it is named. A
    // sibling mid-release is waited out first.
    await this.projectSettled(project.id);
    const holder = this.store.listSessions().find((session) => session.projectId === project.id && (session.live || session.externalWriter));
    if (this.opening.has(project.id)) throw new CoreError("busy", `a session is starting in ${project.name} — wait a moment`);
    if (holder) {
      const name = holder.title ? `“${holder.title}”` : "a session";
      throw new CoreError("busy", holder.externalWriter
        ? `${name} is in use elsewhere in ${project.name}`
        : `${name} is still working in ${project.name} — wait for it to finish, or abort it`);
    }
    if (this.recovering.has(sessionId)) throw new CoreError("busy", "the session is recovering");
    this.opening.add(project.id);
    this.store.setLocalSession(sessionId, true);
    let entry: LiveSession | undefined;
    let controller: SessionHostController | undefined;
    try {
      // A continued session takes the current config projected onto its
      // stored members, and drift is named before the runtime opens —
      // never after the provider hints are consumed (core-service-92).
      const stored = composed && mode === "continue" ? await this.storedStructure(sessionId) : undefined;
      const members = stored ? storedMembers(stored) : undefined;
      const config = composed ? executionConfig(composed, project.path, members) : undefined;
      if (stored && config) {
        try { assertCaptainSessionExecutionCompatible(stored, config); }
        catch { throw new SettingsDriftError(describeStructuralDrift(stored, projectCaptainSessionStructure(config))); }
      }
      const memberPlaybooks = composed ? composed.playbooks.filter((playbook) => !members || members.playbookIds.includes(playbook.id)) : [];
      const graphs = composed ? await Promise.all(memberPlaybooks.map(async (playbook) => ({
        playbookId: playbook.id, graph: (await resolveArtifacts(playbook, this.options.env)).machine ?? null,
      }))) : undefined;
      const initialVisible = composed ? composed.initialVisible.filter((id) => !members || members.playerIds.includes(id)) : undefined;
      const fixture = composed && this.options.captainFactory ? await this.options.captainFactory(composed, sessionId) : undefined;
      controller = await openSessionHost({
        store: this.store.sessionStore(), sessionId, mode, cwd: project.path,
        ...(config ? {config} : {}), loadModule: this.loadModule,
        ...(graphs ? {graphs} : {}),
        ...(initialVisible ? {initialVisible} : {}),
        ...(this.options.adapterImports ? {adapterImports: this.options.adapterImports} : {}),
        // Tests may narrate records before the real shell turn. Only the
        // shell supplies the reply, journal and durable settlement.
        ...(fixture ? {createHostRuntime: async (input: Parameters<typeof createTmuxPlayRuntime>[0]) => {
          const shell = input.captain;
          return createTmuxPlayRuntime({...input, captain: {
            async init(session) { await shell.init?.(session); await fixture.init?.(session); },
            async handleBossTurn(turn,context) {
              await fixture.handleBossTurn(turn,{...context, emitReply: async () => {}});
              await shell.handleBossTurn(turn,context);
            },
            async prepareDispose() { await fixture.prepareDispose?.(); await shell.prepareDispose?.(); },
            async dispose() { await fixture.dispose?.(); await shell.dispose?.(); },
          }});
        }} : {}),
        onStoredRecord: async (record) => {
          this.record(sessionId, record, entry);
          const result = record.record.type === "captain_finished" ? record.record.result as {status?: string; error?: string; finalText?: string} : undefined;
          if (entry && result?.status === "error") await this.appendError(entry, `The Captain's turn failed: ${result.error ?? result.finalText ?? "unknown error"}`);
        },
        onCheckpoint: async () => {
          await this.store.refreshSession(sessionId, true);
          if (entry) this.publish(sessionId);
        },
      });
      await this.store.refreshSession(sessionId, true);
      const info = this.store.describeSession(sessionId);
      if (!info) throw new Error("shared session has no readable project history");
      entry = {info, controller, runtime: controller.host, seq: this.store.maxSeq(sessionId), turnActive: false};
      this.live.set(sessionId, entry);
      this.publish(sessionId);
      return {...info, live:true, turnActive:false};
    } catch (error) {
      if (controller) await controller.dispose();
      this.store.setLocalSession(sessionId, false);
      if (error instanceof SettingsDriftError) throw new CoreError("invalid_config", error.message);
      throw this.failure(error, mode === "new" ? "invalid_config" : "invalid_request");
    } finally { this.opening.delete(project.id); }
  }

  /** The stored structural projection of a schema-7 checkpoint, when it has one. */
  private async storedStructure(sessionId: string): Promise<SessionStructuralProjection | undefined> {
    try {
      const manifest = await this.store.sessionStore().readManifest(sessionId) as {schemaVersion?: unknown; structuralProjection?: SessionStructuralProjection};
      return manifest.schemaVersion === 7 ? manifest.structuralProjection : undefined;
    } catch { return undefined; }
  }

  /** The runtime is held only for a turn (core-service-91): once the
   * settled checkpoint can be continued from disk, release it — the
   * Playbook lease with it — keeping the provider hints settlement wrote. */
  private async releaseAtSettle(entry: LiveSession): Promise<void> {
    const id = entry.info.id;
    let recovery: {state?: string; unresolvedEffects?: readonly unknown[]} | undefined;
    try { recovery = await entry.controller.read(); } catch { recovery = undefined; }
    if (recovery?.state !== "settled" || (recovery.unresolvedEffects?.length ?? 0) > 0) return;
    try {
      await entry.controller.dispose();
      this.live.delete(id);
      this.store.setLocalSession(id, false);
    } catch (error) {
      console.error(`spex: runtime release failed; ownership retained: ${String(error)}`);
    }
  }

  private record(sessionId: string, entry: ReplayStreamEntry, live?: LiveSession): void {
    if (entry.seq <= this.store.maxSeq(sessionId)) return;
    const record = entry.record as unknown as TmuxPlayRecord;
    this.store.appendRecord(sessionId, entry.seq, record, entry.role);
    this.store.foldStoredRecord(sessionId, record);
    if (live) live.seq = entry.seq;
    if (record.type === "turn_started" && live?.pendingIntentId) {
      const turn = (record as {turn: {id: number}}).turn;
      this.store.stampIntentDispatch(live.pendingIntentId, sessionId, turn.id, record.timestamp);
      live.pendingIntentId = undefined;
    }
    this.onRecord({sessionId, seq: entry.seq, record, hidden: entry.record.visibility === "hidden", ...(entry.role ? {role:entry.role} : {})});
    if (live) {
      this.publish(sessionId);
      this.onLedgerChange(live.info.projectId);
    }
  }

  private async appendError(entry: LiveSession, message: string): Promise<void> {
    const afterSeq = this.store.maxSeq(entry.info.id);
    await entry.controller.lease.append({type:"runtime_error", turnId:null, timestamp:this.now(), message});
    const added = await entry.controller.lease.readStream({afterSeq});
    for (const item of added.entries) this.record(entry.info.id, item, entry);
  }

  submitTurn(sessionId: string, text: string, intentId?: string): void {
    const entry = this.requireLive(sessionId);
    if (entry.turnActive) throw new CoreError("busy", "a turn is already running in this session");
    if (this.store.describeSession(sessionId)?.recovery) throw new CoreError("invalid_request", "Recover the interrupted turn with Retry or Discard first");
    entry.pendingIntentId = intentId;
    this.startTurn(entry, text, false);
  }

  private startTurn(entry: LiveSession, text: string | undefined, retry: boolean): void {
    entry.turnActive = true;
    this.publish(entry.info.id);
    entry.operation = (async () => {
      let failed = false;
      try {
        if (retry) await entry.controller.retry();
        else await entry.controller.handleBossTurn(text!);
      } catch (error) {
        failed = true;
        try { await this.appendError(entry, error instanceof Error ? error.message : String(error)); }
        catch { /* The lifecycle retains incomplete evidence and ownership. */ }
      } finally {
        entry.turnActive = false;
        entry.pendingIntentId = undefined;
        // Register before cleanup starts, including the failed/aborted
        // path, and keep the barrier after cleanup removes the runtime.
        const done = Promise.resolve().then(async () => {
          if (failed) {
            try { await entry.controller.dispose(); this.live.delete(entry.info.id); this.store.setLocalSession(entry.info.id, false); }
            catch (error) { console.error(`spex: session cleanup failed; ownership retained: ${String(error)}`); }
          } else {
            await this.releaseAtSettle(entry);
          }
          await this.store.refreshSession(entry.info.id, this.live.has(entry.info.id));
          this.publish(entry.info.id);
          this.onLedgerChange(entry.info.projectId);
        });
        this.settling.set(entry.info.id, {projectId: entry.info.projectId, done});
        try { await done; }
        finally { this.settling.delete(entry.info.id); }
      }
    })().catch((error) => console.error(`spex: session state refresh failed: ${String(error)}`));
  }

  abortTurn(sessionId: string): boolean {
    const entry = this.requireLive(sessionId);
    if (!entry.turnActive) return false;
    entry.runtime.abortActiveTurn();
    return true;
  }
  async disposeSession(sessionId: string): Promise<void> {
    if (!this.live.has(sessionId) && this.settling.has(sessionId)) {
      await this.settled(sessionId);
      return;
    }
    const entry = this.requireLive(sessionId);
    if (entry.turnActive) entry.runtime.abortActiveTurn();
    await entry.operation;
    // The turn's own settlement may have released the runtime already.
    if (!this.live.has(sessionId)) return;
    await entry.controller.dispose();
    this.live.delete(sessionId);
    this.store.setLocalSession(sessionId, false);
    await this.store.refreshSession(sessionId, false);
    this.publish(sessionId);
    this.onLedgerChange(entry.info.projectId);
  }
  async disposeAll(): Promise<void> {
    const ids = new Set([...this.live.keys(), ...this.settling.keys()]);
    const results = await Promise.allSettled([...ids].map((id) => this.disposeSession(id)));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "session cleanup failed");
  }
  private publish(sessionId: string): void {
    const session = this.store.describeSession(sessionId);
    const entry = this.live.get(sessionId);
    if (session) this.onSessionState({...session, ...(entry ? {externalWriter:undefined} : {}), live:!!entry, turnActive:entry?.turnActive ?? false});
  }
  private requireLive(sessionId: string): LiveSession {
    const entry = this.live.get(sessionId);
    if (!entry) throw new CoreError("not_found", `no live session ${sessionId}`);
    return entry;
  }
  private failure(error: unknown, fallback: CoreError["code"] = "invalid_request"): CoreError {
    if (error instanceof CoreError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new CoreError(/lease|already active|already held|owned by/.test(message) ? "busy" : /structur|execution config|catalog.*(changed|mismatch)|players.*(changed|mismatch)/i.test(message) ? "invalid_config" : fallback, message);
  }
}
