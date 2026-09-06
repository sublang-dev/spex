// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Browser acceptance journeys (DR-039): Chromium over the served UI
// bundle against a real core. The hermetic lane is the default; the
// live lane (SPEX_E2E_LIVE=1, `@live` tests) uses the machine's
// signed-in agents under DR-020's wait budget.

import { defineConfig, devices } from "@playwright/test";

const live = process.env.SPEX_E2E_LIVE === "1";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Each journey runs a browser and a real core; avoid host-dependent load.
  workers: 1,
  timeout: live ? 10 * 60_000 : 45_000,
  expect: { timeout: live ? 60_000 : 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  // Every test boots its own shell on a scratch root; live journeys
  // only run when asked for, hermetic ones only when not.
  grep: live ? /@live/ : undefined,
  grepInvert: live ? undefined : /@live/,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The shell serves loopback plaintext; nothing is remote.
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
