// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Comment-preserving config editing (DR-004, SET-11/12): every
// operation is applied to a yaml Document (keeping comments, key
// order, and formatting), then the candidate is composed with the
// same fail-closed validation as loading — an edit the playbook
// launcher would reject never reaches the file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument, YAMLMap, isMap, isScalar } from "yaml";

import { composeConfig, type LoadModule } from "./config.js";
import { writeApplicationBytes } from "./app-storage.js";

export interface AgentBlock {
  adapter: string;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  instruction?: string;
  permissions?: {
    mode?: string;
    fileWrite?: string;
    shellExecute?: string;
    networkAccess?: string;
    writablePaths?: string[];
  };
}

/** Merge patch over an existing agent block (DR-019): provided keys
 * change, absent keys — including hand-written ones — survive. */
export type AgentPatch = {
  adapter?: string;
  model?: string | null;
  effort?: string | null;
  /** `true`/`false` write the key; null removes it (DR-038). */
  fastMode?: boolean | null;
  instruction?: string | null;
  permissions?: AgentBlock["permissions"] | null;
};

export type ConfigEditOp =
  | { kind: "captain.set"; patch: AgentPatch }
  | { kind: "notifications.set"; prefs: Record<string, string> }
  | { kind: "theme.set"; theme: string | null }
  /** Edit a session player's envelope: identity and defaults. */
  | { kind: "player.set"; playerId: string; patch: AgentPatch }
  | { kind: "player.delete"; playerId: string }
  /** Bind a role to a player, with that role's own tuning. Adapter and
   * permissions are the player's and are not settable here (DR-032). */
  | {
      kind: "playbook.role.bind";
      playbookId: string;
      role: string;
      playerId: string;
      model?: string | false | null;
      effort?: string | false | null;
    }
  | { kind: "playbook.option.set"; playbookId: string; key: string; value: unknown }
  | { kind: "playbook.delete"; playbookId: string }
  | {
      kind: "playbook.add";
      playbookId: string;
      from: string;
      roles: Record<string, string>;
      options?: Record<string, unknown>;
    };

