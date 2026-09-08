// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Acceptance coverage for the CORE test package (CORE-19..23):
// end-to-end over the WebSocket protocol against the scripted fake
// adapter — no network, no agent credentials (CORE-18).

import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { Store } from "./store.js";
import { WebSocket } from "ws";
import { openSessionStore, createSessionStore, validateSessionManifest } from "@sublang/playbook/session-store";
import { openSessionHost, loadLaunchPlan, executionConfigFromPlan } from "@sublang/playbook/session-host";

import { CoreService } from "./service.js";
import { templatePath, resolveModulePath, REGISTRY_CONTRACT } from "./config.js";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { fakeAdapterImports, type FakeAdapterStats } from "./testing/fake-adapter.js";
import { createScriptedCaptain } from "./testing/scripted-captain.js";
import type { LineSpawner } from "./compile.js";
import { defaultSpawner } from "./compile.js";
import { stubSlcSource } from "./testing/stub-slc.js";
import type {
  Command,
  CommandResults,
  CompileProgressMessage,
  ReadinessEntry,
  RecordMessage,
  ServerMessage,
  SessionInfo,
  StoredRecord,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const VALID_CONFIG = `
captain:
  adapter: claude
  model: claude-test
players:
  dev.coder:
    adapter: claude
    model: claude-test
playbooks:
  code:
    from: "@sublang/playbook/code/registry"
    roles:
      coder: dev.coder
`;

class Client {
  private readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  private nextId = 0;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/?token=test`);
    this.socket.on("message", (data) => {
      this.messages.push(JSON.parse(String(data)) as ServerMessage);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // The socket may open during an unrelated await between the
      // constructor and this call; 'open' is edge-triggered.
      if (this.socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    await this.waitFor((m) => m.type === "hello");
  }

  close(): void {
    this.socket.close();
  }

  sendRaw(text: string): void {
    this.socket.send(text);
  }

  async command<T extends Command["type"]>(
    type: T,
    fields: Omit<Extract<Command, { type: T }>, "type" | "id">,
  ): Promise<
    | { ok: true; result: CommandResults[T] }
    | { ok: false; error: { code: string; message: string } }
  > {
    const id = `c${(this.nextId += 1)}`;
    this.socket.send(JSON.stringify({ type, id, ...fields }));
    const reply = await this.waitFor(
      (m) => m.type === "reply" && m.id === id,
    );
    if (reply.type !== "reply") throw new Error("unreachable");
    return reply.ok
      ? { ok: true, result: reply.result as CommandResults[T] }
      : { ok: false, error: reply.error };
  }

  async expectOk<T extends Command["type"]>(
    type: T,
    fields: Omit<Extract<Command, { type: T }>, "type" | "id">,
  ): Promise<CommandResults[T]> {
    const reply = await this.command(type, fields);
    if (!reply.ok) {
      throw new Error(`${type} failed: ${reply.error.code} ${reply.error.message}`);
    }
    return reply.result;
  }

  records(channel: "session" | "debug"): RecordMessage[] {
    return this.messages.filter(
      (m): m is RecordMessage => m.type === "record" && m.channel === channel,
    );
  }

  async waitFor(
    check: (message: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage> {
    const start = Date.now();
    for (;;) {
      const found = this.messages.find(check);
      if (found) return found;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timeout waiting; got ${JSON.stringify(this.messages.map((m) => m.type))}`,
        );
      }
      await sleep(10);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  service: CoreService;
  stats: FakeAdapterStats;
  dir: string;
  dataDir: string;
  projectDir: string;
}

async function startHarness(
  configText: string = VALID_CONFIG,
  options: {
    dataDir?: string;
    realShell?: boolean;
    env?: NodeJS.ProcessEnv;
    runCommand?: import("./forge.js").RunCommand;
    compileSpawner?: import("./compile.js").LineSpawner;
    adapterRuntime?: import("./service.js").CoreServiceOptions["adapterRuntime"];
    discoverAgentModels?: import("./service.js").CoreServiceOptions["discoverAgentModels"];
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "spex-core-it-"));
  const configPath = join(dir, "playbook.config.yaml");
  writeFileSync(configPath, configText);
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  execFileSync("git", ["init", "-q", projectDir]);
  const dataDir = options.dataDir ?? join(dir, "state");

  const { imports, stats } = fakeAdapterImports({
    rules: [
      { match: "route:", response: { result: '{"decision":"dispatch"}' } },
      {
        match: "slow:",
        response: { deltas: ["working"], result: "slow done", delayMs: 250 },
      },
    ],
    fallback: {
      deltas: ["hello ", "world"],
      result: "hello world",
      usage: { totalCostUsd: 0.02 },
    },
  });

  const captain = createScriptedCaptain(async (turn, context, session) => {
    await session.emitStatus(`◇ turn ${turn.id}`);
    await context.callCaptain(`route: ${turn.prompt}`, { visibility: "hidden" });
    await context.callPlayer("dev.coder", `${turn.prompt}`);
    await context.emitReply("Finished the scripted turn.");
  });

  const service = await CoreService.start({
    token: "test",
    configPath,
    dataDir,
    adapterImports: imports,
    // DR-024: the fake-adapter harness fakes the readiness runtime half
    // too, so verdicts never depend on the host's installed runtimes.
    adapterRuntime: options.adapterRuntime ?? (() => ({ usable: true })),
    discoverAgentModels: options.discoverAgentModels,
    ...(options.realShell ? {} : {captainFactory: async () => captain}),
    env: options.env ?? {},
    home: join(dir, "home"),
    watchConfig: false,
    ...(options.runCommand ? { runCommand: options.runCommand } : {}),
    ...(options.compileSpawner
      ? { compileSpawner: options.compileSpawner }
      : {}),
  });
  return { service, stats, dir, dataDir, projectDir };
}

// ---------------------------------------------------------------------------
// CORE-19: end-to-end session over the protocol
// ---------------------------------------------------------------------------

