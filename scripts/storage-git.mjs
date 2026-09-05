#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { homedir } from "node:os";
import { join } from "node:path";
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
  } else throw new Error("Usage: node scripts/storage-git.mjs [--home path] plan <ours> <theirs> | select [unit=ours|theirs ...] | validate");
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
