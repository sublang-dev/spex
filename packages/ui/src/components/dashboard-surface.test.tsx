// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The Dashboard as the intent ledger's surface (DR-035): the two-band
// attention queue with its verdict acts (dashboard-1..4), the
// all-clear pull (dashboard-8), the per-project groups' four bands
// (dashboard-26..30), capture with the shelf reveal (dashboard-30/31,
// 37), the paged Sources tabs with the captured-artifact swap
// (dashboard-19/20/24/25), History as done work (dashboard-27/38,
// DR-038), empty states without takeover (dashboard-8/21/22), the
// row menu as the house popover with Move up/down and Undo
// (dashboard-29), focus hand-offs (dashboard-4, projects-9, DR-010
// §6), and the Overview tab's header over the shared group
// (projects-4/6/7/9, forge-work-lists-1).

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  AttentionEntry,
  DerivedIntent,
  ForgeState,
  IntentInfo,
  IntentSource,
  LedgerState,
  SpecTreeState,
} from "@sublang/spex-core/protocol";

import { DashboardSurface } from "./DashboardSurface.js";
import { OverviewTab } from "./ProjectsSurface.js";
import { setClientForTests, useAppStore } from "../state/store.js";
import { initialSessionView } from "../state/reducer.js";

afterEach(() => {
  cleanup();
  setClientForTests(undefined);
});

const commandMock = vi.fn();

const NOW = Date.now();
const MIN = 60_000;

const PROJECTS = [
  { id: "p1", name: "alpha", path: "/tmp/alpha", registeredAt: 0 },
  { id: "p2", name: "beta", path: "/tmp/beta", registeredAt: 1 },
];

const EMPTY_TREE: SpecTreeState = {
  present: true,
  legacy: false,
  files: [],
  decisions: [],
  intents: [],
  notices: [],
  readAt: NOW,
};

const EMPTY_LEDGER: LedgerState = { intents: [], attention: [], badge: 0 };

function info(
  over: Partial<IntentInfo> & { id: string; projectId: string; text: string },
): IntentInfo {
  return { rank: "m", createdAt: NOW - 60 * MIN, ...over };
}

function q(
  id: string,
  projectId: string,
  text: string,
  over: Partial<DerivedIntent> = {},
): DerivedIntent {
  return { intent: info({ id, projectId, text }), state: "queued", ...over };
}

/** Seed the real store; the client is faked via setClientForTests. */
function seed(over: Record<string, unknown> = {}) {
  useAppStore.setState({
    connection: "open",
    projects: PROJECTS,
    projectMeta: { p1: {}, p2: {} },
    specTrees: { p1: EMPTY_TREE, p2: EMPTY_TREE },
    sessions: [],
    views: {},
    history: {
      p1: { intents: [], more: false },
      p2: { intents: [], more: false },
    },
    ledger: EMPTY_LEDGER,
    ledgerError: undefined,
    stagedIntents: {},
    foldedSources: {},
    ...over,
  } as never);
}

beforeEach(() => {
  commandMock.mockReset();
  commandMock.mockImplementation(async (type: string) => {
    if (type === "ledger.get") {
      return useAppStore.getState().ledger ?? EMPTY_LEDGER;
    }
    if (type === "ledger.history") return { intents: [], more: false };
    return {};
  });
  setClientForTests({
    command: commandMock,
    subscribe: vi.fn(async () => null),
  } as never);
});

function renderSurface(over: {
  onOpenSession?: Mock<(sessionId: string, turnId?: number) => void>;
  onOpenIntent?: Mock<(projectId: string, path: string, anchor: string) => void>;
  onStartIntent?: Mock<(intent: IntentInfo) => void>;
  onNavigate?: Mock<(surface: "Workspace") => void>;
} = {}) {
  const onOpenSession =
    over.onOpenSession ?? vi.fn<(sessionId: string, turnId?: number) => void>();
  const onOpenIntent =
    over.onOpenIntent ??
    vi.fn<(projectId: string, path: string, anchor: string) => void>();
  const onStartIntent =
    over.onStartIntent ?? vi.fn<(intent: IntentInfo) => void>();
  const onNavigate = over.onNavigate ?? vi.fn<(surface: "Workspace") => void>();
  render(
    <DashboardSurface
      onOpenSession={onOpenSession}
      onOpenIntent={onOpenIntent}
      onStartIntent={onStartIntent}
      onNavigate={onNavigate}
    />,
  );
  return { onOpenSession, onOpenIntent, onStartIntent, onNavigate };
}

function callsOf(type: string) {
  return commandMock.mock.calls
    .filter((call) => call[0] === type)
    .map((call) => call[1]);
}

/** A stateful ledger behind the command mock: close removes, queue
 * appends, move reorders, and ledger.get serves the current state —
 * enough for the queue's acts to read back the way the core's fold
 * would serve them. */
function ledgerMock(initial: LedgerState): () => LedgerState {
  let current = initial;
  let minted = 0;
  commandMock.mockImplementation(async (type: string, fields) => {
    if (type === "ledger.get") return current;
    if (type === "ledger.history") return { intents: [], more: false };
    if (type === "intent.close") {
      const { intentId } = fields as { intentId: string };
      current = {
        ...current,
        intents: current.intents.filter((d) => d.intent.id !== intentId),
        attention: current.attention.filter((e) => e.intentId !== intentId),
      };
      return {};
    }
    if (type === "intent.queue") {
      const input = fields as {
        projectId: string;
        text: string;
        source?: IntentSource;
      };
      minted += 1;
      const intent = info({
        id: `i-new-${minted}`,
        projectId: input.projectId,
        text: input.text,
        ...(input.source ? { source: input.source } : {}),
      });
      current = {
        ...current,
        intents: [...current.intents, { intent, state: "queued" }],
      };
      return intent;
    }
    if (type === "intent.move") {
      const { intentId, afterIntentId } = fields as {
        intentId: string;
        afterIntentId: string | null;
      };
      const moving = current.intents.find((d) => d.intent.id === intentId);
      if (moving) {
        const rest = current.intents.filter((d) => d.intent.id !== intentId);
        const at =
          afterIntentId === null
            ? 0
            : rest.findIndex((d) => d.intent.id === afterIntentId) + 1;
        rest.splice(at, 0, moving);
        current = { ...current, intents: rest };
      }
      return {};
    }
    return {};
  });
  return () => current;
}

// ---------------------------------------------------------------------------
// Attention queue
// ---------------------------------------------------------------------------

const ATTENTION: AttentionEntry[] = [
  {
    band: "interrupted",
    kind: "question",
    intentId: "iq",
    title: "Fix login",
    projectId: "p1",
    sessionId: "s1",
    turnId: 4,
    since: NOW - 10 * MIN,
  },
  {
    band: "interrupted",
    kind: "permission",
    title: "claude wants to push",
    projectId: "p1",
    sessionId: "s6",
    since: NOW - 6 * MIN,
  },
  {
    band: "interrupted",
    kind: "failure",
    intentId: "if",
    title: "Migrate DB",
    projectId: "p2",
    sessionId: "s2",
    since: NOW - 5 * MIN,
  },
  {
    band: "finished",
    kind: "finish",
    intentId: "id1",
    title: "Ship docs",
    projectId: "p1",
    sessionId: "s3",
    turnId: 9,
    since: NOW - 30 * MIN,
    stats: { reviewRounds: 2, turns: 3, elapsedMs: 12 * MIN },
  },
  {
    band: "finished",
    kind: "finish",
    intentId: "id2",
    title: "Tidy CI",
    projectId: "p2",
    sessionId: "s5",
    since: NOW - 8 * MIN,
    stats: { turns: 1, elapsedMs: MIN },
  },
  {
    band: "finished",
    kind: "review",
    title: "chat about tests",
    projectId: "p2",
    sessionId: "s4",
    turnId: 2,
    since: NOW - 2 * MIN,
  },
];

describe("dashboard-1/2/3/35: the two-band attention queue", () => {
  test("bands render in served order with human reasons and tones", () => {
    seed({ ledger: { intents: [], attention: ATTENTION, badge: 6 } });
    const { onOpenSession } = renderSurface();

    const queue = screen.getByTestId("attention-queue");
    const rows = Array.from(queue.querySelectorAll("[data-band]"));
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "attention-iq-question",
      "attention-s6-permission",
      "attention-if-failure",
      "attention-id1-finish",
      "attention-id2-finish",
      "attention-s4-review",
    ]);
    // Interrupted before finished, as the fold serves it.
    expect(rows.map((row) => row.getAttribute("data-band"))).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
      "finished",
      "finished",
      "finished",
    ]);
    // Amber waits on the human; only the unacknowledged failure is red.
    expect(
      rows.map((row) => row.getAttribute("data-tone")),
    ).toEqual(["amber", "amber", "red", "amber", "amber", "amber"]);

    // Status speaks human (DR-010 §2), and the row names its project
    // and how long it has waited.
    const question = screen.getByTestId("attention-iq-question");
    expect(question.textContent).toContain("needs your reply");
    expect(question.textContent).toContain("Fix login");
    expect(question.textContent).toContain("alpha");
    // The age says "ago" and carries the absolute moment (DR-010 §2).
    expect(question.textContent).toContain("10m ago");
    expect(
      within(question).getByTitle(
        new Date(ATTENTION[0].since).toLocaleString(),
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId("attention-s6-permission").textContent,
    ).toContain("awaiting permission");
    expect(screen.getByTestId("attention-if-failure").textContent).toContain(
      "failed",
    );
    expect(screen.getByTestId("attention-id1-finish").textContent).toContain(
      "finished — confirm?",
    );
    expect(screen.getByTestId("attention-s4-review").textContent).toContain(
      "turn to review",
    );

    // Finished stats: review rounds foremost, omitted when zero
    // (dashboard-35).
    expect(screen.getByTestId("attention-stats-id1").textContent).toBe(
      "2 review rounds · 3 turns · 12m",
    );
    expect(screen.getByTestId("attention-stats-id2").textContent).toBe(
      "1 turn · 1m",
    );

    // Activation opens the session at the entry's place (dashboard-3).
    fireEvent.click(
      within(question).getByRole("button", { name: /Open Fix login/ }),
    );
    expect(onOpenSession).toHaveBeenCalledWith("s1", 4);
  });

  test("Confirm closes done with an in-frame busy state; Drop acts on the click", async () => {
    seed({ ledger: { intents: [], attention: ATTENTION, badge: 6 } });
    let settleClose!: () => void;
    commandMock.mockImplementation(async (type: string) => {
      if (type === "intent.close") {
        return new Promise((resolve) => {
          settleClose = () => resolve({});
        });
      }
      if (type === "ledger.get") return useAppStore.getState().ledger;
      return {};
    });
    renderSurface();

    const confirm = screen.getByTestId("attention-confirm-id1");
    fireEvent.click(confirm);
    // The action acknowledges where it was taken (DR-010 §5).
    expect(confirm.textContent).toBe("Confirming…");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(callsOf("intent.close")).toEqual([
      { intentId: "id1", as: "done" },
    ]);
    await act(async () => settleClose());

    // Drop is a verdict on the click (dashboard-4, DR-038): no guard —
    // the History row it produces is the record of it.
    fireEvent.click(screen.getByTestId("attention-drop-id2"));
    const row = screen.getByTestId("attention-id2-finish");
    expect(row.textContent).not.toContain("Drop this intent?");
    expect(callsOf("intent.close")).toEqual([
      { intentId: "id1", as: "done" },
      { intentId: "id2", as: "dropped" },
    ]);
    await act(async () => settleClose());
  });

  test("a verdict hands focus on: the next entry, then the all-clear Start (dashboard-4, DR-010 §6)", async () => {
    const current = ledgerMock({
      intents: [q("n1", "p1", "Polish README")],
      attention: [ATTENTION[3], ATTENTION[4]],
      badge: 2,
    });
    seed({ ledger: current() });
    renderSurface();

    await act(async () => {
      fireEvent.click(screen.getByTestId("attention-confirm-id1"));
    });
    // The row that took the closed one's place holds focus.
    expect(screen.queryByTestId("attention-id1-finish")).toBeNull();
    const next = screen.getByTestId("attention-id2-finish");
    expect(document.activeElement).toBe(
      within(next).getByRole("button", { name: /Open Tidy CI/ }),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("attention-drop-id2"));
    });
    // The last verdict lands on the all-clear's Start, never on body.
    expect(screen.queryByTestId("attention-id2-finish")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("all-clear-start"));
  });
});