test("CORE-19: fake-adapter session end to end over the WebSocket", async () => {
  const harness = await startHarness();
  const client = new Client(harness.service.port());
  await client.open();

  const hello = client.messages[0];
  assert.equal(hello.type, "hello");

  const project = await client.expectOk("project.register", {
    path: harness.projectDir,
  });
  const session = await client.expectOk("session.create", {
    projectId: project.id,
  });
  assert.deepEqual(
    session.players.map((p) => p.id),
    ["dev.coder"],
  );

  await client.expectOk("subscribe", {
    channel: { kind: "session", sessionId: session.id },
  });

  await client.expectOk("turn.submit", {
    sessionId: session.id,
    text: "slow: build the feature",
  });

  // A second submission during the active turn is rejected busy.
  const busy = await client.command("turn.submit", {
    sessionId: session.id,
    text: "another",
  });
  assert.ok(!busy.ok && busy.error.code === "busy");

  await client.waitFor(
    (m) => m.type === "record" && m.record.type === "turn_finished",
  );

  const sessionRecords = client.records("session");
  // The runtime cwd is the project directory, observed by the adapter.
  assert.ok(
    harness.stats.runs.every((run) => run.cwd === harness.projectDir),
    `adapter cwds: ${JSON.stringify(harness.stats.runs.map((r) => r.cwd))}`,
  );
  // Script-ordered, seq-ascending, no hidden records on the session channel.
  const seqs = sessionRecords.map((m) => m.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  const types = sessionRecords.map((m) => m.record.type);
  assert.equal(types[0], "turn_started");
  assert.ok(types.includes("captain_status"));
  assert.ok(types.includes("player_prompt"));
  assert.ok(types.includes("player_event"));
  assert.ok(types.includes("player_finished"));
  assert.equal(types[types.length - 1], "turn_finished");
  assert.ok(!types.includes("captain_prompt"), "hidden records leaked");

  // No network: every event came from the fake adapter.
  const playerEvents = sessionRecords.filter(
    (m) => m.record.type === "player_event",
  );
  assert.ok(playerEvents.length > 0);
  for (const message of playerEvents) {
    const event = (message.record as { event: { agent: string } }).event;
    assert.equal(event.agent, "fake");
  }

  client.close();
  await harness.service.stop();
});

// ---------------------------------------------------------------------------
// CORE-20: hidden records only on the debug channel
// ---------------------------------------------------------------------------

test("CORE-20: hidden records reach only debug subscribers", async () => {
  const harness = await startHarness();
  const sessionClient = new Client(harness.service.port());
  const debugClient = new Client(harness.service.port());
  await sessionClient.open();
  await debugClient.open();

  const project = await sessionClient.expectOk("project.register", {
    path: harness.projectDir,
  });
  const session = await sessionClient.expectOk("session.create", {
    projectId: project.id,
  });
  await sessionClient.expectOk("subscribe", {
    channel: { kind: "session", sessionId: session.id },
  });
  await debugClient.expectOk("subscribe", {
    channel: { kind: "debug", sessionId: session.id },
  });

  await sessionClient.expectOk("turn.submit", {
    sessionId: session.id,
    text: "do something",
  });
  await sessionClient.waitFor(
    (m) => m.type === "record" && m.record.type === "turn_finished",
  );
  await debugClient.waitFor(
    (m) => m.type === "record" && m.record.type === "captain_finished",
  );

  const visibleTypes = sessionClient
    .records("session")
    .map((m) => m.record.type);
  assert.ok(!visibleTypes.includes("captain_prompt"));
  assert.ok(!visibleTypes.includes("captain_event"));

  const debugRecords = debugClient.records("debug");
  const debugTypes = [...new Set(debugRecords.map((m) => m.record.type))].sort();
  assert.deepEqual(debugTypes, [
    "captain_event",
    "captain_finished",
    "captain_prompt",
  ]);
  for (const message of debugRecords) {
    assert.equal(
      (message.record as { visibility?: string }).visibility,
      "hidden",
    );
  }

  sessionClient.close();
  debugClient.close();
  await harness.service.stop();
});

// ---------------------------------------------------------------------------
// CORE-21: launcher fail-closed defect classes rejected identically
// ---------------------------------------------------------------------------

const DEFECT_CONFIGS: { name: string; pattern: RegExp; config: string }[] = [
  {
    name: "missing from",
    pattern: /playbooks\.code\.from must be a module specifier/,
    config: VALID_CONFIG.replace('    from: "@sublang/playbook/code/registry"\n', ""),
  },
  {
    name: "import failure",
    pattern: /failed to import/,
    config: VALID_CONFIG.replace(
      "@sublang/playbook/code/registry",
      "@sublang/definitely-missing",
    ),
  },
  {
    name: "key/manifest id mismatch",
    pattern: /key must equal the module manifest id "code"/,
    config: VALID_CONFIG.replace("  code:", "  wrong:"),
  },
  {
    name: "reserved captain role",
    pattern: /roles\.captain binds local role "captain"/,
    config: VALID_CONFIG.replace(
      "      coder: dev.coder\n",
      "      coder: dev.coder\n      captain: dev.coder\n",
    ),
  },
  {
    name: "unresolved required role",
    pattern: /roles must exactly cover requiredRoleIds; missing reviewer/,
    config:
      VALID_CONFIG +
      `  review:
    from: "@sublang/playbook/review/registry"
    roles:
      coder: dev.coder
`,
  },
  {
    name: "bindings miss a required role",
    pattern: /roles must exactly cover requiredRoleIds/,
    config: VALID_CONFIG.replace("    roles:\n      coder: dev.coder\n", "    roles: {}\n"),
  },
  {
    name: "a binding names an absent player",
    pattern: /names absent session player/,
    config: VALID_CONFIG.replace("coder: dev.coder", "coder: dev.missing"),
  },
  {
    name: "the removed per-playbook players block",
    pattern: /was removed in the explicit-session-player major release/,
    config: VALID_CONFIG.replace(
      "    roles:\n      coder: dev.coder\n",
      "    players:\n      coder:\n        adapter: claude\n",
    ),
  },
  {
    name: "unknown adapter",
    pattern: /Unknown adapter "mystery" for players\.dev\.coder/,
    config: VALID_CONFIG.replace(
      "players:\n  dev.coder:\n    adapter: claude\n    model: claude-test",
      "players:\n  dev.coder:\n    adapter: mystery",
    ),
  },
  {
    name: "adapter-scoped invalid effort",
    pattern: /effort "extreme" is not supported by the "claude" adapter/,
    config: VALID_CONFIG.replace(
      "    model: claude-test\n",
      "    model: claude-test\n    effort: extreme\n",
    ),
  },
];

test("CORE-21: each launcher defect class yields a named config error and blocks sessions", async () => {
  for (const defect of DEFECT_CONFIGS) {
    const harness = await startHarness(defect.config);
    const client = new Client(harness.service.port());
    await client.open();

    const state = await client.expectOk("config.get", {});
    assert.equal(state.status, "invalid", defect.name);
    if (state.status === "invalid") {
      assert.match(state.errors.join("; "), defect.pattern, defect.name);
    }

    const project = await client.expectOk("project.register", {
      path: harness.projectDir,
    });
    const rejected = await client.command("session.create", {
      projectId: project.id,
    });
    assert.ok(
      !rejected.ok && rejected.error.code === "invalid_config",
      defect.name,
    );

    client.close();
    await harness.service.stop();
  }
});

// ---------------------------------------------------------------------------
// CORE-22: restart persistence
// ---------------------------------------------------------------------------

test("CORE-22: records, order, and usage survive a service restart", async () => {
  const harness = await startHarness();
  const client = new Client(harness.service.port());
  await client.open();

  const project = await client.expectOk("project.register", {
    path: harness.projectDir,
  });
  const session = await client.expectOk("session.create", {
    projectId: project.id,
  });
  await client.expectOk("subscribe", {
    channel: { kind: "session", sessionId: session.id },
  });
  await client.expectOk("turn.submit", { sessionId: session.id, text: "go" });
  await client.waitFor(
    (m) => m.type === "record" && m.record.type === "turn_finished",
  );
  // The runtime is held only for a turn (core-service-91): settlement
  // releases it, the Captain's disposal trace reaching the session
  // channel outside any turn, and the session lists as no longer live.
  await client.waitFor(
    (m) => m.type === "session.state" && m.session.id === session.id &&
      m.session.turns === 1 && m.session.live === false,
  );
  assert.ok(client.records("session").some(({ record }) =>
    record.type === "captain_telemetry" && record.topic === "playbook.trace" &&
    (record.payload as { type?: string }).type === "session.disposed" &&
    (record as { turnId?: number | null }).turnId === null,
  ), "release delivers the Captain's disposal trace to the session channel");

  const before = await client.expectOk("history.get", {
    sessionId: session.id,
  });
  const usageBefore = await client.expectOk("usage.get", {
    sessionId: session.id,
  });
  client.close();
  await harness.service.stop();

  const restarted = await CoreService.start({
    token: "test",
    configPath: join(harness.dir, "playbook.config.yaml"),
    dataDir: harness.dataDir,
    env: {},
    home: join(harness.dir, "home"),
    watchConfig: false,
  });
  const client2 = new Client(restarted.port());
  await client2.open();

  const sessions = await client2.expectOk("session.list", {});
  const recovered = sessions.find((s: SessionInfo) => s.id === session.id);
  assert.ok(recovered, "session survives restart");
  assert.equal(recovered.live, false, "a released session stays not live across restart");

  const after = await client2.expectOk("history.get", {
    sessionId: session.id,
  });
  // Content and order, whole (core-service-22): payloads, roles, and
  // timestamps replay byte-identical, not just seq and type.
  assert.deepEqual(after.records, before.records);
  assert.deepEqual(
    await client2.expectOk("usage.get", { sessionId: session.id }),
    usageBefore,
  );

  client2.close();
  await restarted.stop();
});

// ---------------------------------------------------------------------------
// CORE-23: readiness reporting
// ---------------------------------------------------------------------------

const READINESS_CONFIG = `
captain:
  adapter: gemini
players:
  dev.coder:
    adapter: claude
    model: claude-test
  dev.reviewer:
    adapter: codex
  dev.unused:
    adapter: kimi
playbooks:
  code:
    from: "@sublang/playbook/code/registry"
    roles:
      coder: dev.coder
  review:
    from: "@sublang/playbook/review/registry"
    roles:
      coder: dev.coder
      reviewer: dev.reviewer
`;

test("CORE-23: readiness is adapter-keyed with positions and requirements", async () => {
  const harness = await startHarness(READINESS_CONFIG, {
    env: { ANTHROPIC_API_KEY: "test-key" },
  });
  const client = new Client(harness.service.port());
  await client.open();

  const readiness = await client.expectOk("readiness.get", {});
  // dev.unused is never bound, so its adapter never gates a run
  // (DR-032): three adapters are configured, two are referenced, and
  // the captain's makes the third entry.
  assert.equal(readiness.length, 3, "one entry per adapter in use");
  const byAdapter = new Map(
    readiness.map((entry: ReadinessEntry) => [entry.adapter, entry]),
  );
  assert.equal(byAdapter.get("claude")?.ready, true);
  // A position is a player lane and the roles it serves.
  assert.deepEqual(byAdapter.get("claude")?.usedBy, [
    "dev.coder (code.coder, review.coder)",
  ]);
  assert.equal(byAdapter.get("codex")?.ready, false);
  assert.match(byAdapter.get("codex")?.requirement ?? "", /OPENAI_API_KEY/);
  assert.deepEqual(byAdapter.get("codex")?.usedBy, [
    "dev.reviewer (review.reviewer)",
  ]);
  assert.ok(
    !readiness.some((entry: ReadinessEntry) => entry.adapter === "kimi"),
    "an unbound player never enters the readiness gate",
  );
  // No preflight rule for gemini: unknown, verify yourself.
  assert.equal(byAdapter.get("gemini")?.ready, null);
  assert.deepEqual(byAdapter.get("gemini")?.usedBy, ["captain"]);

  client.close();
  await harness.service.stop();
});

test("settings-36: model discovery uses the captured environment without opening sessions or changing config", async (t) => {
  const env = { ANTHROPIC_API_KEY: "test-key", SPEX_OPTIONS_TEST: "captured environment" };
  const calls: string[] = [];
  const discovered = {
    status: "available" as const,
    models: [{ id: "claude-fable-5-1", name: "Claude Fable 5.1", effortValues: ["high", "max"], fastModeSupported: false }],
  };
  const harness = await startHarness(VALID_CONFIG, {
    env,
    discoverAgentModels: async (adapter, options) => {
      assert.equal(options.env, env, "discovery receives the shell-supplied environment");
      assert.equal(options.timeoutMs, 10_000, "the real reader bounds discovery to ten seconds");
      calls.push(adapter);
      if (adapter === "claude") return discovered;
      if (adapter === "codex") throw new Error("Fixture discovery failed");
      return { status: "unavailable", reason: "Fixture runtime is offline" };
    },
  });
  const client = new Client(harness.service.port());
  t.after(async () => { client.close(); await harness.service.stop(); rmSync(harness.dir, { recursive: true, force: true }); });
  await client.open();
  assert.equal((await client.expectOk("config.get", {})).status, "valid");
  await client.expectOk("config.edit", { op: { kind: "captain.set", patch: { instruction: "Before discovery" } } });
  assert.deepEqual(calls, [], "startup, config reads and saves do not discover models");

  const configPath = join(harness.dir, "playbook.config.yaml");
  const configBefore = readFileSync(configPath, "utf8");
  const sessionsDir = join(harness.dataDir, "sessions");
  const filesBefore = readdirSync(sessionsDir).sort();
  assert.deepEqual(await client.expectOk("agent.options", { adapter: "claude" }), {
    adapter: "claude", effortValues: ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"],
    orchestrationValues: ["ultracode"], fastModeSupported: true, discovery: discovered,
  });
  assert.deepEqual(await client.expectOk("agent.options", { adapter: "codex" }), {
    adapter: "codex", effortValues: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    orchestrationValues: ["ultra"], fastModeSupported: true,
    discovery: { status: "unavailable", reason: "Fixture discovery failed" },
  });
  assert.deepEqual(await client.expectOk("agent.options", { adapter: "gemini" }), {
    adapter: "gemini", effortValues: ["minimal", "low", "medium", "high", "xhigh", "max"],
    orchestrationValues: [], fastModeSupported: false,
    discovery: { status: "unavailable", reason: "Fixture runtime is offline" },
  });
  client.sendRaw(JSON.stringify({ type: "agent.options", id: "unknown-adapter", adapter: "unknown" }));
  const rejected = await client.waitFor((m) => m.type === "reply" && m.id === "unknown-adapter");
  assert.ok(rejected.type === "reply" && !rejected.ok);
  assert.equal(rejected.error.code, "invalid_message");
  assert.deepEqual(calls, ["claude", "codex", "gemini"], "unknown adapters never enter discovery");
  assert.equal(readFileSync(configPath, "utf8"), configBefore);
  assert.deepEqual(readdirSync(sessionsDir).sort(), filesBefore);
  assert.deepEqual(await client.expectOk("session.list", {}), []);
  assert.equal(harness.stats.runs.length, 0, "discovery submits no agent task");

  await client.expectOk("config.edit", { op: { kind: "captain.set", patch: { model: "manual-unlisted-model" } } });
  assert.match(readFileSync(configPath, "utf8"), /manual-unlisted-model/);
  assert.equal((await client.expectOk("config.get", {})).status, "valid");
  assert.deepEqual(calls, ["claude", "codex", "gemini"], "unavailable discovery does not gate config editing");
});

test("playbook-library-39: role binding edits preserve tuning and distinguish disabled from inherited fast mode", async (t) => {
  const config = VALID_CONFIG
    .replace("    model: claude-test\nplaybooks:", "    model: claude-test\n    fastMode: true\nplaybooks:")
    .replace("      coder: dev.coder", `      coder: # role comment
        player: dev.coder
        model: role-model # model comment
        effort: high # effort comment
        fastMode: false # explicit disabled`).trimStart();
  const harness = await startHarness(config);
  const client = new Client(harness.service.port());
  t.after(async () => { client.close(); await harness.service.stop(); rmSync(harness.dir, { recursive: true, force: true }); });
  await client.open();
  const path = join(harness.dir, "playbook.config.yaml");
  const readRole = () => parseYaml(readFileSync(path, "utf8")).playbooks.code.roles.coder;
  const base = { kind: "playbook.role.bind" as const, playbookId: "code", role: "coder", playerId: "dev.coder" };
  const untouched = config.slice(0, config.indexOf("playbooks:"));

  await client.expectOk("config.edit", { op: base });
  assert.deepEqual(readRole(), { player: "dev.coder", model: "role-model", effort: "high", fastMode: false });
  await client.expectOk("config.edit", { op: { ...base, model: "another-role-model" } });
  assert.deepEqual(readRole(), { player: "dev.coder", model: "another-role-model", effort: "high", fastMode: false });
  const retained = readFileSync(path, "utf8");
  for (const comment of ["# role comment", "# model comment", "# effort comment", "# explicit disabled"]) assert.ok(retained.includes(comment), comment);
  assert.equal(retained.slice(0, retained.indexOf("playbooks:")), untouched);

  for (const fastMode of [true, false, null] as const) {
    await client.expectOk("config.edit", { op: { ...base, fastMode } });
    assert.deepEqual(readRole(), {
      player: "dev.coder", model: "another-role-model", effort: "high",
      ...(fastMode === null ? {} : { fastMode }),
    });
    const state = await client.expectOk("config.get", {});
    assert.ok(state.status === "valid");
    assert.equal(state.summary.playbooks[0].roles.coder.fastMode, fastMode ?? undefined);
    assert.equal(state.summary.players[0].agent.fastMode, true, "the player's default stays unchanged");
  }

  // Promote a real shorthand without losing its comment; false must not
  // be mistaken for an absent override against this fast-enabled player.
  writeFileSync(path, config.replace(/      coder:[\s\S]*$/, "      coder: dev.coder # shorthand comment\n"));
  await harness.service.reloadConfig();
  await client.expectOk("config.edit", { op: { ...base, fastMode: false } });
  assert.deepEqual(readRole(), { player: "dev.coder", fastMode: false });
  assert.match(readFileSync(path, "utf8"), /# shorthand comment/);

  // Invalid user data must be refused intact, not silently dropped by
  // rebuilding a role block from only the fields this editor knows.
  const invalid = readFileSync(path, "utf8").replace("        fastMode: false", "        unknownTuning: keep-me\n        fastMode: false");
  writeFileSync(path, invalid);
  const refused = await client.command("config.edit", { op: { ...base, effort: "low" } });
  assert.ok(!refused.ok && refused.error.code === "invalid_config");
  assert.match(refused.error.message, /unknownTuning/);
  assert.equal(readFileSync(path, "utf8"), invalid);
  assert.equal(harness.stats.runs.length, 0);
});

test("a reload superseded while probing broadcasts no stale readiness", async () => {
  // The race: an older reload snapshots one config, waits on a slow
  // runtime probe, and would broadcast after a newer reload for a changed
  // config already has — leaving clients holding readiness for the wrong
  // configuration. The superseded reload must discard its result instead.
  let gate: Promise<void> | undefined;
  let openGate = (): void => {};
  const harness = await startHarness(VALID_CONFIG, {
    env: { ANTHROPIC_API_KEY: "test-key" },
    adapterRuntime: async () => {
      if (gate) await gate;
      return { usable: true };
    },
  });
  const client = new Client(harness.service.port());
  await client.open();
  const configPath = join(harness.dir, "playbook.config.yaml");
  const readinessBroadcasts = () =>
    client.messages.filter((message) => message.type === "readiness.state");
  const baseline = readinessBroadcasts().length;

  // Older reload: probes block on the gate after its config commit.
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const older = harness.service.reloadConfig();
  // Newer reload: the config now uses a different adapter set, and its
  // probes must not block — reopen the gate for it only after the older
  // reload is already parked on it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  writeFileSync(configPath, READINESS_CONFIG);
  gate = undefined;
  await harness.service.reloadConfig();
  // Broadcast delivery is asynchronous; wait for it rather than sampling.
  await client.waitFor(
    (message) => message.type === "readiness.state",
  );
  const afterNewer = readinessBroadcasts();
  assert.equal(afterNewer.length, baseline + 1, "newer reload broadcast once");
  const newest = afterNewer.at(-1) as { entries: ReadinessEntry[] };
  assert.deepEqual(
    newest.entries.map((entry) => entry.adapter).sort(),
    ["claude", "codex", "gemini"],
    "broadcast readiness is the newer config's",
  );

  // Release the older reload; it must commit nothing.
  openGate();
  await older;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    readinessBroadcasts().length,
    baseline + 1,
    "the superseded reload broadcast nothing",
  );
  client.close();
  await harness.service.stop();
});

// ---------------------------------------------------------------------------
// CORE-28: readiness deduplication across positions
// ---------------------------------------------------------------------------

test("CORE-28: the starter template yields one readiness entry per adapter it names", async () => {
  // The template is the installed playbook's own (core-service-3), so
  // the expectation derives from it rather than restating a roster.
  const template = readFileSync(templatePath(), "utf8");
  const parsed = (await import("yaml")).parse(template) as {
    captain: { adapter: string };
    players: Record<string, { adapter: string }>;
  };
  const adapters = [
    ...new Set([parsed.captain.adapter, ...Object.values(parsed.players).map((p) => p.adapter)]),
  ].sort();
  const harness = await startHarness(template, {
    env: { ANTHROPIC_API_KEY: "test-key", OPENAI_API_KEY: "test-key" },
  });
  const client = new Client(harness.service.port());
  await client.open();

  const readiness = await client.expectOk("readiness.get", {});
  // One entry per adapter; its positions are the captain and each
  // referenced lane with the roles it serves (DR-032).
  assert.deepEqual(readiness.map((entry) => entry.adapter).sort(), adapters);
  const captainEntry = readiness.find((entry) => entry.adapter === parsed.captain.adapter);
  assert.ok(captainEntry?.usedBy.includes("captain"));
  for (const [id, player] of Object.entries(parsed.players)) {
    const entry = readiness.find((e) => e.adapter === player.adapter);
    assert.ok(entry?.usedBy.some((position) => position.startsWith(`${id} (`)), `${id} listed`);
  }

  // A config edit pushes readiness.state with the entries payload.
  await client.expectOk("config.edit", {
    op: { kind: "theme.set", theme: "dark" },
  });
  const pushed = await client.waitFor((m) => m.type === "readiness.state");
  if (pushed.type === "readiness.state") {
    assert.ok(Array.isArray(pushed.entries));
    assert.ok(adapters.includes(pushed.entries[0]?.adapter as string));
  }

  client.close();
  await harness.service.stop();
});

const SHORTHAND_CONFIG = `
captain: claude
players:
  dev.coder: claude
  dev.reviewer: codex
playbooks:
  code:
    from: "@sublang/playbook/code/registry"
    roles:
      coder: dev.coder
  review:
    from: "@sublang/playbook/review/registry"
    roles:
      coder: dev.coder
      reviewer: dev.reviewer
`;

test("CORE-28: scalar shorthands compose and share adapter entries", async () => {
  const harness = await startHarness(SHORTHAND_CONFIG, {
    env: { ANTHROPIC_API_KEY: "test-key" },
  });
  const client = new Client(harness.service.port());
  await client.open();

  // A scalar reads as its adapter's defaults (bare-adapter block).
  const state = await client.expectOk("config.get", {});
  assert.equal(state.status, "valid");
  if (state.status === "valid") {
    assert.deepEqual(state.summary.captain, { adapter: "claude" });
    // A scalar player reads as its adapter's defaults, and the
    // reviewer role binds to that lane (DR-032).
    const reviewer = state.summary.players.find(
      (player) => player.id === "dev.reviewer",
    );
    assert.deepEqual(reviewer?.agent, { adapter: "codex" });
    assert.equal(reviewer?.display, "codex");
    assert.deepEqual(reviewer?.boundBy, ["review.reviewer"]);
    assert.equal(
      state.summary.playbooks[1].roles.reviewer.playerId,
      "dev.reviewer",
    );
    // dev.coder answers both playbooks: one lane, one conversation.
    const coder = state.summary.players.find(
      (player) => player.id === "dev.coder",
    );
    assert.deepEqual(coder?.boundBy, ["code.coder", "review.coder"]);
  }

  const readiness = await client.expectOk("readiness.get", {});
  // The captain and the coder are both "claude": one deduped entry.
  const claude = readiness.filter(
    (entry: ReadinessEntry) => entry.adapter === "claude",
  );
  assert.equal(claude.length, 1);
  assert.equal(claude[0].ready, true);
  assert.deepEqual(claude[0].usedBy, [
    "captain",
    "dev.coder (code.coder, review.coder)",
  ]);
  const codex = readiness.find(
    (entry: ReadinessEntry) => entry.adapter === "codex",
  );
  assert.equal(codex?.ready, false);
  assert.match(codex?.requirement ?? "", /OPENAI_API_KEY/);

  client.close();
  await harness.service.stop();
});

// ---------------------------------------------------------------------------
// CORE-27: compile busy rejection and cancellation
// ---------------------------------------------------------------------------

/** Compile spawner whose slc run hangs until its signal aborts,
 * mirroring how node:child_process spawn honors { signal }. */
function hangingCompileSpawner(): LineSpawner {
  return (command, args, cwd, onLine, signal) => {
    if (args[0] === "--version") {
      onLine("v24.0.0");
      return Promise.resolve(0);
    }
    onLine("slc: working");
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error("The operation was aborted"));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  };
}

