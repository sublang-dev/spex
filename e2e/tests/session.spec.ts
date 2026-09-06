// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// A session end to end (run-view-98, run-view-99, server-shell-21): the
// served page, its token gone from the address bar, running the
// scripted Captain's narration through the real core.

import { test, expect, open, send } from "../src/harness";

test.use({ appOptions: { project: true, agentDelayMs: 1500 } });

test("server-shell-21: the token URL connects, scrubs, and reloads", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(page).toHaveURL(`${app.origin}/`);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText(/reconnecting to the spex core/i)).toHaveCount(0);
  // The overrides drive the served core: the fake environment is ready.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText(/claude/).first()).toBeVisible();
  await expect(page.getByText(/not ready|aren't ready/i)).toHaveCount(0);
});

test("run-view-98: the first task runs, queues, and ends", async ({ page, app }) => {
  await open(page, app);
  const home = page.getByTestId("captain-home");
  await expect(home).toContainText("demo-project");

  await send(page, "Fix the token refresh in auth.ts");

  // The tab and the sidebar row carry the task as the title.
  const tab = page.getByRole("tab", { name: /fix the token refresh/i });
  await expect(tab).toBeVisible();
  const tree = page.getByRole("tree", { name: "Projects and sessions" });
  await expect(tree).toContainText(/fix the token refresh/i);

  // The Captain narrates; the machine card draws the code run with
  // its nested review.
  const captain = page.getByTestId("captain-pane");
  await expect(captain).toContainText("/code started");
  const machines = page.getByTestId("live-machines");
  await expect(machines).toContainText(/code/i);

  // One pane per roster player; the coder streams and uses tools.
  const coder = page.getByTestId("player-pane-dev.coder");
  const reviewer = page.getByTestId("player-pane-dev.reviewer");
  await expect(coder).toBeVisible();
  await expect(reviewer).toBeVisible();
  await expect(coder).toContainText(/editing/i);
  await expect(coder).toContainText(/Edit|Read/);

  // A message during the turn queues — never reads as sent — and
  // goes out when the turn ends.
  const box = page.getByTestId("boss-composer");
  await expect(box).toHaveAttribute("placeholder", /sends after this turn/i);
  await box.fill("Also add a test for expiry skew");
  await page.getByRole("button", { name: "Send next", exact: true }).click();
  await expect(page.getByTestId("queue-indicator")).toBeVisible();
  await expect(page.getByTestId("queue-indicator")).toContainText(/expiry skew/i);
  await expect(page.getByTestId("queue-indicator")).toContainText(
    "sends when this turn ends",
  );
  await expect(captain).toContainText("/code finished");
  await expect(captain).toContainText(/review/i);
  await expect(coder).toContainText(/\$0\.12|2,?400/);
  // The queued message became the next turn.
  await expect(captain.getByTestId("boss-bubble").filter({ hasText: /expiry skew/i })).toBeVisible();
  await expect(page.getByTestId("queue-indicator")).toHaveCount(0);
  await expect(captain).toContainText("/code finished");

  // Text shelved instead of sent (run-view-85): the control and its
  // note name where it went, and the Overview's Up next holds it.
  await box.fill("Later: tighten the expiry tests");
  await page.getByRole("button", { name: "Add to Up next", exact: true }).click();
  await expect(page.getByTestId("queued-intent-note")).toHaveText(
    "Added to Up next — see the project's Overview.",
  );
  await expect(box).toHaveValue("");
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByTestId(`upnext-${app.projectId}`)).toContainText(
    /tighten the expiry tests/i,
  );
  await tab.click();
  await expect(box).toHaveAttribute("placeholder", "Message the Captain…");

  // Ending: the inline confirm says a message can continue it, then
  // the notice reads the paused conversation above the composer,
  // which stays (run-view-33, DR-042).
  await page.getByTestId("end-session").click();
  await expect(page.getByRole("button", { name: "Keep", exact: true })).toBeVisible();
  await expect(page.getByText(/A message can continue it later/)).toBeVisible();
  await page.getByRole("button", { name: "End", exact: true }).click();
  await expect(page.getByTestId("ended-notice")).toContainText("a message continues it");
  await expect(page.getByTestId("boss-composer")).toBeEnabled();
  await expect(page.getByRole("button", { name: "New session", exact: true })).toBeVisible();
  await expect(tree).toContainText(/fix the token refresh/i);
});

