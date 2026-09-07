// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Sessions continue (DR-042, DR-051, run-view-109): a settled session takes a
// message and runs again on the same id — after its end, and after
// the shell restarted underneath the page — and a session the
// terminal wrote can be deleted from the sidebar. The real Captain
// owns journal and recovery; only provider replies are substituted.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { test, expect, open, nav, send, writeTerminalSession, interruptSession } from "../src/harness";

test.use({ appOptions: { project: true, realCaptain: true } });

test("run-view-109: a message continues a settled session on the current settings, before and after a restart", async ({
  page,
  app,
}) => {
  await open(page, app);
  await send(page, "Fix the token refresh in auth.ts");
  const captain = page.getByTestId("captain-pane");
  const finished = captain.getByText("Acknowledged by the real Captain.", { exact: true });
  await expect(finished).toHaveCount(1);
  const tab = page.getByRole("tab", { name: /fix the token refresh/i });
  await expect(tab).toBeVisible();

  // The turn settled: the runtime is held only for a turn (DR-051), so
  // the composer stands ready with nothing ending and nothing named.
  await expect(page.getByTestId("end-session")).toHaveCount(0);
  await expect(page.getByTestId("history-notice")).toHaveCount(0);
  const box = page.getByTestId("boss-composer");
  await expect(box).toBeEnabled();
  const coder = page.getByTestId("player-pane-dev.coder");
  await expect(coder).toContainText("claude-opus-5");

  // Settings change between turns: the coder's model. The next message
  // opens the runtime on the current settings (core-service-92), and
  // the coder's pane wears the new model.
  await nav(page, "Settings").click();
  await page.getByTestId("player-edit-dev.coder").click();
  const model = page.getByTestId("player-row-dev.coder").getByTestId("agent-model");
  await model.fill("claude-sonnet-5");
  await page.getByTestId("player-row-dev.coder").getByTestId("agent-save").click();
  await expect(page.getByTestId("player-saved-dev.coder")).toHaveText("Saved ✓");
  await nav(page, "Workspace").click();
  await expect(box).toBeEnabled();

  // A message continues it on the same tab: working again, narrating.
  await box.fill("Now add the expiry test");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    captain.getByTestId("boss-bubble").filter({ hasText: /expiry test/i }),
  ).toBeVisible();
  await expect(finished).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /fix the token refresh/i })).toHaveCount(1);
  await expect(coder).toContainText("claude-sonnet-5");
  await expect(page.getByTestId("end-session")).toHaveCount(0);

  // The shell restarts underneath the page: the session lists idle
  // and still continues from its persisted snapshot.
  await app.stop();
  await expect(page.getByText(/reconnecting to the spex core/i).first()).toBeVisible();
  await app.start();
  await expect(page.getByText(/reconnecting to the spex core/i)).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(box).toBeEnabled();
  await expect(page.getByTestId("history-notice")).toHaveCount(0);
  await box.fill("And document the skew");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    captain.getByTestId("boss-bubble").filter({ hasText: /document the skew/i }),
  ).toBeVisible();
  await expect(finished).toHaveCount(3);
});

test("run-view-109: a session the terminal wrote deletes from the sidebar, its history with it", async ({
  page,
  app,
}) => {
  const id = await writeTerminalSession(app, { prompt: "Triage the flaky test from the terminal" });
  await open(page, app);
  const tree = page.getByRole("tree", { name: "Projects and sessions" });
  const row = page.getByTestId(`sidebar-session-${id}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(/triage the flaky test/i);

  // The row's delete control, then the confirm worded for a terminal
  // session; Delete removes the files from the shared store.
  await row.hover();
  await page.getByTestId(`sidebar-delete-${id}`).click();
  const confirm = page.getByTestId(`sidebar-delete-confirm-${id}`);
  await expect(confirm).toContainText(
    "Delete this session and its transcript?",
  );
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(tree).not.toContainText(/triage the flaky test/i);
  await expect
    .poll(() => existsSync(join(app.sharedSessionsDir, `${id}.json`)))
    .toBe(false);
  expect(existsSync(join(app.sharedSessionsDir, `${id}.records.jsonl`))).toBe(false);
});


test("run-view-111: Retry uses saved input and Discard restores the preceding checkpoint", async ({ page, app }) => {
  const session = await app.core.command("session.create", { projectId: app.projectId! });
  await app.core.command("session.dispose", { sessionId: session.id });
  await interruptSession(app, session.id, "Retry this saved request");
  await open(page, app);
  await page.getByTestId(`sidebar-session-${session.id}`).click();
  const recovery = page.getByRole("region", { name: "Interrupted turn" });
  await expect(recovery).toContainText("Retry this saved request");
  await page.getByTestId("boss-composer").fill("Keep my draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await recovery.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(recovery).toContainText("Retry the saved input with its saved configuration");
  await recovery.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(recovery).toBeHidden();
  const captain = page.getByTestId("captain-pane");
  await expect(captain.getByTestId("boss-bubble").filter({ hasText: "Retry this saved request" })).toHaveCount(1);
  await expect(captain.getByText("Acknowledged by the real Captain.", { exact: true })).toHaveCount(1);
  // The retried turn settled and released the runtime (DR-051).
  await expect(page.getByTestId("end-session")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

  await interruptSession(app, session.id, "Discard this unexecuted request");
  await expect(recovery).toContainText("Discard this unexecuted request");
  await recovery.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(recovery).toContainText("The previous checkpoint is restored only if no effects were added");
  await recovery.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(recovery).toBeHidden();
  await expect(page.getByTestId("history-notice")).toHaveCount(0);
  await expect(captain.getByTestId("boss-bubble")).toHaveCount(1);
  await expect(captain).not.toContainText("Discard this unexecuted request");
  await expect(page.getByTestId("abort-button")).toHaveCount(0);
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
  await page.getByTestId("boss-composer").fill("Continue after discarding");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(captain.getByTestId("boss-bubble").filter({ hasText: "Continue after discarding" })).toHaveCount(1);
  await expect(captain.getByText("Acknowledged by the real Captain.", { exact: true })).toHaveCount(2);
  await expect(page.getByTestId("queue-indicator")).toHaveCount(0);
});
