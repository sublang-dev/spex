// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// run-view-70/72: the sidebar is the navigator and the tabs are the
// working set (DR-029), and the chrome folds without dropping a duty
// (DR-030). Both drive the whole App against store state, because the
// contract is about how the rail, the strip and the run view agree.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

afterEach(cleanup);

const { commandMock } = vi.hoisted(() => ({ commandMock: vi.fn() }));

vi.mock("./state/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/store.js")>();
  return { ...actual, getClient: () => ({ command: commandMock }) };
});

import { App } from "./App.js";
import {
  deliverServerMessageForTests,
  setClientForTests,
  useAppStore,
} from "./state/store.js";
import { initialSessionView, type SessionView } from "./state/reducer.js";
import { keyLabel } from "./lib/shortcuts.js";
import type { SessionInfo } from "@sublang/spex-core/protocol";

// A live clock: the rows print ages relative to now.
const NOW = Date.now();
const PLAYERS = [{ id: "dev.coder", adapter: "claude" as const }];

function session(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    projectId: "p1",
    projectPath: "/tmp/alpha",
    createdAt: NOW - 60_000,
    live: false,
    endedAt: NOW - 30_000,
    players: PLAYERS,
    initialVisible: ["dev.coder"],
    turns: 1,
    failed: false,
    ...over,
  };
}

/** A loaded transcript; `question` parks it awaiting a Boss reply. */
function view(question?: string): SessionView {
  const loaded = initialSessionView(PLAYERS);
  loaded.loading = false;
  if (question) loaded.pendingQuestion = question;
  return loaded;
}

const OLD_ENDED = Array.from({ length: 6 }, (_, index) =>
  session({
    id: `old-${index}`,
    title: `older work ${index}`,
    endedAt: NOW - 3_600_000 * (index + 2),
  }),
);

const SESSIONS: SessionInfo[] = [
  session({
    id: "a-live",
    title: "harden the session refresh",
    live: true,
    endedAt: null,
    createdAt: NOW - 120_000,
    turns: 2,
  }),
  session({
    id: "a-failed",
    title: "chase the flaky test",
    failed: true,
    endedAt: NOW - 600_000,
  }),
  session({ id: "a-bare", turns: 0, endedAt: NOW - 900_000 }),
  ...OLD_ENDED,
  session({
    id: "b-live",
    projectId: "p2",
    projectPath: "/tmp/beta",
    title: "beta is asking",
    live: true,
    endedAt: null,
  }),
  session({
    id: "b-ended",
    projectId: "p2",
    projectPath: "/tmp/beta",
    title: "beta wrapped up",
  }),
];

// The one attention fold (DR-035): the badge and every dot re-source
// from the core-derived ledger, so the fixture serves one.
const LEDGER = {
  intents: [],
  attention: [
    {
      band: "interrupted",
      kind: "question",
      title: "Which migration should I run first?",
      projectId: "p1",
      sessionId: "a-live",
      since: NOW - 60_000,
    },
    {
      band: "interrupted",
      kind: "question",
      title: "Should I rebase?",
      projectId: "p2",
      sessionId: "b-live",
      since: NOW - 30_000,
    },
  ],
  badge: 2,
} as never;

function seed(): void {
  useAppStore.setState({
    connection: "open",
    everConnected: true,
    projects: [
      { id: "p1", name: "alpha", path: "/tmp/alpha", registeredAt: 0 },
      { id: "p2", name: "beta", path: "/tmp/beta", registeredAt: 1 },
    ] as never,
    projectMeta: {},
    sessions: SESSIONS,
    views: {
      "a-live": view("Which migration should I run first?"),
      "b-live": view("Should I rebase?"),
      "b-ended": view(),
    },
    composers: {},
    runErrors: {},
    currentProjectId: "p1",
    activeSessionId: "a-live",
    workspaceTabs: { p1: "a-live" },
    openTabs: { p1: ["a-live"] },
    expandedProjects: {},
    railCollapsed: false,
    captainSplit: 45,
    specTrees: {},
    specErrors: {},
    homeDraft: "",
    readiness: [],
    machineGraphs: {},
    ledger: LEDGER,
    stagedIntents: {},
    history: {},
    configState: {
      status: "valid",
      summary: { playbooks: [], captain: undefined },
    } as never,
  });
}

