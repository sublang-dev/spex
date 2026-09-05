// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The Spex WebSocket protocol: every message between core and UI is
// defined here and nowhere else (CORE-12). This module must stay free
// of Node-only imports so the UI can consume it directly; the record
// type is imported type-only from cligent and erased at build time.

import { z } from "zod";
import type { TmuxPlayRecord as RuntimeRecord } from "@sublang/cligent/tmux-play";

export const PROTOCOL_VERSION = 7;

export type TmuxPlayRecord = RuntimeRecord & {contextSeq?: number};

/** The v1 stream also carries opaque objects. This header gates only
 * presentation, never whether a stored envelope is valid. */
export function hasPresentationHeader(record: TmuxPlayRecord): boolean {
  return typeof record.type === "string" && Number.isFinite(record.timestamp);
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export const adapterNameSchema = z.enum([
  "claude",
  "codex",
  "gemini",
  "kimi",
  "opencode",
]);
export type AdapterName = z.infer<typeof adapterNameSchema>;

export interface AgentPermissionsSummary {
  mode?: string;
  fileWrite?: string;
  shellExecute?: string;
  networkAccess?: string;
  writablePaths?: string[];
}

/** One agent's inline settings (DR-019). Hand-written fields the UI
 * does not surface (instruction, granular permissions) round-trip
 * through merge-patch edits. */
export interface AgentSummary {
  adapter: AdapterName;
  model?: string;
  /** Adapter-scoped vocabulary; composition validates. */
  effort?: string;
  /** Adapter-scoped fast mode; the chip wears a lightning mark (DR-038). */
  fastMode?: boolean;
  instruction?: string;
  permissions?: AgentPermissionsSummary;
}

/** A session player: an identity-bearing lane, with the roles that
 * bind to it across every enabled playbook (DR-032). */
export interface SessionPlayerSummary {
  id: string;
  agent: AgentSummary;
  /** Human-readable identity: pinned model, else adapter. */
  display: string;
  /** `<playbook>.<role>` for every binding naming this player — the
   * evidence that a lane is shared, and by whom. */
  boundBy: string[];
}

/** One role's binding: which player answers it, and that role's own
 * tuning. `false` means the provider's current default; absent means
 * the player's own (DR-032). */
export interface RoleBindingSummary {
  playerId: string;
  model?: string | false;
  effort?: string | false;
  fastMode?: boolean;
  /** What this role effectively runs, after inheritance. */
  display: string;
}

export interface PlaybookSummary {
  id: string;
  from: string;
  command: string;
  intent: string;
  roles: Record<string, RoleBindingSummary>;
}

export interface PlaybookArtifacts {
  /** The workflow markdown the playbook was compiled from. */
  source: string | null;
  /** The GEARS spec items. */
  gears: string | null;
  /** The gears markdown parsed into the item shape the spec outline's
   * rows read (playbook-library-24); absent when the parse yields no
   * item. */
  gearsItems?: SpecFileInfo;
  /** The compiled XState FSM module code. */
  fsm: string | null;
  /** Every state id of the FSM, when derivable. */
  stateIds: string[] | null;
  /** The drawable machine graph (playbook-library-36, DR-028), null
   * when the machine cannot be loaded. */
  machine: MachineGraph | null;
  /** Stage names that could not be located. */
  missing: string[];
}

/** The machine graph the run view draws (DR-028): nodes and stable
 * edges derived from the hosted machine's own config. */
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
  /** owner::event::branch::target — guarded siblings stay distinct. */
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

export interface ConfigSummary {
  path: string;
  captain: AgentSummary;
  /** The session roster, in first-reference order (DR-032). */
  players: SessionPlayerSummary[];
  playbooks: PlaybookSummary[];
  notifications?: Record<string, string>;
  theme?: string;
}

export type ConfigState =
  | { status: "valid"; summary: ConfigSummary; seeded: boolean }
  | { status: "invalid"; path: string; errors: string[] }
  | { status: "missing"; path: string };

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  registeredAt: number;
}

