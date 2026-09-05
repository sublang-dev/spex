// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Load-time migration of profiles-era configs (DR-019): a faithful
// port of the playbook 3.0 launcher's migrateRetiredProfiles, so the
// shared file migrates identically whichever host touches it first.
// Cases: a scalar naming a profile inlines it (comment carried); a
// scalar naming nothing stays; a block `profile` key inlines with the
// block's own fields winning; a `profile` naming a missing entry is a
// hard error leaving the file untouched; the `profiles` map is
// removed with its header paragraph preserved. Comment-preserving via
// the yaml Document API; the pre-migration file is backed up beside
// the config; a MIGRATION_NOTE heads the rewritten file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMap, isScalar, parseDocument } from "yaml";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { migrateApplicationFile } from "./app-storage.js";
import type { Document, Pair, Scalar, YAMLMap } from "yaml";

const MIGRATION_NOTE =
  " Migrated by playbook 3.0.0: the top-level `profiles` map was removed and\n" +
  " each agent now carries its settings inline. The pre-migration file is\n" +
  " kept beside this one as a .bak. Comments below may still describe the\n" +
  " retired profiles model.";

function freeBackupPath(configPath: string): string {
  const first = `${configPath}.bak`;
  if (!existsSync(first)) return first;
  for (let n = 2; ; n += 1) {
    const candidate = `${configPath}.bak.${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

function carryScalarComment(node: Scalar, inlined: YAMLMap): void {
  const parts = [node.commentBefore, node.comment].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  if (parts.length === 0) return;
  const first = (inlined.items?.[0] as Pair | undefined)?.key as
    | Scalar
    | undefined;
  if (!first) return;
  // A flow map carrying a comment renders as a multi-line brace
  // block; the ordinary block form matches the rest of the config.
  inlined.flow = false;
  const carried = parts.join("\n");
  first.commentBefore =
    first.commentBefore === undefined
      ? carried
      : `${carried}\n${first.commentBefore}`;
}

/** Drop the trailing paragraph (the one describing profiles) and keep
 * the rest of the leading comment (SPDX header, file overview). */
function keptHeaderComment(comment: unknown): string | undefined {
  if (typeof comment !== "string" || comment.trim() === "") return undefined;
  const paragraphs = comment.split("\n\n");
  const kept = paragraphs.slice(0, -1).join("\n\n");
  return kept.trim() === "" ? undefined : kept;
}

/**
 * Rewrite a profiles-era config in place, launcher-parity. Returns the
 * migrated text, or undefined when there is nothing to migrate.
 * Throws (file untouched by the caller contract) when a block
 * `profile` names a missing entry.
 */
export function migrateRetiredProfiles(text: string): string | undefined {
  const doc = parseDocument(text) as Document & { contents: YAMLMap | null };
  const contents = doc.contents;
  if (!contents || !Array.isArray(contents.items)) return undefined;
  const profiles = doc.get("profiles") as YAMLMap | undefined;
  const agentPaths: string[][] = [["captain"]];
  const playbooks = doc.get("playbooks") as YAMLMap | undefined;
  if (playbooks && Array.isArray(playbooks.items)) {
    for (const entry of playbooks.items as Pair[]) {
      const id = String(entry.key);
      const players = doc.getIn(["playbooks", id, "players"]) as
        | YAMLMap
        | undefined;
      if (!players || !Array.isArray(players.items)) continue;
      for (const player of players.items as Pair[]) {
        agentPaths.push(["playbooks", id, "players", String(player.key)]);
      }
    }
  }

  const profileSettings = (name: unknown): YAMLMap | undefined =>
    profiles && typeof profiles.get === "function"
      ? (profiles.get(name as string, true) as YAMLMap | undefined)
      : undefined;

  let changed = false;
  for (const path of agentPaths) {
    const node = doc.getIn(path, true) as
      | (Scalar & { items?: unknown })
      | (YAMLMap & { value?: unknown })
      | undefined;
    if (node && typeof node.value === "string" && !Array.isArray(node.items)) {
      // A scalar that named a profile; a bare adapter shorthand (or an
      // unmatched name) stays as written.
      const settings = profileSettings(node.value);
      if (settings === undefined) continue;
      const inlined = settings.clone() as YAMLMap;
      carryScalarComment(node as Scalar, inlined);
      doc.setIn(path, inlined);
      changed = true;
    } else if (node && Array.isArray(node.items)) {
      const block = node as YAMLMap;
      const named = block.get?.("profile");
      if (named === undefined) continue;
      const settings = profileSettings(named);
      if (settings === undefined) {
        throw new Error(
          `${path.join(".")}.profile names "${String(named)}", which no ` +
            "profiles entry defines",
        );
      }
      // Fill the block from its profile in place — never rebuild it —
      // so the user's own keys, ordering, and comments survive. The
      // block's own fields stay authoritative: only absent keys are
      // added, as whole cloned pairs so key-borne comments ride along.
      block.delete("profile");
      for (const item of settings.items as Pair[]) {
        if (block.has(String(item.key))) continue;
        block.add(item.clone() as Pair);
      }
      changed = true;
    }
  }

  if (profiles !== undefined) {
    // The comment block above `profiles` usually carries the file's
    // own header; keep every paragraph except the last, which
    // documents profiles themselves.
    const index = contents.items.findIndex(
      (item) => String((item as Pair).key) === "profiles",
    );
    const lead =
      index === -1
        ? undefined
        : ((contents.items[index] as Pair).key as Scalar | undefined)
            ?.commentBefore;
    doc.delete("profiles");
    const header = keptHeaderComment(lead);
    const next = contents.items[0] as Pair | undefined;
    const nextKey = next?.key as Scalar | undefined;
    if (header !== undefined && nextKey) {
      nextKey.commentBefore =
        nextKey.commentBefore === undefined
          ? header
          : `${header}\n\n${nextKey.commentBefore}`;
    }
    changed = true;
  }
  if (!changed) return undefined;
  doc.commentBefore = MIGRATION_NOTE;
  return doc.toString({ flowCollectionPadding: false });
}

export interface MigrationResult {
  migrated: boolean;
  backupPath?: string;
}

/**
 * Migrate the config file in place when it carries the retired
 * profiles model; no-op when there is nothing to migrate (including
 * when the launcher migrated first). Throws with edit-by-hand
 * guidance on the unresolvable-`profile` case, leaving the file
 * untouched.
 */
export function migrateConfigFileIfRetired(
  configPath: string,
): MigrationResult {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return { migrated: false };
  }
  let migrated: string | undefined;
  try {
    migrated = migrateRetiredProfiles(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot migrate the retired profiles config at ${configPath}: ` +
        `${message} — edit it by hand: each agent takes its own ` +
        "adapter, model, effort, and permissions",
    );
  }
  if (migrated === undefined) return { migrated: false };
  const backupPath = freeBackupPath(configPath);
  writeFileSync(backupPath, text, { mode: 0o600 });
  writeFileSync(configPath, migrated);
  return { migrated: true, backupPath };
}

/** Convert only managed absolute locators whose target stays identical. */
export function migrateManagedLibraryConfig(configPath: string, libraryDir: string, spexHome: string): void {
  migrateApplicationFile(spexHome, configPath, (original) => {
    const document = parseDocument(original);
    if (document.errors.length) return original;
    const playbooks = document.get("playbooks"); if (!isMap(playbooks)) return original;
    let changed = false;
    for (const entry of playbooks.items) {
      if (!isMap(entry.value)) continue;
      const from = entry.value.get("from", true);
      if (!isScalar(from) || typeof from.value !== "string" || !isAbsolute(from.value)) continue;
      const target = resolve(from.value); const local = relative(resolve(libraryDir), target);
      if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) || !existsSync(target)) continue;
      const locator = relative(dirname(configPath), target).split(sep).join("/");
      const next = locator.startsWith(".") ? locator : `./${locator}`;
      if (resolve(dirname(configPath), next) !== target) continue;
      from.value = next; changed = true;
    }
    return changed ? document.toString({ flowCollectionPadding: false }) : original;
  });
}
