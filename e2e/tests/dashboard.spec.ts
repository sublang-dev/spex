// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The intent ledger as a user works it (dashboard-39, run-view-100's
// sibling flows): capture, start, watch, confirm, and the History that
// results — all through the Dashboard and the run view.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { test, expect, open, nav, send } from "../src/harness";

test.use({ appOptions: { project: true, agentDelayMs: 2500 } });

test("run-view-115, dashboard-39: an intent dropped from the working line leaves Now and lists in History as dropped", async ({
  page,
  app,
}) => {
  await open(page, app);
  await nav(page, "Dashboard").click();
  const add = page.getByRole("textbox", { name: /add an intent to demo-project/i });
  await add.fill("Drop me midway");
  await add.press("Enter");
  await expect(
    page.getByTestId(/^upnext-row-/).filter({ hasText: "Drop me midway" }),
  ).toBeVisible();
  await page.getByTestId("all-clear-start").click();
  await expect(page.getByTestId("start-composer")).toHaveValue("Drop me midway");
  await page.getByTestId("start-send").click();
  await expect(page.getByTestId("captain-pane")).toContainText("/code started");

  // The working line names the intent; Drop sits behind the inline
  // confirm, and Keep hands focus back to the control.
  const line = page.getByTestId("working-line");
  await expect(line).toContainText("Drop me midway");
  await page.getByTestId("working-drop").click();
  await expect(line).toContainText(/work is underway/i);
  await page.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(page.getByTestId("working-drop")).toBeFocused();
  await page.getByTestId("working-drop").click();
  await page.getByRole("button", { name: "Drop", exact: true }).click();
  await expect(line).toHaveCount(0);
  const note = page.getByTestId("working-note");
  await expect(note).toContainText(/dropped “drop me midway”/i);
  await expect(note).toHaveAttribute("role", "status");
  await expect(page.getByTestId("boss-composer")).toBeFocused();

  // Now still shows the live session, but serves no intent: no Drop
  // stands beside it, and the queue holds nothing.
  await nav(page, "Dashboard").click();
  const now = page.getByTestId(`now-session-${app.projectId}`);
  await expect(now).toBeVisible();
  await expect(now).not.toHaveAttribute("data-intent-id", /./);
  await expect(page.getByTestId(`now-drop-${app.projectId}`)).toHaveCount(0);
  await expect(page.getByTestId(/^upnext-row-/)).toHaveCount(0);

  // The turn it was dropped from ends finished: worked, then dropped,
  // so History lists it under the quiet tag, and no verdict is owed.
  const history = page
    .getByTestId(/^history-row-/)
    .filter({ hasText: "Drop me midway" });
  await expect(history).toBeVisible({ timeout: 20_000 });
  await expect(history).toHaveAttribute("data-verdict", "dropped");
  await expect(history).toContainText(/dropped/i);
  await expect(page.getByTestId(/^attention-confirm-/)).toHaveCount(0);
});

