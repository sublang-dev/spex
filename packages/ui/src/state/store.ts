// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// App store: wires the protocol client into view state. Composer
// submissions queue client-side while a turn is active and dispatch
// when it ends (RUN-8); the core enforces one turn at a time.
// Reconnects re-subscribe every live session and backfill missed
// records via history afterSeq, so panes never silently freeze.

import { create } from "zustand";
import { hasPresentationHeader } from "@sublang/spex-core/protocol";
import type {
  AgentBlockInput,
  AdapterName,
  AgentOptions,
  BuiltinPlaybookInfo,
  ClosedIntent,
  ConfigState,
  ForgeState,
  IntentInfo,
  IntentSource,
  LedgerState,
  ProjectInfo,
  ReadinessEntry,
  RepoStatusInfo,
  ServerMessage,
  SessionInfo,
  SpecTreeState,
  MachineGraph,
  TmuxPlayRecord,
} from "@sublang/spex-core/protocol";

import { SpexClient, defaultCoreUrl, type ConnectionStatus } from "../lib/client.js";
import { currentSessionOf } from "../lib/sessions.js";
import {
  applyRecord,
  initialSessionView,
  type SessionView,
} from "./reducer.js";

export interface ComposerState {
  /** Submissions waiting for the turn to end (RUN-8). A staged
   * intent's id rides its entry, so the chip follows the pending
   * bubble and the dispatch stamps when the turn starts (DR-035). */
  queued: { text: string; intentId?: string }[];
  /** Unsent composer text — survives tab and surface switches. */
  draft?: string;
}

export interface ProjectMeta {
  status?: RepoStatusInfo;
  forge?: ForgeState;
  statusError?: string;
  forgeError?: string;
  loading?: boolean;
}

export interface CompileTracker {
  playbookId: string;
  running: boolean;
  ok?: boolean;
}

/** One project's History page state (DR-035): closed intents newest
 * first, extended in place as the reader scrolls. */
export interface HistoryState {
  intents: ClosedIntent[];
  more: boolean;
  loading?: boolean;
}

/** A staged dispatch's chip (DR-035): the composer wears the intent
 * until the text is sent or the chip is detached. Keyed by session id,
 * or "home" for the Captain home composer. */
export interface StagedIntent {
  intentId: string;
  title: string;
}

export interface AppState {
  connection: ConnectionStatus;
  /** True once a connection has ever opened (first-paint banner). */
  everConnected: boolean;
  /** The core endpoint the client dials, named when it cannot be
   * reached (run-view-50). */
  coreUrl?: string;
  configState?: ConfigState;
  /** Served machine definitions by playbook id (run-view-64); null
   * records a fetch that found no machine. */
  machineGraphs: Record<string, MachineGraph | null>;
  readiness: ReadinessEntry[];
  projects: ProjectInfo[];
  projectMeta: Record<string, ProjectMeta>;
  compileProgress: Record<string, string[]>;
  activeCompile?: CompileTracker;
  /** Built-in playbook catalog (DR-015); undefined until first load. */
  builtins?: BuiltinPlaybookInfo[];
  sessions: SessionInfo[];
  views: Record<string, SessionView>;
  composers: Record<string, ComposerState>;
  /** Per-session command failures shown above the composer. */
  runErrors: Record<string, string>;
  activeSessionId?: string;
  /** The workspace's project context (DR-011): set only by the
   * palette, focusSession, or boot restoration. */
  currentProjectId?: string;
  /** Per-project last-active workspace tab: a session id, "start",
   * "specs", or "repo" (DR-011 workspace memory). */
  workspaceTabs: Record<string, string>;
  /** Per-project working set (run-view-57): the sessions open as
   * tabs, in the order they were opened. This launch's, not durable —
   * the sidebar is what carries history across launches. */
  openTabs: Record<string, string[]>;
  /** Sidebar chrome (DR-030), persisted app-wide. */
  railCollapsed: boolean;
  /** The Captain pane's share of the run view, as a percentage. A
   * machine drawing has a natural width that text does not, so the
   * split is the reader's to set (DR-030). */
  captainSplit: number;
  /** Capped frames' heights in their own steps, by frame id (DR-030):
   * a frame the reader pulled taller stays that way across launches. */
  frameHeights: Record<string, number>;
  /** Per-project sidebar disclosure (run-view-67), persisted; a
   * project with no entry follows the current-project default. */
  expandedProjects: Record<string, boolean>;
  /** Parsed specs trees per project (specs.get). */
  specTrees: Record<string, SpecTreeState>;
  /** Spec-view load failures per project. */
  specErrors: Record<string, string>;
  /** Draft for the Captain-home start composer. */
  homeDraft: string;
  /** The one ledger fold, as ledger.get last served it (DR-035). */
  ledger?: LedgerState;
  ledgerError?: string;
  /** Per-project History pages (DR-035). */
  history: Record<string, HistoryState>;
  /** Staged dispatches by composer key (session id or "home"). */
  stagedIntents: Record<string, StagedIntent>;
  /** Per-session collapsed player lanes (run-view-116): this launch's,
   * never on disk — a lane's rail is a reading posture, not a
   * preference. */
  collapsedLanes: Record<string, string[]>;
  /** Per-project folded Sources bands (dashboard-20): the band opens
   * expanded, and a fold lasts this launch — the Dashboard's group and
   * the project's Overview read the same one. */
  foldedSources: Record<string, boolean>;
  /** Bootstrap refresh failure — connected but app state missing. */
  refreshError?: string;

