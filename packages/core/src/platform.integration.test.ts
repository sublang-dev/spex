// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("core-service-90: unsupported native startup refuses before creating storage", () => {
  const scratch = mkdtempSync(join(tmpdir(), "spex-platform-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { existsSync } from "node:fs";
      import { CoreService } from ${JSON.stringify(new URL("./service.js", import.meta.url).href)};
      const nativePlatform = process.platform;
      // Windows CI exercises the real platform. Other hosts exercise only
      // the refusal branch; they do not claim Windows filesystem coverage.
      if (nativePlatform !== "win32") {
        Object.defineProperty(process, "platform", { value: "win32" });
      }
      const dataDir = ${JSON.stringify(join(scratch, "state"))};
      const configPath = ${JSON.stringify(join(scratch, "config", "playbook.yaml"))};
      await assert.rejects(
        CoreService.start({ dataDir, configPath }),
        /require macOS or Linux.*On Windows, use the scaffold CLI or connect to a Spex server/,
      );
      assert.equal(existsSync(dataDir), false);
      assert.equal(existsSync(configPath), false);
      assert.equal(existsSync(${JSON.stringify(join(scratch, "config"))}), false);
      console.log("native platform: " + nativePlatform);
    `], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`native platform: ${process.platform}`));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