describe("dashboard-8: no false all-clear before the ledger is read", () => {
  test("a quiet loading row until the ledger arrives", () => {
    commandMock.mockImplementation(async (type: string) => {
      if (type === "ledger.get") return new Promise(() => {});
      if (type === "ledger.history") return { intents: [], more: false };
      return {};
    });
    seed({ ledger: undefined, ledgerError: undefined });
    renderSurface();

    const loading = screen.getByTestId("attention-loading");
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.textContent).toBe("Loading…");
    expect(screen.queryByTestId("attention-all-clear")).toBeNull();
    // The queue band waits too, rather than claiming an empty queue.
    const upnext = screen.getByTestId("upnext-p1");
    expect(upnext.textContent).toContain("Loading…");
    expect(upnext.textContent).not.toContain("Nothing queued");
  });

  test("a failed load shows the failure strip with Retry and nothing else in the box", async () => {
    seed({ ledger: undefined, ledgerError: "state root unreadable" });
    renderSurface();

    const strip = screen.getByTestId("ledger-error");
    expect(strip.textContent).toContain("state root unreadable");
    expect(screen.queryByTestId("attention-all-clear")).toBeNull();
    expect(screen.queryByTestId("attention-loading")).toBeNull();
    expect(screen.getByTestId("upnext-p1").textContent).toContain(
      "could not be loaded",
    );

    // Retry reads the ledger again; only a loaded ledger brings the
    // all-clear.
    await act(async () => {
      fireEvent.click(within(strip).getByRole("button", { name: "Retry" }));
    });
    expect(callsOf("ledger.get")).toHaveLength(1);
    expect(screen.queryByTestId("ledger-error")).toBeNull();
    expect(screen.getByTestId("attention-all-clear")).toBeTruthy();
  });
});