const COMPILE_INPUT = {
  playbookId: "demo",
  sourceText: "# Demo\n\nA one-player demo workflow.\n",
  roles: ["helper"],
  command: "demo",
  intent: "demo workflow for tests",
  bindings: { helper: "dev.helper" },
  newPlayers: { "dev.helper": { adapter: "claude" } },
};

test("CORE-27: a second compile.run for the same playbook rejects busy", async () => {
  const harness = await startHarness(VALID_CONFIG, {
    env: { SPEX_SLC: "fake-slc" },
    compileSpawner: hangingCompileSpawner(),
  });
  const client = new Client(harness.service.port());
  await client.open();

  const first = client.command("compile.run", COMPILE_INPUT);
  await client.waitFor(
    (m) => m.type === "compile.progress" && m.line === "slc: working",
  );
  const second = await client.command("compile.run", COMPILE_INPUT);
  assert.ok(!second.ok, "duplicate compile must be rejected");
  if (!second.ok) {
    assert.equal(second.error.code, "busy");
    assert.match(second.error.message, /already running for demo/);
  }

  // Cancel so the pending first command settles before teardown.
  await client.expectOk("compile.abort", { playbookId: "demo" });
  const firstReply = await first;
  assert.ok(!firstReply.ok && firstReply.error.code === "aborted");

  client.close();
  await harness.service.stop();
});

test("CORE-27: compile.abort cancels the run; the ◇ line closes progress", async () => {
  const harness = await startHarness(VALID_CONFIG, {
    env: { SPEX_SLC: "fake-slc" },
    compileSpawner: hangingCompileSpawner(),
  });
  const client = new Client(harness.service.port());
  await client.open();

  // Aborting with nothing in flight is a not_found.
  const idle = await client.command("compile.abort", { playbookId: "demo" });
  assert.ok(!idle.ok && idle.error.code === "not_found");

  const pending = client.command("compile.run", COMPILE_INPUT);
  await client.waitFor(
    (m) => m.type === "compile.progress" && m.line === "slc: working",
  );
  await client.expectOk("compile.abort", { playbookId: "demo" });

  const reply = await pending;
  assert.ok(!reply.ok, "aborted compile must not report success");
  if (!reply.ok) {
    assert.equal(reply.error.code, "aborted");
    assert.equal(reply.error.message, "compile canceled");
  }

  // Give any stray post-abort output a beat to arrive, then assert
  // the canceled marker is the final progress line.
  await sleep(50);
  const progress = client.messages.filter(
    (m): m is CompileProgressMessage => m.type === "compile.progress",
  );
  assert.ok(progress.length > 0);
  assert.equal(progress[progress.length - 1].line, "◇ compile canceled");

  // The slot is free again: a new compile is accepted (not busy).
  const again = client.command("compile.run", COMPILE_INPUT);
  await client.waitFor(
    (m) =>
      m.type === "compile.progress" &&
      m.line === "slc: working" &&
      client.messages.filter(
        (n) => n.type === "compile.progress" && n.line === "slc: working",
      ).length >= 2,
  );
  await client.expectOk("compile.abort", { playbookId: "demo" });
  const againReply = await again;
  assert.ok(!againReply.ok && againReply.error.code === "aborted");

  client.close();
  await harness.service.stop();
});

// ---------------------------------------------------------------------------
// PROJ-16..19: registration validation, create flow, stubbed forge, removal
// ---------------------------------------------------------------------------

test("PROJ: work-tree validation, create flow, forge states, removal", async () => {
  const { defaultRunCommand } = await import("./forge.js");
  const ghStub: import("./forge.js").RunCommand = async (command, args, cwd) => {
    if (command !== "gh") return defaultRunCommand(command, args, cwd);
    if (args[0] === "auth") return { code: 0, stdout: "ok", stderr: "" };
    return {
      code: 0,
      stdout: JSON.stringify([
        { number: 3, title: "Stub item", url: "https://github.com/o/r/issues/3" },
      ]),
      stderr: "",
    };
  };
  const harness = await startHarness(VALID_CONFIG, { runCommand: ghStub });
  const client = new Client(harness.service.port());
  await client.open();

  // Non-repo directory is rejected with guidance (PROJ-1).
  const plain = join(harness.dir, "plain");
  mkdirSync(plain);
  const rejected = await client.command("project.register", { path: plain });
  assert.ok(!rejected.ok && rejected.error.code === "invalid_request");
  assert.match(rejected.error.message, /git work tree/);

  // Create flow produces a registered, statusable repo (PROJ-2/3).
  const created = await client.expectOk("project.create", {
    path: join(harness.dir, "fresh"),
  });
  const status = await client.expectOk("project.status", {
    projectId: created.id,
  });
  assert.ok(status.branch.length > 0);
  assert.equal(status.dirty, false);

  // Forge state via the stubbed gh (PROJ-5/6): bind an origin first.
  execFileSync("git", [
    "-C",
    created.path,
    "remote",
    "add",
    "origin",
    "https://github.com/sublang-ai/demo.git",
  ]);
  const forge = await client.expectOk("forge.items", {
    projectId: created.id,
    refresh: true,
  });
  assert.equal(forge.authenticated, true);
  assert.equal(forge.repo, "sublang-ai/demo");
  assert.equal(forge.issues[0]?.number, 3);

  // Removal keeps the repo on disk (PROJ-8/19).
  await client.expectOk("project.remove", { projectId: created.id });
  assert.ok(existsSync(join(created.path, ".git")));

  client.close();
  await harness.service.stop();
});

// ---------------------------------------------------------------------------
// Real Playbook Captain shell through the Spex pipeline (DR-003):
// registry loading via the injected module loader, player binding,
// visible replies, and pane visibility — no LLM, no network.
// ---------------------------------------------------------------------------

test("real captain shell: a Boss turn round-trips the captain reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spex-shell-it-"));
  const configPath = join(dir, "playbook.config.yaml");
  writeFileSync(configPath, VALID_CONFIG);
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  execFileSync("git", ["init", "-q", projectDir]);

  const { imports } = fakeAdapterImports({
    fallback: { result: "not json on purpose" },
  });
  // No captainFactory: the service instantiates the REAL shell from
  // @sublang/playbook/playbook-captain with the core loadModule.
  const service = await CoreService.start({
    token: "test",
    configPath,
    dataDir: join(dir, "state"),
    adapterImports: imports,
    env: {},
    home: join(dir, "home"),
    watchConfig: false,
  });
  const client = new Client(service.port());
  await client.open();

  const project = await client.expectOk("project.register", {
    path: projectDir,
  });
  const session = await client.expectOk("session.create", {
    projectId: project.id,
  });
  assert.deepEqual(
    session.players.map((p) => p.id),
    ["dev.coder"],
  );
  await client.expectOk("subscribe", {
    channel: { kind: "session", sessionId: session.id },
  });

  // Playbook 7's controller Captain answers every Boss turn through
  // the session Captain — a model call — so the faked adapter's text
  // comes back as the visible reply. Core owns the wiring: registry
  // loading, real shell construction, and the reply reaching the
  // session channel with the turn completing.
  await client.expectOk("turn.submit", { sessionId: session.id, text: "/code" });
  await client.waitFor(
    (m) => m.type === "record" && m.record.type === "turn_finished",
  );

  const transcript = JSON.stringify(client.records("session"));
  assert.ok(
    transcript.includes("not json on purpose"),
    `captain reply missing from the session channel; got: ${transcript.slice(0, 600)}`,
  );

  client.close();
  await service.stop();
});

// ---------------------------------------------------------------------------
// CORE-13: malformed messages leave the connection open with no state change
// ---------------------------------------------------------------------------

test("CORE-13: invalid messages get error replies and the connection survives", async () => {
  const harness = await startHarness();
  const client = new Client(harness.service.port());
  await client.open();

  client.sendRaw("{not json");
  const errorReply = await client.waitFor(
    (m) => m.type === "reply" && !m.ok,
  );
  assert.equal(errorReply.type, "reply");
  if (errorReply.type === "reply" && !errorReply.ok) {
    assert.equal(errorReply.error.code, "invalid_message");
  }

  // Connection still serves commands.
  const projects = await client.expectOk("project.list", {});
  assert.deepEqual(projects, []);

  client.close();
  await harness.service.stop();
});

test("CORE: handshake without the token is rejected before hello", async () => {
  const harness = await startHarness();
  const socket = new WebSocket(`ws://127.0.0.1:${harness.service.port()}`);
  const outcome = await new Promise<string>((resolve) => {
    socket.on("message", () => resolve("message"));
    socket.on("close", () => resolve("closed"));
    socket.on("error", () => resolve("closed"));
    setTimeout(() => resolve("timeout"), 3000);
  });
  assert.equal(outcome, "closed");
  await harness.service.stop();
});

// ---------------------------------------------------------------------------
// CORE-63: one core per state root
// ---------------------------------------------------------------------------

test("core-service-63: a second core service on a held root refuses naming the holder, and a fresh start succeeds after stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spex-root-"));
  const options = {
    token: "test",
    configPath: join(dir, "playbook.config.yaml"),
    dataDir: join(dir, "state"),
    env: {},
    home: join(dir, "home"),
    watchConfig: false,
  };
  const first = await CoreService.start(options);
  await assert.rejects(
    CoreService.start(options),
    (error: Error) => {
      assert.match(error.message, /held by pid/);
      assert.match(error.message, new RegExp(String(process.pid)));
      return true;
    },
  );
  await first.stop();
  const third = await CoreService.start(options);
  await third.stop();
});

// ---------------------------------------------------------------------------
// CORE-64: the legacy library relocation riding the import
// ---------------------------------------------------------------------------

test("core-service-64: a legacy library relocates into the root with config from paths rewritten and comments kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spex-lib-"));
  const legacyLib = join(dir, "legacy-lib");
  mkdirSync(join(legacyLib, "demo"), { recursive: true });
  writeFileSync(join(legacyLib, "demo", "demo.registry.mjs"), "export default {};\n");
  const configPath = join(dir, "playbook.config.yaml");
  writeFileSync(
    configPath,
    "# hand-written comment that must survive\n" +
      "playbooks:\n" +
      "  demo:\n" +
      `    from: ${join(legacyLib, "demo", "demo.registry.mjs")}\n` +
      "    roles: {}\n",
  );
  const dataDir = join(dir, "state");
  const service = await CoreService.start({
    token: "test",
    configPath,
    dataDir,
    legacyLibraryDir: legacyLib,
    env: {},
    home: join(dir, "home"),
    watchConfig: false,
  });
  const relocated = join(dataDir, "playbooks", "demo", "demo.registry.mjs");
  assert.ok(existsSync(relocated), "the library file relocated into the root");
  assert.ok(!existsSync(legacyLib), "the legacy directory is gone after the move");
  const rewritten = readFileSync(configPath, "utf8");
  assert.equal(resolve(dirname(configPath), parseYaml(rewritten).playbooks.demo.from), relocated, "the relative module locator follows the library");
  assert.ok(
    rewritten.includes("# hand-written comment that must survive"),
    "comments survive the rewrite",
  );
  await service.stop();
});

// ---------------------------------------------------------------------------
// CORE-60/65: sessions another host wrote into the shared session store
// ---------------------------------------------------------------------------

/** A captain-session record and replay stream as the playbook CLI writes
 * them: `<id>.json` naming the working directory, `<id>.records.jsonl`
 * carrying the history in the shared v1 envelope. */
