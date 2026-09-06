// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionStore } from "@sublang/playbook/session-store";
import { Store } from "./store.js";
import { ApplicationRegistry, sha256 } from "./app-storage.js";
import { planStorageMerge, prepareStorageGitFiles, reserveStorageHome, selectStorageMerge, validateStorageTree } from "./storage-git.js";

const git = (home: string, ...args: string[]): string => execFileSync("git", ["-C", home, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function setup() {
  const home = mkdtempSync(join(tmpdir(), "spex-git-store-")); git(home, "init", "-b", "main"); git(home, "config", "user.name", "Storage Test"); git(home, "config", "user.email", "storage@example.test"); git(home, "config", "commit.gpgsign", "false");
  const registry = new ApplicationRegistry(home); const project = registry.register(join(home, "project"), "Project", 1);
  mkdirSync(join(home, "sessions"), { mode: 0o700 }); mkdirSync(join(home, "intents")); prepareStorageGitFiles(home);
  const sessionId = randomUUID();
  const bundle = (label: string) => {
    const records = `${JSON.stringify({ v: 1, seq: 1, record: { futureKind: label } })}\n`;
    writeFileSync(join(home, "sessions", `${sessionId}.records.jsonl`), records, { mode: 0o600 });
    writeFileSync(join(home, "sessions", `${sessionId}.json`), JSON.stringify({ schemaVersion: 7, kind: "captain-session", sessionId, cwd: project.path, createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", state: "history-only", reason: label, replay: { seq: 1, sha256: sha256(records), incomplete: false }, contextSeq: null }, null, 2), { mode: 0o600 });
  };
  const commit = (message: string) => { git(home, "add", "."); git(home, "commit", "-m", message); };
  bundle("base"); commit("base"); return { home, project, sessionId, bundle, commit };
}
function merge(home: string) { try { git(home, "merge", "--no-commit", "--no-ff", "other"); } catch { /* conflicts are the subject */ } }

test("real Git branches select session pairs and ordered intent logs as complete units", async () => {
  const { home, project, sessionId, bundle, commit } = setup();
  git(home, "branch", "other"); bundle("ours");
  const log = join(home, "intents", `${project.id}.jsonl`); const act = (text: string) => `${JSON.stringify({ v: 1, act: "queue", intent: { id: randomUUID(), projectId: project.id, text, rank: "a", createdAt: 1 } })}\n`;
  writeFileSync(log, act("ours")); commit("ours"); const oursManifest = readFileSync(join(home, "sessions", `${sessionId}.json`));
  git(home, "checkout", "other"); bundle("theirs"); mkdirSync(join(home, "intents"), { recursive: true }); writeFileSync(log, act("theirs")); commit("theirs"); const theirsRecords = readFileSync(join(home, "sessions", `${sessionId}.records.jsonl`));
  git(home, "checkout", "main"); const plan = planStorageMerge(home, "HEAD", "other");
  assert.equal(plan.units.find((u) => u.name === `sessions/${sessionId}`)?.choice, "conflict"); assert.equal(plan.units.find((u) => u.name === `intents/${project.id}.jsonl`)?.choice, "conflict");
  merge(home); await assert.rejects(() => selectStorageMerge(home), /choose ours or theirs/);
  const result = await selectStorageMerge(home, { [`sessions/${sessionId}`]: "theirs", [`intents/${project.id}.jsonl`]: "ours" });
  assert.equal(result.diagnostics.length, 0);
  assert.notDeepEqual(readFileSync(join(home, "sessions", `${sessionId}.json`)), oursManifest);
  assert.deepEqual(readFileSync(join(home, "sessions", `${sessionId}.records.jsonl`)), theirsRecords);
  assert.equal(JSON.parse(readFileSync(log, "utf8")).intent.text, "ours");
  assert.equal(git(home, "diff", "--name-only", "--diff-filter=U"), "");
  assert.equal(statSync(join(home, "sessions")).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, "sessions", `${sessionId}.json`)).mode & 0o777, 0o600);
  rmSync(home, { recursive: true, force: true });
});

test("delete versus modify needs explicit bundle choice; active core or CLI lease blocks selection", async () => {
  const { home, sessionId, bundle, commit } = setup(); git(home, "branch", "other");
  rmSync(join(home, "sessions", `${sessionId}.json`)); rmSync(join(home, "sessions", `${sessionId}.records.jsonl`)); commit("delete");
  git(home, "checkout", "other"); bundle("changed"); commit("modify"); git(home, "checkout", "main"); merge(home);
  const release = reserveStorageHome(home); await assert.rejects(() => selectStorageMerge(home, { [`sessions/${sessionId}`]: "theirs" }), /stop the Spex core/); release();
  const shared = createSessionStore({ sessionsDir: join(home, "sessions") }); await shared.prepare(); const lease = await shared.acquireManagement(sessionId);
  await assert.rejects(() => selectStorageMerge(home, { [`sessions/${sessionId}`]: "ours" }), /held|owner|active|lease/i); await lease.release();
  await selectStorageMerge(home, { [`sessions/${sessionId}`]: "ours" });
  assert.equal(existsSync(join(home, "sessions", `${sessionId}.json`)), false); assert.equal(existsSync(join(home, "sessions", `${sessionId}.records.jsonl`)), false);
  rmSync(home, { recursive: true, force: true });
});

test("reopening a real ordinary-umask checkout tightens permissions and refuses altered replay bytes", async () => {
  const { home, sessionId } = setup();
  const copy = mkdtempSync(join(tmpdir(), "spex-git-checkout-")); const previous = process.umask(0o022);
  try { git(copy, "clone", home, "."); } finally { process.umask(previous); }
  const manifest = join(copy, "sessions", `${sessionId}.json`); assert.equal(statSync(manifest).mode & 0o777, 0o644);
  const diagnostics = await validateStorageTree(copy); assert.ok(diagnostics.some((d) => d.reason.includes("unresolved")));
  assert.equal(statSync(manifest).mode & 0o777, 0o600); assert.equal(statSync(join(copy, "sessions")).mode & 0o777, 0o700);
  writeFileSync(join(copy, "sessions", `${sessionId}.records.jsonl`), '{"v":1,"seq":1,"record":{"futureKind":"tampered"}}\n');
  await assert.rejects(() => validateStorageTree(copy), /digest|checkpoint|replay/i);
  rmSync(home, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true });
});

test("Git local-file rules exclude hints, migration inputs, prefs and all lease families", () => {
  const { home, sessionId } = setup();
  for (const file of ["local/migrations/x/inputs/0", "prefs.json", "meta.json", "forge-cache.json", `sessions/${sessionId}.hints.json`, `sessions/.${sessionId}.lock/owner.json`, `sessions/.${sessionId}.lock.retired.x/owner.json`, "playbook/config.yaml.bak.2", "sessions/value.json.x.tmp"]) {
    assert.equal(git(home, "check-ignore", "--no-index", file), file);
  }
  assert.match(git(home, "check-attr", "text", "--", `sessions/${sessionId}.json`, `sessions/${sessionId}.records.jsonl`), /text: unset/);
  rmSync(home, { recursive: true, force: true });
});

test("the documented entry point operates on the chosen home and protective Git rules override earlier exceptions", async () => {
  const { home, sessionId } = setup();
  writeFileSync(join(home, ".gitignore"), readFileSync(join(home, ".gitignore"), "utf8") + "!prefs.json\n");
  writeFileSync(join(home, ".gitattributes"), readFileSync(join(home, ".gitattributes"), "utf8") + "sessions/*.json text\n");
  prepareStorageGitFiles(home);
  assert.equal(git(home, "check-ignore", "--no-index", "prefs.json"), "prefs.json");
  assert.match(git(home, "check-attr", "text", "--", `sessions/${sessionId}.json`), /text: unset/);
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/storage-git.mjs");
  const plan = JSON.parse(execFileSync(process.execPath, [script, "--home", home, "plan", "HEAD", "HEAD"], { encoding: "utf8" }));
  assert.equal(plan.units.find((unit: { name: string }) => unit.name === `sessions/${sessionId}`).choice, "ours");
  const result = JSON.parse(execFileSync(process.execPath, [script, "--home", home, "validate"], { encoding: "utf8" }));
  assert.deepEqual(result, []);
  rmSync(home, { recursive: true, force: true });
});

test("unknown session versions stay local and cannot enter a selected portable tree", async () => {
  const { home, project } = setup(); const id = randomUUID();
  const file = `sessions/${id}.json`;
  const bytes = JSON.stringify({ schemaVersion: 99, sessionId: id, cwd: project.path, future: "opaque" });
  writeFileSync(join(home, file), bytes, { mode: 0o600 });
  writeFileSync(join(home, "sessions", `${id}.records.jsonl`), '{"v":1,"seq":1,"record":{}}\n', { mode: 0o600 });
  prepareStorageGitFiles(home, [file, `sessions/${id}.records.jsonl`]);
  assert.ok((await validateStorageTree(home)).some((entry) => entry.reason.includes("retained locally")));
  assert.equal(readFileSync(join(home, file), "utf8"), bytes);
  await assert.rejects(() => validateStorageTree(home, new Set([id])), /unsupported session version/);
  git(home, "add", "-f", file);
  await assert.rejects(() => validateStorageTree(home), /unsupported session version/);
  rmSync(home, { recursive: true, force: true });
});

test("Git validation and core reopening agree on selected dispatch boundaries", async () => {
  const {home,project,sessionId} = setup();
  const intentId = randomUUID();
  const manifestPath = join(home,"sessions",`${sessionId}.json`);
  const streamPath = join(home,"sessions",`${sessionId}.records.jsonl`);
  const log = join(home,"intents",`${project.id}.jsonl`);
  const other = new ApplicationRegistry(home).register(join(home,"other"),"Other",2);
  const bundle = (cwd: string) => {
    const records = JSON.stringify({v:1,seq:1,record:{type:"turn_started",timestamp:1,turnId:1,turn:{id:1,prompt:"Work"}}}) + "\n";
    const manifest = JSON.parse(readFileSync(manifestPath,"utf8"));
    writeFileSync(streamPath,records);
    writeFileSync(manifestPath,JSON.stringify({...manifest,cwd,replay:{seq:1,sha256:sha256(records),incomplete:false}}));
  };
  const dispatch = (turnId: number) => writeFileSync(log,[
    {v:1,act:"queue",intent:{id:intentId,projectId:project.id,text:"Work",rank:"a",createdAt:1}},
    {v:1,act:"dispatch",id:intentId,sessionId,turnId,at:1},
  ].map((act) => JSON.stringify(act)).join("\n") + "\n");
  const verify = async (valid: boolean) => {
    const before = readFileSync(log);
    if (valid) await validateStorageTree(home);
    else await assert.rejects(() => validateStorageTree(home),/invalid dispatch/);
    const store = new Store({dir:home});
    try {
      await store.initializeSessions();
      if (valid) store.assertWritable({projectId:project.id});
      else assert.throws(() => store.assertWritable({projectId:project.id}),/invalid dispatch/);
    } finally {store.close();}
    assert.deepEqual(readFileSync(log),before);
  };
  try {
    bundle(project.path); dispatch(1); await verify(true);
    dispatch(2); await verify(false);
    bundle(other.path); dispatch(1); await verify(false);
    rmSync(manifestPath); rmSync(streamPath); await verify(true);
  } finally {rmSync(home,{recursive:true,force:true});}
});


test("the rebind command restores a Git ancestor's identity and recorded-path history", async () => {
  const { home, project, sessionId, commit } = setup();
  writeFileSync(join(home, "projects.json"), JSON.stringify({ v: 2, projects: [] })); commit("drop registration");
  const checkout = mkdtempSync(join(tmpdir(), "spex-rebound-project-")); git(checkout, "init");
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/storage-git.mjs");
  const output = JSON.parse(execFileSync(process.execPath, [script, "--home", home, "rebind", project.id, checkout, "--alias", project.path, "--revision", "HEAD^"], { encoding: "utf8" }));
  assert.equal(output.project.id, project.id); assert.equal(output.project.path, checkout); assert.deepEqual(output.diagnostics, []);
  const store = new Store({ dir: home });
  try { await store.initializeSessions(); assert.equal(store.listSessions()[0]?.id, sessionId); assert.equal(store.listSessions()[0]?.projectId, project.id); }
  finally { store.close(); }
  const before = readFileSync(join(home, "projects.json")); const child = join(checkout, "child"); mkdirSync(child);
  assert.throws(() => execFileSync(process.execPath, [script, "--home", home, "rebind", project.id, child], { stdio: "pipe" }), /not the root/);
  assert.deepEqual(readFileSync(join(home, "projects.json")), before);
  const release = reserveStorageHome(home);
  try { assert.throws(() => execFileSync(process.execPath, [script, "--home", home, "rebind", project.id, checkout], { stdio: "pipe" }), /held|one core/); }
  finally { release(); }
  rmSync(home, { recursive: true, force: true }); rmSync(checkout, { recursive: true, force: true });
});

test("Git rules replace stale generated session ignores after successful validation", async () => {
  const {home,sessionId}=setup();
  const file=join(home,".gitignore");
  const original=readFileSync(file,"utf8");
  const canonical=original.split("\n").filter((line)=>line&&!line.startsWith("#"));
  const authorId=randomUUID(); const authored=`# Authored rule\n/sessions/${authorId}.json\n`;
  // Previous releases wrote this exact unmarked block repeatedly.
  writeFileSync(file,authored+canonical.join("\n")+`\n/sessions/${sessionId}.json\n/sessions/${sessionId}.records.jsonl\n`);
  const manifestFile=join(home,"sessions",`${sessionId}.json`); const valid=readFileSync(manifestFile);
  const future={...JSON.parse(valid.toString()),schemaVersion:99}; writeFileSync(manifestFile,JSON.stringify(future));
  const store=new Store({dir:home});
  try {
    await store.initializeSessions(); prepareStorageGitFiles(home,store.untrackedSessionPaths());
    assert.equal(git(home,"check-ignore","--no-index",`sessions/${sessionId}.json`),`sessions/${sessionId}.json`);
    writeFileSync(manifestFile,valid); await store.initializeSessions();
    prepareStorageGitFiles(home,store.untrackedSessionPaths());
    assert.deepEqual(store.untrackedSessionPaths(),[]);
    assert.throws(()=>git(home,"check-ignore","--no-index",`sessions/${sessionId}.json`));
    assert.throws(()=>git(home,"check-ignore","--no-index",`sessions/${sessionId}.records.jsonl`));
    assert.equal(git(home,"check-ignore","--no-index",`sessions/${authorId}.json`),`sessions/${authorId}.json`);
    const after=readFileSync(file,"utf8"); assert.ok(after.startsWith(authored));
    assert.equal(after.split("# BEGIN Spex managed storage rules").length,2);
    prepareStorageGitFiles(home,[]); assert.equal(readFileSync(file,"utf8"),after,"preparation is idempotent");
    git(home,"add","--",`sessions/${sessionId}.json`,`sessions/${sessionId}.records.jsonl`);
  } finally {store.close();rmSync(home,{recursive:true,force:true});}
});