test("dashboard-46: a History record opens in the reader and Back returns to its row", async ({
  page,
  app,
}) => {
  // A finished record in the seeded tree: History lists it.
  writeFileSync(
    join(app.projectDir, "specs", "intents", "004-shipped.md"),
    [
      "# IR-004: Shipped already",
      "",
      "## Status",
      "",
      "Done",
      "",
      "## Intent",
      "",
      "This one shipped before the app met the project.",
      "",
    ].join("\n"),
  );
  await open(page, app);
  await nav(page, "Dashboard").click();
  const group = page.getByTestId(`project-group-${app.projectId}`);
  const row = group.getByTestId("history-row-IR-004");
  const opener = row.getByRole("button", { name: /open IR-004/i });
  await expect(row).toContainText("Shipped already");
  await opener.click();

  // The Specs tab, in the records reader, on that record, with Back
  // naming where it came from.
  await expect(page.getByRole("tab", { name: "Specs" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const reader = page.getByTestId("record-reader");
  await expect(reader).toContainText("IR-004");
  await expect(reader).toContainText(/shipped before the app met the project/i);
  const back = page.getByTestId("reader-back");
  await expect(back).toHaveText("← Back to Dashboard");

  // Back: the Dashboard, the project's group in view, the row focused.
  await back.click();
  await expect(reader).toHaveCount(0);
  await expect(group).toBeInViewport();
  await expect(opener).toBeFocused();

  // The same row on the project's Overview returns to the Overview.
  await page.getByTestId(`sidebar-project-${app.projectId}`).click();
  await page.getByRole("tab", { name: "Overview" }).click();
  const overview = page.getByTestId("overview-tab");
  const overviewOpener = overview
    .getByTestId("history-row-IR-004")
    .getByRole("button", { name: /open IR-004/i });
  await overviewOpener.click();
  await expect(reader).toContainText("IR-004");
  await expect(back).toHaveText("← Back to Overview");
  await back.click();
  await expect(reader).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(overviewOpener).toBeFocused();
});

test("dashboard-39: capture, start, confirm, and History through the page", async ({
  page,
  app,
}) => {
  await open(page, app);
  await nav(page, "Dashboard").click();
  const group = page.getByTestId(`project-group-${app.projectId}`);
  await expect(group).toBeVisible();

  // Empty bands carry guidance, never blanks.
  await expect(group).toContainText(/nothing done here yet/i);
  await expect(group).toContainText(/idle/i);
  await expect(group).toContainText(/nothing queued/i);
  await expect(page.getByTestId("attention-all-clear")).toContainText(/all clear/i);

  // Sources stands open (dashboard-20): its summary line heads the
  // tabs, GitHub guidance speaks in GitHub terms, and the seeded
  // example's open records carry their Queue controls. The line folds
  // the band and opens it again.
  const sourcesToggle = page.getByTestId(`sources-toggle-${app.projectId}`);
  await expect(sourcesToggle).toContainText(/open records/i);
  await expect(sourcesToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId(`sources-guidance-${app.projectId}`)).toContainText(/github/i);
  await sourcesToggle.click();
  await expect(sourcesToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId(`sources-guidance-${app.projectId}`)).toHaveCount(0);
  await sourcesToggle.click();
  await page.getByTestId(`sources-tab-records-${app.projectId}`).click();
  const record = page.getByTestId(new RegExp(`^source-record-${app.projectId}-`)).first();
  await expect(record).toBeVisible();

  // Inline capture reveals the row; the all-clear names it next.
  const add = page.getByRole("textbox", { name: /add an intent to demo-project/i });
  await add.fill("Add a README badge");
  await add.press("Enter");
  const row = page.getByTestId(/^upnext-row-/).filter({ hasText: "Add a README badge" });
  await expect(row).toBeVisible();
  await expect(add).toHaveValue("");
  await expect(page.getByTestId("attention-all-clear")).toContainText(/add a readme badge/i);

  // A second intent, removed before it ever ran, leaves no History.
  await add.fill("Second thought");
  await add.press("Enter");
  const second = page.getByTestId(/^upnext-row-/).filter({ hasText: "Second thought" });
  await expect(second).toBeVisible();
  await second.getByRole("button", { name: /actions for second thought/i }).click();
  await page.getByTestId(/^upnext-remove-action-/).click();
  await expect(second).toHaveCount(0);
  await expect(group).toContainText(/nothing done here yet/i);

  // Queue from a record: the row wears its provenance.
  await record.getByRole("button", { name: /queue/i }).click();
  await expect(page.getByTestId(/^upnext-row-/)).toHaveCount(2);
  await expect(page.getByTestId(/^upnext-row-/).nth(1)).toContainText(/IR-\d+/);

  // Start stages the head intent into the composer; Send dispatches.
  await page.getByTestId("all-clear-start").click();
  await expect(page.getByTestId("staged-intent-chip")).toContainText(/add a readme badge/i);
  await expect(page.getByTestId("start-composer")).toHaveValue("Add a README badge");
  await page.getByTestId("start-send").click();
  await expect(page.getByTestId("captain-pane")).toContainText("/code started");

  // Now shows the live session while it runs; the badge is quiet.
  await nav(page, "Dashboard").click();
  await expect(page.getByTestId(`now-session-${app.projectId}`)).toBeVisible();
  await expect(page.getByTestId(/^upnext-row-/)).toHaveCount(1);

  // Finished: the attention entry, its Confirm, then History.
  const confirm = page.getByTestId(/^attention-confirm-/);
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("nav-attention-badge")).toContainText("1");
  await confirm.click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId("nav-attention-badge")).toHaveCount(0);
  const history = page.getByTestId(/^history-row-/).filter({ hasText: "Add a README badge" });
  await expect(history).toBeVisible();
  await expect(history).not.toContainText(/dropped/i);
  await expect(group).not.toContainText(/nothing done here yet/i);
  // The next queued intent moved up, and the all-clear names it.
  await expect(page.getByTestId("attention-all-clear")).toContainText(/IR-\d+|next up/i);
});

test.describe("the History frame", () => {
  // Twenty-five worked, closed intents before boot: one full intent
  // page, then a second one behind "Older…".
  test.use({ appOptions: { project: true, history: 25 } });

  test("dashboard-44: History scrolls inside a frame eight rows tall that Older… never grows", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await nav(page, "Dashboard").click();
    const projectId = app.projectId!;
    const frame = page.getByTestId(`history-frame-${projectId}`);
    const rows = frame.getByTestId(/^history-row-/);
    const older = page.getByTestId(`history-older-${projectId}`);
    const group = page.getByTestId(`project-group-${projectId}`);
    const heightOf = (el: HTMLElement) => el.getBoundingClientRect().height;
    const scrolls = (el: HTMLElement) => el.scrollHeight > el.clientHeight;

    // The first page lists whole inside the frame, which is exactly
    // eight rows tall and scrolls; the control is its last item.
    await expect(older).toHaveText("Older…");
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(20);
    const rowHeight = await rows.first().evaluate(heightOf);
    const frameHeight = await frame.evaluate(heightOf);
    expect(frameHeight).toBeCloseTo(rowHeight * 8, 0);
    expect(await frame.evaluate(scrolls)).toBe(true);
    await expect(frame).toHaveAttribute("data-overflowing", "true");
    expect(await frame.evaluate((el) => el.lastElementChild?.textContent)).toBe("Older…");
    const groupHeight = await group.evaluate(heightOf);
    const countBefore = await rows.count();

    // Older… appends the next page: the rows grow, the frame and the
    // group do not, and the control leaves once nothing waits.
    await older.click();
    await expect.poll(() => rows.count()).toBeGreaterThan(countBefore);
    await expect(older).toHaveCount(0);
    expect(await frame.evaluate(heightOf)).toBeCloseTo(frameHeight, 0);
    expect(await group.evaluate(heightOf)).toBeCloseTo(groupHeight, 0);
    expect(await frame.evaluate(scrolls)).toBe(true);
    // Every row is one frame unit tall.
    for (const height of await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
      expect(height).toBeCloseTo(rowHeight, 0);
    }

    // The frame takes keyboard focus and scrolls by arrow key.
    await frame.focus();
    await expect(frame).toBeFocused();
    await page.keyboard.press("End");
    await expect.poll(() => frame.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // The Overview draws the same frame for this project.
    await page.getByRole("button", { name: "Workspace" }).click();
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByTestId("overview-tab")).toBeVisible();
    await expect(frame).toBeVisible();
    expect(await frame.evaluate(heightOf)).toBeCloseTo(frameHeight, 0);
    expect(await frame.evaluate(scrolls)).toBe(true);
  });

  test("dashboard-48: the reader pulls the frame's edge, and it stays pulled", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await nav(page, "Dashboard").click();
    const projectId = app.projectId!;
    const frame = page.getByTestId(`history-frame-${projectId}`);
    const grip = page.getByTestId(`history-frame-${projectId}-grip`);
    const heightOf = (el: HTMLElement) => el.getBoundingClientRect().height;
    const scrolls = (el: HTMLElement) => el.scrollHeight > el.clientHeight;

    // The grip stands while the rows run past the frame, names itself,
    // and reports the height in rows.
    await expect(grip).toBeVisible();
    await expect(grip).toHaveAttribute("aria-label", "Resize History");
    await expect(grip).toHaveAttribute("aria-valuenow", "8");
    await expect(grip).toHaveAttribute("aria-valuemin", "4");
    await expect(grip).toHaveAttribute("aria-valuemax", "24");
    const rowHeight = await frame
      .getByTestId(/^history-row-/)
      .first()
      .evaluate(heightOf);
    const before = await frame.evaluate(heightOf);

    // Dragged down two rows, the frame is two rows taller and still
    // scrolls what it cannot show.
    await grip.hover();
    const handle = (await grip.boundingBox())!;
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.down();
    await page.mouse.move(x, y + 2 * rowHeight, { steps: 8 });
    await page.mouse.up();
    await expect(grip).toHaveAttribute("aria-valuenow", "10");
    expect(await frame.evaluate(heightOf)).toBeCloseTo(before + 2 * rowHeight, 0);
    expect(await frame.evaluate(scrolls)).toBe(true);

    // Chrome state is preference, not project state (DR-030): a reload
    // finds the frame where the reader left it.
    await page.reload();
    await nav(page, "Dashboard").click();
    await expect(frame).toBeVisible();
    expect(await frame.evaluate(heightOf)).toBeCloseTo(before + 2 * rowHeight, 0);
    await expect(page.getByTestId(`history-frame-${projectId}-grip`)).toHaveAttribute(
      "aria-valuenow",
      "10",
    );
  });
});

