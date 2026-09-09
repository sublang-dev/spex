// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The demo narration (DR-039): one scripted Captain and one fake
// adapter script shared by the fake dev core and the browser
// acceptance harness, so both draw the same run — the real CODE
// machine's states with a nested review, two player transcripts with
// tool use, usage, and a clean finish — with no credentials.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSessionStore, validateSessionManifest } from "@sublang/playbook/session-store";
import { sha256, writeApplicationFile } from "../app-storage.js";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Captain } from "@sublang/cligent/tmux-play";

import { academyCorpusDir } from "../forge.js";
import { Store } from "../store.js";
import { fakeAdapterImports } from "./fake-adapter.js";
import { createScriptedCaptain } from "./scripted-captain.js";

/** A starter config naming two players and the code/review built-ins;
 * the captain and coder ride the claude adapter, the reviewer codex. */
export const DEMO_CONFIG = `# Spex demo config — the comment is kept by every in-app edit.
captain:
  adapter: claude
  model: claude-opus-5
players:
  dev.coder:
    adapter: claude
    model: claude-opus-5
  dev.reviewer:
    adapter: codex
    model: gpt-5.6-sol
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

/** The demo project: a git-initialized directory holding the staged
 * Academy corpus (DR-015) — the same example the app seeds for users. */
export function seedDemoProject(projectDir: string): void {
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", "-q", projectDir]);
  cpSync(academyCorpusDir(), projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# Demo project\n");
  execFileSync("git", ["-C", projectDir, "add", "-A"]);
  // Identity and no signing: the host's global git config must not
  // decide whether a scratch repository can commit.
  execFileSync("git", [
    "-C",
    projectDir,
    "-c",
    "user.name=Spex Demo",
    "-c",
    "user.email=demo@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "seed",
  ]);
}

/** Done work the demo project holds before the app meets it
 * (dashboard-27): `count` intents, each worked in one finished turn
 * of one ended session and closed done, written into the state root
 * the core will serve — a History longer than one intent page with
 * nothing run. The project registers by its path, so the core's own
 * registration after boot finds this one. */
export async function seedDemoHistory(
  dataDir: string,
  projectDir: string,
  count: number,
): Promise<void> {
  const store = new Store({ dir: dataDir });
  try {
    const project = store.registerProject(projectDir, "demo-project", 1);
    const sessionId = randomUUID();
    const minute = 60_000;
    const base = Date.now() - (count + 1) * minute;
    const records: Record<string, unknown>[] = [];
    for (let i = 1; i <= count; i += 1) {
      const id = demoHistoryIntentId(i);
      const text = `Seeded done work ${i}`;
      const at = base + i * minute;
      store.addIntent({ id, projectId: project.id, text, rank: `${String(i).padStart(3, "0")}i`, createdAt: at - 30_000 });
      records.push({ type: "turn_started", turnId: i, turn: { id: i, prompt: text }, timestamp: at - 20_000 });
      records.push({ type: "turn_finished", turnId: i, timestamp: at - 10_000 });
      store.stampIntentDispatch(id, sessionId, i, at - 20_000);
      store.closeIntent(id, "done", at);
    }
    await seedHistorySession(join(dataDir, "sessions"), projectDir, records, sessionId);
  } finally { store.close(); }
}

export const demoHistoryIntentId = (index: number): string =>
  `72000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/** Historical fixtures have no runtime checkpoint and never claim to resume. */
export async function seedHistorySession(
  sessionsDir: string,
  cwd: string,
  records: Record<string, unknown>[],
  sessionId: string = randomUUID(),
): Promise<string> {
  const shared = createSessionStore({ sessionsDir }); await shared.prepare();
  const writer = await shared.acquire(sessionId);
  try { for (const record of records) await writer.append(record); }
  finally { await writer.release(); }
  const history = await shared.readHistory(sessionId);
  const bytes = readFileSync(join(sessionsDir, `${sessionId}.records.jsonl`));
  const times = records.map((record) => record.timestamp).filter((at): at is number => typeof at === "number" && Number.isFinite(at));
  const lease = await shared.acquireManagement(sessionId);
  try {
    const manifest = validateSessionManifest({
      schemaVersion: 7, kind: "captain-session", sessionId, cwd,
      createdAt: new Date(times[0] ?? 0).toISOString(), updatedAt: new Date(times.at(-1) ?? 0).toISOString(),
      state: "history-only", reason: "Historical demonstration fixture", contextSeq: null,
      replay: { seq: history.lastReadableSeq, sha256: sha256(bytes), incomplete: false },
    });
    writeApplicationFile(join(sessionsDir, `${sessionId}.json`), manifest);
  } finally { await lease.release(); }
  const checked = await shared.validate(sessionId);
  if (!checked.integrityValid) throw new Error(checked.reasons.join("; "));
  return sessionId;
}