function writeForeignSession(
  sessionsDir: string,
  id: string,
  cwd: string,
  records: Record<string, unknown>[],
): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${id}.json`),
    JSON.stringify({ schemaVersion: 6, sessionId: id, state: "settled", cwd }), {mode:0o600},
  );
  writeFileSync(
    join(sessionsDir, `${id}.records.jsonl`),
    records
      .map((record, index) =>
        JSON.stringify({ v: 1, seq: index + 1, record }),
      )
      .join("\n") + "\n", {mode:0o600},
  );
}

/** The lease directory the CLI guards a writer with: `.<id>.lock`
 * holding `owner.json` naming the pid and host. */
function writeForeignLease(
  sessionsDir: string,
  id: string,
  owner: { pid: number; hostname: string },
): string {
  const lock = join(sessionsDir, `.${id}.lock`);
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "captain-session-lease",
      sessionId: id,
      ownerToken: "11111111-2222-4333-8444-555555555555",
      ...owner,
      acquiredAt: new Date().toISOString(),
    }), {mode:0o600},
  );
  return lock;
}

/** A pid that has already exited, so a lease naming it is dead. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("no child pid");
  return child.pid;
}

function foreignTurn(prompt: string): Record<string, unknown>[] {
  return [
    {
      type: "turn_started",
      turnId: 1,
      turn: { id: 1, prompt },
      timestamp: 1000,
    },
    {
      type: "captain_prompt",
      turnId: 1,
      timestamp: 1500,
      prompt: "routing",
      visibility: "hidden",
    },
    { type: "turn_finished", turnId: 1, timestamp: 2000 },
  ];
}

test("core-service-60: sessions another host wrote are served, bound to their project by working directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spex-foreign-"));
  const sessionsDir = join(dir, "shared-sessions");
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  execFileSync("git", ["init", "-q", projectDir]);
  const configPath = join(dir, "playbook.config.yaml");
  writeFileSync(configPath, `sessions: ${sessionsDir}\n${VALID_CONFIG}`);

  // One session is already there when the service starts...
  const atStartup = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  writeForeignSession(sessionsDir, atStartup, projectDir, foreignTurn("from the terminal"));
  // ...and one names a directory no project is registered for.
  const unregistered = "ccccccc1-3333-4333-8333-cccccccccccc";
  writeForeignSession(sessionsDir, unregistered, join(dir, "elsewhere"), foreignTurn("elsewhere"));

  const service = await CoreService.start({
    token: "test",
    configPath,
    dataDir: join(dir, "state"),
    env: {},
    home: join(dir, "home"),
    // The sessions watcher rides the same option as the config watcher.
    watchConfig: true,
  });
  const client = new Client(service.port());
  await client.open();
  await client.expectOk("project.register", { path: projectDir });
  // Registering the project lists the history the directory already
  // holds for it, with no new record needed.
  const afterRegister = await client.expectOk("session.list", {});
  assert.ok(afterRegister.some((s: SessionInfo) => s.id === atStartup));

  // A record that lands while the service runs binds on arrival.
  const arrival = "bbbbbbb2-2222-4222-8222-bbbbbbbbbbbb";
  writeForeignSession(sessionsDir, arrival, projectDir, foreignTurn("while running"));

  const listed = await client.waitFor(
    (m) =>
      m.type === "session.state" &&
      (m as { session: SessionInfo }).session.id === arrival,
  );
  assert.ok(listed, "an arrival while running is announced");

  // A record written before the CLI teed its stream carries only its
  // Boss journal; it lists from that (core-service-60).
  const journaled = "ddddddd4-4444-4444-8444-dddddddddddd";
  writeFileSync(
    join(sessionsDir, `${journaled}.json`),
    JSON.stringify({
      schemaVersion: 3,
      kind: "captain-session",
      sessionId: journaled,
      state: "settled",
      cwd: projectDir,
      createdAt: "2026-08-29T01:35:22.228Z",
      updatedAt: "2026-08-29T14:39:13.668Z",
      snapshot: {
        journal: [
          { seq: 1, turnId: 1, kind: "boss", payload: "Resolve issue 42" },
          { seq: 2, turnId: 1, kind: "action", payload: "{}" },
          { seq: 3, turnId: 1, kind: "reply", payload: "Kicked off /code." },
          { seq: 4, turnId: 2, kind: "boss", payload: "Continue with /review" },
          { seq: 5, turnId: 2, kind: "reply", payload: "Review passed." },
        ],
      },
    }), {mode:0o600},
  );
  await client.waitFor(
    (m) =>
      m.type === "session.state" &&
      (m as { session: SessionInfo }).session.id === journaled,
  );

  const sessions = await client.expectOk("session.list", {});
  const ids = sessions.map((s: SessionInfo) => s.id);
  const fromJournal = sessions.find((s: SessionInfo) => s.id === journaled);
  assert.equal(fromJournal?.title, "Resolve issue 42");
  assert.equal(fromJournal?.turns, 2);
  const journalHistory = await client.expectOk("history.get", { sessionId: journaled });
  assert.deepEqual(
    journalHistory.records.map((r: StoredRecord) => r.record.type),
    ["turn_started", "captain_reply", "turn_finished", "turn_started", "captain_reply", "turn_finished"],
  );
  assert.ok(ids.includes(atStartup), "the session present at startup is served");
  assert.ok(ids.includes(arrival), "the session that arrived is served");
  assert.ok(
    !ids.includes(unregistered),
    "a session matching no registered project is not listed",
  );
  const served = sessions.find((s: SessionInfo) => s.id === atStartup);
  assert.equal(served?.live, false, "another host's session is never live here");
  assert.equal(served?.title, "from the terminal", "the title folds from the stream");
  assert.equal(served?.turns, 1);

  // Hidden records stay off the session channel on replay (CORE-10).
  const history = await client.expectOk("history.get", { sessionId: atStartup });
  assert.deepEqual(
    history.records.map((r: StoredRecord) => r.record.type),
    ["turn_started", "turn_finished"],
  );

  // CORE-65: this core writes none of another host's files.
  const before = readFileSync(join(sessionsDir, `${atStartup}.records.jsonl`), "utf8");
  assert.ok(!existsSync(join(sessionsDir, `${atStartup}.spex.json`)));
  client.close();
  await service.stop();
  assert.equal(
    readFileSync(join(sessionsDir, `${atStartup}.records.jsonl`), "utf8"),
    before,
    "the foreign stream is byte-identical afterwards",
  );
});

test("core-service-62: CLI stream changes refresh history and subscribers without duplicating folds or writing foreign files", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spex-foreign-refresh-"));
  const sessionsDir = join(dir, "shared-sessions");
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  execFileSync("git", ["init", "-q", projectDir]);
  const configPath = join(dir, "playbook.config.yaml");
  writeFileSync(configPath, `sessions: ${sessionsDir}\n${VALID_CONFIG}`);
  const sessionId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const manifest = join(sessionsDir, `${sessionId}.json`);
  const stream = join(sessionsDir, `${sessionId}.records.jsonl`);
  const opening = { type: "captain_status", turnId: null, message: "ready", timestamp: 1000 };
  writeForeignSession(sessionsDir, sessionId, projectDir, [opening]);
  // Sorting ahead of the healthy manifest exposed the old whole-scan
  // catch, which let one malformed neighbor hide every later session.
  const bindingStore = new Store({dir:join(dir, "state"), sessionsDir});
  bindingStore.registerProject(projectDir, "project", Date.now());
  bindingStore.close();
  const malformed = join(sessionsDir, "00000000-0000-4000-8000-000000000000.json");
  writeFileSync(malformed, '{"sessionId":');
  const invalidStreamId = "00000000-0000-4000-8000-000000000001";
  writeForeignSession(sessionsDir, invalidStreamId, projectDir, [opening]);
  const invalidStream = join(sessionsDir, `${invalidStreamId}.records.jsonl`);
  const invalidStreamBefore = '{"v":1,"seq":1,"record":null}\n';
  writeFileSync(invalidStream, invalidStreamBefore);
  const manifestBefore = readFileSync(manifest, "utf8");
  const malformedBefore = readFileSync(malformed, "utf8");

  const service = await CoreService.start({
    token: "test",
    configPath,
    dataDir: join(dir, "state"),
    env: {},
    home: join(dir, "home"),
    watchConfig: true,
  });
  const client = new Client(service.port());
  t.after(async () => {
    client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await client.open();
  await client.expectOk("project.register", { path: projectDir });
  const initial = (await client.expectOk("session.list", {})).find((session) => session.id === sessionId);
  assert.ok(initial, "a malformed neighbor hides no healthy session");
  assert.equal(initial.title, undefined);
  assert.equal(initial.turns, 0);
  await client.expectOk("subscribe", { channel: { kind: "session", sessionId } });
  await client.expectOk("subscribe", { channel: { kind: "debug", sessionId } });

  const usage = (turnId: number, timestamp: number, input: number, output: number) => ({
    type: "player_event",
    playerId: "dev.coder",
    turnId,
    timestamp,
    event: {
      type: "done",
      payload: { usage: { tokens: { totals: { input: { total: input }, output: { total: output } } }, toolUses: 1 } },
    },
  });
  const firstTurn = [
    { type: "turn_started", turnId: 1, turn: { id: 1, prompt: "first terminal turn" }, timestamp: 2000 },
    { type: "captain_prompt", turnId: 1, prompt: "routing", visibility: "hidden", timestamp: 3000 },
    { type: "captain_reply", turnId: 1, text: "first reply", timestamp: 4000 },
    usage(1, 5000, 10, 4),
    { type: "turn_finished", turnId: 1, timestamp: 6000 },
  ];
  const secondStart = { type: "turn_started", turnId: 2, turn: { id: 2, prompt: "second terminal turn" }, timestamp: 7000 };
  const line = (seq: number, record: Record<string, unknown>) => JSON.stringify({ v: 1, seq, record });
  // Only the stream changes. The parseable last record is deliberately
  // not newline-terminated, just as a reader can catch an append.
  appendFileSync(stream, firstTurn.map((record, index) => line(index + 2, record)).join("\n") + "\n" + line(7, secondStart));
  // Continuing directory activity must not postpone this stream's
  // subscriber updates until the writer goes quiet.
  const activity = setInterval(() => writeFileSync(malformed, malformedBefore), 25);
  try {
    await client.waitFor((message) => message.type === "session.state" && message.session.id === sessionId && message.session.turns === 1);
    await client.waitFor((message) => message.type === "record" && message.sessionId === sessionId && message.seq === 6);
  } finally {
    clearInterval(activity);
  }
  const first = (await client.expectOk("session.list", {})).find((session) => session.id === sessionId);
  assert.equal(first?.title, "first terminal turn");
  assert.equal(first?.turns, 1, "the unterminated second turn is not read");
  const firstHistory = await client.expectOk("history.get", { sessionId });
  assert.deepEqual(firstHistory.records.map((entry) => entry.seq), [1, 2, 4, 5, 6]);
  assert.deepEqual(client.records("session").map((entry) => entry.seq), [2, 4, 5, 6]);
  assert.deepEqual(client.records("debug").map((entry) => entry.seq), [3]);
  assert.equal((await client.expectOk("usage.get", { sessionId })).inputTokens, 10);

  appendFileSync(stream, "\n");
  await client.waitFor((message) => message.type === "session.state" && message.session.id === sessionId && message.session.turns === 2);
  await client.waitFor((message) => message.type === "record" && message.sessionId === sessionId && message.seq === 7);
  assert.equal((await client.expectOk("history.get", { sessionId })).records.at(-1)?.seq, 7);
  const secondEnd = [usage(2, 8000, 6, 2), { type: "turn_finished", turnId: 2, timestamp: 9000 }];
  appendFileSync(stream, secondEnd.map((record, index) => line(index + 8, record)).join("\n") + "\n");
  await client.waitFor((message) => message.type === "session.state" && message.session.id === sessionId && message.session.endedAt === 9000);
  await client.waitFor((message) => message.type === "record" && message.sessionId === sessionId && message.seq === 9);
  const completeHistory = await client.expectOk("history.get", { sessionId });
  const expectedUsage = await client.expectOk("usage.get", { sessionId });
  assert.equal(expectedUsage.inputTokens, 16);
  assert.equal(expectedUsage.outputTokens, 6);
  assert.equal(expectedUsage.toolUses, 2);
  const announced = client.messages.filter((message) => message.type === "session.state").length;

  // Registering an existing project synchronously rescans the directory.
  // Repeated notifications/read cycles must neither inflate usage nor
  // send the same records or unchanged session state again.
  for (let count = 0; count < 3; count += 1) {
    await client.expectOk("project.register", { path: projectDir });
    assert.deepEqual(await client.expectOk("usage.get", { sessionId }), expectedUsage);
    assert.deepEqual(await client.expectOk("history.get", { sessionId }), completeHistory);
  }
  assert.deepEqual(client.records("session").map((entry) => entry.seq), [2, 4, 5, 6, 7, 8, 9]);
  assert.equal(client.messages.filter((message) => message.type === "session.state").length, announced);

  // A replacement is a new readable history, not a second addition to
  // the prior fold. It announces state but emits no invented append.
  const replacement = [
    opening,
    { ...firstTurn[0], turn: { id: 1, prompt: "replaced terminal history" } },
    ...firstTurn.slice(1),
  ];
  writeFileSync(stream, replacement.map((record, index) => line(index + 1, record)).join("\n") + "\n");
  await client.waitFor((message) => message.type === "session.state" && message.session.id === sessionId && message.session.title === "replaced terminal history");
  const resetIndex = client.messages.findIndex((message) => message.type === "session.history-replaced" && message.sessionId === sessionId);
  const stateIndex = client.messages.findIndex((message) => message.type === "session.state" && message.session.id === sessionId && message.session.title === "replaced terminal history");
  assert.ok(resetIndex >= 0 && resetIndex < stateIndex, "history replacement is announced before its summary");
  const replaced = (await client.expectOk("session.list", {})).find((session) => session.id === sessionId);
  assert.equal(replaced?.turns, 1);
  assert.equal((await client.expectOk("usage.get", { sessionId })).inputTokens, 10);
  const replacedHistory = await client.expectOk("history.get", { sessionId });
  assert.deepEqual(replacedHistory.records.map((entry) => entry.seq), [1, 2, 4, 5, 6]);
  assert.deepEqual(client.records("session").map((entry) => entry.seq), [2, 4, 5, 6, 7, 8, 9]);

  const streamAfterExternalWrites = readFileSync(stream, "utf8");
  client.close();
  await service.stop();
  assert.equal(readFileSync(stream, "utf8"), streamAfterExternalWrites);
  assert.equal(readFileSync(manifest, "utf8"), manifestBefore);
  assert.equal(readFileSync(malformed, "utf8"), malformedBefore);
  assert.equal(readFileSync(invalidStream, "utf8"), invalidStreamBefore);
  assert.ok(!existsSync(join(sessionsDir, `${sessionId}.spex.json`)));
});


// ---------------------------------------------------------------------------
// CORE-70/71: session deletion
// ---------------------------------------------------------------------------

test("core-service-85: removing a recorded path alias unlists history without deleting it", async () => {
  const harness = await startHarness();
  const client = new Client(harness.service.port());
  try {
    await client.open();
    const project = await client.expectOk("project.register", { path: harness.projectDir });
    const session = await client.expectOk("session.create", { projectId: project.id });
    await client.expectOk("session.dispose", { sessionId: session.id });
    const history = await client.expectOk("history.get", { sessionId: session.id });
    const paths = ["json", "records.jsonl", "hints.json"].map((suffix) => join(harness.dataDir, "sessions", `${session.id}.${suffix}`));
    const before = paths.map((path) => existsSync(path) ? readFileSync(path) : undefined);
    const relocated = join(harness.dir, "relocated-project");
    mkdirSync(relocated);
    execFileSync("git", ["init", "-q", relocated]);

    await client.expectOk("project.rebind", { projectId: project.id, path: relocated, aliases: [] });
    assert.ok(!(await client.expectOk("session.list", {})).some((entry) => entry.id === session.id));
    await client.waitFor((message) => message.type === "session.removed" && message.sessionId === session.id && message.projectId === project.id);
    const hidden = await client.command("history.get", { sessionId: session.id });
    assert.ok(!hidden.ok && hidden.error.code === "not_found");
    assert.ok((await client.expectOk("storage.diagnostics", {})).some((entry) => entry.file.endsWith(`${session.id}.json`) && entry.reason.includes(harness.projectDir) && !entry.blocking));
    assert.deepEqual(paths.map((path) => existsSync(path) ? readFileSync(path) : undefined), before);

    await client.expectOk("project.rebind", { projectId: project.id, path: relocated, aliases: [harness.projectDir] });
    const restored = (await client.expectOk("session.list", {})).find((entry) => entry.id === session.id);
    assert.equal(restored?.projectId, project.id);
    assert.equal(restored?.projectPath, relocated);
    assert.deepEqual(await client.expectOk("history.get", { sessionId: session.id }), history);
    assert.ok(!(await client.expectOk("storage.diagnostics", {})).some((entry) => entry.file.endsWith(`${session.id}.json`)));
  } finally {
    client.close();
    await harness.service.stop();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

test("core-service-71: session.delete removes an ended session and its traces, refuses a live one, and refuses another host's while its lease is held", async () => {
  const sessionsDir = join(mkdtempSync(join(tmpdir(), "spex-delete-")), "shared-sessions");
  const harness = await startHarness(`sessions: ${sessionsDir}\n${VALID_CONFIG}`);
  const client = new Client(harness.service.port());
  await client.open();
  const watcher = new Client(harness.service.port());
  await watcher.open();

  // A session another host wrote, adopted when its project registers
  // (core-service-60).
  const foreignId = "eeeeeee5-5555-4555-8555-eeeeeeeeeeee";
  writeForeignSession(sessionsDir, foreignId, harness.projectDir, foreignTurn("from the terminal"));
  const project = await client.expectOk("project.register", { path: harness.projectDir });

  // An ended session that served an intent, viewed, then disposed.
  const ended = await client.expectOk("session.create", { projectId: project.id });
  await client.expectOk("subscribe", {
    channel: { kind: "session", sessionId: ended.id },
  });
  const served = await client.expectOk("intent.queue", {
    projectId: project.id,
    text: "Served by the session to delete",
  });
  await client.expectOk("turn.submit", {
    sessionId: ended.id,
    text: "hello",
    intentId: served.id,
  });
  const finished = await client.waitFor(
    (m) => m.type === "record" && m.record.type === "turn_finished",
  );
  const turnId = finished.type === "record" ? (finished.record.turnId ?? -1) : -1;
  await client.expectOk("session.viewed", { sessionId: ended.id, turnId });
  await client.expectOk("session.dispose", { sessionId: ended.id });
  const live = await client.expectOk("session.create", { projectId: project.id });

  const sidecar = join(sessionsDir, `${ended.id}.json`);
  const stream = join(sessionsDir, `${ended.id}.records.jsonl`);
  const prefsFile = join(harness.dataDir, "prefs.json");
  assert.ok(existsSync(sidecar) && existsSync(stream), "the ended session's files exist");
  assert.ok(readFileSync(prefsFile, "utf8").includes(`viewed:${ended.id}`));

  // The live session ends first (core-service-70).
  const busy = await client.command("session.delete", { sessionId: live.id });
  assert.ok(!busy.ok && busy.error.code === "busy");

  // Another host's session is listed as such (core-service-32); while
  // a live writer holds its lease it is refused busy naming the
  // holder, its files byte-identical (core-service-75).
  const listedForeign = (await client.expectOk("session.list", {})).find(
    (s: SessionInfo) => s.id === foreignId,
  );
  assert.equal(listedForeign?.live, false, "CLI history has the same ended session shape");
  assert.equal(ended.foreign, undefined, "a session this core ran is not");
  writeForeignLease(sessionsDir, foreignId, { pid: process.pid, hostname: hostname() });
  const manifestBefore = readFileSync(join(sessionsDir, `${foreignId}.json`), "utf8");
  const streamBefore = readFileSync(join(sessionsDir, `${foreignId}.records.jsonl`), "utf8");
  const refused = await client.command("session.delete", { sessionId: foreignId });
  assert.ok(!refused.ok && refused.error.code === "busy");
  assert.ok(!refused.ok && refused.error.message.includes(String(process.pid)));
  assert.equal(readFileSync(join(sessionsDir, `${foreignId}.json`), "utf8"), manifestBefore);
  assert.equal(readFileSync(join(sessionsDir, `${foreignId}.records.jsonl`), "utf8"), streamBefore);

  // The ended session deletes: files, listing, history, viewed marker.
  await client.expectOk("session.delete", { sessionId: ended.id });
  assert.ok(!existsSync(sidecar) && !existsSync(stream), "the files are gone");
  const listed = await client.expectOk("session.list", {});
  assert.ok(!listed.some((s: SessionInfo) => s.id === ended.id), "dropped from the listing");
  assert.ok(listed.some((s: SessionInfo) => s.id === live.id), "the live session stays");
  const history = await client.command("history.get", { sessionId: ended.id });
  assert.ok(!history.ok && history.error.code === "not_found");
  assert.ok(!readFileSync(prefsFile, "utf8").includes(`viewed:${ended.id}`));
  const removed = await watcher.waitFor(
    (m) => m.type === "session.removed" && m.sessionId === ended.id,
  );
  assert.equal(
    removed.type === "session.removed" ? removed.projectId : undefined,
    project.id,
    "subscribed clients learn the removal",
  );
  const again = await client.command("session.delete", { sessionId: ended.id });
  assert.ok(!again.ok && again.error.code === "not_found");

  // The intent the session served re-derives as queued (core-service-49).
  await client.waitFor(
    (m) => m.type === "intents.changed" && m.projectIds.includes(project.id),
  );
  const ledger = await client.expectOk("ledger.get", {});
  assert.equal(
    ledger.intents.find((entry) => entry.intent.id === served.id)?.state,
    "queued",
  );

  // A restart serves nothing of it, and still serves the other host's.
  client.close();
  watcher.close();
  await harness.service.stop();
  const restarted = await CoreService.start({
    token: "test",
    configPath: join(harness.dir, "playbook.config.yaml"),
    dataDir: harness.dataDir,
    env: {},
    home: join(harness.dir, "home"),
    watchConfig: false,
  });
  const client2 = new Client(restarted.port());
  await client2.open();
  const afterRestart = (await client2.expectOk("session.list", {})).map((s: SessionInfo) => s.id);
  assert.ok(!afterRestart.includes(ended.id));
  assert.ok(afterRestart.includes(foreignId));
  client2.close();
  await restarted.stop();
});

// ---------------------------------------------------------------------------
// CORE-70/75/76/78: deleting another host's session, and its vanishing
// ---------------------------------------------------------------------------

test("core-service-78: another host's session deletes lease-free, its lock dirs untouched, and one that vanishes leaves the listing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spex-foreign-delete-"));
  const sessionsDir = join(dir, "shared-sessions");
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  execFileSync("git", ["init", "-q", projectDir]);
  const configPath = join(dir, "playbook.config.yaml");
  writeFileSync(configPath, `sessions: ${sessionsDir}\n${VALID_CONFIG}`);

  const held = "f0000001-1111-4111-8111-f00000000001";
  const released = "f0000002-2222-4222-8222-f00000000002";
  const abroad = "f0000003-3333-4333-8333-f00000000003";
  const vanishing = "f0000004-4444-4444-8444-f00000000004";
  for (const id of [held, released, abroad, vanishing]) {
    writeForeignSession(sessionsDir, id, projectDir, foreignTurn(`terminal ${id}`));
  }
  // A dead pid on this host holds nothing; a retired lease beside it
  // is the CLI's own transient and stays.
  const releasedLock = writeForeignLease(sessionsDir, released, {
    pid: deadPid(),
    hostname: hostname(),
  });
  const retired = join(sessionsDir, `.${released}.lock.retired.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`);
  mkdirSync(retired, { recursive: true, mode:0o700 });
  writeFileSync(join(retired, "owner.json"), JSON.stringify({schemaVersion:1,kind:"captain-session-lease",sessionId:released,ownerToken:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",pid:deadPid(),hostname:hostname(),acquiredAt:new Date().toISOString()}), {mode:0o600});
  // Another host's lease can never be probed: it always holds.
  writeForeignLease(sessionsDir, abroad, { pid: 1, hostname: "elsewhere.invalid" });

  const service = await CoreService.start({
    token: "test",
    configPath,
    dataDir: join(dir, "state"),
    env: {},
    home: join(dir, "home"),
    watchConfig: true,
  });
  const client = new Client(service.port());
  await client.open();
  const watcher = new Client(service.port());
  await watcher.open();
  const project = await client.expectOk("project.register", { path: projectDir });
  const listed = (await client.expectOk("session.list", {})).map((s: SessionInfo) => s.id);
  for (const id of [held, released, abroad, vanishing]) {
    assert.ok(listed.includes(id), `${id} is served`);
  }

  // Lease-free: the record and the stream go, the lock directories
  // stay, and subscribed clients learn the removal (core-service-70).
  await client.expectOk("session.delete", { sessionId: released });
  assert.ok(!existsSync(join(sessionsDir, `${released}.json`)), "the record is gone");
  assert.ok(!existsSync(join(sessionsDir, `${released}.records.jsonl`)), "the stream is gone");
  assert.ok(!existsSync(releasedLock), "the shared owner reclaims and releases the dead lease");
  assert.ok(existsSync(join(retired, "owner.json")), "a retired lease is never removed");
  const removed = await watcher.waitFor(
    (m) => m.type === "session.removed" && m.sessionId === released,
  );
  assert.equal(removed.type === "session.removed" ? removed.projectId : undefined, project.id);
  assert.ok(
    !(await client.expectOk("session.list", {})).some((s: SessionInfo) => s.id === released),
    "dropped from the listing",
  );

  // Held on another host: refused busy naming the holder (core-service-75).
  const foreignHeld = await client.command("session.delete", { sessionId: abroad });
  assert.ok(!foreignHeld.ok && foreignHeld.error.code === "busy", JSON.stringify(foreignHeld));
  assert.ok(!foreignHeld.ok && foreignHeld.error.message.includes("elsewhere.invalid"));
  assert.ok(existsSync(join(sessionsDir, `${abroad}.json`)));

  // Vanishing from the shared store while the service runs: the CLI
  // removed it, and the listing follows (core-service-76).
  rmSync(join(sessionsDir, `${vanishing}.json`));
  rmSync(join(sessionsDir, `${vanishing}.records.jsonl`));
  const gone = await watcher.waitFor(
    (m) => m.type === "session.removed" && m.sessionId === vanishing,
  );
  assert.equal(gone.type === "session.removed" ? gone.projectId : undefined, project.id);
  assert.ok(
    !(await client.expectOk("session.list", {})).some((s: SessionInfo) => s.id === vanishing),
  );
  const history = await client.command("history.get", { sessionId: vanishing });
  assert.ok(!history.ok && history.error.code === "not_found");
  // The others are untouched by either event.
  assert.ok(existsSync(join(sessionsDir, `${held}.records.jsonl`)));

  client.close();
  watcher.close();
  await service.stop();
});

// ---------------------------------------------------------------------------
// CORE-72/73/74/77: an ended session continues on a Boss message
// ---------------------------------------------------------------------------

/** The turn ids a session's history holds, in order. */
function turnIds(records: StoredRecord[]): number[] {
  return records
    .filter((entry) => entry.record.type === "turn_started")
    .map((entry) => (entry.record as { turn: { id: number } }).turn.id);
}

test("core-service-22/62: opaque v1 records survive native restart and CLI replay without truncating history", async (t) => {
  const harness = await startHarness();
  let service = harness.service;
  let client = new Client(service.port());
  t.after(async () => {
    client.close();
    await service.stop();
    rmSync(harness.dir, { recursive: true, force: true });
  });
  await client.open();
  const project = await client.expectOk("project.register", { path: harness.projectDir });
  const native = await client.expectOk("session.create", { projectId: project.id });
  await client.expectOk("subscribe", { channel: { kind: "session", sessionId: native.id } });
  await client.expectOk("turn.submit", { sessionId: native.id, text: "known native turn" });
  await client.waitFor((message) => message.type === "record" && message.sessionId === native.id && message.record.type === "turn_finished");
  await client.expectOk("session.dispose", { sessionId: native.id });
  const nativeUsage = await client.expectOk("usage.get", { sessionId: native.id });
  client.close();
  await service.stop();

  const sessionsDir = join(harness.dataDir, "sessions");
  const nativeStream = join(sessionsDir, `${native.id}.records.jsonl`);
  const original = readFileSync(nativeStream, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const opaque = [
    {},
    { type: "future_context", playerId: "not-a-player", timestamp: 1700 },
    { type: "opaque_record", nested: { retained: true } },
    { type: 7, timestamp: "not a presentation timestamp" },
    { type: "turn_started" },
    { type: "player_event", playerId: "not-a-player" },
    { type: "runtime_error", message: "not a presentation record" },
  ];
  const nativeEntries = [...original, ...opaque.map((record, index) => ({v:1,seq:original.length + index + 1,record}))];
  const nativeBytes = nativeEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(nativeStream, nativeBytes);

  const foreignId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const foreignRecords = [
    opaque[0], ...foreignTurn("known CLI turn").slice(0, 1),
    ...opaque.slice(1), ...foreignTurn("known CLI turn").slice(1), {},
  ];
  writeForeignSession(sessionsDir, foreignId, harness.projectDir, foreignRecords);
  const foreignStream = join(sessionsDir, `${foreignId}.records.jsonl`);
  // The released Playbook reader is the compatibility oracle, including
  // its private-file boundary; no duplicate mock parser defines v1 here.
  chmodSync(sessionsDir, 0o700);
  chmodSync(foreignStream, 0o600);
  const playbook = openSessionStore(sessionsDir);
  const expectedForeign = (await playbook.readStream(foreignId)).entries;
  assert.equal(expectedForeign.length, foreignRecords.length);
  const foreignBytes = readFileSync(foreignStream, "utf8");
  const opaqueId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  writeForeignSession(sessionsDir, opaqueId, harness.projectDir, [{}, { type: "future" }]);
  const createdAt = "2026-09-01T01:00:00.000Z";
  const updatedAt = "2026-09-01T02:00:00.000Z";
  writeFileSync(join(sessionsDir, `${opaqueId}.json`), JSON.stringify({
    sessionId: opaqueId, cwd: harness.projectDir, createdAt, updatedAt,
  }));
  writeFileSync(join(harness.dir, "playbook.config.yaml"), `sessions: ${sessionsDir}\n${VALID_CONFIG}`);

  service = await CoreService.start({
    token: "test", configPath: join(harness.dir, "playbook.config.yaml"),
    dataDir: harness.dataDir, env: {}, home: join(harness.dir, "home"),
    watchConfig: true,
  });
  client = new Client(service.port());
  await client.open();
  const sessions = await client.expectOk("session.list", {});
  const nativeInfo = sessions.find((session) => session.id === native.id);
  assert.equal(nativeInfo?.title, "known native turn");
  assert.equal(nativeInfo?.turns, 1);
  assert.equal(nativeInfo?.failed, false);
  assert.equal(nativeInfo?.streamIncompleteAfterSeq, undefined);
  assert.equal(nativeInfo?.continuable, true);
  assert.equal(JSON.parse(readFileSync(join(sessionsDir, `${native.id}.json`), "utf8")).replay.incomplete, false);
  assert.deepEqual(await client.expectOk("usage.get", { sessionId: native.id }), nativeUsage);
  const withoutEnvelopeVersion = ({ v: _v, ...entry }: { v: number }) => entry;
  const visible = (entry: { record: object }) => (entry.record as { visibility?: unknown }).visibility !== "hidden";
  assert.deepEqual((await client.expectOk("history.get", { sessionId: native.id })).records,
    nativeEntries.filter(visible).map(withoutEnvelopeVersion));
  assert.deepEqual((await client.expectOk("history.get", { sessionId: foreignId })).records,
    expectedForeign.filter(visible).map(withoutEnvelopeVersion));
  const foreignInfo = sessions.find((session) => session.id === foreignId);
  assert.equal(foreignInfo?.title, "known CLI turn");
  assert.equal(foreignInfo?.turns, 1);
  assert.equal(foreignInfo?.failed, false);
  assert.deepEqual(foreignInfo?.players, []);
  assert.equal(foreignInfo?.createdAt, 1000);
  assert.equal(foreignInfo?.endedAt, 2000);
  const opaqueInfo = sessions.find((session) => session.id === opaqueId);
  assert.equal(opaqueInfo?.createdAt, Date.parse(createdAt));
  assert.equal(opaqueInfo?.endedAt, Date.parse(updatedAt));
  assert.equal(opaqueInfo?.turns, 0);

  await client.expectOk("subscribe", { channel: { kind: "session", sessionId: foreignId } });
  const appended = [{ type: "future" }, { type: "captain_reply", turnId: 1, timestamp: 3000, text: "after opaque records" }];
  appendFileSync(foreignStream, appended.map((record, index) => JSON.stringify({
    v: 1, seq: foreignRecords.length + index + 1, record,
  })).join("\n") + "\n");
  await client.waitFor((message) => message.type === "record" && message.sessionId === foreignId && message.seq === foreignRecords.length + 2);
  assert.deepEqual(client.records("session").map((message) => message.record), appended);
  assert.equal((await client.expectOk("history.get", { sessionId: foreignId })).records.at(-1)?.seq, foreignRecords.length + 2);
  assert.equal(readFileSync(nativeStream, "utf8"), nativeBytes);
  assert.ok(readFileSync(foreignStream, "utf8").startsWith(foreignBytes));
  assert.ok(!existsSync(join(sessionsDir, `${foreignId}.spex.json`)));
});

test("core-service-22: damaged native streams remain readable but cannot continue after restart", async (t) => {
  const harness = await startHarness();
  let service = harness.service;
  let client = new Client(service.port());
  t.after(async () => {
    client.close();
    await service.stop();
    rmSync(harness.dir, { recursive: true, force: true });
  });
  await client.open();
  const project = await client.expectOk("project.register", { path: harness.projectDir });
  const envelope = (seq: number, v = 1) => JSON.stringify({
    v, seq, record: { type: "captain_status", turnId: null, timestamp: 1, message: "unfinished append" },
  });
  const cases = [
    { name: "unterminated record", suffix: (seq: number) => envelope(seq) },
    { name: "torn JSON", suffix: () => '{"v":1,"seq":' },
    { name: "malformed complete line", suffix: () => "{broken}\n" },
    { name: "sequence gap", suffix: (seq: number) => envelope(seq + 1) + "\n" },
    { name: "unknown version", suffix: (seq: number) => envelope(seq, 2) + "\n" },
    { name: "non-object record", suffix: (seq: number) => JSON.stringify({ v: 1, seq, record: null }) + "\n" },
    { name: "unknown envelope member", suffix: (seq: number) => JSON.stringify({ ...JSON.parse(envelope(seq)), extra: true }) + "\n" },
    { name: "non-string role", suffix: (seq: number) => JSON.stringify({ ...JSON.parse(envelope(seq)), role: 7 }) + "\n" },
    { name: "earlier incomplete marker", suffix: (seq: number) => envelope(seq), earlier: true },
  ];
  const damaged: {
    id: string;
    name: string;
    stream: string;
    sidecar: string;
    bytes: string;
    boundary: number;
    history: CommandResults["history.get"];
    earlier?: boolean;
  }[] = [];
  for (const example of cases) {
    const session = await client.expectOk("session.create", { projectId: project.id });
    await client.expectOk("subscribe", { channel: { kind: "session", sessionId: session.id } });
    await client.expectOk("turn.submit", { sessionId: session.id, text: example.name });
    await client.waitFor((message) => message.type === "record" && message.sessionId === session.id && message.record.type === "turn_finished");
    await client.expectOk("session.dispose", { sessionId: session.id });
    const stream = join(harness.dataDir, "sessions", `${session.id}.records.jsonl`);
    const before = readFileSync(stream, "utf8");
    const records = before.trimEnd().split("\n").map((line) => JSON.parse(line) as StoredRecord);
    const lastSeq = records.at(-1)?.seq ?? 0;
    const history = await client.expectOk("history.get", { sessionId: session.id });
    damaged.push({
      id: session.id,
      name: example.name,
      stream,
      sidecar: join(harness.dataDir, "sessions", `${session.id}.json`),
      bytes: before + example.suffix(lastSeq + 1),
      boundary: JSON.parse(readFileSync(join(harness.dataDir, "sessions", `${session.id}.json`), "utf8")).replay.seq,
      history,
      earlier: example.earlier,
    });
  }
  client.close();
  await service.stop();
  for (const example of damaged) {
    writeFileSync(example.stream, example.bytes);
    if (example.earlier) {
      const meta = JSON.parse(readFileSync(example.sidecar, "utf8"));
      meta.replay.incomplete = true;
      writeFileSync(example.sidecar, JSON.stringify(meta));
    }
  }
  service = await CoreService.start({
    token: "test",
    configPath: join(harness.dir, "playbook.config.yaml"),
    dataDir: harness.dataDir,
    adapterImports: fakeAdapterImports({ fallback: { result: "unexpected continuation" } }).imports,
    adapterRuntime: () => ({ usable: true }),
    captainFactory: async () => createScriptedCaptain(async () => {}),
    env: {},
    home: join(harness.dir, "home"),
    watchConfig: false,
  });
  client = new Client(service.port());
  await client.open();
  const sessions = await client.expectOk("session.list", {});
  for (const example of damaged) {
    const listed = sessions.find((session) => session.id === example.id);
    assert.equal(listed?.streamIncompleteAfterSeq, example.boundary, example.name);
    assert.equal(listed?.continuable, undefined, example.name);
    assert.equal(listed?.live, false, example.name);
    assert.deepEqual(await client.expectOk("history.get", { sessionId: example.id }), example.history, example.name);
    const refused = await client.command("turn.submit", { sessionId: example.id, text: "continue damaged history" });
    assert.ok(!refused.ok, example.name);
    assert.ok(!refused.ok && /incomplete|replay|checkpoint|damage/i.test(refused.error.message), example.name);
    assert.equal(readFileSync(example.stream, "utf8"), example.bytes, example.name);
    assert.ok(!existsSync(example.sidecar.replace(/\.json$/, ".spex.json")), "no desktop authority file");
  }
});

test("core-service-77: a real session continues after restart and respects another active session", async (t) => {
  const harness = await startHarness(VALID_CONFIG, {realShell:true});
  let service = harness.service;
  let client = new Client(service.port());
  t.after(async () => {client.close(); await service.stop(); rmSync(harness.dir,{recursive:true,force:true});});
  await client.open();
  const project = await client.expectOk("project.register", {path:harness.projectDir});
  const session = await client.expectOk("session.create", {projectId:project.id});
  await client.expectOk("turn.submit", {sessionId:session.id,text:"first"});
  // Settlement releases the runtime (core-service-91).
  await client.waitFor((m) => m.type === "session.state" && m.session.id === session.id && !m.session.live && m.session.turns === 1);
  const stream = join(harness.dataDir,"sessions",`${session.id}.records.jsonl`);
  const before = readFileSync(stream,"utf8");
  client.close(); await service.stop();
  service = await CoreService.start({token:"test",configPath:join(harness.dir,"playbook.config.yaml"),dataDir:harness.dataDir,adapterImports:fakeAdapterImports({fallback:{result:"continued answer"}}).imports,env:{},watchConfig:false});
  client = new Client(service.port()); await client.open();
  assert.equal((await client.expectOk("session.list",{})).find((item) => item.id === session.id)?.continuable,true);
  // A freshly created session holds its runtime until its first turn
  // settles, so the project refuses a message elsewhere, naming it.
  const other = await client.expectOk("session.create",{projectId:project.id});
  const busy = await client.command("turn.submit",{sessionId:session.id,text:"second"});
  assert.ok(!busy.ok && busy.error.code === "busy");
  assert.ok(!busy.ok && /still working|a session/.test(busy.error.message), busy.ok ? "" : busy.error.message);
  await client.expectOk("session.dispose",{sessionId:other.id});
  await client.expectOk("turn.submit",{sessionId:session.id,text:"second"});
  await client.waitFor((m) => m.type === "session.state" && m.session.id === session.id && !m.session.live && m.session.turns === 2);
  assert.deepEqual(turnIds((await client.expectOk("history.get",{sessionId:session.id})).records),[1,2]);
  assert.ok(readFileSync(stream,"utf8").startsWith(before),"continue appends to the same replay");
});

test("core-service-77: the real shell continues from its token-free snapshot, ledger intact, and refuses config drift", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spex-shell-continue-"));
  const configPath = join(dir, "playbook.config.yaml");
  writeFileSync(configPath, VALID_CONFIG);
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  execFileSync("git", ["init", "-q", projectDir]);

  // The fake adapter issues resume tokens, so the shell's own export
  // carries them; the manifest must not.
  const { imports } = fakeAdapterImports({
    fallback: { result: "not json on purpose" },
  });
  const service = await CoreService.start({
    token: "test",
    configPath,
    dataDir: join(dir, "state"),
    adapterImports: imports,
    env: {},
    home: join(dir, "home"),
    watchConfig: false,
  });
  t.after(async () => { await service.stop(); rmSync(dir, {recursive:true,force:true}); });
  const client = new Client(service.port());
  t.after(() => client.close());
  await client.open();
  const project = await client.expectOk("project.register", { path: projectDir });
  const session = await client.expectOk("session.create", { projectId: project.id });
  await client.expectOk("subscribe", {
    channel: { kind: "session", sessionId: session.id },
  });
  await client.expectOk("turn.submit", { sessionId: session.id, text: "hello" });
  await client.waitFor(
    (m) => m.type === "record" && m.record.type === "turn_finished",
  );

  // The turn's end persisted the shell's snapshot, token-free
  // (core-service-72).
  const manifest = join(dir, "state", "sessions", `${session.id}.json`);
  await client.waitFor((m) => m.type === "session.state" && m.session.id === session.id && m.session.turns === 1 && m.session.turnActive === false);
  const text = readFileSync(manifest, "utf8");
  assert.ok(!text.includes("resumeToken"), "no token key in the manifest");
  assert.ok(!text.includes("fake-resume-"), "no token value in the manifest");
  const snapshot = (JSON.parse(text) as {
    snapshot: {

        schemaVersion: number;
        journal: unknown[];
        captain: { conversation: { kind: string } };
        effectLedger: unknown;
    };
  }).snapshot;
  assert.equal(snapshot.schemaVersion, 4);
  assert.ok(snapshot.journal.length > 0, "the journal is kept for the reseed");
  assert.equal(snapshot.captain.conversation.kind, "needsSeeding");
  const ledgerBefore = JSON.stringify(snapshot.effectLedger);

  // Settlement released the runtime (core-service-91): the session is
  // no longer live, and the provider hints written at settlement stay
  // bound to the untouched manifest.
  await client.waitFor((m) => m.type === "session.state" && m.session.id === session.id && m.session.live === false);
  const hints = JSON.parse(readFileSync(join(dir, "state", "sessions", `${session.id}.hints.json`), "utf8")) as { checkpointSha256: string; captain?: { kind: string } };
  assert.equal(hints.checkpointSha256, createHash("sha256").update(readFileSync(manifest)).digest("hex"), "hints bound to the settled manifest");
  assert.equal(hints.captain?.kind, "pinned");

  // A tuning change lands on the next message (core-service-92): the
  // message restores the snapshot into a fresh shell and a new runtime,
  // seeded with the ledger (core-service-73, core-service-74) — the
  // Captain replies again on the new model.
  writeFileSync(configPath, VALID_CONFIG.replace("  model: claude-test\nplayers:", "  model: claude-tuned\nplayers:"));
  await service.reloadConfig();
  await client.expectOk("turn.submit", { sessionId: session.id, text: "hello again" });
  await client.waitFor(
    (m) => m.type === "record" && m.record.type === "turn_finished" && m.record.turnId === 2,
  );
  const transcript = JSON.stringify(client.records("session").filter((m) => m.record.turnId === 2));
  assert.ok(transcript.includes("not json on purpose"), "the Captain replied on the continued turn");
  await client.waitFor((m) => m.type === "session.state" && m.session.id === session.id && m.session.turns === 2 && m.session.turnActive === false);
  const after = JSON.parse(readFileSync(manifest, "utf8")) as {
    snapshot: { effectLedger: unknown; sequences: { turn: number } };
  };
  assert.equal(JSON.stringify(after.snapshot.effectLedger), ledgerBefore, "ledger intact");
  assert.equal(after.snapshot.sequences.turn, 2, "the shell counted both turns");
  assert.ok(JSON.stringify((after as unknown as { lastAppliedExecutionProjection: { captain: unknown } }).lastAppliedExecutionProjection.captain).includes("claude-tuned"), "the new model was applied");
  await client.waitFor((m) => m.type === "session.state" && m.session.id === session.id && m.session.turns === 2 && m.session.live === false);

  // An unrelated addition changes nothing (core-service-92): a second
  // playbook with its own player enters the config, the session keeps
  // its stored members, and a third message continues it.
  writeFileSync(configPath, VALID_CONFIG
    .replace("  model: claude-test\nplayers:", "  model: claude-tuned\nplayers:")
    .replace("    model: claude-test\nplaybooks:", "    model: claude-test\n  dev.reviewer:\n    adapter: claude\n    model: claude-test\nplaybooks:")
    + "  review:\n    from: \"@sublang/playbook/review/registry\"\n    roles:\n      coder: dev.coder\n      reviewer: dev.reviewer\n");
  await service.reloadConfig();
  await client.expectOk("turn.submit", { sessionId: session.id, text: "and again" });
  await client.waitFor((m) => m.type === "session.state" && m.session.id === session.id && m.session.turns === 3 && m.session.live === false);
  const narrowed = JSON.parse(readFileSync(manifest, "utf8")) as { structuralProjection: { catalog: Record<string, unknown>; players: { id: string }[] } };
  assert.deepEqual(Object.keys(narrowed.structuralProjection.catalog), ["code"], "the stored catalog is the session's own");
  assert.deepEqual(narrowed.structuralProjection.players.map((player) => player.id), ["dev.coder"]);

  // Structural drift: the roster changed since, so the refusal names the
  // change and offers a new session, which the project then accepts
  // (core-service-73, core-service-92).
  writeFileSync(configPath, VALID_CONFIG.replace(/dev\.coder/g, "dev.other"));
  await service.reloadConfig();
  const drift = await client.command("turn.submit", { sessionId: session.id, text: "once more" });
  assert.ok(!drift.ok && drift.error.code === "invalid_config");
  assert.ok(!drift.ok && /dev\.coder/.test(drift.error.message), `names the change: ${!drift.ok ? drift.error.message : ""}`);
  assert.ok(!drift.ok && /new session/.test(drift.error.message), "offers a new session");
  const stillEnded = (await client.expectOk("session.list", {})).find(
    (s: SessionInfo) => s.id === session.id,
  );
  assert.equal(stillEnded?.live, false, "the session stays as it was");
  const fresh = await client.expectOk("session.create", { projectId: project.id });
  assert.notEqual(fresh.id, session.id);

  client.close();
});

// ---------------------------------------------------------------------------
// CORE-66: the shared config relocates once from its previous location
// ---------------------------------------------------------------------------

test("core-service-66: a config at the previous location relocates once, bytes and mode kept, seeding nothing over it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spex-relocate-"));
  const home = join(dir, "home");
  const xdg = join(dir, "xdg");
  const legacy = join(xdg, "playbook", "playbook.config.yaml");
  mkdirSync(dirname(legacy), { recursive: true });
  const text = `# the user's own comment\n${VALID_CONFIG}`;
  writeFileSync(legacy, text, { mode: 0o640 });
  const env = { HOME: home, XDG_CONFIG_HOME: xdg };
  const canonical = join(dir, "state", "playbook", "playbook.config.yaml");

  const first = await CoreService.start({
    token: "test",
    dataDir: join(dir, "state"),
    env,
    home,
    watchConfig: false,
  });
  assert.equal(readFileSync(canonical, "utf8"), text, "bytes preserved");
  // Permission bits are POSIX; Windows reports its own fixed mode.
  if (process.platform !== "win32") {
    assert.equal(statSync(canonical).mode & 0o777, 0o640, "mode preserved");
  }
  assert.equal(readFileSync(legacy, "utf8"), text, "the legacy file stays in place");
  const client = new Client(first.port());
  await client.open();
  const state = await client.expectOk("config.get", {});
  assert.equal(state.status, "valid");
  assert.equal(
    state.status === "valid" ? state.seeded : true,
    false,
    "the relocated config is the user's, not a seed",
  );
  client.close();
  await first.stop();

  // Editing the canonical copy afterwards never pulls the legacy one back.
  writeFileSync(canonical, `${text}# edited after relocation\n`);
  const second = await CoreService.start({
    token: "test",
    dataDir: join(dir, "state"),
    env,
    home,
    watchConfig: false,
  });
  assert.ok(readFileSync(canonical, "utf8").endsWith("# edited after relocation\n"));
  await second.stop();
});

