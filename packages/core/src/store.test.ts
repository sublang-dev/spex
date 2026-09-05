// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { projectCaptainSessionStructure, type SessionExecutionProjection, type SessionFreshBoundary } from "@sublang/playbook/session-store";

import { StateRootHeldError, Store } from "./store.js";
import type { SessionInfo, TmuxPlayRecord } from "./protocol.js";

const PROJECT_PATH = join(tmpdir(), "spex-store-project");

function tempRoot(): string {
  return join(mkdtempSync(join(tmpdir(), "spex-store-")), "state");
}

function sampleSession(store: Store): SessionInfo {
  const project = store.registerProject(PROJECT_PATH, "proj", 1000);
  const session: SessionInfo = {
    id: "71000000-0000-4000-8000-000000000001",
    projectId: project.id,
    projectPath: project.path,
    createdAt: 2000,
    live: true,
    endedAt: null,
    players: [{ id: "dev.coder", adapter: "claude" }],
    turns: 0,
    failed: false,
    initialVisible: ["dev.coder"],
  };
  store.createSession(session);
  return session;
}

const SESSION = "71000000-0000-4000-8000-000000000001";
const execution: SessionExecutionProjection = {
  schemaVersion: 2,
  captain: { adapter: "claude", model: { kind: "provider-default" }, effort: { kind: "provider-default" }, permissions: { mode: "auto" } },
  players: [{ id: "dev.coder", adapter: "codex", model: { kind: "provider-default" }, effort: { kind: "provider-default" }, permissions: {} }],
  catalog: { code: { id: "code", from: "@sublang/playbook/code/registry", manifestCommand: "code", command: "code", intent: "Implement a change", artifactSchema: 3, requiredRoleIds: ["coder"], concurrentRoleSets: [], roles: { coder: { playerId: "dev.coder", model: { kind: "provider-default" }, effort: { kind: "provider-default" } } }, options: {} } },
};
async function sharedSession(store: Store) {
  store.registerProject(PROJECT_PATH, "proj", 1000);
  const shared = store.sessionStore(); await shared.prepare();
  const lease = await shared.acquire(SESSION);
  const structure = projectCaptainSessionStructure(execution);
  const captainId = "71000000-0000-4000-8000-000000000007";
  const ledger = { schemaVersion: 1, revision: 0, boundaries: [], logicalOperations: [] };
  const state = { value: "routing", activeStateIds: ["routing"], tags: ["playbook.parked"], status: "active", quiescent: true, stateId: "routing" };
  const snapshot = {
    schemaVersion: 4,
    captain: {
      sessionId: captainId, agent: structure.captain, conversation: { kind: "unopened" },
      runtime: { schemaVersion: 4, playbookId: "captain", machine: { value: "routing", status: "active" }, roleResumeTokens: {},
        sequences: { trace: 0, turn: 0, judgeCall: 0, playerCall: 0, playbookCall: 0, captainCall: 0 }, state, pendingBossQuestions: [], effectLedger: ledger },
    },
    playerSessions: Object.fromEntries(structure.players.map(({ id, ...agent }) => [id, agent])), issuedSessionIds: [captainId], sequences: { turn: 0, journal: 0 }, journal: [], effectLedger: ledger, mode: "chat",
  } as unknown as SessionFreshBoundary["snapshot"];
  await lease.initializeSettledWithPredecessor({ cwd: PROJECT_PATH, structuralProjection: structure, executionProjection: execution, snapshot });
  return lease;
}

test("projects register idempotently by path and can be removed", () => {
  const store = new Store({ dir: tempRoot() });
  const a = store.registerProject(join(tmpdir(), "spex-store-x"), "x", 1);
  const b = store.registerProject(join(tmpdir(), "spex-store-x"), "x", 2);
  assert.equal(a.id, b.id);
  assert.equal(store.listProjects().length, 1);
  assert.ok(store.removeProject(a.id));
  assert.equal(store.listProjects().length, 0);
  store.close();
});

