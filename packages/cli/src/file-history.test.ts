// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalContentHash } from "./copy-templates.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_ROOT = join(REPO_ROOT, "scaffold");
const SCAFFOLD_SPECS = join(SCAFFOLD_ROOT, "specs");
const SCAFFOLD_I18N = join(SCAFFOLD_ROOT, "i18n");

function listBundledSpecFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".DS_Store") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listBundledSpecFiles(path));
    } else {
      files.push(relative(SCAFFOLD_ROOT, path).replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

function listBundledManifestFiles(): string[] {
  const files = listBundledSpecFiles(SCAFFOLD_SPECS);
  if (existsSync(SCAFFOLD_I18N)) {
    for (const entry of readdirSync(SCAFFOLD_I18N, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const overlaySpecs = join(SCAFFOLD_I18N, entry.name, "specs");
      if (existsSync(overlaySpecs)) {
        files.push(...listBundledSpecFiles(overlaySpecs));
      }
    }
  }
  return files.sort();
}

describe("legacy file-history manifest", () => {
  const manifestPath = join(REPO_ROOT, "scaffold", ".legacy-file-history.json");

  it("holds only paths that no longer ship, with non-empty histories", () => {
    const legacy = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
      string,
      string[]
    >;
    const bundled = new Set(listBundledManifestFiles());
    assert.ok(Object.keys(legacy).length > 0, "legacy manifest is empty");
    for (const [relPath, hashes] of Object.entries(legacy)) {
      assert.ok(!bundled.has(relPath), `${relPath} still ships in the bundle`);
      assert.equal(
        existsSync(join(SCAFFOLD_ROOT, relPath)),
        false,
        `${relPath} exists on disk but is in the legacy manifest`,
      );
      assert.ok(hashes.length > 0, `${relPath}: empty history`);
      assert.equal(
        new Set(hashes).size,
        hashes.length,
        `${relPath}: duplicate hash entries`,
      );
    }
  });

  it("is disjoint from the live manifest", () => {
    const legacy = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
      string,
      string[]
    >;
    const live = JSON.parse(
      readFileSync(join(REPO_ROOT, "scaffold", ".file-history.json"), "utf-8"),
    ) as Record<string, string[]>;
    for (const relPath of Object.keys(legacy)) {
      assert.ok(!(relPath in live), `${relPath} is in both manifests`);
    }
  });
});

describe("file-history manifest records releases (SCAF-21)", () => {
  // SCAF-21 records one hash per RELEASED version of a bundled file,
  // plus one working entry for the current content that is rewritten
  // in place between releases. Only a released version can be the
  // content of a target file, so only a released hash can make a
  // target pristine (SCAF-22) — an intermediate commit's hash is
  // unreachable and must not accumulate. Truth therefore comes from
  // the release tags, not from commit history: every version a tag
  // shipped must still be present, in tag order. Without git, or in
  // a shallow clone missing tags, the check covers what is available.
  it("keeps every released version, in order, and nothing unreleased", () => {
    let gitRoot: string;
    let tags: string[];
    try {
      gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      tags = execFileSync("git", ["tag", "--sort=v:refname"], {
        cwd: gitRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split("\n")
        // Only CLI version tags are releases; a working tag (a backup
        // before a history rewrite, say) names no released content and
        // must not be read as one.
        .filter((tag) => /^(cli-)?v\d/.test(tag))
        // Compare versions across the legacy and current namespaces.
        .sort((a, b) =>
          a.replace(/^cli-/, "").localeCompare(b.replace(/^cli-/, ""), "en", {
            numeric: true,
          }),
        );
    } catch {
      return; // not a git checkout
    }
    if (tags.length === 0) return; // no releases to check against

    const manifest = JSON.parse(
      readFileSync(join(gitRoot, "scaffold", ".file-history.json"), "utf-8"),
    ) as Record<string, string[]>;

    const errors: string[] = [];
    for (const [relPath, hashes] of Object.entries(manifest)) {
      // The contents this path shipped, in tag order, deduped.
      // A bundled file keeps its identity across layout renames
      // (specs/dev -> specs/packages, iterations -> intents), so the
      // released contents are gathered over every path it ever had.
      const basename = relPath.slice(relPath.lastIndexOf("/") + 1);
      const candidates = new Set([
        `scaffold/${relPath}`,
        `packages/cli/scaffold/${relPath}`,
      ]);
      try {
        const log = execFileSync(
          "git",
          ["log", "--follow", "--name-only", "--format=", "--", `scaffold/${relPath}`],
          { cwd: gitRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
        );
        for (const line of log.split("\n")) {
          const path = line.trim();
          if (path.endsWith(`/${basename}`)) candidates.add(path);
        }
      } catch {
        // no history for this path; the defaults above still apply
      }

      const released: string[] = [];
      for (const tag of tags) {
        let blob: Buffer | undefined;
        for (const candidate of [...candidates].sort()) {
          try {
            blob = execFileSync("git", ["show", `${tag}:${candidate}`], {
              cwd: gitRoot,
              stdio: ["ignore", "pipe", "ignore"],
            });
            break;
          } catch {
            // path absent at this tag; try the pre-monorepo location
          }
        }
        if (blob === undefined) continue;
        const hash = canonicalContentHash(blob);
        if (!released.includes(hash)) released.push(hash);
      }

      let cursor = 0;
      for (const hash of released) {
        const at = hashes.indexOf(hash, cursor);
        if (at === -1) {
          errors.push(
            `${relPath}: ${hash} shipped in a release but is missing or out of order`,
          );
          break;
        }
        cursor = at + 1;
      }

      // Beyond the released set, only the single working entry is
      // allowed: anything more is per-commit accumulation.
      const extra = hashes.filter((hash) => !released.includes(hash));
      if (extra.length > 1) {
        errors.push(
          `${relPath}: ${extra.length} unreleased entries; rewrite the working entry in place instead of appending`,
        );
      }
    }
    assert.deepEqual(errors, [], errors.join("\n"));
  });
});

describe("file-history manifest (SCAF-21)", () => {
  it("matches the bundled scaffold/specs file set", () => {
    const manifestPath = join(REPO_ROOT, "scaffold", ".file-history.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
      string,
      string[]
    >;
    assert.deepEqual(
      Object.keys(manifest).sort(),
      listBundledManifestFiles(),
    );
  });

  it("stores the current bundled hash as each file's final entry", () => {
    const manifestPath = join(REPO_ROOT, "scaffold", ".file-history.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
      string,
      string[]
    >;
    const errors: string[] = [];
    for (const [relPath, hashes] of Object.entries(manifest)) {
      const uniqueHashes = new Set(hashes);
      if (hashes.length === 0) {
        errors.push(`${relPath}: empty history`);
        continue;
      }
      if (uniqueHashes.size !== hashes.length) {
        errors.push(`${relPath}: duplicate hash entries`);
      }
      const currentHash = canonicalContentHash(
        readFileSync(join(SCAFFOLD_ROOT, relPath)),
      );
      if (hashes[hashes.length - 1] !== currentHash) {
        errors.push(`${relPath}: final hash is not current ${currentHash}`);
      }
    }
    assert.deepEqual(errors, [], errors.join("\n"));
  });
});