export interface SessionInfo {
  id: string;
  projectId: string;
  projectPath: string;
  createdAt: number;
  live: boolean;
  /** Includes checkpoint settlement after the runtime finishes. */
  turnActive?: boolean;
  endedAt: number | null;
  /** The session's bound player roster, in config order (DR-032). */
  players: { id: string; adapter: AdapterName; model?: string; fastMode?: boolean }[];
  /** Panes visible at session start, before any player_view_changed record. */
  initialVisible: string[];
  /** Legacy host label retained for older history; never recovery authority. */
  foreign?: true;
  /** Shared validation permits an ordinary Boss message to continue it. */
  continuable?: boolean;
  continuationReason?: string;
  recovery?: { state: "uncertain"; input: string };
  /** The session's own words: its first Boss turn, absent when the
   * session held no turn (core-service-32). */
  title?: string;
  /** Turns this session held. */
  turns: number;
  /** Whether the session carries a failure record. */
  failed: boolean;
  /** Recorded cost, when any usage carried one. */
  costUsd?: number;
  /** Set when a record could not be durably appended: the persisted
   * stream is complete only up to this sequence, so served history is
   * never presented as complete when it is not (DR-036). */
  streamIncompleteAfterSeq?: number;
}

export interface ReadinessEntry {
  adapter: AdapterName;
  /** true = ready, false = not ready, null = no preflight rule for
   * this adapter (verify sign-in yourself). */
  ready: boolean | null;
  /** Unmet requirement, present when ready is false. */
  requirement?: string;
  /** Positions using this adapter: "captain" or `<playbook>.<role>`. */
  usedBy: string[];
  /** Whether the embedded runtime declares fast mode for this adapter
   * (DR-038); the editor offers the switch only then. */
  fastModeSupported: boolean;
}

/** What a run reported spending. `costSources` names every provenance
 * the summed cost came from — a cost is only as trustworthy as its
 * weakest source, so the label travels with the number (DR-032). */
export interface UsageRollup {
  inputTokens: number;
  outputTokens: number;
  toolUses: number;
  totalCostUsd: number;
  costSources: string[];
}

export interface StoredRecord {
  seq: number;
  record: TmuxPlayRecord;
  /** For a player record inside a resolved call, the role that call
   * served (DR-032). One lane answers several roles over a session,
   * so without this a shared player reads as one voice talking to
   * itself. Absent where the trace named no resolved player. */
  role?: string;
}

export interface RepoStatusInfo {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  originUrl?: string;
}

export interface ForgeItem {
  number: number;
  title: string;
  url: string;
  author?: string;
  updatedAt?: string;
  labels?: string[];
}

export interface ForgeState {
  adapter: "github";
  /** null: adapter tool missing/unbound; false: not authenticated. */
  authenticated: boolean | null;
  /** owner/name when the origin remote maps to the forge. */
  repo?: string;
  issues: ForgeItem[];
  prs: ForgeItem[];
  /** Setup guidance when data cannot be served. */
  guidance?: string;
}

// ---------------------------------------------------------------------------
// The intent ledger (DR-035)
// ---------------------------------------------------------------------------

export type IntentSourceKind = "issue" | "pr" | "record" | "chat";

/** Where an intent came from — provenance, never mirrored state. */
export interface IntentSource {
  kind: IntentSourceKind;
  /** Issue/PR number as text, a record id like "IR-21", or a session
   * id for chat capture. */
  ref: string;
  url?: string;
  /** The forge labels the source carried at capture — provenance, so a
   * fixed bug is known as one without a later forge read (DR-038). */
  labels?: string[];
}

/** One stored intent: a staged Boss turn plus its acts (DR-035).
 * There is no stored state — everything visible derives. */
export interface IntentInfo {
  id: string;
  projectId: string;
  /** The future Boss turn; its first line is the display title. */
  text: string;
  source?: IntentSource;
  /** Lexicographic order key; position is priority. */
  rank: string;
  /** Single optional predecessor, any project. */
  afterId?: string;
  createdAt: number;
  /** Stamped when the dispatched turn starts; re-written by a later
   * dispatch. An aborted dispatch releases by derivation — the stamp
   * stays as history. */
  dispatched?: { sessionId: string; turnId: number; at: number };
  closedAt?: number;
  closedAs?: "done" | "dropped";
}

export type IntentState =
  | "queued"
  | "working"
  | "interrupted"
  | "finished"
  | "done"
  | "dropped";

/** Basic run stats folded from the intent's turn range (DR-035). */
export interface IntentStats {
  /** Reviewer-role player calls the range held; absent when zero. */
  reviewRounds?: number;
  turns: number;
  elapsedMs?: number;
}

/** An open intent with its derived state (DR-035). */
export interface DerivedIntent {
  intent: IntentInfo;
  state: IntentState;
  /** Present once dispatched (working/interrupted/finished). */
  stats?: IntentStats;
  /** Present while the after-link's target is still open. */
  blockedBy?: { intentId: string; title: string; projectId: string };
  /** Why an interrupted intent stands stopped on the Boss. */
  reason?: "question" | "permission" | "failure";
}

