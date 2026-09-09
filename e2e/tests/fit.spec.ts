// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The fit journey (run-view-105, spec-view-56, dashboard-43,
// settings-30; DR-041 §9): every surface, both sidebar states, six
// widths, two heights — the page never scrolls sideways or
// vertically, nothing but a canvas is wider than its box, every
// scroll box ends inside the viewport and contains its own positioned
// content, no two siblings in a row overlap, every child stays inside
// its parent, and every control keeps its accessible name; a window
// made short and tall again re-fits without a reload. Simulated
// documents cannot measure layout, so this is the one home of that
// evidence.

import { join } from "node:path";
import type { Page } from "@playwright/test";
import { seedDemoProject } from "@sublang/spex-core/testing";

import { test, expect, open, nav, send } from "../src/harness";


// Long enough that a turn is still in flight while a surface is
// measured at eleven widths. The demo project carries closed work, so
// the Dashboard's History band draws rows — with their screen-reader
// marks — below the fold, where a box that fails to contain them
// stretches the page.
test.use({ appOptions: { project: true, history: 25, agentDelayMs: 4000 } });

const WIDTHS = [320, 480, 640, 800, 1024, 1280];
/** An unbroken token longer than any pane (run-view-3): it rides the
 * task into the Boss bubble, the coder's prompt, and the tab and row
 * titles, and must wrap or truncate everywhere rather than scroll a
 * pane sideways. */
const LONG_URL = `https://example.com/${"a".repeat(380)}`;
const TASK = `Fix the token refresh in auth.ts — see ${LONG_URL}`;
/** The law is measured in a tall window and a short one (DR-041 §9):
 * the shell fills either, and the surface scrolls inside its box. */
const TALL = 800;
const SHORT = 400;
const HEIGHTS = [TALL, SHORT];
/** The open sidebar is 224px wide, so the 320px floor holds with it
 * collapsed (DR-041): the open state is measured from 480px. */
const OPEN_RAIL_MIN_WIDTH = 480;

interface Measured {
  /** Elements wider than their box outside a scrolling canvas. */
  overflow: string[];
  /** The page scrolling vertically, and outermost scroll containers
   * whose box ends past the bottom of the viewport. */
  vertical: string[];
  /** Sibling pairs that overlap, and children outside their parent,
   * within tab lists, toolbars, headers, list rows, and composer boxes. */
  overlap: string[];
  /** Every button's accessible name, in document order. */
  names: string[];
}

