// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// SET coverage for the DR-019 surfaces: the Captain's row opening the
// shared agent editor and writing merge patches, and the per-adapter
// readiness panel naming the positions each adapter serves.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

afterEach(cleanup);

const { commandMock } = vi.hoisted(() => ({ commandMock: vi.fn() }));

vi.mock("../state/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/store.js")>();
  return { ...actual, getClient: () => ({ command: commandMock }) };
});

import { SettingsSurface } from "./SettingsSurface.js";
import { useAppStore } from "../state/store.js";
import { keyLabel } from "../lib/shortcuts.js";
import type { ConfigState, ReadinessEntry } from "@sublang/spex-core/protocol";

const CONFIG: ConfigState = {
  status: "valid",
  seeded: false,
  summary: {
    path: "/tmp/playbook.config.yaml",
    captain: {
      adapter: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      permissions: { mode: "auto" },
    },
    players: [
      {
        id: "dev.coder",
        agent: { adapter: "claude", model: "claude-opus-5[1m]" },
        display: "claude-opus-5[1m]",
        boundBy: ["code.coder"],
      },
      {
        id: "dev.reviewer",
        agent: { adapter: "codex", model: "gpt-5.6-sol" },
        display: "gpt-5.6-sol",
        boundBy: ["code.reviewer"],
      },
    ],
    playbooks: [
      {
        id: "code",
        from: "@sublang/playbook/code/registry",
        command: "code",
        intent: "software development workflow",
        roles: {
          coder: { playerId: "dev.coder", display: "claude-opus-5[1m]" },
          reviewer: { playerId: "dev.reviewer", display: "gpt-5.6-sol" },
        },
      },
    ],
  },
};

const READINESS: ReadinessEntry[] = [
  {
    adapter: "claude",
    ready: true,
    usedBy: ["captain", "dev.coder (code.coder)"],
    fastModeSupported: true,
  },
  {
    adapter: "codex",
    ready: false,
    requirement: "set OPENAI_API_KEY or sign in with the Codex CLI",
    usedBy: ["dev.reviewer (code.reviewer)"],
    fastModeSupported: false,
  },
];

function renderSettings() {
  useAppStore.setState({
    configState: CONFIG,
    readiness: READINESS,
    refreshReadiness: vi.fn(async () => {}),
  });
  return render(<SettingsSurface />);
}

beforeEach(() => {
  commandMock.mockReset();
  commandMock.mockResolvedValue(CONFIG);
});

describe("SET: the Captain's row and its agent editor", () => {
  test("the captain renders as a chip on a collapsed row with no removal", () => {
    renderSettings();
    const section = screen.getByTestId("captain-section");
    expect(section.textContent).toContain("claude");
    expect(section.textContent).toContain("claude-opus-4-8");
    expect(section.textContent).toContain("high");
    // The row wears the players' shape (settings-1): an edit toggle,
    // no editor until it is asked for, and never a remove control.
    expect(within(section).queryByTestId("agent-editor")).toBeNull();
    const toggle = within(section).getByTestId("captain-edit");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      within(section).queryByRole("button", { name: /^Remove/ }),
    ).toBeNull();
  });

  test("editing the model writes a captain.set merge patch and closes the editor", async () => {
    renderSettings();
    const section = screen.getByTestId("captain-section");
    fireEvent.click(within(section).getByTestId("captain-edit"));
    expect(
      within(section).getByTestId("captain-edit").getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.change(within(section).getByTestId("agent-model"), {
      target: { value: "claude-opus-4-8[1m]" },
    });
    fireEvent.click(within(section).getByTestId("agent-save"));
    await vi.waitFor(() => expect(commandMock).toHaveBeenCalled());
    const [type, payload] = commandMock.mock.calls[0];
    expect(type).toBe("config.edit");
    expect(payload.op.kind).toBe("captain.set");
    expect(payload.op.patch.model).toBe("claude-opus-4-8[1m]");
    // A merge patch never carries hand-written fields it did not edit.
    expect(payload.op.patch).not.toHaveProperty("instruction");
    // Saved, the editor folds back into the row and the toggle takes
    // the keyboard (DR-010 §6).
    await vi.waitFor(() =>
      expect(within(section).queryByTestId("agent-editor")).toBeNull(),
    );
    expect(document.activeElement).toBe(
      within(section).getByTestId("captain-edit"),
    );
  });

  test("Cancel and Escape close the Captain's editor without a command", () => {
    renderSettings();
    const section = screen.getByTestId("captain-section");
    fireEvent.click(within(section).getByTestId("captain-edit"));
    fireEvent.change(within(section).getByTestId("agent-model"), {
      target: { value: "claude-sonnet-5" },
    });
    fireEvent.click(within(section).getByTestId("agent-cancel"));
    expect(within(section).queryByTestId("agent-editor")).toBeNull();
    expect(commandMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      within(section).getByTestId("captain-edit"),
    );
    // Reopened, the draft starts from the file again.
    fireEvent.click(within(section).getByTestId("captain-edit"));
    expect(
      (within(section).getByTestId("agent-model") as HTMLInputElement).value,
    ).toBe("claude-opus-4-8");
    fireEvent.keyDown(within(section).getByTestId("agent-model"), {
      key: "Escape",
    });
    expect(within(section).queryByTestId("agent-editor")).toBeNull();
    expect(commandMock).not.toHaveBeenCalled();
  });

  test("one row's editor stands open at a time, the Captain's and the players' alike", () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("captain-edit"));
    expect(screen.getAllByTestId("agent-editor")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("player-edit-dev.coder"));
    expect(screen.getAllByTestId("agent-editor")).toHaveLength(1);
    expect(
      within(screen.getByTestId("player-row-dev.coder")).getByTestId(
        "agent-editor",
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId("captain-edit").getAttribute("aria-expanded"),
    ).toBe("false");
    fireEvent.click(screen.getByTestId("captain-edit"));
    expect(
      within(screen.getByTestId("captain-section")).getByTestId("agent-editor"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("player-row-dev.coder")).queryByTestId(
        "agent-editor",
      ),
    ).toBeNull();
  });
});