// ---------------------------------------------------------------------------
// playbook-library-17: compile.run over the protocol with a stub slc,
// the bindings re-keyed onto the entry's derived role ids
// (playbook-library-32)
// ---------------------------------------------------------------------------

test("playbook-library-32: compile.run binds derived roles however the form cased them", async () => {
  const stubDir = mkdtempSync(join(tmpdir(), "spex-stub-slc-"));
  const stubPath = join(stubDir, "stub-slc.cjs");
  // slc emits the ids as the gears declared them (DR-032): `Coder`
  // and `Reviewer`, not their lowercase forms.
  writeFileSync(stubPath, stubSlcSource("['Coder', 'Reviewer']"));
  const harness = await startHarness(VALID_CONFIG, {
    env: { SPEX_SLC: `${process.execPath} ${stubPath}` },
    // The toolchain probe wants a system Node slc can run on; the
    // runner's own Node is whatever CI installed, so the probe is
    // answered here and every other spawn — the stub slc — is real.
    compileSpawner: (command, args, cwd, onLine, signal) => {
      if (args.length === 1 && args[0] === "--version" && command !== process.execPath) {
        onLine("v24.1.0");
        return Promise.resolve(0);
      }
      return defaultSpawner(command, args, cwd, onLine, signal);
    },
  });
  const client = new Client(harness.service.port());
  await client.open();

  // The form keys one binding as the role reads and one lowercased;
  // both must land on the derived ids.
  const state = await client.expectOk("compile.run", {
    playbookId: "pair",
    sourceText: "# Pair\n\nA two-player workflow.\n",
    roles: ["Coder", "Reviewer"],
    command: "pair",
    intent: "pair workflow for tests",
    bindings: { Coder: "dev.coder", reviewer: "dev.reviewer" },
    newPlayers: { "dev.reviewer": { adapter: "claude" } },
  });
  assert.equal(state.status, "valid");
  const registered =
    state.status === "valid"
      ? state.summary.playbooks.find((p) => p.id === "pair")
      : undefined;
  assert.ok(registered, "the compiled playbook is configured");
  assert.ok(
    registered.from.startsWith(join(harness.dataDir, "playbooks", "pair")),
    `manifest under the library: ${registered.from}`,
  );
  // The config entry binds each derived role by its own id.
  const config = readFileSync(join(harness.dir, "playbook.config.yaml"), "utf8");
  const start = config.indexOf("\n  pair:\n");
  assert.ok(start >= 0, "the pair entry is written");
  const pairEntry = config.slice(start);
  assert.match(pairEntry, /\n      Coder: dev\.coder\n/);
  assert.match(pairEntry, /\n      Reviewer: dev\.reviewer\n/);
  assert.doesNotMatch(pairEntry, /\n      (coder|reviewer): /);

  // The new playbook's artifacts serve its machine.
  const artifacts = await client.expectOk("playbook.artifacts", {
    playbookId: "pair",
  });
  assert.ok(artifacts.machine, "machine graph served");
  assert.ok(artifacts.machine.nodes.some((node) => node.id === "ready"));

  client.close();
  await harness.service.stop();
});