/** One attention entry: an interrupted or finished intent, or a
 * session standing in where no intent is bound (DR-035). */
export interface AttentionEntry {
  band: "interrupted" | "finished";
  /** Interruption reason, or "finish" / "review" for band two —
   * "review" names the un-ledgered turn that clears on viewing. */
  kind: "question" | "permission" | "failure" | "finish" | "review";
  /** Absent for session stand-in entries. */
  intentId?: string;
  /** The intent's title, or the session's latest turn text. */
  title: string;
  projectId: string;
  sessionId: string;
  /** The turn the entry points at, when one is known. */
  turnId?: number;
  /** When the condition began, ms epoch — longest waiting first. */
  since: number;
  stats?: IntentStats;
}

/** The one cross-project ledger fold (DR-035): every open intent with
 * its derived state, the two-band attention queue, and the badge. */
export interface LedgerState {
  intents: DerivedIntent[];
  attention: AttentionEntry[];
  badge: number;
}

/** One closed intent, as History pages serve it (DR-035). */
export interface ClosedIntent {
  intent: IntentInfo;
  stats?: IntentStats;
}

// ---------------------------------------------------------------------------
// Client → core commands (validated per CORE-13)
// ---------------------------------------------------------------------------

const id = z.string().min(1);

/** One agent's inline settings as written to the config (DR-019).
 * Full-block writes carry every field so nothing hand-written drops;
 * merge patches change only the provided keys. */
export const agentBlockSchema = z.object({
  adapter: z.string().min(1),
  model: z.string().optional(),
  effort: z.string().optional(),
  instruction: z.string().optional(),
  permissions: z
    .object({
      mode: z.string().optional(),
      fileWrite: z.string().optional(),
      shellExecute: z.string().optional(),
      networkAccess: z.string().optional(),
      writablePaths: z.array(z.string()).optional(),
    })
    .optional(),
});
export type AgentBlockInput = z.infer<typeof agentBlockSchema>;

/** A merge patch over an existing agent block: provided keys change,
 * absent keys survive (adapter may change; retired keys never pass).
 * An explicit null unsets that key, so a pinned model or effort can
 * return to the adapter's default (DR-019). */