  loadAgentOptions(adapter: AdapterName): Promise<AgentOptions>;
  connect(url?: string): void;
  refresh(): Promise<void>;
  setCurrentProject(projectId: string | undefined): void;
  setWorkspaceTab(projectId: string, tab: string): void;
  /** Add a session to a project's working set (idempotent). */
  openTab(projectId: string, sessionId: string): void;
  /** File a session out of the working set — never ends it. */
  closeTab(projectId: string, sessionId: string): void;
  setRailCollapsed(collapsed: boolean): void;
  setCaptainSplit(percent: number): void;
  /** Set a capped frame's height, in that frame's own steps. */
  setFrameHeight(frameId: string, steps: number): void;
  toggleProjectExpanded(projectId: string, expanded: boolean): void;
  setLaneCollapsed(sessionId: string, playerId: string, collapsed: boolean): void;
  setSourcesFolded(projectId: string, folded: boolean): void;
  /** Register a folder, silently git-initializing non-repos
   * (RUN-27); the palette and any surface share this one action. */
  addProjectByPath(path: string): Promise<ProjectInfo>;
  /** Load (or refresh) the built-in playbook catalog (DR-015). */
  loadBuiltins(): Promise<void>;
  /** Seed the Academy example project (DR-015) and make it current.
   * Paths pass through as typed — the core expands a leading ~. */
  openAcademyExample(path?: string): Promise<ProjectInfo>;
  loadSpecs(projectId: string): Promise<void>;
  /** Fetch every configured playbook's machine graph, once per
   * config (run-view-64, playbook-library-36). */
  loadMachineGraphs(): Promise<void>;
  /** One file's text with the token its save must carry
   * (spec-view-16). */
  readSpecRecord(
    projectId: string,
    path: string,
  ): Promise<{ markdown: string; version: string }>;
  /** Replace one file under the token its read handed out — none
   * overwrites (spec-view-47). */
  writeSpec(
    projectId: string,
    path: string,
    content: string,
    baseVersion?: string,
  ): Promise<{ version: string }>;
  refreshReadiness(): Promise<void>;
  registerProject(path: string): Promise<ProjectInfo>;
  createProject(path: string, scaffold: boolean): Promise<ProjectInfo>;
  removeProject(projectId: string): Promise<void>;
  loadProjectMeta(projectId: string, refresh?: boolean): Promise<void>;
  openSession(projectId: string): Promise<SessionInfo>;
  focusSession(sessionId: string): Promise<void>;
  /** Load an idle session's transcript without focusing tabs.
   * `force` retries after a failed load (clears the stale view). */
  loadPastSession(sessionId: string, force?: boolean): Promise<void>;
  /** Delete an idle session's files and every trace (DR-038,
   * core-service-70); the core refuses a working or foreign one. */
  deleteSession(sessionId: string): Promise<void>;
  recoverSession(sessionId: string, action: "retry" | "discard"): Promise<void>;
  /** Forget a deleted session everywhere — the listing, its tab, its
   * transcript, composer, and staged chip. The removal broadcast and
   * the delete reply both land here, idempotently. */
  forgetSession(sessionId: string, projectId: string): void;
  submitBossText(sessionId: string, text: string): Promise<void>;
  /** Re-pull the one ledger fold (DR-035). */
  loadLedger(): Promise<void>;
  /** Load (or extend, with `more`) a project's History page. */
  loadHistory(projectId: string, more?: boolean): Promise<void>;
  /** Capture an intent (DR-035): one gesture, any source. */
  queueIntent(input: {
    projectId: string;
    text: string;
    source?: IntentSource;
    at?: "head" | "tail";
  }): Promise<IntentInfo>;
  moveIntent(intentId: string, afterIntentId: string | null): Promise<void>;
  /** Edit a queued intent's text (DR-035: from dispatch on, history). */
  editIntent(intentId: string, text: string): Promise<void>;
  closeIntent(intentId: string, as: "done" | "dropped"): Promise<void>;
  /** Retire a closed intent from History (core-service-79, DR-038):
   * the row leaves every loaded page at once. */
  removeIntent(intentId: string): Promise<void>;
  /** Stage an intent's text into its project's composer (DR-035):
   * the current conversation's, else the Captain home's. Returns the
   * staged composer key ("home" or the session id). */
  stageDispatch(intent: IntentInfo): Promise<string>;
  /** Detach a staged chip without sending (DR-035). */
  clearStagedIntent(key: string): void;
  /** Persist the viewed marker so the review summons clears (DR-035). */
  markViewed(sessionId: string): void;
  removeQueued(sessionId: string, index: number): void;
  abortTurn(sessionId: string): Promise<void>;
  clearRunError(sessionId: string): void;
  setDraft(sessionId: string, draft: string): void;
  setHomeDraft(draft: string): void;
  abortCompile(): Promise<void>;
  runCompile(input: {
    playbookId: string;
    sourceText?: string;
    sourcePath?: string;
    roles: string[];
    command: string;
    intent: string;
    /** role -> the session player that answers it (DR-032). */
    bindings: Record<string, string>;
    /** Lanes to create for bindings the roster does not yet hold. */
    newPlayers?: Record<string, AgentBlockInput>;
  }): Promise<void>;
}

let client: SpexClient | undefined;

const CURRENT_PROJECT_KEY = "spex.currentProject";
const RAIL_COLLAPSED_KEY = "spex.railCollapsed";
const EXPANDED_PROJECTS_KEY = "spex.expandedProjects";
const CAPTAIN_SPLIT_KEY = "spex.captainSplit";
/** The default share leaves a 1280px window's Captain column wide
 * enough for the built-in machines' drawings to scale into it rather
 * than scroll (run-view-81); chrome never moves by itself (DR-030), so
 * the default holds whether or not a drawing is up. */
export const CAPTAIN_SPLIT_DEFAULT = 45;
export const CAPTAIN_SPLIT_MIN = 22;
export const CAPTAIN_SPLIT_MAX = 70;

