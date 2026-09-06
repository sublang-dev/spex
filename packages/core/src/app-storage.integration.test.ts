// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import type { IntentInfo } from "./protocol.js";
import { ApplicationRegistry, foldIntentActs, migrateApplicationRegistry, parseIntentLog, parsePrefs, sha256, validateApplicationTree, validateIntentRelations } from "./app-storage.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "spex-app-storage-"));
const line = (act: object): string => `${JSON.stringify({ v: 1, ...act })}\n`;

test("registry migration retains exact input, separates paths and rebinds one identity across restarts", () => {
  const home = scratch(); const id = randomUUID(); const first = join(home, "first"); const second = join(home, "second");
  const original = JSON.stringify({ v: 1, projects: [{ id, path: first, name: "Example", registeredAt: 1 }] }, null, 2);
  writeFileSync(join(home, "projects.json"), original);
  const registry = new ApplicationRegistry(home);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "projects.json"), "utf8")), { v: 2, projects: [{ id, name: "Example", registeredAt: 1 }] });
  const migration = readdirSync(join(home, "local", "migrations"))[0];
  assert.equal(readFileSync(join(home, "local", "migrations", migration, "inputs", "0"), "utf8"), original);
  assert.equal(JSON.parse(readFileSync(join(home, "local", "migrations", migration, "receipt.json"), "utf8")).complete, true);
  registry.bind(registry.identities.get(id)!, second);
  const reopened = new ApplicationRegistry(home);
  assert.equal(reopened.resolvePath(first)?.id, id); assert.equal(reopened.resolvePath(second)?.id, id);
  assert.equal(reopened.project(id)?.path, second);
  assert.equal(reopened.register(first, "Ignored replacement", 2).id, id);
  assert.equal(reopened.identities.size, 1);
  rmSync(home, { recursive: true, force: true });
});

test("registry migration resumes after one destination and refuses divergent destinations", () => {
  const home = scratch(); const id = randomUUID(); const migration = randomUUID();
  const original = JSON.stringify({ v: 1, projects: [{ id, path: join(home, "repo"), name: "Repo", registeredAt: 1 }] });
  const dir = join(home, "local", "migrations", migration); mkdirSync(join(dir, "inputs"), { recursive: true });
  writeFileSync(join(dir, "inputs", "0"), original);
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ v: 1, id: migration, inputs: [{ path: join(home, "projects.json"), sha256: sha256(original) }], complete: false }));
  writeFileSync(join(home, "projects.json"), JSON.stringify({ v: 2, projects: [{ id, name: "Repo", registeredAt: 1 }] }));
  migrateApplicationRegistry(home);
  assert.equal(new ApplicationRegistry(home).project(id)?.path, join(home, "repo"));
  const conflict = scratch(); writeFileSync(join(conflict, "projects.json"), original);
  mkdirSync(join(conflict, "local")); writeFileSync(join(conflict, "local", "project-paths.json"), JSON.stringify({ v: 1, bindings: [] }));
  assert.throws(() => migrateApplicationRegistry(conflict), /destination diverged/);
  assert.equal(readFileSync(join(conflict, "projects.json"), "utf8"), original);
  rmSync(home, { recursive: true, force: true }); rmSync(conflict, { recursive: true, force: true });
});

test("unknown registry versions and ambiguous path bindings preserve files and require explicit selection", () => {
  const home = scratch(); const original = '{"v":55,"projects":[]}'; writeFileSync(join(home, "projects.json"), original);
  assert.throws(() => new ApplicationRegistry(home), /unsupported registry version/);
  assert.equal(readFileSync(join(home, "projects.json"), "utf8"), original);
  rmSync(join(home, "projects.json")); const registry = new ApplicationRegistry(home);
  const a = registry.register(join(home, "a"), "A", 0); const b = registry.register(join(home, "b"), "B", 1);
  assert.throws(() => registry.bind(registry.identities.get(b.id)!, join(home, "a")), /already belongs/);
  registry.identities.delete(a.id); registry.save();
  const reopened = new ApplicationRegistry(home);
  assert.equal(reopened.resolvePath(join(home, "a")), undefined);
  assert.match(reopened.diagnostics()[0].reason, /unregistered/);
  assert.throws(() => reopened.register(join(home, "a"), "New", 2), /explicit rebinding/);
  rmSync(home, { recursive: true, force: true });
});