// jsdom has no layout, so the strip's keep-in-view call needs a stub.
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  commandMock.mockReset();
  // The App re-pulls the ledger once connected (DR-035): the default
  // reply must keep serving the seeded fold.
  commandMock.mockImplementation(async (type: string) =>
    type === "ledger.get" ? (LEDGER as object) : {},
  );
  // Store actions resolve the module-local client, which the module
  // mock above cannot reach.
  setClientForTests({
    command: commandMock,
    subscribe: vi.fn(async () => {}),
  } as never);
  seed();
});

describe("run-view-70: the sidebar navigates, the tabs hold what is open", () => {
  test("rows read as conversations, attention first, history quiet", () => {
    render(<App />);

    // Dashboard stands first and carries the cross-project count
    // (run-view-34): both live sessions are waiting.
    const rail = screen.getByTestId("sidebar");
    const entries = Array.from(rail.querySelectorAll("button")).map(
      (button) => button.textContent,
    );
    expect(entries[0]).toContain("Dashboard");
    expect(screen.getByTestId("nav-attention-badge").textContent).toBe("2");

    // Past nine the badge prints "9+", the count in the entry's name
    // and tooltip (run-view-108).
    act(() => {
      useAppStore.setState({
        ledger: { ...(LEDGER as Record<string, unknown>), badge: 12 } as never,
      });
    });
    expect(screen.getByTestId("nav-attention-badge").textContent).toBe("9+");
    expect(screen.getByTestId("nav-attention-badge").title).toContain("12");
    expect(
      screen.getByRole("button", { name: "Dashboard — 12 need your attention" }),
    ).toBeTruthy();
    act(() => {
      useAppStore.setState({ ledger: LEDGER });
    });

    // The current project is disclosed; its live row wears amber for
    // the waiting question, not emerald for merely being alive.
    const liveRow = screen.getByTestId("sidebar-session-a-live");
    expect(liveRow.dataset.selected).toBeUndefined();
    expect(
      screen.getByTestId("sidebar-mark-a-live").dataset.life,
    ).toBe("question");
    expect(liveRow.textContent).toContain("harden the session refresh");
    // The compact age is printed with the exact moment on hover, and
    // the fuller scent is in the accessible description (run-view-73).
    expect(liveRow.textContent).toContain("2m");
    expect(screen.getByTestId("sidebar-age-a-live").title).toBe(
      new Date(NOW - 120_000).toLocaleString(),
    );
    expect(liveRow.getAttribute("aria-label")).toContain("2m ago");
    expect(liveRow.getAttribute("aria-label")).toContain("2 turns");

    // A failure the session ended holding is history, not a summons.
    expect(
      screen.getByTestId("sidebar-mark-a-failed").dataset.life,
    ).toBe("ended-failed");
    expect(
      screen.getByTestId("sidebar-session-a-failed").getAttribute("aria-label"),
    ).toContain("held a failure");

    // A session that never spoke says so instead of faking a name.
    expect(screen.getByTestId("sidebar-session-a-bare").textContent).toContain(
      "no messages yet",
    );

    // The other project is collapsed and still shows it needs a human.
    expect(screen.queryByTestId("sidebar-session-b-ended")).toBeNull();
    expect(screen.getByTestId("sidebar-project-attention-p2")).toBeTruthy();
  });

  test("the recent window holds, and its control reveals the rest", () => {
    render(<App />);
    // Six ended sessions plus the live one: only five ended list.
    expect(screen.queryByTestId("sidebar-session-old-5")).toBeNull();
    fireEvent.click(screen.getByTestId("sidebar-more-p1"));
    expect(screen.getByTestId("sidebar-session-old-5")).toBeTruthy();
  });

  test("disclosing another project leaves the workspace where it is", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("sidebar-disclose-p2"));
    expect(screen.getByTestId("sidebar-session-b-ended")).toBeTruthy();
    expect(useAppStore.getState().currentProjectId).toBe("p1");
  });

  test("selection follows the surface, and the Workspace restores it", () => {
    render(<App />);
    const rail = screen.getByTestId("sidebar");
    const selectedRows = () =>
      rail.querySelectorAll('[role="treeitem"][aria-selected="true"]');
    const entry = (name: string) =>
      within(rail).getByRole("button", { name });

    // The Workspace is the surface: the current project is selected,
    // and so is the session whose tab it is showing.
    expect(selectedRows().length).toBe(2);
    expect(
      screen.getByTestId("sidebar-project-p1").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("sidebar-session-a-live").getAttribute("aria-selected"),
    ).toBe("true");

    // Playbooks is a place of its own: its entry is the only current
    // one, and no row in the tree still reads as where the reader is.
    fireEvent.click(entry("Playbooks"));
    expect(entry("Playbooks").getAttribute("aria-current")).toBe("page");
    expect(selectedRows().length).toBe(0);

    // The store still remembers the project, so choosing the Workspace
    // again lights the same rows.
    fireEvent.click(entry("Workspace"));
    expect(
      screen.getByTestId("sidebar-project-p1").getAttribute("aria-selected"),
    ).toBe("true");
    expect(selectedRows().length).toBe(2);
  });

  test("a foreign session opens as a read-only tab, once", async () => {
    commandMock.mockResolvedValue({ records: [] });
    render(<App />);
    fireEvent.click(screen.getByTestId("sidebar-disclose-p2"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("sidebar-session-b-ended"));
    });
    expect(useAppStore.getState().currentProjectId).toBe("p2");
    expect(useAppStore.getState().openTabs.p2).toEqual(["b-ended"]);
    // Ended means read-only: the composer gives way to the notice.
    expect(screen.getByTestId("ended-notice")).toBeTruthy();
    expect(screen.queryByTestId("end-session")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("sidebar-session-b-ended"));
    });
    expect(useAppStore.getState().openTabs.p2).toEqual(["b-ended"]);
  });

  test("ending keeps the transcript put and marks the row ended", async () => {
    render(<App />);
    expect(screen.getByTestId("end-session")).toBeTruthy();

    fireEvent.click(screen.getByTestId("end-session"));
    await act(async () => {
      fireEvent.click(screen.getByText("End"));
    });
    expect(commandMock).toHaveBeenCalledWith("session.dispose", {
      sessionId: "a-live",
    });

    // The core answers with the ended state; the tab must not move.
    // Ending also clears the session's attention from the ledger fold
    // (intents.changed re-pulls it in production).
    await act(async () => {
      useAppStore.setState({
        sessions: SESSIONS.map((entry) =>
          entry.id === "a-live"
            ? { ...entry, live: false, endedAt: NOW }
            : entry,
        ),
        ledger: {
          ...(LEDGER as { attention: { sessionId: string }[] }),
          attention: (
            LEDGER as { attention: { sessionId: string }[] }
          ).attention.filter((entry) => entry.sessionId !== "a-live"),
          badge: 1,
        } as never,
      });
    });
    expect(useAppStore.getState().openTabs.p1).toEqual(["a-live"]);
    expect(screen.getByTestId("ended-notice")).toBeTruthy();
    expect(screen.getByTestId("tab-ended-a-live")).toBeTruthy();
    expect(screen.getByTestId("sidebar-mark-a-live").dataset.life).toBe(
      "ended",
    );
  });

  test("the tree walks by keyboard and keeps its own letters", async () => {
    render(<App />);
    const project = screen.getByTestId("sidebar-project-p1");
    project.focus();

    // One focus stop, arrow keys within it (run-view-67).
    fireEvent.keyDown(project, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByTestId("sidebar-session-a-live"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(project);

    // Disclosure by keyboard, and it never moves the workspace.
    fireEvent.keyDown(project, { key: "ArrowLeft" });
    expect(project.getAttribute("aria-expanded")).toBe("false");
    expect(useAppStore.getState().currentProjectId).toBe("p1");

    // Type-ahead reaches a session by its own first words, and the
    // composer does not steal the letter (run-view-49).
    fireEvent.keyDown(project, { key: "ArrowRight" });
    fireEvent.keyDown(project, { key: "c" });
    expect(document.activeElement).toBe(
      screen.getByTestId("sidebar-session-a-failed"),
    );
  });

  test("closing a tab files the session back, still listed", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("tab-close-a-live"));
    expect(useAppStore.getState().openTabs.p1).toEqual([]);
    // Closing stops nothing: no dispose was asked for.
    expect(commandMock).not.toHaveBeenCalledWith(
      "session.dispose",
      expect.anything(),
    );
    expect(screen.getByTestId("sidebar-session-a-live")).toBeTruthy();
  });
});

