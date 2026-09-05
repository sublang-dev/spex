// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Playbook compilation via the external slc toolchain (DR-005):
// resolve system Node >= 23.6 and the slc CLI, run the pipeline in a
// managed library directory, then package the TypeScript artifacts
// with esbuild (type stripping + dependency inlining) so the
// registry loads in any Node — including Electron's — and derive the
// registry's state ids by FSM introspection.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/** node_modules dirs up-tree from this package, so bundling artifacts
 * in the external library dir still resolves xstate and friends. */
function bundleNodePaths(): string[] {
  const paths: string[] = [];
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, "node_modules");
    if (existsSync(candidate)) paths.push(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

import { isValidRegistryEntry, REGISTRY_CONTRACT } from "./config.js";

export const MIN_NODE_MAJOR = 23;
export const MIN_NODE_MINOR = 6;

export interface ToolchainStatus {
  node: { ok: boolean; version?: string; command: string; guidance?: string };
  slc: { ok: boolean; command: string[]; guidance?: string };
}

export type LineSpawner = (
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  signal?: AbortSignal,
) => Promise<number>;

export const defaultSpawner: LineSpawner = (command, args, cwd, onLine, signal) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });
    let buffer = "";
    const feed = (chunk: unknown) => {
      // A canceled run goes quiet immediately: the kill-induced tail
      // (partial lines, SIGTERM noise) must not follow the ◇ line.
      if (signal?.aborted) return;
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (signal?.aborted) return;
      if (buffer.trim()) onLine(buffer);
      resolvePromise(code ?? 1);
    });
  });