for (const selection of ["default", "home override", "sessions override"] as const) {
  test(`storage-15: legacy default discovery respects ${selection}`, async (t) => {
    const home = mkdtempSync(join(tmpdir(),"spex-legacy-default-"));
    const dataDir = selection === "home override" ? join(home,"custom") : join(home,".spex");
    const legacyDir = join(home,"old-state","playbook","sessions");
    const projectPath = join(home,"project");
    const configPath = join(home,"custom-config.yaml");
    mkdirSync(legacyDir,{recursive:true,mode:0o700}); mkdirSync(projectPath);
    execFileSync("git",["init","-q",projectPath]);
    writeFileSync(configPath,(selection === "sessions override" ? `sessions: ${join(dataDir,"sessions")}\n` : "") + VALID_CONFIG);
    const plan = await loadLaunchPlan({userConfigPath:configPath});
    const {imports} = fakeAdapterImports({fallback:{result:"Done"}});
    const seedDir = join(home,"seed-sessions");
    const seed = await openSessionHost({store:createSessionStore({sessionsDir:seedDir}),mode:"new",cwd:projectPath,
      config:executionConfigFromPlan(plan),adapterImports:imports});
    await seed.handleBossTurn("Prior CLI work");
    const sessionId = seed.sessionId;
    const source = join(legacyDir,`${sessionId}.json`);
    const original = JSON.stringify(await seed.read());
    assert.equal(JSON.parse(original).schemaVersion,6,"the public lifecycle exports the released legacy recovery projection");
    await seed.dispose();
    writeFileSync(source,original,{mode:0o600});
    writeFileSync(join(legacyDir,`${sessionId}.records.jsonl`),readFileSync(join(seedDir,`${sessionId}.records.jsonl`)),{mode:0o600});
    const service = await CoreService.start({token:"test",configPath,dataDir,home,watchConfig:false,
      env:{HOME:home,XDG_STATE_HOME:join(home,"old-state"),...(selection === "home override" ? {SPEX_HOME:dataDir} : {})}});
    t.after(async () => {await service.stop();rmSync(home,{recursive:true,force:true});});
    const client = new Client(service.port()); t.after(() => client.close()); await client.open();
    await client.expectOk("project.register",{path:projectPath});
    const sessions = await client.expectOk("session.list",{});
    if (selection === "default") {
      assert.equal(sessions[0]?.id,sessionId); assert.equal(sessions[0]?.title,"Prior CLI work");
      assert.equal(sessions[0]?.continuable,true);
      assert.equal(existsSync(source),false,"old active manifest retires after the new bundle is valid");
      const migrations = join(dataDir,"local","migrations");
      const inputs = readdirSync(migrations,{recursive:true}).filter((path) => String(path).endsWith(join("inputs","0")));
      assert.ok(inputs.some((path) => readFileSync(join(migrations,String(path)),"utf8") === original),"original bytes are retained locally");
    } else {
      assert.equal(sessions.length,0); assert.equal(readFileSync(source,"utf8"),original);
    }
  });
}

