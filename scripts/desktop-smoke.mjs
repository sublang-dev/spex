#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Live desktop smoke (DR-020, RELEASE-22): boots the real Electron
// app against a scratch home and walks the release-critical path over
// the app's own socket — seeded config, Academy example, session,
// live /code dispatch with real agents, abort, teardown. Requires a
// locally signed-in Claude adapter; NOT hermetic, NOT for CI. The
// driver owns the native-ABI flip to Electron and restores it on
// every exit path (skip flip with SPEX_SMOKE_ABI_READY=1). An unchanged
// successful build can be reused with SPEX_SMOKE_BUILD_READY=1.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { livePlayerOutput } from "./live-output.mjs";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const BUDGET_MS = 8 * 60_000;
const manual = process.env.SPEX_SMOKE_MANUAL === "1";
// A real but trivial coding task: the judge must classify this as
// work, or the Captain answers it itself and no player ever runs.
// The Academy copy is a throwaway scratch repo, so the edit is safe.
const PROMPT =
  "/code Append a single line reading `smoke ok` to the end of README.md. " +
  "Change nothing else.";

let stage = "setup";
const seen = [];
let lastError;

/** Kill the app's whole process group; a bare child kill leaves
 * Electron's helpers (and the app itself) running. */
function stopApp(signal) {
  if (!electron?.pid) return;
  try {
    process.kill(-electron.pid, signal);
  } catch {
    try {
      electron.kill(signal);
    } catch {
      // Already gone.
    }
  }
}
const say = (line) => process.stdout.write(`desktop-smoke: ${line}\n`);
const at = (name) => {
  stage = name;
  say(`— ${name}`);
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

async function waitFor(check, budgetMs, what) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > budgetMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const flip = process.env.SPEX_SMOKE_ABI_READY !== "1";
let electron;
let scratch;
try {
  if (flip) {
    at("abi-flip");
    run("npm", ["run", "rebuild:electron", "-w", "apps/desktop"]);
  }

  at("build");
  if (process.env.SPEX_SMOKE_BUILD_READY === "1") {
    say("reusing the prepared desktop build (SPEX_SMOKE_BUILD_READY=1)");
  } else {
    run("npm", ["run", "build", "-w", "apps/desktop"]);
  }

  at("launch");
  scratch = mkdtempSync(join(tmpdir(), "spex-desktop-smoke-"));
  const handshakePath = join(scratch, "handshake.json");
  // Spawn Electron directly, detached: `npm start` wraps the real
  // process, so killing the wrapper would orphan the app.
  electron = spawn(
    join(root, "node_modules", ".bin", "electron"),
    ["."],
    {
      cwd: join(root, "apps", "desktop"),
      stdio: "inherit",
      detached: true,
      env: {
        ...process.env,
        SPEX_SMOKE_HANDSHAKE: handshakePath,
        SPEX_SMOKE_USERDATA: join(scratch, "userdata"),
        XDG_CONFIG_HOME: join(scratch, "config"),
      },
    },
  );
  const exited = new Promise((resolve) => electron.once("exit", resolve));

  const { wsUrl } = JSON.parse(
    readFileSync(
      await waitFor(
        () => (existsSync(handshakePath) ? handshakePath : undefined),
        90_000,
        "the app's core handshake",
      ),
      "utf8",
    ),
  );
  say(`core at ${wsUrl}`);

  at("connect");
  const { WebSocket } = await import("ws");
  const socket = new WebSocket(wsUrl);
  const replies = new Map();
  const records = [];
  const sessions = new Map();
  let seq = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type === "reply") replies.get(message.id)?.(message);
    if (message.type === "session.state") sessions.set(message.session.id, message.session);
    if (message.type === "record") {
      records.push(message);
      const type = String(message.record?.type ?? "?");
      seen.push(type);
      if (type === "runtime_error" || type === "turn_aborted") {
        lastError = String(message.record?.message ?? message.record?.reason ?? type);
      }
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("socket never opened")),
      30_000,
    );
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    socket.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
  const command = (type, fields = {}) =>
    new Promise((resolve, reject) => {
      const id = `d${(seq += 1)}`;
      const timer = setTimeout(
        () => reject(new Error(`${type}: no reply within 60s`)),
        60_000,
      );
      replies.set(id, (reply) => {
        clearTimeout(timer);
        reply.ok
          ? resolve(reply.result)
          : reject(new Error(`${type}: ${reply.error.message}`));
      });
      socket.send(JSON.stringify({ type, id, ...fields }));
    });

  at("config");
  const config = await command("config.get");
  if (config.status !== "valid") {
    throw new Error(`seeded config invalid: ${JSON.stringify(config)}`);
  }
  if (config.summary.captain.adapter !== "claude") {
    throw new Error("seeded captain is not the single-vendor claude block");
  }
  if (manual) {
    await command("config.edit", {
      op: {
        kind: "notifications.set",
        prefs: { ...config.summary.notifications, turn_aborted: "desktop" },
      },
    });
  }

  at("academy");
  const project = await command("project.create", {
    path: join(scratch, "academy"),
    example: true,
  });
  const tree = await command("specs.get", { projectId: project.id });
  if (!tree.present || tree.legacy) throw new Error("Academy tree not parsed");

  at("session");
  const session = await command("session.create", { projectId: project.id });
  await command("subscribe", {
    channel: { kind: "session", sessionId: session.id },
  });

  at("dispatch");
  await command("turn.submit", { sessionId: session.id, text: PROMPT });
  // Dispatch evidence: the first player prompt of the turn — the
  // coder, since /code opens on it; player ids are roster lanes
  // ("dev.coder", DR-032), not playbook-prefixed names. Live-agent
  // evidence: that player's first text, thinking or tool activity. Routing +
  // first-token latency sit inside the budget (DR-020).
  const dispatched = await waitFor(
    () => {
      const prompt = records.find((m) => m.record?.type === "player_prompt");
      if (prompt) return prompt;
      // The Captain finishing alone is a verdict, not a delay: the
      // task never reached a player, so say so now.
      if (records.some((m) => m.record?.type === "turn_finished")) {
        throw new Error(
          "the turn finished without dispatching a player — the Captain " +
            "answered it directly (check the task reads as coding work)",
        );
      }
      return undefined;
    },
    BUDGET_MS,
    "the coder dispatch prompt",
  );
  const playerId = String(dispatched.record.playerId ?? "");
  say(`coder dispatched: ${playerId}`);
  await waitFor(
    () => livePlayerOutput(records, dispatched),
    BUDGET_MS,
    "live agent output",
  );
  say("live agent output observed");

  at("abort");
  const aborted = await command("turn.abort", { sessionId: session.id });
  if (!aborted.aborted) throw new Error("the turn ended before the abort path could be exercised");
  await waitFor(
    () => records.find((m) => m.record?.type === "turn_aborted"),
    60_000,
    "the aborted-turn record",
  );
  // The abort record precedes cleanup, which releases the runtime; a
  // session still held afterwards is detached explicitly.
  const stopped = await waitFor(
    () => {
      const state = sessions.get(session.id);
      return state && !state.turnActive ? state : undefined;
    },
    60_000,
    "turn cleanup after abort",
  );
  if (stopped.live) await command("session.dispose", { sessionId: session.id });
  await waitFor(
    () => {
      const state = sessions.get(session.id);
      return state && !state.live && !state.turnActive;
    },
    60_000,
    "the released session",
  );

  if (manual) {
    at("manual-review");
    say(`scratch profile: ${scratch}; session: ${session.id}`);
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let timer;
    try {
      await Promise.race([
        input.question("Inspect history, notification and badge; press Enter to close.\n"),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("manual review timed out after 5 minutes")), 300_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      input.close();
    }
  }

  at("teardown");
  socket.close();
  stopApp("SIGTERM");
  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
  ]);
  if (code === "timeout") {
    stopApp("SIGKILL");
    throw new Error("app did not exit on SIGTERM");
  }

  say("critical path complete");
} catch (error) {
  process.stderr.write(`\ndesktop-smoke FAILED at ${stage}: ${error.message}\n`);
  // A blind timeout is useless: say what the session actually
  // produced so the failure names itself.
  if (seen.length > 0) {
    const tally = new Map();
    for (const type of seen) tally.set(type, (tally.get(type) ?? 0) + 1);
    process.stderr.write(
      `records observed: ${[...tally].map(([t, n]) => `${t}×${n}`).join(", ")}\n`,
    );
    if (lastError) process.stderr.write(`last error record: ${lastError}\n`);
  } else {
    process.stderr.write("no records observed on the session channel\n");
  }
  stopApp("SIGKILL");
  process.exitCode = 1;
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (flip) {
    at("abi-restore");
    const restore = spawnSync(
      "npm",
      ["run", "rebuild:node", "-w", "apps/desktop"],
      { cwd: root, stdio: "inherit" },
    );
    if (restore.status !== 0) {
      process.stderr.write(
        "WARNING: ABI restore failed — run `npm run rebuild:node -w apps/desktop`\n",
      );
      process.exitCode = 1;
    }
  }
}