/** One measurement of the current layout, taken in the page. */
async function measure(page: Page): Promise<Measured> {
  // Two frames so container queries and the auto-growing field have
  // settled after a resize.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return page.evaluate(() => {
    const TOLERANCE = 1;
    const describe = (el: Element): string => {
      const id = el.getAttribute("data-testid");
      const tag = el.tagName.toLowerCase();
      const cls = (el.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .join(".");
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
      return `${tag}${id ? `[data-testid=${id}]` : ""}${cls ? `.${cls}` : ""}${
        text ? ` "${text}"` : ""
      }`;
    };
    const styleOf = (el: Element) => getComputedStyle(el);
    const scrolls = (el: Element): boolean => {
      const ox = styleOf(el).overflowX;
      return ox === "auto" || ox === "scroll";
    };
    const scrollsDown = (el: Element): boolean => {
      const oy = styleOf(el).overflowY;
      return oy === "auto" || oy === "scroll";
    };
    const shown = (el: Element): boolean => {
      const style = styleOf(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (style.position === "fixed" || style.position === "absolute") return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    // An inline element paints as line fragments; its union box says
    // nothing about overlap, so each fragment is measured on its own.
    const rects = (el: Element): DOMRect[] =>
      styleOf(el).display === "inline"
        ? Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
        : [el.getBoundingClientRect()];
    const intersect = (a: DOMRect, b: DOMRect): boolean =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > TOLERANCE &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > TOLERANCE;
    const inside = (child: DOMRect, parent: DOMRect): boolean =>
      child.left >= parent.left - TOLERANCE &&
      child.right <= parent.right + TOLERANCE &&
      child.top >= parent.top - TOLERANCE &&
      child.bottom <= parent.bottom + TOLERANCE;

    // (i) Sideways overflow: the page, then every element that is
    // not a scrolling canvas, not a truncating text box, and not the
    // one-pixel clipped box that carries screen-reader-only text.
    const overflow: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) {
      overflow.push(`document scrolls sideways: ${root.scrollWidth} > ${root.clientWidth}`);
    }
    const inCanvas = new Map<Element, boolean>();
    const insideCanvas = (el: Element): boolean => {
      const known = inCanvas.get(el);
      if (known !== undefined) return known;
      const parent = el.parentElement;
      const found = parent ? scrolls(parent) || insideCanvas(parent) : false;
      inCanvas.set(el, found);
      return found;
    };
    const viewportWidth = document.documentElement.clientWidth;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement)) continue;
      const style = styleOf(el);
      if (style.display === "none" || style.display === "inline") continue;
      if (scrolls(el) || style.textOverflow === "ellipsis") continue;
      if (el.clientWidth <= 1) continue;
      // A text field scrolls its own value; its box is what counts.
      const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if (!field && el.scrollWidth > el.clientWidth + TOLERANCE) {
        overflow.push(`${describe(el)}: ${el.scrollWidth} > ${el.clientWidth}`);
      }
      // Nothing paints outside the viewport but inside a canvas
      // (DR-041's 320px floor) — positioned chrome included.
      const box = el.getBoundingClientRect();
      if (
        box.width > 0 &&
        (box.right > viewportWidth + TOLERANCE || box.left < -TOLERANCE) &&
        !insideCanvas(el)
      ) {
        overflow.push(
          `${describe(el)} extends past the viewport (${Math.round(box.left)}..${Math.round(box.right)} of ${viewportWidth})`,
        );
      }
    }

    // (ii) Vertical fit: the page itself never scrolls, and every
    // surface scrolls inside a box that ends inside the viewport. A
    // scroll container nested in another one is skipped — its own
    // parent may have scrolled it out of sight, which is the point.
    const vertical: string[] = [];
    const viewportHeight = root.clientHeight;
    if (root.scrollHeight > root.clientHeight + TOLERANCE) {
      vertical.push(
        `document scrolls vertically: ${root.scrollHeight} > ${root.clientHeight}`,
      );
    }
    const inScroller = new Map<Element, boolean>();
    const insideScroller = (el: Element): boolean => {
      const known = inScroller.get(el);
      if (known !== undefined) return known;
      const parent = el.parentElement;
      const found = parent ? scrollsDown(parent) || insideScroller(parent) : false;
      inScroller.set(el, found);
      return found;
    };
    // A positioned box is carried by the page itself unless a scroll
    // box contains it: its containing block — the offset parent, or
    // the page for a fixed box — must be, or sit inside, something
    // that clips. Screen-reader-only text is the usual culprit: it is
    // absolutely positioned, one pixel tall, and invisible, so only
    // the page's height shows that it escaped.
    const contained = (el: HTMLElement): boolean => {
      let node: Element | null =
        styleOf(el).position === "fixed" ? null : el.offsetParent;
      while (node && node !== document.body && node !== root) {
        const style = styleOf(node);
        if (style.overflowY !== "visible" || style.overflowX !== "visible") {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement)) continue;
      const style = styleOf(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = el.getBoundingClientRect();
      const positioned = style.position === "absolute" || style.position === "fixed";
      if (!positioned && (!scrollsDown(el) || insideScroller(el))) continue;
      if (box.height <= 0 || box.bottom <= viewportHeight + TOLERANCE) continue;
      if (positioned) {
        if (!contained(el)) {
          vertical.push(
            `${describe(el)} is positioned past the viewport with no scroll box containing it (bottom ${Math.round(box.bottom)} of ${viewportHeight})`,
          );
        }
      } else {
        vertical.push(
          `${describe(el)} scrolls but ends past the viewport (bottom ${Math.round(box.bottom)} of ${viewportHeight})`,
        );
      }
    }

    // (iii) Overlap and containment within the rows that lay controls
    // side by side.
    const overlap: string[] = [];
    const seen = new Set<Element>();
    const containers = Array.from(
      document.querySelectorAll('[role="tablist"], [role="toolbar"], header, li'),
    );
    for (const box of Array.from(document.querySelectorAll('[data-testid$="-composer"]'))) {
      if (box.parentElement) containers.push(box.parentElement);
    }
    const check = (parent: Element): void => {
      if (seen.has(parent)) return;
      seen.add(parent);
      const parentBox = parent.getBoundingClientRect();
      const children = Array.from(parent.children).filter(shown);
      const parentScrolls = scrolls(parent);
      const parentHasBox = parentBox.width > 0 && parentBox.height > 0;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        const childRects = rects(child);
        if (parentHasBox && !parentScrolls) {
          for (const r of childRects) {
            if (!inside(r, parentBox)) {
              overlap.push(
                `${describe(child)} leaves ${describe(parent)} (${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(parentBox.left)}..${Math.round(parentBox.right)})`,
              );
              break;
            }
          }
        }
        for (let j = i + 1; j < children.length; j += 1) {
          const other = children[j];
          const hit = childRects.some((a) => rects(other).some((b) => intersect(a, b)));
          if (hit) {
            overlap.push(`${describe(child)} overlaps ${describe(other)} in ${describe(parent)}`);
          }
        }
      }
      for (const child of children) check(child);
    };
    for (const container of containers) {
      if (shown(container)) check(container);
    }

    // (iv) Accessible names of every button, in document order. The
    // Now row names the live run's current state, which advances
    // between measurements, and a Running row stands only while its
    // turn is in flight; both are live content, not chrome, so they
    // stay out of the stability check.
    const names = Array.from(document.querySelectorAll("button"))
      .filter(
        (button) =>
          !button.closest('[data-testid^="now-session-"]') &&
          !button.closest('[data-testid^="running-session-"]'),
      )
      .map((button) => {
        const label = button.getAttribute("aria-label");
        const text = (button.textContent ?? "").trim().replace(/\s+/g, " ");
        return label ?? (text || (button.getAttribute("title") ?? ""));
      });
    return { overflow, vertical, overlap, names };
  });
}