describe("run-view-72: the chrome folds without dropping a duty", () => {
  test("the binding collapses and the foot control restores", () => {
    const { unmount } = render(<App />);
    expect(screen.getByTestId("sidebar").dataset.collapsed).toBe("0");

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    const collapsed = screen.getByTestId("sidebar");
    expect(collapsed.dataset.collapsed).toBe("1");
    // Collapsed entries keep their names and the count survives.
    expect(screen.getByLabelText(/^Playbooks$/)).toBeTruthy();
    expect(screen.getByTestId("nav-attention-badge").textContent).toBe("2");
    // Sessions stop listing, but the open tab is still the reach.
    expect(screen.queryByTestId("sidebar-session-a-live")).toBeNull();
    expect(screen.getByRole("tab", { selected: true })).toBeTruthy();
    // The palette control keeps its icon-only form under the
    // Workspace entry (DR-030): collapse never hides a duty.
    const palette = screen.getByLabelText("Switch or add a project");
    expect(palette.title).toBe(`Switch or add a project (${keyLabel("P")})`);
    fireEvent.click(palette);
    expect(screen.getByRole("dialog", { name: "Choose a project" })).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("palette-search"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose a project" })).toBeNull();

    // Chrome state is a preference: it survives a remount.
    unmount();
    render(<App />);
    expect(screen.getByTestId("sidebar").dataset.collapsed).toBe("1");

    fireEvent.click(screen.getByTestId("sidebar-collapse"));
    expect(screen.getByTestId("sidebar").dataset.collapsed).toBe("0");
  });

  test("a broken config keeps its red voice while collapsed", () => {
    useAppStore.setState({
      configState: { status: "invalid", errors: ["captain: missing"] } as never,
      railCollapsed: true,
    });
    render(<App />);
    expect(
      screen.getByLabelText("Config invalid — open Settings"),
    ).toBeTruthy();
  });
});

describe("run-view-50: a boot that never connects says so, after its grace", () => {
  test("the banner waits eight seconds, then names the endpoint with Retry", () => {
    vi.useFakeTimers();
    try {
      useAppStore.setState({
        connection: "closed",
        everConnected: false,
        coreUrl: "ws://127.0.0.1:8137/?token=secret",
      } as never);
      render(<App />);
      act(() => {
        vi.advanceTimersByTime(7_900);
      });
      expect(screen.queryByRole("alert")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      const banner = screen.getByRole("alert");
      expect(banner.textContent).toContain("Can't reach the Spex core");
      expect(banner.textContent).toContain("ws://127.0.0.1:8137/?token=…");
      expect(within(banner).getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("run-view-81: the reader sets the Captain/players split", () => {
  // The split rides a custom property the side-by-side form reads;
  // stacked below 42rem the column is full width (run-view-107).
  const split = () =>
    screen.getByTestId("captain-column").style.getPropertyValue("--captain-split");

  test("keys move it, a double-click restores it, and it persists", () => {
    const { unmount } = render(<App />);
    expect(split()).toBe("45%");

    const divider = screen.getByTestId("captain-divider");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(split()).toBe("47%");

    // Chrome state is a preference: it survives a remount (DR-030).
    unmount();
    render(<App />);
    expect(split()).toBe("47%");

    fireEvent.doubleClick(screen.getByTestId("captain-divider"));
    expect(split()).toBe("45%");
  });

  test("neither side can be squeezed away", () => {
    render(<App />);
    const divider = screen.getByTestId("captain-divider");
    for (let nudge = 0; nudge < 40; nudge += 1) {
      fireEvent.keyDown(divider, { key: "ArrowLeft" });
    }
    expect(split()).toBe("22%");
    for (let nudge = 0; nudge < 60; nudge += 1) {
      fireEvent.keyDown(divider, { key: "ArrowRight" });
    }
    expect(split()).toBe("70%");
  });
});

describe("run-view-57: a workspace holding projects opens inside one", () => {
  test("a launch with nothing remembered adopts a registered project", async () => {
    // Nothing persisted and no live session — the state a first launch
    // after registering elsewhere lands in. The workspace still opens
    // in a project rather than sending the reader to the sidebar.
    // Ids no earlier run could have remembered, so the assertion can
    // only be met by the fallback and not by a persisted choice.
    useAppStore.setState({ currentProjectId: undefined, projects: [] });
    commandMock.mockImplementation(async (type: string) => {
      if (type === "project.list") {
        return [
          { id: "fresh-1", name: "alpha", path: "/tmp/alpha", registeredAt: 0 },
          { id: "fresh-2", name: "beta", path: "/tmp/beta", registeredAt: 1 },
        ];
      }
      if (type === "session.list") return [];
      if (type === "readiness.get") return [];
      if (type === "config.get") {
        return { status: "valid", summary: { playbooks: [], captain: undefined } };
      }
      return {};
    });

    await useAppStore.getState().refresh();

    expect(useAppStore.getState().currentProjectId).toBe("fresh-1");
  });
});

describe("run-view-58, projects-4: the Overview tab pins the project's group", () => {
  test("the strip ends with Specs and Overview; the Overview draws header and group", async () => {
    commandMock.mockImplementation(async (type: string) => {
      if (type === "ledger.get") return LEDGER;
      if (type === "project.status") {
        return { branch: "main", dirty: true, ahead: 2, behind: 0 };
      }
      if (type === "forge.items") {
        return {
          adapter: "github",
          authenticated: null,
          issues: [],
          prs: [],
          guidance:
            "No GitHub origin remote — add one to list issues and PRs here.",
        };
      }
      if (type === "specs.get") {
        return {
          present: true,
          legacy: false,
          files: [],
          decisions: [],
          intents: [],
          notices: [],
          readAt: NOW,
        };
      }
      if (type === "ledger.history") return { intents: [], more: false };
      return {};
    });
    render(<App />);
    expect(screen.queryByTestId("workspace-tab-repo")).toBeNull();
    const tab = screen.getByTestId("workspace-tab-overview");
    expect(tab.textContent).toBe("Overview");
    fireEvent.click(tab);
    const overview = await screen.findByTestId("overview-tab");

    // The repository header (projects-4).
    await vi.waitFor(() => expect(overview.textContent).toContain("main"));
    expect(overview.textContent).toContain("/tmp/alpha");
    expect(within(overview).getByTitle("uncommitted changes")).toBeTruthy();
    expect(within(overview).getByTitle("ahead of upstream").textContent).toBe(
      "↑2",
    );
    expect(
      within(overview).getByRole("button", { name: "Remove project" }),
    ).toBeTruthy();

    // The project's own group, no project filter (dashboard-26, DR-038).
    expect(within(overview).getByTestId("project-group-p1")).toBeTruthy();
    for (const band of ["history", "now", "upnext", "sources"]) {
      expect(within(overview).getByTestId(`${band}-p1`)).toBeTruthy();
    }
    expect(
      within(overview).queryByRole("combobox", { name: "Filter by project" }),
    ).toBeNull();

    // The GitHub setup guidance sits in the Sources band (projects-7,
    // dashboard-8), so the Dashboard and the Overview show one thing.
    expect(
      within(overview).getByTestId("sources-guidance-p1").textContent,
    ).toContain("No GitHub origin remote");
  });

  test("a remembered 'repo' tab lands on the Overview, and the cycle walks it", () => {
    useAppStore.setState({ workspaceTabs: { p1: "repo" } });
    render(<App />);
    expect(
      screen.getByTestId("workspace-tab-overview").getAttribute("aria-selected"),
    ).toBe("true");
    // ⌘⇧[ from the Overview reaches Specs; ⌘⇧] returns (run-view-58).
    fireEvent.keyDown(window, {
      code: "BracketLeft",
      metaKey: true,
      shiftKey: true,
    });
    expect(useAppStore.getState().workspaceTabs.p1).toBe("specs");
    fireEvent.keyDown(window, {
      code: "BracketRight",
      metaKey: true,
      shiftKey: true,
    });
    expect(useAppStore.getState().workspaceTabs.p1).toBe("overview");
  });
});

describe("DR-038, core-service-70: sessions can be deleted from the sidebar", () => {
  test.each(["active", "unknown"] as const)("external %s ownership removes open End/Delete confirmations and keeps the transcript", (externalWriter) => {
    const composer = {draft: "Keep draft", queued: [{text: "Keep queue"}]};
    useAppStore.setState({composers: {"a-live": composer}});
    render(<App />);
    fireEvent.click(screen.getByRole("button", {name: "End session"}));
    expect(screen.getByRole("button", {name: "End"})).toBeTruthy();
    fireEvent.click(screen.getByTestId("sidebar-delete-a-failed"));
    expect(screen.getByTestId("sidebar-delete-confirm-a-failed")).toBeTruthy();
    act(() => {
      useAppStore.setState({sessions: SESSIONS.map((entry) =>
        ["a-live", "a-failed"].includes(entry.id)
          ? {...entry, externalWriter, live: externalWriter === "active", endedAt: null}
          : entry)});
    });
    expect(screen.getByTestId("session-external-owner")).toBeTruthy();
    expect(screen.getByTestId("captain-pane")).toBeTruthy();
    expect(screen.queryByTestId("boss-composer")).toBeNull();
    expect(screen.queryByTestId("tab-ended-a-live")).toBeNull();
    expect(screen.queryByRole("button", {name: "End"})).toBeNull();
    expect(screen.queryByRole("button", {name: "End session"})).toBeNull();
    expect(screen.queryByTestId("sidebar-delete-confirm-a-failed")).toBeNull();
    expect(screen.queryByTestId("sidebar-delete-a-failed")).toBeNull();
    expect(screen.queryByTestId("sidebar-delete-a-live")).toBeNull();
    expect(screen.getByTestId("sidebar-session-a-live").getAttribute("aria-label"))
      .toContain(externalWriter === "active" ? "in use elsewhere" : "ownership unknown");
    expect(useAppStore.getState().composers["a-live"]).toEqual(composer);
    expect(commandMock).not.toHaveBeenCalledWith("session.dispose", expect.anything());
    expect(commandMock).not.toHaveBeenCalledWith("session.delete", expect.anything());
  });

  test("an ended session offers delete; the confirm sends session.delete and every trace goes", async () => {
    render(<App />);
    // A live session carries no delete control; an ended one does.
    expect(screen.queryByTestId("sidebar-delete-a-live")).toBeNull();
    const control = screen.getByTestId("sidebar-delete-a-failed");
    expect(control.getAttribute("aria-label")).toBe(
      "Delete session chase the flaky test",
    );
    fireEvent.click(control);
    // The control never activates the row.
    expect(useAppStore.getState().openTabs.p1).toEqual(["a-live"]);
    const confirm = screen.getByTestId("sidebar-delete-confirm-a-failed");
    expect(confirm.textContent).toContain(
      "Delete this session and its transcript?",
    );
    // Keep backs out, and nothing was asked of the core.
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep" }));
    expect(screen.queryByTestId("sidebar-delete-confirm-a-failed")).toBeNull();
    expect(commandMock).not.toHaveBeenCalledWith(
      "session.delete",
      expect.anything(),
    );

    // Open the ended session as a tab, so the removal has one to close.
    commandMock.mockImplementation(async (type: string) =>
      type === "ledger.get"
        ? (LEDGER as object)
        : type === "history.get"
          ? { records: [] }
          : {},
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("sidebar-session-a-failed"));
    });
    expect(useAppStore.getState().openTabs.p1).toEqual(["a-live", "a-failed"]);

    fireEvent.click(screen.getByTestId("sidebar-delete-a-failed"));
    await act(async () => {
      fireEvent.click(
        within(
          screen.getByTestId("sidebar-delete-confirm-a-failed"),
        ).getByRole("button", { name: "Delete" }),
      );
    });
    expect(commandMock).toHaveBeenCalledWith("session.delete", {
      sessionId: "a-failed",
    });
    // The reply forgets it: the listing, its tab, its transcript.
    expect(screen.queryByTestId("sidebar-session-a-failed")).toBeNull();
    expect(useAppStore.getState().openTabs.p1).toEqual(["a-live"]);
    expect(useAppStore.getState().views["a-failed"]).toBeUndefined();
  });

  test("a session another host wrote offers delete, the confirm naming the terminal history (DR-042)", async () => {
    useAppStore.setState({
      sessions: SESSIONS.map((entry) =>
        entry.id === "a-failed" ? { ...entry, foreign: true as const } : entry,
      ),
    });
    render(<App />);
    expect(screen.getByTestId("sidebar-delete-a-bare")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sidebar-delete-a-failed"));
    const confirm = screen.getByTestId("sidebar-delete-confirm-a-failed");
    expect(confirm.textContent).toContain(
      "Delete this session? It was run from the terminal; its history goes too.",
    );
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    });
    expect(commandMock).toHaveBeenCalledWith("session.delete", {
      sessionId: "a-failed",
    });
  });

  test("the removal broadcast drops the session and closes its tab", () => {
    useAppStore.setState({
      openTabs: { p1: ["a-live", "a-failed"] },
      workspaceTabs: { p1: "a-failed" },
      views: { ...useAppStore.getState().views, "a-failed": view() },
    });
    render(<App />);
    act(() => {
      deliverServerMessageForTests({
        type: "session.removed",
        sessionId: "a-failed",
        projectId: "p1",
      });
    });
    expect(screen.queryByTestId("sidebar-session-a-failed")).toBeNull();
    expect(useAppStore.getState().openTabs.p1).toEqual(["a-live"]);
    // The closed tab lands on a neighbour (run-view-47).
    expect(useAppStore.getState().workspaceTabs.p1).toBe("a-live");
    expect(useAppStore.getState().views["a-failed"]).toBeUndefined();
  });

  test("the core's refusal shows at the row, the session kept", async () => {
    commandMock.mockImplementation(async (type: string) => {
      if (type === "session.delete") {
        throw new Error("the session is live — end it first");
      }
      return type === "ledger.get" ? (LEDGER as object) : {};
    });
    render(<App />);
    fireEvent.click(screen.getByTestId("sidebar-delete-a-failed"));
    await act(async () => {
      fireEvent.click(
        within(
          screen.getByTestId("sidebar-delete-confirm-a-failed"),
        ).getByRole("button", { name: "Delete" }),
      );
    });
    expect(screen.getByTestId("sidebar-delete-error-a-failed").title).toContain(
      "end it first",
    );
    expect(screen.getByTestId("sidebar-session-a-failed")).toBeTruthy();
  });
});

describe("run-view-48/50: the strip walks by keyboard and names its attention", () => {
  beforeEach(() => {
    useAppStore.setState({ openTabs: { p1: ["a-live", "a-failed"] } });
  });

  test("one Tab stop, arrows and Home/End between tabs, attention in the name", () => {
    render(<App />);
    const live = screen.getByRole("tab", {
      name: "harden the session refresh — needs your reply",
    });
    const failed = screen.getByRole("tab", {
      name: "chase the flaky test — ended",
    });
    const plus = screen.getByRole("tab", { name: "Start another session" });
    const specs = screen.getByTestId("workspace-tab-specs");
    const overview = screen.getByTestId("workspace-tab-overview");
    expect(live.tabIndex).toBe(0);
    for (const other of [failed, plus, specs, overview]) {
      expect(other.tabIndex).toBe(-1);
    }

    live.focus();
    fireEvent.keyDown(live, { key: "ArrowRight" });
    expect(document.activeElement).toBe(failed);
    fireEvent.keyDown(failed, { key: "ArrowRight" });
    expect(document.activeElement).toBe(plus);
    fireEvent.keyDown(plus, { key: "End" });
    expect(document.activeElement).toBe(overview);
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(document.activeElement).toBe(live);
    fireEvent.keyDown(live, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(overview);
    fireEvent.keyDown(overview, { key: "Home" });
    expect(document.activeElement).toBe(live);
    // Walking the strip activates nothing.
    expect(useAppStore.getState().workspaceTabs.p1).toBe("a-live");

    // A tooltip naming a shortcut prints the platform's own modifier.
    expect(specs.title).toBe(
      `The project's spec packages (${keyLabel("⇧S")})`,
    );
    expect(plus.title).toBe(`Start another session (${keyLabel("N")})`);
  });

  test("closing tabs and ending a session leave focus on a tab", async () => {
    render(<App />);
    const failed = screen.getByRole("tab", {
      name: "chase the flaky test — ended",
    });
    failed.focus();
    fireEvent.keyDown(failed, { key: "Delete" });
    expect(useAppStore.getState().openTabs.p1).toEqual(["a-live"]);
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: /harden the session refresh/ }),
    );

    fireEvent.click(screen.getByTestId("end-session"));
    await act(async () => {
      fireEvent.click(screen.getByText("End"));
    });
    const live = screen.getByRole("tab", { name: /harden the session refresh/ });
    expect(document.activeElement).toBe(live);

    // The last session tab closed: the workspace falls to the start
    // view, whose composer is ready to type — never the body.
    fireEvent.keyDown(live, { key: "Delete" });
    expect(useAppStore.getState().openTabs.p1).toEqual([]);
    expect(document.activeElement).toBe(screen.getByTestId("start-composer"));
  });
});

describe("spec-view-7, dashboard-24: a History record opens in the reader", () => {
  // A finished record in alpha's tree: History lists it on the
  // Dashboard and the Overview alike.
  function serveFinishedRecord(): void {
    const tree = {
      present: true,
      legacy: false,
      files: [],
      decisions: [],
      intents: [
        {
          id: "IR-001",
          title: "First intent",
          path: "intents/001-first-intent.md",
          status: "Done",
          finished: "done",
          updatedAt: NOW - 1_000,
        },
      ],
      notices: [],
      readAt: NOW,
    };
    commandMock.mockImplementation(async (type: string) => {
      if (type === "ledger.get") return LEDGER;
      if (type === "ledger.history") return { intents: [], more: false };
      if (type === "specs.get") return tree;
      if (type === "specs.read") {
        return {
          markdown: "# IR-001: First intent\n\nThe first intent, done.",
          version: "v1",
        };
      }
      if (type === "project.status") {
        return { branch: "main", dirty: false, ahead: 0, behind: 0 };
      }
      if (type === "forge.items") {
        return { adapter: "github", authenticated: null, issues: [], prs: [] };
      }
      return {};
    });
  }

  test("a finished record row on the Overview lands in the Specs tab's reader", async () => {
    serveFinishedRecord();
    render(<App />);
    fireEvent.click(screen.getByTestId("workspace-tab-overview"));
    const overview = await screen.findByTestId("overview-tab");
    const row = await within(overview).findByTestId("history-row-IR-001");
    fireEvent.click(within(row).getByRole("button"));

    // The Specs tab takes over and its reader shows the record — the
    // request survives the tree read the tab activation triggers.
    expect(
      screen.getByTestId("workspace-tab-specs").getAttribute("aria-selected"),
    ).toBe("true");
    const reader = await screen.findByTestId("record-reader");
    await within(reader).findByText("The first intent, done.");
    expect(commandMock).toHaveBeenCalledWith("specs.read", {
      projectId: "p1",
      path: "intents/001-first-intent.md",
    });
  });

  test("spec-view-57: Back from a record opened on the Overview returns to the Overview row", async () => {
    serveFinishedRecord();
    render(<App />);
    fireEvent.click(screen.getByTestId("workspace-tab-overview"));
    const overview = await screen.findByTestId("overview-tab");
    const row = await within(overview).findByTestId("history-row-IR-001");
    fireEvent.click(within(row).getByRole("button"));
    const reader = await screen.findByTestId("record-reader");
    await within(reader).findByText("The first intent, done.");

    // Back names where the record came from, and leads there: the
    // Overview tab, with the invoking row focused (DR-010 §6).
    const back = screen.getByTestId("reader-back");
    expect(back.textContent).toBe("← Back to Overview");
    fireEvent.click(back);
    expect(screen.queryByTestId("record-reader")).toBeNull();
    expect(
      screen.getByTestId("workspace-tab-overview").getAttribute("aria-selected"),
    ).toBe("true");
    const returned = await screen.findByTestId("history-row-IR-001");
    expect(document.activeElement).toBe(within(returned).getByRole("button"));
  });

  test("spec-view-57: Back from a record opened on the Dashboard returns to the Dashboard row", async () => {
    serveFinishedRecord();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Dashboard/ }));
    const group = await screen.findByTestId("project-group-p1");
    const row = await within(group).findByTestId("history-row-IR-001");
    fireEvent.click(within(row).getByRole("button"));
    const reader = await screen.findByTestId("record-reader");
    await within(reader).findByText("The first intent, done.");
    expect(screen.queryByTestId("project-group-p1")).toBeNull();

    const back = screen.getByTestId("reader-back");
    expect(back.textContent).toBe("← Back to Dashboard");
    fireEvent.click(back);
    expect(screen.queryByTestId("record-reader")).toBeNull();
    // The Dashboard is back with the project's group and its row
    // focused, the row scrolled into view.
    const returnedGroup = await screen.findByTestId("project-group-p1");
    const returned = within(returnedGroup).getByTestId("history-row-IR-001");
    const control = within(returned).getByRole("button");
    expect(document.activeElement).toBe(control);
    expect(control.scrollIntoView).toHaveBeenCalled();
  });
});