describe("SET: adapter readiness panel", () => {
  test("one row per adapter, with requirement and the positions it serves", () => {
    renderSettings();
    const claude = screen.getByTestId("agent-row-claude");
    expect(claude.textContent).toContain("claude");
    // Positions render per DR-019: the Captain and each playbook role.
    expect(claude.textContent).toMatch(/Captain/i);
    expect(claude.textContent).toMatch(/coder/i);

    const codex = screen.getByTestId("agent-row-codex");
    expect(codex.textContent).toContain(
      "set OPENAI_API_KEY or sign in with the Codex CLI",
    );
    expect(codex.textContent).toMatch(/reviewer/i);
    // Deduped: no third row for an adapter used twice.
    expect(screen.queryAllByTestId(/^agent-row-/)).toHaveLength(2);
  });

  test("re-check triggers a readiness refresh", () => {
    const refreshReadiness = vi.fn(async () => {});
    useAppStore.setState({
      configState: CONFIG,
      readiness: READINESS,
      refreshReadiness,
    });
    render(<SettingsSurface />);
    fireEvent.click(screen.getByRole("button", { name: /Re-check readiness/i }));
    expect(refreshReadiness).toHaveBeenCalled();
  });
});

describe("SET: the session-player roster", () => {
  test("each lane prints its id, its agent, and the roles it answers", () => {
    renderSettings();
    const row = screen.getByTestId("player-row-dev.coder");
    expect(row.textContent).toContain("dev.coder");
    // The lane's own agent, with the adapter's readiness (DR-032).
    expect(
      within(row).getByLabelText(
        "dev.coder: claude · claude-opus-5[1m] (ready)",
      ),
    ).toBeTruthy();
    expect(within(row).getByTestId("player-bound-dev.coder").textContent).toBe(
      "code.coder",
    );
  });

  test("editing a lane writes a player.set merge patch", async () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("player-edit-dev.coder"));
    const row = screen.getByTestId("player-row-dev.coder");
    fireEvent.change(within(row).getByTestId("agent-model"), {
      target: { value: "claude-opus-5" },
    });
    fireEvent.click(within(row).getByTestId("agent-save"));
    await vi.waitFor(() =>
      expect(commandMock).toHaveBeenCalledWith("config.edit", {
        op: {
          kind: "player.set",
          playerId: "dev.coder",
          // Identity keys only: a lane's adapter and permissions live
          // here, never in a role binding (DR-032).
          patch: expect.objectContaining({ model: "claude-opus-5" }),
        },
      }),
    );
  });

  test("removing a bound lane is refused in the core's own words", async () => {
    commandMock.mockImplementation(async (_type: string, payload: unknown) => {
      const op = (payload as { op: { kind: string } }).op;
      if (op.kind === "player.delete") {
        throw new Error("dev.coder still answers code.coder");
      }
      return CONFIG;
    });
    renderSettings();
    fireEvent.click(screen.getByTestId("player-delete-dev.coder"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("player-error-dev.coder").textContent,
      ).toContain("dev.coder still answers code.coder"),
    );
  });

  test("adding a lane names it and gives it a whole block", async () => {
    renderSettings();
    fireEvent.click(screen.getByTestId("player-add"));
    fireEvent.change(screen.getByTestId("player-add-id"), {
      target: { value: "dev.docs" },
    });
    const form = screen.getByTestId("player-add-form");
    fireEvent.click(within(form).getByTestId("agent-save"));
    await vi.waitFor(() =>
      expect(commandMock).toHaveBeenCalledWith("config.edit", {
        op: {
          kind: "player.set",
          playerId: "dev.docs",
          patch: expect.objectContaining({ adapter: "claude" }),
        },
      }),
    );
  });
});

