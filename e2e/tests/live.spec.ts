// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The live lane (run-view-104): the machine's signed-in agents and the
// real Captain, a minimal no-change task observed to a player's live
// output, then aborted — under DR-020's budget. Runs only with
// SPEX_E2E_LIVE=1.

import { test, expect, open, send, LIVE } from "../src/harness";

test.use({ appOptions: { config: "none", project: true } });

test("run-view-104 @live: a real /code task shows live output and aborts cleanly", async ({
  page,
  app,
}) => {
  test.skip(!LIVE, "live lane only");
  await open(page, app);
  await expect(page.getByTestId("captain-home")).toContainText("demo-project");
  // The seeded template's agents must be ready on this machine, or the
  // lane proves nothing: fail early, naming what is not signed in.
  await expect(page.getByTestId("captain-home")).not.toContainText(/aren't ready/i);

  await send(
    page,
    "/code Append a single line reading `smoke ok` to the end of README.md. Change nothing else.",
  );
  const captain = page.getByTestId("captain-pane");
  await expect(captain).toBeVisible();
  const attach = async (label: string) => {
    await test.info().attach(label, {
      body: [
        "--- captain ---",
        await captain.innerText(),
        "--- players ---",
        await page.getByTestId("player-grid").innerText(),
      ].join("\n"),
      contentType: "text/plain",
    });
  };

  // A player is dispatched and its pane fills with live output: the
  // running mark first, then real text from the agent.
  const running = page.getByTestId("player-running").first();
  await expect(running).toBeVisible({ timeout: 8 * 60_000 });
  const pane = page
    .getByTestId(/^player-pane-/)
    .filter({ has: page.getByTestId("player-running") })
    .first();
  await expect
    .poll(async () => (await pane.innerText()).length, { timeout: 8 * 60_000 })
    .toBeGreaterThan(200);
  await attach("live output");
  await expect(captain).not.toContainText(/turn failed/i);

  // Abort acknowledges at once and the turn ends aborted.
  const abort = page.getByTestId("abort-button");
  await abort.click();
  await expect(abort).toContainText(/aborting/i);
  await expect(captain).toContainText(/abort/i, { timeout: 90_000 });
  await expect(page.getByTestId("boss-composer")).toBeEnabled({ timeout: 90_000 });
  await attach("after abort");

  // Nothing ends (DR-051): the session reads idle with its composer
  // ready for the next message.
  await expect(page.getByTestId("end-session")).toHaveCount(0);
  await expect(page.getByTestId("history-notice")).toHaveCount(0);
});