function prune(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

/** Apply one operation to the YAML text; returns the new text. */
export function applyConfigOp(text: string, op: ConfigEditOp): string {
  const doc = parseDocument(text);
  if (doc.contents === null) {
    // Empty file: start a fresh mapping.
    doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  }

  const patchAgent = (
    basePath: (string | number)[],
    patch: Record<string, unknown>,
  ): void => {
    // A scalar shorthand becomes a block on first edit (DR-019): seed
    // the block with its adapter, then merge the patch — provided
    // keys change, hand-written ones survive.
    const current = doc.getIn(basePath);
    if (typeof current === "string") {
      doc.setIn(basePath, doc.createNode({ adapter: current }));
    } else if (current === undefined) {
      doc.setIn(basePath, doc.createNode({}));
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) {
        // An explicit null unsets the key, so a pinned model or
        // effort can return to the adapter's default (DR-019).
        doc.deleteIn([...basePath, key]);
        continue;
      }
      doc.setIn(
        [...basePath, key],
        typeof value === "object" ? doc.createNode(value) : value,
      );
    }
    // Canonicalize on write (DR-014): setting effort retires the
    // legacy alias so the block never carries both keys.
    if (patch.effort !== undefined) {
      doc.deleteIn([...basePath, "reasoningEffort"]);
    }
    // The retired profiles indirection never survives an edit (DR-019).
    doc.deleteIn([...basePath, "profile"]);
  };

  switch (op.kind) {
    case "captain.set": {
      patchAgent(["captain"], op.patch as Record<string, unknown>);
      break;
    }
    case "notifications.set": {
      doc.setIn(["notifications"], doc.createNode(op.prefs));
      break;
    }
    case "theme.set": {
      if (op.theme === null) doc.deleteIn(["theme"]);
      else doc.setIn(["theme"], op.theme);
      break;
    }
    case "player.set": {
      patchAgent(["players", op.playerId], op.patch as Record<string, unknown>);
      break;
    }
    case "player.delete": {
      doc.deleteIn(["players", op.playerId]);
      break;
    }
    case "playbook.role.bind": {
      const path = ["playbooks", op.playbookId, "roles", op.role];
      const tuned = op.model !== undefined || op.effort !== undefined;
      if (!tuned) {
        // No role tuning: the binding is just the lane, written as the
        // scalar the launcher's own template uses.
        doc.setIn(path, op.playerId);
        break;
      }
      const existing = doc.getIn(path);
      const block: Record<string, unknown> = { player: op.playerId };
      // A block already there keeps its other tuning key.
      if (existing && typeof existing === "object" && "toJSON" in existing) {
        const prior = (existing as { toJSON(): Record<string, unknown> }).toJSON();
        if (prior.model !== undefined) block.model = prior.model;
        if (prior.effort !== undefined) block.effort = prior.effort;
      }
      for (const key of ["model", "effort"] as const) {
        const value = op[key];
        if (value === undefined) continue;
        // null clears the override, so the role inherits the player's
        // default again; false selects the provider's (DR-032).
        if (value === null) delete block[key];
        else block[key] = value;
      }
      doc.setIn(path, doc.createNode(block));
      break;
    }
    case "playbook.option.set": {
      if (op.value === null || op.value === undefined) {
        doc.deleteIn(["playbooks", op.playbookId, op.key]);
      } else {
        doc.setIn(
          ["playbooks", op.playbookId, op.key],
          doc.createNode(op.value),
        );
      }
      break;
    }
    case "playbook.delete": {
      doc.deleteIn(["playbooks", op.playbookId]);
      break;
    }
    case "playbook.add": {
      // Enabling a playbook binds its roles to existing lanes; the
      // players themselves are edited in their own map (DR-032).
      const node = doc.createNode({
        from: op.from,
        roles: { ...op.roles },
        ...(op.options ?? {}),
      }) as YAMLMap;
      doc.setIn(["playbooks", op.playbookId], node);
      break;
    }
  }
  return doc.toString({ flowCollectionPadding: false });
}

export interface EditResult {
  ok: boolean;
  /** Composition error when the candidate failed validation. */
  error?: string;
}

/**
 * Apply an operation to the config file: validate the candidate via
 * composition first; only write when it passes (SET-3).
 */
export async function editConfigFile(
  path: string,
  op: ConfigEditOp,
  loadModule?: LoadModule,
): Promise<EditResult> {
  const text = readFileSync(path, "utf8");
  const candidate = applyConfigOp(text, op);
  try {
    const parsed = parseDocument(candidate).toJS() as unknown;
    await composeConfig(parsed, loadModule, path);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  writeApplicationBytes(path, candidate);
  return { ok: true };
}

/**
 * The one-time library relocation's config half (CORE-64, DR-036):
 * every `playbooks.<id>.from` path inside the legacy library prefix
 * moves to the new one, comments and formatting kept. A mechanical
 * migration edit, like the profiles migration before it: it does not
 * fail closed on unrelated config invalidity.
 */
export function rewriteLibraryPaths(
  configPath: string,
  fromPrefix: string,
  toPrefix: string,
): void {
  if (!existsSync(configPath)) return;
  const doc = parseDocument(readFileSync(configPath, "utf8"));
  const playbooks = doc.get("playbooks");
  if (!isMap(playbooks)) return;
  let changed = false;
  for (const item of playbooks.items) {
    const entry = item.value;
    if (!isMap(entry)) continue;
    const from = entry.get("from", true);
    if (!isScalar(from) || typeof from.value !== "string") continue;
    if (!from.value.startsWith(fromPrefix)) continue;
    from.value = toPrefix + from.value.slice(fromPrefix.length);
    changed = true;
  }
  if (changed) writeFileSync(configPath, doc.toString({ flowCollectionPadding: false }));
}