export const agentPatchSchema = z.object({
  adapter: z.string().min(1).optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  fastMode: z.boolean().nullable().optional(),
  instruction: z.string().nullable().optional(),
  permissions: z
    .object({
      mode: z.string().nullable().optional(),
      fileWrite: z.string().optional(),
      shellExecute: z.string().optional(),
      networkAccess: z.string().optional(),
      writablePaths: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
});

/** A session player id: lowercase segments, dots by convention. */
export const playerIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/);

export const configEditOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("captain.set"), patch: agentPatchSchema }),
  z.object({
    kind: z.literal("notifications.set"),
    prefs: z.record(z.string(), z.string()),
  }),
  z.object({ kind: z.literal("theme.set"), theme: z.string().nullable() }),
  z.object({
    kind: z.literal("player.set"),
    playerId: playerIdSchema,
    patch: agentPatchSchema,
  }),
  z.object({ kind: z.literal("player.delete"), playerId: playerIdSchema }),
  z.object({
    kind: z.literal("playbook.role.bind"),
    playbookId: z.string().min(1),
    role: z.string().min(1),
    playerId: playerIdSchema,
    // A concrete value pins, false selects the provider default, null
    // clears the override so the role inherits the player (DR-032).
    model: z.union([z.string().min(1), z.literal(false)]).nullable().optional(),
    effort: z.union([z.string().min(1), z.literal(false)]).nullable().optional(),
  }),
  z.object({
    kind: z.literal("playbook.option.set"),
    playbookId: z.string().min(1),
    key: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({ kind: z.literal("playbook.delete"), playbookId: z.string().min(1) }),
  z.object({
    kind: z.literal("playbook.add"),
    playbookId: z.string().min(1),
    from: z.string().min(1),
    roles: z.record(z.string(), playerIdSchema),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type ConfigEditOpInput = z.infer<typeof configEditOpSchema>;

export const channelSchema = z.object({
  kind: z.enum(["session", "debug"]),
  sessionId: z.string().min(1),
});
export type Channel = z.infer<typeof channelSchema>;

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("config.get"), id }),
  z.object({ type: z.literal("readiness.get"), id }),
  z.object({ type: z.literal("project.list"), id }),
  z.object({ type: z.literal("project.register"), id, path: z.string().min(1) }),
  z.object({ type: z.literal("project.remove"), id, projectId: z.string().min(1) }),
  z.object({
    type: z.literal("project.create"),
    id,
    path: z.string().min(1),
    scaffold: z.boolean().optional(),
    /** Seed the Academy example corpus (DR-015); excludes scaffold. */
    example: z.boolean().optional(),
  }),
  z.object({ type: z.literal("project.status"), id, projectId: z.string().min(1) }),
  z.object({
    type: z.literal("forge.items"),
    id,
    projectId: z.string().min(1),
    refresh: z.boolean().optional(),
  }),
  z.object({ type: z.literal("session.list"), id }),
  z.object({ type: z.literal("session.create"), id, projectId: z.string().min(1) }),
  z.object({ type: z.literal("project.rebind"), id, projectId: z.string().uuid(), path: z.string().min(1), aliases: z.array(z.string()).optional(), revision: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal("storage.diagnostics"), id }).strict(),
  z.object({ type: z.literal("session.dispose"), id, sessionId: z.string().min(1) }),
  z.object({ type: z.literal("session.retry"), id, sessionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("session.discard"), id, sessionId: z.string().min(1) }).strict(),
  z.object({
    type: z.literal("turn.submit"),
    id,
    sessionId: z.string().min(1),
    text: z.string().min(1),
    /** The staged intent this turn dispatches (DR-035): validated,
     * then stamped when the turn starts — never on a submission that
     * starts no turn. */
    intentId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("turn.abort"), id, sessionId: z.string().min(1) }),
  z.object({ type: z.literal("subscribe"), id, channel: channelSchema }),
  z.object({ type: z.literal("unsubscribe"), id, channel: channelSchema }),
  z.object({
    type: z.literal("history.get"),
    id,
    sessionId: z.string().min(1),
    afterSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("usage.get"), id, sessionId: z.string().min(1) }),
  z.object({ type: z.literal("usage.days"), id }),
  z.object({ type: z.literal("config.edit"), id, op: configEditOpSchema }),
  z.object({ type: z.literal("compile.check"), id }),
  z.object({
    type: z.literal("playbook.artifacts"),
    id,
    playbookId: z.string().min(1),
  }),
  z.object({
    type: z.literal("compile.run"),
    id,
    playbookId: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    sourceText: z.string().optional(),
    sourcePath: z.string().optional(),
    roles: z.array(z.string().min(1)).min(1),
    command: z.string().min(1),
    intent: z.string().min(1),
    /** role -> the session player that answers it (DR-032). */
    bindings: z.record(z.string(), playerIdSchema),
    /** Lanes to create for bindings naming a player not yet in the
     * roster — the Playbooks surface may mint one in place. */
    newPlayers: z.record(playerIdSchema, agentBlockSchema).optional(),
  }),
  z.object({
    type: z.literal("compile.abort"),
    id,
    playbookId: z.string().min(1),
  }),
  z.object({ type: z.literal("library.builtins"), id }),
  z.object({ type: z.literal("specs.get"), id, projectId: z.string().min(1) }),
  z.object({
    type: z.literal("specs.read"),
    id,
    projectId: z.string().min(1),
    /** Path relative to the project's specs/ directory. */
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("specs.write"),
    id,
    projectId: z.string().min(1),
    /** Path relative to the project's specs/ directory; the file must
     * exist — the write never creates one (DR-043). */
    path: z.string().min(1),
    /** The whole file, written exactly as sent. */
    content: z.string(),
    /** The version token specs.read handed out: a mismatch is a
     * conflict, and no token writes unconditionally. */
    baseVersion: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("intent.queue"),
    id,
    projectId: z.string().min(1),
    text: z.string().min(1),
    source: z
      .object({
        kind: z.enum(["issue", "pr", "record", "chat"]),
        ref: z.string().min(1),
        url: z.string().min(1).optional(),
        labels: z.array(z.string()).optional(),
      })
      .optional(),
    afterIntentId: z.string().min(1).optional(),
    at: z.enum(["head", "tail"]).optional(),
  }),
  z.object({
    type: z.literal("intent.edit"),
    id,
    intentId: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("intent.move"),
    id,
    intentId: z.string().min(1),
    /** The open intent to sit after; null moves to the head. */
    afterIntentId: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("intent.link"),
    id,
    intentId: z.string().min(1),
    /** The open predecessor to wait behind; null clears the link. */
    afterIntentId: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("intent.close"),
    id,
    intentId: z.string().min(1),
    as: z.enum(["done", "dropped"]),
  }),
  z.object({
    /** Retire a closed intent from History and every other read
     * (core-service-79, DR-038). */
    type: z.literal("intent.remove"),
    id,
    intentId: z.string().min(1),
  }),
  z.object({ type: z.literal("ledger.get"), id }),
  z.object({
    type: z.literal("ledger.history"),
    id,
    projectId: z.string().min(1),
    /** Page cursor: the last served row's closedAt and id. */
    before: z
      .object({ closedAt: z.number().int(), intentId: z.string().min(1) })
      .optional(),
  }),
  z.object({
    type: z.literal("session.viewed"),
    id,
    sessionId: z.string().min(1),
    turnId: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("session.delete"), id, sessionId: z.string().min(1) }),
]);