test.describe("the Running band", () => {
  // Long enough that the turn is still in flight while the band is
  // read, watched, and opened from.
  test.use({ appOptions: { project: true, agentDelayMs: 8000 } });

  test("dashboard-51: a running session lists in its own band, opens from it, and leaves when its turn ends", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await send(page, "Add a README badge");
    await expect(page.getByTestId("captain-pane")).toContainText("/code started");

    // The Dashboard: the band names the project, the session's title,
    // and what it is doing — no summons stands, so the queue is clear.
    await nav(page, "Dashboard").click();
    const row = page.getByTestId(/^running-session-/);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("demo-project");
    await expect(row).toContainText("Add a README badge");
    // What it is doing, in human words: the running player and the
    // engagement state, never a wire id (the raw id rides the title).
    const doing = page.getByTestId(/^running-state-/);
    await expect(doing).toHaveText(/^[a-z][a-z. ]*$/);
    await expect(page.getByTestId("attention-all-clear")).toBeVisible();

    // The row opens its session.
    await row.click();
    await expect(page.getByTestId("captain-pane")).toBeVisible();
    await expect(page.getByTestId("boss-composer")).toBeVisible();

    // The turn ends: the row leaves, and the band keeps its place
    // with its note.
    await nav(page, "Dashboard").click();
    await expect(row).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("running-band")).toContainText(
      "Nothing running.",
    );
  });
});

