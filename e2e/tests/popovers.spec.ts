// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// What only opens on a gesture (settings-33, playbook-library-43,
// projects-30, spec-view-59, spec-view-26, dashboard-49; DR-041 §9):
// the fit journey measures every surface at every width but never
// opens a popover, hovers a graph node, or shows the palette, so the
// chrome that appears in place is measured here — each box lying
// inside the box that must show it, with the page scrolling in
// neither direction.

import type { Locator, Page } from "@playwright/test";

import { test, expect, open, nav } from "../src/harness";

const FLOOR = 320;
const SHORT = 400;
const TOLERANCE = 1;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, "the element has no box").not.toBeNull();
  return box!;
}

/** The page scrolls in neither direction (DR-041 §9). */
async function pageDoesNotScroll(page: Page): Promise<void> {
  const scroll = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      sideways: root.scrollWidth - root.clientWidth,
      down: root.scrollHeight - root.clientHeight,
      width: root.clientWidth,
      height: root.clientHeight,
    };
  });
  expect(scroll.sideways, "the page scrolls sideways").toBeLessThanOrEqual(TOLERANCE);
  expect(scroll.down, "the page scrolls vertically").toBeLessThanOrEqual(TOLERANCE);
}

/** `inner` lies inside `outer`, named when it does not. */
function expectInside(inner: Box, outer: Box, what: string): void {
  expect(
    Math.round(inner.x),
    `${what} starts left of its box (${Math.round(inner.x)} of ${Math.round(outer.x)})`,
  ).toBeGreaterThanOrEqual(Math.round(outer.x) - TOLERANCE);
  expect(
    Math.round(inner.x + inner.width),
    `${what} ends right of its box`,
  ).toBeLessThanOrEqual(Math.round(outer.x + outer.width) + TOLERANCE);
  expect(Math.round(inner.y), `${what} starts above its box`).toBeGreaterThanOrEqual(
    Math.round(outer.y) - TOLERANCE,
  );
  expect(
    Math.round(inner.y + inner.height),
    `${what} ends below its box`,
  ).toBeLessThanOrEqual(Math.round(outer.y + outer.height) + TOLERANCE);
}

async function viewport(page: Page): Promise<Box> {
  const size = page.viewportSize()!;
  return { x: 0, y: 0, width: size.width, height: size.height };
}

/** Collapse the sidebar, so the 320px floor is measured with the rail
 * out of the way as DR-041 states it. */
async function collapseRail(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const control = page.getByRole("button", { name: "Collapse the sidebar" });
  if (await control.isVisible()) await control.click();
  await expect(page.getByRole("button", { name: "Show the sidebar" })).toBeVisible();
}

test.describe("the role editors on the Playbooks surface", () => {
  let releaseDiscovery: (() => void) | undefined;
  test.use({ appOptions: {
    discoverAgentModels: async () => {
      await new Promise<void>((resolve) => { releaseDiscovery = resolve; });
      return { status: "available", models: [{ id: "fixture-model", name: "Fixture model" }] };
    },
  } });
  test.afterEach(() => releaseDiscovery?.());

  async function finishDiscovery(editor: Locator): Promise<void> {
    await expect(editor).toContainText("Loading model options…");
    await expect.poll(() => Boolean(releaseDiscovery)).toBe(true);
    releaseDiscovery!();
    releaseDiscovery = undefined;
    await expect(editor).toContainText("Models reported by the installed runtime.");
  }

  test("settings-29, playbook-library-41: an editor opened at a role's control stands inside the pane", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await collapseRail(page);
    await nav(page, "Playbooks").click();
    await expect(page.getByTestId("builtins-section")).toBeVisible();

    for (const width of [FLOOR, 480, 1280]) {
      await page.setViewportSize({ width, height: 800 });

      // The agent editor hangs from a 24px gear near the left of its
      // card, and asks for 384px (settings-33).
      const gear = page.getByTestId(/^builtin-player-/).first();
      await gear.click();
      const popover = page.getByTestId("agent-popover");
      await expect(popover).toBeVisible();
      expectInside(
        await boxOf(popover),
        await viewport(page),
        `the agent editor at ${width}px`,
      );
      // Resolve discovery only after the initial fit: the model picker,
      // custom-value warning and tuning guidance grow the open dialog.
      await finishDiscovery(popover);
      await expect(async () => expectInside(
        await boxOf(popover), await viewport(page),
        `the agent editor after discovery at ${width}px`,
      )).toPass();
      await expect(popover.getByTestId("agent-adapter-claude")).toBeVisible();
      expectInside(
        await boxOf(popover.getByTestId("agent-adapter-claude")),
        await boxOf(popover),
        `the adapter group at ${width}px`,
      );
      await pageDoesNotScroll(page);
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);

      // The binding editor grows rightwards from a control that sits
      // further along a wrapping roles row (playbook-library-43).
      const bind = page.getByTestId("role-bind-review-reviewer");
      await bind.scrollIntoViewIfNeeded();
      await bind.click();
      const editor = page.getByTestId("binding-editor-reviewer");
      await expect(editor).toBeVisible();
      expectInside(
        await boxOf(editor),
        await viewport(page),
        `the binding editor at ${width}px`,
      );
      await finishDiscovery(editor);
      await editor.getByTestId("binding-model-mode").selectOption("pin");
      await expect(editor.getByTestId("binding-model-value")).toBeVisible();
      await expect(async () => expectInside(
        await boxOf(editor), await viewport(page),
        `the binding editor after pinning a custom model at ${width}px`,
      )).toPass();
      await pageDoesNotScroll(page);
      await page.keyboard.press("Escape");
      await expect(editor).toHaveCount(0);
    }
  });
});