/** File one measurement's findings against the place it was taken. */
function record(where: string, found: Measured, defects: string[]): void {
  for (const line of found.overflow) defects.push(`${where}: overflow — ${line}`);
  for (const line of found.vertical) defects.push(`${where}: vertical — ${line}`);
  for (const line of found.overlap) defects.push(`${where}: ${line}`);
}

/** Put the sidebar in the state to be measured, from a width where
 * both of its controls are reachable. */
async function setRail(page: Page, railOpen: boolean): Promise<void> {
  await page.setViewportSize({ width: 1280, height: TALL });
  const control = page.getByRole("button", {
    name: railOpen ? "Show the sidebar" : "Collapse the sidebar",
  });
  if (await control.isVisible()) await control.click();
  await expect(
    page.getByRole("button", {
      name: railOpen ? "Collapse the sidebar" : "Show the sidebar",
    }),
  ).toBeVisible();
}

interface Surface {
  name: string;
  /** Bring the surface up once. */
  show: () => Promise<void>;
  /** Hold before each measurement: the surface is drawn and in the
   * state the journey measures. */
  ready: () => Promise<void>;
}

test("run-view-105: chrome fits at every width, in both sidebar states", async ({
  page,
  app,
}) => {
  test.setTimeout(120_000);
  const projectId = app.projectId!;

  // Arrange through the protocol: a queued intent with a second one
  // blocked behind it, and ten parked sessions in other projects so
  // the attention queue holds ten entries and the badge passes nine.
  const first = await app.core.command("intent.queue", {
    projectId,
    text: "Add a README badge",
  });
  await app.core.command("intent.queue", {
    projectId,
    text: "Tighten the expiry tests once the badge lands on the README",
    afterIntentId: first.id,
  });
  for (let index = 0; index < 10; index += 1) {
    const dir = join(app.projectDir, "..", `parked-${index}`);
    seedDemoProject(dir);
    const project = await app.core.command("project.register", { path: dir });
    const session = await app.core.command("session.create", {
      projectId: project.id,
    });
    await app.core.command("turn.submit", {
      sessionId: session.id,
      text: "ask before migrating",
    });
  }
  await expect
    .poll(async () => (await app.core.command("ledger.get", {})).badge, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(10);

  page.on("pageerror", (error) => console.log(`[fit] page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[fit] console error: ${message.text()}`);
  });
  await open(page, app);
  // Several projects are registered, so the demo project is chosen
  // by hand from the sidebar.
  await page.getByTestId(`sidebar-project-${projectId}`).click();
  await expect(page.getByTestId("captain-home")).toContainText("demo-project");

  const abort = page.getByTestId("abort-button");
  const ensureTurnRunning = async () => {
    if (await abort.isVisible()) return;
    await page.getByTestId("boss-composer").fill(TASK);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(abort).toBeVisible();
  };

  const surfaces: Surface[] = [
    {
      name: "Captain home",
      show: async () => {},
      ready: () => expect(page.getByTestId("captain-home")).toBeVisible(),
    },
    {
      name: "Session (turn in flight)",
      show: async () => {
        await send(page, TASK);
        await expect(page.getByTestId("captain-pane")).toContainText("/code started");
      },
      ready: async () => {
        await expect(page.getByTestId("captain-pane")).toBeVisible();
        await ensureTurnRunning();
      },
    },
    {
      name: "Dashboard",
      // The entry's name carries the attention count (run-view-34).
      show: () => page.getByRole("button", { name: /^Dashboard\b/ }).click(),
      ready: async () => {
        await expect(page.getByTestId(`project-group-${projectId}`)).toBeVisible();
        await expect(page.getByTestId(/^attention-/).first()).toBeVisible();
      },
    },
    {
      name: "Overview",
      show: async () => {
        await page.getByRole("button", { name: "Workspace" }).click();
        await page.getByRole("tab", { name: "Overview" }).click();
      },
      ready: () => expect(page.getByTestId("overview-tab")).toBeVisible(),
    },
    {
      name: "Specs (graph on)",
      show: async () => {
        await page.getByRole("tab", { name: "Specs" }).click();
        await expect(page.getByTestId("specv-live")).toBeVisible();
        const toggle = page.getByTestId("view-graph");
        if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        const file = page.getByTestId(/^file-toggle-/).first();
        if ((await file.getAttribute("aria-expanded")) !== "true") await file.click();
        await expect(page.getByTestId(/^item-toggle-/).first()).toBeVisible();
      },
      ready: async () => {
        await expect(page.getByTestId("specv-live")).toBeVisible();
        // The graph half fills the split's box beside the outline, or
        // its own floor where that is taller, and the drawing surface
        // fills the half less its legend (spec-view-59). A pane whose height
        // fails to resolve is exactly as tall as its legend plus the
        // 150px an svg falls back to, so the half is measured against
        // the box it owes its height to, never against itself.
        const fill = await page.getByTestId("spec-graph").evaluate((pane) => {
          const svg = pane.querySelector("svg");
          const others = Array.from(pane.children)
            .filter((child) => child !== svg)
            .reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
          const half = pane.parentElement!;
          const split = half.parentElement!;
          const box = split.parentElement!;
          const paneBox = pane.getBoundingClientRect();
          return {
            pane: paneBox.height,
            svg: svg?.getBoundingClientRect().height ?? 0,
            others,
            besideOutline: paneBox.width < split.getBoundingClientRect().width - 1,
            box: box.clientHeight,
            floor: Number.parseFloat(getComputedStyle(half).minHeight) || 0,
          };
        });
        const owed = Math.max(fill.floor, fill.besideOutline ? fill.box : 0);
        expect(
          fill.pane,
          `the graph half is ${fill.pane}px tall with a ${fill.floor}px floor ${
            fill.besideOutline ? `beside the outline in a ${fill.box}px box` : "below the outline"
          }`,
        ).toBeGreaterThanOrEqual(owed - 1);
        expect(
          fill.svg,
          `the graph's drawing surface is ${fill.svg}px tall in a ${fill.pane}px pane`,
        ).toBeGreaterThanOrEqual(fill.pane - fill.others - 1);
      },
    },
    {
      name: "Playbooks",
      show: () => nav(page, "Playbooks").click(),
      ready: () => expect(page.getByTestId("builtins-section")).toBeVisible(),
    },
    {
      name: "Settings",
      show: () => nav(page, "Settings").click(),
      ready: () => expect(page.getByTestId("captain-section")).toBeVisible(),
    },
  ];

  const defects: string[] = [];
  const started = Date.now();
  const log = (line: string) => {
    if (!process.env.SPEX_E2E_DEBUG) return;
    console.log(`[fit +${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);
  };
  for (const surface of surfaces) {
    await page.setViewportSize({ width: 1280, height: TALL });
    await surface.show();
    log(`${surface.name}: shown`);
    for (const railOpen of [false, true]) {
      await setRail(page, railOpen);
      let reference: string[] | undefined;
      for (const width of WIDTHS) {
        if (railOpen && width < OPEN_RAIL_MIN_WIDTH) continue;
        for (const height of HEIGHTS) {
          await page.setViewportSize({ width, height });
          await surface.ready();
          const where = `${surface.name} · sidebar ${railOpen ? "open" : "collapsed"} · ${width}×${height}`;
          const found = await measure(page);
          log(`${where}: measured`);
          record(where, found, defects);
          // (iv) Names hold at every size: the first measurement of
          // this sidebar state is the reference.
          if (!reference) {
            reference = found.names;
          } else if (found.names.length !== reference.length) {
            defects.push(
              `${where}: ${found.names.length} buttons, ${reference.length} at the reference size`,
            );
          } else {
            found.names.forEach((name, index) => {
              if (name !== reference![index]) {
                defects.push(`${where}: button ${index} reads "${name}", "${reference![index]}" at the reference size`);
              }
            });
          }
        }
      }
    }
    // One page life, made tall, short, and tall again: a surface that
    // measured the window once would keep the stale height here.
    for (const height of [TALL, SHORT, TALL]) {
      await page.setViewportSize({ width: 1280, height });
      await surface.ready();
      const where = `${surface.name} · re-fit after resize · 1280×${height}`;
      record(where, await measure(page), defects);
      log(`${where}: measured`);
    }
  }
  // The collapsed rail's badge caps at "9+", the count in the name
  // (run-view-108).
  await setRail(page, false);
  await expect(page.getByTestId("nav-attention-badge")).toHaveText("9+");
  await expect(
    page.getByRole("button", { name: /^Dashboard — 10 need your attention$/ }),
  ).toBeVisible();

  expect(defects, defects.join("\n")).toEqual([]);
});

// The at-hand popovers and the composer's queue are chrome the sweep
// above never opens, and both used to leave the window: the Captain's
// agent editor above the top edge with nothing able to scroll it back,
// the queue below the bottom with the page growing behind it. They are
// measured here at the same widths and heights (run-view-105).
test.describe("chrome the sweep does not open", () => {
  let releaseDiscovery: (() => void) | undefined;
  test.use({ appOptions: {
    project: true,
    agentDelayMs: 120_000,
    discoverAgentModels: async () => {
      await new Promise<void>((resolve) => { releaseDiscovery = resolve; });
      return { status: "available", models: [{ id: "fixture-model", name: "Fixture model" }] };
    },
  } });
  test.afterEach(() => releaseDiscovery?.());

  test("run-view-105: the home's agent popover and the queue stay in the window", async ({
    page,
    app,
  }) => {
    test.setTimeout(120_000);
    const defects: string[] = [];
    await page.setViewportSize({ width: 1280, height: TALL });
    await open(page, app);
    await expect(page.getByTestId("captain-home")).toBeVisible();
    // The 320px floor is stated with the sidebar collapsed (DR-041).
    await setRail(page, false);

    // (i) The gear sits at the foot of the home, so the room above it
    // shrinks with the window (run-view-32).
    const popover = page.getByTestId("agent-popover");
    for (const height of HEIGHTS) {
      for (const width of [320, 900]) {
        await page.setViewportSize({ width, height });
        await page.getByTestId("captain-settings").click();
        await expect(popover).toBeVisible();
        for (const phase of ["on opening", "after discovery"]) {
          if (phase === "on opening") {
            await expect(popover).toContainText("Loading model options…");
          } else {
            await expect.poll(() => Boolean(releaseDiscovery)).toBe(true);
            releaseDiscovery!();
            releaseDiscovery = undefined;
            await expect(popover).toContainText("Models reported by the installed runtime.");
          }
          const where = `agent popover · ${width}×${height} · ${phase}`;
          // Discovery can grow the visible editor before ResizeObserver
          // refits it. Retain a bounded poll's final failure so the other
          // viewports and the queue still contribute to the report.
          await expect(async () => {
            const fitDefects: string[] = [];
            const box = (await popover.boundingBox())!;
            if (box.y < -1) fitDefects.push(`${where}: top at ${Math.round(box.y)}`);
            if (box.y + box.height > height + 1) {
              fitDefects.push(`${where}: bottom at ${Math.round(box.y + box.height)} of ${height}`);
            }
            // The adapter picker is the first thing the dialog offers, and
            // was the first thing to go off the top edge.
            const adapter = (await page
              .getByTestId("agent-adapter-claude")
              .boundingBox())!;
            if (adapter.y < -1 || adapter.y + adapter.height > height + 1) {
              fitDefects.push(`${where}: the adapter picker is outside the window`);
            }
            const page_ = await page.evaluate(() => [
              document.documentElement.scrollHeight,
              document.documentElement.clientHeight,
            ]);
            if (page_[0] > page_[1] + 1) {
              fitDefects.push(`${where}: the page grew to ${page_[0]} of ${page_[1]}`);
            }
            expect(fitDefects, fitDefects.join("\n")).toEqual([]);
          }).toPass({ timeout: 2_000 }).catch((cause: unknown) => {
            defects.push(`${where}: ${cause instanceof Error ? cause.message : String(cause)}`);
          });
        }
        await page.keyboard.press("Escape");
        await expect(popover).toHaveCount(0);
      }
    }

    // (ii) A queue standing behind a long turn, measured at every
    // width and height (run-view-106).
    await page.setViewportSize({ width: 1280, height: TALL });
    await send(page, TASK);
    await expect(page.getByTestId("abort-button")).toBeVisible();
    const queue = page.getByTestId("queue-indicator");
    const field = page.getByTestId("boss-composer");
    for (let index = 1; index <= 6; index += 1) {
      await field.fill(`Queued ${index}: ${TASK}`);
      await page.getByRole("button", { name: "Send next", exact: true }).click();
      await expect(queue).toContainText(`Queued ${index}:`);
    }
    for (const width of WIDTHS) {
      for (const height of HEIGHTS) {
        await page.setViewportSize({ width, height });
        const where = `queue · ${width}×${height}`;
        // The frame stays a few entries tall however much is queued;
        // in a window too short for the composer alone it yields the
        // rest of the way, which is the ladder, not a defect.
        const frame = await queue.boundingBox();
        if (frame && frame.height > 200) {
          defects.push(`${where}: the queue frame is ${Math.round(frame.height)} tall`);
        }
        const primary = (await page.getByTestId("send-button").boundingBox())!;
        if (primary.y + primary.height > height + 1) {
          defects.push(
            `${where}: the send control ends at ${Math.round(primary.y + primary.height)} of ${height}`,
          );
        }
        record(where, await measure(page), defects);
      }
    }
    expect(defects, defects.join("\n")).toEqual([]);
  });
});

// A window laid out before it is shown reports no viewport height; the
// field keeps one row through that first paint and refits once the
// viewport has a size (run-view-106).
test("run-view-106: the field keeps one row without viewport height and refits on resize", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1024, height: 1 });
  await open(page, app);
  const field = page.getByTestId("start-composer");
  const line = await field.evaluate((el) =>
    parseFloat(getComputedStyle(el).lineHeight),
  );
  const height = async (): Promise<number> =>
    (await field.boundingBox())?.height ?? 0;
  expect(await height()).toBeGreaterThanOrEqual(line);
  await field.fill("one\ntwo\nthree");
  expect(await height()).toBeGreaterThanOrEqual(line);
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect.poll(height).toBeGreaterThanOrEqual(line * 3);
});