test("records persist through the shared lifecycle with order and hidden flags", async () => {
  const dir = tempRoot();
  const store = new Store({ dir });
  const lease = await sharedSession(store);
  const visible: TmuxPlayRecord = {
    type: "captain_status",
    turnId: 1,
    timestamp: 10,
    message: "◇ /code started",
  } as TmuxPlayRecord;
  const hidden: TmuxPlayRecord = {
    type: "captain_prompt",
    turnId: 1,
    timestamp: 11,
    prompt: "route this",
    visibility: "hidden",
  } as TmuxPlayRecord;
  await lease.append(visible);
  await lease.append(hidden);
  await lease.release();
  store.close();

  const reopened = new Store({ dir });
  await reopened.initializeSessions();
  const filtered = reopened.getRecords("71000000-0000-4000-8000-000000000001");
  assert.deepEqual(
    filtered.map((r) => r.seq),
    [1, 2],
  );
  const all = reopened.getRecords("71000000-0000-4000-8000-000000000001", { includeHidden: true });
  assert.deepEqual(
    all.map((r) => r.seq),
    [1, 2, 3],
  );
  assert.equal(all[2].record.type, "captain_prompt");
  assert.equal(reopened.maxSeq(SESSION), 3);
  reopened.close();
});

test("liveness comes from the host while shared recovery survives restart", async () => {
  const dir = tempRoot();
  const store = new Store({ dir });
  const lease = await sharedSession(store);
  await lease.release();
  await store.initializeSessions();
  assert.equal(store.listSessions()[0].continuable, true);
  store.reopenSession(SESSION, []);
  assert.equal(store.listSessions()[0].live, true);
  assert.equal(store.listSessions()[0].continuable, undefined);
  store.close();

  const reopened = new Store({ dir });
  await reopened.initializeSessions();
  assert.equal(reopened.listSessions()[0].live, false);
  assert.equal(reopened.listSessions()[0].continuable, true);
  assert.equal(reopened.listSessions()[0].projectPath, PROJECT_PATH);
  assert.equal(existsSync(join(dir, "sessions", `${SESSION}.spex.json`)), false);
  const before = readFileSync(join(dir, "sessions", `${SESSION}.json`));
  await reopened.refreshSession(SESSION);
  assert.deepEqual(readFileSync(join(dir, "sessions", `${SESSION}.json`)), before);
  reopened.close();
});

test("usage totals aggregate per session", () => {
  const store = new Store();
  sampleSession(store);
  store.addUsage({
    sessionId: "71000000-0000-4000-8000-000000000001",
    turnId: 1,
    actorId: "dev.coder",
    inputTokens: 100,
    outputTokens: 40,
    toolUses: 3,
    totalCostUsd: 0.5,
    costSource: "provider-reported",
    at: 1,
  });
  store.addUsage({
    sessionId: "71000000-0000-4000-8000-000000000001",
    turnId: 1,
    actorId: "captain",
    inputTokens: 10,
    outputTokens: 5,
    toolUses: 0,
    totalCostUsd: 0.25,
    costSource: "agent-estimate",
    at: 2,
  });
  // The provenance of every contributing entry travels with the sum,
  // so a total mixing a provider's bill with an agent's guess cannot be
  // presented as if the provider reported all of it (DR-032).
  assert.deepEqual(store.sessionUsage("71000000-0000-4000-8000-000000000001"), {
    inputTokens: 110,
    outputTokens: 45,
    toolUses: 3,
    totalCostUsd: 0.75,
    costSources: ["agent-estimate", "provider-reported"],
  });
  store.close();
});

test("prefs round-trip JSON values", () => {
  const store = new Store({ dir: tempRoot() });
  store.setPref("ui", { theme: "dark" });
  assert.deepEqual(store.getPref("ui"), { theme: "dark" });
  store.setPref("ui", { theme: "light" });
  assert.deepEqual(store.getPref("ui"), { theme: "light" });
  store.close();
});