for (const action of ["retry", "discard"] as const) {
  test(`core-service-84: desktop ${action} recovers CLI storage without current config`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "spex-cross-host-recovery-"));
    const configPath = join(dir, "config.yaml");
    const projectPath = join(dir, "project");
    const dataDir = join(dir, "state");
    const sessionsDir = join(dataDir, "sessions");
    mkdirSync(projectPath);
    execFileSync("git", ["init", "-q", projectPath]);
    writeFileSync(configPath, VALID_CONFIG);
    const plan = await loadLaunchPlan({userConfigPath: configPath});
    const config = executionConfigFromPlan(plan);
    const {imports, stats} = fakeAdapterImports({fallback: {result: "recovered answer"}});
    const shared = createSessionStore({sessionsDir});
    const cli = await openSessionHost({store: shared, mode: "new", cwd: projectPath, config, adapterImports: imports});
    t.after(() => cli.dispose());
    const sessionId = cli.sessionId;
    // Uncertainty under an active CLI lease is not interrupted work.
    await cli.lease.beginTurn({input: "saved CLI input", attemptId: randomUUID(), attemptedExecutionProjection: config});
    writeFileSync(configPath, "captain: [invalid current config]\n");
    const service = await CoreService.start({token:"test", configPath, dataDir, adapterImports:imports, env:{}, watchConfig:true});
    t.after(async () => { await service.stop(); rmSync(dir, {recursive:true,force:true}); });
    const client = new Client(service.port());
    t.after(() => client.close());
    await client.open();
    assert.equal((await client.expectOk("session.list", {})).length, 0, "unregistered CLI history is not guessed");
    const project = await client.expectOk("project.register", {path:projectPath});
    const session = (await client.expectOk("session.list", {})).find((item) => item.id === sessionId);
    assert.equal(session?.projectId, project.id);
    assert.equal(session?.externalWriter,"active");
    assert.equal(session?.live,true);
    assert.equal(session?.recovery,undefined);
    assert.equal((await client.command(`session.${action}`,{sessionId})).ok,false);
    // Releasing only the lease must reveal recovery without a stream write.
    await cli.dispose();
    await client.waitFor((message) => message.type === "session.state" && message.session.id === sessionId && message.session.recovery?.input === "saved CLI input" && !message.session.externalWriter);
    const blocked = await client.command("turn.submit", {sessionId, text:"replacement input"});
    assert.equal(blocked.ok, false, "ordinary input cannot retry uncertainty");
    assert.equal(stats.runs.length, 0);
    // Both commands use the same exclusive lease as the CLI.
    const holder = await shared.acquire(sessionId);
    const busy = await client.command(`session.${action}`, {sessionId});
    assert.equal(busy.ok, false);
    assert.equal(stats.runs.length, 0);
    await holder.release();
    await client.expectOk("project.register",{path:projectPath});
    if (action === "retry") {
      await client.expectOk("subscribe", {channel:{kind:"session",sessionId}});
      await client.expectOk("session.retry", {sessionId});
      await client.waitFor((m) => m.type === "session.state" && m.session.id === sessionId && !m.session.turnActive && m.session.turns > 0 && !m.session.recovery);
      const manifest = validateSessionManifest(await shared.readManifest(sessionId));
      assert.equal(manifest.state, "settled");
      assert.ok(stats.runs.some((run) => run.prompt.includes("saved CLI input")));
      assert.ok(stats.runs.every((run) => !run.prompt.includes("replacement input")));
      assert.ok(!JSON.stringify(manifest).includes("fake-resume-"));
      // Settlement released the runtime (core-service-91); the same CLI
      // facade can reopen the desktop settlement at once.
      await client.waitFor((m) => m.type === "session.state" && m.session.id === sessionId && m.session.live === false);
      const reopened = await openSessionHost({store:shared,sessionId,mode:"continue",cwd:projectPath,config,adapterImports:imports});
      await reopened.handleBossTurn("continued in CLI");
      assert.equal((await reopened.read())?.state, "settled");
      await reopened.dispose();
    } else {
      assert.deepEqual(await client.expectOk("session.discard", {sessionId}), {removed:false});
      assert.equal(stats.runs.length, 0, "Discard invokes no agents");
      const restored = validateSessionManifest(await shared.readManifest(sessionId));
      assert.equal(restored.state, "settled", "restore the initialized turn-zero checkpoint");
      assert.equal(restored.snapshot.sequences.turn, 0);
      assert.ok(existsSync(join(sessionsDir, `${sessionId}.records.jsonl`)));
      assert.equal((await client.expectOk("session.list", {}))[0]?.recovery, undefined);
    }
  });
}

// Review regressions exercise the public protocol with independent files.
test("core-service-86: damaged sessions refuse only their own execution and remain deletable", async (t) => {
  const harness = await startHarness(VALID_CONFIG, {realShell:true});
  const client = new Client(harness.service.port()); await client.open();
  t.after(async () => {client.close(); await harness.service.stop(); rmSync(harness.dir,{recursive:true,force:true});});
  const project = await client.expectOk("project.register", {path:harness.projectDir});
  const damaged = await client.expectOk("session.create", {projectId:project.id});
  await client.expectOk("session.dispose", {sessionId:damaged.id});
  const manifestFile = join(harness.dataDir,"sessions",`${damaged.id}.json`);
  const manifest = JSON.parse(readFileSync(manifestFile,"utf8"));
  manifest.replay.sha256 = "0".repeat(64); writeFileSync(manifestFile,JSON.stringify(manifest));
  await harness.service["syncForeignSessions"]();
  const reports = await client.expectOk("storage.diagnostics", {});
  assert.ok(reports.some((report) => report.blocking && report.file.endsWith(`${damaged.id}.json`)));
  for (const type of ["turn.submit","session.retry","session.discard"] as const) {
    const reply = type === "turn.submit" ? await client.command(type,{sessionId:damaged.id,text:"resume"}) : await client.command(type,{sessionId:damaged.id});
    assert.ok(!reply.ok && reply.error.code === "invalid_request", JSON.stringify(reply));
    assert.ok(!reply.ok && reply.error.message.includes(`${damaged.id}.json`));
  }
  await client.expectOk("config.edit", {op:{kind:"captain.set",patch:{instruction:"Independent edit"}}});
  await client.expectOk("intent.queue", {projectId:project.id,text:"Healthy queue"});
  const healthy = await client.expectOk("session.create", {projectId:project.id});
  await client.expectOk("session.viewed", {sessionId:healthy.id,turnId:0});
  await client.expectOk("session.delete", {sessionId:damaged.id});
  assert.equal(existsSync(manifestFile),false);
  assert.equal((await client.expectOk("session.list", {})).find((session) => session.id === healthy.id)?.live,true);
});

for (const defect of ["completed JSON", "cycle", "duplicate source", "foreign act"] as const) {
  test(`core-service-86: ${defect} intent damage is isolated at startup`, async (t) => {
    const harness = await startHarness(VALID_CONFIG, {realShell:true});
    let service = harness.service; let client = new Client(service.port()); await client.open();
    t.after(async () => {client.close(); await service.stop(); rmSync(harness.dir,{recursive:true,force:true});});
    const bad = await client.expectOk("project.register", {path:harness.projectDir});
    const register = async (name:string) => {const path=join(harness.dir,name); mkdirSync(path); execFileSync("git",["init","-q",path]); return client.expectOk("project.register",{path});};
    const good = await register("good"); const dependent = await register("dependent");
    const first = await client.expectOk("intent.queue", {projectId:bad.id,text:"A",source:{kind:"issue",ref:"1"}});
    const second = await client.expectOk("intent.queue", {projectId:bad.id,text:"B"});
    const healthy = await client.expectOk("intent.queue", {projectId:good.id,text:"Healthy"});
    await client.expectOk("intent.queue", {projectId:dependent.id,text:"After A",afterIntentId:first.id});
    client.close(); await service.stop();
    const file=join(harness.dataDir,"intents",`${bad.id}.jsonl`);
    const line=(act:object) => JSON.stringify({v:1,...act})+"\n";
    if (defect === "completed JSON") appendFileSync(file,"broken JSON\n");
    if (defect === "cycle") appendFileSync(file,line({act:"link",id:first.id,afterId:second.id})+line({act:"link",id:second.id,afterId:first.id}));
    if (defect === "duplicate source") appendFileSync(file,line({act:"queue",intent:{id:randomUUID(),projectId:bad.id,text:"Duplicate",rank:"z",createdAt:1,source:{kind:"issue",ref:"1"}}}));
    if (defect === "foreign act") appendFileSync(file,line({act:"edit",id:healthy.id,text:"Cross-project corruption"}));
    const before=readFileSync(file);
    service=await CoreService.start({token:"test",dataDir:harness.dataDir,configPath:join(harness.dir,"playbook.config.yaml"),env:{},home:join(harness.dir,"home"),watchConfig:false,adapterImports:fakeAdapterImports({}).imports});
    client=new Client(service.port()); await client.open();
    const reports=await client.expectOk("storage.diagnostics",{});
    assert.ok(reports.some((report)=>report.blocking&&report.file.includes(bad.id)));
    assert.ok(reports.some((report)=>report.blocking&&report.file.includes(dependent.id)));
    for (const project of [bad,dependent]) {
      const reply=await client.command("intent.queue",{projectId:project.id,text:"Refused"});
      assert.ok(!reply.ok&&reply.error.code==="invalid_request",JSON.stringify(reply));
      assert.ok(!reply.ok&&reply.error.message.includes(project.id));
    }
    await client.expectOk("intent.edit",{intentId:healthy.id,text:"Still editable"});
    await client.expectOk("intent.queue",{projectId:good.id,text:"Still queueable"});
    await client.expectOk("config.edit",{op:{kind:"captain.set",patch:{instruction:"Still configurable"}}});
    const session=await client.expectOk("session.create",{projectId:good.id});
    await client.expectOk("session.viewed",{sessionId:session.id,turnId:0});
    assert.deepEqual(readFileSync(file),before,"invalid log bytes preserved");
  });
}

