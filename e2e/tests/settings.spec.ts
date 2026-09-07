// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Settings as a user edits them (settings-29): the Captain row's editor
// writing the shared config with its comment kept, a refused edit,
// readiness per adapter, and an outside edit reflected live.

import { writeFileSync } from "node:fs";

import { test, expect, open, nav } from "../src/harness";

test.use({ appOptions: { project: true } });

test("settings-29: the Captain row's editor round-trips the shared config", async ({
  page,
  app,
}) => {
  await open(page, app);
  await nav(page, "Settings").click();

  // The captain block as configured: a collapsed row, its chip naming
  // the model, the editor opening on the pencil (settings-1).
  const captain = page.getByTestId("captain-section");
  await expect(captain).toBeVisible();
  const chip = captain.getByTestId("agent-chip");
  await expect(chip).toContainText("claude-opus-5");
  await expect(captain.getByTestId("agent-editor")).toHaveCount(0);
  await captain.getByTestId("captain-edit").click();
  const model = captain.getByTestId("agent-model");
  await expect(model).toHaveValue("claude-opus-5");

  // Change the model; the editor closes, the row ticks Saved and
  // shows the new value, and the file keeps its comment and key order.
  await model.fill("claude-sonnet-5");
  await captain.getByTestId("agent-save").click();
  await expect(captain.getByTestId("captain-saved")).toHaveText("Saved ✓");
  await expect(captain.getByTestId("agent-editor")).toHaveCount(0);
  await expect(chip).toContainText("claude-sonnet-5");
  await expect.poll(() => app.readConfig()).toContain("claude-sonnet-5");
  const written = app.readConfig();
  expect(written.startsWith("# Spex demo config")).toBe(true);
  // The served page prints the shell's version, never "dev"
  // (settings-31, server-shell-4).
  await expect(page.getByText(/^Spex \d+\.\d+\.\d+/)).toBeVisible();
  await expect(page.getByText(/^Spex dev/)).toHaveCount(0);
  expect(written.indexOf("captain:")).toBeLessThan(written.indexOf("players:"));
  expect(written.indexOf("players:")).toBeLessThan(written.indexOf("playbooks:"));

  // The readiness panel: one entry per adapter the config names.
  const agents = page.getByTestId("agents-section");
  await expect(agents.getByTestId("agent-row-claude")).toBeVisible();
  await expect(agents.getByTestId("agent-row-codex")).toBeVisible();

  // The shortcut sheet names the palette binding with this platform's
  // modifier, and the terminal theme stands last under its CLI name.
  const sheet = page.getByTestId("shortcuts-section");
  await expect(sheet).toContainText("Switch or add a project");
  await expect(sheet.getByRole("row").nth(1)).toContainText(/⌘P|Ctrl\+P/);
  await expect(page.getByRole("heading", { level: 2 }).last()).toHaveText(
    "Terminal pane theme (CLI only)",
  );

  // A refused edit: a player id that already exists is turned back
  // with its message, and the file stays as it was.
  const before = app.readConfig();
  await page.getByTestId("player-add").click();
  await page.getByTestId("player-add-id").fill("dev.coder");
  await page.getByTestId("player-add-form").getByRole("button", { name: /add|save/i }).click();
  await expect(page.getByTestId("player-add-error")).toBeVisible();
  expect(app.readConfig()).toBe(before);

  // An outside edit lands on the surface without a reload.
  writeFileSync(app.configPath, before.replace("claude-sonnet-5", "claude-opus-5"));
  await expect(chip).toContainText("claude-opus-5");
});