test("core-service-32: session.list carries each session's conversation summary", () => {
  // The rail's rows are only scannable if the listing carries scent:
  // the session's own first words, its size, and whether it ended badly.
  const store = new Store();
  const project = store.registerProject(PROJECT_PATH, "proj", 1000);
  const base = {
    projectId: project.id,
    projectPath: project.path,
    createdAt: 2000,
    live: false,
    endedAt: 9000,
    players: [{ id: "dev.coder", adapter: "claude" as const }],
    initialVisible: ["dev.coder"],
    turns: 0,
    failed: false,
  };
  store.createSession({ ...base, id: "rich" });
  store.createSession({ ...base, id: "bare", createdAt: 3000 });

  store.startTurn("rich", 1, "harden the session refresh", 2100);
  store.endTurn("rich", 1, "finished", 2200);
  store.startTurn("rich", 2, "add expiry-skew tests", 2300);
  store.appendRecord("rich", 1, {
    type: "runtime_error",
    turnId: 2,
    timestamp: 2400,
    message: "The Captain's turn failed: adapter sign-in expired",
  } as TmuxPlayRecord);
  store.addUsage({
    sessionId: "rich",
    turnId: 1,
    actorId: "dev.coder",
    inputTokens: 100,
    outputTokens: 20,
    toolUses: 1,
    totalCostUsd: 0.16,
    at: 2500,
  });

  const listed = store.listSessions();
  const rich = listed.find((session) => session.id === "rich");
  const bare = listed.find((session) => session.id === "bare");

  assert.equal(rich?.title, "harden the session refresh");
  assert.equal(rich?.turns, 2);
  assert.equal(rich?.failed, true);

  // A session that never held a turn says so by carrying no title,
  // rather than faking a name.
  assert.equal(bare?.title, undefined);
  assert.equal(bare?.turns, 0);
  assert.equal(bare?.failed, false);
  store.close();
});

test("core-service-61: a held state root refuses a second store, and releases on close", () => {
  const dir = tempRoot();
  const first = new Store({ dir });
  assert.throws(
    () => new Store({ dir }),
    (error: unknown) => {
      assert.ok(error instanceof StateRootHeldError);
      assert.equal(error.holder.pid, process.pid);
      return true;
    },
  );
  first.close();
  const second = new Store({ dir });
  second.close();
});