test("local registration normalizes before lookup and foreign aliases survive restart unchanged", () => {
  const home = scratch();
  try {
    const registry = new ApplicationRegistry(home);
    const local = join(home, "repo");
    const project = registry.register(local, "Local", 1);
    assert.equal(registry.register(`${local}${sep}.`, "Repeated", 2).id, project.id);
    assert.equal(registry.register(local.replaceAll("\\", "/"), "Slashes", 3).id, project.id);
    const aliases = ["/Users/alice/project", "C:\\Users\\alice\\project", "\\\\server\\share\\project"];
    registry.bind(registry.identities.get(project.id)!, local, aliases);
    const reopened = new ApplicationRegistry(home);
    assert.equal(reopened.identities.size, 1);
    assert.equal(reopened.project(project.id)?.path, local);
    for (const alias of aliases) assert.equal(reopened.resolvePath(alias)?.id, project.id);
    const file = join(home, "local", "project-paths.json");
    const before = readFileSync(file);
    for (const alias of ["/Users/alice/../project", "C:\\Users\\alice\\..\\project", "C:/Users/alice/project", "C:project", "\\Users\\alice", "relative/project", "/Users/alice/project\0"]) {
      assert.throws(() => reopened.bind(reopened.identities.get(project.id)!, local, [alias]), /invalid project binding/);
      assert.deepEqual(readFileSync(file), before);
    }
    const foreignLocal = process.platform === "win32" ? aliases[0] : aliases[1];
    const invalid = JSON.stringify({v:1, bindings:[{id:project.id, path:foreignLocal, aliases:[]}]});
    writeFileSync(file, invalid);
    assert.throws(() => new ApplicationRegistry(home), /invalid project binding/);
    assert.equal(readFileSync(file, "utf8"), invalid);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test("intent acts fold exactly, ignore only an incomplete last line, and refuse lost or duplicated identities", () => {
  const project = randomUUID(); const id = randomUUID(); const next = randomUUID(); const sessionId = randomUUID();
  const intent = { id, projectId: project, text: "first", rank: "a", createdAt: 1 };
  const contents = line({ act: "queue", intent }) + line({ act: "edit", id, text: "edited" }) + line({ act: "move", id, rank: "b" }) + line({ act: "link", id, afterId: next }) + line({ act: "link", id, afterId: null }) + line({ act: "dispatch", id, sessionId, turnId: 1, at: 2 }) + line({ act: "close", id, as: "done", at: 3 }) + '{"v":1';
  const folded = foldIntentActs(parseIntentLog(contents, project), "fixture");
  assert.deepEqual(folded.intents.get(id), { ...intent, text: "edited", rank: "b", dispatched: { sessionId, turnId: 1, at: 2 }, closedAt: 3, closedAs: "done" });
  assert.throws(() => parseIntentLog(`${contents}\n`, project), /invalid completed/);
  assert.throws(() => parseIntentLog(line({ act: "queue", intent, extra: true }), project), /expected fields/);
  assert.throws(() => foldIntentActs(parseIntentLog(line({ act: "queue", intent }) + line({ act: "queue", intent }), project), "fixture"), /duplicate queue/);
  assert.throws(() => foldIntentActs([{ act: "edit", id, text: "missing" }], "fixture"), /unknown intent/);
  assert.throws(() => foldIntentActs([{ act: "queue", intent }, { act: "remove", id, at: 2 }, { act: "edit", id, text: "resurrect" }], "fixture"), /removed intent/);
});

test("selected-tree validation reports orphan identities and rejects duplicate ranks, sources and cycles without modifying bytes", () => {
  const home = scratch(); const registry = new ApplicationRegistry(home); const project = registry.register(join(home, "repo"), "Repo", 1);
  mkdirSync(join(home, "intents")); const a = { id: randomUUID(), projectId: project.id, text: "A", rank: "a", createdAt: 1, source: { kind: "issue" as const, ref: "1" } }; const b = { ...a, id: randomUUID(), rank: "b" };
  const file = join(home, "intents", `${project.id}.jsonl`); const sourceConflict = line({ act: "queue", intent: a }) + line({ act: "queue", intent: b }); writeFileSync(file, sourceConflict);
  assert.throws(() => validateApplicationTree(home), /duplicate open source/); assert.equal(readFileSync(file, "utf8"), sourceConflict);
  const intents = new Map<string, IntentInfo>([[a.id, a], [b.id, { ...b, rank: "a", source: undefined }]]);
  assert.throws(() => validateIntentRelations(intents, new Set()), /duplicate open rank/);
  const cycle = new Map<string, IntentInfo>([[a.id, { ...a, afterId: b.id }], [b.id, { ...b, source: undefined, afterId: a.id }]]);
  assert.throws(() => validateIntentRelations(cycle, new Set()), /dependency cycle/);
  writeFileSync(file, line({ act: "queue", intent: a })); writeFileSync(join(home, "projects.json"), '{"v":2,"projects":[]}');
  assert.equal(validateApplicationTree(home).diagnostics.some((d) => d.reason.includes(project.id)), true);
  assert.throws(() => parsePrefs({ v: 1, prefs: { [`viewed:${a.id}`]: -1 } }), /invalid viewed/);
  rmSync(home, { recursive: true, force: true });
});

test("startup tolerance never bypasses an incomplete registry migration", () => {
  const home=scratch(); const id=randomUUID(); const migration=randomUUID();
  const registryFile=join(home,"projects.json");
  const original=JSON.stringify({v:1,projects:[{id,path:join(home,"repo"),name:"Legacy",registeredAt:1,unexpected:true}]});
  const dir=join(home,"local","migrations",migration); mkdirSync(join(dir,"inputs"),{recursive:true});
  writeFileSync(join(dir,"inputs","0"),original);
  writeFileSync(join(dir,"receipt.json"),JSON.stringify({v:1,id:migration,inputs:[{path:registryFile,sha256:sha256(original)}],complete:false}));
  const current=JSON.stringify({v:2,projects:[{id,name:"Legacy",registeredAt:1}]}); writeFileSync(registryFile,current);
  try {
    assert.throws(()=>new ApplicationRegistry(home,true),/expected fields/);
    assert.equal(readFileSync(registryFile,"utf8"),current);
    assert.equal(JSON.parse(readFileSync(join(dir,"receipt.json"),"utf8")).complete,false);
  } finally {rmSync(home,{recursive:true,force:true});}
});