test("run-view-99: a player question parks the session until the Boss replies", async ({
  page,
  app,
}) => {
  await open(page, app);
  await send(page, "ask before migrating");

  const question = page.getByTestId("question-bubble");
  await expect(question).toContainText(/migrate the legacy sessions/i);
  await expect(question).toContainText(/coder/i);
  const chip = page.getByTestId("state-chip");
  await expect(chip).toContainText(/wait/i);
  const box = page.getByTestId("boss-composer");
  await expect(box).toHaveAttribute("placeholder", /reply to coder/i);
  // A question is visible before the Boss turn's checkpoint settles.
  // The settled composer, not the text alone, authorizes the reply.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(box).toBeEnabled();
  await expect(page.getByTestId("session-external-owner")).toHaveCount(0);

  await box.fill("Yes, migrate them too");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const captain = page.getByTestId("captain-pane");
  await expect(captain).toContainText("/code finished");
  await expect(chip).not.toContainText(/wait/i);
});

// The working lane comes into view (run-view-7): stacked at a narrow
// width, the coder's pane starts below the fold and the grid scrolls
// to it when its call opens.
test("run-view-7: a lane's pane scrolls into view when its call opens", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 600, height: 500 });
  await open(page, app);
  await send(page, "Fix the token refresh in auth.ts");
  const grid = page.getByTestId("player-grid");
  const coder = page.getByTestId("player-pane-dev.coder");
  await expect(coder).toContainText("coder working");
  await expect
    .poll(async () => {
      const g = await grid.boundingBox();
      const p = await coder.boundingBox();
      if (!g || !p) return false;
      return p.y + 40 <= g.y + g.height && p.y >= g.y - 1;
    })
    .toBe(true);
});

// A lane folds to a rail and returns for its call (run-view-118): the
// reviewer's idle lane collapses while the session is parked on a
// question, and unfolds itself when the nested review calls it.
test("run-view-118: a collapsed lane unfolds when its call opens", async ({
  page,
  app,
}) => {
  await open(page, app);
  await send(page, "ask before migrating");
  await expect(page.getByTestId("question-bubble")).toBeVisible();

  const coder = page.getByTestId("player-pane-dev.coder");
  const reviewer = page.getByTestId("player-pane-dev.reviewer");
  const wholeWidth = (await coder.boundingBox())!.width;
  await page.getByRole("button", { name: "Collapse dev.reviewer" }).click();
  // The rail: narrow, named within its box, its expand control focused
  // — and the coder's pane took the freed width (run-view-116).
  await expect(page.getByRole("button", { name: "Expand dev.reviewer" })).toBeFocused();
  await expect(reviewer).toHaveAttribute("data-collapsed", "true");
  const rail = (await reviewer.boundingBox())!;
  expect(rail.width).toBeLessThanOrEqual(40);
  const name = (await page.getByTestId("player-name-dev.reviewer").boundingBox())!;
  expect(name.x).toBeGreaterThanOrEqual(rail.x - 1);
  expect(name.x + name.width).toBeLessThanOrEqual(rail.x + rail.width + 1);
  expect(name.y).toBeGreaterThanOrEqual(rail.y - 1);
  expect(name.y + name.height).toBeLessThanOrEqual(rail.y + rail.height + 1);
  expect((await coder.boundingBox())!.width).toBeGreaterThan(wholeWidth);

  // The reply runs the code narration: the coder works in view, then
  // the nested review calls the reviewer and its lane unfolds itself
  // (run-view-7, run-view-117).
  await page.getByTestId("boss-composer").fill("Yes, migrate them too");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(coder).toContainText("coder working");
  await expect(coder).toBeInViewport();
  await expect(reviewer).not.toHaveAttribute("data-collapsed", "true");
  await expect(page.getByRole("button", { name: "Collapse dev.reviewer" })).toBeVisible();
  await expect(reviewer).toContainText(/Review/);
  await expect(page.getByTestId("captain-pane")).toContainText("/code finished");
});

