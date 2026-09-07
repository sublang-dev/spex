// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Accessibility as a journey (run-view-102): every surface scanned by
// axe-core at WCAG 2.1 AA, in both themes; serious and critical
// violations fail the run.

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { test, expect, open, nav, send } from "../src/harness";

test.use({ appOptions: { project: true } });

async function scan(page: Page, surface: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${surface}: [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}; e.g. ${v.nodes[0]?.target.join(" ")} :: ${v.nodes[0]?.html.slice(0, 160)})`,
    );
}

for (const theme of ["light", "dark"] as const) {
  test(`run-view-102: no serious or critical violation on any surface (${theme})`, async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await open(page, app);
    const found: string[] = [];

    found.push(...(await scan(page, "Captain home")));

    await send(page, "Fix the token refresh in auth.ts");
    await expect(page.getByTestId("captain-pane")).toContainText("/code finished");
    found.push(...(await scan(page, "Session")));

    await nav(page, "Dashboard").click();
    await expect(page.getByTestId(`project-group-${app.projectId}`)).toBeVisible();
    found.push(...(await scan(page, "Dashboard")));

    await page.getByRole("button", { name: "Workspace" }).click();
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByTestId("overview-tab")).toBeVisible();
    found.push(...(await scan(page, "Overview")));

    await page.getByRole("tab", { name: "Specs" }).click();
    await expect(page.getByTestId("specv-live")).toBeVisible();
    found.push(...(await scan(page, "Specs")));

    await nav(page, "Playbooks").click();
    await expect(page.getByTestId("builtins-section")).toBeVisible();
    found.push(...(await scan(page, "Playbooks")));

    await nav(page, "Settings").click();
    await expect(page.getByTestId("captain-section")).toBeVisible();
    // The Captain's editor opens in place; scan the surface with it
    // standing, so the shared editor's controls are covered too.
    await page.getByTestId("captain-edit").click();
    await expect(page.getByTestId("agent-editor")).toBeVisible();
    found.push(...(await scan(page, "Settings")));

    expect(found, found.join("\n")).toEqual([]);
  });
}