function readCaptainSplit(): number {
  const stored = Number(safeStorageGet(CAPTAIN_SPLIT_KEY));
  return Number.isFinite(stored) && stored >= CAPTAIN_SPLIT_MIN && stored <= CAPTAIN_SPLIT_MAX
    ? stored
    : CAPTAIN_SPLIT_DEFAULT;
}

/** One key per capped frame, so a frame's height is remembered under
 * its own identity beside the other chrome preferences (DR-030). */
export const frameKey = (frameId: string): string => `spex.frame:${frameId}`;

function readFrameHeights(): Record<string, number> {
  const heights: Record<string, number> = {};
  try {
    const store = window.localStorage;
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key?.startsWith("spex.frame:")) continue;
      const steps = Number(store.getItem(key));
      if (Number.isFinite(steps)) heights[key.slice("spex.frame:".length)] = steps;
    }
  } catch {
    // A frame falls back to its default height.
  }
  return heights;
}

/** localStorage access that tolerates non-browser test environments. */
function safeStorageGet(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort.
  }
}

function readExpandedProjects(): Record<string, boolean> {
  try {
    const raw = safeStorageGet(EXPANDED_PROJECTS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Sessions with a history backfill in flight: live records buffer
 * here so a race can never skip the gap (they apply after the
 * backfill in seq order). */
const backfilling = new Map<
  string,
  {
    seq: number;
    record: import("@sublang/spex-core/protocol").TmuxPlayRecord;
    role?: string;
  }[]
>();

export function getClient(): SpexClient {
  if (!client) throw new Error("client not connected");
  return client;
}

/** Test seam: store actions resolve the module-local client, which
 * module mocks cannot reach — vitest injects a fake through here. */
export function setClientForTests(fake: SpexClient | undefined): void {
  client = fake;
}

let deliver: ((message: ServerMessage) => void) | undefined;

/** Test seam: hand the store a server message as the client would,
 * without a socket. */
export function deliverServerMessageForTests(message: ServerMessage): void {
  deliver?.(message);
}

/** The newest ledger read's number: only its reply applies. */
let ledgerReads = 0;

export const useAppStore = create<AppState>((set, get) => {
  /** Records describe the conversation; the listing owns activity,
   * including settlement after the final reply and stopped history. */
  function sessionActivity(view: SessionView, session?: SessionInfo): SessionView {
    const turnActive = session?.live === false
      ? false
      : session?.turnActive ?? view.turnActive;
    return { ...view, turnActive };
  }

  function setRunError(sessionId: string, message: string): void {
    set({ runErrors: { ...get().runErrors, [sessionId]: message } });
  }

  /** Dispatch the next queued composer message when a turn is idle
   * (RUN-8), from live records and backfills alike. The runtime is
   * held only for a turn (DR-051), so a session is no longer live once
   * its turn settled: a queued message then opens it again — but only
   * on the heels of that turn's end, never because history was loaded
   * or an interrupted turn was recovered, which are the user's next
   * action to take. */
  const queuedInFlight = new Set<string>();
  function maybeDispatchQueued(sessionId: string, cause: "turn-ended" | "state" | "backfill" = "state"): void {
    if (queuedInFlight.has(sessionId)) return;
    const state = get();
    const view = state.views[sessionId];
    const composer = state.composers[sessionId];
    const next = composer?.queued[0];
    if (!view || view.turnActive || next === undefined) return;
    const session = state.sessions.find((s) => s.id === sessionId);
    if (session?.externalWriter || session?.turnActive || session?.recovery) return;
    if (session && !session.live && (cause !== "turn-ended" || !session.continuable)) return;
    set({
      composers: {
        ...state.composers,
        [sessionId]: { ...composer, queued: composer!.queued.slice(1) },
      },
    });
    queuedInFlight.add(sessionId);
    void getClient()
      .command("turn.submit", {
        sessionId,
        text: next.text,
        ...(next.intentId !== undefined ? { intentId: next.intentId } : {}),
      })
      .catch((cause: Error) => {
        const current = get().composers[sessionId] ?? {queued: []};
        set({composers: {...get().composers, [sessionId]: {...current, queued:[next, ...current.queued]}}});
        setRunError(sessionId, `queued submission failed: ${cause.message}`);
      })
      .finally(() => queuedInFlight.delete(sessionId));
  }

  /** Fold one record into a view — and let a collapsed lane whose
   * call this record opens unfold itself (run-view-117). The rule
   * lives at the fold, so it holds whether or not the session's tab
   * is shown; folding a lane whose call is already open stands. */
  function fold(
    sessionId: string,
    view: SessionView,
    seq: number,
    record: import("@sublang/spex-core/protocol").TmuxPlayRecord,
    role?: string,
  ): void {
    applyRecord(view, seq, record, role);
    if (hasPresentationHeader(record) && record.type === "player_prompt") {
      get().setLaneCollapsed(sessionId, String(record.playerId), false);
    }
  }

  /** Subscribe and backfill a session's view (idempotent). Live
   * records arriving mid-backfill buffer and apply afterwards, so a
   * reconnect can never lose the gap. */
  async function ensureSubscribed(sessionId: string): Promise<void> {
    const state = get();
    const session = state.sessions.find((s) => s.id === sessionId);
    let view = state.views[sessionId];
    if (!view) {
      view = initialSessionView(session?.players ?? []);
      view.loading = true;
      set({ views: { ...state.views, [sessionId]: view } });
    }
    const pending: {seq: number; record: TmuxPlayRecord; role?: string}[] = [];
    backfilling.set(sessionId, pending);
    try {
      await getClient().subscribe({ kind: "session", sessionId });
      const history = await getClient().command("history.get", {
        sessionId,
        afterSeq: view.lastSeq,
      });
      const fresh = get();
      const target = fresh.views[sessionId];
      if (!target || backfilling.get(sessionId) !== pending) return;
      for (const entry of history.records) {
        if (entry.seq > target.lastSeq) {
          fold(sessionId, target, entry.seq, entry.record, entry.role);
        }
      }
      const buffered = backfilling.get(sessionId) ?? [];
      for (const entry of buffered) {
        if (entry.seq > target.lastSeq) {
          fold(sessionId, target, entry.seq, entry.record, entry.role);
        }
      }
      target.loading = false;
      target.loadError = undefined;
      set({ views: { ...fresh.views, [sessionId]: sessionActivity(target, fresh.sessions.find((s) => s.id === sessionId)) } });
      maybeDispatchQueued(sessionId, "backfill");
    } catch (cause) {
      const failed = get().views[sessionId];
      if (backfilling.get(sessionId) !== pending) return;
      const message = `transcript could not be loaded: ${(cause as Error).message}`;
      if (failed) {
        failed.loading = false;
        failed.loadError = message;
        set({ views: { ...get().views, [sessionId]: sessionActivity(failed, get().sessions.find((s) => s.id === sessionId)) } });
      }
      throw cause;
    } finally {
      if (backfilling.get(sessionId) === pending) backfilling.delete(sessionId);
    }
  }

  function handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "config.state":
        set({ configState: message.state });
        // Config edits flip catalog `configured` flags (DR-015):
        // refresh an already-loaded catalog so the Library stays true.
        if (get().builtins) {
          void get()
            .loadBuiltins()
            .catch(() => {});
        }
        break;
      case "readiness.state":
        set({ readiness: message.entries });
        break;
      case "compile.progress": {
        const progress = get().compileProgress;
        set({
          compileProgress: {
            ...progress,
            [message.playbookId]: [
              ...(progress[message.playbookId] ?? []),
              message.line,
            ],
          },
        });
        break;
      }
      case "session.state": {
        const sessions = get().sessions.filter(
          (session) => session.id !== message.session.id,
        );
        sessions.push(message.session);
        sessions.sort((a, b) => a.createdAt - b.createdAt);
        const view = get().views[message.session.id];
        // The runtime's release at settlement reports the session no
        // longer live: that report still belongs to the turn that ended.
        const wasLive = get().sessions.find((s) => s.id === message.session.id)?.live === true;
        set({ sessions, ...(view ? {
          views: { ...get().views, [message.session.id]: sessionActivity(view, message.session) },
        } : {}) });
        maybeDispatchQueued(message.session.id, wasLive && !message.session.live ? "turn-ended" : "state");
        break;
      }
      case "session.history-replaced":
        if (get().views[message.sessionId]) void get().loadPastSession(message.sessionId, true).catch((error: Error) => setRunError(message.sessionId, error.message));
        break;
      case "session.removed":
        get().forgetSession(message.sessionId, message.projectId);
        break;
      case "intents.changed": {
        // The one fold moved (DR-035): re-pull it, and refresh any
        // loaded History first page for the named projects.
        void get()
          .loadLedger()
          .catch(() => {});
        for (const projectId of message.projectIds) {
          if (get().history[projectId]) {
            void get()
              .loadHistory(projectId)
              .catch(() => {});
          }
        }
        break;
      }
      case "record": {
        const { sessionId, seq, record, role } = message;
        const buffer = backfilling.get(sessionId);
        if (buffer) {
          buffer.push({ seq, record, ...(role !== undefined ? { role } : {}) });
          break;
        }
        const state = get();
        const session = state.sessions.find((s) => s.id === sessionId);
        const view =
          state.views[sessionId] ??
          initialSessionView(session?.players ?? []);
        fold(sessionId, view, seq, record, role);

        const updates: Partial<AppState> = {
          views: { ...state.views, [sessionId]: sessionActivity(view, session) },
        };

        set(updates);
        // Dispatch a queued submission when the turn ends (RUN-8).
        if (
          hasPresentationHeader(record) &&
          (record.type === "turn_finished" || record.type === "turn_aborted")
        ) {
          maybeDispatchQueued(sessionId, "turn-ended");
          // Agents may have rewritten specs during the turn: re-read
          // any loaded tree for this project (DR-011 freshness).
          if (session && get().specTrees[session.projectId]) {
            void get().loadSpecs(session.projectId);
          }
          // The reader is looking at this session: the finish is seen
          // the moment it lands, so the review summons clears (DR-035).
          if (
            record.type === "turn_finished" &&
            sessionId === get().activeSessionId
          ) {
            get().markViewed(sessionId);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  deliver = handleMessage;

  return {
    connection: "closed",
    everConnected: false,
    readiness: [],
    projects: [],
    projectMeta: {},
    machineGraphs: {},
    compileProgress: {},
    sessions: [],
    views: {},
    composers: {},
    runErrors: {},
    workspaceTabs: {},
    openTabs: {},
    railCollapsed: safeStorageGet(RAIL_COLLAPSED_KEY) === "1",
    captainSplit: readCaptainSplit(),
    frameHeights: readFrameHeights(),
    expandedProjects: readExpandedProjects(),
    specTrees: {},
    specErrors: {},
    homeDraft: "",
    history: {},
    stagedIntents: {},
    collapsedLanes: {},
    foldedSources: {},

    connect(url?: string): void {
      const target = url ?? defaultCoreUrl();
      set({ coreUrl: target });
      client = new SpexClient({
        url: target,
        onMessage: handleMessage,
        onStatus: (connection) => {
          set({ connection });
          if (connection === "open") {
            set({ everConnected: true });
            // A failed bootstrap must not present as an empty app
            // (DR-010 §5): surface it with a retry.
            void get()
              .refresh()
              .then(() => set({ refreshError: undefined }))
              .catch((cause: Error) =>
                set({
                  refreshError: `app state failed to load: ${cause.message}`,
                }),
              );
          }
        },
      });
      client.connect();
    },

    async refresh(): Promise<void> {
      const [configState, readiness, projects, sessions] = await Promise.all([
        getClient().command("config.get", {}),
        getClient().command("readiness.get", {}),
        getClient().command("project.list", {}),
        getClient().command("session.list", {}),
      ]);
      const loaded = new Set(Object.keys(get().views));
      for (const old of get().sessions) if (!sessions.some((session) => session.id === old.id)) get().forgetSession(old.id, old.projectId);
      set({ configState, readiness, projects, sessions, views:{} });
      void get().loadLedger();
      void get().loadMachineGraphs();
      for (const project of projects) {
        void get().loadProjectMeta(project.id);
      }
      // A checkout may replace history while disconnected. Reload cached
      // conversations from sequence zero, retaining drafts and queued text.
      const live = sessions.filter((session) => session.live);
      for (const session of sessions.filter((item) => item.live || loaded.has(item.id))) {
        await ensureSubscribed(session.id).catch(() => {});
      }
      // Boot the project context (DR-011): the persisted project when
      // it still exists, else the first live session's project, else
      // any project at all — a workspace holding projects never opens
      // asking which one (run-view-57).
      let current = get().currentProjectId;
      if (!current) {
        const persisted = safeStorageGet(CURRENT_PROJECT_KEY);
        if (persisted && projects.some((p) => p.id === persisted)) {
          current = persisted;
        } else if (live.length > 0) {
          current = live[0].projectId;
        } else {
          current = projects[0]?.id;
        }
        if (current) set({ currentProjectId: current });
      }
      // Bootstrap session activation happens within the current
      // project, never across it.
      const active = get().activeSessionId;
      const inProject = live.filter((s) => s.projectId === current);
      if ((!active || !live.some((s) => s.id === active)) && inProject[0]) {
        set({ activeSessionId: inProject[0].id });
      }
      // A launch opens the current project's live session and nothing
      // else (run-view-57): the sidebar carries the rest.
      if (current && inProject[0]) {
        get().openTab(current, inProject[0].id);
      }
    },

    setCurrentProject(projectId: string | undefined): void {
      set({ currentProjectId: projectId });
      if (projectId) safeStorageSet(CURRENT_PROJECT_KEY, projectId);
    },

    setWorkspaceTab(projectId: string, tab: string): void {
      set({
        workspaceTabs: { ...get().workspaceTabs, [projectId]: tab },
      });
    },

    openTab(projectId: string, sessionId: string): void {
      const open = get().openTabs[projectId] ?? [];
      if (open.includes(sessionId)) return;
      set({
        openTabs: { ...get().openTabs, [projectId]: [...open, sessionId] },
      });
    },

    closeTab(projectId: string, sessionId: string): void {
      const open = get().openTabs[projectId] ?? [];
      const index = open.indexOf(sessionId);
      if (index < 0) return;
      const next = open.filter((id) => id !== sessionId);
      const updates: Partial<AppState> = {
        openTabs: { ...get().openTabs, [projectId]: next },
      };
      // Closing the tab you are looking at lands on a neighbour, never
      // on nothing (run-view-47).
      if (get().workspaceTabs[projectId] === sessionId) {
        const neighbour = next[index] ?? next[index - 1];
        updates.workspaceTabs = {
          ...get().workspaceTabs,
          [projectId]: neighbour ?? "start",
        };
      }
      set(updates);
    },

    setRailCollapsed(collapsed: boolean): void {
      set({ railCollapsed: collapsed });
      safeStorageSet(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
    },

    setCaptainSplit(percent: number): void {
      const clamped = Math.min(
        CAPTAIN_SPLIT_MAX,
        Math.max(CAPTAIN_SPLIT_MIN, Math.round(percent)),
      );
      set({ captainSplit: clamped });
      safeStorageSet(CAPTAIN_SPLIT_KEY, String(clamped));
    },

    setFrameHeight(frameId: string, steps: number): void {
      // The frame owns its bounds and its unit; the store keeps what
      // the reader set and hands it back on the next launch.
      set({ frameHeights: { ...get().frameHeights, [frameId]: steps } });
      safeStorageSet(frameKey(frameId), String(steps));
    },

    toggleProjectExpanded(projectId: string, expanded: boolean): void {
      const next = { ...get().expandedProjects, [projectId]: expanded };
      set({ expandedProjects: next });
      safeStorageSet(EXPANDED_PROJECTS_KEY, JSON.stringify(next));
    },

    setLaneCollapsed(sessionId: string, playerId: string, collapsed: boolean): void {
      const lanes = get().collapsedLanes[sessionId] ?? [];
      if (lanes.includes(playerId) === collapsed) return;
      const next = collapsed
        ? [...lanes, playerId]
        : lanes.filter((id) => id !== playerId);
      set({ collapsedLanes: { ...get().collapsedLanes, [sessionId]: next } });
    },

    setSourcesFolded(projectId: string, folded: boolean): void {
      if ((get().foldedSources[projectId] ?? false) === folded) return;
      set({ foldedSources: { ...get().foldedSources, [projectId]: folded } });
    },

    async addProjectByPath(path: string): Promise<ProjectInfo> {
      try {
        return await get().registerProject(path);
      } catch (cause) {
        // Add means an existing repository: a directory that is none
        // is refused with the way forward, never initialized behind
        // the user's back (projects-1, projects-22).
        if (/not the root of a git work tree/.test((cause as Error).message)) {
          throw new Error(
            `${path} is not the root of a git work tree. To start a new repository there, use Create instead.`,
          );
        }
        throw cause;
      }
    },

    async loadBuiltins(): Promise<void> {
      const { builtins } = await getClient().command("library.builtins", {});
      set({ builtins });
    },

    async openAcademyExample(path?: string): Promise<ProjectInfo> {
      // Same path UX as the palette's typed paths: pass through as
      // written and let the core expand ~ (DR-015 example mode).
      const target = path?.trim() || "~/spex-academy";
      let project: ProjectInfo;
      try {
        project = await getClient().command("project.create", {
          path: target,
          example: true,
        });
      } catch (cause) {
        // A repeat visit: the example is already a registered
        // project — open it instead of surfacing the conflict. The
        // error names the expanded path, which the client cannot
        // derive itself.
        const registered = /^(.*) is already registered$/.exec(
          (cause as Error).message ?? "",
        )?.[1];
        const projects = await getClient().command("project.list", {});
        const existing = registered
          ? projects.find((entry) => entry.path === registered)
          : undefined;
        if (!existing) throw cause;
        set({ projects });
        void get().loadProjectMeta(existing.id);
        get().setCurrentProject(existing.id);
        return existing;
      }
      // Registration happened server-side: mirror the post-create
      // flow of addProjectByPath, then make the example current.
      set({ projects: await getClient().command("project.list", {}) });
      void get().loadProjectMeta(project.id);
      get().setCurrentProject(project.id);
      return project;
    },

    async loadSpecs(projectId: string): Promise<void> {
      try {
        const tree = await getClient().command("specs.get", { projectId });
        const { [projectId]: _, ...errors } = get().specErrors;
        set({
          specTrees: { ...get().specTrees, [projectId]: tree },
          specErrors: errors,
        });
      } catch (cause) {
        set({
          specErrors: {
            ...get().specErrors,
            [projectId]: (cause as Error).message,
          },
        });
      }
    },

    async loadMachineGraphs() {
      const state = get();
      if (state.configState?.status !== "valid") return;
      const playbooks = state.configState.summary?.playbooks ?? [];
      for (const playbook of playbooks) {
        if (playbook.id in get().machineGraphs) continue;
        try {
          const artifacts = (await getClient().command("playbook.artifacts", {
            playbookId: playbook.id,
          })) as { machine?: MachineGraph | null };
          set({
            machineGraphs: {
              ...get().machineGraphs,
              [playbook.id]: artifacts.machine ?? null,
            },
          });
        } catch {
          // A failed fetch records nothing; the card degrades to the
          // observed drawing (run-view-64) and a later config load
          // retries.
        }
      }
    },

    async readSpecRecord(
      projectId: string,
      path: string,
    ): Promise<{ markdown: string; version: string }> {
      const reply = await getClient().command("specs.read", {
        projectId,
        path,
      });
      return { markdown: reply.markdown, version: reply.version };
    },

    async writeSpec(
      projectId: string,
      path: string,
      content: string,
      baseVersion?: string,
    ): Promise<{ version: string }> {
      const reply = await getClient().command("specs.write", {
        projectId,
        path,
        content,
        ...(baseVersion !== undefined ? { baseVersion } : {}),
      });
      return { version: reply.version };
    },

    loadAgentOptions: (adapter) => getClient().command("agent.options", { adapter }),

    async refreshReadiness(): Promise<void> {
      set({ readiness: await getClient().command("readiness.get", {}) });
    },

    async registerProject(path: string): Promise<ProjectInfo> {
      const project = await getClient().command("project.register", { path });
      set({ projects: await getClient().command("project.list", {}) });
      void get().loadProjectMeta(project.id);
      return project;
    },

    async createProject(path: string, scaffold: boolean): Promise<ProjectInfo> {
      const project = await getClient().command("project.create", {
        path,
        scaffold,
      });
      set({ projects: await getClient().command("project.list", {}) });
      void get().loadProjectMeta(project.id);
      return project;
    },

    async removeProject(projectId: string): Promise<void> {
      await getClient().command("project.remove", { projectId });
      set({ projects: await getClient().command("project.list", {}) });
    },

    async loadProjectMeta(projectId: string, refresh = false): Promise<void> {
      const before = get();
      set({
        projectMeta: {
          ...before.projectMeta,
          [projectId]: { ...before.projectMeta[projectId], loading: true },
        },
      });
      const [status, forge] = await Promise.allSettled([
        getClient().command("project.status", { projectId }),
        getClient().command("forge.items", { projectId, refresh }),
      ]);
      const meta: ProjectMeta = { loading: false };
      if (status.status === "fulfilled") meta.status = status.value;
      else meta.statusError = (status.reason as Error).message;
      if (forge.status === "fulfilled") meta.forge = forge.value;
      else meta.forgeError = (forge.reason as Error).message;
      set({ projectMeta: { ...get().projectMeta, [projectId]: meta } });
    },

    async openSession(projectId: string): Promise<SessionInfo> {
      const session = await getClient().command("session.create", {
        projectId,
      });
      const sessions = [
        ...get().sessions.filter((existing) => existing.id !== session.id),
        session,
      ].sort((a, b) => a.createdAt - b.createdAt);
      set({ sessions });
      await get().focusSession(session.id);
      return session;
    },

    async focusSession(sessionId: string): Promise<void> {
      if (!get().views[sessionId]) {
        await ensureSubscribed(sessionId);
      }
      set({ activeSessionId: sessionId });
      // Focusing a session always carries its project context along
      // (DR-011): sidebar rows, Dashboard rows and palette rows route
      // through here, and each puts the session in the working set.
      const session = get().sessions.find((s) => s.id === sessionId);
      if (session) {
        get().setCurrentProject(session.projectId);
        get().openTab(session.projectId, sessionId);
        get().setWorkspaceTab(session.projectId, sessionId);
      }
    },

    async loadPastSession(sessionId: string, force = false): Promise<void> {
      if (force) {
        // Retry after a failed load: the stale view would otherwise
        // short-circuit this into a no-op.
        const { [sessionId]: _, ...views } = get().views;
        set({ views });
        get().clearRunError(sessionId);
      }
      if (!get().views[sessionId]) {
        await ensureSubscribed(sessionId);
      }
    },

    async deleteSession(sessionId: string): Promise<void> {
      const session = get().sessions.find((s) => s.id === sessionId);
      if (session?.externalWriter) throw new Error("Session ownership must be idle before deleting it.");
      await getClient().command("session.delete", { sessionId });
      // The broadcast follows; the reply is proof enough to forget it.
      if (session) get().forgetSession(sessionId, session.projectId);
    },

    async recoverSession(sessionId: string, action: "retry" | "discard"): Promise<void> {
      if (get().sessions.find((session) => session.id === sessionId)?.externalWriter) {
        throw new Error("Session ownership must be idle before recovery.");
      }
      if (action === "retry") {
        await getClient().command("session.retry", { sessionId });
      } else {
        const result = await getClient().command("session.discard", { sessionId });
        const session = get().sessions.find((s) => s.id === sessionId);
        if (result.removed && session) get().forgetSession(sessionId, session.projectId);
        else await get().loadPastSession(sessionId, true);
      }
    },

    forgetSession(sessionId: string, projectId: string): void {
      // The tab first: closing lands the reader on a neighbour, never
      // on nothing (run-view-47).
      get().closeTab(projectId, sessionId);
      backfilling.delete(sessionId);
      const state = get();
      const { [sessionId]: _view, ...views } = state.views;
      const { [sessionId]: _composer, ...composers } = state.composers;
      const { [sessionId]: _error, ...runErrors } = state.runErrors;
      const { [sessionId]: _staged, ...stagedIntents } = state.stagedIntents;
      const { [sessionId]: _lanes, ...collapsedLanes } = state.collapsedLanes;
      set({
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        views,
        composers,
        runErrors,
        stagedIntents,
        collapsedLanes,
        activeSessionId:
          state.activeSessionId === sessionId
            ? undefined
            : state.activeSessionId,
      });
    },

    async submitBossText(sessionId: string, text: string): Promise<void> {
      const state = get();
      const session = state.sessions.find((s) => s.id === sessionId);
      if (session?.externalWriter) throw new Error("Session ownership must be idle before sending a message.");
      if (session?.recovery && !session.turnActive) {
        throw new Error("Recover the interrupted turn before sending another message.");
      }
      const view = state.views[sessionId];
      // A staged intent dispatches with the text that carries it
      // (DR-035); the chip leaves the composer either way — riding
      // the queued entry, or consumed by the submission.
      const staged = state.stagedIntents[sessionId];
      const intentId = staged?.intentId;
      const consumeStaged = () => {
        if (staged) get().clearStagedIntent(sessionId);
      };
      const enqueue = () => {
        const composer = get().composers[sessionId] ?? { queued: [] };
        set({
          composers: {
            ...get().composers,
            [sessionId]: {
              queued: [
                ...composer.queued,
                { text, ...(intentId !== undefined ? { intentId } : {}) },
              ],
            },
          },
        });
        consumeStaged();
      };
      if (session?.live !== false && (session?.turnActive ?? view?.turnActive)) {
        enqueue();
        return;
      }
      try {
        // The runtime is held only for a turn (DR-051): a message to a
        // session that is not live opens it again, and the connection
        // re-subscribed only live sessions, so this one's records need
        // a subscription before the turn they belong to.
        if (session && !session.live) await ensureSubscribed(sessionId);
        await getClient().command("turn.submit", {
          sessionId,
          text,
          ...(intentId !== undefined ? { intentId } : {}),
        });
        consumeStaged();
      } catch (cause) {
        const error = cause as { code?: string; message: string };
        if (error.code === "busy" && session?.live !== false) {
          // The view lagged reality (e.g. right after a reconnect):
          // queueing is what the user meant. An idle session's busy
          // names the sibling still working instead, and is shown as
          // said.
          enqueue();
          return;
        }
        setRunError(sessionId, error.message);
        throw cause;
      }
    },

    async loadLedger(): Promise<void> {
      // Replies apply in request order (dashboard-42): an older read
      // landing after a newer one is discarded, never applied.
      const read = (ledgerReads += 1);
      try {
        const ledger = await getClient().command("ledger.get", {});
        if (read !== ledgerReads) return;
        set({ ledger, ledgerError: undefined });
      } catch (cause) {
        if (read !== ledgerReads) return;
        set({ ledgerError: (cause as Error).message });
      }
    },

    async loadHistory(projectId: string, more = false): Promise<void> {
      const current = get().history[projectId];
      const cursorRow = more
        ? current?.intents[current.intents.length - 1]
        : undefined;
      set({
        history: {
          ...get().history,
          [projectId]: {
            intents: current?.intents ?? [],
            more: current?.more ?? false,
            loading: true,
          },
        },
      });
      try {
        const page = await getClient().command("ledger.history", {
          projectId,
          ...(cursorRow?.intent.closedAt !== undefined
            ? {
                before: {
                  closedAt: cursorRow.intent.closedAt,
                  intentId: cursorRow.intent.id,
                },
              }
            : {}),
        });
        const kept = more ? (get().history[projectId]?.intents ?? []) : [];
        set({
          history: {
            ...get().history,
            [projectId]: {
              intents: [...kept, ...page.intents],
              more: page.more,
            },
          },
        });
      } catch {
        const stale = get().history[projectId];
        if (stale) {
          set({
            history: {
              ...get().history,
              [projectId]: { ...stale, loading: false },
            },
          });
        }
      }
    },

    async queueIntent(input): Promise<IntentInfo> {
      const intent = await getClient().command("intent.queue", input);
      await get().loadLedger();
      return intent;
    },

    async moveIntent(intentId, afterIntentId): Promise<void> {
      await getClient().command("intent.move", { intentId, afterIntentId });
      await get().loadLedger();
    },

    async editIntent(intentId, text): Promise<void> {
      await getClient().command("intent.edit", { intentId, text });
      await get().loadLedger();
    },

    async closeIntent(intentId, as): Promise<void> {
      await getClient().command("intent.close", { intentId, as });
      await get().loadLedger();
    },

    async removeIntent(intentId): Promise<void> {
      await getClient().command("intent.remove", { intentId });
      // The row leaves at once, from every page already loaded — the
      // broadcast that follows re-reads the first page anyway.
      const history = Object.fromEntries(
        Object.entries(get().history).map(([projectId, page]) => [
          projectId,
          {
            ...page,
            intents: page.intents.filter((row) => row.intent.id !== intentId),
          },
        ]),
      );
      set({ history });
      await get().loadLedger();
    },

    async stageDispatch(intent: IntentInfo): Promise<string> {
      const title = intent.text.split(/\r?\n/, 1)[0] ?? intent.text;
      // The project's current conversation is the lane Start reuses
      // (run-view-86, DR-051): its context is the point of a session.
      const current = currentSessionOf(get().sessions, intent.projectId);
      if (current) {
        await get().focusSession(current.id);
        get().setDraft(current.id, intent.text);
        set({
          stagedIntents: {
            ...get().stagedIntents,
            [current.id]: { intentId: intent.id, title },
          },
        });
        return current.id;
      }
      // No conversation yet: stage the Captain home, where sending
      // creates the session in the same motion (run-view-26).
      get().setCurrentProject(intent.projectId);
      get().setWorkspaceTab(intent.projectId, "start");
      get().setHomeDraft(intent.text);
      set({
        stagedIntents: {
          ...get().stagedIntents,
          home: { intentId: intent.id, title },
        },
      });
      return "home";
    },

    clearStagedIntent(key: string): void {
      const { [key]: _, ...rest } = get().stagedIntents;
      set({ stagedIntents: rest });
    },

    markViewed(sessionId: string): void {
      const view = get().views[sessionId];
      const turnId = view?.currentTurnId;
      const session = get().sessions.find((s) => s.id === sessionId);
      const latest =
        typeof turnId === "number" && turnId >= 0
          ? turnId
          : (session?.turns ?? 0) - 1;
      if (latest < 0) return;
      void getClient()
        .command("session.viewed", { sessionId, turnId: latest })
        .catch(() => {});
    },

    removeQueued(sessionId: string, index: number): void {
      const composer = get().composers[sessionId];
      if (!composer) return;
      set({
        composers: {
          ...get().composers,
          [sessionId]: {
            ...composer,
            queued: composer.queued.filter((_, i) => i !== index),
          },
        },
      });
    },

    async abortTurn(sessionId: string): Promise<void> {
      try {
        await getClient().command("turn.abort", { sessionId });
      } catch (cause) {
        setRunError(sessionId, `abort failed: ${(cause as Error).message}`);
      }
    },

    clearRunError(sessionId: string): void {
      const { [sessionId]: _, ...rest } = get().runErrors;
      set({ runErrors: rest });
    },

    setDraft(sessionId: string, draft: string): void {
      const composer = get().composers[sessionId] ?? { queued: [] };
      set({
        composers: {
          ...get().composers,
          [sessionId]: { ...composer, draft },
        },
      });
    },

    setHomeDraft(draft: string): void {
      set({ homeDraft: draft });
    },

    async abortCompile(): Promise<void> {
      const active = get().activeCompile;
      if (!active?.running) return;
      try {
        await getClient().command("compile.abort", {
          playbookId: active.playbookId,
        });
      } catch (cause) {
        const progress = get().compileProgress;
        set({
          compileProgress: {
            ...progress,
            [active.playbookId]: [
              ...(progress[active.playbookId] ?? []),
              `✗ cancel failed: ${(cause as Error).message}`,
            ],
          },
        });
      }
    },

    async runCompile(input): Promise<void> {
      const playbookId = input.playbookId;
      set({
        activeCompile: { playbookId, running: true },
        compileProgress: { ...get().compileProgress, [playbookId]: [] },
      });
      const appendLine = (line: string) => {
        const progress = get().compileProgress;
        set({
          compileProgress: {
            ...progress,
            [playbookId]: [...(progress[playbookId] ?? []), line],
          },
        });
      };
      try {
        // Compiles legitimately run for minutes: no client timeout
        // (DR-010 §5) — a dropped socket still rejects the call.
        await getClient().command("compile.run", input, { timeoutMs: 0 });
        appendLine("✓ compiled and registered — see Configured playbooks");
        set({ activeCompile: { playbookId, running: false, ok: true } });
      } catch (cause) {
        const error = cause as { code?: string; message: string };
        // A user cancel already ends the log with the ◇ line; a busy
        // rejection means this very compile is still running.
        if (error.code === "aborted") {
          set({ activeCompile: { playbookId, running: false, ok: false } });
          return;
        }
        if (error.code === "busy") {
          appendLine(`… ${error.message}`);
          return;
        }
        appendLine(`✗ ${error.message}`);
        set({ activeCompile: { playbookId, running: false, ok: false } });
        throw cause;
      }
    },
  };
});
