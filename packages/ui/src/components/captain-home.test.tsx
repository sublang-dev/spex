// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// RUN-29/31/35: the Captain home greets, starts in one motion, filters
// the slash menu, keeps the quick start dismissed, and tunes the
// Captain's inline agent block in place (DR-019).

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

afterEach(cleanup);

import { CaptainHome, QUICK_START_KEY, popoverRoom } from "./CaptainHome.js";

const PROJECT = { id: "p1", path: "/tmp/demo", name: "demo", registeredAt: 0 };

import type {
  AgentSummary,
  IntentInfo,
  PlaybookSummary,
  ReadinessEntry,
} from "@sublang/spex-core/protocol";
import type { AgentPatch } from "../lib/config-ops.js";
import { keyLabel } from "../lib/shortcuts.js";
import {
  setClientForTests,
  useAppStore,
  type StagedIntent,
} from "../state/store.js";

// A hand-written `instruction` rides along in the summary: the editor
// never surfaces it, so a merge patch must leave it out (DR-019).
const CAPTAIN: AgentSummary = {
  adapter: "claude",
  model: "claude-opus-4-8",
  effort: "high",
  instruction: "Route the boss's words to a playbook.",
  permissions: { mode: "auto" },
};

const READY: ReadinessEntry[] = [
  {
    adapter: "claude",
    ready: true,
    usedBy: ["captain", "code.coder"],
    fastModeSupported: true,
  },
];

const PLAYBOOKS: PlaybookSummary[] = [
  {
    id: "code",
    from: "@sublang/playbook/code/registry",
    command: "code",
    intent: "software development workflow",
    roles: { coder: { playerId: "dev.coder", display: "claude-opus-5" } },
  },
  {
    id: "review",
    from: "@sublang/playbook/review/registry",
    command: "review",
    intent: "design review",
    roles: { host: { playerId: "dev.coder", display: "claude-opus-5" } },
  },
];

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function renderHome({
  onStart = vi.fn(async () => {}),
  onSaveCaptain = vi.fn(async (_patch: AgentPatch) => {}),
  onNavigate = vi.fn(),
  onOpenPalette = vi.fn(),
  hasProject = true,
  hasProjects = true,
  // null renders the no-captain state; undefined would fall back to
  // this default the way an omitted option does.
  captain = CAPTAIN as AgentSummary | null,
  onRecheckReadiness = undefined as (() => Promise<unknown>) | undefined,
  readiness = READY,
  configStatus = undefined as "valid" | "invalid" | "missing" | undefined,
  configErrors = undefined as string[] | undefined,
  storage = memoryStorage(),
  next = undefined as { intent: IntentInfo; more: number } | undefined,
  onStartIntent = undefined as
    | ((intent: IntentInfo) => Promise<void>)
    | undefined,
  staged = undefined as StagedIntent | undefined,
  onDetachStaged = undefined as (() => void) | undefined,
  onQueueInstead = undefined as ((text: string) => Promise<void>) | undefined,
} = {}) {
  const view = render(
    <CaptainHome
      hasProject={hasProject}
      hasProjects={hasProjects}
      projectName={hasProject ? PROJECT.name : undefined}
      playbooks={PLAYBOOKS}
      captain={captain ?? undefined}
      readiness={readiness}
      connected
      configStatus={configStatus}
      configErrors={configErrors}
      onRecheckReadiness={onRecheckReadiness}
      onOpenPalette={onOpenPalette}
      onNavigate={onNavigate}
      onSaveCaptain={onSaveCaptain}
      onStart={onStart}
      storage={storage}
      next={next}
      onStartIntent={onStartIntent}
      staged={staged}
      onDetachStaged={onDetachStaged}
      onQueueInstead={onQueueInstead}
    />,
  );
  return {
    onStart,
    onSaveCaptain,
    onNavigate,
    onOpenPalette,
    storage,
    view,
  };
}

