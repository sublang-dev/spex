// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The core service: config lifecycle (load/seed/watch, CORE-2/3),
// WebSocket endpoint with hello/version handshake (CORE-1) — a
// loopback socket by default, or attached to a shell-supplied HTTP
// server (DR-033) — command dispatch with schema validation
// (CORE-13), and record channels filtered by visibility at this
// boundary (CORE-8/14).

import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";

import {
  checkAdapterReadiness,
  checkAdapterRuntime,
  createModuleLoader,
  loadConfig,
  relocateLegacyConfig,
  resolveConfigPath,
  resolveLegacyConfigPath,
  resolveSessionsDir,
  seedConfig,
  summarizeConfig,
  type ComposedConfig,
  type AdapterRuntimeCheck,
  type LoadModule,
} from "./config.js";
import {
  parseCommand,
  PROTOCOL_VERSION,
  type AdapterName,
  type Channel,
  type Command,
  type ConfigState,
  type ErrorCode,
  type ReadinessEntry,
  type ServerMessage,
} from "./protocol.js";
import { CoreError, SessionManager, type CaptainFactory, type RecordEnvelope } from "./session.js";
import { closedStats, foldLedger, intentTitle, wasWorked } from "./ledger.js";
import { rankBetween } from "./rank.js";
import { Store } from "./store.js";
import { StorageFormatError } from "./app-storage.js";
import { prepareStorageGitFiles } from "./storage-git.js";
import {
  GitHubForgeAdapter,
  createProjectRepo,
  seedExampleProject,
  defaultRunCommand,
  isWorkTreeRoot,
  repoStatus,
  type ForgeAdapter,
  type RunCommand,
} from "./forge.js";
import {
  editConfigFile,
  rewriteLibraryPaths,
  type AgentBlock,
  type ConfigEditOp,
} from "./config-edit.js";
import { migrateManagedLibraryConfig } from "./config-migrate.js";
import { resolveArtifacts } from "./artifacts.js";
import { loadBuiltinCatalog } from "./builtins.js";
import {
  parseSpecTree,
  readSpecFile,
  resolveSpecPath,
  writeSpecFile,
} from "./specs.js";
import { checkToolchain, compilePlaybook, type LineSpawner } from "./compile.js";
import { readAgentOptions, type AgentModelDiscovery } from "./agent-options.js";
import { isFastModeSupported } from "@sublang/cligent";
import type { PlayerAdapterImports } from "@sublang/cligent/tmux-play";

const CORE_VERSION = "0.1.0";

export interface CoreServiceOptions {
  /** Shared config path; defaults to the XDG playbook location. */
  configPath?: string;
  /**
   * State root directory (DR-036); defaults to in-memory (callers
   * should set it). Shells resolve `${SPEX_HOME:-~/.spex}`.
   */
  dataDir?: string;
  /** Sessions directory; defaults to `<dataDir>/sessions`. */
  sessionsDir?: string;
  /** A legacy SQLite store the shell hands over for the one-time
   * import (core-service-64); the file is left in place. */
  legacyDbPath?: string;
  /** A legacy compiled-playbook library to relocate into the root,
   * with config `from` paths rewritten (core-service-64). */
  legacyLibraryDir?: string;
  port?: number;
  /**
   * A shell-supplied HTTP(S) server to attach the WebSocket endpoint
   * to (DR-033). The shell owns binding, TLS, and the server's
   * lifecycle; `port` is ignored, and `port()` reports the attached
   * server's bound port once the shell listens.
   */
  httpServer?: HttpServer | HttpsServer;
  loadModule?: LoadModule;
  adapterImports?: PlayerAdapterImports;
  /**
   * Injectable runtime half of adapter readiness (DR-024); defaults to
   * the cligent-derived check. Tests faking `adapterImports` fake this
   * too, for the same reason: the host machine's installed runtimes must
   * not decide a hermetic verdict.
   */
  adapterRuntime?: (
    adapter: AdapterName,
  ) => AdapterRuntimeCheck | Promise<AdapterRuntimeCheck>;
  /** Substitute only discovery; real Cligent capabilities remain composed. */
  discoverAgentModels?: AgentModelDiscovery;
  captainFactory?: CaptainFactory;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Disable the config file watcher (tests drive reload directly). */
  watchConfig?: boolean;
  /** Injectable external-command runner (git/gh; tests stub this). */
  runCommand?: RunCommand;
  forgeAdapter?: ForgeAdapter;
  /** Scaffold command for project creation, e.g. ["npx","-y","@sublang/spex"]. */
  scaffoldCommand?: string[];
  /** Compiled-playbook library directory (DR-005). */
  libraryDir?: string;
  /**
   * Handshake token required on the WS URL (?token=). Unset or empty
   * defaults to a random value — a blank secret would disable the
   * handshake — and embedding shells pass it to the UI. Foreign
   * browser origins are rejected regardless.
   */
  token?: string;
  /** Injectable line-streaming spawner for compile runs (tests). */
  compileSpawner?: LineSpawner;
}

// The Sources cache ages out at ten minutes (dashboard-14).
const FORGE_CACHE_MS = 600_000;

interface ClientState {
  socket: WebSocket;
  channels: Set<string>;
}

function channelKey(channel: Channel): string {
  return `${channel.kind}:${channel.sessionId}`;
}

/** Expand a leading ~ so the most natural path spelling works. */
function expandPath(input: string, home: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2));
  return resolve(trimmed);
}

export interface CoreServiceEvents {
  /** Local hook for an embedding shell (notifications, badges). */
  onRecord?: (envelope: RecordEnvelope) => void;
  onSessionState?: (session: import("./protocol.js").SessionInfo) => void;
  /** The ledger fold moved (DR-035): the shell re-reads `ledger()`
   * for its badge, so the dock and the app never disagree. */
  onLedgerChange?: () => void;
}