function nodeSatisfies(version: string): boolean {
  const match = /v?(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

/** Resolve the toolchain (PBLIB-11): env overrides, then PATH, then npx. */
export async function checkToolchain(
  env: NodeJS.ProcessEnv = process.env,
  spawner: LineSpawner = defaultSpawner,
): Promise<ToolchainStatus> {
  const nodeCommand = env.SPEX_NODE ?? "node";
  let nodeVersion = "";
  let nodeOk = false;
  try {
    await spawner(nodeCommand, ["--version"], ".", (line) => {
      nodeVersion = line.trim();
    });
    nodeOk = nodeSatisfies(nodeVersion);
  } catch {
    nodeOk = false;
  }
  const node: ToolchainStatus["node"] = {
    ok: nodeOk,
    command: nodeCommand,
    ...(nodeVersion ? { version: nodeVersion } : {}),
    ...(nodeOk
      ? {}
      : {
          guidance: `Compiling playbooks needs Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} on your system (found ${nodeVersion || "none"}). Install it from nodejs.org or set SPEX_NODE.`,
        }),
  };

  let slc: ToolchainStatus["slc"];
  const configured = env.SPEX_SLC?.split(" ").filter(Boolean);
  if (configured && configured.length > 0) {
    slc = { ok: true, command: configured };
  } else {
    let found = false;
    try {
      await spawner("slc", ["--version"], ".", () => {});
      found = true;
    } catch {
      found = false;
    }
    slc = found
      ? { ok: true, command: ["slc"] }
      : node.ok
        ? {
            ok: true,
            command: [nodeCommand === "node" ? "npx" : nodeCommand, "--yes", "@sublang/slc"],
            guidance:
              "slc is not installed; Spex will run it via npx (downloads on first use). Install @sublang/slc globally to pin it.",
          }
        : {
            ok: false,
            command: [],
            guidance: "Install Node >= 23.6 first; slc runs on it.",
          };
  }
  return { node, slc };
}

export interface CompileOptions {
  playbookId: string;
  /** Prose/skill source: inline text or a file to copy. */
  source: { text?: string; path?: string };
  /** Roles the user expected (informational since DR-014: the
   * compiled entry's derived role ids are authoritative). */
  roles: string[];
  command: string;
  intent: string;
  libraryDir: string;
  /** Primary config path; supplied by the app to return a portable locator. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  spawner?: LineSpawner;
  onProgress?: (line: string) => void;
  /** Skip the slc run when artifacts already exist (re-package). */
  skipSlc?: boolean;
  /** Cancels the run: the slc child is killed and the pipeline
   * rejects with an abort error at the next stage boundary. */
  signal?: AbortSignal;
}

export interface CompileResult {
  /** Absolute path of the bundled registry module (config `from`). */
  from: string;
  /** Derived role ids (lowercased) from the slc-emitted entry. */
  roles: string[];
  idleStateId: string;
  finalStateId: string;
  parkStateIds: string[];
}

interface MachineLike {
  config?: { initial?: unknown; states?: Record<string, { type?: string }> };
}

// --- Machine graph (playbook-library-36, DR-028) ---------------------------

export interface MachineGraphNode {
  id: string;
  parent?: string;
  kind: "state" | "final";
  /** The player role the state invokes, as the machine names it. */
  role?: string;
  /** The state's own description, for human tooltips (DR-010 §2). */
  description?: string;
  tags: string[];
}

export interface MachineGraphEdge {
  /** Stable identity: owner state, event, branch index, target index
   * — guarded sibling branches stay distinct (DR-028). */
  id: string;
  from: string;
  to: string;
  /** Event name; "" names the always transition. */
  event: string;
}

export interface MachineGraph {
  initial: string;
  nodes: MachineGraphNode[];
  edges: MachineGraphEdge[];
}

interface StateConfigLike {
  type?: string;
  id?: unknown;
  initial?: unknown;
  tags?: string | string[];
  meta?: { playbook?: { role?: unknown; player?: unknown; description?: unknown } };
  description?: unknown;
  on?: Record<string, unknown>;
  always?: unknown;
  onDone?: unknown;
  invoke?: unknown;
  states?: Record<string, StateConfigLike>;
}

/** Strip XState target syntax down to a path from the machine root.
 * A `#` target names a declared state id — resolved against the ids
 * the machine actually declares, never assumed to be prefixed with
 * the machine's own id (playbook-library-36). */
function normalizeTarget(
  target: string,
  ownerPath: string[],
  declaredIds: ReadonlyMap<string, string>,
): string | null {
  if (target.startsWith("#")) {
    const address = target.slice(1);
    const direct = declaredIds.get(address);
    if (direct !== undefined) return direct;
    // `#<id>.<child>`: the head names a declared state, the tail
    // descends into it.
    const cut = address.indexOf(".");
    if (cut > 0) {
      const head = declaredIds.get(address.slice(0, cut));
      if (head !== undefined) return `${head}.${address.slice(cut + 1)}`;
      // Legacy form: the head is the machine's own id, and the tail is
      // already a root-relative path.
      return address.slice(cut + 1) || null;
    }
    return null;
  }
  if (target.startsWith(".")) {
    return [...ownerPath, target.slice(1)].join(".");
  }
  // A bare target names a sibling: resolve within the owner's parent.
  return [...ownerPath.slice(0, -1), target].join(".");
}

/** Every state id the machine declares, mapped to its root-relative
 * path. XState gives each state an implicit id of its path, and an
 * explicit `id:` overrides it — both address the same state. */
function collectDeclaredIds(
  states: Record<string, StateConfigLike>,
  parentPath: string[],
  into: Map<string, string>,
): void {
  for (const [name, state] of Object.entries(states)) {
    const path = [...parentPath, name];
    const id = path.join(".");
    if (typeof state.id === "string" && state.id) into.set(state.id, id);
    if (state.states) collectDeclaredIds(state.states, path, into);
  }
}

function transitionBranches(value: unknown): { target?: unknown }[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((branch) =>
    typeof branch === "string" ? { target: branch } : (branch as { target?: unknown }),
  );
}

/** Derive the drawable graph from an imported machine's config — the
 * config is data, so no XState import is needed (DR-028). */
export function extractMachineGraph(machine: MachineLike): MachineGraph | null {
  const config = machine.config as
    | {
        initial?: unknown;
        states?: Record<string, StateConfigLike>;
        on?: Record<string, unknown>;
      }
    | undefined;
  const rootStates = config?.states;
  const initial = typeof config?.initial === "string" ? config.initial : null;
  if (!rootStates || !initial) return null;

  // Targets are resolved against the ids the machine declares, so the
  // id table is built before any edge is read.
  const declaredIds = new Map<string, string>();
  collectDeclaredIds(rootStates, [], declaredIds);

  const nodes: MachineGraphNode[] = [];
  const edges: MachineGraphEdge[] = [];

  const addEdges = (
    ownerPath: string[],
    event: string,
    value: unknown,
  ): void => {
    const owner = ownerPath.join(".");
    const branches = transitionBranches(value);
    branches.forEach((branch, branchIndex) => {
      const targets =
        branch.target === undefined
          ? []
          : Array.isArray(branch.target)
            ? branch.target
            : [branch.target];
      targets.forEach((target, targetIndex) => {
        if (typeof target !== "string") return;
        const to = normalizeTarget(target, ownerPath, declaredIds);
        if (!to) return;
        edges.push({
          id: `${owner}::${event}::${branchIndex}::${targetIndex}`,
          from: owner,
          to,
          event,
        });
      });
    });
  };

  const walk = (
    states: Record<string, StateConfigLike>,
    parentPath: string[],
  ): void => {
    for (const [name, state] of Object.entries(states)) {
      const path = [...parentPath, name];
      const id = path.join(".");
      // Published playbook-7 machines name the invoked player as
      // meta.playbook.player; newer compiles say role. Accept both.
      const meta = state.meta?.playbook;
      const role = meta?.role ?? meta?.player;
      const description = meta?.description ?? state.description;
      nodes.push({
        id,
        ...(parentPath.length > 0 ? { parent: parentPath.join(".") } : {}),
        kind: state.type === "final" ? "final" : "state",
        ...(typeof role === "string" && role ? { role } : {}),
        ...(typeof description === "string" && description
          ? { description }
          : {}),
        tags:
          typeof state.tags === "string"
            ? [state.tags]
            : Array.isArray(state.tags)
              ? state.tags.filter((t): t is string => typeof t === "string")
              : [],
      });
      for (const [event, value] of Object.entries(state.on ?? {})) {
        addEdges(path, event, value);
      }
      if (state.always !== undefined) addEdges(path, "", state.always);
      // A compound or parallel state's own done transition: the join
      // out of its regions, a real state-to-state edge.
      if (state.onDone !== undefined) addEdges(path, "done", state.onDone);
      const invoke = state.invoke;
      const invokes = Array.isArray(invoke) ? invoke : invoke ? [invoke] : [];
      for (const entry of invokes) {
        const shaped = entry as { onDone?: unknown; onError?: unknown };
        if (shaped.onDone !== undefined) addEdges(path, "done", shaped.onDone);
        if (shaped.onError !== undefined) addEdges(path, "error", shaped.onError);
      }
      if (state.states) walk(state.states, path);
    }
  };
  walk(rootStates as Record<string, StateConfigLike>, []);

  // Edges whose target names no known node are dropped rather than
  // drawn dangling.
  const known = new Set(nodes.map((node) => node.id));
  return {
    initial,
    nodes,
    edges: edges.filter((edge) => known.has(edge.from) && known.has(edge.to)),
  };
}

/** Bundle an FSM module and serve its state ids and drawable graph,
 * or nulls on failure (playbook-library-36). */
export async function loadFsmInfo(fsmPath: string): Promise<{
  stateIds: string[] | null;
  machine: MachineGraph | null;
}> {
  try {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const outfile = join(mkdtempSync(join(tmpdir(), "spex-fsm-")), "fsm.mjs");
    await build({
      entryPoints: [fsmPath],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      nodePaths: bundleNodePaths(),
    });
    const machine = await importMachine(outfile);
    return {
      stateIds: Object.keys(machine.config?.states ?? {}),
      machine: extractMachineGraph(machine),
    };
  } catch {
    return { stateIds: null, machine: null };
  }
}

/** Bundle an FSM module and list every state id, or null on failure. */
export async function listFsmStates(
  fsmPath: string,
): Promise<string[] | null> {
  return (await loadFsmInfo(fsmPath)).stateIds;
}

export function deriveStateIds(machine: MachineLike): {
  idleStateId: string;
  finalStateId: string;
  parkStateIds: string[];
} {
  const config = machine.config;
  const states = config?.states ?? {};
  const initial = typeof config?.initial === "string" ? config.initial : undefined;
  if (!initial) throw new Error("FSM has no initial state");
  const finals = Object.entries(states)
    .filter(([, state]) => state?.type === "final")
    .map(([name]) => name);
  if (finals.length === 0) throw new Error("FSM has no final state");
  const finalStateId = finals.includes("done") ? "done" : finals[0];
  const parkStateIds = ["failed", "awaitBossReply"].filter(
    (name) => name in states && name !== finalStateId,
  );
  return { idleStateId: initial, finalStateId, parkStateIds };
}

async function importMachine(bundlePath: string): Promise<MachineLike> {
  const moduleValue = (await import(pathToFileURL(bundlePath).href)) as Record<
    string,
    unknown
  >;
  for (const value of Object.values(moduleValue)) {
    if (
      typeof value === "object" &&
      value !== null &&
      "config" in value &&
      typeof (value as MachineLike).config === "object"
    ) {
      return value as MachineLike;
    }
  }
  throw new Error("no XState machine export found in the compiled FSM");
}

function wrapperSource(options: CompileOptions, entryModulePath: string): string {
  return `// Generated by Spex (DR-014, DR-032): a thin wrapper over the
// slc-emitted registry entry, supplying the command and intent the
// config names. Under artifact schema 2 a role id is a playbook-local
// slot that binds to a session player, not a host player id, so the
// entry's role ids pass through exactly as the gears declared them —
// the lowercasing and re-casing shim of the v7 host boundary is gone.
import entry from ${JSON.stringify(`./${options.playbookId}.ts`)};

export const spexRegistryContract = ${REGISTRY_CONTRACT};

export default {
  ...entry,
  command: ${JSON.stringify(options.command)},
  intent: ${JSON.stringify(options.intent)},
};
`;
}

export async function compilePlaybook(
  options: CompileOptions,
): Promise<CompileResult> {
  const progress = options.onProgress ?? (() => {});
  const spawner = options.spawner ?? defaultSpawner;
  const env = options.env ?? process.env;
  const signal = options.signal;
  const id = options.playbookId;
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
    throw new Error(
      `playbook id "${id}" must match ^[a-z][a-z0-9_-]*$ (it becomes player id prefixes)`,
    );
  }

  const dir = resolve(options.libraryDir, id);
  mkdirSync(dir, { recursive: true });
  const sourcePath = join(dir, `${id}.md`);
  if (options.source.text !== undefined) {
    writeFileSync(sourcePath, options.source.text);
  } else if (options.source.path) {
    copyFileSync(options.source.path, sourcePath);
  } else if (!existsSync(sourcePath)) {
    throw new Error("compile needs a source text or file");
  }

  const artifactDir = join(dir, `${id}.playbook`);
  const fsmPath = join(artifactDir, `${id}.fsm.ts`);
  const playbookPath = join(artifactDir, `${id}.playbook.ts`);
  // slc emits the registry-entry module beside the artifact dir when
  // no -o is given (DR-014); the compile runs with cwd = dir.
  const entryModulePath = join(dir, `${id}.ts`);

  if (!options.skipSlc) {
    const toolchain = await checkToolchain(env, spawner);
    if (!toolchain.node.ok) throw new Error(toolchain.node.guidance);
    if (!toolchain.slc.ok) throw new Error(toolchain.slc.guidance);
    const [slcCommand, ...slcArgs] = toolchain.slc.command;
    progress(`running: ${toolchain.slc.command.join(" ")} playbook ${id}.md`);
    // Bare invocation (DR-019): slc >= 0.2 links against the installed
    // @sublang/playbook runtime contract by default.
    const code = await spawner(
      slcCommand,
      [...slcArgs, "playbook", sourcePath],
      dir,
      progress,
      signal,
    );
    signal?.throwIfAborted();
    if (code !== 0) {
      throw new Error(`slc playbook failed with exit code ${code}`);
    }
  }
  signal?.throwIfAborted();

  if (!existsSync(fsmPath) || !existsSync(playbookPath)) {
    throw new Error(
      `expected artifacts missing: ${fsmPath} / ${playbookPath} — the slc run did not produce the <id>.playbook/ layout`,
    );
  }
  if (!existsSync(entryModulePath)) {
    throw new Error(
      `expected registry entry missing: ${entryModulePath} — slc >= 0.1.0 emits it beside the artifact directory; recompile with the released toolchain`,
    );
  }

  progress("packaging: bundling the FSM for introspection");
  const fsmBundle = join(dir, `${id}.fsm.bundle.mjs`);
  await build({
    entryPoints: [fsmPath],
    outfile: fsmBundle,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    nodePaths: bundleNodePaths(),
  });
  const ids = deriveStateIds(await importMachine(fsmBundle));
  progress(
    `introspected states: idle=${ids.idleStateId} final=${ids.finalStateId} park=[${ids.parkStateIds.join(", ")}]`,
  );

  signal?.throwIfAborted();
  progress("packaging: wrapping and bundling the slc registry entry");
  const registryTs = join(dir, `${id}.registry.ts`);
  writeFileSync(registryTs, wrapperSource(options, entryModulePath));
  const registryBundle = join(dir, `${id}.registry.mjs`);
  await build({
    entryPoints: [registryTs],
    outfile: registryBundle,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    nodePaths: bundleNodePaths(),
  });

  // Fail-closed validation before anything touches the config
  // (PBLIB-14): the bundle must satisfy the captain shell's checks.
  const moduleValue = (await import(pathToFileURL(registryBundle).href)) as {
    default?: unknown;
    spexRegistryContract?: unknown;
  };
  const entry = moduleValue.default;
  if (!isValidRegistryEntry(entry)) {
    throw new Error("generated registry failed structural validation");
  }
  if (entry.id !== id) {
    throw new Error(
      `generated registry id mismatch: slc derived "${entry.id}" from the source, expected "${id}"`,
    );
  }
  if (moduleValue.spexRegistryContract !== REGISTRY_CONTRACT) {
    throw new Error("generated registry is missing the contract marker");
  }
  entry.validateOptions(undefined);
  const roles = [...entry.requiredRoleIds];
  if (roles.length === 0) {
    // Entries compiled before slc 0.2 can carry no roles when the
    // gears rendered Players as a heading (fixed upstream).
    throw new Error(
      "the compiled entry declares no player roles; recompile with slc >= 0.2 (its gears Players parsing fix)",
    );
  }
  const seen = new Set<string>();
  for (const role of roles) {
    // A role is a config key a user binds to a player, so it must be
    // writable and distinct; it is no longer a host player id and
    // carries no case folding (DR-032).
    if (seen.has(role)) {
      throw new Error(`derived role ids collide: "${role}" appears twice`);
    }
    seen.add(role);
  }
  progress(`derived roles: ${roles.join(", ")}`);

  signal?.throwIfAborted();
  progress("compile complete");
  const locator = options.configPath ? relative(dirname(options.configPath), registryBundle).split("\\").join("/") : registryBundle;
  const from = options.configPath && !locator.startsWith(".") ? `./${locator}` : locator;
  return { from, roles, ...ids };
}

/** Rebuild bundles from retained compiler outputs without invoking an agent. */
export async function rebuildManagedRegistry(libraryDir: string, id: string): Promise<void> {
  const directory = resolve(libraryDir, id);
  if (existsSync(join(directory, `${id}.registry.mjs`))) return;
  const source = join(directory, `${id}.md`); const entry = join(directory, `${id}.ts`);
  const wrapper = join(directory, `${id}.registry.ts`);
  if (!existsSync(source) || !existsSync(entry) || !existsSync(wrapper)) throw new Error(`playbook ${id} is unavailable: retained source or compiler output is missing; compile it in Playbooks`);
  const temporary = mkdtempSync(join(tmpdir(), "spex-library-rebuild-"));
  try {
    const bundled = join(temporary, "entry.mjs");
    await build({ entryPoints: [wrapper], outfile: bundled, bundle: true, format: "esm", platform: "node", logLevel: "silent", nodePaths: bundleNodePaths() });
    const module = await import(pathToFileURL(bundled).href);
    if (!isValidRegistryEntry(module.default) || module.default.id !== id) throw new Error(`retained registry ${id} is invalid`);
    await compilePlaybook({ playbookId: id, source: {}, roles: [...module.default.requiredRoleIds], command: module.default.command, intent: module.default.intent, libraryDir, skipSlc: true });
  } catch (error) {
    throw new Error(`playbook ${id} is unavailable: rebuilding failed: ${(error as Error).message}`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
