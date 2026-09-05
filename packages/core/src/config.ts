// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Shared playbook config: location, seeding, validation, and
// composition into runtime options. Validation and composition keep
// behavioral parity with the playbook launcher (DR-004, CORE-16): any
// config the launcher accepts or rejects is treated identically here,
// with the same error messages wherever the rule exists upstream.

import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  AGENT_RUNTIME_TARGETS,
  classifyRuntime,
  describeRuntimeReadiness,
  isEffortSupported,
  readRuntimeVersion,
  supportedEffortValues,
  type RuntimeReadiness,
} from "@sublang/cligent";
import { KNOWN_PLAYER_ADAPTERS } from "@sublang/cligent/tmux-play";
import { SUPPORTED_ARTIFACT_SCHEMAS } from "@sublang/playbook/xstate-runtime";
import { migrateConfigFileIfRetired } from "./config-migrate.js";

import type {
  AdapterName,
  AgentSummary,
  ConfigSummary,
} from "./protocol.js";

export const PLAYBOOK_CAPTAIN_MODULE = "@sublang/playbook/playbook-captain";

/** Marker export stamped into Spex-generated registry bundles
 * (DR-014); composition refuses file-path registries without it. */
export const REGISTRY_CONTRACT = 3;

/** The artifact formats a registry manifest may advertise, read from
 * the installed playbook rather than restated here: the shared runtime
 * factory refuses a manifest that disagrees with the module it loads,
 * so Spex checks it at generation time rather than letting a session
 * fail at construction (DR-032), and a playbook release that moves the
 * schema moves this check with it. */
export const ARTIFACT_SCHEMAS: readonly number[] = SUPPORTED_ARTIFACT_SCHEMAS;

// The adapter set is the embedded runtime's own (DR-019): an id
// outside it cannot start a session, so composition rejects it with
// the runtime's wording. Scalars are adapter shorthands normalizing
// to bare-adapter blocks; Spex itself writes only inline blocks.
const KNOWN_ADAPTERS = KNOWN_PLAYER_ADAPTERS;
const PLAYBOOK_LAUNCHER_KEYS = ["from", "command", "roles"];
/** A session player id: segmented, dots by convention only. */
const PLAYER_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const RESERVED_CAPTAIN_ROLE_ID = "captain";

const AGENT_FIELDS = new Set([
  "adapter",
  "model",
  "instruction",
  "permissions",
  "effort",
  // Adapter-scoped fast mode (cligent 0.24). Spex accepts and preserves it
  // so a config the launcher accepts is never rejected here
  // (shared-config-roundtrip-1); cligent owns which adapters allow it.
  "fastMode",
  // Read-only legacy alias for `effort` (cligent 0.14 rename, DR-014);
  // composition normalizes it and Spex never writes it back.
  "reasoningEffort",
]);
const PERMISSION_FIELDS = new Set([
  "mode",
  "fileWrite",
  "shellExecute",
  "networkAccess",
  "writablePaths",
]);


export interface PermissionPolicyLike {
  mode?: "auto" | "bypass";
  fileWrite?: "allow" | "ask" | "deny";
  shellExecute?: "allow" | "ask" | "deny";
  networkAccess?: "allow" | "ask" | "deny";
  writablePaths?: string[];
}

export interface ResolvedAgent {
  adapter: AdapterName;
  model?: string;
  instruction?: string;
  permissions?: PermissionPolicyLike;
  /** Adapter-scoped vocabulary; validated during composition. */
  effort?: string;
  /** Adapter-scoped fast mode; `false` is a literal request, not omission. */
  fastMode?: boolean;
}

export interface ComposedPlayer extends ResolvedAgent {
  id: string;
}

/** A role's binding: which session player answers it, and that role's
 * own tuning. `false` selects the provider's current default;
 * undefined inherits the player's own (DR-032). */
/** A tuning choice the shell takes explicitly: a pinned value, or the
 * provider's current default. Omission is not representable here —
 * inheritance is resolved before the call (playbook DR-032 §4). */
export type TuningSelection =
  | { kind: "value"; value: string }
  | { kind: "provider-default" };

/** An agent envelope as the Captain shell's options carry it: the
 * identity-bearing fields plus a complete tuning selection. */
export interface SessionAgentBlock {
  adapter: string;
  model: TuningSelection;
  effort: TuningSelection;
  /** Adapter-scoped fast mode, forwarded so the setting takes effect
   * (playbook 11: `false` is a literal disabled request). */
  fastMode?: boolean;
  instruction?: string;
  permissions?: unknown;
}

const providerDefault: TuningSelection = { kind: "provider-default" };
const tuningOf = (value: string | undefined): TuningSelection =>
  value === undefined ? providerDefault : { kind: "value", value };

export interface ResolvedBinding {
  playerId: string;
  model?: string | false;
  effort?: string | false;
  fastMode?: boolean;
}

/** The binding as the shell takes it: the lane, plus this role's
 * complete tuning with inheritance already resolved. */
export interface HostRoleBinding {
  playerId: string;
  model: TuningSelection;
  effort: TuningSelection;
  /** A role's own fast-mode override; absent inherits the player's. */
  fastMode?: boolean;
}