test("core-service-64: a legacy SQLite store imports once, rows served from files", async () => {
  // A pre-DR-036 release left a spex.db behind. Its rows must serve
  // identically from the file state, with turns, titles, and usage
  // folded from the imported record stream — and the legacy file must
  // stay in place, imported exactly once.
  const dir = mkdtempSync(join(tmpdir(), "spex-import-"));
  const legacyDbPath = join(dir, "spex.db");
  const root = join(dir, "state");
  const legacy = new Database(legacyDbPath);
  const doneEvent = {
    type: "player_event",
    turnId: 1,
    timestamp: 30,
    playerId: "dev.coder",
    event: {
      type: "done",
      payload: {
        usage: {
          toolUses: 2,
          tokens: { totals: { input: { total: 40 }, output: { total: 10 } } },
          cost: { amount: 0.25, source: "provider-reported" },
        },
        durationMs: 700,
      },
    },
  };
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      registered_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      created_at INTEGER NOT NULL, ended_at INTEGER, live INTEGER NOT NULL,
      players_json TEXT NOT NULL, initial_visible_json TEXT NOT NULL
    );
    CREATE TABLE records (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id INTEGER,
      type TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL, payload_json TEXT NOT NULL, role TEXT,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE prefs (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    CREATE TABLE intents (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL,
      source_kind TEXT, source_ref TEXT, source_url TEXT,
      rank TEXT NOT NULL, after_id TEXT, created_at INTEGER NOT NULL,
      dispatched_session_id TEXT, dispatched_turn_id INTEGER, dispatched_at INTEGER,
      closed_at INTEGER, closed_as TEXT
    );
    INSERT INTO meta VALUES ('schema_version', '3');
    INSERT INTO projects VALUES ('71000000-0000-4000-8000-000000000004', '${PROJECT_PATH.replaceAll("'", "''")}', 'proj', 1);
    INSERT INTO sessions VALUES ('71000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000004', 1, NULL, 1, '[]', '[]');
    INSERT INTO prefs VALUES ('viewed:71000000-0000-4000-8000-000000000001', '1');
    INSERT INTO intents VALUES ('71000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000004', 'Ship it', NULL, NULL, NULL,
      'i', NULL, 5, '71000000-0000-4000-8000-000000000001', 1, 10, NULL, NULL);
  `);
  const insert = legacy.prepare(
    "INSERT INTO records (session_id, seq, turn_id, type, hidden, timestamp, payload_json, role) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    "71000000-0000-4000-8000-000000000001",
    1,
    1,
    "turn_started",
    0,
    10,
    JSON.stringify({
      type: "turn_started",
      turnId: 1,
      turn: { id: 1, prompt: "ship the import" },
      timestamp: 10,
    }),
    null,
  );
  insert.run("71000000-0000-4000-8000-000000000001", 2, 1, "player_event", 0, 30, JSON.stringify(doneEvent), "coder");
  // The pre-0.22 flat usage shape lives in real stored streams; the
  // fold must read it too.
  insert.run(
    "71000000-0000-4000-8000-000000000001",
    4,
    1,
    "captain_event",
    0,
    40,
    JSON.stringify({
      type: "captain_event",
      turnId: 1,
      timestamp: 40,
      event: {
        type: "done",
        payload: {
          usage: { tokenAvailability: "reported", inputTokens: 60, outputTokens: 5, toolUses: 1 },
        },
      },
    }),
    null,
  );
  insert.run(
    "71000000-0000-4000-8000-000000000001",
    3,
    1,
    "turn_finished",
    0,
    50,
    JSON.stringify({ type: "turn_finished", turnId: 1, timestamp: 50 }),
    null,
  );
  legacy.close();
  const legacyBytes = readFileSync(legacyDbPath);

  const store = new Store({ dir: root, legacyDbPath });
  await store.initializeSessions();
  // A session live when the legacy store last closed is not live now.
  const session = store.listSessions().find((entry) => entry.id === "71000000-0000-4000-8000-000000000001");
  assert.equal(session?.live, false);
  assert.equal(session?.title, "ship the import");
  assert.equal(session?.turns, 1);
  // Usage folds from the imported stream (core-service-10), across
  // both payload generations.
  assert.deepEqual(store.sessionUsage("71000000-0000-4000-8000-000000000001"), {
    inputTokens: 100,
    outputTokens: 15,
    toolUses: 3,
    totalCostUsd: 0.25,
    costSources: ["provider-reported"],
  });
  assert.equal(store.getRecords("71000000-0000-4000-8000-000000000001")[1]?.role, "coder");
  assert.equal(store.getPref("viewed:71000000-0000-4000-8000-000000000001"), 1);
  assert.equal(store.getIntent("71000000-0000-4000-8000-000000000002")?.dispatched?.turnId, 1);
  store.close();

  // The legacy file is untouched, and a second startup imports nothing
  // twice: rows written since are not clobbered by a re-import.
  assert.deepEqual(readFileSync(legacyDbPath), legacyBytes);
  const reopened = new Store({ dir: root, legacyDbPath });
  reopened.setPref("viewed:71000000-0000-4000-8000-000000000001", 4);
  reopened.close();
  const third = new Store({ dir: root, legacyDbPath });
  assert.equal(third.getPref("viewed:71000000-0000-4000-8000-000000000001"), 4);
  assert.ok(existsSync(legacyDbPath));
  third.close();
});

test("a second shell's legacy import merges into the root, clobbering nothing", () => {
  // Both shells share one root: the server's first launch imports its
  // own legacy store and must not erase what the desktop imported or
  // what was registered since (DR-036).
  const dir = mkdtempSync(join(tmpdir(), "spex-merge-"));
  const root = join(dir, "state");
  const seed = (path: string, projectId: string, projectPath: string): void => {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        registered_at INTEGER NOT NULL
      );
      CREATE TABLE prefs (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      INSERT INTO projects VALUES ('${projectId}', '${projectPath.replaceAll("'", "''")}', 'p', 1);
      INSERT INTO prefs VALUES ('shared', '"${projectId}"');
    `);
    db.close();
  };
  seed(join(dir, "desktop.db"), "71000000-0000-4000-8000-000000000005", join(tmpdir(), "spex-desktop-project"));
  seed(join(dir, "server.db"), "71000000-0000-4000-8000-000000000006", join(tmpdir(), "spex-server-project"));

  const first = new Store({ dir: root, legacyDbPath: join(dir, "desktop.db") });
  first.registerProject(join(tmpdir(), "spex-new-work"), "new-work", 2);
  first.setPref("shared", "live");
  first.close();

  const second = new Store({ dir: root, legacyDbPath: join(dir, "server.db") });
  assert.deepEqual(
    second.listProjects().map((project) => project.path).sort(),
    [join(tmpdir(), "spex-desktop-project"), join(tmpdir(), "spex-new-work"), join(tmpdir(), "spex-server-project")],
  );
  // Existing preferences win over imported ones: they are newer.
  assert.equal(second.getPref("shared"), "live");
  second.close();
});