test.describe("the project palette", () => {
  test.use({ appOptions: { project: true } });

  test("projects-28: a refused path shows its message inside a short window", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await page.setViewportSize({ width: 900, height: SHORT });
    await page.getByRole("button", { name: "Switch or add a project" }).click();
    const palette = page.getByRole("dialog", {
      name: /Add a project|Choose a project/,
    });
    await expect(palette).toBeVisible();

    // The home directory is no git work tree, so the palette refuses
    // it and says why (projects-1) — the message a 400px-tall window
    // used to cut off (projects-30).
    await palette.getByTestId("palette-path").fill(app.home);
    await palette.getByTestId("palette-add").click();
    const message = palette.getByTestId("palette-error");
    await expect(message).toBeVisible();
    const window = await viewport(page);
    expectInside(await boxOf(palette), window, "the palette");
    expectInside(await boxOf(message), window, "the palette's message");
    await pageDoesNotScroll(page);
  });
});

test.describe("the Specs surface at its floor", () => {
  test.use({ appOptions: { project: true } });

  test("spec-view-56: the outline keeps its height and the graph's card stays in its pane", async ({
    page,
    app,
  }) => {
    await open(page, app);
    await collapseRail(page);
    await page.getByRole("tab", { name: "Specs" }).click();
    await expect(page.getByTestId("specv-live")).toBeVisible();
    const graphToggle = page.getByTestId("view-graph");
    if ((await graphToggle.getAttribute("aria-pressed")) !== "true") {
      await graphToggle.click();
    }
    await expect(graphToggle).toHaveAttribute("aria-pressed", "true");

    // Narrow and short: the split stacks, and the outline's filter row
    // wraps to three lines (spec-view-59).
    await page.setViewportSize({ width: FLOOR, height: SHORT });
    const outline = page.getByTestId("specs-outline");
    await expect(outline).toBeVisible();
    const list = await boxOf(outline);
    expect(list.height, "the outline collapsed to nothing").toBeGreaterThan(40);
    await expect(page.getByTestId(/^file-toggle-/).first()).toBeVisible();
    await pageDoesNotScroll(page);

    // The details card is centred on its mark, so the marks at the
    // pane's own edges are where it used to paint outside
    // (spec-view-26). Keyboard focus asks for the card the way a
    // reader walking the graph does — and reaches a mark another mark
    // overlaps, which a pointer cannot.
    await page.setViewportSize({ width: 800, height: 800 });
    const pane = page.getByTestId("spec-graph");
    await expect(pane).toBeVisible();
    const nodes = page.getByTestId(/^graph-node-/);
    const centres = await nodes.evaluateAll((elements) =>
      elements.map((element, index) => {
        const box = element.getBoundingClientRect();
        return { index, x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }),
    );
    expect(centres.length).toBeGreaterThan(0);
    const edges = [
      centres.reduce((a, b) => (b.x < a.x ? b : a)),
      centres.reduce((a, b) => (b.x > a.x ? b : a)),
      centres.reduce((a, b) => (b.y > a.y ? b : a)),
    ];
    const paneBox = await boxOf(pane);
    for (const at of new Set(edges.map((edge) => edge.index))) {
      const node = nodes.nth(at);
      await node.focus();
      const card = page.getByTestId("graph-card");
      await expect(card).toBeVisible();
      expectInside(
        await boxOf(card),
        paneBox,
        `the card for the node at the pane's edge (${at})`,
      );
      await node.blur();
    }
  });
});

test.describe("a labelled Sources row", () => {
  test.use({ appOptions: { project: true, forge: true } });

  test("dashboard-49: an issue row with labels does not widen the Dashboard", async ({
    page,
    app,
  }) => {
    const projectId = app.projectId!;
    // One intent standing behind another, sourced from issue #7, so
    // its row wears the longest state the band can show (dashboard-30).
    const first = await app.core.command("intent.queue", {
      projectId,
      text: "Add a README badge",
    });
    await app.core.command("intent.queue", {
      projectId,
      text: "Address #7: Token refresh drops the session after ninety seconds",
      source: { kind: "issue", ref: "7" },
      afterIntentId: first.id,
    });

    await open(page, app);
    await collapseRail(page);
    await nav(page, "Dashboard").click();
    await page.getByTestId(`sources-tab-issues-${projectId}`).click();
    const row = page.getByTestId(`source-issue-${projectId}-7`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`source-issue-${projectId}-7-state`)).toBeVisible();

    await page.setViewportSize({ width: FLOOR, height: 800 });
    await expect(row).toBeVisible();
    const rowBox = await boxOf(row);
    // Every child inside the row, and the row no wider than its box.
    const overflow = await row.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "the labelled row is wider than its box").toBeLessThanOrEqual(
      TOLERANCE,
    );
    const children = await row.locator(":scope > *").all();
    for (const [index, child] of children.entries()) {
      const box = await child.boundingBox();
      if (!box) continue;
      expectInside(box, rowBox, `child ${index} of the labelled row`);
    }
    // The label tags yielded; their words ride the row's title.
    await expect(row.getByText("documentation")).toBeHidden();
    await expect(row.getByRole("link")).toHaveAttribute(
      "title",
      /documentation, help wanted, auth$/,
    );
    await pageDoesNotScroll(page);
  });
});