export interface ComposedPlaybook {
  id: string;
  /** Command declared by the registry before the config override. */
  manifestCommand: string;
  command: string;
  intent: string;
  requiredRoleIds: readonly string[];
  /** Role groups the manifest may run at once; empty when it declares none. */
  concurrentRoleSets: readonly (readonly string[])[];
  /** The artifact format the manifest advertises [[ARTIFACT_SCHEMAS]]. */
  artifactSchema: number;
  from: string;
  /** local role -> its binding (DR-032). */
  roles: Record<string, ResolvedBinding>;
  /** True when the entry takes a `cwd` option the config leaves
   * unset, so sessions may inject the project path (DR-014). */
  acceptsCwdOption: boolean;
}

export interface ComposedConfig {
  captainAgent: ResolvedAgent;
  /** The options object handed to createPlaybookCaptainShell. */
  captainOptions: {
    playbooks: Record<
      string,
      {
        from: string;
        command?: string;
        roles: Record<string, HostRoleBinding>;
        options: Record<string, unknown>;
      }
    >;
    /** The session's agent envelopes, as the shell takes them. */
    sessionAgents: {
      captain: SessionAgentBlock;
      players: Record<string, SessionAgentBlock>;
    };
    /** The Captain's adapter, so the shell picks provider-level vs
     * prompt-level control-call tool restriction (DR-019). */
    captainAdapter: string;
  };
  /** Flat roster of namespaced `<id>-<role>` players, in config order. */
  players: ComposedPlayer[];
  initialVisible: string[];
  playbooks: ComposedPlaybook[];
  notifications?: unknown;
  theme?: unknown;
  layout?: Record<string, unknown>;
}

export type LoadModule = (specifier: string) => Promise<unknown>;

/**
 * Resolve a registry specifier to its file path, honoring the same
 * SPEX_MODULE_PATHS fallback as createModuleLoader. Absolute paths
 * and file URLs pass through; bare specifiers resolve from Spex's
 * dependencies first, then from configured checkouts.
 */
export function isFileModule(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("~/") || specifier.startsWith("file:") || /^[A-Za-z]:[\\/]/.test(specifier);
}

/** File locators use the primary config's directory in both hosts. */
export function resolveConfigModule(specifier: string, configPath: string, home = homedir()): string {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (specifier.startsWith("~/")) return resolve(home, specifier.slice(2));
  return isFileModule(specifier) ? resolve(dirname(configPath), specifier) : specifier;
}

export function resolveModulePath(
  specifier: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier)) {
    return specifier;
  }
  const dirs = [
    dirname(fileURLToPath(import.meta.url)),
    ...(env.SPEX_MODULE_PATHS ?? "")
      .split(":")
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];
  for (const dir of dirs) {
    try {
      const requireFrom = createRequire(join(dir, "__spex_resolve__.js"));
      return requireFrom.resolve(specifier);
    } catch {
      // Try the next base.
    }
  }
  return undefined;
}

/**
 * Module loader with local-checkout fallback: when a bare specifier
 * fails to resolve from Spex's own dependencies (e.g. a registry
 * subpath that exists only in an unpublished build), try resolving
 * from each directory in SPEX_MODULE_PATHS (colon-separated package
 * checkouts; package self-reference resolves their exports).
 */
export function createModuleLoader(
  env: NodeJS.ProcessEnv = process.env,
): LoadModule {
  const extraDirs = (env.SPEX_MODULE_PATHS ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return async (specifier: string): Promise<unknown> => {
    try {
      // A compiled registry names its bundle by absolute path; the
      // ESM loader takes a path only as a file URL on Windows.
      return await import(
        isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier,
      );
    } catch (error) {
      for (const dir of extraDirs) {
        try {
          const requireFrom = createRequire(join(dir, "__spex_resolve__.js"));
          const resolved = requireFrom.resolve(specifier);
          return await import(pathToFileURL(resolved).href);
        } catch {
          // Try the next configured checkout.
        }
      }
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// Paths and seeding
// ---------------------------------------------------------------------------

/**
 * The shared config lives under this app's own root, resolved exactly as the
 * shells resolve it, so Spex and the launcher open one file. The singular
 * `playbook/` namespace holds it; the plural `playbooks/` library is ours.
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME ?? homedir(),
): string {
  const explicit = env.SPEX_HOME;
  const root =
    explicit !== undefined && explicit.trim().length > 0
      ? explicit
      : join(home, ".spex");
  return join(root, "playbook", "playbook.config.yaml");
}

/**
 * The shared session store's directory: where the playbook CLI keeps
 * its sessions, so a session run in a terminal is one Spex serves
 * (core-service-60). The optional top-level `sessions` key names it
 * for both hosts, resolved as the launcher resolves it — `~` expanded,
 * an absolute path taken as given, anything else relative to the
 * config's own directory — and defaulting to the launcher's own XDG
 * Spex home when the key is absent.
 */
export function resolveSessionsDir(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME ?? homedir(),
): string {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(configPath, "utf8"));
  } catch {
    // A missing or unparsable config names no directory; the default
    // still holds, and config validity is reported elsewhere.
    raw = undefined;
  }
  const configured = isPlainObject(raw) ? raw.sessions : undefined;
  if (typeof configured === "string" && configured.trim().length > 0) {
    const value = configured.trim();
    if (value === "~" || value.startsWith("~/")) {
      return join(home, value.slice(1));
    }
    // `~user` is another user's home, which this host never resolves.
    if (!value.startsWith("~")) {
      return isAbsolute(value) ? value : join(dirname(configPath), value);
    }
  }
  const spexHome = env.SPEX_HOME?.trim() ? env.SPEX_HOME : join(home, ".spex");
  return join(spexHome, "sessions");
}

/**
 * The installed playbook package's root: an exported entry resolves to
 * `<root>/src/<file>.js`, and the files the package ships beside its
 * exports — the starter template, the CLI's own modules — sit under it.
 */
export function playbookPackageRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const entry = resolveModulePath("@sublang/playbook/runtime", env);
  if (!entry) throw new Error("@sublang/playbook is not installed");
  return dirname(dirname(entry));
}

/**
 * The starter config is the playbook CLI's own (core-service-3): seeding
 * from the installed package's template keeps both hosts' first-run
 * config identical by construction, with nothing to keep in sync.
 */
export function templatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    playbookPackageRoot(env),
    "reference",
    "sdlc",
    "code.playbook",
    "playbook.config.template.yaml",
  );
}