test("a torn intent tail remains readable but refuses further writes without changing memory", () => {
  const dir = tempRoot(); const store = new Store({ dir });
  const project = store.registerProject(join(tmpdir(), "spex-heal"), "heal", 1);
  const firstId = "71000000-0000-4000-8000-000000000002";
  const nextId = "71000000-0000-4000-8000-000000000003";
  store.addIntent({ id: firstId, projectId: project.id, text: "First", rank: "i", createdAt: 1 });
  store.close();
  const log = join(dir, "intents", `${project.id}.jsonl`);
  const damaged = readFileSync(log, "utf8") + '{"v":1,"act":"edit"'; writeFileSync(log, damaged);
  const reopened = new Store({ dir });
  assert.deepEqual(reopened.listOpenIntents().map((intent) => intent.id), [firstId]);
  assert.throws(() => reopened.addIntent({ id: nextId, projectId: project.id, text: "Second", rank: "r", createdAt: 2 }), /incomplete final act/);
  assert.equal(reopened.getIntent(nextId), undefined);
  assert.equal(readFileSync(log, "utf8"), damaged);
  reopened.close();
});

test("an unreadable legacy store skips its import and never blocks startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "spex-badlegacy-"));
  const legacyDbPath = join(dir, "spex.db");
  // What better-sqlite3 leaves when the old app died before its first
  // migration: a zero-byte file.
  writeFileSync(legacyDbPath, "");
  const store = new Store({ dir: join(dir, "state"), legacyDbPath });
  store.registerProject(join(tmpdir(), "spex-after"), "after", 1);
  store.close();
  const reopened = new Store({ dir: join(dir, "state"), legacyDbPath });
  assert.equal(reopened.listProjects().length, 1);
  reopened.close();
});

test("an unreadable root lock fails closed rather than letting a second core in", () => {
  const dir = tempRoot();
  mkdirSync(join(dir, ".lock"), { recursive: true });
  writeFileSync(join(dir, ".lock", "owner.json"), "not json");
  assert.throws(() => new Store({ dir }), /unreadable lock/);
  rmSync(join(dir, ".lock"), { recursive: true, force: true });
  const store = new Store({ dir });
  store.close();
});