describe("dashboard-8: the all-clear names the globally next head", () => {
  test("the first unblocked head by sidebar order carries Start", () => {
    // p1 holds only a blocked intent, so p2's head is globally next.
    seed({
      ledger: {
        intents: [
          q("b1", "p1", "Wait on upstream", {
            blockedBy: { intentId: "n1", title: "Polish README", projectId: "p2" },
          }),
          q("n1", "p2", "Polish README\nwith details"),
        ],
        attention: [],
        badge: 0,
      },
    });
    const { onStartIntent } = renderSurface();

    const allClear = screen.getByTestId("attention-all-clear");
    expect(allClear.textContent).toContain("Polish README");
    expect(allClear.textContent).toContain("beta");
    fireEvent.click(screen.getByTestId("all-clear-start"));
    expect(onStartIntent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n1", text: "Polish README\nwith details" }),
    );
  });

  test("plain all-clear copy when no unblocked head exists", () => {
    seed({
      ledger: {
        intents: [
          q("b1", "p1", "Blocked", {
            blockedBy: { intentId: "x", title: "Elsewhere", projectId: "p2" },
          }),
        ],
        attention: [],
        badge: 0,
      },
    });
    renderSurface();
    expect(
      screen.getByTestId("attention-all-clear").textContent,
    ).toContain("All clear — nothing waiting");
    expect(screen.queryByTestId("all-clear-start")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Project groups: Up next
// ---------------------------------------------------------------------------

describe("dashboard-26/29: groups and the queue band", () => {
  const QUEUE_LEDGER: LedgerState = {
    intents: [
      q("q1", "p1", "First thing"),
      q("q2", "p1", "Blocked thing", {
        blockedBy: { intentId: "x1", title: "Upstream fix", projectId: "p2" },
      }),
      q("q3", "p1", "Third thing"),
    ],
    attention: [],
    badge: 0,
  };

  test("groups render in sidebar order with all four bands", () => {
    seed({ ledger: QUEUE_LEDGER });
    renderSurface();
    const groups = screen.getAllByTestId(/^project-group-/);
    expect(groups.map((el) => el.getAttribute("data-testid"))).toEqual([
      "project-group-p1",
      "project-group-p2",
    ]);
    const p1 = screen.getByTestId("project-group-p1");
    expect(within(p1).getByTestId("history-p1")).toBeTruthy();
    expect(within(p1).getByTestId("now-p1")).toBeTruthy();
    expect(within(p1).getByTestId("upnext-p1")).toBeTruthy();
    expect(within(p1).getByTestId("sources-p1")).toBeTruthy();
  });

  test("head emphasized with Start; blocked visible, disabled, reasoned", () => {
    seed({ ledger: QUEUE_LEDGER });
    const { onStartIntent } = renderSurface();

    const head = screen.getByTestId("upnext-row-q1");
    expect(head.getAttribute("data-next")).toBe("true");
    fireEvent.click(screen.getByTestId("upnext-start-q1"));
    expect(onStartIntent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "q1" }),
    );

    // The blocked row stays visible at its place with "after ⟨title⟩",
    // the predecessor's project named when foreign (dashboard-29).
    expect(screen.getByTestId("upnext-blocked-q2").textContent).toBe(
      "after Upstream fix (beta)",
    );
    const blockedStart = screen.getByTestId(
      "upnext-start-q2",
    ) as HTMLButtonElement;
    expect(blockedStart.disabled).toBe(true);
    expect(blockedStart.title).toContain("Upstream fix");

    // A queued row that is neither head nor blocked carries no Start.
    expect(screen.queryByTestId("upnext-start-q3")).toBeNull();
  });

  test("Alt+Arrow reorders the focused row through intent.move", async () => {
    seed({ ledger: QUEUE_LEDGER });
    renderSurface();

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("upnext-row-q3"), {
        key: "ArrowUp",
        altKey: true,
      });
    });
    expect(callsOf("intent.move")).toEqual([
      { intentId: "q3", afterIntentId: "q1" },
    ]);

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("upnext-row-q2"), {
        key: "ArrowUp",
        altKey: true,
      });
    });
    expect(callsOf("intent.move")).toEqual([
      { intentId: "q3", afterIntentId: "q1" },
      { intentId: "q2", afterIntentId: null },
    ]);
  });

  test("the row popover edits queued text and removes on the click", async () => {
    seed({ ledger: QUEUE_LEDGER });
    renderSurface();

    fireEvent.click(screen.getByTestId("upnext-menu-q1"));
    fireEvent.click(screen.getByTestId("upnext-edit-action-q1"));
    const input = screen.getByTestId("upnext-edit-q1") as HTMLInputElement;
    expect(input.value).toBe("First thing");
    fireEvent.change(input, { target: { value: "First thing, sharper" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(callsOf("intent.edit")).toEqual([
      { intentId: "q1", text: "First thing, sharper" },
    ]);

    // Remove acts on the click (dashboard-29, DR-038): no confirm, and
    // the word is Remove, never Drop — a queued intent never ran.
    fireEvent.click(screen.getByTestId("upnext-menu-q3"));
    const row = screen.getByTestId("upnext-row-q3");
    expect(within(row).queryByText("Drop")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("upnext-remove-action-q3"));
    });
    expect(row.textContent).not.toContain("Drop?");
    expect(callsOf("intent.close")).toEqual([
      { intentId: "q3", as: "dropped" },
    ]);
  });

  test("Move up and Move down in the row menu take Alt+↑/↓'s step (dashboard-29)", async () => {
    seed({ ledger: QUEUE_LEDGER });
    renderSurface();

    const trigger = screen.getByTestId("upnext-menu-q3");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Actions for Third thing" });
    // The last row cannot move down; each item names its keyboard
    // step for the eye and the ear.
    const down = within(menu).getByRole("menuitem", {
      name: "Move down",
    }) as HTMLButtonElement;
    expect(down.disabled).toBe(true);
    expect(down.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowDown");
    expect(down.textContent).toContain("Alt+↓");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Move up" }));
    });
    expect(callsOf("intent.move")).toEqual([
      { intentId: "q3", afterIntentId: "q1" },
    ]);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByTestId("upnext-menu-q1"));
    const head = screen.getByRole("menu", { name: "Actions for First thing" });
    expect(
      (within(head).getByRole("menuitem", { name: "Move up" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => {
      fireEvent.click(within(head).getByRole("menuitem", { name: "Move down" }));
    });
    expect(callsOf("intent.move")[1]).toEqual({
      intentId: "q1",
      afterIntentId: "q2",
    });
  });

  test("the row menu is the house popover: focus in, arrows, Escape and outside close, focus back, one at a time", () => {
    seed({ ledger: QUEUE_LEDGER });
    renderSurface();

    const trigger = screen.getByTestId("upnext-menu-q1");
    trigger.focus();
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Actions for First thing" });
    // Focus lands on the first item that can act (Move up is off at
    // the head); arrows walk the items.
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "Move down" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "Edit text" }),
    );
    // Escape closes and returns focus to the trigger.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    // Opening another row's menu closes this one: one menu at a time.
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("upnext-menu-q2"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(
      screen.getByRole("menu", { name: "Actions for Blocked thing" }),
    ).toBeTruthy();
    // A click outside closes.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("Remove offers Undo, which re-queues the same text and provenance at its place (dashboard-29)", async () => {
    const current = ledgerMock({
      intents: [
        q("q1", "p1", "First thing"),
        {
          intent: info({
            id: "q2",
            projectId: "p1",
            text: "Address #7: Fix the bug",
            source: {
              kind: "issue",
              ref: "7",
              url: "https://github.com/x/y/issues/7",
              labels: ["bug"],
            },
          }),
          state: "queued",
        },
        q("q3", "p1", "Third thing"),
      ],
      attention: [],
      badge: 0,
    });
    seed({ ledger: current() });
    renderSurface();

    fireEvent.click(screen.getByTestId("upnext-menu-q2"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("upnext-remove-action-q2"));
    });
    expect(screen.queryByTestId("upnext-row-q2")).toBeNull();
    const notice = screen.getByTestId("upnext-removed-p1");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("Removed “Address #7: Fix the bug”");
    const undo = within(notice).getByRole("button", { name: "Undo" });
    // The removed row took focus with it; Undo is where it lands.
    expect(document.activeElement).toBe(undo);

    await act(async () => {
      fireEvent.click(undo);
    });
    // The same text and provenance, back after the row it followed,
    // revealed and focused.
    expect(callsOf("intent.queue")).toEqual([
      {
        projectId: "p1",
        text: "Address #7: Fix the bug",
        source: {
          kind: "issue",
          ref: "7",
          url: "https://github.com/x/y/issues/7",
          labels: ["bug"],
        },
      },
    ]);
    expect(callsOf("intent.move")).toEqual([
      { intentId: "i-new-1", afterIntentId: "q1" },
    ]);
    expect(screen.queryByTestId("upnext-removed-p1")).toBeNull();
    const restored = screen.getByTestId("upnext-row-i-new-1");
    expect(restored.getAttribute("data-highlight")).toBe("true");
    expect(document.activeElement).toBe(restored);
    expect(
      screen
        .getAllByTestId(/^upnext-row-/)
        .map((el) => el.getAttribute("data-testid")),
    ).toEqual(["upnext-row-q1", "upnext-row-i-new-1", "upnext-row-q3"]);
  });

  test("the Undo line stays six seconds, and longer while its control holds focus", async () => {
    vi.useFakeTimers();
    try {
      const current = ledgerMock(QUEUE_LEDGER);
      seed({ ledger: current() });
      renderSurface();
      fireEvent.click(screen.getByTestId("upnext-menu-q3"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("upnext-remove-action-q3"));
      });
      const undo = within(screen.getByTestId("upnext-removed-p1")).getByRole(
        "button",
        { name: "Undo" },
      );
      expect(document.activeElement).toBe(undo);
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      // Still there: a keyboard user on the control is never raced.
      expect(screen.getByTestId("upnext-removed-p1")).toBeTruthy();
      undo.blur();
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(screen.queryByTestId("upnext-removed-p1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a pointer Remove leaves the pointer where it is, and the line lapses on schedule", async () => {
    vi.useFakeTimers();
    try {
      const current = ledgerMock(QUEUE_LEDGER);
      seed({ ledger: current() });
      renderSurface();
      fireEvent.click(screen.getByTestId("upnext-menu-q3"));
      // A mouse click carries its click count (detail 1); the keyboard
      // sends none, which is the case the test above covers.
      await act(async () => {
        fireEvent.click(screen.getByTestId("upnext-remove-action-q3"), {
          detail: 1,
        });
      });
      const notice = screen.getByTestId("upnext-removed-p1");
      const undo = within(notice).getByRole("button", { name: "Undo" });
      expect(document.activeElement).not.toBe(undo);
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(screen.queryByTestId("upnext-removed-p1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("the provenance action is named after what it opens (dashboard-29, DR-038)", () => {
    const sourced = (
      id: string,
      text: string,
      source: IntentSource,
    ): DerivedIntent => ({
      intent: info({ id, projectId: "p1", text, source }),
      state: "queued",
    });
    seed({
      specTrees: {
        p1: {
          ...EMPTY_TREE,
          intents: [
            { id: "IR-3", title: "Half done", path: "intents/003-half.md" },
          ],
        },
        p2: EMPTY_TREE,
      },
      sessions: [
        {
          id: "s-chat",
          projectId: "p1",
          projectPath: "/tmp/alpha",
          createdAt: NOW - MIN,
          live: false,
          endedAt: NOW,
          players: [],
          initialVisible: [],
          turns: 1,
          failed: false,
        },
      ],
      ledger: {
        intents: [
          sourced("i1", "Address #7: Fix the bug", {
            kind: "issue",
            ref: "7",
            url: "https://github.com/x/y/issues/7",
          }),
          sourced("i2", "Review PR #8: Add tests", {
            kind: "pr",
            ref: "8",
            url: "https://github.com/x/y/pull/8",
          }),
          sourced("i3", "Resume IR-3: Half done", { kind: "record", ref: "IR-3" }),
          sourced("i4", "later: tidy the docs", { kind: "chat", ref: "s-chat" }),
          sourced("i5", "orphaned chat", { kind: "chat", ref: "s-gone" }),
        ],
        attention: [],
        badge: 0,
      },
    });
    const { onOpenIntent, onOpenSession } = renderSurface();

    fireEvent.click(screen.getByTestId("upnext-menu-i1"));
    const issue = screen.getByTestId("upnext-source-i1");
    expect(issue.textContent).toBe("Issue #7 ↗");
    expect(issue.getAttribute("href")).toBe("https://github.com/x/y/issues/7");
    expect(screen.queryByText("Open source")).toBeNull();

    fireEvent.click(screen.getByTestId("upnext-menu-i2"));
    expect(screen.getByTestId("upnext-source-i2").textContent).toBe("PR #8 ↗");

    fireEvent.click(screen.getByTestId("upnext-menu-i3"));
    // The record item is the one record row (dashboard-40): chip,
    // title, named as an opener, a menu item still.
    const record = screen.getByTestId("upnext-source-i3");
    expect(record.getAttribute("role")).toBe("menuitem");
    expect(within(record).getByText("IR-3").className).toContain("font-mono");
    expect(record.textContent).toContain("Half done");
    expect(record.getAttribute("aria-label")).toBe("Open IR-3: Half done");
    expect(record.getAttribute("title")).toBe("Open IR-3 in Specs");
    fireEvent.click(record);
    // The menu item leaves with its menu: the trigger is the origin's
    // control (spec-view-57).
    expect(onOpenIntent).toHaveBeenCalledWith(
      "p1",
      "intents/003-half.md",
      "upnext-menu-i3",
    );

    fireEvent.click(screen.getByTestId("upnext-menu-i4"));
    const session = screen.getByTestId("upnext-source-i4");
    expect(session.textContent).toBe("Session");
    fireEvent.click(session);
    expect(onOpenSession).toHaveBeenCalledWith("s-chat");

    // A capturing session that is gone leaves the action inert.
    fireEvent.click(screen.getByTestId("upnext-menu-i5"));
    expect(
      (screen.getByTestId("upnext-source-i5") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("the inline add row captures and the shelf reveals the row", async () => {
    let current: LedgerState = { ...QUEUE_LEDGER };
    commandMock.mockImplementation(async (type: string, fields) => {
      if (type === "intent.queue") {
        const input = fields as { projectId: string; text: string };
        current = {
          ...current,
          intents: [
            ...current.intents,
            q("i-new", input.projectId, input.text),
          ],
        };
        return info({ id: "i-new", projectId: input.projectId, text: input.text });
      }
      if (type === "ledger.get") return current;
      return {};
    });
    seed({ ledger: QUEUE_LEDGER });
    renderSurface();

    const add = screen.getByTestId("add-intent-p1");
    fireEvent.change(add, { target: { value: "New idea" } });
    await act(async () => {
      fireEvent.keyDown(add, { key: "Enter" });
    });
    // Captured with no source (dashboard-29's inline add).
    expect(callsOf("intent.queue")).toEqual([
      { projectId: "p1", text: "New idea" },
    ]);
    const row = await screen.findByTestId("upnext-row-i-new");
    expect(row.getAttribute("data-highlight")).toBe("true");
    expect((add as HTMLInputElement).value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Project groups: Now
// ---------------------------------------------------------------------------

describe("dashboard-28: the Now band reads the live lane", () => {
  test.each(
    (["Dashboard", "Overview"] as const).flatMap((surface) =>
      (["missing", "stale", "player running"] as const).map((transcript) => ({ surface, transcript })),
    ),
  )("$surface uses summary activity for the Now label and mark with a $transcript transcript", ({ surface, transcript }) => {
    const view = initialSessionView([{ id: "dev.coder" }]);
    view.players["dev.coder"].running = transcript === "player running";
    const session = {
      id: "s-live", projectId: "p1", projectPath: "/tmp/alpha",
      title: "Current work", createdAt: NOW - MIN, live: true,
      endedAt: null, players: [], initialVisible: [], turns: 2,
      failed: false, turnActive: true,
    };
    seed({
      sessions: [session],
      views: transcript === "missing" ? {} : { "s-live": view },
    });
    if (surface === "Dashboard") renderSurface();
    else renderOverview();
    const row = screen.getByTestId("now-session-p1");
    expect(within(row).getByText(transcript === "player running" ? "working" : "deciding")).toBeTruthy();
    expect(row.querySelector('[data-running="true"]')).toBeTruthy();

    // A stale active transcript cannot keep the mark or label running
    // after the authoritative summary reports the turn finished.
    act(() => useAppStore.setState({
      sessions: [{ ...session, turnActive: false }],
      views: transcript === "missing" ? {} : { "s-live": { ...view, turnActive: true } },
    }));
    expect(within(row).queryByText("deciding")).toBeNull();
    expect(within(row).queryByText("working")).toBeNull();
    expect(row.querySelector('[data-running="false"]')).toBeTruthy();
    expect(within(row).getAllByText("idle")).toHaveLength(2);
  });

  test("mark, playbook, state label, served intent, and elapsed", () => {
    const view = initialSessionView([]);
    view.turnActive = true;
    view.fsmState = "codeReview";
    view.frames = [{ playbookId: "code" } as never];
    seed({
      sessions: [
        {
          id: "s-live",
          projectId: "p1",
          projectPath: "/tmp/alpha",
          createdAt: NOW - 45 * MIN,
          live: true,
          endedAt: null,
          players: [],
          initialVisible: [],
          turns: 3,
          failed: false,
        },
      ],
      views: { "s-live": view },
      ledger: {
        intents: [
          {
            intent: info({
              id: "w1",
              projectId: "p1",
              text: "Fix login flow\nmore detail",
              dispatched: { sessionId: "s-live", turnId: 3, at: NOW - 10 * MIN },
            }),
            state: "working",
            stats: { turns: 1 },
          },
        ],
        attention: [],
        badge: 0,
      },
    });
    const { onOpenSession } = renderSurface();

    const row = screen.getByTestId("now-session-p1");
    expect(
      row.querySelector("[data-running]")?.getAttribute("data-running"),
    ).toBe("true");
    expect(row.textContent).toContain("code");
    // Humanized state, raw id in the tooltip (DR-010 §2).
    expect(row.textContent).toContain("code review");
    expect(row.querySelector('[title="codeReview"]')).toBeTruthy();
    expect(row.textContent).toContain("Fix login flow");
    // The start reads as an age with the moment in the tooltip.
    expect(row.textContent).toContain("started 45m ago");
    expect(
      within(row).getByTitle(new Date(NOW - 45 * MIN).toLocaleString()),
    ).toBeTruthy();
    fireEvent.click(row);
    expect(onOpenSession).toHaveBeenCalledWith("s-live");

    // A project with no live session stays quiet (dashboard-8).
    expect(screen.getByTestId("now-p2").textContent).toContain(
      "Idle — no conversation yet.",
    );
    expect(screen.queryByTestId("now-drop-p2")).toBeNull();
  });

  test("before a run draws, the row names no playbook and a live turn reads working", () => {
    const view = initialSessionView([{ id: "dev.coder" }]);
    view.turnActive = true;
    view.players["dev.coder"].running = true;
    seed({
      sessions: [
        {
          id: "s-live",
          projectId: "p1",
          projectPath: "/tmp/alpha",
          title: "Fix login flow",
          createdAt: NOW - MIN,
          live: true,
          endedAt: null,
          players: [],
          initialVisible: [],
          turns: 1,
          failed: false,
        },
      ],
      views: { "s-live": view },
    });
    renderSurface();
    const row = screen.getByTestId("now-session-p1");
    expect(row.textContent).not.toContain("no playbook");
    expect(row.textContent).toContain("working");
    expect(row.textContent).not.toContain("idle");
  });

  test("Drop beside the served intent asks the inline confirm, then closes it dropped (dashboard-41)", async () => {
    const view = initialSessionView([]);
    view.turnActive = true;
    view.frames = [{ playbookId: "code" } as never];
    const current = ledgerMock({
      intents: [
        {
          intent: info({
            id: "w1",
            projectId: "p1",
            text: "Fix login flow\nmore detail",
            dispatched: { sessionId: "s-live", turnId: 3, at: NOW - 10 * MIN },
          }),
          state: "working",
          stats: { turns: 1 },
        },
      ],
      attention: [],
      badge: 0,
    });
    seed({
      sessions: [
        {
          id: "s-live",
          projectId: "p1",
          projectPath: "/tmp/alpha",
          createdAt: NOW - 45 * MIN,
          live: true,
          endedAt: null,
          players: [],
          initialVisible: [],
          turns: 3,
          failed: false,
        },
      ],
      views: { "s-live": view },
      ledger: current(),
    });
    renderSurface();

    const row = screen.getByTestId("now-session-p1");
    expect(row.getAttribute("data-intent-id")).toBe("w1");
    const drop = screen.getByTestId("now-drop-p1");
    expect(drop.textContent).toBe("Drop");
    // Work is underway, so the act sits behind the inline confirm,
    // its safe default focused; Keep backs out to the control.
    fireEvent.click(drop);
    const confirm = screen.getByTestId("now-drop-confirm-p1");
    expect(confirm.textContent).toContain("Drop “Fix login flow”?");
    const keep = within(confirm).getByRole("button", { name: "Keep" });
    expect(document.activeElement).toBe(keep);
    expect(callsOf("intent.close")).toEqual([]);
    fireEvent.click(keep);
    expect(screen.queryByTestId("now-drop-confirm-p1")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("now-drop-p1"));

    fireEvent.click(screen.getByTestId("now-drop-p1"));
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("now-drop-confirm-p1")).getByRole("button", {
          name: "Drop",
        }),
      );
    });
    expect(callsOf("intent.close")).toEqual([{ intentId: "w1", as: "dropped" }]);
    // The fold re-derives without the intent: the control leaves with
    // it, the outcome announces, and focus lands on the session row.
    expect(screen.queryByTestId("now-drop-p1")).toBeNull();
    expect(row.getAttribute("data-intent-id")).toBeNull();
    const note = screen.getByTestId("now-note-p1");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("Dropped “Fix login flow”");
    expect(document.activeElement).toBe(row);
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const FORGE: ForgeState = {
  adapter: "github",
  authenticated: true,
  repo: "x/y",
  issues: [
    {
      number: 7,
      title: "Fix the bug",
      url: "https://github.com/x/y/issues/7",
      labels: ["bug", "urgent"],
    },
  ],
  prs: [
    {
      number: 8,
      title: "Add tests",
      url: "https://github.com/x/y/pull/8",
      labels: ["ci"],
    },
  ],
};

const RECORD_TREE: SpecTreeState = {
  ...EMPTY_TREE,
  intents: [
    {
      id: "IR-2",
      title: "Old finished",
      path: "intents/002-old.md",
      status: "Done (2026-01-05)",
      finished: "done",
      updatedAt: NOW - 180 * MIN,
    },
    { id: "IR-3", title: "Half done", path: "intents/003-half.md", status: "In review" },
    {
      id: "IR-4",
      title: "Abandoned idea",
      path: "intents/004-idea.md",
      status: "Superseded by IR-3",
      finished: "superseded",
      updatedAt: NOW - 120 * MIN,
    },
  ],
};

function seedSources(over: Record<string, unknown> = {}) {
  seed({
    projectMeta: { p1: { forge: FORGE }, p2: {} },
    specTrees: { p1: RECORD_TREE, p2: EMPTY_TREE },
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The Running band
// ---------------------------------------------------------------------------

describe("dashboard-50: the Running band lists what is working", () => {
  const RUN_START = NOW - 12 * MIN;

  function live(id: string, projectId: string, title: string) {
    return {
      id,
      projectId,
      projectPath: `/tmp/${projectId}`,
      title,
      createdAt: NOW - 20 * MIN,
      live: true,
      endedAt: null,
      players: [],
      initialVisible: [],
      turns: 1,
      failed: false,
    };
  }

  /** A session with a turn in flight, its first line drawn at the
   * turn's start so the row can read the span. */
  function inFlight(player?: string) {
    const view = initialSessionView(player ? [{ id: player }] : []);
    view.turnActive = true;
    view.currentTurnId = 1;
    if (player) view.players[player].running = true;
    view.captain.push({
      kind: "boss",
      text: "Add a README badge",
      turnId: 1,
      at: RUN_START,
    });
    return view;
  }

  test("a live turn with nothing to answer lists; a summoned session does not", () => {
    const asking = inFlight();
    asking.pendingQuestion = "which branch?";
    seed({
      sessions: [
        live("s-run", "p1", "Add a README badge"),
        live("s-ask", "p2", "Migrate the DB"),
      ],
      views: { "s-run": inFlight("dev.coder"), "s-ask": asking },
      ledger: {
        intents: [],
        attention: [
          {
            band: "interrupted",
            kind: "question",
            title: "Migrate the DB",
            projectId: "p2",
            sessionId: "s-ask",
            since: NOW - 3 * MIN,
          },
        ],
        badge: 1,
      },
    });
    const { onOpenSession } = renderSurface();

    const band = screen.getByTestId("running-band");
    const row = within(band).getByTestId("running-session-s-run");
    // The project, the session's own title, and what it is doing in
    // the Now band's vocabulary, the running player named beside it.
    expect(row.textContent).toContain("alpha");
    expect(row.textContent).toContain("Add a README badge");
    expect(row.textContent).toContain("dev.coder");
    expect(screen.getByTestId("running-state-s-run").textContent).toBe(
      "working",
    );
    // The turn's span, with the moment it began in the tooltip.
    expect(row.textContent).toContain("12m");
    expect(
      within(row).getByTitle(new Date(RUN_START).toLocaleString()),
    ).toBeTruthy();

    // A summoned session stands in the queue, never in both places.
    expect(within(band).queryByTestId("running-session-s-ask")).toBeNull();
    expect(screen.getByTestId("attention-s-ask-question")).toBeTruthy();

    // The row opens its session.
    fireEvent.click(row);
    expect(onOpenSession).toHaveBeenCalledWith("s-run");
  });

  test("an earlier delivery keeps Confirm while later work runs, until that work needs attention", () => {
    const view = inFlight("dev.coder");
    view.currentTurnId = 2;
    view.captain[0].turnId = 2;
    const delivery: AttentionEntry = {
      band: "finished",
      kind: "finish",
      intentId: "i-first",
      title: "The first delivery",
      projectId: "p1",
      sessionId: "s-run",
      turnId: 1,
      since: NOW - MIN,
    };
    seed({
      sessions: [live("s-run", "p1", "The shared conversation")],
      views: { "s-run": view },
      ledger: { intents: [], attention: [delivery], badge: 1 },
    });
    renderSurface();
    expect(screen.getByTestId("running-session-s-run")).toBeTruthy();
    expect((screen.getByTestId("attention-confirm-i-first") as HTMLButtonElement).disabled).toBe(false);

    act(() => useAppStore.setState({
      ledger: {
        intents: [],
        attention: [delivery, {
          ...delivery,
          intentId: "i-next",
          title: "The later work",
          band: "interrupted",
          kind: "question",
          turnId: 2,
        }],
        badge: 2,
      },
    }));
    expect(screen.queryByTestId("running-session-s-run")).toBeNull();
    expect(screen.getByTestId("attention-i-next-question")).toBeTruthy();
    expect(screen.getByTestId("attention-confirm-i-first")).toBeTruthy();
  });

  test.each(
    (["missing", "stale"] as const).flatMap((transcript) =>
      (["question", "permission", "failure"] as const).map((kind) => ({ transcript, kind })),
    ),
  )("summary activity and a standing $kind override a $transcript transcript", ({ transcript, kind }) => {
    const stale = inFlight();
    stale.turnActive = false;
    const delivery: AttentionEntry = {
      band: "finished",
      kind: "finish",
      intentId: "i-first",
      title: "The first delivery",
      projectId: "p1",
      sessionId: "s-run",
      turnId: 1,
      since: NOW - MIN,
    };
    seed({
      sessions: [{ ...live("s-run", "p1", "The shared conversation"), turnActive: true }],
      views: transcript === "missing" ? {} : { "s-run": stale },
      ledger: { intents: [], attention: [delivery], badge: 1 },
    });
    renderSurface();
    expect(screen.getByTestId("running-session-s-run")).toBeTruthy();
    expect(screen.getByTestId("running-state-s-run").textContent).toBe("deciding");
    expect((screen.getByTestId("attention-confirm-i-first") as HTMLButtonElement).disabled).toBe(false);

    act(() => useAppStore.setState({
      ledger: {
        intents: [],
        attention: [delivery, {
          ...delivery,
          intentId: "i-next",
          title: "The later work",
          band: "interrupted",
          kind,
          turnId: 2,
        }],
        badge: 2,
      },
    }));
    expect(screen.queryByTestId("running-session-s-run")).toBeNull();
    expect(screen.getByTestId(`attention-i-next-${kind}`)).toBeTruthy();
    expect(screen.getByTestId("attention-confirm-i-first")).toBeTruthy();
  });

  test("an inactive session summary overrides a stale active transcript", () => {
    seed({
      sessions: [{ ...live("s-idle", "p1", "Settling finished"), turnActive: false }],
      views: { "s-idle": inFlight() },
    });
    renderSurface();
    expect(screen.queryByTestId("running-session-s-idle")).toBeNull();
  });

  test("nothing running keeps the band in place with its note (dashboard-8)", () => {
    seed({
      sessions: [live("s-idle", "p1", "Yesterday's work")],
      views: { "s-idle": initialSessionView([]) },
    });
    renderSurface();
    expect(screen.getByTestId("running-band").textContent).toContain(
      "Nothing running.",
    );
    expect(screen.queryByTestId("running-session-s-idle")).toBeNull();
  });

  test("rows read in sidebar order, and the filter hides the rest (dashboard-32)", () => {
    seed({
      // Served in the other order: the band reads by sidebar order.
      sessions: [live("s-b", "p2", "Tidy CI"), live("s-a", "p1", "Ship docs")],
      views: { "s-a": inFlight("dev.coder"), "s-b": inFlight() },
    });
    renderSurface();
    const ids = () =>
      Array.from(
        screen.getByTestId("running-band").querySelectorAll("[data-project-id]"),
      ).map((row) => row.getAttribute("data-testid"));
    expect(ids()).toEqual(["running-session-s-a", "running-session-s-b"]);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter by project" }), {
      target: { value: "p2" },
    });
    expect(ids()).toEqual(["running-session-s-b"]);
    // Visibility only: no ledger write rode the change.
    expect(callsOf("intent.close")).toEqual([]);
  });
});

describe("dashboard-19/20/24/25/30/37: the Sources band", () => {
  test("the open band's summary line, tabs, labels, and queue seeds", async () => {
    seedSources();
    const { onOpenIntent } = renderSurface();

    // The band opens expanded under its summary line: counts with the
    // data age (dashboard-20/14).
    const toggle = screen.getByTestId("sources-toggle-p1");
    expect(toggle.textContent).toContain("1 issue · 1 PR · 1 open record");
    expect(toggle.textContent).toContain("just now");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    // Issues tab first: number, title link, forge labels as tags.
    const issue = screen.getByTestId("source-issue-p1-7");
    expect(issue.textContent).toContain("#7");
    expect(issue.textContent).toContain("Fix the bug");
    expect(issue.textContent).toContain("bug");
    expect(issue.textContent).toContain("urgent");
    const link = issue.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/x/y/issues/7");
    // The page opens outside the app, without a referrer.
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");

    // Queue seeds the spec table's text with the URL as provenance
    // (dashboard-30/37).
    await act(async () => {
      fireEvent.click(
        within(issue).getByRole("button", { name: /Queue issue #7/ }),
      );
    });
    expect(callsOf("intent.queue")).toEqual([
      {
        projectId: "p1",
        text: "Address #7: Fix the bug\n\nRead the issue and comments. Work on a new branch from the current default-branch commit, implement the requested change, and run relevant checks. Push the branch and open a PR against the default branch with a summary, test results, and `Closes #7` in its description so merging it closes the issue.\n\nhttps://github.com/x/y/issues/7",
        source: {
          kind: "issue",
          ref: "7",
          url: "https://github.com/x/y/issues/7",
          labels: ["bug", "urgent"],
        },
      },
    ]);

    // PRs tab seeds the review text.
    fireEvent.click(screen.getByTestId("sources-tab-prs-p1"));
    const pr = screen.getByTestId("source-pr-p1-8");
    expect(pr.textContent).toContain("ci");
    await act(async () => {
      fireEvent.click(
        within(pr).getByRole("button", { name: /Queue PR #8/ }),
      );
    });
    expect(callsOf("intent.queue")[1]).toEqual({
      projectId: "p1",
      text: "Review PR #8: Add tests\nhttps://github.com/x/y/pull/8",
      source: {
        kind: "pr",
        ref: "8",
        url: "https://github.com/x/y/pull/8",
        labels: ["ci"],
      },
    });

    // Records tab lists only records the core classifies open
    // (dashboard-24/25, spec-view-14): the finished ones list in
    // History instead.
    fireEvent.click(screen.getByTestId("sources-tab-records-p1"));
    expect(screen.queryByTestId("source-record-p1-IR-2")).toBeNull();
    expect(screen.queryByTestId("source-record-p1-IR-4")).toBeNull();
    const record = screen.getByTestId("source-record-p1-IR-3");
    await act(async () => {
      fireEvent.click(
        within(record).getByRole("button", { name: /Queue record IR-3/ }),
      );
    });
    expect(callsOf("intent.queue")[2]).toEqual({
      projectId: "p1",
      text: "Resume IR-3: Half done",
      source: { kind: "record", ref: "IR-3" },
    });
    // The record row opens the records reader (dashboard-24): the one
    // record row (dashboard-40) — chip, title, pointer, no brand link.
    const row = within(record).getByRole("button", {
      name: "Open IR-3: Half done",
    });
    expect(row.getAttribute("title")).toBe("Open IR-3");
    expect(within(row).getByText("IR-3").className).toContain("font-mono");
    expect(row.className).toContain("cursor-pointer");
    expect(row.className).not.toContain("underline");
    expect(row.className).not.toContain("brand");
    fireEvent.click(row);
    // The row leaves the surface with its activation, so the band's
    // toggle — which stands open or folded — is the origin's control.
    expect(onOpenIntent).toHaveBeenCalledWith(
      "p1",
      "intents/003-half.md",
      "sources-toggle-p1",
    );
  });

  test("a captured artifact swaps its Queue control for the intent's state and regains it on close", () => {
    const captured: DerivedIntent = {
      intent: info({
        id: "c1",
        projectId: "p1",
        text: "Address #7: Fix the bug",
        source: {
          kind: "issue",
          ref: "7",
          url: "https://github.com/x/y/issues/7",
        },
        dispatched: { sessionId: "s1", turnId: 1, at: NOW - MIN },
      }),
      state: "working",
    };
    seedSources({
      ledger: { intents: [captured], attention: [], badge: 0 },
    });
    renderSurface();

    const issue = screen.getByTestId("source-issue-p1-7");
    const state = within(issue).getByTestId("source-issue-p1-7-state");
    expect(state.textContent).toBe("working");
    expect(state.getAttribute("title")).toBe("working");
    expect(within(issue).queryByRole("button", { name: /Queue/ })).toBeNull();

    // The intent closes: the ledger no longer serves it, and the row
    // regains its control (dashboard-30).
    act(() => {
      useAppStore.setState({ ledger: EMPTY_LEDGER });
    });
    expect(
      within(screen.getByTestId("source-issue-p1-7")).getByRole("button", {
        name: /Queue issue #7/,
      }),
    ).toBeTruthy();
  });

  test("pages of six with a quiet in-place pager; refresh re-fetches", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      url: `https://github.com/x/y/issues/${index + 1}`,
    }));
    commandMock.mockImplementation(async (type: string) => {
      if (type === "forge.items") return { ...FORGE, issues: many };
      if (type === "ledger.get") return useAppStore.getState().ledger;
      if (type === "ledger.history") return { intents: [], more: false };
      return {};
    });
    seedSources({
      projectMeta: { p1: { forge: { ...FORGE, issues: many } }, p2: {} },
    });
    renderSurface();

    expect(screen.getByTestId("source-issue-p1-6")).toBeTruthy();
    expect(screen.queryByTestId("source-issue-p1-7")).toBeNull();
    expect(screen.getByText("1 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByTestId("source-issue-p1-7")).toBeTruthy();
    expect(screen.queryByTestId("source-issue-p1-1")).toBeNull();

    // Manual refresh calls the adapter regardless of cache age
    // (dashboard-14).
    await act(async () => {
      fireEvent.click(screen.getByTestId("sources-refresh-p1"));
    });
    expect(callsOf("forge.items")).toEqual([
      { projectId: "p1", refresh: true },
    ]);
  });

  test("an adapter failure keeps the last lists and surfaces itself", () => {
    seedSources({
      projectMeta: {
        p1: { forge: FORGE, forgeError: "gh: network unreachable" },
        p2: {},
      },
    });
    renderSurface();
    // Keep-last-good (dashboard-14): the failure rides beside the
    // data, which stays served.
    expect(screen.getByTestId("sources-error-p1").textContent).toContain(
      "keeping the last data",
    );
    expect(screen.getByTestId("source-issue-p1-7")).toBeTruthy();
  });

  test("the band folds to its summary, per project, for the app's run (dashboard-20)", () => {
    seedSources();
    renderSurface();

    const fold = (projectId: string) =>
      fireEvent.click(screen.getByTestId(`sources-toggle-${projectId}`));
    const shown = (projectId: string) =>
      screen
        .getByTestId(`sources-toggle-${projectId}`)
        .getAttribute("aria-expanded");

    // Both bands open; folding one leaves the other open.
    expect(shown("p1")).toBe("true");
    expect(shown("p2")).toBe("true");
    fold("p1");
    expect(shown("p1")).toBe("false");
    expect(screen.queryByTestId("source-issue-p1-7")).toBeNull();
    expect(shown("p2")).toBe("true");

    // The fold is the project's, so the Overview's band — the same one
    // (dashboard-26) — stands folded too, and its line opens it again
    // for both surfaces.
    cleanup();
    renderOverview();
    expect(shown("p1")).toBe("false");
    fold("p1");
    expect(shown("p1")).toBe("true");
    expect(screen.getByTestId("source-issue-p1-7")).toBeTruthy();
    cleanup();
    renderSurface();
    expect(shown("p1")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("dashboard-27/38: History is done work, one timeline newest first", () => {
  const page1 = {
    intents: [
      {
        intent: info({
          id: "h1",
          projectId: "p1",
          text: "Newest done",
          closedAt: NOW - 2 * MIN,
          closedAs: "done",
        }),
      },
      {
        intent: info({
          id: "hb",
          projectId: "p1",
          text: "Address #7: Fix the bug",
          closedAt: NOW - 4 * MIN,
          closedAs: "done",
          source: {
            kind: "issue",
            ref: "7",
            url: "https://github.com/x/y/issues/7",
            labels: ["bug", "urgent"],
          },
        }),
      },
      {
        intent: info({
          id: "h2",
          projectId: "p1",
          text: "Dropped after work",
          closedAt: NOW - 5 * MIN,
          closedAs: "dropped",
        }),
      },
      {
        intent: info({
          id: "hr",
          projectId: "p1",
          text: "Resume IR-2: Old finished",
          closedAt: NOW - 6 * MIN,
          closedAs: "done",
          source: { kind: "record", ref: "IR-2" },
        }),
      },
    ],
    more: true,
  };
  const page2 = {
    intents: [
      {
        intent: info({
          id: "h3",
          projectId: "p1",
          text: "Older done",
          closedAt: NOW - 60 * MIN,
          closedAs: "done",
        }),
      },
    ],
    more: false,
  };
  const ids = () =>
    screen
      .getAllByTestId(/^history-row-/)
      .map((el) => el.getAttribute("data-testid")!.replace("history-row-", ""));

  test("checks, the bug strike, the quiet drop, records, and older pages", async () => {
    commandMock.mockImplementation(async (type: string, fields) => {
      if (type === "ledger.history") {
        return (fields as { before?: unknown }).before ? page2 : page1;
      }
      if (type === "ledger.get") return useAppStore.getState().ledger;
      return {};
    });
    // History absent for p1: the band loads its first page itself. The
    // tree holds a done, an open, and a superseded record.
    seed({
      projects: [PROJECTS[0]],
      projectMeta: { p1: {} },
      specTrees: { p1: RECORD_TREE },
      history: {},
    });
    const { onOpenIntent } = renderSurface();

    // Until the first page answers the band loads: the tree's records
    // already show, and the control says a page is in flight rather
    // than offering more (dashboard-8/27).
    expect(screen.getByTestId("history-older-p1").textContent).toBe("Loading…");
    expect((screen.getByTestId("history-older-p1") as HTMLButtonElement).disabled).toBe(true);
    await screen.findByTestId("history-row-h1");
    // Newest first — intents by close time, records by last change;
    // IR-2 lists once, as the intent naming it; open IR-3 never lists.
    expect(ids()).toEqual(["h1", "hb", "h2", "hr", "IR-4"]);

    const done = screen.getByTestId("history-row-h1");
    expect(done.getAttribute("data-verdict")).toBe("done");
    expect(done.textContent).toContain("✓");
    expect(done.querySelector(".line-through")).toBeNull();
    // Ages say "ago" and carry the absolute moment (DR-010 §2).
    expect(done.textContent).toContain("2m ago");
    expect(
      within(done).getByTitle(new Date(NOW - 2 * MIN).toLocaleString()),
    ).toBeTruthy();

    // A fixed bug: struck through under the red tag, no check.
    const bug = screen.getByTestId("history-row-hb");
    expect(bug.getAttribute("data-verdict")).toBe("bug");
    expect(bug.querySelector(".line-through")).toBeTruthy();
    expect(within(bug).getByTestId("history-tag").textContent).toBe("bug");
    expect(bug.textContent).not.toContain("✓");

    // Dropped after work: a quiet tag, dimmed, never struck.
    const dropped = screen.getByTestId("history-row-h2");
    expect(dropped.getAttribute("data-verdict")).toBe("dropped");
    expect(within(dropped).getByTestId("history-tag").textContent).toBe(
      "dropped",
    );
    expect(dropped.querySelector(".line-through")).toBeNull();
    expect(dropped.textContent).not.toContain("✓");
    expect(dropped.textContent).not.toContain("✕");

    // A superseded record wears that word as a trailing tag after its
    // record row, dimmed, no check, and opens in the records reader.
    const superseded = screen.getByTestId("history-row-IR-4");
    expect(superseded.getAttribute("data-kind")).toBe("record");
    expect(superseded.getAttribute("data-verdict")).toBe("superseded");
    expect(
      within(superseded).getByTestId("history-tag").textContent,
    ).toBe("superseded");
    expect(superseded.textContent).not.toContain("✓");
    const supersededRow = within(superseded).getByRole("button", {
      name: "Open IR-4: Abandoned idea",
    });
    expect(within(supersededRow).getByText("IR-4").className).toContain(
      "font-mono",
    );
    fireEvent.click(supersededRow);
    expect(onOpenIntent).toHaveBeenCalledWith(
      "p1",
      "intents/004-idea.md",
      "record-row-IR-4",
    );

    // The accessible older control fetches the next intent page with
    // the cursor of the last served row (dashboard-38); records keep
    // their place in the one timeline.
    expect(screen.getByTestId("history-older-p1").textContent).toBe("Older…");
    await act(async () => {
      fireEvent.click(screen.getByTestId("history-older-p1"));
    });
    expect(callsOf("ledger.history")[1]).toEqual({
      projectId: "p1",
      before: { closedAt: NOW - 6 * MIN, intentId: "hr" },
    });
    expect(await screen.findByTestId("history-row-h3")).toBeTruthy();
    expect(ids()).toEqual(["h1", "hb", "h2", "hr", "h3", "IR-4"]);
    await waitFor(() =>
      expect(screen.queryByTestId("history-older-p1")).toBeNull(),
    );
  });

  test("an intent row leaves the record behind the inline confirm; a record row carries no control", async () => {
    commandMock.mockImplementation(async (type: string) => {
      if (type === "ledger.history") return { ...page1, more: false };
      if (type === "ledger.get") return useAppStore.getState().ledger;
      return {};
    });
    seed({
      projects: [PROJECTS[0]],
      projectMeta: { p1: {} },
      specTrees: { p1: RECORD_TREE },
      history: {},
    });
    renderSurface();
    await screen.findByTestId("history-row-h1");

    // Every intent row carries the control, named after its intent; a
    // record row carries none — a file in the specs tree is not the
    // ledger's to remove.
    const control = screen.getByTestId("history-remove-h1");
    expect(control.getAttribute("aria-label")).toBe(
      "Remove Newest done from history",
    );
    expect(screen.getByTestId("history-remove-h2")).toBeTruthy();
    expect(screen.queryByTestId("history-remove-IR-4")).toBeNull();

    // The confirm opens in place, naming the act; Keep backs out and
    // hands focus back to the control, and nothing was sent.
    fireEvent.click(control);
    const confirm = screen.getByTestId("history-remove-confirm-h1");
    expect(confirm.textContent).toContain("Remove this intent from history?");
    const keep = within(confirm).getByRole("button", { name: "Keep" });
    expect(document.activeElement).toBe(keep);
    await act(async () => {
      fireEvent.click(keep);
    });
    expect(document.activeElement).toBe(screen.getByTestId("history-remove-h1"));
    expect(callsOf("intent.remove")).toEqual([]);

    // Confirming removes the intent over the protocol: the row leaves
    // at once, and focus lands on the next row's control.
    fireEvent.click(screen.getByTestId("history-remove-h1"));
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("history-remove-confirm-h1")).getByRole(
          "button",
          { name: "Remove" },
        ),
      );
    });
    expect(callsOf("intent.remove")).toEqual([{ intentId: "h1" }]);
    expect(screen.queryByTestId("history-row-h1")).toBeNull();
    expect(ids()).toEqual(["hb", "h2", "hr", "IR-4"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("history-remove-hb"),
      ),
    );
  });

  test("an empty band reads Loading… until its first page answers", async () => {
    let answer!: (page: { intents: never[]; more: boolean }) => void;
    commandMock.mockImplementation(async (type: string) => {
      if (type === "ledger.history") {
        return new Promise((resolve) => {
          answer = resolve;
        });
      }
      if (type === "ledger.get") return useAppStore.getState().ledger;
      return {};
    });
    seed({ projects: [PROJECTS[0]], history: {} });
    renderSurface();
    expect(screen.getByTestId("history-empty-p1").textContent).toBe("Loading…");
    await act(async () => {
      answer({ intents: [], more: false });
    });
    expect(screen.getByTestId("history-empty-p1").textContent).toBe(
      "Nothing done here yet.",
    );
  });

  const manyRows = (count: number, from = 0) =>
    Array.from({ length: count }, (_, index) => ({
      intent: info({
        id: `m${from + index}`,
        projectId: "p1",
        text: `Done ${from + index}`,
        closedAt: NOW - (from + index + 1) * MIN,
        closedAs: "done",
      }),
    }));

  // The frame measures whether content runs past it (dashboard-27),
  // and jsdom reports every box as zero — so the frame's cap and its
  // rows are given their real sizes here.
  const FRAME_ID = "history:p1";
  const ROW = 24;

  describe("the frame the reader sets", () => {
    let restore = () => {};

    beforeEach(() => {
      useAppStore.setState({ frameHeights: {} });
      const prior = (["clientHeight", "scrollHeight"] as const).map(
        (name) =>
          [
            name,
            Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
          ] as const,
      );
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return parseFloat(this.style.maxHeight) || 0;
        },
      });
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
        configurable: true,
        get(this: HTMLElement) {
          return this.children.length * ROW;
        },
      });
      restore = () => {
        for (const [name, descriptor] of prior) {
          if (descriptor) {
            Object.defineProperty(HTMLElement.prototype, name, descriptor);
          } else {
            Reflect.deleteProperty(HTMLElement.prototype, name);
          }
        }
      };
    });

    afterEach(() => {
      restore();
      useAppStore.setState({ frameHeights: {} });
    });

    test("every loaded row lists inside the frame, which scrolls past eight rows", async () => {
      commandMock.mockImplementation(async (type: string) => {
        if (type === "ledger.history") return { intents: manyRows(10), more: false };
        if (type === "ledger.get") return useAppStore.getState().ledger;
        return {};
      });
      seed({ projects: [PROJECTS[0]], history: {} });
      renderSurface();
      await screen.findByTestId("history-row-m0");
      // Ten loaded rows, all in the frame: none held back for a control.
      expect(ids()).toHaveLength(10);
      const frame = screen.getByTestId("history-frame-p1");
      // Every row is one frame unit tall, so the frame's cap counts in
      // rows exactly: eight of them by default.
      expect(frame.style.maxHeight).toBe(`${8 * ROW}px`);
      expect(frame.className).toContain("overflow-y-auto");
      for (const row of screen.getAllByTestId(/^history-row-/)) {
        expect(row.className).toContain("h-6");
      }
      // The overflowing frame draws its cut edges and takes focus.
      expect(frame.getAttribute("data-overflowing")).toBe("true");
      expect(frame.getAttribute("tabindex")).toBe("0");
      expect(frame.className).toContain("border-y");
      // Nothing waits unfetched: no control, one fetch.
      expect(screen.queryByTestId("history-older-p1")).toBeNull();
      expect(callsOf("ledger.history")).toHaveLength(1);
    });

    test("a short history is a plain list; Older… at the frame's end fetches the next page", async () => {
      commandMock.mockImplementation(async (type: string, fields) => {
        if (type === "ledger.history") {
          return (fields as { before?: unknown }).before
            ? { intents: manyRows(20, 20), more: false }
            : { intents: manyRows(20), more: true };
        }
        if (type === "ledger.get") return useAppStore.getState().ledger;
        return {};
      });
      seed({ projects: [PROJECTS[0]], history: {} });
      renderSurface();
      await screen.findByTestId("history-row-m0");
      expect(ids()).toHaveLength(20);
      const frame = screen.getByTestId("history-frame-p1");
      // The control is the frame's last item, reached by tabbing through
      // the rows, and it fetches with the cursor of the last served row.
      const older = screen.getByTestId("history-older-p1");
      expect(older.textContent).toBe("Older…");
      expect(frame.lastElementChild?.contains(older)).toBe(true);
      await act(async () => {
        fireEvent.click(older);
      });
      expect(callsOf("ledger.history")[1]).toEqual({
        projectId: "p1",
        before: { closedAt: NOW - 20 * MIN, intentId: "m19" },
      });
      expect(await screen.findByTestId("history-row-m39")).toBeTruthy();
      expect(ids()).toHaveLength(40);
      // Nothing left behind: the control leaves, the frame stays.
      expect(screen.queryByTestId("history-older-p1")).toBeNull();
      expect(frame.getAttribute("data-overflowing")).toBe("true");
      expect(frame.style.maxHeight).toBe(`${8 * ROW}px`);
    });

    test("a history within eight rows draws no cut edges, takes no focus, and offers no grip", async () => {
      commandMock.mockImplementation(async (type: string) => {
        if (type === "ledger.history") return { intents: manyRows(8), more: false };
        if (type === "ledger.get") return useAppStore.getState().ledger;
        return {};
      });
      seed({ projects: [PROJECTS[0]], history: {} });
      renderSurface();
      await screen.findByTestId("history-row-m7");
      const frame = screen.getByTestId("history-frame-p1");
      expect(ids()).toHaveLength(8);
      expect(frame.getAttribute("data-overflowing")).toBeNull();
      expect(frame.getAttribute("tabindex")).toBeNull();
      expect(frame.className).not.toContain("border-y");
      // Eight rows hold everything: nothing to page through, so no
      // edge to pull (DR-030).
      expect(screen.queryByTestId("history-frame-p1-grip")).toBeNull();
    });

    test("the grip sets the frame between four and twenty-four rows, and it is remembered", async () => {
      commandMock.mockImplementation(async (type: string) => {
        if (type === "ledger.history") return { intents: manyRows(30), more: false };
        if (type === "ledger.get") return useAppStore.getState().ledger;
        return {};
      });
      seed({ projects: [PROJECTS[0]], history: {} });
      renderSurface();
      await screen.findByTestId("history-row-m0");
      const frame = screen.getByTestId("history-frame-p1");
      const grip = screen.getByTestId("history-frame-p1-grip");
      // The frame's bottom edge is a control that names itself and
      // reports the height in the frame's own unit (DR-010 §7).
      expect(grip.getAttribute("role")).toBe("separator");
      expect(grip.getAttribute("aria-orientation")).toBe("horizontal");
      expect(grip.getAttribute("aria-label")).toBe("Resize History");
      expect(grip.getAttribute("aria-valuenow")).toBe("8");
      expect(grip.getAttribute("aria-valuemin")).toBe("4");
      expect(grip.getAttribute("aria-valuemax")).toBe("24");
      expect(grip.getAttribute("tabindex")).toBe("0");

      // Dragged, the edge follows the pointer a row at a time.
      fireEvent.pointerDown(grip, { clientY: 200 });
      fireEvent.pointerMove(grip, { clientY: 200 + 2 * ROW });
      fireEvent.pointerUp(grip, { clientY: 200 + 2 * ROW });
      expect(frame.style.maxHeight).toBe(`${10 * ROW}px`);
      expect(grip.getAttribute("aria-valuenow")).toBe("10");

      // Arrow keys move it a row at a time; neither bound is passed.
      fireEvent.keyDown(grip, { key: "ArrowUp" });
      expect(frame.style.maxHeight).toBe(`${9 * ROW}px`);
      for (let nudge = 0; nudge < 20; nudge += 1) {
        fireEvent.keyDown(grip, { key: "ArrowUp" });
      }
      expect(frame.style.maxHeight).toBe(`${4 * ROW}px`);
      for (let nudge = 0; nudge < 40; nudge += 1) {
        fireEvent.keyDown(grip, { key: "ArrowDown" });
      }
      expect(frame.style.maxHeight).toBe(`${24 * ROW}px`);

      // A double-click restores the eight.
      fireEvent.doubleClick(grip);
      expect(frame.style.maxHeight).toBe(`${8 * ROW}px`);

      // Chrome state is preference, not project state: the height set
      // here survives a remount (DR-030).
      fireEvent.keyDown(grip, { key: "ArrowDown" });
      fireEvent.keyDown(grip, { key: "ArrowDown" });
      expect(useAppStore.getState().frameHeights[FRAME_ID]).toBe(10);
      cleanup();
      renderSurface();
      await screen.findByTestId("history-row-m0");
      expect(screen.getByTestId("history-frame-p1").style.maxHeight).toBe(
        `${10 * ROW}px`,
      );
      expect(
        screen.getByTestId("history-frame-p1-grip").getAttribute("aria-valuenow"),
      ).toBe("10");
    });
  });

  test("a record orders by the date its status line carries, else file time", () => {
    const tree: SpecTreeState = {
      ...RECORD_TREE,
      intents: [
        {
          id: "IR-9",
          title: "Dated late, filed early",
          path: "intents/009-dated.md",
          status: "Done (2026-03-01)",
          finished: "done",
          updatedAt: Date.parse("2026-01-01"),
        },
        {
          id: "IR-8",
          title: "Undated, filed later",
          path: "intents/008-undated.md",
          status: "Done",
          finished: "done",
          updatedAt: Date.parse("2026-02-01"),
        },
      ],
    };
    seed({
      projects: [PROJECTS[0]],
      specTrees: { p1: tree },
      history: { p1: { intents: [], more: false } },
    });
    renderSurface();
    expect(ids()).toEqual(["IR-9", "IR-8"]);
    expect(
      within(screen.getByTestId("history-row-IR-9")).getByTitle(
        new Date(Date.parse("2026-03-01")).toLocaleString(),
      ),
    ).toBeTruthy();
  });

  test("a finished record lists with a check before its record row", () => {
    seed({
      projects: [PROJECTS[0]],
      projectMeta: { p1: {} },
      specTrees: { p1: RECORD_TREE },
      history: { p1: { intents: [], more: false } },
    });
    const { onOpenIntent } = renderSurface();
    expect(screen.queryByTestId("history-row-IR-3")).toBeNull();
    const record = screen.getByTestId("history-row-IR-2");
    expect(record.getAttribute("data-verdict")).toBe("done");
    expect(record.textContent).toContain("✓");
    // The one record row (dashboard-40): the identifier chip, the
    // title, hover and pointer, named as an opener — never the brand
    // link, which is for what leaves the app.
    const row = within(record).getByRole("button", {
      name: "Open IR-2: Old finished",
    });
    expect(row.getAttribute("title")).toBe("Open IR-2");
    expect(within(row).getByText("IR-2").className).toContain("font-mono");
    expect(row.className).toContain("cursor-pointer");
    expect(row.className).toContain("hover:bg-");
    expect(row.className).not.toContain("underline");
    expect(within(record).queryByTestId("history-tag")).toBeNull();
    fireEvent.click(row);
    // The row itself is the origin's control (dashboard-40).
    expect(onOpenIntent).toHaveBeenCalledWith(
      "p1",
      "intents/002-old.md",
      "record-row-IR-2",
    );
  });
});

// ---------------------------------------------------------------------------
// Ledger reads in request order
// ---------------------------------------------------------------------------

describe("dashboard-42: ledger reads apply in request order", () => {
  test("an older reply landing last never overwrites the newer fold", async () => {
    const stale: LedgerState = {
      intents: [q("old", "p1", "Stale queue")],
      attention: [],
      badge: 0,
    };
    const fresh: LedgerState = {
      intents: [q("new", "p1", "Fresh queue")],
      attention: [],
      badge: 0,
    };
    let settleFirst!: () => void;
    let reads = 0;
    commandMock.mockImplementation(async (type: string) => {
      if (type === "ledger.get") {
        reads += 1;
        if (reads === 1) {
          return new Promise((resolve) => {
            settleFirst = () => resolve(stale);
          });
        }
        return fresh;
      }
      if (type === "ledger.history") return { intents: [], more: false };
      return {};
    });
    seed({ ledger: undefined });
    const first = useAppStore.getState().loadLedger();
    const second = useAppStore.getState().loadLedger();
    await second;
    expect(useAppStore.getState().ledger).toEqual(fresh);
    // The older read lands last: discarded, never applied.
    await act(async () => {
      settleFirst();
      await first;
    });
    expect(useAppStore.getState().ledger).toEqual(fresh);
    renderSurface();
    expect(screen.getByTestId("upnext-row-new").textContent).toContain(
      "Fresh queue",
    );
    expect(screen.queryByTestId("upnext-row-old")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty states, no takeover, filter
// ---------------------------------------------------------------------------

describe("dashboard-8/21/22/32: empty states, no takeover, the filter", () => {
  test("no registered project: guidance with Workspace navigation, no takeover", () => {
    seed({
      projects: [],
      projectMeta: {},
      specTrees: {},
      history: {},
      ledger: EMPTY_LEDGER,
    });
    const { onNavigate } = renderSurface();
    // The attention queue still renders (dashboard-21): no takeover.
    expect(screen.getByTestId("attention-all-clear")).toBeTruthy();
    const empty = screen.getByTestId("projects-empty");
    expect(empty.textContent).toContain("register");
    fireEvent.click(within(empty).getByRole("button", { name: "Workspace" }));
    expect(onNavigate).toHaveBeenCalledWith("Workspace");
  });

  test("a registered project with an empty ledger keeps every band instructive", () => {
    seed({ projects: [PROJECTS[0]] });
    renderSurface();
    expect(screen.getByTestId("history-p1").textContent).toContain(
      "Nothing done here yet.",
    );
    expect(screen.getByTestId("now-p1").textContent).toContain(
      "Idle — no conversation yet.",
    );
    // The add row stays as the capture path (dashboard-8/29).
    expect(screen.getByTestId("add-intent-p1")).toBeTruthy();
    expect(screen.getByTestId("upnext-p1").textContent).toContain(
      "Nothing queued",
    );
    // No forge binding: the summary line still counts, and the band
    // guides to the Workspace.
    expect(screen.getByTestId("sources-p1").textContent).toContain(
      "No GitHub connection yet",
    );
  });

  test("a forge state not yet read is loading, never not connected (dashboard-20)", () => {
    commandMock.mockImplementation(async (type: string) => {
      if (type === "forge.items" || type === "project.status") {
        return new Promise(() => {});
      }
      if (type === "ledger.get") return useAppStore.getState().ledger;
      return {};
    });
    seed({ projects: [PROJECTS[0]], projectMeta: {} });
    renderSurface();
    const line = screen.getByTestId("sources-toggle-p1");
    expect(line.textContent).toContain("Loading GitHub…");
    expect(line.textContent).not.toContain("GitHub not connected");
    expect(screen.getByTestId("sources-guidance-p1").textContent).toContain(
      "Loading GitHub state…",
    );
  });

  test("the project filter is visibility only (dashboard-32)", () => {
    seed({ ledger: { intents: [], attention: ATTENTION, badge: 6 } });
    renderSurface();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by project" }), {
      target: { value: "p2" },
    });
    // Only beta's entries and group stay visible.
    expect(screen.queryByTestId("attention-iq-question")).toBeNull();
    expect(screen.getByTestId("attention-if-failure")).toBeTruthy();
    expect(screen.queryByTestId("project-group-p1")).toBeNull();
    expect(screen.getByTestId("project-group-p2")).toBeTruthy();
    // No ledger write rode the filter change.
    expect(callsOf("intent.move")).toEqual([]);
    expect(callsOf("intent.close")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The Overview tab: header over the shared group (projects-4/6/7)
// ---------------------------------------------------------------------------

function renderOverview(onOpenIntent = vi.fn()) {
  render(
    <OverviewTab
      projectId="p1"
      onRemoved={() => {}}
      onOpenSession={vi.fn()}
      onOpenIntent={onOpenIntent}
      onStartIntent={vi.fn()}
    />,
  );
  return { onOpenIntent, overview: screen.getByTestId("overview-tab") };
}

describe("projects-4/6/9, forge-work-lists-1: the Overview tab", () => {
  test("the repository header over the project's own group, sharing the rows", async () => {
    seedSources({
      projectMeta: {
        p1: {
          forge: FORGE,
          status: { branch: "main", dirty: true, ahead: 2, behind: 1 },
        },
        p2: {},
      },
    });
    const { overview } = renderOverview();

    // The header (projects-4): name, path, branch, dirty, ahead/behind,
    // and the GitHub slug.
    expect(overview.textContent).toContain("alpha");
    expect(overview.textContent).toContain("/tmp/alpha");
    expect(overview.textContent).toContain("main");
    expect(within(overview).getByTitle("uncommitted changes")).toBeTruthy();
    expect(within(overview).getByTitle("ahead of upstream").textContent).toBe("↑2");
    expect(within(overview).getByTitle("behind upstream").textContent).toBe("↓1");
    expect(overview.textContent).toContain("x/y");
    // Removal keeps its one confirm (projects-9): a project is not a row.
    fireEvent.click(within(overview).getByRole("button", { name: "Remove project" }));
    expect(overview.textContent).toContain("Remove from Spex?");
    fireEvent.click(within(overview).getByRole("button", { name: "Keep" }));
    expect(callsOf("project.remove")).toEqual([]);
    // Keep hands focus back to the control it replaced (DR-010 §6).
    expect(document.activeElement).toBe(
      within(overview).getByRole("button", { name: "Remove project" }),
    );

    // The project's group as the Dashboard draws it, no project filter
    // (dashboard-26, DR-038).
    expect(within(overview).getByTestId("project-group-p1")).toBeTruthy();
    expect(
      within(overview).queryByRole("combobox", { name: "Filter by project" }),
    ).toBeNull();
    expect(within(overview).getByTestId("history-p1")).toBeTruthy();
    expect(within(overview).getByTestId("now-p1")).toBeTruthy();
    expect(within(overview).getByTestId("upnext-p1")).toBeTruthy();

    // The Sources band carries the one row representation
    // (forge-work-lists-1): labels, Queue with the same seed and the
    // labels kept as provenance.
    const issue = within(overview).getByTestId("source-issue-p1-7");
    expect(issue.textContent).toContain("#7");
    expect(issue.textContent).toContain("bug");
    expect(
      issue.querySelector("a")?.getAttribute("href"),
    ).toBe("https://github.com/x/y/issues/7");
    await act(async () => {
      fireEvent.click(
        within(issue).getByRole("button", { name: /Queue issue #7/ }),
      );
    });
    expect(callsOf("intent.queue")).toEqual([
      {
        projectId: "p1",
        text: "Address #7: Fix the bug\n\nRead the issue and comments. Work on a new branch from the current default-branch commit, implement the requested change, and run relevant checks. Push the branch and open a PR against the default branch with a summary, test results, and `Closes #7` in its description so merging it closes the issue.\n\nhttps://github.com/x/y/issues/7",
        source: {
          kind: "issue",
          ref: "7",
          url: "https://github.com/x/y/issues/7",
          labels: ["bug", "urgent"],
        },
      },
    ]);

    // The captured artifact shows its intent's state here too.
    act(() => {
      useAppStore.setState({
        ledger: {
          intents: [
            {
              intent: info({
                id: "c1",
                projectId: "p1",
                text: "Review PR #8: Add tests",
                source: { kind: "pr", ref: "8" },
              }),
              state: "queued",
            },
          ],
          attention: [],
          badge: 0,
        },
      });
    });
    fireEvent.click(within(overview).getByTestId("sources-tab-prs-p1"));
    const pr = within(overview).getByTestId("source-pr-p1-8");
    expect(
      within(pr).getByTestId("source-pr-p1-8-state").textContent,
    ).toBe("queued");
    expect(within(pr).queryByRole("button", { name: /Queue/ })).toBeNull();
  });

  test("Remove forgets the project and hands focus to the sidebar's Dashboard entry (projects-9)", async () => {
    commandMock.mockImplementation(async (type: string) => {
      if (type === "project.list") return [PROJECTS[1]];
      if (type === "ledger.get") return useAppStore.getState().ledger;
      if (type === "ledger.history") return { intents: [], more: false };
      return {};
    });
    seed();
    const onRemoved = vi.fn();
    render(
      <>
        <nav aria-label="Spex navigation">
          <button type="button" aria-label="Dashboard — 2 need your attention">
            Dashboard
          </button>
        </nav>
        <OverviewTab
          projectId="p1"
          onRemoved={onRemoved}
          onOpenSession={vi.fn()}
          onOpenIntent={vi.fn()}
          onStartIntent={vi.fn()}
        />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(callsOf("project.remove")).toEqual([{ projectId: "p1" }]);
    expect(onRemoved).toHaveBeenCalled();
    // The Overview went with the project; focus lands on the sidebar's
    // Dashboard entry, found by its accessible name — never on body.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Dashboard/ }),
    );
  });

  test("GitHub setup guidance names the unmet condition inside the Sources band (projects-7)", () => {
    seed({
      projectMeta: {
        p1: {
          status: { branch: "main", dirty: false, ahead: 0, behind: 0 },
          forge: {
            adapter: "github",
            authenticated: null,
            issues: [],
            prs: [],
            guidance:
              "gh is not installed — install the GitHub CLI to list issues and PRs.",
          },
        },
        p2: {},
      },
    });
    const { overview } = renderOverview();
    // Repo state and removal stay functional beside the guidance.
    expect(overview.textContent).toContain("main");
    expect(
      (
        within(overview).getByRole("button", {
          name: "Remove project",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      within(overview).getByTestId("sources-guidance-p1").textContent,
    ).toContain("gh is not installed");
    // The band is the one place for the lists: no second list in the
    // header, and no link away from the Overview itself.
    expect(within(overview).queryByText("Issues to do")).toBeNull();
    expect(
      within(overview).queryByRole("button", { name: /Open the project/ }),
    ).toBeNull();
  });
});