describe("settings-6: every edit acknowledges in place", () => {
  test("saving the Captain closes its editor and ticks on the row", async () => {
    renderSettings();
    const section = screen.getByTestId("captain-section");
    expect(within(section).queryByRole("status")).toBeNull();
    fireEvent.click(within(section).getByTestId("captain-edit"));
    fireEvent.change(within(section).getByTestId("agent-model"), {
      target: { value: "claude-opus-5" },
    });
    fireEvent.click(within(section).getByTestId("agent-save"));
    await vi.waitFor(() =>
      expect(within(section).getByTestId("captain-saved").textContent).toBe(
        "Saved ✓",
      ),
    );
    expect(within(section).getByRole("status").textContent).toBe("Saved ✓");
    expect(within(section).queryByTestId("agent-editor")).toBeNull();
  });

  test("a notification select is disabled in flight, then ticks", async () => {
    let land!: (value: unknown) => void;
    commandMock.mockImplementation(
      () => new Promise((resolve) => (land = resolve)),
    );
    renderSettings();
    const [select] = within(
      screen.getByTestId("notifications-section"),
    ).getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(select, { target: { value: "bell" } });
    expect(select.disabled).toBe(true);
    expect(
      screen.queryByTestId("notification-saved-player_finished"),
    ).toBeNull();
    land(CONFIG);
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(
      screen.getByTestId("notification-saved-player_finished").textContent,
    ).toBe("Saved ✓");
  });

  test("the terminal theme is named for the CLI and stands last", () => {
    renderSettings();
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings[headings.length - 1]).toBe(
      "Terminal pane theme (CLI only)",
    );
    expect(headings).toContain("Keyboard shortcuts");
  });
});

describe("settings-9: a seeded starter config says so once", () => {
  test("the header names the created file; a loaded one says nothing", () => {
    useAppStore.setState({
      configState: { ...CONFIG, seeded: true },
      readiness: READINESS,
      refreshReadiness: vi.fn(async () => {}),
    });
    const { unmount } = render(<SettingsSurface />);
    expect(screen.getByTestId("config-seeded").textContent).toContain(
      "Created a starter config at /tmp/playbook.config.yaml",
    );
    unmount();
    renderSettings();
    expect(screen.queryByTestId("config-seeded")).toBeNull();
  });
});

describe("settings-10: the shortcut sheet and the mode guidance", () => {
  test("the sheet lists every binding with this platform's modifier", () => {
    renderSettings();
    const sheet = screen.getByTestId("shortcuts-section");
    const rows = within(sheet).getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThan(8);
    expect(rows[0].textContent).toContain(keyLabel("P"));
    expect(rows[0].textContent).toContain("Switch or add a project");
    expect(sheet.textContent).toContain("Escape");
    expect(sheet.textContent).toContain("Shift+Enter");
  });

  test("the permission mode explains its stakes", () => {
    renderSettings();
    const section = screen.getByTestId("captain-section");
    fireEvent.click(within(section).getByTestId("captain-edit"));
    expect(within(section).getByTestId("agent-mode-help").textContent).toMatch(
      /^auto:/,
    );
    fireEvent.change(within(section).getByTestId("agent-mode"), {
      target: { value: "bypass" },
    });
    expect(within(section).getByTestId("agent-mode-help").textContent).toBe(
      "bypass: no permission prompts — sandboxed repos only",
    );
  });
});

describe("settings-24: a missing config names the remedy and retries", () => {
  test("the copy names the path, the folder, and a Retry that refreshes", async () => {
    const refresh = vi.fn(async () => {});
    useAppStore.setState({
      configState: { status: "missing", path: "/tmp/playbook.config.yaml" },
      readiness: [],
      refreshReadiness: vi.fn(async () => {}),
      refresh,
    });
    render(<SettingsSurface />);
    const box = screen.getByTestId("config-broken");
    expect(box.textContent).toContain(
      "Spex could not create a starter config at /tmp/playbook.config.yaml — check the folder is writable, then retry.",
    );
    expect(box.textContent).not.toContain("Fix the file in your editor");
    fireEvent.click(screen.getByTestId("config-retry"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("settings-1, DR-038: fast mode is visible and switchable", () => {
  test("the captain chip wears the mark and the editor offers the switch", () => {
    useAppStore.setState({
      configState: {
        ...CONFIG,
        summary: {
          ...CONFIG.summary,
          captain: { ...CONFIG.summary.captain, fastMode: true },
        },
      },
      readiness: READINESS,
      refreshReadiness: vi.fn(async () => {}),
    });
    render(<SettingsSurface />);
    const section = screen.getByTestId("captain-section");
    const chip = within(section).getByTestId("agent-chip");
    expect(within(chip).getByTitle("fast mode").textContent).toBe("⚡");
    expect(chip.getAttribute("aria-label")).toContain("fast mode");
    fireEvent.click(within(section).getByTestId("captain-edit"));
    expect(
      (within(section).getByTestId("agent-fast-mode") as HTMLInputElement)
        .checked,
    ).toBe(true);
    // A lane not in fast mode wears no mark; codex declares none, so
    // its editor offers no switch.
    const reviewer = screen.getByTestId("player-row-dev.reviewer");
    expect(within(reviewer).queryByTitle("fast mode")).toBeNull();
    fireEvent.click(screen.getByTestId("player-edit-dev.reviewer"));
    expect(within(reviewer).queryByTestId("agent-fast-mode")).toBeNull();
  });
});