/** Save the real pre-turn uncertainty boundary; the harness stops its host first. */
export async function interruptDemoSession(sessionsDir: string, sessionId: string, input: string): Promise<void> {
  const shared = createSessionStore({ sessionsDir });
  const lease = await shared.acquire(sessionId);
  try {
    const prior = await lease.read();
    if (!prior || prior.state !== "settled") throw new Error("fixture needs a settled real checkpoint");
    await lease.beginTurn({ input, attemptId: randomUUID(), attemptedExecutionProjection: prior.lastAppliedExecutionProjection });
  } finally { await lease.release(); }
}

/** Fake player adapters: the coder edits and tests, the reviewer
 * inspects and approves — each with tool calls, streamed markdown,
 * usage, and a delay long enough to watch in-flight state. */
export function demoAdapterImports(options: { delayMs?: number } = {}) {
  const delay = options.delayMs ?? 1;
  return fakeAdapterImports({
    rules: [
      {
        match: "route:",
        response: { result: '{"decision":"dispatch"}' },
      },
      {
        match: "Review the change",
        response: {
          tools: [
            { toolName: "command_execution", input: { command: "git show --stat HEAD" } },
            { toolName: "command_execution", input: { command: "npm test" } },
          ],
          deltas: [
            "### Review\n\n",
            "- `auth.ts` — the token refresh looks **correct**\n",
            "- consider a test for expiry skew\n",
          ],
          result:
            "### Review\n\n- `auth.ts` — the token refresh looks **correct**\n- consider a test for expiry skew\n",
          usage: { inputTokens: 850, outputTokens: 120, totalCostUsd: 0.04 },
          delayMs: Math.round(delay * 0.75),
        },
      },
    ],
    fallback: {
      tools: [
        { toolName: "Read", input: { file_path: "src/auth.ts" } },
        { toolName: "Edit", input: { file_path: "src/auth.ts" } },
        { toolName: "Bash", input: { command: "npm test -- auth" } },
      ],
      deltas: [
        "Working on it. ",
        "Editing `auth.ts` to fix the refresh path…\n\n",
        "```ts\nconst token = await refresh(session);\n```\n",
        "Done — the bug is fixed.",
      ],
      thinking: "tracing the token lifecycle",
      result: "Done — the bug is fixed.",
      usage: { inputTokens: 2400, outputTokens: 310, totalCostUsd: 0.12 },
      delayMs: delay,
    },
  });
}

/** The scripted Captain: a prompt starting with "ask" parks the
 * session on a player question; anything else narrates a full /code
 * run with a nested /review, mirroring the runtime's trace shapes
 * (DR-028, DR-031) so the UI draws the cards a real run produces. */
/** Which demo sessions stand parked on a question, by session id: the
 * runtime is held only for a turn (DR-051), so a fresh fixture takes
 * the reply turn and must still know the park it is leaving. */
const parkedSessions = new Set<string>();

