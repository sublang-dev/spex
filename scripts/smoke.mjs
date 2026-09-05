#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Pre-release smoke suite (RELEASE-20, docs/release-smoke.md): the
// automated stages a release candidate must pass before tagging.
// Fail-fast; each stage names itself so a failure is actionable.
// `--desktop` adds the Electron render stage (flips the native ABI
// to Electron and back — do not run it mid-development).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const require = createRequire(import.meta.url);
const desktop = process.argv.includes("--desktop");
let stage = "";

function run(name, command, args, options = {}) {
  stage = name;
  process.stdout.write(`\n=== smoke: ${name} ===\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`stage "${name}" failed (${command} ${args.join(" ")})`);
  }
}

async function coreRoundTrip() {
  stage = "core-round-trip";
  process.stdout.write(`\n=== smoke: core-round-trip ===\n`);
  const { CoreService } = await import(
    pathToFileURL(join(root, "packages/core/dist/service.js")).href
  );
  const { WebSocket } = await import("ws");
  const home = mkdtempSync(join(tmpdir(), "spex-smoke-"));
  const service = await CoreService.start({
    token: "smoke",
    configPath: join(home, "playbook.config.yaml"),
    env: {},
    home,
    watchConfig: false,
  });
  const socket = new WebSocket(
    `ws://127.0.0.1:${service.port()}/?token=smoke`,
  );
  const replies = new Map();
  let seq = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type === "reply") replies.get(message.id)?.(message);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const command = (type, fields = {}) =>
    new Promise((resolve, reject) => {
      const id = `s${(seq += 1)}`;
      replies.set(id, (reply) =>
        reply.ok
          ? resolve(reply.result)
          : reject(new Error(`${type}: ${reply.error.message}`)),
      );
      socket.send(JSON.stringify({ type, id, ...fields }));
    });

  const config = await command("config.get");
  if (config.status !== "valid") {
    throw new Error(`seeded template did not compose: ${config.error ?? config.status}`);
  }
  const commands = config.summary.playbooks.map((p) => p.command).sort();
  if (!["code", "review", "decide"].every((id) => commands.includes(id))) {
    throw new Error(`template playbooks incomplete: ${commands.join(", ")}`);
  }
  const { builtins } = await command("library.builtins");
  for (const id of ["code", "review", "decide"]) {
    const entry = builtins.find((b) => b.id === id);
    if (!entry) throw new Error(`builtin catalog missing ${id}`);
    if (!entry.source?.startsWith(`# ${id[0].toUpperCase()}${id.slice(1)}`)) {
      throw new Error(`builtin ${id} source missing or unstripped`);
    }
  }
  const artifacts = await command("playbook.artifacts", { playbookId: "code" });
  if (artifacts.missing.length > 0) {
    throw new Error(`code artifacts missing: ${artifacts.missing.join(", ")}`);
  }
  const project = await command("project.create", {
    path: join(home, "academy"),
    example: true,
  });
  const tree = await command("specs.get", { projectId: project.id });
  // The migrated Academy corpus (IR-027): every file a package —
  // 12 of them, none flagged legacy, every one parsing clean.
  const broken = tree.files.filter((f) => f.error !== undefined).length;
  if (!tree.present || tree.legacy || tree.files.length !== 12 || broken !== 0) {
    throw new Error(
      `Academy tree unexpected: present=${tree.present} legacy=${tree.legacy} files=${tree.files.length} broken=${broken}`,
    );
  }
  socket.close();
  await service.stop();
  rmSync(home, { recursive: true, force: true });
  process.stdout.write(
    `core round-trip ok: template valid, catalog + artifacts served, Academy seeded (${tree.files.length} packages, all parsed clean)\n`,
  );
}

try {
  run("build", "npm", ["run", "build"]);
  run("lint", "node", ["packages/cli/dist/cli.js", "lint"]);
  // Workspace test suites already include their integration coverage.
  run("unit-and-integration", "npm", ["test"]);
  // The browser journeys (DR-039): the served UI in Chromium against
  // a real core with substitute agents. The browser install is a
  // cached no-op after the first run.
  run("browser", "npx", ["playwright", "install", "chromium"]);
  run("journeys", "npm", ["run", "e2e"]);
  await coreRoundTrip();
  // The end-user pass: pack the real tarball, install it into an
  // isolated prefix, and walk the README journeys (fresh scaffold,
  // lint, --lang, --update, legacy detection) via the spex bin.
  run("cli-user", "node", ["scripts/cli-smoke.mjs"]);
  if (desktop) {
    // The ABI flip must never outlive the run: node-gyp cleans the
    // Node build before compiling for Electron, so even a failed
    // rebuild:electron needs the restore — the flip itself lives
    // inside the protected region.
    let restoreFailed = false;
    try {
      run("desktop-abi", "npm", ["run", "rebuild:electron", "-w", "apps/desktop"]);
      const shot = join(tmpdir(), `spex-smoke-${Date.now()}.png`);
      // The render boots on scratch user data and a scratch state
      // root: the developer's own Spex may be running — holding the
      // single-instance lock and the ~/.spex root (DR-036) — and a
      // hermetic gate touches nothing of theirs (app-shell-24).
      const renderHome = mkdtempSync(join(tmpdir(), "spex-smoke-home-"));
      try {
        run("desktop-render", require("electron"), ["."], {
          cwd: join(root, "apps", "desktop"),
          env: {
            ...process.env,
            SPEX_ACCEPTANCE: shot,
            SPEX_SMOKE_USERDATA: join(renderHome, "userdata"),
          },
        });
      } finally {
        rmSync(renderHome, { recursive: true, force: true });
      }
      if (!existsSync(shot)) {
        throw new Error("desktop render wrote no screenshot");
      }
      process.stdout.write(`desktop screenshot: ${shot}\n`);
    } finally {
      const restore = spawnSync(
        "npm",
        ["run", "rebuild:node", "-w", "apps/desktop"],
        { cwd: root, stdio: "inherit" },
      );
      if (restore.status !== 0) {
        restoreFailed = true;
        process.stderr.write(
          "WARNING: ABI restore failed — run `npm run rebuild:node -w apps/desktop` before using system-Node tooling\n",
        );
      }
    }
    // A green render must not mask a failed restore: the tree would
    // be left on the Electron ABI and every system-Node run after
    // the smoke would fail at better-sqlite3 load.
    if (restoreFailed) {
      stage = "desktop-abi-restore";
      throw new Error(
        "ABI restore failed; run `npm run rebuild:node -w apps/desktop`",
      );
    }
  } else {
    process.stdout.write(
      "\n(desktop render skipped — pass --desktop before a release)\n",
    );
  }
  process.stdout.write("\nsmoke: all stages passed\n");
} catch (error) {
  process.stderr.write(`\nsmoke FAILED at ${stage}: ${error.message}\n`);
  process.exit(1);
}