export type Command = z.infer<typeof commandSchema>;
export type CommandType = Command["type"];

/** Reply result payload per command type. */
export interface CommandResults {
  "config.get": ConfigState;
  "readiness.get": ReadinessEntry[];
  "project.list": ProjectInfo[];
  "project.rebind": ProjectInfo;
  "storage.diagnostics": { file: string; reason: string; blocking: boolean }[];
  "project.register": ProjectInfo;
  "project.remove": null;
  "project.create": ProjectInfo;
  "project.status": RepoStatusInfo;
  "forge.items": ForgeState;
  "session.list": SessionInfo[];
  "session.create": SessionInfo;
  "session.dispose": null;
  "session.retry": { accepted: true };
  "session.discard": { removed: boolean };
  "session.delete": null;
  "turn.submit": { accepted: true };
  "turn.abort": { aborted: boolean };
  subscribe: null;
  unsubscribe: null;
  "history.get": { records: StoredRecord[] };
  "usage.get": UsageRollup;
  "usage.days": { day: string; totals: UsageRollup }[];
  "config.edit": ConfigState;
  "compile.check": {
    node: { ok: boolean; version?: string; command: string; guidance?: string };
    slc: { ok: boolean; command: string[]; guidance?: string };
  };
  "compile.run": ConfigState;
  "compile.abort": null;
  "playbook.artifacts": PlaybookArtifacts;
  "library.builtins": { builtins: BuiltinPlaybookInfo[] };
  "specs.get": SpecTreeState;
  /** The file's text with its version token — a digest of the bytes —
   * and last change (spec-view-16, DR-043). */
  "specs.read": { markdown: string; version: string; mtime: number };
  /** The token and last change of the bytes written (spec-view-47). */
  "specs.write": { version: string; mtime: number };
  "intent.queue": IntentInfo;
  "intent.edit": IntentInfo;
  "intent.move": IntentInfo;
  "intent.link": IntentInfo;
  "intent.close": IntentInfo;
  /** The intent is gone from every read, so nothing comes back. */
  "intent.remove": null;
  "ledger.get": LedgerState;
  "ledger.history": { intents: ClosedIntent[]; more: boolean };
  "session.viewed": null;
}

// ---------------------------------------------------------------------------
// Spec view data (SPECV, DR-011)
// ---------------------------------------------------------------------------

export type SpecGroup = "external" | "internal" | "test";

export interface SpecItemInfo {
  /** Item ID, e.g. "run-view-9". */
  id: string;
  /** Section-kind group (DR-015): External Behavior external,
   * Internal Behavior internal, Verification test. */
  group: SpecGroup;
  /** Containing `##` section heading, verbatim. */
  section: string;
  /** Nearest `###` topic heading above a `####` item, when present. */
  topic?: string;
  /** One-line digest: the item's first sentence. */
  firstLine: string;
  /** Full markdown body of the item. */
  text: string;
  /** Item IDs cited by inline links in the item body. */
  cites: string[];
}

export interface SpecFileInfo {
  /** Path relative to the project root. */
  path: string;
  /** Collection-relative path minus .md, e.g. "identity/github-login". */
  key: string;
  /** Collection subdirectory ("" at collection root) — navigation only. */
  dir: string;
  /** The package identifier: the file's basename (meta-10). */
  basename: string;
  /** Title from the `# <pack>: <Title>` heading, after the
   * identifier — or the whole H1 when it lacks that pattern. */
  title?: string;
  /** First paragraph of the file's `## Intent` section. */
  intent?: string;
  /** Items in document order — never sorted by ID. */
  items: SpecItemInfo[];
  /** Consistency notices: an H1 identifier or item-ID prefix
   * disagreeing with the basename, section surprises. */
  notices: string[];
  /** Parse-failure notice; items may be partial when set. */
  error?: string;
}

