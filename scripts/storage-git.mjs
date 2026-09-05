#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../packages/core/dist/store.js";
import { isWorkTreeRoot } from "../packages/core/dist/forge.js";
import { planStorageMerge, reserveStorageHome, selectStorageMerge, validateStorageTree } from "../packages/core/dist/storage-git.js";

const args = process.argv.slice(2);
const homeAt = args.indexOf("--home");
const home = homeAt >= 0 ? args.splice(homeAt, 2)[1] : process.env.SPEX_HOME?.trim() ? process.env.SPEX_HOME : join(homedir(), ".spex");
const operation = args.shift();
try {
  if (!home) throw new Error("--home requires a path");
  if (operation === "plan" && args.length === 2) console.log(JSON.stringify(planStorageMerge(home, args[0], args[1]), null, 2));
  else if (operation === "select") {
    const choices = {};
    for (const item of args) {
      const split = item.lastIndexOf("="); const name = item.slice(0, split); const side = item.slice(split + 1);
      if (split < 1 || !["ours", "theirs"].includes(side) || Object.hasOwn(choices, name)) throw new Error(`invalid choice ${item}; use unit=ours or unit=theirs once per unit`);
      choices[name] = side;
    }
    console.log(JSON.stringify(await selectStorageMerge(home, choices), null, 2));
  } else if (operation === "validate" && args.length === 0) {
    const release = reserveStorageHome(home);
    try { console.log(JSON.stringify(await validateStorageTree(home), null, 2)); } finally { release(); }
  } else if (operation === "rebind" && args.length >= 2) {
    const id = args.shift(); const path = resolve(args.shift().replace(/^~(?=\/|$)/, homedir()));
    let revision; let aliases;
    while (args.length) {
      const option = args.shift(); const value = args.shift();
      if (!value || !["--alias", "--revision"].includes(option)) throw new Error("rebind accepts --alias <recorded-path> and --revision <ancestor>");
      if (option === "--alias") (aliases ??= []).push(value);
      else { if (revision !== undefined) throw new Error("select one --revision"); revision = value; }
    }
    if (!(await isWorkTreeRoot(path))) throw new Error(`${path} is not the root of a Git work tree`);
    if (revision && !(await isWorkTreeRoot(home))) throw new Error("restoring from Git requires Spex home itself to be the work-tree root");
    const store = new Store({ dir: resolve(home) });
    try {
      const project = store.rebindProject({ id, path, ...(aliases ? { aliases } : {}), ...(revision ? { revision } : {}) });
      await store.initializeSessions();
      console.log(JSON.stringify({ project, diagnostics: [...store.validateStorage(), ...store.sessionDiagnostics()] }, null, 2));
    } finally { store.close(); }
  } else throw new Error("Usage: node scripts/storage-git.mjs [--home path] plan <ours> <theirs> | select [unit=ours|theirs ...] | validate | rebind <project-id> <path> [--alias recorded-path] [--revision ancestor]");
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
