// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from "node:crypto";
import { createTmuxPlayRuntime, type Captain, type PlayerAdapterImports } from "@sublang/cligent/tmux-play";
import { openSessionHost, discardSessionUncertain, type SessionHostController } from "@sublang/playbook/session-host";
import { validateCaptainSessionExecutionProjection, type SessionExecutionProjection, type ReplayStreamEntry } from "@sublang/playbook/session-store";
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

/** Deterministic record fixtures; production uses Playbook's Captain shell. */
export type CaptainFactory = (composed: ComposedConfig) => Promise<Captain>;
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

/** Construct the shared execution projection from the validated desktop config. */
function executionConfig(composed: ComposedConfig, cwd: string): SessionExecutionProjection {
  return validateCaptainSessionExecutionProjection({
    schemaVersion: 2,
    captain: composed.captainOptions.sessionAgents.captain,
    players: composed.players.map(({id}) => ({ id, ...composed.captainOptions.sessionAgents.players[id] })),
    catalog: Object.fromEntries(composed.playbooks.map((playbook) => {
      const block = composed.captainOptions.playbooks[playbook.id];
      return [playbook.id, {
        id: playbook.id, from: playbook.from,
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

export class SessionManager {
  private readonly store: Store;
  private readonly loadModule: LoadModule;
  private readonly live = new Map<string, LiveSession>();
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
      return {...session, live: !!live || session.live, turnActive: live?.turnActive ?? session.turnActive ?? false};
    });
  }
  listLanes(): { sessionId: string; projectId: string; turnActive: boolean }[] {
    return this.listSessions().filter((session) => session.live).map((session) => ({sessionId:session.id, projectId:session.projectId, turnActive:session.turnActive ?? false}));
  }
  getLive(sessionId: string): LiveSession | undefined { return this.live.get(sessionId); }

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
    if (this.opening.has(project.id) || this.store.listSessions().some((session) => session.projectId === project.id && (session.live || session.externalWriter)) || this.recovering.has(sessionId)) {
      throw new CoreError("busy", `end the active session in ${project.name} first`);
    }
    this.opening.add(project.id);
    let entry: LiveSession | undefined;
    let controller: SessionHostController | undefined;
    try {
      const config = composed ? executionConfig(composed, project.path) : undefined;
      const graphs = composed ? await Promise.all(composed.playbooks.map(async (playbook) => ({
        playbookId: playbook.id, graph: (await resolveArtifacts(playbook, this.options.env)).machine ?? null,
      }))) : undefined;
      const fixture = composed && this.options.captainFactory ? await this.options.captainFactory(composed) : undefined;
      controller = await openSessionHost({
        store: this.store.sessionStore(), sessionId, mode, cwd: project.path,
        ...(config ? {config} : {}), loadModule: this.loadModule,
        ...(graphs ? {graphs} : {}),
        ...(composed ? {initialVisible: composed.initialVisible} : {}),
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
      throw this.failure(error, mode === "new" ? "invalid_config" : "invalid_request");
    } finally { this.opening.delete(project.id); }
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
        if (failed) {
          try { await entry.controller.dispose(); this.live.delete(entry.info.id); }
          catch (error) { console.error(`spex: session cleanup failed; ownership retained: ${String(error)}`); }
        }
        await this.store.refreshSession(entry.info.id, this.live.has(entry.info.id));
        this.publish(entry.info.id);
        this.onLedgerChange(entry.info.projectId);
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
    const entry = this.requireLive(sessionId);
    if (entry.turnActive) entry.runtime.abortActiveTurn();
    await entry.operation;
    await entry.controller.dispose();
    this.live.delete(sessionId);
    await this.store.refreshSession(sessionId, false);
    this.publish(sessionId);
    this.onLedgerChange(entry.info.projectId);
  }
  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.live.keys()].map((id) => this.disposeSession(id)));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "session cleanup failed");
  }
  private publish(sessionId: string): void {
    const session = this.store.describeSession(sessionId);
    const entry = this.live.get(sessionId);
    if (session) this.onSessionState({...session, live:!!entry, turnActive:entry?.turnActive ?? false});
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
