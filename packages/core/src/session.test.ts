// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { composeConfig, templatePath } from "./config.js";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { SessionManager, CoreError, type RecordEnvelope } from "./session.js";
import { Store } from "./store.js";
import { fakeAdapterImports } from "./testing/fake-adapter.js";
import {
  createScriptedCaptain,
  type CaptainTurnScript,
} from "./testing/scripted-captain.js";

/** The roster the installed template binds, in config order. */
function templateRoster(): string[] {
  const top = parseYaml(readFileSync(templatePath(), "utf8")) as {
    players: Record<string, unknown>;
  };
  return Object.keys(top.players);
}

async function setup(
  records: RecordEnvelope[],
  overrides?: {
    rules?: Parameters<typeof fakeAdapterImports>[0]["rules"];
    script?: CaptainTurnScript;
  },
) {
  const top = parseYaml(readFileSync(templatePath(), "utf8"));
  const composed = await composeConfig(top);
  const scratch = mkdtempSync(join(tmpdir(), "spex-sess-"));
  const projectDir = join(scratch, "project"); mkdirSync(projectDir);
  execFileSync("git", ["init", "-q", projectDir]);
  const store = new Store({ dir: join(scratch, "state") });
  const { imports, stats } = fakeAdapterImports({
    rules: overrides?.rules ?? [
      {
        match: "route:",
        response: { result: '{"decision":"chat"}', usage: { totalCostUsd: 0.01 } },
      },
    ],
    fallback: { deltas: ["work ", "done"], result: "work done" },
  });
  const captain = createScriptedCaptain(overrides?.script ?? (async (turn, context, session) => {
    await session.emitStatus("◇ /code started");
    await context.callCaptain(`route: ${turn.prompt}`, { visibility: "hidden" });
    await context.callPlayer("dev.coder", `do: ${turn.prompt}`);
    await session.emitTelemetry({
      topic: "playbook.fsm.state",
      payload: { to: "ready" },
    });
    await context.emitReply("work done");
  }));
  const manager = new SessionManager({
    store,
    adapterImports: imports,
    captainFactory: async () => captain,
  });
  manager.onRecord = (envelope) => records.push(envelope);
  const project = store.registerProject(projectDir, "proj-a", 1);
  return { manager, store, project, composed, stats };
}

