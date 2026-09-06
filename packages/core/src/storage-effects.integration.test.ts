// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "@sublang/playbook/session-store";
import { executionConfigFromPlan, loadLaunchPlan, openSessionHost } from "@sublang/playbook/session-host";
import { ApplicationRegistry } from "./app-storage.js";
import { prepareStorageGitFiles, selectStorageMerge } from "./storage-git.js";
import { fakeAdapterImports } from "./testing/fake-adapter.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

// Seed durable boundaries through Playbook's real repository authority. Production
// uses the public host; this fixture reaches the owning package's write-ahead path.
const { createRepositoryEffectCapabilities, classifyRepositoryReceipt } = await import(
  new URL("./bin/repository-effects.js", import.meta.resolve("@sublang/playbook/session-host")).href
);

test("storage-16: Git selection reconciles an omitted repository receipt before another agent can run", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "spex-git-effects-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  for (const dir of [home, project]) {
    mkdirSync(dir);
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.name", "Storage Test");
    git(dir, "config", "user.email", "storage@example.test");
    git(dir, "config", "commit.gpgsign", "false");
  }
  writeFileSync(join(project, "work.txt"), "baseline\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "baseline");
  new ApplicationRegistry(home).register(project, "Project", 1);
  prepareStorageGitFiles(home);
  const configPath = join(root, "playbook.config.yaml");
  writeFileSync(configPath, `captain:
  adapter: claude
players:
  dev.coder:
    adapter: claude
playbooks:
  code:
    from: "@sublang/playbook/code/registry"
    roles:
      coder: dev.coder
`);
  const config = executionConfigFromPlan(await loadLaunchPlan({ userConfigPath: configPath }));
  const { imports } = fakeAdapterImports({ fallback: { result: "Done" } });
  const sessionsDir = join(home, "sessions");
  const store = createSessionStore({ sessionsDir });
  const host = await openSessionHost({ store, mode: "new", cwd: project, config, adapterImports: imports });
  const id = host.sessionId;
  try { await host.handleBossTurn("Establish the session"); } finally { await host.dispose(); }
  const manifest = join(sessionsDir, `${id}.json`);
  const replay = join(sessionsDir, `${id}.records.jsonl`);
  const commit = (message: string) => { git(home, "add", "."); git(home, "commit", "-m", message); };
  commit("base");
  git(home, "branch", "other");

  const lease = await store.acquire(id);
  const settled = await lease.read();
  assert.ok(settled?.snapshot);
  const attemptId = randomUUID();
  let checkpoint: any;
  try {
    await lease.beginTurn({ input: "Prepare an effect", attemptId,
      attemptedExecutionProjection: settled.lastAppliedExecutionProjection });
    const pendingRecord = await lease.read();
    assert.ok(pendingRecord);
    let mirror = pendingRecord.effectLedger;
    const capabilities = await createRepositoryEffectCapabilities({ cwd: project, catalog: config.catalog,
      sessionId: id, sessionLease: lease, createWriteAhead: () => ({ snapshot: () => mirror,
        async writeAhead(authority: Parameters<typeof lease.writeEffectLedger>[0], commands: Parameters<typeof lease.writeEffectLedger>[1]) {
          return mirror = await lease.writeEffectLedger(authority, commands);
        },
      }),
    });
    await capabilities.code.effectLedger.writeAhead([{ kind: "start-boundaries", boundaries: [{
      boundaryId: randomUUID(), playbookId: "code", runtimeSessionId: randomUUID(), turnId: 1,
      callId: "coder:checkpoint", roleId: "coder", sourceStateId: "implementing",
      sourceOutcomeSchema: { type: "object" }, dispositions: ["one-descendant-commit"],
      canonicalWorktree: capabilities.code.authority.canonicalWorktree,
      baseline: await capabilities.code.repository.observe(), correctionBudget: { limit: 1, spent: false },
    }] }]);
    checkpoint = await lease.settle({ attemptId, unresolvedEffects: [],
      snapshot: { ...settled.snapshot, effectLedger: mirror } });
    await lease.beginTurn({ input: "Complete the effect", attemptId: randomUUID(),
      attemptedExecutionProjection: checkpoint.lastAppliedExecutionProjection });
  } finally { await lease.release(); }
  const selectedManifest = readFileSync(manifest);
  const selectedReplay = readFileSync(replay);
  commit("retain an incomplete effect boundary");

  git(home, "checkout", "other");
  writeFileSync(manifest, selectedManifest);
  writeFileSync(replay, selectedReplay);
  await store.prepare();
  const completion = await store.acquire(id);
  try {
    const pendingRecord = await completion.read();
    assert.equal(pendingRecord?.state, "uncertain");
    assert.ok(pendingRecord?.uncertain);
    const completionId = pendingRecord.uncertain.attemptId;
    let mirror = pendingRecord.effectLedger;
    const capabilities = await createRepositoryEffectCapabilities({ cwd: project, catalog: config.catalog,
      sessionId: id, sessionLease: completion, createWriteAhead: () => ({ snapshot: () => mirror,
        async writeAhead(authority: Parameters<typeof completion.writeEffectLedger>[0], commands: Parameters<typeof completion.writeEffectLedger>[1]) {
          return mirror = await completion.writeEffectLedger(authority, commands);
        },
      }),
    });
    const pending = mirror.boundaries[0];
    writeFileSync(join(project, "work.txt"), "completed once\n");
    git(project, "add", ".");
    git(project, "commit", "-m", "perform the external action");
    const after = await capabilities.code.repository.observe();
    const physicalReceipt = await classifyRepositoryReceipt(pending.baseline, after, {
      allowedDispositions: pending.dispositions,
    });
    assert.equal(physicalReceipt.classification, "one-descendant-commit");
    await capabilities.code.effectLedger.writeAhead([{ kind: "replace-boundaries", replacements: [{
      expected: pending, next: { ...pending, after, physicalReceipt },
    }] }]);
    await completion.settle({ attemptId: completionId, unresolvedEffects: [],
      snapshot: { ...checkpoint.snapshot, effectLedger: mirror } });
  } finally { await completion.release(); }
  commit("record the completed effect");
  const completedHead = git(project, "rev-parse", "HEAD");

  git(home, "checkout", "main");
  try { git(home, "merge", "--no-commit", "--no-ff", "other"); } catch { /* explicit selection follows */ }
  await selectStorageMerge(home, { [`sessions/${id}`]: "ours" });
  assert.deepEqual(readFileSync(manifest), selectedManifest);
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).effectLedger.boundaries[0].physicalReceipt, undefined);
  let hostStarts = 0;
  await assert.rejects(() => openSessionHost({ store, sessionId: id, mode: "retry", cwd: project, config,
    createHostRuntime: async () => { hostStarts += 1; throw new Error("must not run another action"); },
  }), /cannot restore a changed pre-turn boundary/);
  assert.equal(hostStarts, 0, "reconciliation refuses before any host or provider work");
  const recovered = JSON.parse(readFileSync(manifest, "utf8")).effectLedger.boundaries[0].physicalReceipt;
  assert.equal(recovered.classification, "one-descendant-commit");
  assert.equal(recovered.commitOid, completedHead, "the selected manifest now retains evidence of the omitted action");
  assert.equal(git(project, "rev-parse", "HEAD"), completedHead);
  assert.equal(git(project, "rev-list", "--count", "HEAD"), "2");
  assert.equal(readFileSync(join(project, "work.txt"), "utf8"), "completed once\n");
});