/** The pre-DR-036 shared config location, kept only to relocate a
 * config written there (the launcher's `resolveLegacyUserConfigPath`). */
export function resolveLegacyConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME ?? homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "playbook", "playbook.config.yaml");
}

/**
 * Relocate a config the previous location holds into the canonical one,
 * once, exactly as the launcher does (playbook DR-043): only when the
 * canonical path is absent, preserving bytes and permission bits, and
 * publishing with an exclusive link so a canonical file that appears
 * concurrently wins. The legacy file stays in place untouched.
 * Returns true when a relocation was published.
 */
export function relocateLegacyConfig(
  configPath: string,
  legacyPath: string,
): boolean {
  if (existsSync(configPath) || legacyPath === configPath) return false;
  let source: ReturnType<typeof lstatSync>;
  try {
    source = lstatSync(legacyPath);
  } catch {
    return false;
  }
  if (!source.isFile()) return false;
  // A relative locator resolves against the config's own directory, so
  // moving the file would retarget it; the launcher refuses too.
  const text = readFileSync(legacyPath, "utf8");
  if (/^sessions:\s*(?!["']?(?:\/|~))/m.test(text)) {
    console.error(
      `spex: legacy config ${legacyPath} names a relative sessions directory; ` +
        `move it to ${configPath} by hand`,
    );
    return false;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const staging = mkdtempSync(join(dirname(configPath), ".spex-config-relocation-"));
  const staged = join(staging, "playbook.config.yaml");
  try {
    copyFileSync(legacyPath, staged, constants.COPYFILE_EXCL);
    chmodSync(staged, source.mode & 0o7777);
    try {
      linkSync(staged, configPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Seed the shared config from the bundled starter when absent.
 * Returns true when a file was created; never overwrites (CORE-3).
 */
export function seedConfig(path: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(templatePath(), path, constants.COPYFILE_EXCL);
  return true;
}

// ---------------------------------------------------------------------------
// Agent resolution (launcher parity: resolveAgent)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function validateAgentBlock(
  block: Record<string, unknown>,
  path: string,
): void {
  for (const key of Object.keys(block)) {
    if (!AGENT_FIELDS.has(key)) {
      throw new Error(`Unknown config field ${path}.${key}`);
    }
  }
  if (block.permissions !== undefined) {
    if (!isPlainObject(block.permissions)) {
      throw new Error(`${path}.permissions must be an object`);
    }
    const permissions = block.permissions;
    for (const key of Object.keys(permissions)) {
      if (!PERMISSION_FIELDS.has(key)) {
        throw new Error(`Unknown config field ${path}.permissions.${key}`);
      }
    }
    if (
      permissions.mode !== undefined &&
      permissions.mode !== "auto" &&
      permissions.mode !== "bypass"
    ) {
      throw new Error(`${path}.permissions.mode must be auto or bypass`);
    }
    for (const policy of ["fileWrite", "shellExecute", "networkAccess"]) {
      const value = permissions[policy];
      if (value !== undefined && !["allow", "ask", "deny"].includes(String(value))) {
        throw new Error(
          `${path}.permissions.${policy} must be allow, ask, or deny`,
        );
      }
    }
    if (
      permissions.writablePaths !== undefined &&
      (!Array.isArray(permissions.writablePaths) ||
        permissions.writablePaths.some((p) => typeof p !== "string"))
    ) {
      throw new Error(`${path}.permissions.writablePaths must be a string list`);
    }
  }
  if (block.effort !== undefined && block.reasoningEffort !== undefined) {
    throw new Error(
      `${path} must not set both effort and its legacy alias reasoningEffort`,
    );
  }
  // Effort values are validated adapter-scoped in toResolvedAgent,
  // once the adapter is known (DR-019).
}

/**
 * True when a config reference string acts as an adapter shorthand
 * (launcher parity: a scalar agent value is an adapter shorthand,
 * accepted only for the embedded runtime's adapters).
 */
export function isKnownAdapter(value: string): value is AdapterName {
  return (KNOWN_ADAPTERS as readonly string[]).includes(value);
}

export function resolveAgent(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value === "string") {
    // A scalar is an adapter shorthand, normalizing to a bare-adapter
    // block (the launcher reads it the same way).
    return { adapter: value };
  }
  if (isPlainObject(value)) {
    if ("profile" in value) {
      // Retired with the profiles model (playbook 3.0); the load path
      // migrates old files, so a survivor here is a hand-typed edit.
      throw new Error(
        `${path}.profile is retired: agents carry their own adapter, model, effort, and permissions`,
      );
    }
    return { ...value };
  }
  throw new Error(
    `${path} must be an adapter shorthand or an agent block`,
  );
}

function toResolvedAgent(
  block: Record<string, unknown>,
  path: string,
): ResolvedAgent {
  validateAgentBlock(block, path);
  const adapter = block.adapter;
  if (typeof adapter !== "string" || adapter.length === 0) {
    throw new Error(`${path} must resolve an adapter`);
  }
  if (!(KNOWN_ADAPTERS as readonly string[]).includes(adapter)) {
    throw new Error(
      `Unknown adapter "${adapter}" for ${path}. Valid adapters: ${KNOWN_ADAPTERS.join(", ")}`,
    );
  }
  const { reasoningEffort, ...rest } = block;
  if (reasoningEffort !== undefined) rest.effort = reasoningEffort;
  if (rest.effort !== undefined) {
    // Adapter-scoped vocabularies (DR-019): Claude adds ultracode,
    // Codex adds ultra, Kimi accepts only off/on. cligent owns the
    // sets; a value it refuses would otherwise fail mid-turn.
    const effort = String(rest.effort);
    if (!isEffortSupported(adapter as never, effort as never)) {
      const values = (supportedEffortValues(adapter as never) ?? []).join(
        ", ",
      );
      throw new Error(
        `${path}.effort "${effort}" is not supported by the "${adapter}" adapter (valid: ${values})`,
      );
    }
  }
  if (rest.fastMode !== undefined && typeof rest.fastMode !== "boolean") {
    throw new Error(`${path}.fastMode must be a boolean`);
  }
  return rest as unknown as ResolvedAgent;
}

// ---------------------------------------------------------------------------
// Registry entry structural check (parity with shell/launcher)
// ---------------------------------------------------------------------------

// The load contract mirrors the Playbook Captain shell's own
// `isValidRegistryEntry` (playbook-captain: PlaybookCaptainRegistryEntry):
// id, command, intent, requiredRoleIds, validateOptions, createRuntime,
// with an optional summaryPolicy. State ids (idle/final/park) are NOT part
// of the shell's load contract — the shell derives park/idle/final from
// runtime state tags (`playbook.parked`, quiescence), not per-entry fields.
// Requiring them here rejected the real `@sublang/playbook/code/registry`
// entry, which carries none. Spex's own compiler still derives state ids for
// its introspection preview (PBLIB-13), but they are optional metadata, not a
// gate.
export interface RegistryEntryLike {
  id: string;
  command: string;
  intent: string;
  /** The artifact format this manifest advertises [[ARTIFACT_SCHEMAS]]. */
  artifactSchema: number;
  requiredRoleIds: readonly string[];
  /** Role groups the manifest may run at once (v8): each must bind to
   * pairwise-distinct players. Absent on older entries. */
  concurrentRoleSets?: readonly (readonly string[])[];
  validateOptions(captainOptions: unknown): unknown;
  createRuntime(options: unknown): unknown;
}

export function isValidRegistryEntry(
  value: unknown,
): value is RegistryEntryLike {
  if (!isPlainObject(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.command === "string" &&
    typeof entry.intent === "string" &&
    // A manifest that advertises no schema, or a different one, cannot
    // construct its runtime — the factory refuses it — so it is not a
    // valid entry here either (DR-032).
    typeof entry.artifactSchema === "number" &&
    ARTIFACT_SCHEMAS.includes(entry.artifactSchema) &&
    Array.isArray(entry.requiredRoleIds) &&
    typeof entry.validateOptions === "function" &&
    typeof entry.createRuntime === "function"
  );
}

// ---------------------------------------------------------------------------
// Composition (launcher parity: composeGenericConfig)
// ---------------------------------------------------------------------------

/** A role binding: a bare player id, or a block naming `player` with
 * optional model/effort overrides. Adapter, permissions, instruction
 * and workspace belong to the player and are refused here (DR-032). */
function resolveBinding(value: unknown, path: string): ResolvedBinding {
  if (typeof value === "string") {
    if (!PLAYER_ID_PATTERN.test(value)) {
      throw new Error(`${path} is not a canonical player id`);
    }
    return { playerId: value };
  }
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be a player id or a binding block`);
  }
  const allowed = new Set(["player", "model", "effort", "fastMode"]);
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    throw new Error(
      `${path}.${key} is not a role binding key: adapter, permissions, instruction and workspace belong to the session player`,
    );
  }
  const playerId = value.player;
  if (typeof playerId !== "string" || !PLAYER_ID_PATTERN.test(playerId)) {
    throw new Error(`${path}.player must name a canonical player id`);
  }
  const tuning = (key: "model" | "effort"): string | false | undefined => {
    const raw = value[key];
    if (raw === undefined) return undefined;
    // `false` is a positive choice — the provider's current default —
    // distinct from omission, which inherits the player's.
    if (raw === false) return false;
    if (typeof raw === "string" && raw.length > 0) return raw;
    throw new Error(
      `${path}.${key} must be a string or false (the provider default)`,
    );
  };
  const fastMode = value.fastMode;
  if (fastMode !== undefined && typeof fastMode !== "boolean") {
    // Unlike model and effort, fast mode carries no provider-default
    // sentinel: omission inherits the player's, `false` is a literal request.
    throw new Error(`${path}.fastMode must be a boolean`);
  }
  return {
    playerId,
    ...(tuning("model") !== undefined ? { model: tuning("model") } : {}),
    ...(tuning("effort") !== undefined ? { effort: tuning("effort") } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
}

function sessionAgentOf(agent: ResolvedAgent): SessionAgentBlock {
  return {
    adapter: agent.adapter,
    // Both selections travel on every call: an omitted pin means the
    // provider's default, never "whatever the last role left behind".
    model: tuningOf(agent.model),
    effort: tuningOf(agent.effort),
    ...(agent.fastMode !== undefined ? { fastMode: agent.fastMode } : {}),
    ...(agent.instruction !== undefined
      ? { instruction: agent.instruction }
      : {}),
    ...(agent.permissions !== undefined
      ? { permissions: agent.permissions }
      : {}),
  };
}

export async function composeConfig(
  top: unknown,
  loadModule: LoadModule = (specifier) => import(isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier),
  configPath?: string,
): Promise<ComposedConfig> {
  if (!isPlainObject(top)) {
    throw new Error("config must be a YAML mapping");
  }

  if (top.profiles !== undefined) {
    // The load path migrates profiles-era files (DR-019); a map
    // arriving here came through an edit or a raw compose.
    throw new Error(
      "profiles is retired (playbook 3.0): agents carry their settings inline",
    );
  }

  if (!isPlainObject(top.playbooks)) {
    throw new Error("playbooks must be an object");
  }
  const playbookBlocks = top.playbooks;
  if (Object.keys(playbookBlocks).length === 0) {
    throw new Error("playbooks must enable at least one playbook");
  }

  const captainBlock = resolveAgent(top.captain, "captain");
  if (
    typeof captainBlock.adapter !== "string" ||
    captainBlock.adapter.length === 0
  ) {
    throw new Error("captain must resolve an adapter");
  }
  const captainAgent = toResolvedAgent(captainBlock, "captain");

  // The Captain shell restricts control-call tools per the captain's
  // adapter (playbook 3.0, DR-019): without this field it fail-closes
  // to an empty allowlist, which the Codex adapter rejects outright.
  const captainOptions: ComposedConfig["captainOptions"] = {
    playbooks: {},
    // v8 takes the session's agents as one block: the Captain's
    // envelope and every referenced player's (DR-032). Filled after
    // the bindings below decide which players the session references.
    sessionAgents: { captain: sessionAgentOf(captainAgent), players: {} },
    captainAdapter: captainAgent.adapter,
  };
  // The flat session roster: identity-bearing lanes, resolved before
  // any binding can name one (DR-032).
  const sessionPlayers = new Map<string, ResolvedAgent>();
  if (top.players !== undefined) {
    if (!isPlainObject(top.players)) {
      throw new Error("players must be an object");
    }
    for (const [playerId, value] of Object.entries(top.players)) {
      const path = `players.${playerId}`;
      if (!PLAYER_ID_PATTERN.test(playerId)) {
        throw new Error(
          `${path} is not a canonical player id (lowercase segments, dots optional)`,
        );
      }
      if (playerId === RESERVED_CAPTAIN_ROLE_ID) {
        throw new Error(
          `players.captain is reserved for the session Captain, which is configured at the top level`,
        );
      }
      const resolved = resolveAgent(value, path);
      if (
        typeof resolved.adapter !== "string" ||
        resolved.adapter.length === 0
      ) {
        throw new Error(`${path} must resolve an adapter`);
      }
      sessionPlayers.set(playerId, toResolvedAgent(resolved, path));
    }
  }
  // Only a referenced player enters the roster and the readiness gate;
  // an unused entry is legal and inert (DR-032).
  const referenced = new Set<string>();

  const players: ComposedPlayer[] = [];
  const playbooks: ComposedPlaybook[] = [];
  const seenIds = new Set<string>();
  const seenCommands = new Set<string>();
  let initialVisible: string[] = [];

  for (const [id, blockValue] of Object.entries(playbookBlocks)) {
    if (!isPlainObject(blockValue)) {
      throw new Error(`playbooks.${id} must be an object`);
    }
    const block = blockValue;
    const configuredFrom = block.from;
    if (typeof configuredFrom !== "string" || configuredFrom.length === 0) {
      throw new Error(`playbooks.${id}.from must be a module specifier`);
    }

    const from = configPath ? resolveConfigModule(configuredFrom, configPath) : configuredFrom;
    let moduleValue: unknown;
    try {
      moduleValue = await loadModule(from);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `playbooks.${id}.from "${from}" failed to import: ${message}`,
      );
    }
    const entry = (moduleValue as { default?: unknown } | undefined)?.default;
    if (!isValidRegistryEntry(entry)) {
      throw new Error(
        `playbooks.${id}.from "${from}" exposes no valid registry entry`,
      );
    }
    // File-path registries are Spex-generated bundles; one without the
    // DR-014 contract marker predates the playbook 2.0 runtime and
    // would fail mid-turn — refuse it at load with recompile guidance.
    // Package-specifier registries ship with their runtime and are
    // exempt.
    if (
      isAbsolute(from) &&
      (moduleValue as { spexRegistryContract?: unknown }).spexRegistryContract !==
        REGISTRY_CONTRACT
    ) {
      throw new Error(
        `playbooks.${id}.from "${from}" was generated by an older Spex toolchain; recompile "${id}" in the Playbooks surface to re-enable it`,
      );
    }
    if (entry.id !== id) {
      throw new Error(
        `playbooks.${id} key must equal the module manifest id "${entry.id}"`,
      );
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`duplicate playbook id "${entry.id}"`);
    }
    seenIds.add(entry.id);

    const commandOverride =
      typeof block.command === "string" && block.command.length > 0
        ? block.command
        : undefined;
    const command = commandOverride ?? entry.command;
    if (seenCommands.has(command)) {
      throw new Error(`duplicate effective command "${command}"`);
    }
    seenCommands.add(command);

    if (entry.requiredRoleIds.includes(RESERVED_CAPTAIN_ROLE_ID)) {
      throw new Error(
        `playbooks.${id} requires local role "captain", which is reserved for the tmux-play Captain`,
      );
    }

    // v8 binds roles to session players (DR-032); a surviving
    // per-playbook players block is the removed shape and rejects with
    // the launcher's own wording rather than a paraphrase.
    if (block.players !== undefined) {
      throw new Error(
        `playbooks.${id}.players was removed in the explicit-session-player major release: ` +
          "define stable ids in top-level players and bind them explicitly under " +
          "playbooks.<id>.roles; automatic migration would choose which prior " +
          "conversations share a session",
      );
    }
    if (!isPlainObject(block.roles)) {
      throw new Error(`playbooks.${id}.roles must be an object`);
    }
    const roleBlocks = block.roles;
    if (RESERVED_CAPTAIN_ROLE_ID in roleBlocks) {
      throw new Error(
        `playbooks.${id}.roles.captain binds local role "captain", which is reserved for the tmux-play Captain`,
      );
    }
    // Bindings cover requiredRoleIds exactly: a missing role has no
    // agent and an extra one names work the manifest never declares.
    const bound = Object.keys(roleBlocks);
    const required = new Set(entry.requiredRoleIds);
    const missing = entry.requiredRoleIds.filter((role) => !(role in roleBlocks));
    const extra = bound.filter((role) => !required.has(role));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `playbooks.${id}.roles must exactly cover requiredRoleIds` +
          (missing.length > 0 ? `; missing ${missing.join(", ")}` : "") +
          (extra.length > 0 ? `; unknown ${extra.join(", ")}` : ""),
      );
    }

    const roleBindings: Record<string, ResolvedBinding> = {};
    const hostBindings: Record<string, HostRoleBinding> = {};
    for (const role of entry.requiredRoleIds) {
      const path = `playbooks.${id}.roles.${role}`;
      const binding = resolveBinding(roleBlocks[role], path);
      if (!sessionPlayers.has(binding.playerId)) {
        throw new Error(
          `${path} names absent session player "${binding.playerId}"`,
        );
      }
      roleBindings[role] = binding;
      // Inheritance resolves here, once: omitted takes the player's
      // default, `false` takes the provider's, a string pins. The
      // shell is told the outcome, never asked to infer it.
      const player = sessionPlayers.get(binding.playerId) as ResolvedAgent;
      const select = (
        override: string | false | undefined,
        fallback: string | undefined,
      ): TuningSelection =>
        override === false
          ? providerDefault
          : tuningOf(override ?? fallback);
      hostBindings[role] = {
        playerId: binding.playerId,
        model: select(binding.model, player.model),
        effort: select(binding.effort, player.effort),
        ...(binding.fastMode !== undefined ? { fastMode: binding.fastMode } : {}),
      };
      if (!referenced.has(binding.playerId)) {
        referenced.add(binding.playerId);
        // Roster order follows first reference, so panes appear in the
        // order the enabled playbooks introduce them.
        players.push({ id: binding.playerId, ...player });
        captainOptions.sessionAgents.players[binding.playerId] =
          sessionAgentOf(player);
      }
    }
    // Roles a manifest may run at once must be distinct lanes: one
    // player cannot hold two simultaneous calls (playbook DR-032 §3).
    for (const set of entry.concurrentRoleSets ?? []) {
      const ids = set.map((role: string) => roleBindings[role]?.playerId);
      const distinct = new Set(
        ids.filter((value: string | undefined) => value !== undefined),
      );
      if (distinct.size < ids.length) {
        throw new Error(
          `playbooks.${id} runs roles ${set.join(", ")} concurrently, so they must bind to distinct players`,
        );
      }
    }

    const optionSlice: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block)) {
      if (!PLAYBOOK_LAUNCHER_KEYS.includes(key)) optionSlice[key] = value;
    }
    // Probe whether the entry accepts a `cwd` option (DR-014): script
    // gears default to the host process cwd, so sessions inject the
    // project path for entries that take it and configs that leave it
    // unset. validateOptions is fail-closed, making the probe safe.
    let acceptsCwdOption = false;
    if (optionSlice.cwd === undefined) {
      try {
        entry.validateOptions({ ...optionSlice, cwd: "/" });
        acceptsCwdOption = true;
      } catch {
        acceptsCwdOption = false;
      }
    }
    captainOptions.playbooks[id] = {
      from,
      ...(commandOverride ? { command: commandOverride } : {}),
      roles: hostBindings,
      options: optionSlice,
    };

    playbooks.push({
      id: entry.id,
      manifestCommand: entry.command,
      command,
      intent: entry.intent,
      requiredRoleIds: entry.requiredRoleIds,
      concurrentRoleSets: entry.concurrentRoleSets ?? [],
      artifactSchema: entry.artifactSchema,
      from,
      roles: roleBindings,
      acceptsCwdOption,
    });
  }

  // Every referenced player is visible by default, in roster order;
  // a roleless catalog is a legal session with no player panes.
  initialVisible = players.map((player) => player.id);

  return {
    captainAgent,
    captainOptions,
    players,
    initialVisible,
    playbooks,
    ...(top.notifications !== undefined
      ? { notifications: top.notifications }
      : {}),
    ...(top.theme !== undefined ? { theme: top.theme } : {}),
    ...(isPlainObject(top.layout) ? { layout: top.layout } : {}),
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadedConfig {
  path: string;
  raw: unknown;
  composed: ComposedConfig;
}

export async function loadConfig(
  path: string,
  loadModule?: LoadModule,
  options: { libraryDir?: string } = {},
): Promise<LoadedConfig> {
  // A profiles-era file migrates in place first (DR-019, launcher
  // parity): the shared config composes whichever host loads it, and
  // whichever migrates first wins — the other's pass no-ops. The
  // watcher reload triggered by our own write re-reads the already-
  // migrated file harmlessly. The unresolvable-`profile` case throws
  // with edit-by-hand guidance and leaves the file untouched, which
  // surfaces as an invalid config.
  const migration = migrateConfigFileIfRetired(path);
  if (migration.migrated) {
    process.stderr.write(
      `spex: migrated ${path} to inline agent settings ` +
        `(the top-level "profiles" map was removed in playbook 3.0.0); ` +
        `the original is at ${migration.backupPath}\n`,
    );
  }
  const text = readFileSync(path, "utf8");
  const raw: unknown = parseYaml(text);
  if (options.libraryDir && isPlainObject(raw) && isPlainObject(raw.playbooks)) {
    for (const [id, block] of Object.entries(raw.playbooks)) {
      if (!isPlainObject(block) || typeof block.from !== "string") continue;
      const from = resolveConfigModule(block.from, path);
      if (from !== resolve(options.libraryDir, id, `${id}.registry.mjs`) || existsSync(from)) continue;
      const { rebuildManagedRegistry } = await import("./compile.js");
      await rebuildManagedRegistry(options.libraryDir, id);
    }
  }
  const composed = await composeConfig(raw, loadModule, path);
  return { path, raw, composed };
}

export function summarizeConfig(loaded: LoadedConfig): ConfigSummary {
  const top = isPlainObject(loaded.raw) ? loaded.raw : {};
  const agentSummary = (agent: ResolvedAgent): AgentSummary => ({
    adapter: agent.adapter,
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
    ...(agent.fastMode !== undefined ? { fastMode: agent.fastMode } : {}),
    ...(agent.instruction !== undefined
      ? { instruction: agent.instruction }
      : {}),
    ...(agent.permissions !== undefined
      ? { permissions: agent.permissions as AgentSummary["permissions"] }
      : {}),
  });
  // Which bindings name each player — the shared-lane evidence the
  // roster and the binding editors both show (DR-032).
  const boundBy = new Map<string, string[]>();
  for (const playbook of loaded.composed.playbooks) {
    for (const [role, binding] of Object.entries(playbook.roles)) {
      const list = boundBy.get(binding.playerId) ?? [];
      list.push(`${playbook.id}.${role}`);
      boundBy.set(binding.playerId, list);
    }
  }
  const playerAgents = new Map(
    loaded.composed.players.map((player) => [player.id, player]),
  );
  return {
    path: loaded.path,
    captain: agentSummary(loaded.composed.captainAgent),
    players: loaded.composed.players.map((player) => ({
      id: player.id,
      agent: agentSummary(player),
      display: player.model ?? player.adapter,
      boundBy: boundBy.get(player.id) ?? [],
    })),
    playbooks: loaded.composed.playbooks.map((playbook) => ({
      id: playbook.id,
      from: playbook.from,
      command: playbook.command,
      intent: playbook.intent,
      roles: Object.fromEntries(
        Object.entries(playbook.roles).map(([role, binding]) => {
          const player = playerAgents.get(binding.playerId);
          // What the role actually runs: its own pin, the provider
          // default it chose, or the player's default it inherits.
          const display =
            binding.model === false
              ? `${player?.adapter ?? "?"} default`
              : (binding.model ?? player?.model ?? player?.adapter ?? "?");
          return [
            role,
            {
              playerId: binding.playerId,
              ...(binding.model !== undefined ? { model: binding.model } : {}),
              ...(binding.effort !== undefined ? { effort: binding.effort } : {}),
              ...(binding.fastMode !== undefined ? { fastMode: binding.fastMode } : {}),
              display,
            },
          ];
        }),
      ),
    })),
    ...(isPlainObject(top.notifications)
      ? { notifications: top.notifications as Record<string, string> }
      : {}),
    ...(typeof top.theme === "string" ? { theme: top.theme } : {}),
  };
}

// ---------------------------------------------------------------------------
// Readiness (launcher parity: runtime half + credential half, DR-024)
// ---------------------------------------------------------------------------

export interface AdapterReadiness {
  adapter: AdapterName;
  ready: boolean | null;
  requirement?: string;
}

/** The runtime half of readiness: usable, or a requirement naming why not. */
export interface AdapterRuntimeCheck {
  usable: boolean;
  requirement?: string;
}

// Adapter shorthand -> the cligent module that constructs it. API-shape
// knowledge, not version knowledge: versions, floors, and repairs come
// from cligent's descriptor.
const ADAPTER_MODULES: Record<AdapterName, { module: string; name: string }> = {
  claude: { module: "@sublang/cligent/adapters/claude-code", name: "ClaudeCodeAdapter" },
  codex: { module: "@sublang/cligent/adapters/codex", name: "CodexAdapter" },
  gemini: { module: "@sublang/cligent/adapters/gemini", name: "GeminiAdapter" },
  kimi: { module: "@sublang/cligent/adapters/kimi", name: "KimiAdapter" },
  opencode: { module: "@sublang/cligent/adapters/opencode", name: "OpenCodeAdapter" },
};

// DR-024: one repair per install tree. A PATH runtime is repairable in
// place with cligent's pinned global install (plus any one-time step no
// install performs); a bundled SDK is not — no npm command reaches
// cligent's resolution tree inside the packaged app, and a global copy is
// invisible to its module walk — so its honest remedy is reinstalling.
export function describeRuntimeFault(verdict: RuntimeReadiness): string {
  const described = describeRuntimeReadiness(verdict);
  if (verdict.target.kind === "cli") {
    const steps =
      verdict.repair.steps.length > 0
        ? `; then: ${verdict.repair.steps.join("; ")}`
        : "";
    return `${described} — install with: npm install -g ${verdict.repair.spec}${steps}`;
  }
  return `${described} — bundled with Spex; reinstall the app, or run npm install in a checkout`;
}

// DR-024: availability is cligent's own answer — the same load a session
// start performs, so readiness cannot disagree with the run. Only when the
// probe says no are the published targets consulted, to say which runtime
// is at fault and how its tree is repaired. A target that classifies as
// healthy while the probe fails is not named — naming a healthy half sends
// the user to install what is already there. `untested` and `unknown` stay
// non-faults: the load gate itself fails open on both.
export async function checkAdapterRuntime(
  adapter: AdapterName,
): Promise<AdapterRuntimeCheck> {
  let available = false;
  try {
    const entry = ADAPTER_MODULES[adapter];
    const module = (await import(entry.module)) as Record<
      string,
      new () => { isAvailable(): Promise<boolean> }
    >;
    const AdapterClass = module[entry.name];
    if (!AdapterClass) throw new Error(`missing export ${entry.name}`);
    available = await new AdapterClass().isAvailable();
  } catch {
    available = false;
  }
  if (available) return { usable: true };
  const faults: string[] = [];
  for (const target of AGENT_RUNTIME_TARGETS[adapter] ?? []) {
    const installed = readRuntimeVersion(target);
    const verdict = classifyRuntime(target, false, installed);
    if (verdict.state === "missing" && installed !== undefined) continue;
    if (verdict.state === "missing" || verdict.state === "unsupported") {
      faults.push(describeRuntimeFault(verdict));
    }
  }
  return {
    usable: false,
    requirement:
      faults.length > 0
        ? faults.join("; ")
        : `the ${adapter} runtime failed to load — reinstall the app, or run npm install in a checkout`,
  };
}

export async function checkAdapterReadiness(
  adapter: AdapterName,
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME ?? homedir(),
  // Injectable so tests need neither installed SDKs nor CLIs on PATH.
  runtime: (
    adapter: AdapterName,
  ) => AdapterRuntimeCheck | Promise<AdapterRuntimeCheck> = checkAdapterRuntime,
): Promise<AdapterReadiness> {
  // Both halves are evaluated so an adapter missing both reports both —
  // reporting one at a time sends the user round the loop twice.
  const faults: string[] = [];
  const runtimeCheck = await runtime(adapter);
  if (!runtimeCheck.usable && runtimeCheck.requirement) {
    faults.push(runtimeCheck.requirement);
  }
  let credentialReady: boolean | null = null;
  if (adapter === "claude") {
    credentialReady =
      Boolean(env.ANTHROPIC_API_KEY) || existsSync(join(home, ".claude"));
    if (!credentialReady) {
      faults.push(
        "set ANTHROPIC_API_KEY or sign in with Claude Code (creates ~/.claude)",
      );
    }
  } else if (adapter === "codex") {
    credentialReady =
      Boolean(env.OPENAI_API_KEY) || existsSync(join(home, ".codex"));
    if (!credentialReady) {
      faults.push(
        "set OPENAI_API_KEY or sign in with the Codex CLI (creates ~/.codex)",
      );
    }
  }
  if (faults.length > 0) {
    return { adapter, ready: false, requirement: faults.join("; ") };
  }
  // The null class survives only over a usable runtime (settings-14): no
  // credential rule exists, so the UI shows verify-yourself guidance.
  return { adapter, ready: credentialReady === null ? null : true };
}
