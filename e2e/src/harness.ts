// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The journey harness (DR-039): every test boots the real server shell
// on a scratch root — scratch config, scratch state, scratch home —
// with the core's agent seams substituted (server-shell-20), and opens
// the shell's token URL in the browser. The live lane keeps the
// machine's agents and sign-in, redirecting only the state it writes.

import { test as base, expect, type Page } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import type {
  AgentOptions,
  Command,
  CommandResults,
  ServerMessage,
} from "@sublang/spex-core";
import {
  DEMO_CONFIG,
  demoAdapterImports,
  demoCaptain,
  seedDemoHistory,
  seedDemoProject,
  seedHistorySession,
  interruptDemoSession,
  fakeAdapterImports,
} from "@sublang/spex-core/testing";
import {
  startServer,
  type RunningServer,
  type ServerShellOptions,
} from "spex-server/dist/server.js";

export { expect };

/** The live lane: the machine's real adapters and Captain (DR-020). */
export const LIVE = process.env.SPEX_E2E_LIVE === "1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const uiDist = join(repoRoot, "apps", "server", "ui-dist");

export interface AppOptions {
  /**
   * `demo` writes the two-player demo config before boot; `none`
   * leaves the path empty so the core seeds its installed template —
   * the true first run.
   */
  config?: "demo" | "none";
  /** Seed and register the demo project before the browser opens. */
  project?: boolean;
  /** With `project`: this many intents already worked and closed
   * done, written into the state root before boot — a History longer
   * than one intent page with nothing run. */
  history?: number;
  /** The core's environment; readiness derives from it. */
  env?: NodeJS.ProcessEnv;
  /** Serve the Sources band from a substitute forge adapter instead
   * of `gh`: open issues and a pull request carrying ordinary GitHub
   * labels, so a labelled row can be measured hermetically. */
  forge?: boolean;
  /**
   * How long each fake player call stays in flight; long enough to
   * act during a turn, short enough to keep the journey quick.
   */
  agentDelayMs?: number;
  /** Keep the real Captain journal/recovery; substitute only provider replies. */
  realCaptain?: boolean;
  /** Substitute task-free model discovery; never start installed providers. */
  agentOptions?: NonNullable<ServerShellOptions["core"]>["agentOptions"];
}

/** Deliberately omits the demo's current model, exercising retained custom IDs. */
function fixtureAgentOptions(adapter: AgentOptions["adapter"]): AgentOptions {
  return {
    adapter,
    effortValues: ["low", "medium", "high", "max"],
    fastModeSupported: adapter === "claude" || adapter === "codex",
    discovery: {
      status: "available",
      models: adapter === "claude" ? [{
        id: "claude-fable-5-1", name: "Claude Fable 5.1",
        effortValues: ["high", "max"], fastModeSupported: false,
      }] : adapter === "codex" ? [{
        id: "gpt-6-astra", name: "GPT-6 Astra",
        effortValues: ["high", "max"], fastModeSupported: true,
      }] : [],
    },
  };
}

/** The substitute forge's data (dashboard-49): the labels are the
 * ordinary GitHub words a real repository carries. */
const FORGE_FIXTURE = {
  adapter: "github" as const,
  authenticated: true,
  repo: "sublang/demo-project",
  issues: [
    {
      number: 7,
      title: "Token refresh drops the session after ninety seconds",
      url: "https://github.com/sublang/demo-project/issues/7",
      labels: ["documentation", "help wanted", "auth"],
    },
    {
      number: 9,
      title: "The README badge is stale",
      url: "https://github.com/sublang/demo-project/issues/9",
      labels: ["good first issue"],
    },
  ],
  prs: [
    {
      number: 11,
      title: "Tighten the expiry tests",
      url: "https://github.com/sublang/demo-project/pull/11",
      labels: ["dependencies"],
    },
  ],
};

// ---------------------------------------------------------------------------
// A protocol client for arranging state (never for asserting the UI)
// ---------------------------------------------------------------------------