export class CoreService {
  private readonly options: CoreServiceOptions;
  private readonly configPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly store: Store;
  private readonly sessions: SessionManager;
  private readonly clients = new Set<ClientState>();
  private authToken = "";
  readonly events: CoreServiceEvents = {};
  private wss?: WebSocketServer;
  private watcher?: FSWatcher;
  private sessionsWatcher?: FSWatcher;
  private adoptTimer?: NodeJS.Timeout;
  private reloadTimer?: NodeJS.Timeout;

  private configState: ConfigState;
  private composed?: ComposedConfig;
  private seeded = false;
  private readonly runCommand: RunCommand;
  private readonly forge: ForgeAdapter;
  /** One in-flight compile per playbook id; abort via compile.abort. */
  private readonly activeCompiles = new Map<string, AbortController>();
  /** Projects whose ledger changed since the last broadcast (DR-035). */
  private readonly ledgerChanged = new Set<string>();
  private ledgerTimer?: NodeJS.Timeout;
  /** Monotonic reload identity; a superseded reload commits nothing. */
  private reloadGeneration = 0;
  /** The reload in flight, awaited before a runtime opens (core-service-92). */
  private reloading?: Promise<void>;
  private readonly migrationDiagnostics: {file: string; reason: string; blocking: boolean}[] = [];

  private constructor(options: CoreServiceOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.home = options.home ?? this.env.HOME ?? homedir();
    this.configPath =
      options.configPath ?? resolveConfigPath({...this.env, SPEX_HOME: options.dataDir ?? this.env.SPEX_HOME}, this.home);
    if (!options.loadModule) {
      this.options = { ...options, loadModule: createModuleLoader(this.env) };
    }
    this.authToken = options.token || randomUUID();
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.forge =
      options.forgeAdapter ?? new GitHubForgeAdapter(this.runCommand);
    this.store = new Store({
      ...(options.dataDir ? { dir: options.dataDir } : {}),
      sessionsDir: options.sessionsDir ?? resolveSessionsDir(this.configPath, { ...this.env, HOME: this.home, SPEX_HOME: options.dataDir ?? this.env.SPEX_HOME }),
      ...(options.legacyDbPath ? { legacyDbPath: options.legacyDbPath } : {}),
    });
    this.configState = { status: "missing", path: this.configPath };
    this.sessions = new SessionManager({
      store: this.store,
      loadModule: this.options.loadModule,
      adapterImports: options.adapterImports,
      captainFactory: options.captainFactory,
      env: this.env,
    });
    this.sessions.onRecord = (envelope) => {
      this.dispatchRecord(envelope);
      this.events.onRecord?.(envelope);
    };
    this.sessions.onSessionState = (session) => {
      this.broadcast({ type: "session.state", session });
      this.events.onSessionState?.(session);
    };
    this.sessions.onLedgerChange = (projectId) => {
      this.queueLedgerChange([projectId]);
    };
  }

  /** Announce ledger changes debounced (DR-035): session records land
   * in bursts, and every consumer re-pulls the one fold on receipt, so
   * a trailing edge per burst is all the truth costs. */
  private queueLedgerChange(projectIds: string[]): void {
    for (const projectId of projectIds) this.ledgerChanged.add(projectId);
    if (this.ledgerTimer) return;
    this.ledgerTimer = setTimeout(() => {
      this.ledgerTimer = undefined;
      const projects = [...this.ledgerChanged];
      this.ledgerChanged.clear();
      if (projects.length > 0) {
        this.broadcast({ type: "intents.changed", projectIds: projects });
        this.events.onLedgerChange?.();
      }
    }, 200);
  }

  /** The one ledger fold (DR-035), for the embedding shell's badge. */
  ledger(): import("./protocol.js").LedgerState {
    return foldLedger({
      store: this.store,
      lanes: this.sessions.listLanes(),
      now: Date.now,
    });
  }

