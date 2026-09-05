// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compilePlaybook, defaultSpawner } from "./compile.js";
import { loadConfig, resolveConfigPath, resolveSessionsDir } from "./config.js";
import { editConfigFile } from "./config-edit.js";
import { migrateManagedLibraryConfig } from "./config-migrate.js";
import { resolveArtifacts } from "./artifacts.js";
import { stubSlcSource } from "./testing/stub-slc.js";

test("home defaults agree and only explicit session paths replace the shared default", () => {
  const scratch = mkdtempSync(join(tmpdir(), "spex-locations-")); const home = join(scratch, "home"); const config = join(scratch, "elsewhere", "config.yaml"); mkdirSync(join(scratch, "elsewhere"));
  assert.equal(resolveConfigPath({ SPEX_HOME: home }, scratch), join(home, "playbook", "playbook.config.yaml"));
  assert.equal(resolveSessionsDir(config, { SPEX_HOME: home, XDG_STATE_HOME: "/ignored" }, scratch), join(home, "sessions"));
  assert.equal(resolveSessionsDir(config, { SPEX_HOME: "  " }, scratch), join(scratch, ".spex", "sessions"));
  writeFileSync(config, "sessions: ./records\n"); assert.equal(resolveSessionsDir(config, { SPEX_HOME: home }, scratch), join(scratch, "elsewhere", "records"));
  writeFileSync(config, "sessions: ~/records\n"); assert.equal(resolveSessionsDir(config, {}, scratch), join(scratch, "records"));
  rmSync(scratch, { recursive: true, force: true });
});

test("managed config, executable modules and graphs relocate; omitted bundles rebuild from retained inputs", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "spex-library-move-")); const original = join(scratch, "first"); const moved = join(scratch, "second");
  const config = join(original, "playbook", "playbook.config.yaml"); const library = join(original, "playbooks"); mkdirSync(join(original, "playbook"), { recursive: true });
  const stub = join(scratch, "slc.cjs"); writeFileSync(stub, stubSlcSource());
  const result = await compilePlaybook({ playbookId: "demo", source: { text: "# Demo\n\nA portable workflow.\n" }, roles: ["Helper"], command: "special", intent: "Retained custom intent", libraryDir: library, configPath: config, env: { SPEX_SLC: `${process.execPath} ${stub}` }, spawner: async (cmd, args, cwd, line, signal) => { if (args[0] === "--version") { line("v25.5.0"); return 0; } return defaultSpawner(cmd, args, cwd, line, signal); } });
  assert.equal(result.from, "../playbooks/demo/demo.registry.mjs");
  // Exercise conversion of the legacy absolute value, with original YAML retained.
  const before = `# retained comment\ncaptain: claude\nplayers: {worker: claude}\nplaybooks:\n  demo:\n    from: ${join(library, "demo", "demo.registry.mjs")}\n    roles: {Helper: worker}\n`;
  writeFileSync(config, before); migrateManagedLibraryConfig(config, library, original);
  assert.match(readFileSync(config, "utf8"), /from: \.\.\/playbooks\/demo\/demo.registry.mjs/);
  assert.match(readFileSync(config, "utf8"), /retained comment/);
  const loaded = await loadConfig(config); assert.equal(loaded.composed.playbooks[0].manifestCommand, "special");
  cpSync(original, moved, { recursive: true }); rmSync(original, { recursive: true, force: true });
  const movedConfig = join(moved, "playbook", "playbook.config.yaml"); const movedLibrary = join(moved, "playbooks");
  const copied = await loadConfig(movedConfig); assert.equal(copied.composed.playbooks[0].from, resolve(movedLibrary, "demo", "demo.registry.mjs"));
  const artifacts = await resolveArtifacts(copied.composed.playbooks[0]); assert.ok(artifacts.machine); assert.match(artifacts.source ?? "", /portable workflow/);
  rmSync(join(movedLibrary, "demo", "demo.registry.mjs")); rmSync(join(movedLibrary, "demo", "demo.fsm.bundle.mjs"));
  const rebuilt = await loadConfig(movedConfig, undefined, { libraryDir: movedLibrary });
  assert.equal(rebuilt.composed.playbooks[0].intent, "Retained custom intent"); assert.equal(rebuilt.composed.playbooks[0].manifestCommand, "special"); assert.ok(existsSync(join(movedLibrary, "demo", "demo.fsm.bundle.mjs")));
  const edit = await editConfigFile(movedConfig, { kind: "player.set", playerId: "worker", patch: { instruction: "Keep it small" } });
  assert.equal(edit.ok, true);
  assert.match(readFileSync(movedConfig, "utf8"), /from: \.\.\/playbooks\/demo\/demo.registry.mjs/);
  rmSync(join(movedLibrary, "demo", "demo.registry.mjs")); rmSync(join(movedLibrary, "demo", "demo.ts"));
  await assert.rejects(() => loadConfig(movedConfig, undefined, { libraryDir: movedLibrary }), /unavailable.*missing/);
  rmSync(scratch, { recursive: true, force: true });
});