test("end-to-end turn produces ordered persisted records with visibility flags", async () => {
  const records: RecordEnvelope[] = [];
  const { manager, store, project, composed, stats } = await setup(records);

  const info = await manager.createSession(project, composed);
  // Three playbooks bind the same two lanes, so the roster is those
  // two — not one generated identity per role (DR-032).
  assert.deepEqual(
    info.players.map((p) => p.id),
    templateRoster(),
  );
  assert.deepEqual(info.initialVisible, templateRoster());

  manager.submitTurn(info.id, "fix the bug");
  assert.throws(
    () => manager.submitTurn(info.id, "second"),
    (error: CoreError) => error.code === "busy",
  );

  // The terminal record precedes the shared lifecycle's durable settlement.
  await waitFor(() => records.some((r) => r.record.type === "turn_finished"));
  await manager.getLive(info.id)?.operation;

  const types = records.map((r) => r.record.type);
  assert.ok(types.indexOf("turn_started") < types.indexOf("captain_status"));
  assert.ok(types.includes("captain_status"));
  assert.ok(types.includes("captain_prompt"));
  assert.ok(types.includes("player_prompt"));
  assert.ok(types.includes("player_finished"));
  assert.ok(types.includes("captain_telemetry"));
  // The turn's last record is its end; what follows is the runtime's
  // release at settlement, traced outside any turn (core-service-91).
  const finished = types.lastIndexOf("turn_finished");
  assert.ok(finished >= 0);
  for (const envelope of records.slice(finished + 1)) {
    assert.equal(envelope.record.type, "captain_telemetry");
    assert.equal((envelope.record as { turnId: number | null }).turnId, null);
  }
  await waitFor(() => !manager.getLive(info.id));

  const hiddenTypes = records.filter((r) => r.hidden).map((r) => r.record.type);
  assert.deepEqual(
    [...new Set(hiddenTypes)].sort(),
    ["captain_event", "captain_finished", "captain_prompt"],
  );

  const seqs = records.map((r) => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

  const storedVisible = store.getRecords(info.id);
  const storedAll = store.getRecords(info.id, { includeHidden: true });
  assert.ok(storedAll.some((entry) => (entry.record as { type?: unknown }).type === "session_context"));
  const observed = records.map(({ seq, record, role }) => ({
    seq, record, ...(role === undefined ? {} : { role }),
  }));
  assert.deepEqual(storedAll, observed, "every stored record, including context, is delivered once in order");
  assert.deepEqual(storedVisible, observed.filter((_, index) => !records[index]!.hidden));
  assert.ok(storedVisible.length < storedAll.length);

  const usage = store.sessionUsage(info.id);
  assert.ok(usage.inputTokens > 0);
  assert.equal(usage.totalCostUsd, 0.01);

  assert.ok(stats.constructed >= 2, "captain and player fakes constructed");
  assert.ok(stats.runs.some((run) => run.prompt.includes("route:")));

  const secondDir = join(project.path, "..", "second"); mkdirSync(secondDir);
  execFileSync("git", ["init", "-q", secondDir]);
  const second = store.registerProject(secondDir, "proj-b", 2);
  const other = await manager.createSession(second, composed);
  assert.notEqual(other.id, info.id);
  // The runtime was released at settlement (core-service-91), so the
  // project admits another session; only a turn in flight refuses.
  const sibling = await manager.createSession(project, composed);
  assert.notEqual(sibling.id, info.id);
  await assert.rejects(
    manager.createSession(project, composed),
    (error: CoreError) => error.code === "busy" && /a session|still working/.test(error.message),
  );

  await manager.disposeAll();
  const sessions = manager.listSessions();
  assert.ok(sessions.every((session) => !session.live));
});

test("an errored hidden captain result surfaces a visible failure record", async () => {
  // core-service-30: the owner's normal chat failed with an expired
  // sign-in that reached the store only as hidden records. The core
  // synthesizes the visible cause; the hidden record stays hidden.
  const records: RecordEnvelope[] = [];
  const cause =
    "Failed to authenticate: OAuth session expired and could not be refreshed";
  const { manager, project, composed } = await setup(records, {
    rules: [{ match: "route:", response: { result: cause, status: "error" } }],
    script: async (turn, context) => {
      try {
        await context.callCaptain(`route: ${turn.prompt}`, {
          visibility: "hidden",
        });
      } catch {
        // The production shell composes a polite reply on failure;
        // the cause itself must not depend on the reply.
      }
      await context.emitReply("I could not finish deciding that turn.");
    },
  });

  const info = await manager.createSession(project, composed);
  manager.submitTurn(info.id, "how are you doing?");
  await waitFor(() => records.some((r) => r.record.type === "turn_finished"));
  await manager.getLive(info.id)?.operation;

  const failure = records.find((r) => r.record.type === "runtime_error");
  assert.ok(failure, "a visible runtime_error must be synthesized");
  assert.equal(failure.hidden, false);
  assert.match(
    (failure.record as { message: string }).message,
    /OAuth session expired/,
  );
  // The hidden captain result itself never rides the session channel.
  const hiddenFinished = records.filter(
    (r) => r.record.type === "captain_finished" && r.hidden,
  );
  assert.ok(hiddenFinished.length > 0);
  await manager.disposeAll();
});

test("core-service-35: session state broadcasts carry the live summary", async () => {
  // The sidebar watches these broadcasts. Sending the creation-time
  // record would blank a row the reader is looking at the moment its
  // session ends (core-service-34).
  const records: RecordEnvelope[] = [];
  const { manager, project, composed } = await setup(records);
  const states: import("./protocol.js").SessionInfo[] = [];
  // One ordered timeline, so "the name arrived before the turn ended"
  // is a fact about order rather than about how fast the fake ran.
  const timeline: string[] = [];
  manager.onSessionState = (session) => {
    states.push(session);
    if (session.title) timeline.push(`named:${session.title}`);
  };
  const priorOnRecord = manager.onRecord;
  manager.onRecord = (envelope) => {
    priorOnRecord(envelope);
    timeline.push(`record:${envelope.record.type}`);
  };

  const info = await manager.createSession(project, composed);
  assert.equal(states.at(-1)?.turns, 0, "a fresh session summarizes as empty");

  manager.submitTurn(info.id, "harden the session refresh");
  await waitFor(() => records.some((r) => r.record.type === "turn_finished"));
  await manager.getLive(info.id)?.operation;
  // The name arrives with the turn that starts, not the one that ends:
  // a running session must never be listed as having said nothing.
  assert.ok(
    timeline.indexOf("named:harden the session refresh") <
      timeline.indexOf("record:turn_finished"),
    `named after the turn ended: ${timeline.join(" ")}`,
  );

  // The turn's end and the runtime's release at settlement each carry
  // the summary (core-service-34, core-service-91); the release leaves
  // the session no longer live with its last activity stamped.
  const afterTurn = states.find((state) => state.turns === 1 && state.turnActive === false);
  assert.equal(afterTurn?.title, "harden the session refresh");
  await waitFor(() => states.at(-1)?.live === false);
  const released = states.at(-1);
  assert.equal(released?.live, false);
  assert.ok(released?.endedAt);
  assert.equal(released?.title, "harden the session refresh");
  assert.equal(released?.turns, 1);
  assert.equal(manager.getLive(info.id), undefined, "the runtime is held only for a turn");
});

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("DR-032: a shared lane's records carry the role each call served", async () => {
  const records: RecordEnvelope[] = [];
  // One lane, two calls, two roles: /code's coder then /review's
  // reviewer, both landing on dev.coder. Without the bracket the pane
  // would read as one voice talking to itself.
  const trace = (
    session: { emitTelemetry(t: { topic: string; payload: unknown }): Promise<void> },
    type: string,
    roleId: string,
  ) =>
    session.emitTelemetry({
      topic: "playbook.trace",
      payload: {
        schemaVersion: 4,
        sessionId: "role-fixture", rootSessionId: "role-fixture", playbookId: "code",
        depth: 1, sequence: 1, timestamp: 1, turnId: 1, callId: roleId,
        type,
        payload: { roleId, playerId: "dev.coder", resume: false, ...(type === "player.call.started" ? { prompt: "work" } : { status: "ok" }) },
      },
    });
  const { manager, store, project, composed } = await setup(records, {
    script: async (turn, context, session) => {
      await trace(session, "player.call.started", "coder");
      await context.callPlayer("dev.coder", `code: ${turn.prompt}`);
      await trace(session, "player.call.finished", "coder");
      await trace(session, "player.call.started", "reviewer");
      await context.callPlayer("dev.coder", `review: ${turn.prompt}`);
      await trace(session, "player.call.finished", "reviewer");
      await context.emitReply("review complete");
    },
  });

  const info = await manager.createSession(project, composed);
  manager.submitTurn(info.id, "fix the bug");
  await waitFor(() => records.some((r) => r.record.type === "turn_finished"));
  await manager.getLive(info.id)?.operation;

  const prompts = records.filter((r) => r.record.type === "player_prompt");
  assert.deepEqual(
    prompts.map((r) => r.role),
    ["coder", "reviewer"],
  );
  // The finish belongs to the call it ends, so the bracket closes
  // after the last record it covers.
  assert.deepEqual(
    records
      .filter((r) => r.record.type === "player_finished")
      .map((r) => r.role),
    ["coder", "reviewer"],
  );
  // A replay reads exactly as the live stream did: the role is stored
  // beside the record, not recomputed by the renderer.
  assert.deepEqual(
    store
      .getRecords(info.id, { includeHidden: true })
      .filter((entry) => entry.record.type === "player_prompt")
      .map((entry) => entry.role),
    ["coder", "reviewer"],
  );
  // The trace record itself is not a player record and takes no role.
  assert.equal(
    records.find((r) => r.record.type === "captain_telemetry")?.role,
    undefined,
  );
  await manager.disposeAll();
  store.close();
});