test("dashboard-39: the row menu moves, removes with Undo, and closes on Escape", async ({
  page,
  app,
}) => {
  await open(page, app);
  await nav(page, "Dashboard").click();
  const add = page.getByRole("textbox", { name: /add an intent to demo-project/i });
  const rows = page.getByTestId(/^upnext-row-/);
  await add.fill("First");
  await add.press("Enter");
  await expect(rows).toHaveCount(1);
  await add.fill("Second");
  await add.press("Enter");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("First");

  // Move down from the menu: a single-pointer alternative to dragging.
  const trigger = page.getByRole("button", { name: /actions for first/i });
  await trigger.click();
  const menu = page.getByRole("menu", { name: /actions for first/i });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Move down" }).click();
  await expect(rows.nth(0)).toContainText("Second");
  await expect(rows.nth(1)).toContainText("First");

  // Escape closes the menu and puts focus back on its trigger.
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // Remove, then Undo brings the row back where it was.
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Remove" }).click();
  await expect(rows).toHaveCount(1);
  const removed = page.getByTestId(`upnext-removed-${app.projectId}`);
  await expect(removed).toContainText(/removed/i);
  await expect(removed).toHaveAttribute("role", "status");
  await removed.getByRole("button", { name: "Undo" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("First");
  await expect(removed).toBeHidden();
});

test.describe("removing a History row", () => {
  // Three intents already worked and confirmed before boot.
  test.use({ appOptions: { project: true, history: 3 } });

  test("dashboard-52: a done intent leaves History behind the confirm and stays gone", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await nav(page, "Dashboard").click();
    const projectId = app.projectId!;
    const band = page.getByTestId(`history-${projectId}`);
    // By id, not by text: the confirm takes the row's place while it
    // stands, so its title is not there to match on.
    const row = band.getByTestId("history-row-72000000-0000-4000-8000-000000000003");
    const neighbour = band.getByTestId("history-row-72000000-0000-4000-8000-000000000002");
    await expect(row).toContainText("Seeded done work 3");
    const control = row.getByRole("button", {
      name: "Remove Seeded done work 3 from history",
    });

    // Keep backs out: the row stays on the record.
    await row.hover();
    await control.click();
    await expect(row).toContainText("Remove this intent from history?");
    await row.getByRole("button", { name: "Keep", exact: true }).click();
    await expect(control).toBeFocused();
    await expect(row).toBeVisible();

    // Remove takes it out at once; its neighbours stay.
    await control.click();
    await row.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(neighbour).toBeVisible();

    // The act is durable: a reload lists it nowhere.
    await page.reload();
    await nav(page, "Dashboard").click();
    await expect(neighbour).toBeVisible();
    await expect(row).toHaveCount(0);

    // The Overview draws the same rows with the same control.
    await page.getByRole("button", { name: "Workspace" }).click();
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByTestId("overview-tab")).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(
      neighbour.getByRole("button", {
        name: "Remove Seeded done work 2 from history",
      }),
    ).toBeVisible();
  });
});