export function demoCaptain(
  sessionId?: string,
  options: { governedCompletion?: boolean } = {},
): Captain {
  // The runtime leaves a park with one transition on the Boss reply
  // (BOSS_REPLY from awaitBossReply); the narration mirrors it so the
  // folds that answer a question on that departure see what a real
  // run emits (run-view-9).
  let parkedHere = false;
  const isParked = () => (sessionId ? parkedSessions.has(sessionId) : parkedHere);
  const setParked = (value: boolean) => {
    parkedHere = value;
    if (sessionId) {
      if (value) parkedSessions.add(sessionId);
      else parkedSessions.delete(sessionId);
    }
  };
  return createScriptedCaptain(async (turn, context, session) => {
    if (isParked() && !turn.prompt.toLowerCase().startsWith("ask")) {
      setParked(false);
      await session.emitTelemetry({
        topic: "playbook.fsm.state",
        payload: { from: "awaitBossReply", to: "coding", event: "BOSS_REPLY" },
      });
    }
    if (turn.prompt.toLowerCase().startsWith("ask")) {
      setParked(true);
      await session.emitStatus(
        "◆ code-coder asks: Should I also migrate the legacy sessions?",
      );
      await session.emitTelemetry({
        topic: "playbook.fsm.state",
        payload: {
          from: "coding",
          to: "awaitBossReply",
          event: "NEEDS_BOSS",
          pendingBossQuestion: {
            player: "coder",
            question: "Should I also migrate the legacy sessions?",
            resumeStateId: "coding",
          },
        },
      });
      return;
    }
    const runId = `demo-code-${Date.now()}`;
    let sequence = 0;
    const trace = async (
      type: string,
      payload: Record<string, unknown>,
    ): Promise<void> => {
      sequence += 1;
      await session.emitTelemetry({
        topic: "playbook.trace",
        payload: {
          schemaVersion: 3,
          sessionId: runId,
          playbookId: "code",
          rootSessionId: runId,
          depth: options.governedCompletion ? 0 : 1,
          sequence,
          timestamp: Date.now(),
          type,
          payload,
        },
      });
    };
    const move = async (
      from: string | null,
      to: string,
      event: string,
      status: "active" | "done" = "active",
      tags: string[] = [],
    ): Promise<void> => {
      await trace("fsm.transition", {
        from,
        to,
        event: { type: event },
        state: { value: to, activeStateIds: [to], tags, status, quiescent: true },
      });
      await session.emitTelemetry({
        topic: "playbook.fsm.state",
        payload: { from, to, event },
      });
    };

    await session.emitStatus(`◇ /code started`);
    await context.callCaptain(`route: ${turn.prompt}`, {
      visibility: "hidden",
    });
    await trace("session.started", {});
    await move("ready", "runFirstPhase", "START_CODE");
    await session.emitStatus("⤷ Coder: implement");
    await trace("player.call.started", {
      stateId: "runFirstPhase",
      roleId: "coder",
      playerId: "dev.coder",
    });
    await context.callPlayer("dev.coder", `Implement: ${turn.prompt}`);
    await trace("player.call.finished", {
      stateId: "runFirstPhase",
      status: "ok",
    });
    await move("runFirstPhase", "reviewFirstCommit", "done");
    const reviewId = `${runId}-review`;
    let reviewSequence = 0;
    const reviewTrace = async (
      type: string,
      payload: Record<string, unknown>,
    ): Promise<void> => {
      reviewSequence += 1;
      await session.emitTelemetry({
        topic: "playbook.trace",
        payload: {
          schemaVersion: 3,
          sessionId: reviewId,
          playbookId: "review",
          rootSessionId: runId,
          parentSessionId: runId,
          depth: options.governedCompletion ? 1 : 2,
          sequence: reviewSequence,
          timestamp: Date.now(),
          type,
          payload,
        },
      });
    };
    const reviewMove = async (
      from: string | null,
      to: string,
      event: string,
      status: "active" | "done" = "active",
    ): Promise<void> => {
      await reviewTrace("fsm.transition", {
        from,
        to,
        event: { type: event },
        state: { value: to, activeStateIds: [to], tags: [], status },
      });
    };
    await session.emitStatus("⮕ /review: first commit");
    await trace("playbook.call.started", {
      stateId: "reviewFirstCommit",
      playbookId: "review",
      text: "review the first commit",
    });
    await reviewTrace("session.started", {});
    await reviewMove("ready", "reviewInitial", "START_REVIEW");
    await session.emitStatus("⤷ Reviewer: review round 1");
    await reviewTrace("player.call.started", {
      stateId: "reviewInitial",
      roleId: "reviewer",
      playerId: "dev.reviewer",
    });
    await context.callPlayer("dev.reviewer", "Review the change");
    await reviewTrace("player.call.finished", {
      stateId: "reviewInitial",
      status: "ok",
    });
    await reviewMove("reviewInitial", "done", "done", "done");
    await reviewTrace("session.disposed", {
      state: { value: "done", status: "done" },
    });
    await trace("playbook.call.finished", {
      stateId: "reviewFirstCommit",
      playbookId: "review",
      result: "approved",
    });
    await move("reviewFirstCommit", "done", "done", "done");
    await trace("status.emitted", { message: "settled", stateId: "done" });
    // Opt in only for journeys exercising advancement from a typed
    // governed result; the ordinary demo remains narration alone.
    if (options.governedCompletion) {
      await trace("boss.input.settled", {
        outcome: "terminal",
        terminal: { kind: "success" },
      });
    }
    await trace("session.disposed", {
      state: { value: "done", status: "done" },
    });
    await session.emitStatus("◇ /code finished");
    await context.emitReply("Done — the requested change is ready.");
  });
}