  static async start(options: CoreServiceOptions = {}): Promise<CoreService> {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("Spex desktop and server require macOS or Linux with private POSIX file permissions. On Windows, use the scaffold CLI or connect to a Spex server in your browser.");
    }
    const service = new CoreService(options);
    try {
    service.store.markAllSessionsNotLive();
    service.relocateLegacyLibrary();
    // The launcher moved the shared config under the Spex root
    // (playbook DR-043); a config still at the previous location
    // relocates once before seeding could shadow it (core-service-66).
    // An explicit --config is the operator's path and moves nothing.
    if (options.configPath === undefined) {
      relocateLegacyConfig(
        service.configPath,
        resolveLegacyConfigPath(service.env, service.home),
      );
    }
    service.seeded = seedConfig(service.configPath);
    if (service.options.dataDir) migrateManagedLibraryConfig(service.configPath, service.libraryDir(), service.options.dataDir);
    await service.reloadConfig();
    await service.migrateLegacySessionDefault();
    await service.store.initializeSessions(service.sessionsDir());
    await service.syncForeignSessions();
    service.store.validateStorage();
    if (options.dataDir) prepareStorageGitFiles(options.dataDir, service.store.untrackedSessionPaths());
    if (options.watchConfig !== false) {
      service.watchConfigFile();
      service.watchSessionsDir();
    }
    await service.listen(options.port ?? 0);
    return service;
    } catch (error) {
      await service.stop();
      throw error;
    }
  }

  /**
   * Serve the sessions another host wrote into the shared session
   * store (core-service-60), and forget the ones whose record left it
   * (core-service-76). Called once before serving and again whenever
   * a captain-session record or replay stream changes, so terminal
   * sessions join the listing, keep their history current, and leave
   * it when removed.
   */
  private adoptScan: Promise<void> = Promise.resolve();

  private syncForeignSessions(): Promise<void> {
    const scan = this.adoptScan.then(() => this.scanSessions());
    this.adoptScan = scan.catch(() => {});
    return scan;
  }

  private async scanSessions(): Promise<void> {
    let changed: Awaited<ReturnType<Store["adoptForeignSessions"]>>;
    let vanished: { id: string; projectId: string }[];
    try {
      changed = await this.store.adoptForeignSessions(this.sessionsDir());
      vanished = this.store.forgetVanishedForeignSessions();
    } catch {
      // Another host's directory is not ours to depend on: an
      // unreadable one costs its sessions, never this service.
      return;
    }
    const projectIds = new Set<string>();
    for (const { id: sessionId, appended, replaced, unlistedProjectId } of changed) {
      if (unlistedProjectId) {
        this.broadcast({ type: "session.removed", sessionId, projectId: unlistedProjectId });
        projectIds.add(unlistedProjectId);
        continue;
      }
      const session = this.store.describeSession(sessionId);
      if (!session) continue;
      if (replaced) this.broadcast({type:"session.history-replaced", sessionId});
      this.broadcast({ type: "session.state", session });
      for (const entry of appended) {
        this.dispatchRecord({
          sessionId,
          ...entry,
          hidden: "visibility" in entry.record && entry.record.visibility === "hidden",
        });
      }
      projectIds.add(session.projectId);
    }
    for (const { id, projectId } of vanished) {
      this.broadcast({ type: "session.removed", sessionId: id, projectId });
      projectIds.add(projectId);
    }
    if (projectIds.size > 0) this.queueLedgerChange([...projectIds]);
  }

  private sessionsDir(): string {
    if (!this.options.dataDir && !this.options.sessionsDir) return this.store.sessionStore().sessionsDir;
    return this.options.sessionsDir ?? resolveSessionsDir(this.configPath, { ...this.env, HOME: this.home, SPEX_HOME: this.options.dataDir ?? this.env.SPEX_HOME });
  }

  private async migrateLegacySessionDefault(): Promise<void> {
    if (!this.options.dataDir || this.options.sessionsDir || this.env.SPEX_HOME?.trim() ||
      resolve(this.options.dataDir) !== resolve(this.home,".spex")) return;
    let config: unknown;
    try { config = parseYaml(readFileSync(this.configPath,"utf8")); }
    catch { return; }
    if (!config || typeof config !== "object" || Object.hasOwn(config,"sessions")) return;
    const result = await this.store.sessionStore().migrateLegacyDefault({env:this.env,homeDir:this.home});
    for (const entry of result.skipped) this.migrationDiagnostics.push({
      file:join(result.sourceDir,`${entry.sessionId}.json`), reason:entry.reason, blocking:false,
    });
  }

  private watchSessionsDir(): void {
    const dir = this.sessionsDir();
    if (!existsSync(dir)) return;
    this.sessionsWatcher = watch(dir, (_eventType, filename) => {
      // The CLI can append without replacing its manifest. Our own
      // sidecars are irrelevant, and the store excludes owned sessions
      // when a shared stream changes. A missing filename means scan.
      if (filename && (
        (!filename.endsWith(".json") && !filename.endsWith(".records.jsonl") && !/^\.[0-9a-f-]{36}\.lock$/.test(filename)) ||
        filename.endsWith(".spex.json")
      )) {
        return;
      }
      if (filename?.endsWith(".records.jsonl")) {
        const session = this.store.describeSession(filename.slice(0, -".records.jsonl".length));
        if (session?.live) return;
      }
      // Bound the wait even while a CLI keeps writing: later events
      // join this scan instead of postponing it until the writer stops.
      if (this.adoptTimer) return;
      this.adoptTimer = setTimeout(() => {
        this.adoptTimer = undefined;
        void this.syncForeignSessions();
      }, 150);
    });
  }

  /** The compiled-playbook library home (DR-005, DR-036): under the
   * state root when one is set, the pre-DR-036 XDG default otherwise. */
  private libraryDir(): string {
    return (
      this.options.libraryDir ??
      (this.options.dataDir
        ? join(this.options.dataDir, "playbooks")
        : join(
            this.env.XDG_DATA_HOME || join(this.home, ".local", "share"),
            "spex",
            "playbooks",
          ))
    );
  }

  /** The one-time library relocation riding the import (CORE-64): a
   * legacy library moves into the root and the config's `from` paths
   * follow, comment-preservingly. */
  private relocateLegacyLibrary(): void {
    if (!this.options.dataDir) return;
    const legacy =
      this.options.legacyLibraryDir ??
      join(
        this.env.XDG_DATA_HOME || join(this.home, ".local", "share"),
        "spex",
        "playbooks",
      );
    const target = this.libraryDir();
    if (legacy === target || !existsSync(legacy) || existsSync(target)) return;
    // Copy, repoint, then delete: a crash at any point leaves every
    // `from` path aimed at a directory that still exists.
    cpSync(legacy, target, { recursive: true });
    rewriteLibraryPaths(this.configPath, legacy, target);
    rmSync(legacy, { recursive: true, force: true });
  }

  port(): number {
    const address = this.wss?.address() as AddressInfo | null;
    if (!address || typeof address === "string") {
      throw new Error("service is not listening");
    }
    return address.port;
  }

  configStateSnapshot(): ConfigState {
    return this.configState;
  }

  /** Config notification preferences (event -> off|bell|desktop). */
  notificationPrefs(): Record<string, string> {
    const prefs = this.composed?.notifications;
    return typeof prefs === "object" && prefs !== null
      ? (prefs as Record<string, string>)
      : {};
  }

  /** True while any live session has an active boss turn. */
  hasActiveTurns(): boolean {
    return this.sessions
      .listSessions()
      .some((session) => session.live && this.sessions.getLive(session.id)?.turnActive);
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.sessionsWatcher?.close();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.adoptTimer) clearTimeout(this.adoptTimer);
    await this.adoptScan;
    if (this.ledgerTimer) clearTimeout(this.ledgerTimer);
    // Kill any in-flight compile child so shutdown never orphans slc.
    for (const controller of this.activeCompiles.values()) controller.abort();
    // A disposal failure must not leave the endpoint or the store open
    // (CORE-39): finish the shutdown, then report it to the host.
    let failure: { error: unknown } | undefined;
    try {
      await this.sessions.disposeAll();
    } catch (error) {
      failure = { error };
    }
    for (const client of this.clients) client.socket.close();
    await new Promise<void>((resolveClose) =>
      this.wss ? this.wss.close(() => resolveClose()) : resolveClose(),
    );
    this.store.close();
    if (failure) throw failure.error;
  }

  // -- config ---------------------------------------------------------------

  async reloadConfig(): Promise<void> {
    const generation = ++this.reloadGeneration;
    const work = this.reloadNow(generation).finally(() => {
      if (this.reloading === work) this.reloading = undefined;
    });
    this.reloading = work;
    await work;
  }

  /** A message applies the file's latest settings (core-service-92): a
   * reload the watcher scheduled or started is awaited before a session
   * opens, so the debounce window never applies stale settings. */
  private async settledConfig(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
      await this.reloadConfig();
    }
    while (this.reloading) await this.reloading;
  }

  private async reloadNow(generation: number): Promise<void> {
    // Reloads overlap: the watcher fires and forgets, two command paths
    // await their own, and external edits add more. Each reload reads the
    // file at its own start, so the newest reload holds the newest content
    // and every superseded one must discard its work — committing it would
    // publish an older file's state, and a readiness probe that outlived a
    // newer reload would overwrite that reload's broadcast with entries
    // for a configuration no longer active.
    let nextState: ConfigState;
    let nextComposed: ComposedConfig | undefined;
    if (!existsSync(this.configPath)) {
      nextState = { status: "missing", path: this.configPath };
      nextComposed = undefined;
    } else {
      try {
        const loaded = await loadConfig(this.configPath, this.options.loadModule, {libraryDir:this.libraryDir()});
        nextComposed = loaded.composed;
        nextState = {
          status: "valid",
          summary: summarizeConfig(loaded),
          seeded: this.seeded,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        nextState = {
          status: "invalid",
          path: this.configPath,
          errors: [message],
        };
        // A turn in flight keeps the config it opened with (core-service-2);
        // opening a runtime is refused until the file is valid again.
        nextComposed = undefined;
      }
    }
    if (generation !== this.reloadGeneration) return;
    this.composed = nextComposed;
    this.configState = nextState;
    this.broadcast({ type: "config.state", state: this.configState });
    const entries = await this.readiness();
    if (generation !== this.reloadGeneration) return;
    this.broadcast({ type: "readiness.state", entries });
  }

  private watchConfigFile(): void {
    const dir = dirname(this.configPath);
    const file = basename(this.configPath);
    if (!existsSync(dir)) return;
    this.watcher = watch(dir, (_eventType, filename) => {
      if (filename && filename !== file) return;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = undefined;
        void this.reloadConfig();
      }, 150);
    });
  }

  async readiness(): Promise<ReadinessEntry[]> {
    if (this.configState.status !== "valid") return [];
    const summary = this.configState.summary;
    // Adapter-keyed and deduplicated (DR-019): readiness is a
    // property of the adapter's auth, not of any one agent block.
    // Each entry names the positions using the adapter so guidance
    // points somewhere concrete.
    const positions = new Map<AdapterName, string[]>();
    const note = (adapter: AdapterName, position: string): void => {
      const list = positions.get(adapter);
      if (list) list.push(position);
      else positions.set(adapter, [position]);
    };
    note(summary.captain.adapter, "captain");
    // A position is a session player, named by its own id; the roles
    // it serves ride along, since one lane may answer several
    // (DR-032). Only referenced players are in the roster, so an
    // unused entry never gates a first run.
    for (const player of summary.players) {
      const roles = player.boundBy.length > 0 ? ` (${player.boundBy.join(", ")})` : "";
      note(player.agent.adapter, `${player.id}${roles}`);
    }
    return Promise.all(
      [...positions.entries()].map(async ([adapter, usedBy]) => {
        const readiness = await checkAdapterReadiness(
          adapter,
          this.env,
          this.home,
          this.options.adapterRuntime ?? checkAdapterRuntime,
        );
        return {
          adapter,
          ready: readiness.ready,
          ...(readiness.requirement
            ? { requirement: readiness.requirement }
            : {}),
          usedBy,
          // The embedded runtime declares which adapters take fast mode
          // (DR-038); the editor offers the switch only for those.
          fastModeSupported: isFastModeSupported(adapter),
        };
      }),
    );
  }

  // -- websocket ------------------------------------------------------------

  /** The handshake token clients must present (?token=). */
  token(): string {
    return this.authToken;
  }

  private async listen(port: number): Promise<void> {
    const verifyClient = (info: {
      origin?: string;
      req: { url?: string; headers: { host?: string } };
    }): boolean => {
      // Reject foreign browser origins outright: only the packaged
      // file:// renderer (origin "file://" or "null"), local dev
      // pages, a page served from the host this handshake itself
      // addressed (DR-033), and non-browser clients (no Origin
      // header) may connect.
      const origin = info.origin;
      if (
        origin &&
        origin !== "null" &&
        !origin.startsWith("file://") &&
        !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) &&
        !this.originMatchesRequestHost(origin, info.req.headers.host)
      ) {
        return false;
      }
      const query = new URL(info.req.url ?? "/", "ws://127.0.0.1").searchParams;
      return query.get("token") === this.authToken;
    };
    this.wss = this.options.httpServer
      ? new WebSocketServer({ server: this.options.httpServer, verifyClient })
      : new WebSocketServer({ host: "127.0.0.1", port, verifyClient });
    this.wss.on("connection", (socket) => {
      const client: ClientState = { socket, channels: new Set() };
      this.clients.add(client);
      socket.on("close", () => this.clients.delete(client));
      socket.on("message", (data) => {
        void this.handleMessage(client, String(data));
      });
      this.send(socket, {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        coreVersion: CORE_VERSION,
      });
    });
    if (this.options.httpServer) return; // the shell listens
    await new Promise<void>((resolveListen, rejectListen) => {
      this.wss?.once("listening", resolveListen);
      this.wss?.once("error", rejectListen);
    });
  }

  /** A browser Origin naming the host the request itself addressed. */
  private originMatchesRequestHost(origin: string, host?: string): boolean {
    if (!host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) this.send(client.socket, message);
  }

  private dispatchRecord(envelope: RecordEnvelope): void {
    const channel = envelope.hidden ? "debug" : "session";
    const key = `${channel}:${envelope.sessionId}`;
    for (const client of this.clients) {
      if (client.channels.has(key)) {
        this.send(client.socket, {
          type: "record",
          channel,
          sessionId: envelope.sessionId,
          seq: envelope.seq,
          record: envelope.record,
          ...(envelope.role !== undefined ? { role: envelope.role } : {}),
        });
      }
    }
  }

  private async handleMessage(client: ClientState, raw: string): Promise<void> {
    const parsed = parseCommand(raw);
    if (!parsed.ok) {
      this.send(client.socket, {
        type: "reply",
        id: parsed.id ?? "",
        ok: false,
        error: { code: "invalid_message", message: parsed.error },
      });
      return;
    }
    const command = parsed.command;
    try {
      const result = await this.execute(client, command);
      this.send(client.socket, {
        type: "reply",
        id: command.id,
        ok: true,
        result,
      });
    } catch (error) {
      const code: ErrorCode =
        error instanceof CoreError ? error.code : error instanceof StorageFormatError ? "invalid_request" : (error as {code?:string})?.code === "PLAYBOOK_SESSION_LEASE_ACTIVE" ? "busy" : "internal";
      const message = error instanceof Error ? error.message : String(error);
      this.send(client.socket, {
        type: "reply",
        id: command.id,
        ok: false,
        error: { code, message },
      });
    }
  }

  private async execute(
    client: ClientState,
    command: Command,
  ): Promise<unknown> {
    if (["project.create", "project.register", "project.rebind", "project.remove"].includes(command.type)) this.store.assertProjectsWritable();
    if (command.type === "session.create" || command.type === "intent.queue") this.store.assertWritable({projectId:command.projectId});
    if (command.type === "session.retry" || command.type === "session.discard" || command.type === "turn.submit") this.store.assertWritable({sessionId:command.sessionId});
    switch (command.type) {
      case "config.get":
        return this.configState;
      case "readiness.get":
        return this.readiness();
      case "agent.options":
        return readAgentOptions(command.adapter, this.env, this.options.discoverAgentModels);
      case "project.list":
        return this.store.listProjects();
      case "project.register": {
        const path = expandPath(command.path, this.home);
        if (!existsSync(path) || !statSync(path).isDirectory()) {
          throw new CoreError(
            "invalid_request",
            `${path} is not a directory`,
          );
        }
        if (!(await isWorkTreeRoot(path, this.runCommand))) {
          throw new CoreError(
            "invalid_request",
            `${path} is not the root of a git work tree (run git init first, or use project.create)`,
          );
        }
        const registered = this.store.registerProject(path, basename(path), Date.now());
        // The shared session store may already hold this project's
        // history from the CLI; it lists from now on (core-service-60).
        await this.syncForeignSessions();
        return registered;
      }
      case "project.rebind": {
        const path = expandPath(command.path, this.home);
        if (!(await isWorkTreeRoot(path, this.runCommand))) {
          throw new CoreError("invalid_request", `${path} is not the root of a git work tree`);
        }
        if (this.sessions.listSessions().some((session) => session.projectId === command.projectId && session.live)) {
          throw new CoreError("busy", "wait for the project's running turn to finish, or abort it, before rebinding");
        }
        const project = this.store.rebindProject({ id: command.projectId, path,
          ...(command.aliases ? { aliases: command.aliases } : {}),
          ...(command.revision ? { revision: command.revision } : {}) });
        await this.syncForeignSessions();
        return project;
      }
      case "storage.diagnostics":
        return [...this.migrationDiagnostics, ...this.store.storageDiagnostics(), ...this.store.sessionDiagnostics()];
      case "project.create": {
        const path = expandPath(command.path, this.home);
        if (this.store.getProjectByPath(path)) {
          throw new CoreError("conflict", `${path} is already registered`);
        }
        if (command.example && command.scaffold) {
          throw new CoreError(
            "invalid_request",
            "example seeding and scaffold are mutually exclusive",
          );
        }
        try {
          if (command.example) {
            await seedExampleProject({ path, run: this.runCommand });
          } else {
            await createProjectRepo({
              path,
              scaffold: command.scaffold,
              run: this.runCommand,
              ...(this.options.scaffoldCommand
                ? { scaffoldCommand: this.options.scaffoldCommand }
                : {}),
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new CoreError("invalid_request", message);
        }
        return this.store.registerProject(path, basename(path), Date.now());
      }
      case "project.status": {
        const project = this.store.getProject(command.projectId);
        if (!project) {
          throw new CoreError("not_found", `no project ${command.projectId}`);
        }
        return repoStatus(project.path, this.runCommand);
      }
      case "forge.items": {
        const project = this.store.getProject(command.projectId);
        if (!project) {
          throw new CoreError("not_found", `no project ${command.projectId}`);
        }
        // The cache is persisted in the app store (dashboard-14), so a
        // restart serves the last lists rather than a blank.
        const cached = this.store.getForgeCache(project.id);
        if (
          !command.refresh &&
          cached &&
          Date.now() - cached.at < FORGE_CACHE_MS
        ) {
          return cached.state;
        }
        const status = await repoStatus(project.path, this.runCommand);
        const state = await this.forge.state(project.path, status.originUrl);
        this.store.setForgeCache(project.id, { at: Date.now(), state });
        return state;
      }
      case "project.remove": {
        if (!this.store.removeProject(command.projectId)) {
          throw new CoreError("not_found", `no project ${command.projectId}`);
        }
        return null;
      }
      case "session.list":
        return this.sessions.listSessions();
      case "session.create": {
        const project = this.store.getProject(command.projectId);
        if (!project) {
          throw new CoreError("not_found", `no project ${command.projectId}`);
        }
        await this.settledConfig();
        if (this.configState.status !== "valid" || !this.composed) {
          throw new CoreError(
            "invalid_config",
            this.configState.status === "invalid"
              ? `config is invalid: ${this.configState.errors.join("; ")}`
              : "config file is missing",
          );
        }
        return this.sessions.createSession(project, this.composed);
      }
      case "session.dispose":
        await this.sessions.disposeSession(command.sessionId);
        return null;
      case "session.retry": {
        const session = this.store.describeSession(command.sessionId);
        if (!session) throw new CoreError("not_found", `no session ${command.sessionId}`);
        const project = this.store.getProject(session.projectId);
        if (!project) throw new CoreError("invalid_request", "bind the existing project before retrying");
        await this.sessions.retrySession(project, session.id);
        return {accepted: true};
      }
      case "session.discard": {
        const session = this.store.describeSession(command.sessionId);
        if (!session) throw new CoreError("not_found", `no session ${command.sessionId}`);
        const result = await this.sessions.discardSession(session.id);
        if (result.removed) this.broadcast({type:"session.removed", sessionId:session.id, projectId:session.projectId});
        return result;
      }
      case "session.delete": {
        const session = this.store.describeSession(command.sessionId);
        if (!session) {
          throw new CoreError("not_found", `no session ${command.sessionId}`);
        }
        // A turn in flight finishes or aborts first (core-service-70):
        // deleting under a running runtime would orphan its agents.
        if (this.sessions.getLive(session.id)) {
          throw new CoreError("busy", "wait for the running turn to finish, or abort it, before deleting");
        }
        await this.store.deleteSession(session.id);
        this.broadcast({
          type: "session.removed",
          sessionId: session.id,
          projectId: session.projectId,
        });
        // An open intent the session served re-derives as queued (DR-038).
        this.queueLedgerChange([session.projectId]);
        return null;
      }
      case "turn.submit": {
        if (command.intentId !== undefined) {
          const intent = this.requireOpenIntent(command.intentId);
          const session = this.store.describeSession(command.sessionId);
          if (!session || session.projectId !== intent.projectId) {
            throw new CoreError(
              "invalid_request",
              "the intent belongs to another project",
            );
          }
          if (this.deriveIntentState(intent.id) !== "queued") {
            throw new CoreError(
              "conflict",
              "the intent is already dispatched",
            );
          }
          const predecessor = intent.afterId
            ? this.store.getIntent(intent.afterId)
            : undefined;
          if (predecessor && predecessor.closedAt === undefined) {
            throw new CoreError(
              "conflict",
              `the intent waits on "${intentTitle(predecessor)}"`,
            );
          }
        }
        // The runtime is held only for a turn (DR-051): a message to a
        // session that is not live opens it first — on the settings the
        // file holds now — then the turn as usual. A turn still settling
        // is waited out, so the message never reaches a closing host.
        await this.sessions.settled(command.sessionId);
        if (!this.sessions.getLive(command.sessionId)) {
          await this.settledConfig();
          await this.continueSession(command.sessionId);
        }
        this.sessions.submitTurn(
          command.sessionId,
          command.text,
          command.intentId,
        );
        return { accepted: true };
      }
      case "turn.abort":
        return { aborted: this.sessions.abortTurn(command.sessionId) };
      case "subscribe": {
        this.requireKnownSession(command.channel.sessionId);
        client.channels.add(channelKey(command.channel));
        return null;
      }
      case "unsubscribe":
        client.channels.delete(channelKey(command.channel));
        return null;
      case "history.get":
        this.requireKnownSession(command.sessionId);
        return {
          records: this.store.getRecords(command.sessionId, {
            afterSeq: command.afterSeq,
          }),
        };
      case "usage.get":
        this.requireKnownSession(command.sessionId);
        return this.store.sessionUsage(command.sessionId);
      case "usage.days":
        return this.store.usageByDay();
      case "config.edit": {
        if (!existsSync(this.configPath)) {
          throw new CoreError("invalid_config", "config file is missing");
        }
        const op = command.op as ConfigEditOp;
        const result = await editConfigFile(
          this.configPath,
          op,
          this.options.loadModule,
        );
        if (!result.ok) {
          throw new CoreError(
            "invalid_config",
            result.error ?? "edit rejected",
          );
        }
        await this.reloadConfig();
        return this.configState;
      }
      case "compile.check":
        return checkToolchain(this.env, this.options.compileSpawner);
      case "playbook.artifacts": {
        if (this.configState.status !== "valid" || !this.composed) {
          throw new CoreError("invalid_config", "config is not valid");
        }
        const playbook = this.composed.playbooks.find(
          (entry) => entry.id === command.playbookId,
        );
        if (!playbook) {
          throw new CoreError(
            "not_found",
            `no configured playbook ${command.playbookId}`,
          );
        }
        return resolveArtifacts(
          { id: playbook.id, from: playbook.from },
          this.env,
        );
      }
      case "library.builtins": {
        const configuredIds = new Set(
          this.composed?.playbooks.map((playbook) => playbook.id) ?? [],
        );
        return {
          builtins: await loadBuiltinCatalog(
            configuredIds,
            this.options.loadModule,
          ),
        };
      }
      case "compile.run": {
        if (!existsSync(this.configPath)) {
          throw new CoreError("invalid_config", "config file is missing");
        }
        // One compile per playbook id, fail-closed (DR-010 §5): a
        // duplicate submission is rejected, never queued or merged.
        if (this.activeCompiles.has(command.playbookId)) {
          throw new CoreError(
            "busy",
            `a compile is already running for ${command.playbookId}`,
          );
        }
        const controller = new AbortController();
        this.activeCompiles.set(command.playbookId, controller);
        try {
          const libraryDir = this.libraryDir();
          let result;
          try {
            result = await compilePlaybook({
              playbookId: command.playbookId,
              configPath: this.configPath,
              source: {
                ...(command.sourceText !== undefined
                  ? { text: command.sourceText }
                  : {}),
                ...(command.sourcePath ? { path: command.sourcePath } : {}),
              },
              roles: command.roles,
              command: command.command,
              intent: command.intent,
              libraryDir,
              env: this.env,
              signal: controller.signal,
              ...(this.options.compileSpawner
                ? { spawner: this.options.compileSpawner }
                : {}),
              onProgress: (line) => {
                // After an abort the ◇ canceled line (sent by the
                // compile.abort handler) stays the last progress output.
                if (controller.signal.aborted) return;
                this.broadcast({
                  type: "compile.progress",
                  playbookId: command.playbookId,
                  line,
                });
              },
            });
          } catch (error) {
            if (controller.signal.aborted) {
              throw new CoreError("aborted", "compile canceled");
            }
            const message =
              error instanceof Error ? error.message : String(error);
            throw new CoreError("invalid_request", message);
          }
          // The compiled entry's derived roles are authoritative
          // (DR-014): re-key the request's role -> player bindings
          // onto them by case-insensitive name match — slc emits the
          // ids as the gears declared them (`Coder`), the form may
          // key them either way — and an unmatched role fails before
          // any config write, keeping the artifacts for a
          // re-registration without recompiling (playbook-library-32).
          const assignments = new Map(
            Object.entries(command.bindings).map(([role, playerId]) => [
              role.toLowerCase(),
              playerId,
            ]),
          );
          const roles: Record<string, string> = {};
          const unmatched: string[] = [];
          for (const role of result.roles) {
            const playerId = assignments.get(role.toLowerCase());
            if (playerId === undefined) unmatched.push(role);
            else roles[role] = playerId;
          }
          if (unmatched.length > 0) {
            throw new CoreError(
              "invalid_request",
              `compiled, but the playbook's derived roles are [${result.roles.join(", ")}] and no player was bound for: ${unmatched.join(", ")}. Re-submit with a binding per derived role; the compiled artifacts are kept.`,
            );
          }
          // Lanes the bindings name but the roster lacks are created
          // first, so the binding never dangles (DR-032).
          for (const [playerId, block] of Object.entries(
            command.newPlayers ?? {},
          )) {
            const minted = await editConfigFile(
              this.configPath,
              { kind: "player.set", playerId, patch: block as AgentBlock },
              this.options.loadModule,
            );
            if (!minted.ok) {
              throw new CoreError(
                "invalid_config",
                `compiled, but creating session player "${playerId}" was refused: ${minted.error}`,
              );
            }
          }
          const edit = await editConfigFile(
            this.configPath,
            {
              kind: "playbook.add",
              playbookId: command.playbookId,
              from: result.from,
              roles,
            },
            this.options.loadModule,
          );
          if (!edit.ok) {
            throw new CoreError(
              "invalid_config",
              `compiled, but registration was refused: ${edit.error}`,
            );
          }
          await this.reloadConfig();
          return this.configState;
        } finally {
          this.activeCompiles.delete(command.playbookId);
        }
      }
      case "compile.abort": {
        const controller = this.activeCompiles.get(command.playbookId);
        if (!controller) {
          throw new CoreError(
            "not_found",
            `no compile is running for ${command.playbookId}`,
          );
        }
        controller.abort();
        this.broadcast({
          type: "compile.progress",
          playbookId: command.playbookId,
          line: "◇ compile canceled",
        });
        return null;
      }
      case "specs.get": {
        const project = this.store.getProject(command.projectId);
        if (!project) {
          throw new CoreError("not_found", `no project ${command.projectId}`);
        }
        return parseSpecTree(project.path);
      }
      case "specs.read": {
        const project = this.store.getProject(command.projectId);
        if (!project) {
          throw new CoreError("not_found", `no project ${command.projectId}`);
        }
        const resolved = resolveSpecPath(project.path, command.path);
        if (!resolved.ok) throw new CoreError(resolved.code, resolved.message);
        return readSpecFile(resolved.path);
      }
      case "specs.write": {
        const project = this.store.getProject(command.projectId);
        if (!project) {
          throw new CoreError("not_found", `no project ${command.projectId}`);
        }
        const written = writeSpecFile(
          project.path,
          command.path,
          command.content,
          command.baseVersion,
        );
        if (!written.ok) throw new CoreError(written.code, written.message);
        return { version: written.version, mtime: written.mtime };
      }
      case "intent.queue": {
        const project = this.store.getProject(command.projectId);
        if (!project) {
          throw new CoreError("not_found", `no project ${command.projectId}`);
        }
        if (command.source && command.source.kind !== "chat") {
          const holder = this.store.openIntentBySource(
            project.id,
            command.source.kind,
            command.source.ref,
          );
          if (holder) {
            throw new CoreError(
              "conflict",
              `an open intent already holds this source: "${intentTitle(holder)}"`,
            );
          }
        }
        if (command.afterIntentId !== undefined) {
          this.requireOpenIntent(command.afterIntentId);
        }
        const ranks = this.projectRanks(project.id);
        const rank =
          command.at === "head"
            ? rankBetween(null, ranks[0] ?? null)
            : rankBetween(ranks[ranks.length - 1] ?? null, null);
        const intent = {
          id: randomUUID(),
          projectId: project.id,
          text: command.text,
          ...(command.source ? { source: command.source } : {}),
          rank,
          ...(command.afterIntentId !== undefined
            ? { afterId: command.afterIntentId }
            : {}),
          createdAt: Date.now(),
        };
        this.store.addIntent(intent);
        this.queueLedgerChange([project.id]);
        return this.store.getIntent(intent.id);
      }
      case "intent.edit": {
        const intent = this.requireOpenIntent(command.intentId);
        if (this.deriveIntentState(intent.id) !== "queued") {
          throw new CoreError(
            "conflict",
            "a dispatched intent's text is history",
          );
        }
        this.store.setIntentText(intent.id, command.text);
        this.queueLedgerChange([intent.projectId]);
        return this.store.getIntent(intent.id);
      }
      case "intent.move": {
        const intent = this.requireOpenIntent(command.intentId);
        let rank: string;
        if (command.afterIntentId === null) {
          const ranks = this.projectRanks(intent.projectId, intent.id);
          rank = rankBetween(null, ranks[0] ?? null);
        } else {
          const target = this.requireOpenIntent(command.afterIntentId);
          if (target.projectId !== intent.projectId) {
            throw new CoreError(
              "invalid_request",
              "an intent reorders only within its own project",
            );
          }
          const ranks = this.projectRanks(intent.projectId, intent.id);
          const index = ranks.indexOf(target.rank);
          rank = rankBetween(target.rank, ranks[index + 1] ?? null);
        }
        this.store.setIntentRank(intent.id, rank);
        this.queueLedgerChange([intent.projectId]);
        return this.store.getIntent(intent.id);
      }
      case "intent.link": {
        const intent = this.requireOpenIntent(command.intentId);
        if (command.afterIntentId !== null) {
          if (command.afterIntentId === intent.id) {
            throw new CoreError("invalid_request", "an intent cannot wait on itself");
          }
          const target = this.requireOpenIntent(command.afterIntentId);
          // Cycles are refused fail-closed (DR-035): walk the chain
          // from the target; reaching this intent would close a loop.
          let cursor: string | undefined = target.afterId;
          while (cursor !== undefined) {
            if (cursor === intent.id) {
              throw new CoreError(
                "conflict",
                "that link would close a waiting cycle",
              );
            }
            const next = this.store.getIntent(cursor);
            cursor =
              next && next.closedAt === undefined ? next.afterId : undefined;
          }
        }
        this.store.setIntentLink(intent.id, command.afterIntentId);
        this.queueLedgerChange([intent.projectId]);
        return this.store.getIntent(intent.id);
      }
      case "intent.close": {
        const intent = this.requireOpenIntent(command.intentId);
        if (
          command.as === "done" &&
          this.deriveIntentState(intent.id) !== "finished"
        ) {
          throw new CoreError(
            "conflict",
            "only a finished intent confirms done",
          );
        }
        this.store.closeIntent(intent.id, command.as, Date.now());
        // Closing may release blocked intents in any project.
        const affected = new Set<string>([intent.projectId]);
        for (const open of this.store.listOpenIntents()) {
          if (open.afterId === intent.id) affected.add(open.projectId);
        }
        this.queueLedgerChange([...affected]);
        return this.store.getIntent(intent.id);
      }
      case "intent.remove": {
        // Only done work leaves History (core-service-79): an open
        // intent is still the ledger's, and its own act closes it.
        const intent = this.store.getIntent(command.intentId);
        if (!intent) {
          throw new CoreError("not_found", `no intent ${command.intentId}`);
        }
        if (intent.closedAt === undefined) {
          throw new CoreError(
            "conflict",
            "only a closed intent leaves history",
          );
        }
        this.store.removeIntent(intent.id, Date.now());
        this.queueLedgerChange([intent.projectId]);
        return null;
      }
      case "ledger.get":
        return foldLedger({
          store: this.store,
          lanes: this.sessions.listLanes(),
          now: Date.now,
        });
      case "ledger.history": {
        const project = this.store.getProject(command.projectId);
        if (!project) {
          throw new CoreError("not_found", `no project ${command.projectId}`);
        }
        // History is done work (DR-038): closed done, or dropped after
        // a turn of the intent's ended finished; a drop before any work
        // left the queue without a trace.
        const page = this.store.listClosedIntents(
          project.id,
          21,
          command.before
            ? {
                closedAt: command.before.closedAt,
                intentId: command.before.intentId,
              }
            : undefined,
          (intent) => intent.closedAs === "done" || wasWorked(this.store, intent),
        );
        const more = page.length > 20;
        return {
          intents: page.slice(0, 20).map((intent) => {
            const stats = closedStats(this.store, intent);
            return { intent, ...(stats ? { stats } : {}) };
          }),
          more,
        };
      }
      case "session.viewed": {
        this.requireKnownSession(command.sessionId);
        const key = `viewed:${command.sessionId}`;
        const previous = this.store.getPref<number>(key) ?? -1;
        if (command.turnId > previous) {
          this.store.setPref(key, command.turnId);
          const session = this.store.describeSession(command.sessionId);
          if (session) this.queueLedgerChange([session.projectId]);
        }
        return null;
      }
    }
  }

  /** Continue either host's checkpoint through the shared lifecycle. */
  private async continueSession(sessionId: string): Promise<void> {
    const session = this.store.describeSession(sessionId);
    if (!session) throw new CoreError("not_found", `no session ${sessionId}`);
    if (!session.continuable) {
      throw new CoreError("invalid_request", session.recovery
        ? "Recover the interrupted turn with Retry or Discard first"
        : session.continuationReason ?? "this session has no compatible checkpoint");
    }
    const project = this.store.getProject(session.projectId);
    if (!project) {
      throw new CoreError("not_found", `no project ${session.projectId}`);
    }
    if (this.configState.status !== "valid" || !this.composed) {
      throw new CoreError(
        "invalid_config",
        this.configState.status === "invalid"
          ? `config is invalid: ${this.configState.errors.join("; ")}`
          : "config file is missing",
      );
    }
    await this.sessions.continueSession(project, this.composed, session);
  }

  /** The intent named must exist and still be open (DR-035). */
  private requireOpenIntent(intentId: string) {
    const intent = this.store.getIntent(intentId);
    if (!intent) throw new CoreError("not_found", `no intent ${intentId}`);
    this.store.assertWritable({projectId:intent.projectId});
    if (intent.closedAt !== undefined) {
      throw new CoreError("conflict", "the intent is already closed");
    }
    return intent;
  }

  /** One intent's derived state, read from the one fold (DR-035). */
  private deriveIntentState(intentId: string) {
    const ledger = foldLedger({
      store: this.store,
      lanes: this.sessions.listLanes(),
      now: Date.now,
    });
    return ledger.intents.find((entry) => entry.intent.id === intentId)?.state;
  }

  /** The project's open-intent ranks in order, optionally without the
   * row being moved. */
  private projectRanks(projectId: string, excludeId?: string): string[] {
    return this.store
      .listOpenIntents()
      .filter(
        (intent) =>
          intent.projectId === projectId && intent.id !== excludeId,
      )
      .map((intent) => intent.rank);
  }

  private requireKnownSession(sessionId: string): void {
    const known = this.store
      .listSessions()
      .some((session) => session.id === sessionId);
    if (!known) throw new CoreError("not_found", `no session ${sessionId}`);
  }
}

export const createCoreService = CoreService.start;