export class CoreClient {
  private readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  private nextId = 0;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data) => {
      this.messages.push(JSON.parse(String(data)) as ServerMessage);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) return resolve();
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
    await this.waitFor((m) => m.type === "hello");
  }

  close(): void {
    this.socket.close();
  }

  async command<T extends Command["type"]>(
    type: T,
    fields: Omit<Extract<Command, { type: T }>, "type" | "id">,
  ): Promise<CommandResults[T]> {
    const id = `e2e${(this.nextId += 1)}`;
    this.socket.send(JSON.stringify({ type, id, ...fields }));
    const reply = await this.waitFor((m) => m.type === "reply" && m.id === id);
    if (reply.type !== "reply") throw new Error("unreachable");
    if (!reply.ok) {
      throw new Error(`${type} failed: ${reply.error.code} ${reply.error.message}`);
    }
    return reply.result as CommandResults[T];
  }

  async waitFor(
    check: (message: ServerMessage) => boolean,
    timeoutMs = 15_000,
  ): Promise<ServerMessage> {
    const start = Date.now();
    for (;;) {
      const found = this.messages.find(check);
      if (found) return found;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timeout; got ${JSON.stringify(this.messages.map((m) => m.type))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

// ---------------------------------------------------------------------------
// The app under test
// ---------------------------------------------------------------------------

export interface App {
  /** The one access URL: origin plus token. */
  url: string;
  origin: string;
  token: string;
  /** Scratch home (hermetic) — readiness and `~` resolve here. */
  home: string;
  dataDir: string;
  configPath: string;
  /** The demo project's path — registered when `project` was asked. */
  projectDir: string;
  projectId?: string;
  /** The shared session store the playbook CLI would write into —
   * scratch in both lanes, so a terminal-run fixture lands where the
   * core serves it (core-service-60). */
  sharedSessionsDir: string;
  server: RunningServer;
  /** Arrange-only protocol client on the running shell. */
  core: CoreClient;
  /** Stop the shell, keeping the root; `start` boots it again on the
   * same port so an open page's origin still reaches it. */
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
  readConfig(): string;
}

async function boot(
  options: ServerShellOptions,
): Promise<{ server: RunningServer; core: CoreClient }> {
  const server = await startServer(options);
  const core = new CoreClient(
    server.url.replace(/^http/, "ws"),
  );
  await core.open();
  return { server, core };
}

export async function startApp(options: AppOptions = {}): Promise<App> {
  const scratch = mkdtempSync(join(tmpdir(), "spex-e2e-"));
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const dataDir = join(scratch, "state");
  const configPath = join(scratch, "config", "playbook.config.yaml");
  mkdirSync(dirname(configPath), { recursive: true });
  if ((options.config ?? "demo") === "demo") {
    writeFileSync(configPath, DEMO_CONFIG);
  }
  const projectDir = join(scratch, "demo-project");
  if (options.project) seedDemoProject(projectDir);
  if (options.project && options.history) {
    await seedDemoHistory(dataDir, projectDir, options.history);
  }
  const token = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  // Both hosts use this explicit isolated Spex home.
  const sharedSessionsDir = join(dataDir, "sessions");
  mkdirSync(sharedSessionsDir, { recursive: true, mode: 0o700 });

  const env = options.env ?? {
    ANTHROPIC_API_KEY: "e2e-fake",
    OPENAI_API_KEY: "e2e-fake",
    SPEX_HOME: dataDir,
  };
  const shellOptions: ServerShellOptions = {
    host: "127.0.0.1",
    port: 0,
    token,
    configPath,
    dataDir,
    legacyDb: join(scratch, "no-legacy.db"),
    insecure: false,
    uiDist,
    core: LIVE
      ? {
          // Real adapters and Captain; only what the run writes is
          // redirected, so the machine's own sessions stay untouched.
          env: { ...process.env, SPEX_HOME: dataDir },
        }
      : {
          adapterImports: options.realCaptain
            ? fakeAdapterImports({ fallback: { result: JSON.stringify({ action: "respond", text: "Acknowledged by the real Captain." }) } }).imports
            : demoAdapterImports({ delayMs: options.agentDelayMs ?? 400 }).imports,
          adapterRuntime: () => ({ usable: true }),
          agentOptions: options.agentOptions ?? (async (adapter) => fixtureAgentOptions(adapter)),
          ...(options.realCaptain ? {} : { captainFactory: async (_composed: unknown, sessionId: string) => demoCaptain(sessionId) }),
          env,
          home,
          ...(options.forge
            ? { forgeAdapter: { state: async () => FORGE_FIXTURE } }
            : {}),
        },
  };

  let running: { server: RunningServer; core: CoreClient } | undefined =
    await boot(shellOptions);
  const live = () => {
    if (!running) throw new Error("the shell is stopped");
    return running;
  };
  const app: App = {
    get url() {
      return live().server.url;
    },
    get origin() {
      return new URL(live().server.url).origin;
    },
    token,
    home,
    dataDir,
    configPath,
    projectDir,
    sharedSessionsDir,
    get server() {
      return live().server;
    },
    get core() {
      return live().core;
    },
    async stop() {
      if (!running) return;
      const port = running.server.port;
      running.core.close();
      await running.server.close();
      running = undefined;
      shellOptions.port = port;
    },
    async start() {
      if (running) return;
      running = await boot(shellOptions);
    },
    async close() {
      await app.stop();
      rmSync(scratch, { recursive: true, force: true });
    },
    readConfig() {
      return existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    },
  };
  if (options.project) {
    const info = await app.core.command("project.register", { path: projectDir });
    app.projectId = info.id;
  }
  return app;
}

/**
 * A session the playbook CLI would have written into the shared store
 * (core-service-60): its captain-session record naming the demo
 * project as the working directory and a replay stream holding one
 * Boss turn. The core adopts it as a terminal-run session, served and
 * deletable (DR-042). Returns the session id.
 */
export async function writeTerminalSession(
  app: App,
  options: { id?: string; prompt?: string } = {},
): Promise<string> {
  const prompt = options.prompt ?? "from the terminal";
  return seedHistorySession(app.sharedSessionsDir, app.projectDir, [
    { type: "turn_started", turnId: 1, turn: { id: 1, prompt }, timestamp: 1000 },
    { type: "captain_reply", turnId: 1, timestamp: 1500, text: "Done from the terminal." },
    { type: "turn_finished", turnId: 1, timestamp: 2000 },
  ], options.id);
}

/** Simulate the durable interruption boundary with every local writer stopped. */
export async function interruptSession(app: App, sessionId: string, input: string): Promise<void> {
  await app.stop();
  await interruptDemoSession(app.sharedSessionsDir, sessionId, input);
  await app.start();
}

// ---------------------------------------------------------------------------
// Fixtures and page helpers
// ---------------------------------------------------------------------------

export const test = base.extend<{ app: App; appOptions: AppOptions }>({
  appOptions: [{}, { option: true }],
  app: async ({ appOptions }, use) => {
    const app = await startApp(appOptions);
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
});

/** Open the app at its token URL and wait for the shell to draw. */
export async function open(page: Page, app: App, path = ""): Promise<void> {
  if (process.env.SPEX_E2E_DEBUG) {
    const tag = `[${app.origin}]`;
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      const stamp = () => performance.now().toFixed(0);
      window.WebSocket = new Proxy(Native, {
        construct(target, args: [string, ...unknown[]]) {
          console.log(`[ws ctor ${stamp()}] ${args[0]}`);
          const socket = new target(...(args as [string]));
          socket.addEventListener("open", () =>
            console.log(`[ws opened ${stamp()}] ${args[0]}`),
          );
          socket.addEventListener("close", (event) =>
            console.log(
              `[ws closed ${stamp()}] ${args[0]} code=${event.code} reason=${event.reason}`,
            ),
          );
          const bag = window as unknown as { __sockets?: unknown[] };
          bag.__sockets ??= [];
          bag.__sockets.push(socket);
          return socket;
        },
      });
      // Log the connection banner's comings and goings against the
      // sockets' ready states, so a status flap shows its cause.
      let shown = false;
      const check = () => {
        const now = !!document.body && document.body.innerText.includes("actions are paused");
        if (now !== shown) {
          shown = now;
          const states = (
            (window as unknown as { __sockets?: { readyState: number }[] })
              .__sockets ?? []
          )
            .map((s) => s.readyState)
            .join(",");
          console.log(`[banner ${stamp()}] ${now ? "shown" : "hidden"} sockets=${states}`);
        }
      };
      new MutationObserver(check).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    page.on("console", (m) => console.log(tag, "console", m.type(), m.text()));
    page.on("websocket", (ws) => {
      console.log(tag, "ws open", ws.url());
      ws.on("close", () => console.log(tag, "ws close", ws.url()));
      ws.on("socketerror", (e) => console.log(tag, "ws error", e));
      ws.on("framesent", (f) => console.log(tag, "->", String(f.payload).slice(0, 120)));
      ws.on("framereceived", (f) =>
        console.log(tag, `<- @${Date.now() % 100000}`, String(f.payload).slice(0, 120)),
      );
    });
  }
  await page.goto(`${app.origin}/${path}?token=${encodeURIComponent(app.token)}`);
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
}

/** The sidebar entry for a surface. */
export function nav(
  page: Page,
  name: "Dashboard" | "Workspace" | "Playbooks" | "Settings",
) {
  return page.getByRole("button", { name, exact: true });
}

/** The Boss composer on the Captain home or in a session (the test
 * ids sit on the textareas themselves). */
export function composer(page: Page) {
  return page.getByTestId("start-composer").or(page.getByTestId("boss-composer"));
}

/** Send composer text and return once the send was accepted. */
export async function send(page: Page, text: string): Promise<void> {
  const box = composer(page);
  await box.fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