test("shared replay remains token-free in memory and across restart", async () => {
  const dir = tempRoot();
  const store = new Store({ dir });
  const lease = await sharedSession(store);
  await lease.append({
    type: "player_finished",
    turnId: 1,
    timestamp: 10,
    playerId: "dev.coder",
    result: { status: "ok", finalText: "done", resumeToken: "sess-abc" },
  } as unknown as TmuxPlayRecord);
  await lease.append({
    type: "captain_telemetry",
    turnId: 1,
    timestamp: 11,
    topic: "playbook.trace",
    payload: {
      type: "player.call.finished",
      playerId: "dev.coder",
      resume: "sess-abc",
      resumeToken: "sess-def",
      status: "ok",
    },
  } as unknown as TmuxPlayRecord);
  await lease.append({
    type: "captain_telemetry",
    turnId: 1,
    timestamp: 12,
    topic: "playbook.trace",
    payload: { type: "player.call.started", resume: false },
  } as unknown as TmuxPlayRecord);
  await lease.release();
  store.close();

  const reopened = new Store({ dir });
  await reopened.initializeSessions();
  const text = readFileSync(join(dir, "sessions", "71000000-0000-4000-8000-000000000001.records.jsonl"), "utf8");
  assert.ok(!text.includes("sess-abc") && !text.includes("sess-def"));
  const serialized = JSON.stringify(reopened.getRecords("71000000-0000-4000-8000-000000000001"));
  assert.ok(!serialized.includes("resumeToken") && !serialized.includes("sess-abc"));
  // `resume: false` is semantics, not a token, and survives the strip.
  const trace = reopened.getRecords("71000000-0000-4000-8000-000000000001")[3].record as unknown as {
    payload: { resume?: unknown };
  };
  assert.equal(trace.payload.resume, false);
  reopened.close();
});

test("a lease-free shared read serves only the complete prefix and mutates nothing", async () => {
  const dir = tempRoot();
  const store = new Store({ dir });
  const lease = await sharedSession(store);
  await lease.append({
    type: "captain_status",
    turnId: 1,
    timestamp: 10,
    message: "ok",
  } as TmuxPlayRecord);
  await lease.release();
  store.close();

  // A torn tail, as a crashed writer leaves it.
  const file = join(dir, "sessions", "71000000-0000-4000-8000-000000000001.records.jsonl");
  const damaged = readFileSync(file, "utf8") + '{"v":1,"seq":2,"rec';
  writeFileSync(file, damaged);

  const reopened = new Store({ dir });
  await reopened.initializeSessions();
  assert.deepEqual(
    reopened.getRecords("71000000-0000-4000-8000-000000000001").map((r) => r.seq),
    [1, 2],
  );
  assert.equal(readFileSync(file, "utf8"), damaged, "the reader rewrites nothing");
  reopened.close();
});

test("shared stream failure preserves the incomplete marker across Store restart", async () => {
  const dir = tempRoot(); const store = new Store({ dir });
  const lease = await sharedSession(store);
  await lease.append({ type: "captain_status", turnId: 1, timestamp: 10, message: "durable" });
  const file = join(dir, "sessions", `${SESSION}.records.jsonl`);
  const prefix = readFileSync(file);
  chmodSync(file, 0o644);
  await assert.rejects(() => lease.append({ type: "captain_status", turnId: 1, timestamp: 11, message: "memory-only" }));
  chmodSync(file, 0o600);
  assert.equal(lease.streamStatus().incomplete, true);
  await lease.release(); store.close();
  assert.deepEqual(readFileSync(file), prefix);
  const reopened = new Store({ dir }); await reopened.initializeSessions();
  assert.equal(reopened.describeSession(SESSION)?.streamIncompleteAfterSeq, 1, "failure retains the last fsynced checkpoint, not merely readable bytes");
  assert.equal(reopened.describeSession(SESSION)?.continuable, undefined);
  assert.deepEqual(reopened.getRecords(SESSION).map((record) => record.seq), [1, 2]);
  reopened.close();
});


test("unsupported or damaged migration metadata stays unchanged and releases the home lease", () => {
  for (const bytes of ['{"version":42}', '{"version":1,"extra":true}', 'null', '{broken']) {
    const dir = tempRoot(); mkdirSync(dir, { recursive: true });
    const file = join(dir, "meta.json"); writeFileSync(file, bytes);
    assert.throws(() => new Store({ dir }));
    assert.equal(readFileSync(file, "utf8"), bytes);
    assert.equal(existsSync(join(dir, ".lock")), false);
    rmSync(dir, { recursive: true, force: true });
  }
});