describe("RUN-29: captain home structure and one-motion start", () => {
  test("greeting, composer, and captain identity render", () => {
    renderHome();
    expect(screen.getByText(/Hello! This is demo/).textContent).toBeTruthy();
    expect(screen.getByTestId("start-composer")).toBeTruthy();
    // The Captain shows as the one agent chip (DR-019): adapter ·
    // model @ effort, with the adapter's readiness dot.
    const chip = screen.getByTestId("agent-chip");
    expect(chip.textContent).toContain("claude · claude-opus-4-8 @ high");
    expect(chip.getAttribute("aria-label")).toBe(
      "Captain: claude · claude-opus-4-8 @ high (ready)",
    );
    expect(screen.getByTestId("captain-settings")).toBeTruthy();
  });

  test("a config with no captain reads as not set, gear inert", () => {
    renderHome({ captain: null, configStatus: "invalid" });
    expect(screen.queryByTestId("agent-chip")).toBeNull();
    expect(screen.getByText("not set")).toBeTruthy();
    expect(
      (screen.getByTestId("captain-settings") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("submitting in the bar's project starts with the text", async () => {
    const { onStart } = renderHome();
    fireEvent.change(screen.getByTestId("start-composer"), {
      target: { value: "fix the bug" },
    });
    fireEvent.click(screen.getByTestId("start-send"));
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledWith("fix the bug"));
  });

  test("with no project registered, the greeting offers adding one", () => {
    // The remedy the workspace actually has: with nothing registered,
    // there is nothing in the sidebar to pick (run-view-25).
    renderHome({ hasProject: false, hasProjects: false });
    expect(screen.getByText(/Add a project — any local git repo/)).toBeTruthy();
    expect(screen.queryByText(/Pick a project in the sidebar/)).toBeNull();
    // Send says what to do first, with this platform's modifier.
    expect(screen.getByTestId("start-send").title).toBe(
      `Add a project first (${keyLabel("P")})`,
    );
  });

  test("the greeting says what a playbook is, and Send says how", () => {
    renderHome();
    expect(
      screen.getByText(/a scripted workflow the AI players run/),
    ).toBeTruthy();
    expect(screen.getByTestId("start-send").title).toBe(
      "Enter to send · Shift+Enter for a new line",
    );
  });

  test("submitting without a project opens the palette, draft intact", () => {
    const { onStart, onOpenPalette } = renderHome({ hasProject: false });
    expect(screen.getByText(/Pick a project in the sidebar/)).toBeTruthy();
    expect(screen.getByTestId("start-send").title).toBe(
      `Pick a project first (${keyLabel("P")})`,
    );
    const composer = screen.getByTestId(
      "start-composer",
    ) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "do it" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onStart).not.toHaveBeenCalled();
    expect(onOpenPalette).toHaveBeenCalled();
    expect(composer.value).toBe("do it");
  });
});

describe("run-view-25: with nothing registered, the greeting carries the ways in", () => {
  test("Add a project… opens the palette; the Academy control seeds through the store", async () => {
    const openAcademyExample = vi.fn(async () => PROJECT);
    useAppStore.setState({ openAcademyExample });
    const { onOpenPalette } = renderHome({
      hasProject: false,
      hasProjects: false,
    });
    fireEvent.click(screen.getByTestId("home-add-project"));
    expect(onOpenPalette).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("home-academy"));
    // The same store action the palette uses (DR-015); it registers
    // and selects, so the host then greets by name.
    await vi.waitFor(() => expect(openAcademyExample).toHaveBeenCalled());
  });

  test("a seeding failure lands in the thread, the controls stay", async () => {
    useAppStore.setState({
      openAcademyExample: vi.fn(async (): Promise<never> => {
        throw new Error("target directory is not empty");
      }),
    });
    renderHome({ hasProject: false, hasProjects: false });
    fireEvent.click(screen.getByTestId("home-academy"));
    await vi.waitFor(() =>
      expect(screen.getByText(/not empty/).textContent).toBeTruthy(),
    );
    expect(
      (screen.getByTestId("home-academy") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("with projects to pick from, the greeting carries no add controls", () => {
    renderHome({ hasProject: false, hasProjects: true });
    expect(screen.queryByTestId("home-add-project")).toBeNull();
    expect(screen.queryByTestId("home-academy")).toBeNull();
  });
});

describe("RUN-31: slash menu and quick start dismissal", () => {
  test("typing / lists playbooks with intents and filters by prefix", () => {
    renderHome();
    const composer = screen.getByTestId("start-composer");
    fireEvent.change(composer, { target: { value: "/" } });
    expect(screen.getByTestId("slash-menu").textContent).toContain("/code");
    expect(screen.getByTestId("slash-menu").textContent).toContain(
      "design review",
    );
    fireEvent.change(composer, { target: { value: "/re" } });
    const menu = screen.getByTestId("slash-menu");
    expect(menu.textContent).toContain("/review");
    expect(menu.textContent).not.toContain("/code");
  });

  test("selecting from the slash menu inserts without dispatching", async () => {
    const { onStart } = renderHome();
    const composer = screen.getByTestId(
      "start-composer",
    ) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "/co" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer.value).toBe("/code ");
    expect(onStart).not.toHaveBeenCalled();
  });

  test("dismissing the quick start persists across remounts", () => {
    const storage = memoryStorage();
    const first = renderHome({ storage });
    expect(screen.getByTestId("quick-start")).toBeTruthy();
    fireEvent.click(screen.getByTestId("quick-start-dismiss"));
    expect(screen.queryByTestId("quick-start")).toBeNull();
    expect(storage.getItem(QUICK_START_KEY)).toBe("1");
    first.view.unmount();
    renderHome({ storage });
    expect(screen.queryByTestId("quick-start")).toBeNull();
  });
});

describe("RUN-35: in-place captain agent editing (DR-019)", () => {
  test("the gear opens the shared editor over the captain's block", () => {
    renderHome();
    fireEvent.click(screen.getByTestId("captain-settings"));
    const popover = screen.getByTestId("agent-popover");
    expect(popover.getAttribute("aria-label")).toBe("Captain agent");
    expect(within(popover).getByTestId("agent-editor")).toBeTruthy();
    // Every adapter the embedded runtime knows is offered, the
    // captain's own selected, and readiness rides on the choice.
    for (const adapter of ["claude", "codex", "gemini", "kimi", "opencode"]) {
      expect(within(popover).getByTestId(`agent-adapter-${adapter}`)).toBeTruthy();
    }
    expect(
      within(popover)
        .getByTestId("agent-adapter-claude")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(popover).getByTitle("ready")).toBeTruthy();
    expect(
      (within(popover).getByTestId("agent-model") as HTMLInputElement).value,
    ).toBe("claude-opus-4-8");
    // Copying from the Captain is meaningless in the Captain's own
    // editor: the action is absent here (DR-019).
    expect(within(popover).queryByTestId("agent-same-as-captain")).toBeNull();
  });

  test("a model edit saves a merge patch and never leaves the home", async () => {
    const { onSaveCaptain } = renderHome();
    fireEvent.click(screen.getByTestId("captain-settings"));
    fireEvent.change(screen.getByTestId("agent-model"), {
      target: { value: "claude-opus-4-8[1m]" },
    });
    fireEvent.click(screen.getByTestId("agent-save"));
    await vi.waitFor(() =>
      expect(onSaveCaptain).toHaveBeenCalledWith({
        adapter: "claude",
        model: "claude-opus-4-8[1m]",
        effort: "high",
        permissions: { mode: "auto" },
      }),
    );
    // The patch carries the surfaced keys only: the hand-written
    // instruction survives by being absent from the patch.
    expect(onSaveCaptain.mock.calls[0][0]).not.toHaveProperty("instruction");
    await vi.waitFor(() =>
      expect(screen.queryByTestId("agent-popover")).toBeNull(),
    );
    // Never navigated anywhere: the home is still mounted.
    expect(screen.getByTestId("captain-home")).toBeTruthy();
  });

  test("an adapter switch resets tuning through the same patch path", async () => {
    const { onSaveCaptain } = renderHome({
      captain: { ...CAPTAIN, fastMode: true },
    });
    fireEvent.click(screen.getByTestId("captain-settings"));
    fireEvent.click(screen.getByTestId("agent-adapter-codex"));
    fireEvent.click(screen.getByTestId("agent-save"));
    await vi.waitFor(() =>
      expect(onSaveCaptain).toHaveBeenCalledWith({
        adapter: "codex",
        model: null,
        effort: null,
        fastMode: null,
        permissions: { mode: "auto" },
      }),
    );
  });
});

describe("RUN-43: Escape hides the slash menu, never the draft", () => {
  test("Escape dismisses; typing brings the menu back", () => {
    renderHome();
    const composer = screen.getByTestId(
      "start-composer",
    ) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "/co" } });
    expect(screen.getByTestId("slash-menu")).toBeTruthy();
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(screen.queryByTestId("slash-menu")).toBeNull();
    expect(composer.value).toBe("/co");
    fireEvent.change(composer, { target: { value: "/cod" } });
    expect(screen.getByTestId("slash-menu")).toBeTruthy();
  });
});

describe("RUN-44: broken config surfaces in the thread", () => {
  test("an invalid config renders the errors and a Settings link", () => {
    const { onNavigate } = renderHome({
      configStatus: "invalid",
      configErrors: ["playbooks.code.players.coder: unknown adapter 'gpt'"],
    });
    expect(
      screen.getByText(/config file has errors/).textContent,
    ).toBeTruthy();
    expect(
      screen.getByText(/unknown adapter/, { exact: false }),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Open Settings →"));
    expect(onNavigate).toHaveBeenCalledWith("Settings");
  });
});

describe("RUN-45: readiness heals at hand", () => {
  test("the heads-up bubble names the adapter and offers a re-check", async () => {
    const onRecheckReadiness = vi.fn(async () => {});
    renderHome({
      onRecheckReadiness,
      readiness: [
        {
          adapter: "claude",
          ready: false,
          requirement: "set ANTHROPIC_API_KEY or sign in with Claude Code",
          usedBy: ["captain", "code.coder"],
          fastModeSupported: true,
        },
      ],
    });
    const bubble = screen.getByText(/aren't ready yet/).closest("div")!;
    expect(bubble.textContent).toContain("claude");
    expect(bubble.textContent).toContain("ANTHROPIC_API_KEY");
    // Within the label budget (DR-041): the bubble's prose says what
    // to set up, the control just re-checks.
    expect(screen.getByTestId("recheck-readiness").textContent).toBe("Re-check");
    fireEvent.click(screen.getByTestId("recheck-readiness"));
    await vi.waitFor(() => expect(onRecheckReadiness).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// Intent ledger coverage (run-view-95/88, DR-035): the next card and
// the home composer's staging and queue-instead wiring.
// ---------------------------------------------------------------------------

const NEXT_INTENT: IntentInfo = {
  id: "i-next",
  projectId: "p1",
  text: "Address #12: harden the auth flow\nwith the full context below",
  rank: "m",
  createdAt: 0,
};

describe("run-view-88: the Captain home names the queue's head", () => {
  test("the next card shows the head intent, the count, and Start", async () => {
    const onStartIntent = vi.fn(async () => {});
    renderHome({ next: { intent: NEXT_INTENT, more: 2 }, onStartIntent });

    const card = screen.getByTestId("next-card");
    expect(card.textContent).toContain("Up next");
    expect(card.textContent).toContain("Address #12: harden the auth flow");
    expect(card.textContent).toContain("+2 more queued");
    expect(screen.getByTestId("next-start").title).toBe(
      "Put this task in the message — Send starts it",
    );
    // Coexists with the quick start card (run-view-88).
    expect(screen.getByTestId("quick-start")).toBeTruthy();

    fireEvent.click(screen.getByTestId("next-start"));
    await vi.waitFor(() =>
      expect(onStartIntent).toHaveBeenCalledWith(NEXT_INTENT),
    );
  });

  test("no queued intent, no card — the quick start stands alone", () => {
    renderHome();
    expect(screen.queryByTestId("next-card")).toBeNull();
    expect(screen.getByTestId("quick-start")).toBeTruthy();
  });

  test("Remove closes the head dropped on the click; Undo re-queues it at the head (run-view-114)", async () => {
    const command = vi.fn(async (type: string) => {
      if (type === "ledger.get") return { intents: [], attention: [], badge: 0 };
      if (type === "intent.queue") return { ...NEXT_INTENT, id: "i-back" };
      return {};
    });
    setClientForTests({ command, subscribe: vi.fn(async () => {}) } as never);
    const props = {
      hasProject: true,
      hasProjects: true,
      projectName: PROJECT.name,
      playbooks: PLAYBOOKS,
      captain: CAPTAIN,
      readiness: READY,
      connected: true,
      onOpenPalette: vi.fn(),
      onNavigate: vi.fn(),
      onSaveCaptain: vi.fn(async () => {}),
      onStart: vi.fn(async () => {}),
      storage: memoryStorage(),
    };
    const view = render(
      <CaptainHome {...props} next={{ intent: NEXT_INTENT, more: 0 }} />,
    );

    const remove = screen.getByTestId("next-remove");
    expect(remove.textContent).toBe("Remove");
    // One click, no confirm — the Undo line is the way back.
    fireEvent.click(remove);
    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledWith("intent.close", {
        intentId: "i-next",
        as: "dropped",
      }),
    );
    const removed = await screen.findByTestId("next-removed");
    expect(removed.getAttribute("role")).toBe("status");
    expect(removed.textContent).toContain(
      "Removed “Address #12: harden the auth flow”",
    );
    const undo = within(removed).getByRole("button", { name: "Undo" });
    // The move lands in the commit's effect; a loaded runner reaches
    // this line before it.
    await vi.waitFor(() => expect(document.activeElement).toBe(undo));
    // The host's fold now serves no next: the card stays for its Undo
    // line alone.
    view.rerender(<CaptainHome {...props} next={undefined} />);
    expect(screen.getByTestId("next-card")).toBeTruthy();
    expect(screen.queryByTestId("next-start")).toBeNull();
    expect(screen.getByTestId("next-removed")).toBeTruthy();

    fireEvent.click(undo);
    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        "intent.queue",
        expect.objectContaining({
          projectId: "p1",
          text: NEXT_INTENT.text,
          at: "head",
        }),
      ),
    );
    expect(screen.queryByTestId("next-removed")).toBeNull();
    // Served again, the restored intent's Start takes focus.
    view.rerender(
      <CaptainHome
        {...props}
        next={{ intent: { ...NEXT_INTENT, id: "i-back" }, more: 0 }}
      />,
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("next-start")),
    );
    setClientForTests(undefined);
  });

  test("a pointer Remove leaves the pointer where it is; the Undo line lapses on schedule (run-view-114)", async () => {
    vi.useFakeTimers();
    const command = vi.fn(async (type: string) => {
      if (type === "ledger.get") return { intents: [], attention: [], badge: 0 };
      return {};
    });
    setClientForTests({ command, subscribe: vi.fn(async () => {}) } as never);
    try {
      renderHome({ next: { intent: NEXT_INTENT, more: 0 } });
      // A mouse click carries its click count; a keyboard activation
      // carries none (detail 0), which is what fireEvent.click sends
      // by default and the keyboard test above relies on.
      await act(async () => {
        fireEvent.click(screen.getByTestId("next-remove"), { detail: 1 });
      });
      // The removal's promise chain settles inside act; the line is
      // up before the clock moves.
      await act(async () => {});
      const removed = screen.getByTestId("next-removed");
      const undo = within(removed).getByRole("button", { name: "Undo" });
      expect(document.activeElement).not.toBe(undo);
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      // Nothing held the line open, so it went: the card stands as a
      // finished removal, never as a prompt.
      expect(screen.queryByTestId("next-removed")).toBeNull();
    } finally {
      vi.useRealTimers();
      setClientForTests(undefined);
    }
  });
});

describe("run-view-86: the home composer wears the staged chip", () => {
  test("the chip names the intent and detaches on demand", () => {
    const onDetachStaged = vi.fn();
    renderHome({
      staged: { intentId: "i-next", title: "Address #12: harden the auth flow" },
      onDetachStaged,
    });
    const chip = screen.getByTestId("staged-intent-chip");
    expect(chip.textContent).toContain("Address #12: harden the auth flow");
    // Plain words for the control (DR-010 §8), on a 24px target.
    const detach = screen.getByLabelText("Take the task out of the message");
    expect(detach.className).toContain("h-6 w-6");
    fireEvent.click(detach);
    expect(onDetachStaged).toHaveBeenCalled();
  });

  test("emptying the composer detaches the staged intent", () => {
    const onDetachStaged = vi.fn();
    renderHome({
      staged: { intentId: "i-next", title: "Address #12: harden the auth flow" },
      onDetachStaged,
    });
    const composer = screen.getByTestId(
      "start-composer",
    ) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "some context" } });
    expect(onDetachStaged).not.toHaveBeenCalled();
    fireEvent.change(composer, { target: { value: "" } });
    expect(onDetachStaged).toHaveBeenCalled();
  });
});

describe("run-view-85: queue instead of send, from the home", () => {
  test("the control queues the text and acknowledges in place", async () => {
    const onQueueInstead = vi.fn(async () => {});
    const { onStart } = renderHome({ onQueueInstead });
    const composer = screen.getByTestId(
      "start-composer",
    ) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "later: tidy the docs" } });
    // The secondary action is named by where the text goes.
    expect(screen.getByTestId("queue-intent-button").textContent).toBe(
      "Add to Up next",
    );
    fireEvent.click(screen.getByTestId("queue-intent-button"));
    await vi.waitFor(() =>
      expect(onQueueInstead).toHaveBeenCalledWith("later: tidy the docs"),
    );
    // Shelved, not sent: no session starts, the draft clears, and the
    // acknowledgment names where the row landed.
    expect(onStart).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(composer.value).toBe(""));
    expect(
      screen.getByTestId("queued-intent-note").textContent,
    ).toContain("Up next");
  });

  test("without a current project the control hides", () => {
    renderHome({ hasProject: false });
    expect(screen.queryByTestId("queue-intent-button")).toBeNull();
  });
});