// Chrome that moves with no window resize behind it (run-view-121):
// showing the sidebar narrows the panes, so the draft rewraps to more
// lines than the field was fitted for and the transcript's content
// grows taller than the box it was pinned in.
test("run-view-121: showing the sidebar keeps the draft whole and the thread at its end", async ({
  page,
  app,
}) => {
  // Short enough that the thread outgrows its pane and has an end to
  // keep following.
  await page.setViewportSize({ width: 1000, height: 420 });
  await open(page, app);
  await send(page, "Fix the token refresh in auth.ts");
  const captain = page.getByTestId("captain-pane");
  await expect(captain).toContainText("/code finished");
  await page.getByRole("button", { name: "Collapse the sidebar" }).click();

  const thread = captain.locator("div.overflow-y-auto").first();
  const bottomGap = () =>
    thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(bottomGap).toBeLessThan(40);

  const field = page.getByTestId("boss-composer");
  // Long enough that the sidebar's 224px costs the draft two lines.
  await field.fill(
    "Fix the token refresh in auth.ts and update the docs so the next reader knows why the refresh window is ninety seconds and not five minutes, then note the same reasoning in the migration guide and in the changelog entry so nobody reopens this thread to find it.",
  );
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  await settle();
  const shortfall = () =>
    field.evaluate((el) => {
      const kept = el.style.height;
      el.style.height = "auto";
      const needed = el.scrollHeight;
      el.style.height = kept;
      return needed - (parseFloat(kept) || 0);
    });
  expect(await shortfall()).toBeLessThanOrEqual(1);

  // The one gesture, and no window resize to repair either box.
  await page.getByRole("button", { name: "Show the sidebar" }).click();
  await settle();
  expect(await shortfall()).toBeLessThanOrEqual(1);
  expect(await bottomGap()).toBeLessThan(40);
});

// A queue the Boss keeps filling while a turn runs (run-view-106): it
// used to push the transcript to two pixels and carry the composer out
// of the window with the page growing behind it. The turn is long
// enough that every message queues.
test.describe("a turn long enough to queue behind", () => {
  test.use({ appOptions: { project: true, agentDelayMs: 120_000 } });

  test("run-view-106: a long queue keeps the composer in the window", async ({
    page,
    app,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 900, height: 700 });
    await open(page, app);
    await send(page, "/code add a hello world function");
    await expect(page.getByTestId("abort-button")).toBeVisible();

    const queue = page.getByTestId("queue-indicator");
    const box = page.getByTestId("boss-composer");
    for (let index = 1; index <= 6; index += 1) {
      await box.fill(
        `Queued ${index}: also update the readme, the changelog, and the migration notes so the next reader knows why`,
      );
      await page.getByRole("button", { name: "Send next", exact: true }).click();
      await expect(queue).toContainText(`Queued ${index}:`);
    }

    // The queue is a frame a few entries tall, showing its end.
    const frame = (await queue.boundingBox())!;
    expect(frame.height).toBeLessThanOrEqual(200);
    const newest = (await queue
      .locator("> div")
      .last()
      .boundingBox())!;
    expect(newest.y).toBeGreaterThanOrEqual(frame.y - 1);
    expect(newest.y + newest.height).toBeLessThanOrEqual(frame.y + frame.height + 1);

    // The transcript keeps a readable share, and the action row is
    // still in the window with the page unmoved (DR-041 §9).
    const pane = (await page.getByTestId("captain-pane").boundingBox())!;
    expect(pane.height).toBeGreaterThan(40);
    for (const control of ["abort-button", "send-button"]) {
      const rect = (await page.getByTestId(control).boundingBox())!;
      expect(rect.y + rect.height, control).toBeLessThanOrEqual(700);
    }
    expect(
      await page.evaluate(() => [
        document.documentElement.scrollHeight,
        document.documentElement.clientHeight,
      ]),
    ).toEqual([700, 700]);
  });
});
