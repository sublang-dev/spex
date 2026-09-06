// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import type { IntentInfo, ProjectInfo } from "./protocol.js";

export interface ProjectIdentity { id: string; name: string; registeredAt: number }
export interface ProjectBinding { id: string; path: string; aliases: string[] }
export interface StorageDiagnostic { file: string; reason: string; blocking: boolean }
export interface RebindProjectOptions { id: string; path: string; aliases?: string[]; revision?: string }
export type IntentAct =
  | { act: "queue"; intent: IntentInfo }
  | { act: "edit"; id: string; text: string }
  | { act: "move"; id: string; rank: string }
  | { act: "link"; id: string; afterId: string | null }
  | { act: "dispatch"; id: string; sessionId: string; turnId: number; at: number }
  | { act: "close"; id: string; as: "done" | "dropped"; at: number }
  | { act: "remove"; id: string; at: number };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const timestamp = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const localPath = (value: unknown): value is string => text(value) && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
// Recorded aliases retain the source device's syntax; they never authorize execution.
const recordedPath = (value: unknown): value is string => text(value) && !value.includes("\0") && (
  posix.isAbsolute(value) && posix.resolve(value) === value ||
  (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) && win32.isAbsolute(value) && win32.resolve(value) === value
);

export class StorageFormatError extends Error {
  constructor(readonly file: string, readonly reason: string) { super(`${file}: ${reason}`); this.name = "StorageFormatError"; }
}
class StorageMigrationError extends StorageFormatError {}
function need(condition: unknown, file: string, reason: string): asserts condition {
  if (!condition) throw new StorageFormatError(file, reason);
}
function closed(value: unknown, required: string[], optional: string[], file: string): asserts value is Record<string, unknown> {
  need(object(value), file, "expected an object");
  need(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)), file, `expected fields ${required.join(", ")}${optional.length ? `; optional ${optional.join(", ")}` : ""}`);
}
export function parseRegistry(value: unknown, file = "projects.json"): ProjectIdentity[] {
  closed(value, ["v", "projects"], [], file);
  need(value.v === 2 && Array.isArray(value.projects), file, "unsupported registry version or projects array");
  const ids = new Set<string>();
  for (const p of value.projects) {
    closed(p, ["id", "name", "registeredAt"], [], file);
    need(uuid(p.id) && text(p.name) && timestamp(p.registeredAt), file, "invalid project identity");
    need(!ids.has(p.id), file, `duplicate project ${p.id}`); ids.add(p.id);
  }
  return value.projects as unknown as ProjectIdentity[];
}
export function parseBindings(value: unknown, file = "local/project-paths.json"): ProjectBinding[] {
  closed(value, ["v", "bindings"], [], file);
  need(value.v === 1 && Array.isArray(value.bindings), file, "unsupported path-map version or bindings array");
  const ids = new Set<string>();
  for (const b of value.bindings) {
    closed(b, ["id", "path", "aliases"], [], file);
    need(uuid(b.id) && localPath(b.path) && Array.isArray(b.aliases) && b.aliases.every(recordedPath) && new Set(b.aliases).size === b.aliases.length, file, "invalid project binding");
    need(!ids.has(b.id), file, `duplicate binding ${b.id}`); ids.add(b.id);
  }
  return value.bindings as unknown as ProjectBinding[];
}
export function parsePrefs(value: unknown, file = "prefs.json"): Record<string, unknown> {
  closed(value, ["v", "prefs"], [], file);
  need(value.v === 1 && object(value.prefs), file, "unsupported preference version or prefs object");
  for (const [key, value_] of Object.entries(value.prefs)) {
    if (key.startsWith("viewed:")) need(timestamp(value_), file, `invalid viewed marker ${key}`);
  }
  return value.prefs;
}
function validateIntent(value: unknown, projectId: string, file: string): asserts value is IntentInfo {
  closed(value, ["id", "projectId", "text", "rank", "createdAt"], ["source", "afterId", "dispatched", "closedAt", "closedAs"], file);
  need(uuid(value.id) && value.projectId === projectId && typeof value.text === "string" && text(value.rank) && timestamp(value.createdAt), file, "invalid queued intent");
  if (value.afterId !== undefined) need(uuid(value.afterId), file, "invalid predecessor");
  if (value.source !== undefined) {
    closed(value.source, ["kind", "ref"], ["url", "labels"], file);
    need(["issue", "pr", "record", "chat"].includes(String(value.source.kind)) && text(value.source.ref) && (value.source.url === undefined || typeof value.source.url === "string") && (value.source.labels === undefined || Array.isArray(value.source.labels) && value.source.labels.every((x) => typeof x === "string")), file, "invalid source");
  }
  if (value.dispatched !== undefined) {
    closed(value.dispatched, ["sessionId", "turnId", "at"], [], file);
    need(uuid(value.dispatched.sessionId) && Number.isSafeInteger(value.dispatched.turnId) && (value.dispatched.turnId as number) > 0 && timestamp(value.dispatched.at), file, "invalid dispatch");
  }
  need((value.closedAt === undefined) === (value.closedAs === undefined), file, "incomplete closed intent");
  if (value.closedAt !== undefined) need(timestamp(value.closedAt) && ["done", "dropped"].includes(String(value.closedAs)), file, "invalid close");
}
export function parseIntentLog(contents: string, projectId: string, file = `intents/${projectId}.jsonl`): IntentAct[] {
  need(uuid(projectId), file, "filename must be a project UUID");
  const lines = contents.split("\n"); lines.pop(); // only newline-terminated acts exist
  const acts: IntentAct[] = [];
  const fields: Record<string, string[]> = { queue: ["intent"], edit: ["id", "text"], move: ["id", "rank"], link: ["id", "afterId"], dispatch: ["id", "sessionId", "turnId", "at"], close: ["id", "as", "at"], remove: ["id", "at"] };
  for (let i = 0; i < lines.length; i++) {
    const location = `${file}:${i + 1}`;
    let value: unknown;
    try { value = JSON.parse(lines[i]); } catch { throw new StorageFormatError(location, "invalid completed JSON line"); }
    need(object(value) && value.v === 1 && typeof value.act === "string" && Object.hasOwn(fields, value.act), location, "unsupported act/version");
    closed(value, ["v", "act", ...fields[value.act]], [], location);
    if (value.act === "queue") validateIntent(value.intent, projectId, location);
    else {
      need(uuid(value.id), location, "invalid intent ID");
      if (value.act === "edit") need(typeof value.text === "string", location, "invalid text");
      if (value.act === "move") need(text(value.rank), location, "invalid rank");
      if (value.act === "link") need(value.afterId === null || uuid(value.afterId), location, "invalid predecessor");
      if (["dispatch", "close", "remove"].includes(value.act)) need(timestamp(value.at), location, "invalid timestamp");
      if (value.act === "dispatch") need(uuid(value.sessionId) && Number.isSafeInteger(value.turnId) && (value.turnId as number) > 0, location, "invalid dispatch");
      if (value.act === "close") need(value.as === "done" || value.as === "dropped", location, "invalid close");
    }
    const { v: _v, ...act } = value; acts.push(act as IntentAct);
  }
  return acts;
}
export function foldIntentActs(acts: IntentAct[], file: string, intents = new Map<string, IntentInfo>(), removed = new Set<string>()): { intents: Map<string, IntentInfo>; removed: Set<string> } {
  for (const act of acts) {
    if (act.act === "queue") {
      need(!intents.has(act.intent.id), file, `duplicate queue ${act.intent.id}`);
      intents.set(act.intent.id, structuredClone(act.intent)); continue;
    }
    const intent = intents.get(act.id);
    need(intent, file, `act targets unknown intent ${act.id}`);
    need(!removed.has(act.id), file, `act targets removed intent ${act.id}`);
    switch (act.act) {
      case "edit": intent.text = act.text; break;
      case "move": intent.rank = act.rank; break;
      case "link": if (act.afterId === null) delete intent.afterId; else intent.afterId = act.afterId; break;
      case "dispatch": intent.dispatched = { sessionId: act.sessionId, turnId: act.turnId, at: act.at }; break;
      case "close": intent.closedAt = act.at; intent.closedAs = act.as; break;
      case "remove": removed.add(act.id); break;
    }
  }
  return { intents, removed };
}
export function validateIntentRelations(intents: Map<string, IntentInfo>, removed: Set<string>, file = "intents", projectId?: string): void {
  const ranks = new Set<string>(); const sources = new Set<string>();
  for (const intent of intents.values()) {
    if (removed.has(intent.id) || projectId !== undefined && intent.projectId !== projectId) continue;
    if (intent.closedAt === undefined) {
      const rank = `${intent.projectId}\0${intent.rank}`;
      need(!ranks.has(rank), file, `duplicate open rank ${intent.rank}`); ranks.add(rank);
      if (intent.source && intent.source.kind !== "chat") {
        const source = `${intent.projectId}\0${intent.source.kind}\0${intent.source.ref}`;
        need(!sources.has(source), file, `duplicate open source ${intent.source.ref}`); sources.add(source);
      }
    }
    const seen = new Set([intent.id]); let next = intent.afterId;
    while (next !== undefined) {
      need(intents.has(next), file, `missing predecessor ${next}`);
      need(!seen.has(next), file, `dependency cycle at ${next}`); seen.add(next);
      next = intents.get(next)?.afterId;
    }
  }
}
export function validateIntentDispatches(
  intents: Map<string, IntentInfo>,
  sessions: Map<string, {projectId?: string; turns: ReadonlySet<number>}>,
  projectId?: string,
): void {
  for (const intent of intents.values()) {
    if (!intent.dispatched || projectId !== undefined && intent.projectId !== projectId) continue;
    const session = sessions.get(intent.dispatched.sessionId);
    if (!session) continue; // Deleted targets retain ledger derivation.
    need((session.projectId === undefined || session.projectId === intent.projectId) && session.turns.has(intent.dispatched.turnId),
      `intents/${intent.projectId}.jsonl`, `invalid dispatch for ${intent.id}`);
  }
}
export function readJsonFile(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new StorageFormatError(file, (error as Error).message); }
}
export function writeApplicationBytes(file: string, bytes: Buffer | string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  // Directory handles are not supported by Windows; the file is still synced.
  if (process.platform !== "win32") {
    const dir = openSync(dirname(file), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}
export function writeApplicationFile(file: string, value: unknown): void { writeApplicationBytes(file, JSON.stringify(value)); }
export const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

interface MigrationReceipt { v: 1; id: string; inputs: { path: string; sha256: string }[]; complete: boolean }
/** Exact original bytes are durable before either destination is replaced. */
export function migrateApplicationRegistry(home: string): void {
  const file = join(home, "projects.json");
  const local = join(home, "local"); mkdirSync(local, { recursive: true, mode: 0o700 });
  const bindingsFile = join(local, "project-paths.json");
  const migrations = join(local, "migrations"); mkdirSync(migrations, { recursive: true, mode: 0o700 });
  let receipt: MigrationReceipt | undefined; let receiptDir: string | undefined;
  for (const id of readdirSync(migrations)) {
    const candidate = join(migrations, id, "receipt.json");
    if (!existsSync(candidate)) continue;
    const found = readJsonFile(candidate) as MigrationReceipt;
    if (found.complete === false && found.inputs?.[0]?.path === file) { receipt = found; receiptDir = join(migrations, id); break; }
  }
  if (!receipt && !existsSync(file)) return;
  const original = receipt ? readFileSync(join(receiptDir!, "inputs", "0")) : readFileSync(file);
  let before: Record<string, unknown>;
  try { before = JSON.parse(original.toString("utf8")) as Record<string, unknown>; }
  catch { throw new StorageFormatError(receipt ? join(receiptDir!, "inputs", "0") : file, "invalid JSON"); }
  need(object(before), receipt ? join(receiptDir!, "inputs", "0") : file, "expected a registry object");
  if (before.v === 2 && !receipt) { parseRegistry(before, file); return; }
  if (!receipt && before.v !== 1) throw new StorageFormatError(file, "unsupported registry version; preserved unchanged");
  try {
    closed(before, ["v", "projects"], [], file);
    need(before.v === 1 && Array.isArray(before.projects), file, "unsupported registry version; preserved unchanged");
    const identities: ProjectIdentity[] = []; const bindings: ProjectBinding[] = [];
    for (const p of before.projects) {
      closed(p, ["id", "path", "name", "registeredAt"], [], file);
      need(localPath(p.path), file, "invalid legacy project path");
      identities.push({ id: p.id as string, name: p.name as string, registeredAt: p.registeredAt as number });
      bindings.push({ id: p.id as string, path: p.path, aliases: [] });
    }
    const registry = { v: 2, projects: identities }; const mapping = { v: 1, bindings };
    parseRegistry(registry, file); parseBindings(mapping, bindingsFile);
    if (!receipt) {
      const id = randomUUID(); receiptDir = join(migrations, id); mkdirSync(join(receiptDir, "inputs"), { recursive: true, mode: 0o700 });
      writeApplicationBytes(join(receiptDir, "inputs", "0"), original);
      receipt = { v: 1, id, inputs: [{ path: file, sha256: sha256(original) }], complete: false };
      writeApplicationFile(join(receiptDir, "receipt.json"), receipt);
    }
    need(receipt.v === 1 && receipt.id === receiptDir!.split(/[\\/]/).at(-1) && receipt.inputs[0].sha256 === sha256(original), file, "invalid migration receipt or retained input");
    for (const [target, expected, allowed] of [[bindingsFile, mapping, undefined], [file, registry, original]] as const) {
      const bytes = Buffer.from(JSON.stringify(expected));
      if (existsSync(target)) {
        const current = readFileSync(target);
        if (current.equals(bytes)) continue;
        need(allowed !== undefined && current.equals(allowed), target, "migration destination diverged; preserved unchanged");
      }
      writeApplicationFile(target, expected);
    }
    parseRegistry(readJsonFile(file), file); parseBindings(readJsonFile(bindingsFile), bindingsFile);
    receipt.complete = true; writeApplicationFile(join(receiptDir!, "receipt.json"), receipt);
  } catch (error) {
    if (error instanceof StorageFormatError) throw new StorageMigrationError(error.file, error.reason);
    throw error;
  }
}

export class ApplicationRegistry {
  readonly identities = new Map<string, ProjectIdentity>();
  readonly bindings = new Map<string, ProjectBinding>();
  private readonly problems: StorageDiagnostic[] = [];
  constructor(readonly home?: string, tolerateDamage = false) {
    if (!home) return;
    const read = (operation: () => void): void => {
      try { operation(); } catch (error) {
        if (!tolerateDamage || error instanceof StorageMigrationError || !(error instanceof StorageFormatError) || ![join(home, "projects.json"), join(home, "local", "project-paths.json")].includes(error.file)) throw error;
        if (!this.problems.some((problem) => problem.file === error.file)) this.problems.push({file:error.file, reason:error.reason, blocking:true});
      }
    };
    read(() => migrateApplicationRegistry(home));
    const registry = join(home, "projects.json"); const mapping = join(home, "local", "project-paths.json");
    read(() => { for (const item of existsSync(registry) ? parseRegistry(readJsonFile(registry), registry) : []) this.identities.set(item.id, item); });
    read(() => { for (const item of existsSync(mapping) ? parseBindings(readJsonFile(mapping), mapping) : []) this.bindings.set(item.id, item); });
  }
  assertWritable(): void {
    const problem = this.problems[0];
    if (problem) throw new StorageFormatError(problem.file, problem.reason);
  }
  diagnostics(): StorageDiagnostic[] {
    const reports: StorageDiagnostic[] = [...this.problems]; const paths = new Map<string, Set<string>>();
    for (const binding of this.bindings.values()) {
      if (!this.identities.has(binding.id)) reports.push({ file: "local/project-paths.json", reason: `unregistered project ${binding.id}`, blocking: false });
      for (const p of [binding.path, ...binding.aliases]) { const ids = paths.get(p) ?? new Set<string>(); ids.add(binding.id); paths.set(p, ids); }
    }
    for (const [p, ids] of paths) if (ids.size > 1) reports.push({ file: "local/project-paths.json", reason: `ambiguous project path ${p}`, blocking: false });
    for (const id of this.identities.keys()) if (!this.bindings.has(id)) reports.push({ file: "projects.json", reason: `project ${id} has no local path`, blocking: false });
    return reports;
  }
  project(id: string): ProjectInfo | undefined {
    const identity = this.identities.get(id); const binding = this.bindings.get(id);
    if (!identity || !binding || this.resolvePath(binding.path)?.id !== id) return undefined;
    return { ...identity, path: binding.path };
  }
  resolvePath(p: string): ProjectInfo | undefined {
    const matches = [...this.bindings.values()].filter((b) => b.path === p || b.aliases.includes(p));
    if (matches.length !== 1) return undefined;
    const identity = this.identities.get(matches[0].id);
    return identity ? { ...identity, path: matches[0].path } : undefined;
  }
  register(p: string, name: string, at: number): ProjectInfo {
    this.assertWritable();
    const normalized = resolve(p);
    const existing = this.resolvePath(normalized); if (existing) return existing;
    need(![...this.bindings.values()].some((b) => b.path === normalized || b.aliases.includes(normalized)), "local/project-paths.json", `path ${normalized} needs explicit rebinding`);
    const id = randomUUID(); return this.bind({ id, name, registeredAt: at }, normalized, []);
  }
  bind(identity: ProjectIdentity, p: string, aliases?: string[]): ProjectInfo {
    this.assertWritable();
    parseRegistry({ v: 2, projects: [identity] });
    const prior = this.bindings.get(identity.id);
    const retained = aliases ?? [...(prior?.aliases ?? []), ...(prior && prior.path !== resolve(p) ? [prior.path] : [])];
    const binding = { id: identity.id, path: resolve(p), aliases: [...new Set(retained)].filter((a) => a !== resolve(p)) };
    parseBindings({ v: 1, bindings: [binding] });
    need(![...this.bindings.values()].some((b) => b.id !== identity.id && [b.path, ...b.aliases].some((x) => [binding.path, ...binding.aliases].includes(x))), "local/project-paths.json", "path or alias already belongs to another project");
    this.identities.set(identity.id, identity); this.bindings.set(identity.id, binding); this.save(); return { ...identity, path: binding.path };
  }
  remove(id: string): boolean { this.assertWritable(); const found = this.identities.delete(id); if (found) { this.bindings.delete(id); this.save(); } return found; }
  save(): void {
    if (!this.home) return;
    writeApplicationFile(join(this.home, "local", "project-paths.json"), { v: 1, bindings: [...this.bindings.values()] });
    writeApplicationFile(join(this.home, "projects.json"), { v: 2, projects: [...this.identities.values()] });
  }
}

/** Read-only validation of app files after Git selection. */
export function validateApplicationTree(home: string): {
  projects: ProjectIdentity[];
  bindings: ProjectBinding[];
  intents: Map<string, IntentInfo>;
  removed: Set<string>;
  diagnostics: StorageDiagnostic[];
} {
  const registry = join(home, "projects.json"); const mapping = join(home, "local", "project-paths.json");
  const projects = existsSync(registry) ? parseRegistry(readJsonFile(registry), registry) : [];
  const bindings = existsSync(mapping) ? parseBindings(readJsonFile(mapping), mapping) : [];
  const prefs = join(home, "prefs.json"); if (existsSync(prefs)) parsePrefs(readJsonFile(prefs), prefs);
  const intents = new Map<string, IntentInfo>(); const removed = new Set<string>();
  const intentsDir = join(home, "intents");
  for (const file of existsSync(intentsDir) ? readdirSync(intentsDir) : []) {
    if (!file.endsWith(".jsonl")) continue;
    const full = join(intentsDir, file);
    const folded = foldIntentActs(parseIntentLog(readFileSync(full, "utf8"), file.slice(0, -6), full), full);
    for (const [id, intent] of folded.intents) {
      need(!intents.has(id), full, `duplicate queue ${id}`);
      intents.set(id, intent);
    }
    for (const id of folded.removed) removed.add(id);
  }
  validateIntentRelations(intents, removed);
  const ids = new Set(projects.map((p) => p.id));
  const diagnostics: StorageDiagnostic[] = [];
  for (const binding of bindings) if (!ids.has(binding.id)) diagnostics.push({ file: mapping, reason: `unregistered project ${binding.id}`, blocking: false });
  const paths = new Map<string, Set<string>>();
  for (const binding of bindings) for (const p of [binding.path, ...binding.aliases]) { const found = paths.get(p) ?? new Set<string>(); found.add(binding.id); paths.set(p, found); }
  for (const [p, found] of paths) if (found.size > 1) diagnostics.push({ file: mapping, reason: `ambiguous project path ${p}`, blocking: false });
  for (const id of new Set([...intents.values()].map((i) => i.projectId))) if (!ids.has(id)) diagnostics.push({ file: join(intentsDir, `${id}.jsonl`), reason: `unregistered project ${id}`, blocking: false });
  return { projects, bindings, intents, removed, diagnostics };
}

/** A deterministic single-file conversion with restart-safe retained inputs. */
export function migrateApplicationFile(home: string, source: string, convert: (original: string) => string): void {
  if (!existsSync(source)) return;
  const migrations = join(home, "local", "migrations"); mkdirSync(migrations, { recursive: true, mode: 0o700 });
  let receipt: MigrationReceipt | undefined; let directory: string | undefined;
  for (const id of readdirSync(migrations)) {
    const file = join(migrations, id, "receipt.json"); if (!existsSync(file)) continue;
    const found = readJsonFile(file) as MigrationReceipt;
    if (!found.complete && found.inputs?.[0]?.path === source) { receipt = found; directory = join(migrations, id); break; }
  }
  const original = receipt ? readFileSync(join(directory!, "inputs", "0")) : readFileSync(source);
  const expected = Buffer.from(convert(original.toString("utf8")));
  if (!receipt && expected.equals(original)) return;
  if (!receipt) {
    const id = randomUUID(); directory = join(migrations, id); mkdirSync(join(directory, "inputs"), { recursive: true, mode: 0o700 });
    writeApplicationBytes(join(directory, "inputs", "0"), original);
    receipt = { v: 1, id, inputs: [{ path: source, sha256: sha256(original) }], complete: false };
    writeApplicationFile(join(directory, "receipt.json"), receipt);
  }
  need(receipt.v === 1 && receipt.inputs[0].sha256 === sha256(original), source, "invalid migration receipt or input");
  const current = readFileSync(source);
  need(current.equals(original) || current.equals(expected), source, "migration destination diverged; preserved unchanged");
  if (!current.equals(expected)) writeApplicationBytes(source, expected);
  need(readFileSync(source).equals(expected), source, "migration output verification failed");
  receipt.complete = true; writeApplicationFile(join(directory!, "receipt.json"), receipt);
}