describe("run-view-25, DR-038: the Captain chip wears the fast-mode mark", () => {
  test("a captain in fast mode shows the lightning with its tooltip", () => {
    renderHome({ captain: { ...CAPTAIN, fastMode: true } });
    const chip = screen.getByTestId("agent-chip");
    expect(within(chip).getByTitle("fast mode").textContent).toBe("⚡");
    expect(chip.getAttribute("aria-label")).toContain("fast mode");
  });

  test("without fast mode there is no mark", () => {
    renderHome();
    expect(
      within(screen.getByTestId("agent-chip")).queryByTitle("fast mode"),
    ).toBeNull();
  });
});

describe("run-view-32: the popover opens where the window can show it", () => {
  /** An anchor whose box the document actually reports. */
  function place(el: HTMLElement, top: number, bottom: number): void {
    el.getBoundingClientRect = () =>
      ({
        top,
        bottom,
        left: 0,
        right: 24,
        width: 24,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  test("the roomier side wins, and the room is what the window can show", () => {
    // jsdom reports a 768px window: a gear near its foot has more room
    // above it, one near its head more room below.
    const gear = document.createElement("button");
    place(gear, 640, 660);
    expect(popoverRoom(gear)).toEqual({ direction: "up", room: 632 });
    place(gear, 20, 40);
    expect(popoverRoom(gear)).toEqual({ direction: "down", room: 720 });
  });

  test("an unmeasured anchor leaves the popover its natural place", () => {
    // A simulated or unpainted document measures nothing.
    expect(popoverRoom(null)).toEqual({ direction: "up" });
    expect(popoverRoom(document.createElement("button"))).toEqual({
      direction: "up",
    });
  });

  test("a gear with less room above opens downward, capped to the room", () => {
    renderHome();
    const gear = screen.getByTestId("captain-settings");
    place(gear, 340, 360);
    fireEvent.click(gear);
    const popover = screen.getByTestId("agent-popover");
    expect(popover.className).toContain("top-full");
    expect(popover.className).not.toContain("bottom-full");
    // The anchor grants the room its dialog may take.
    expect(popover.parentElement!.style.getPropertyValue("--popover-room")).toBe(
      "400px",
    );
  });

  test("a gear with room above keeps opening upward", () => {
    renderHome();
    const gear = screen.getByTestId("captain-settings");
    place(gear, 600, 620);
    fireEvent.click(gear);
    const popover = screen.getByTestId("agent-popover");
    expect(popover.className).toContain("bottom-full");
    expect(popover.parentElement!.style.getPropertyValue("--popover-room")).toBe(
      "592px",
    );
  });
});