for (const file of ["projects.json", "local/project-paths.json", "prefs.json"]) {
  test(`core-service-86: invalid ${file} leaves independent configuration available`, async (t) => {
    const harness=await startHarness(); let service=harness.service; let client=new Client(service.port()); await client.open();
    t.after(async()=>{client.close(); await service.stop(); rmSync(harness.dir,{recursive:true,force:true});});
    const project=await client.expectOk("project.register",{path:harness.projectDir});
    const session=await client.expectOk("session.create",{projectId:project.id});
    await client.expectOk("session.dispose",{sessionId:session.id});
    client.close(); await service.stop();
    const path=join(harness.dataDir,file); writeFileSync(path,"{bad JSON}");
    service=await CoreService.start({token:"test",dataDir:harness.dataDir,configPath:join(harness.dir,"playbook.config.yaml"),env:{},home:join(harness.dir,"home"),watchConfig:false});
    client=new Client(service.port()); await client.open();
    assert.ok((await client.expectOk("storage.diagnostics",{})).some((report)=>report.blocking&&report.file.endsWith(file)));
    await client.expectOk("config.edit",{op:{kind:"captain.set",patch:{instruction:"Independent config"}}});
    const refused=file==="prefs.json" ? await client.command("session.viewed",{sessionId:session.id,turnId:1}) : await client.command("project.register",{path:harness.projectDir});
    assert.ok(!refused.ok&&refused.error.code==="invalid_request",JSON.stringify(refused));
    if (file !== "prefs.json") {
      const destination=join(harness.dir,"must-not-be-created");
      const creation=await client.command("project.create",{path:destination});
      assert.ok(!creation.ok&&creation.error.code==="invalid_request",JSON.stringify(creation));
      assert.equal(existsSync(destination),false,"registry refusal precedes scaffolding or Git writes");
    }
    assert.equal(readFileSync(path,"utf8"),"{bad JSON}");
  });
}

/** Pause after a real lease read to reproduce a scan begun before local admission. */
test("core-service-32: a pending foreign scan cannot overwrite locally acquired ownership", async (t) => {
  const harness=await startHarness(VALID_CONFIG,{realShell:true});
  const client=new Client(harness.service.port()); await client.open();
  t.after(async()=>{client.close(); await harness.service.stop(); rmSync(harness.dir,{recursive:true,force:true});});
  const project=await client.expectOk("project.register",{path:harness.projectDir});
  const session=await client.expectOk("session.create",{projectId:project.id});
  await client.expectOk("session.dispose",{sessionId:session.id});
  const store=harness.service["store"]; const shared=store.sessionStore();
  let release!:()=>void; const paused=new Promise<void>((resolve)=>{release=resolve;});
  let observed!:()=>void; const entered=new Promise<void>((resolve)=>{observed=resolve;});
  let intercept=true;
  store.sessionStore=()=>({...shared,readLeaseState:async(id)=>{
    const result=await shared.readLeaseState(id);
    if (intercept&&id===session.id) {intercept=false; observed(); await paused; return "active";}
    return result;
  }});
  const scan=store.refreshSession(session.id,false); await entered;
  try {
    await client.expectOk("turn.submit",{sessionId:session.id,text:"Local continuation"});
    release(); await scan;
    const listed=(await client.expectOk("session.list",{})).find((item)=>item.id===session.id)!;
    assert.equal(listed.live,true); assert.equal(listed.externalWriter,undefined);
    assert.equal(store.describeSession(session.id)?.externalWriter,undefined);
    await client.waitFor((message)=>message.type==="session.state"&&message.session.id===session.id&&message.session.turns===1&&message.session.turnActive===false);
    assert.ok(client.messages.filter((message)=>message.type==="session.state"&&message.session.id===session.id).every((message)=>message.type!=="session.state"||message.session.externalWriter===undefined));
  } finally {release(); await scan;}
});

/** The replay terminal record does not grant permission to end the transaction. */
test("core-service-32/39: shutdown waits for a paused durable settlement after runtime completion", async (t) => {
  const harness=await startHarness(VALID_CONFIG,{realShell:true});
  const client=new Client(harness.service.port()); await client.open();
  let stopped=false;
  let release!:()=>void;
  t.after(async()=>{release?.(); client.close(); if(!stopped) await harness.service.stop(); rmSync(harness.dir,{recursive:true,force:true});});
  const store=harness.service["store"]; const shared=store.sessionStore();
  const paused=new Promise<void>((resolve)=>{release=resolve;});
  let settling!:()=>void; const entered=new Promise<void>((resolve)=>{settling=resolve;});
  store.sessionStore=()=>({...shared,acquire:async(id)=>{
    const lease=await shared.acquire(id);
    return {...lease,settle:async(...args:Parameters<typeof lease.settle>)=>{settling(); await paused; return lease.settle(...args);}};
  }});
  const project=await client.expectOk("project.register",{path:harness.projectDir});
  const session=await client.expectOk("session.create",{projectId:project.id});
  await client.expectOk("subscribe",{channel:{kind:"session",sessionId:session.id}});
  await client.expectOk("turn.submit",{sessionId:session.id,text:"Settle exactly once"});
  await entered;
  const manifestFile=join(harness.dataDir,"sessions",`${session.id}.json`);
  assert.equal(JSON.parse(readFileSync(manifestFile,"utf8")).state,"uncertain");
  await client.waitFor((message)=>message.type==="record"&&message.record.type==="turn_finished");
  const listed=(await client.expectOk("session.list",{})).find((item)=>item.id===session.id)!;
  assert.equal(listed.turnActive,true,"durable settlement is still pending");
  const busy=await client.command("turn.submit",{sessionId:session.id,text:"Too early"});
  assert.ok(!busy.ok&&busy.error.code==="busy");
  let finished=false; const stop=harness.service.stop().then(()=>{finished=true;stopped=true;});
  try {
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.equal(finished,false,"shutdown joins the pending transaction");
    release(); await stop;
    const checked=await shared.validate(session.id);
    assert.equal(checked.manifest.state,"settled"); assert.equal(checked.integrityValid,true);
    assert.equal((checked.manifest as {snapshot?:{sequences?:{turn:number}}}).snapshot?.sequences?.turn,1);
  } finally {release(); await stop;}
});


test("core-service-81: saved Captain, player context and graphs survive removal of the playbook module", async (t) => {
  const moduleDir=mkdtempSync(join(tmpdir(),"spex-removed-module-"));
  const registry=resolveModulePath("@sublang/playbook/code/registry")!;
  const wrapper=join(moduleDir,"code.registry.mjs");
  writeFileSync(wrapper,`export {default} from ${JSON.stringify(pathToFileURL(registry).href)};\nexport const spexRegistryContract = ${REGISTRY_CONTRACT};\n`);
  writeFileSync(join(moduleDir,"code.fsm.ts"),readFileSync(join(dirname(registry),"code.fsm.ts")));
  const harness=await startHarness(VALID_CONFIG.replace("@sublang/playbook/code/registry",wrapper),{realShell:true});
  let service=harness.service; let client=new Client(service.port()); await client.open();
  t.after(async()=>{client.close(); await service.stop(); rmSync(harness.dir,{recursive:true,force:true}); rmSync(moduleDir,{recursive:true,force:true});});
  const project=await client.expectOk("project.register",{path:harness.projectDir});
  const session=await client.expectOk("session.create",{projectId:project.id});
  await client.expectOk("turn.submit",{sessionId:session.id,text:"Retained history"});
  await client.waitFor((message)=>message.type==="session.state"&&message.session.id===session.id&&message.session.turns===1&&message.session.turnActive===false);
  await client.expectOk("session.dispose",{sessionId:session.id});
  const before=await client.expectOk("history.get",{sessionId:session.id});
  const context=before.records.find((entry)=>(entry.record as {type?:string}).type==="session_context")!.record as unknown as {configuration:{captain:{adapter:string};players:{id:string}[]};graphs:{playbookId:string;graph:unknown}[]};
  assert.equal(context.configuration.captain.adapter,"claude");
  assert.equal(context.configuration.players[0].id,"dev.coder");
  assert.ok(context.graphs.find((entry)=>entry.playbookId==="code")?.graph,"graph stored with context");
  client.close(); await service.stop(); rmSync(moduleDir,{recursive:true,force:true});
  let imports=0;
  service=await CoreService.start({token:"test",dataDir:harness.dataDir,configPath:join(harness.dir,"playbook.config.yaml"),env:{},home:join(harness.dir,"home"),watchConfig:false,loadModule:async()=>{imports++; throw new Error("playbook module removed");}});
  client=new Client(service.port()); await client.open();
  assert.equal((await client.expectOk("config.get",{})).status,"invalid");
  const importsAtStartup=imports;
  assert.deepEqual(await client.expectOk("history.get",{sessionId:session.id}),before);
  const listed=(await client.expectOk("session.list",{})).find((item)=>item.id===session.id)!;
  assert.deepEqual(listed.players,session.players); assert.deepEqual(listed.initialVisible,session.initialVisible);
  assert.equal(listed.live,false); assert.equal(listed.turnActive,false);
  assert.equal(imports,importsAtStartup,"reading saved history and graphs imports no module");
});

test("core-service-86: unreadable legacy sidecars and forge cache preserve unrelated startup", async (t) => {
  const harness=await startHarness(VALID_CONFIG,{realShell:true});
  let service=harness.service; let client=new Client(service.port()); await client.open();
  t.after(async()=>{client.close(); await service.stop(); rmSync(harness.dir,{recursive:true,force:true});});
  const project=await client.expectOk("project.register",{path:harness.projectDir});
  const prior=await client.expectOk("session.create",{projectId:project.id});
  await client.expectOk("session.dispose",{sessionId:prior.id});
  client.close(); await service.stop();
  const sidecar=join(harness.dataDir,"sessions",`${randomUUID()}.spex.json`);
  const malformed=join(harness.dataDir,"sessions",`${randomUUID()}.spex.json`);
  const malformedBytes=JSON.stringify({id:"../outside-store",projectId:project.id,players:[],initialVisible:[]});
  const cache=join(harness.dataDir,"forge-cache.json");
  writeFileSync(sidecar,"{broken sidecar",{mode:0o600}); writeFileSync(malformed,malformedBytes,{mode:0o600}); writeFileSync(cache,"{broken cache");
  service=await CoreService.start({token:"test",dataDir:harness.dataDir,configPath:join(harness.dir,"playbook.config.yaml"),env:{},home:join(harness.dir,"home"),watchConfig:false,adapterImports:fakeAdapterImports({}).imports});
  client=new Client(service.port()); await client.open();
  const diagnostics=await client.expectOk("storage.diagnostics",{});
  assert.ok(diagnostics.some((entry)=>entry.file===sidecar&&entry.reason.length>0));
  assert.ok(diagnostics.some((entry)=>entry.file===malformed&&entry.reason.length>0));
  assert.ok(diagnostics.some((entry)=>entry.file===cache&&!entry.blocking));
  assert.ok((await client.expectOk("session.list",{})).some((session)=>session.id===prior.id));
  await client.expectOk("config.edit",{op:{kind:"captain.set",patch:{instruction:"Still available"}}});
  const created=await client.expectOk("session.create",{projectId:project.id});
  assert.equal(created.live,true);
  assert.equal(readFileSync(sidecar,"utf8"),"{broken sidecar");
  assert.equal(readFileSync(malformed,"utf8"),malformedBytes);
  assert.equal(readFileSync(cache,"utf8"),"{broken cache");
});

test("storage-15: repeated default-home startup does not grow leases for a refused sidecar", async (t) => {
  const root=mkdtempSync(join(tmpdir(),"spex-migration-refusal-"));
  const home=join(root,"home");const dataDir=join(home,".spex");const sessionsDir=join(dataDir,"sessions");
  const configPath=join(dataDir,"playbook","playbook.config.yaml");mkdirSync(dirname(configPath),{recursive:true});writeFileSync(configPath,VALID_CONFIG);
  const projectPath=join(root,"project");mkdirSync(projectPath);execFileSync("git",["init","-q",projectPath]);
  const options={token:"test",configPath,dataDir,home,env:{},watchConfig:false};
  let service=await CoreService.start(options);let client=new Client(service.port());await client.open();
  t.after(async()=>{client.close();await service.stop();rmSync(root,{recursive:true,force:true});});
  const project=await client.expectOk("project.register",{path:projectPath});
  client.close();await service.stop();
  const id=randomUUID();const sidecar=join(sessionsDir,`${id}.spex.json`);
  const valid={v:1,id,projectId:project.id,createdAt:1,endedAt:2,live:false,players:[],initialVisible:[]};
  const refused=JSON.stringify({...valid,v:99});writeFileSync(sidecar,refused,{mode:0o600});
  const guards=()=>readdirSync(sessionsDir).filter((name)=>name.startsWith(`.${id}.lock`)).sort();
  for(let restart=0;restart<3;restart++){
    service=await CoreService.start(options);client=new Client(service.port());await client.open();
    assert.ok((await client.expectOk("storage.diagnostics",{})).some((entry)=>entry.file===sidecar&&entry.reason.includes("invalid legacy desktop")));
    assert.equal(readFileSync(sidecar,"utf8"),refused);assert.deepEqual(guards(),[]);
    client.close();await service.stop();
  }
  writeFileSync(sidecar,JSON.stringify(valid));
  service=await CoreService.start(options);client=new Client(service.port());await client.open();
  assert.equal(existsSync(sidecar),false);
  assert.equal(JSON.parse(readFileSync(join(sessionsDir,`${id}.json`),"utf8")).state,"history-only");
  assert.ok((await client.expectOk("session.list",{})).some((session)=>session.id===id));
  const migratedGuards=guards();assert.equal(migratedGuards.length,1);
  client.close();await service.stop();
  service=await CoreService.start(options);client=new Client(service.port());await client.open();
  assert.deepEqual(guards(),migratedGuards,"successful migration is not retried on the next startup");
});