export interface SpecRecordInfo {
  /** Record ID, e.g. "DR-011" or "IR-016". */
  id: string;
  title: string;
  /** Path relative to the project's specs/ directory. */
  path: string;
  /** The first non-empty line of the record's `## Status` section,
   * verbatim; absent when the file has none. */
  status?: string;
  /** The core's classification of that line (spec-view-14, DR-038):
   * absent while open; "done" or "superseded" once finished. */
  finished?: "done" | "superseded";
  /** The file's last change, for History's timeline (DR-038). */
  updatedAt?: number;
}

export interface SpecTreeState {
  /** False when the project has no specs/ directory. */
  present: boolean;
  /** True when specs/ holds a legacy-generation directory other
   * than iterations/ — see LEGACY_DIRS in specs.ts; files stay empty
   * and the view shows migration guidance. */
  legacy: boolean;
  /** The packages/ collection's files, keyed by collection-relative
   * path. */
  files: SpecFileInfo[];
  decisions: SpecRecordInfo[];
  /** Intent records, read from intents/ or a legacy iterations/. */
  intents: SpecRecordInfo[];
  /** Tree-level notices (unknown top-level entries, etc.). */
  notices: string[];
  /** When the tree was read, ms epoch. */
  readAt: number;
}

// ---------------------------------------------------------------------------
// Built-in playbook catalog (DR-015)
// ---------------------------------------------------------------------------

export interface BuiltinPlaybookInfo {
  id: string;
  command: string;
  intent: string;
  /** Registry module specifier for the config `from` key. */
  from: string;
  /** Role ids the registry entry requires. */
  roles: string[];
  /** True when the active config already registers this id. */
  configured: boolean;
  /** Playbook source markdown from the installed package (DR-019). */
  source?: string;
}

// ---------------------------------------------------------------------------
// Core → client messages
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "invalid_message"
  | "invalid_request"
  | "invalid_config"
  | "not_found"
  | "busy"
  | "aborted"
  | "conflict"
  | "internal";

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  coreVersion: string;
}

export type ReplyMessage =
  | { type: "reply"; id: string; ok: true; result: unknown }
  | {
      type: "reply";
      id: string;
      ok: false;
      error: { code: ErrorCode; message: string };
    };

export interface RecordMessage {
  type: "record";
  channel: "session" | "debug";
  sessionId: string;
  seq: number;
  record: TmuxPlayRecord;
  /** The role this player record's call served — see StoredRecord. */
  role?: string;
}

export interface ConfigStateMessage {
  type: "config.state";
  state: ConfigState;
}

export interface ReadinessStateMessage {
  type: "readiness.state";
  entries: ReadinessEntry[];
}

/** A stored session was deleted (DR-038): clients drop every trace. */
export interface SessionRemovedMessage {
  type: "session.removed";
  sessionId: string;
  projectId: string;
}

export interface SessionHistoryReplacedMessage {
  type: "session.history-replaced";
  sessionId: string;
}

export interface SessionStateMessage {
  type: "session.state";
  session: SessionInfo;
}

export interface CompileProgressMessage {
  type: "compile.progress";
  playbookId: string;
  line: string;
}

/** The ledger changed for these projects: an intents write landed, or
 * a session event moved a derived state (DR-035). Clients re-pull
 * ledger.get; the payload names the projects so a narrow view may
 * skip a foreign change. */
export interface IntentsChangedMessage {
  type: "intents.changed";
  projectIds: string[];
}

export type ServerMessage =
  | HelloMessage
  | ReplyMessage
  | RecordMessage
  | ConfigStateMessage
  | ReadinessStateMessage
  | SessionStateMessage
  | SessionRemovedMessage
  | SessionHistoryReplacedMessage
  | CompileProgressMessage
  | IntentsChangedMessage;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export type ParseCommandResult =
  | { ok: true; command: Command }
  | { ok: false; error: string; id?: string };

/** Parse and validate one inbound client message (CORE-13). */
export function parseCommand(raw: unknown): ParseCommandResult {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: "message is not valid JSON" };
    }
  }
  const result = commandSchema.safeParse(value);
  if (result.success) return { ok: true, command: result.data };
  const maybeId =
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "string"
      ? (value as { id: string }).id
      : undefined;
  return {
    ok: false,
    error: result.error.issues
      .map((issue) => `${issue.path.join(".") || "message"}: ${issue.message}`)
      .join("; "),
    id: maybeId,
  };
}
