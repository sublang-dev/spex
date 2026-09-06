// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// RUN-19/20/21 component coverage: the run view rendered from the
// fixture stream shows the expected panes and never hidden content.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen,
  within, waitFor,
} from "@testing-library/react";

afterEach(cleanup);

import { RunView } from "./RunView.js";
import { PlayerPane, toolLabel, unwrapShell } from "./PlayerPane.js";
import { applyRecords, initialSessionView } from "../state/reducer.js";
import {
  deliverServerMessageForTests,
  setClientForTests,
  useAppStore,
} from "../state/store.js";
import type {
  DerivedIntent,
  IntentInfo,
  LedgerState,
} from "@sublang/spex-core/protocol";
import {
  FULL_RUN,
  HIDDEN_LEAK,
  INITIAL_VISIBLE,
  PLAYERS,
  TURN_ONE,
  TURN_TWO_QUESTION,
} from "../fixtures/sample-run.js";
import type {
  SessionInfo,
  TmuxPlayRecord,
} from "@sublang/spex-core/protocol";
import {
  MACHINE_ORPHAN,
  MACHINE_RUN,
  MACHINE_STOPPED,
} from "../fixtures/sample-run.js";
import codeGraph from "../fixtures/machines/code.json";
import reviewGraph from "../fixtures/machines/review.json";
import type { MachineGraph } from "@sublang/spex-core/protocol";

const SESSION: SessionInfo = {
  id: "s1",
  projectId: "p1",
  projectPath: "/tmp/demo",
  createdAt: 0,
  live: true,
  endedAt: null,
  players: PLAYERS,
  initialVisible: INITIAL_VISIBLE,
  turns: 0,
  failed: false,
};

const restoreResizeObserver: (() => void)[] = [];
afterEach(() => {
  while (restoreResizeObserver.length) restoreResizeObserver.pop()!();
});

/** A stand-in for the browser's ResizeObserver: a simulated document
 * has none, so the boxes that watch their own size are driven by
 * hand. */
function observeResizes(): { fire(target: Element): void } {
  interface Watcher {
    target: Element;
    fire(): void;
  }
  const watchers = new Set<Watcher>();
  const previous = Reflect.get(globalThis, "ResizeObserver");
  class Stub {
    private readonly mine = new Set<Watcher>();
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      const watcher: Watcher = {
        target,
        fire: () => this.callback([], this as unknown as ResizeObserver),
      };
      this.mine.add(watcher);
      watchers.add(watcher);
    }
    unobserve(): void {}
    disconnect(): void {
      for (const watcher of this.mine) watchers.delete(watcher);
      this.mine.clear();
    }
  }
  Reflect.set(globalThis, "ResizeObserver", Stub);
  restoreResizeObserver.push(() => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "ResizeObserver");
    else Reflect.set(globalThis, "ResizeObserver", previous);
  });
  return {
    fire(target: Element): void {
      for (const watcher of [...watchers]) {
        if (watcher.target === target) watcher.fire();
      }
    },
  };
}

/** A system line's words, glyph and all (run-view-1): the glyph sits
 * in its own icon slot, so the line is found by its whole text. */
function systemLine(text: string | RegExp): HTMLElement | null {
  return (
    screen.queryAllByTestId("system-line").find((el) =>
      typeof text === "string"
        ? el.textContent === text
        : text.test(el.textContent ?? ""),
    ) ?? null
  );
}

function renderRun(entries: typeof FULL_RUN, storedGraphs = false) {
  if (storedGraphs) entries = [{seq:1, record:{type:"session_context", timestamp:0, contextVersion:1, graphs:[{playbookId:"code",graph:codeGraph},{playbookId:"review",graph:reviewGraph}]} as unknown as TmuxPlayRecord},
    ...entries.map((entry) => ({...entry, seq:entry.seq + 1, record:{...entry.record, contextSeq:1}}))];
  const view = applyRecords(
    initialSessionView(PLAYERS),
    entries,
  );
  return render(
    <RunView
      session={SESSION}
      view={view}
      composer={{ queued: [] }}
      connected
      onSubmit={async () => {}}
      onAbort={() => {}}
      onRemoveQueued={() => {}}
      onDismissError={() => {}}
    />,
  );
}

describe("run-view-14: opaque records in the protocol stream", () => {
  test("advances past opaque entries without changing the turn or dispatching its queue", () => {
    const previous = useAppStore.getState();
    const command = vi.fn(async () => ({}));
    setClientForTests({ command } as never);
    useAppStore.setState({
      sessions: [SESSION],
      activeSessionId: SESSION.id,
      views: { s1: initialSessionView(PLAYERS) },
      composers: { s1: { queued: [{ text: "Queued follow-up" }] } },
      collapsedLanes: { s1: ["dev.reviewer"] },
      specTrees: {},
      ledger: undefined,
      stagedIntents: {},
    });

    function ConnectedRun() {
      const view = useAppStore((state) => state.views.s1);
      const composer = useAppStore((state) => state.composers.s1);
      return (
        <RunView
          session={SESSION}
          view={view}
          composer={composer}
          connected
          onSubmit={async () => {}}
          onAbort={() => {}}
          onRemoveQueued={() => {}}
          onDismissError={() => {}}
        />
      );
    }

    let seq = 0;
    function deliver(record: Record<string, unknown>): void {
      act(() => {
        deliverServerMessageForTests({
          type: "record",
          channel: "session",
          sessionId: SESSION.id,
          seq: ++seq,
          record: record as unknown as TmuxPlayRecord,
        });
      });
    }

    const rendered = render(<ConnectedRun />);
    try {
      deliver({
        type: "turn_started", turnId: 1, timestamp: 1,
        turn: { id: 1, prompt: "Original task", timestamp: 1 },
      });
      for (const record of [
        { opaque: { preserved: true } },
        { timestamp: 2 },
        { type: "turn_started" },
        { type: "player_event", playerId: "dev.reviewer" },
        { type: "player_prompt", playerId: "dev.reviewer", prompt: "Invisible" },
        { type: "turn_finished", turnId: 1 },
        { type: "turn_aborted", turnId: 1 },
        { type: "future_record", timestamp: 3 },
      ]) deliver(record);

      expect(useAppStore.getState().views.s1).toEqual({
        ...initialSessionView(PLAYERS),
        captain: [{ kind: "boss", text: "Original task", turnId: 1, at: 1 }],
        currentTurnId: 1,
        turnActive: true,
        lastSeq: seq,
      });
      expect(useAppStore.getState().collapsedLanes.s1).toEqual(["dev.reviewer"]);
      expect(screen.getByTestId("player-pane-dev.reviewer").dataset.collapsed).toBe("true");
      expect(useAppStore.getState().composers.s1.queued).toEqual([
        { text: "Queued follow-up" },
      ]);
      expect(command).not.toHaveBeenCalled();
      expect(screen.getByTestId("boss-bubble").textContent).toContain("Original task");
      expect(screen.queryByText("Invisible")).toBeNull();

      deliver({ type: "captain_reply", turnId: 1, timestamp: 4, text: "A valid later reply" });
      expect(screen.getByText("A valid later reply")).toBeTruthy();
      expect(useAppStore.getState().views.s1.lastSeq).toBe(seq);
      expect(command).not.toHaveBeenCalled();

      deliver({ type: "turn_finished", turnId: 1, timestamp: 5 });
      expect(useAppStore.getState().views.s1.turnActive).toBe(false);
      expect(useAppStore.getState().views.s1.lastSeq).toBe(seq);
      expect(useAppStore.getState().composers.s1.queued).toEqual([]);
      expect(command.mock.calls).toEqual([
        ["turn.submit", { sessionId: "s1", text: "Queued follow-up" }],
        ["session.viewed", { sessionId: "s1", turnId: 1 }],
      ]);
    } finally {
      rendered.unmount();
      useAppStore.setState(previous);
      setClientForTests(undefined);
    }
  });
});

describe("RUN-30: boss messages echo as user bubbles", () => {
  test("the submitted turn text renders as a boss bubble", () => {
    renderRun(TURN_ONE);
    const bubble = screen.getByTestId("boss-bubble");
    expect(bubble.textContent).toContain("/code fix the bug");
  });
});

describe("RUN-19: pane structure from the fixture stream", () => {
  test("captain pane and both player panes render with content", () => {
    renderRun(TURN_ONE);
    expect(screen.getByTestId("captain-pane")).toBeTruthy();
    expect(screen.getByTestId("player-pane-dev.coder")).toBeTruthy();
    expect(screen.getByTestId("player-pane-dev.reviewer")).toBeTruthy();
    // A status line is a left-aligned system line at the small step,
    // its glyph in an icon slot — never centered mono (run-view-1).
    const started = systemLine("◇ /code started");
    expect(started).toBeTruthy();
    expect(started!.className).toContain("text-xs");
    expect(started!.className).not.toContain("text-center");
    expect(started!.className).not.toContain("font-mono");
    expect(started!.firstElementChild?.textContent).toBe("◇");
    // Markdown rendered: **auth** becomes a <strong>.
    expect(screen.getByText("auth").tagName).toBe("STRONG");
    // A collapsed tool card says the tool and what it acts on; an
    // input naming nothing recognizable stays the name alone.
    expect(screen.getByText("Edit", { exact: false })).toBeTruthy();
    expect(screen.getByTestId("tool-subject-7").textContent).toBe("src/auth.ts");
    const todo = screen.getByText("TodoWrite").closest("summary");
    expect(todo?.querySelector('[data-testid^="tool-subject-"]')).toBeNull();
    // The body prints each string field verbatim and only the rest as
    // JSON, every line wrapping inside the card; a span reads in the
    // app's one duration vocabulary, never raw milliseconds
    // (run-view-4).
    const body = screen.getByTestId("tool-body-7");
    const blocks = [...body.querySelectorAll("pre")];
    expect(blocks.map((pre) => pre.getAttribute("data-kind"))).toEqual([
      "text",
      "text",
      "text",
      "text",
    ]);
    expect(blocks[0].textContent).toBe("src/auth.ts");
    expect(blocks[3].textContent).toBe("ok");
    expect(body.textContent).toContain("old_string");
    expect(body.textContent).not.toContain('"src/auth.ts"');
    expect(blocks[0].className).toContain("overflow-wrap:anywhere");
    expect(screen.getByTestId("tool-duration-7").textContent).toContain("<1s");
    const todoBody = screen.getByTestId("tool-body-9");
    expect(todoBody.querySelector("pre")!.getAttribute("data-kind")).toBe("json");
    expect(todoBody.textContent).toContain('"content": "ship it"');
    // A call the core resolved no role for names the lane alone, and
    // an unprompted lane says whom it waits for (run-view-7).
    expect(screen.getByTestId("player-name-dev.coder").textContent).toBe(
      "dev.coder",
    );
    expect(screen.getByTestId("player-name-dev.reviewer").textContent).toBe(
      "dev.reviewer",
    );
    expect(screen.getByTestId("player-pane-dev.reviewer").textContent).toContain(
      "Idle until the playbook calls dev.reviewer",
    );
    // Agent text breaks anywhere rather than widening its pane
    // (run-view-3), and so does a call's prompt.
    const markdown = screen.getByText("the SDK docs").closest(".markdown")!;
    expect(markdown.className).toContain("overflow-wrap:anywhere");
    expect(
      screen.getByText("Fix the bug in auth.ts").className,
    ).toContain("overflow-wrap:anywhere");
    // Only what the shell can open wears a link's affordance.
    expect(screen.getByText("the SDK docs").tagName).toBe("A");
    expect(screen.getByText("auth.md").tagName).toBe("SPAN");
    expect(screen.getByText("auth.md").title).toBe(
      "specs/packages/auth.md#auth-3",
    );
    // The turn's usage is its token totals alone: the fixture records
    // a provider-reported cost, and no pane shows a currency sign or
    // an estimate mark (run-view-6, DR-044).
    const coder = screen.getByTestId("player-pane-dev.coder").textContent ?? "";
    expect(coder).toContain("120→30 tok");
    expect(coder).not.toMatch(/[$≈]/);
    expect(document.body.textContent).not.toMatch(/[$≈]/);
  });

  test("a narrowing visibility record takes no pane away", () => {
    // What a nested call does when it returns: the runtime reports
    // only the players it still engages. The lanes are the session's,
    // so both panes stand (run-view-7).
    renderRun([
      ...TURN_ONE,
      {
        seq: 99,
        record: {
          type: "player_view_changed",
          turnId: 1,
          timestamp: Date.now(),
          visiblePlayerIds: ["dev.coder"],
        },
      } as (typeof TURN_ONE)[number],
    ]);
    expect(screen.getByTestId("player-pane-dev.coder")).toBeTruthy();
    expect(screen.getByTestId("player-pane-dev.reviewer")).toBeTruthy();
  });
});

describe("RUN-20: hidden records never appear", () => {
  test("hidden captain prompt content is absent from the DOM", () => {
    const { container } = renderRun([...TURN_ONE, ...HIDDEN_LEAK]);
    expect(container.textContent).not.toContain("secret router prompt");
  });
});

describe("RUN-21: awaitBossReply as a first-class chat moment", () => {
  test("the question renders as an incoming bubble from the player", () => {
    renderRun([...TURN_ONE, ...TURN_TWO_QUESTION]);
    const bubble = screen.getByTestId("question-bubble");
    expect(bubble.textContent).toContain("dev.reviewer");
    expect(bubble.textContent).toContain(
      "Which auth flow should I prioritize?",
    );
    // The runtime's status-line echo of the same question is replaced
    // by the bubble, not duplicated.
    expect(
      screen.queryByText(/asks: Which auth flow/, { exact: false }),
    ).toBeNull();
  });

  test("the banner names the player without repeating the question", () => {
    renderRun([...TURN_ONE, ...TURN_TWO_QUESTION]);
    const banner = screen.getByTestId("boss-reply-banner");
    expect(banner.textContent).toContain(
      "dev.reviewer is waiting for your reply",
    );
  });

  test("banner clears after the reply turn", () => {
    renderRun(FULL_RUN);
    expect(screen.queryByTestId("boss-reply-banner")).toBeNull();
  });
});

const TURN_ONLY_STARTED = [
  {
    seq: 1,
    record: {
      type: "turn_started",
      turnId: 9,
      timestamp: 1,
      turn: { id: 9, prompt: "go", timestamp: 1 },
    } as unknown as TmuxPlayRecord,
  },
];

describe("RUN-37: the thread stays alive while a turn runs", () => {
  test("a working indicator shows when the captain is silent", () => {
    renderRun(TURN_ONLY_STARTED);
    expect(screen.getByTestId("working-indicator").textContent).toContain(
      "Captain is thinking…",
    );
  });

  test("a running player is named with the span since its call, ticking", () => {
    // Through the coder's prompt and its first delta: the call is open,
    // and the core resolved its role (run-view-79).
    const promptAt = (TURN_ONE[3].record as { timestamp: number }).timestamp;
    const entries = TURN_ONE.slice(0, 5).map((entry, index) =>
      index === 3 ? { ...entry, role: "coder" } : entry,
    );
    vi.useFakeTimers();
    vi.setSystemTime(promptAt + 133_000);
    try {
      renderRun(entries);
      const indicator = screen.getByTestId("working-indicator");
      expect(indicator.textContent).toContain("coder working · 2m 13s");
      // The running lane's header names the role beside the lane and
      // says the same span, beside its mark (run-view-7).
      expect(screen.getByTestId("player-name-dev.coder").textContent).toBe(
        "coder · dev.coder",
      );
      expect(screen.getByTestId("player-working").textContent).toBe(
        "coder working · 2m 13s",
      );
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(indicator.textContent).toContain("coder working · 2m 14s");
      expect(screen.getByTestId("player-working").textContent).toBe(
        "coder working · 2m 14s",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RUN-38: queued messages read as pending, not sent", () => {
  test("queue entries render full text with the delivery caption", () => {
    const view = applyRecords(
      initialSessionView(PLAYERS),
      TURN_ONLY_STARTED,
    );
    render(
      <RunView
        session={SESSION}
        view={view}
        composer={{ queued: [{ text: "also update the changelog please" }] }}
        connected
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />,
    );
    const queue = screen.getByTestId("queue-indicator");
    expect(queue.textContent).toContain("also update the changelog please");
    expect(queue.textContent).toContain("sends when this turn ends");
  });

  // run-view-106: the queue is the composer's one unbounded part, so
  // it lives in a frame a few entries tall, kept at its end.
  test("the queue scrolls in its own bounded frame, newest in view", () => {
    const view = applyRecords(initialSessionView(PLAYERS), TURN_ONLY_STARTED);
    const queued = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        text: `queued message ${index + 1}, long enough to wrap twice over`,
      }));
    const run = (count: number) => (
      <RunView
        session={SESSION}
        view={view}
        composer={{ queued: queued(count) }}
        connected
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />
    );
    const { rerender } = render(run(6));
    const queue = screen.getByTestId("queue-indicator");
    expect(queue.className).toContain("overflow-y-auto");
    expect(queue.className).toContain("max-h-40");
    // Every scrolling box is a positioned box (run-view-119).
    expect(queue.className).toContain("relative");

    // A simulated document has no scrolling box of its own; the frame
    // reports what a painted one would.
    let top = 0;
    Object.defineProperty(queue, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (next: number) => {
        top = next;
      },
    });
    Object.defineProperty(queue, "scrollHeight", {
      configurable: true,
      get: () => 480,
    });
    rerender(run(7));
    expect(queue.scrollTop).toBe(480);

    // The composer yields around the frame: its box keeps its place
    // whatever the queue holds.
    const box = screen.getByTestId("composer-box").parentElement!;
    expect(box.className).toContain("shrink-0");
    expect(box.parentElement!.className).toContain("min-h-0");
  });
});

describe("RUN-39: drafts come from the store", () => {
  test("the composer renders the stored draft and reports edits", () => {
    const view = applyRecords(
      initialSessionView(PLAYERS),
      TURN_ONE,
    );
    const onDraftChange = vi.fn();
    render(
      <RunView
        session={SESSION}
        view={view}
        composer={{ queued: [], draft: "half-typed reply" }}
        connected
        onDraftChange={onDraftChange}
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />,
    );
    const composer = screen.getByTestId(
      "boss-composer",
    ) as HTMLTextAreaElement;
    expect(composer.value).toBe("half-typed reply");
    fireEvent.change(composer, { target: { value: "half-typed reply!" } });
    expect(onDraftChange).toHaveBeenCalledWith("half-typed reply!");
  });
});

describe("RUN-40: abort acknowledges instantly", () => {
  test("clicking Abort disables it and relabels to Aborting…", () => {
    renderRun(TURN_ONLY_STARTED);
    const abort = screen.getByTestId("abort-button") as HTMLButtonElement;
    fireEvent.click(abort);
    expect(abort.disabled).toBe(true);
    expect(abort.textContent).toContain("Aborting…");
  });
});

describe("RUN-36: ended sessions render read-only", () => {
  test("readOnly hides the composer and shows the ended notice", () => {
    const view = applyRecords(
      initialSessionView(PLAYERS),
      TURN_ONE,
    );
    render(
      <RunView
        session={{ ...SESSION, live: false, endedAt: 5 }}
        view={view}
        composer={{ queued: [] }}
        connected
        readOnly
        onStartNew={() => {}}
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />,
    );
    expect(screen.getByTestId("ended-notice").textContent).toContain(
      "can't be continued",
    );
    expect(screen.queryByTestId("boss-composer")).toBeNull();
    // The control is within the label budget (DR-041), its sentence
    // in the tooltip.
    const fresh = screen.getByRole("button", { name: "New session" });
    expect(fresh.title).toBe("Start a new session in this project");
    // The notice wraps its control under its words in a narrow pane.
    expect(screen.getByTestId("ended-notice").className).toContain("flex-wrap");
  });

  // run-view-33 (DR-042): a continuable session is a paused
  // conversation — the notice says so above the enabled composer.
  test("a continuable session keeps its composer under the notice", () => {
    const view = applyRecords(initialSessionView(PLAYERS), TURN_ONE);
    render(
      <RunView
        session={{ ...SESSION, live: false, endedAt: 5, continuable: true }}
        view={view}
        composer={{ queued: [] }}
        connected
        onStartNew={() => {}}
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />,
    );
    expect(screen.getByTestId("ended-notice").textContent).toContain(
      "Ended · a message continues it",
    );
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
    expect(screen.getByTestId("session-ended-at")).toBeTruthy();
    const box = screen.getByTestId("boss-composer") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(box.placeholder).toBe("Message the Captain…");
  });
});

// run-view-47 (DR-042): ending pauses the conversation, and the
// confirm says a message can continue it.
describe("run-view-47: the End confirm says the session can continue", () => {
  test("the question names continuation and the queued messages", () => {
    const view = applyRecords(initialSessionView(PLAYERS), TURN_ONLY_STARTED);
    render(
      <RunView
        session={SESSION}
        view={view}
        composer={{ queued: [{ text: "later" }, { text: "and later" }] }}
        connected
        onEnd={() => {}}
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("end-session"));
    const keep = screen.getByRole("button", { name: "Keep" });
    expect(keep.parentElement?.textContent).toContain(
      "End this session? A message can continue it later. 2 queued messages will be discarded.",
    );
    expect(screen.getByRole("button", { name: "End" })).toBeTruthy();
    // The confirm wraps its controls under the question (DR-041).
    expect(keep.parentElement?.className).toContain("flex-wrap");
  });
});

// run-view-66: the machine call tree over a fixture replay (DR-031).
describe("run-view-66: the machine call tree from the trace", () => {
  test("a running child nests under its caller, which stays drawn as the only root", () => {
    // Replay to the review's first transition: /code is delegating,
    // /review is the running leaf.
    renderRun(MACHINE_RUN.slice(0, 13));
    const live = screen.getByTestId("live-machines");
    const cards = within(live).getAllByTestId(/^machine-card-/);
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute("data-playbook")).toBe("code");
    expect(cards[1].getAttribute("data-playbook")).toBe("review");

    // State names read at the name step (run-view-60, DR-010 §8).
    const reviewing = within(cards[1]).getByTestId(
      "machine-state-t-review-reviewing",
    );
    expect(reviewing.querySelector("text")!.getAttribute("font-size")).toBe("13");

    // A drawing wider than its column scrolls, and the column masks
    // its edge so the cut reads as "more this way" (run-view-81).
    const scroller = within(live).getAllByTestId(/^machine-scroll-/)[0];
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).toContain("mask-image");

    // The caller is the only root: it stays drawn while it delegates,
    // its calling state in the call voice naming the callee, and the
    // strip's sentence still names both for the accessible name.
    expect(cards[0].getAttribute("data-expanded")).toBe("true");
    expect(cards[0].getAttribute("aria-label")).toContain("review first commit");
    expect(cards[0].getAttribute("aria-label")).toContain("/review");
    const delegating = within(cards[0]).getByTestId(
      "machine-state-t-code-reviewFirstCommit",
    );
    expect(delegating.getAttribute("data-delegating")).toBe("true");
    expect(within(delegating).getByText("call /review")).toBeTruthy();
    expect(
      within(live).getByTestId("machine-connector-t-code"),
    ).toBeTruthy();

    // The running leaf is drawn too, and its header names the state
    // that called it.
    expect(cards[1].getAttribute("data-expanded")).toBe("true");
    expect(cards[1].getAttribute("data-caller-state")).toBe("reviewFirstCommit");
    expect(reviewing.getAttribute("data-active")).toBe("true");

    // The running mark is the app's one pulse, and it says so.
    const mark = within(cards[1]).getByTestId("machine-running-t-review");
    expect(mark.getAttribute("data-running")).toBe("true");
    expect(mark.className).toContain("motion-safe:animate-pulse");

    // The card absorbs the run's progress while ◇ engagement lines
    // stay — including the bare event ids the runtime narrates with
    // no glyph, which used to reach the reader as raw jargon.
    expect(systemLine("◇ /code started")).toBeTruthy();
    expect(systemLine(/⤷ Coder: implement/)).toBeNull();
    expect(systemLine("START_CODE")).toBeNull();
    expect(systemLine("→ directCommit")).toBeNull();
  });

  test("collapsing the caller is arrangement, and the child stays drawn", () => {
    renderRun(MACHINE_RUN.slice(0, 13));
    const before = screen
      .getAllByTestId(/^machine-card-/)
      .map((card) => card.getAttribute("data-playbook"));

    fireEvent.click(screen.getByTestId("machine-disclose-t-code"));

    const cards = screen.getAllByTestId(/^machine-card-/);
    // The strip names the calling state and the callee, and the
    // connector still leaves it — containment survives the fold.
    expect(cards[0].getAttribute("data-expanded")).toBe("false");
    expect(cards[0].getAttribute("aria-label")).toContain("review first commit");
    expect(screen.getByTestId("machine-connector-t-code")).toBeTruthy();
    // The child is untouched: the same tree, differently disclosed.
    expect(cards.map((card) => card.getAttribute("data-playbook"))).toEqual(
      before,
    );
    expect(cards[1].getAttribute("data-expanded")).toBe("true");
  });

  test("one card per run: the reports that trail a finish revive none", () => {
    renderRun(MACHINE_RUN);
    // Nothing left running, and the root settled into the thread with
    // its child settled inside it — not two loose cards.
    expect(screen.queryByTestId("live-machines")).toBeNull();
    const settled = screen.getAllByTestId(/^machine-card-/);
    expect(settled).toHaveLength(2);
    expect(settled[0].getAttribute("data-playbook")).toBe("code");
    expect(settled[1].getAttribute("data-playbook")).toBe("review");
    for (const card of settled) {
      expect(card.getAttribute("data-settled")).toBe("true");
    }
    // The status, settlement and disposal that follow a finished run
    // used to raise a blank second card labelled "stopped".
    expect(screen.getByTestId("machine-outcome-t-code").textContent).toBe(
      "done",
    );
    expect(screen.getByTestId("machine-outcome-t-review").textContent).toBe(
      "done",
    );
    // The settled child stays anchored to the state that called it.
    expect(settled[1].getAttribute("data-caller-state")).toBe(
      "reviewFirstCommit",
    );
  });

  test("a settled strip expands to its final drawing", () => {
    renderRun(MACHINE_RUN);
    const card = screen.getByTestId("machine-card-t-code");
    expect(card.getAttribute("data-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("machine-disclose-t-code"));
    expect(
      within(card).getByTestId("machine-state-t-code-done"),
    ).toBeTruthy();
  });

  test("a run disposed where it stands settles unfinished", () => {
    renderRun(MACHINE_STOPPED);
    expect(screen.getAllByTestId(/^machine-card-/)).toHaveLength(1);
    expect(screen.getByTestId("machine-outcome-t-halt").textContent).toBe(
      "stopped",
    );
  });

  test("a child whose caller is unknown draws at the top level", () => {
    renderRun(MACHINE_ORPHAN);
    const live = screen.getByTestId("live-machines");
    const cards = within(live).getAllByTestId(/^machine-card-/);
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute("data-playbook")).toBe("review");
  });
});


// run-view-60/76/81: the drawing reads from a projector (DR-010 §8).
describe("run-view-60/76/81: the card's words and its fit to the pane", () => {
  const graphs: Record<string, MachineGraph> = {
    code: codeGraph as MachineGraph,
    review: reviewGraph as MachineGraph,
  };
  beforeEach(() => {
    useAppStore.setState({ machineGraphs: graphs });
  });
  afterEach(() => {
    useAppStore.setState({ machineGraphs: {} });
  });

  test("boxes take their column's longest label; a long caption falls back to its role", () => {
    renderRun(MACHINE_RUN.slice(0, 13), true);
    const code = screen.getByTestId("machine-card-t-code");
    // "reported review failure" sets its column's width, so it reads
    // whole at 13px and the shorter names share the box width.
    const reported = within(code).getByTestId(
      "machine-state-t-code-reportedReviewFailure",
    );
    expect(reported.querySelector("text")!.textContent).toBe(
      "reported review failure",
    );
    const reportedBox = reported.querySelector("rect")!;
    const readyBox = within(code)
      .getByTestId("machine-state-t-code-ready")
      .querySelector("rect")!;
    expect(Number(reportedBox.getAttribute("width"))).toBeGreaterThan(132);
    expect(readyBox.getAttribute("width")).toBe(reportedBox.getAttribute("width"));
    // Exit labels sit one step under the small step, never lower.
    const exit = within(code).getAllByTestId(/^machine-exit-/)[0];
    expect(exit.getAttribute("font-size")).toBe("11");
  });

  test("a running call names role and player at the caption step, or the role alone", () => {
    // Through the coder's call: the code machine's first column is as
    // wide as "reported review failure", so the pair reads whole.
    renderRun(MACHINE_RUN.slice(0, 8));
    const running = screen.getByTestId("machine-state-t-code-runFirstPhase");
    const caption = within(running).getByTestId(
      "machine-caption-t-code-runFirstPhase",
    );
    expect(caption.textContent).toBe("coder · dev.coder");
    expect(caption.getAttribute("font-size")).toBe("12");
    cleanup();

    // A pair no box can hold falls back to the role, the whole pair
    // kept in the box's title (run-view-61).
    const longLane = MACHINE_RUN.slice(0, 7).concat([
      {
        seq: 406,
        record: {
          type: "captain_telemetry",
          turnId: 9,
          timestamp: 9_004,
          topic: "playbook.trace",
          payload: {
            schemaVersion: 3,
            sessionId: "t-code",
            playbookId: "code",
            depth: 1,
            type: "player.call.started",
            timestamp: 9_004,
            payload: {
              stateId: "runFirstPhase",
              roleId: "coder",
              playerId: "security.compliance.reviewer.lane",
            },
          },
        } as unknown as TmuxPlayRecord,
      },
    ]);
    renderRun(longLane);
    const state = screen.getByTestId("machine-state-t-code-runFirstPhase");
    expect(
      within(state).getByTestId("machine-caption-t-code-runFirstPhase").textContent,
    ).toBe("coder");
    expect(state.querySelector("title")!.textContent).toContain(
      "coder · security.compliance.reviewer.lane",
    );
    expect(Number(state.querySelector("rect")!.getAttribute("width"))).toBeLessThanOrEqual(240);
  });

  test("unwalked exits into rest states fold to a count until walked or hovered", () => {
    renderRun(MACHINE_RUN.slice(0, 13), true);
    const code = screen.getByTestId("machine-card-t-code");
    // runFirstPhase's three unwalked exits — two into failed, one
    // into the Boss-reply wait (playbook 12.2's CODE) — fold to one
    // "+3" marker whose title lists them, and no label.
    const first = within(code).getByTestId("machine-state-t-code-runFirstPhase");
    const folded = within(first).getByTestId(
      "machine-exits-folded-t-code-runFirstPhase",
    );
    expect(folded.textContent).toContain("+3");
    expect(folded.querySelector("title")!.textContent).toContain("→ failed");
    expect(within(first).queryAllByTestId(/^machine-exit-/)).toHaveLength(0);
    // Hovering the box reveals them all; leaving folds them again.
    fireEvent.mouseEnter(first);
    expect(within(first).queryAllByTestId(/^machine-exit-/)).toHaveLength(3);
    expect(
      within(first).queryByTestId("machine-exits-folded-t-code-runFirstPhase"),
    ).toBeNull();
    fireEvent.mouseLeave(first);
    expect(within(first).queryAllByTestId(/^machine-exit-/)).toHaveLength(0);
    // An exit into working state stays a label; the one into failed
    // beside it folds to "+1".
    const review = within(code).getByTestId(
      "machine-state-t-code-reviewFirstCommit",
    );
    const labels = within(review).getAllByTestId(/^machine-exit-/);
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toContain("→ run ir task");
    expect(
      within(review).getByTestId("machine-exits-folded-t-code-reviewFirstCommit")
        .textContent,
    ).toContain("+1");
  });

  test("the split's row form is a query on its wrapper, never on itself", () => {
    // An element cannot answer its own container query (run-view-107):
    // the wrapper is the container, the flex box asks it.
    renderRun(MACHINE_RUN.slice(0, 13));
    const split = screen.getByTestId("captain-column").parentElement!;
    expect(split.className).toContain("@2xl:flex-row");
    expect(split.className).not.toContain("@container");
    expect(split.parentElement!.className).toContain("@container");
  });

  test("the drawing scales into a pane it exceeds by under a quarter, else scrolls", () => {
    renderRun(MACHINE_RUN.slice(0, 13));
    const scroller = screen.getByTestId("machine-scroll-t-code");
    const svg = scroller.querySelector("svg")!;
    const natural = Number(svg.getAttribute("data-natural-width"));
    const floor = Number(svg.getAttribute("data-scale-floor"));
    expect(natural).toBeGreaterThan(0);
    expect(floor).toBeCloseTo(natural / 1.25, 0);
    // The rule rides the card as a container query: the pane's width
    // decides between the drawing's natural width and the pane's.
    expect(scroller.style.getPropertyValue("--fit")).toContain("100cqw");
    expect(scroller.style.getPropertyValue("--fit")).toContain(`${floor}px`);
    expect(scroller.className).toContain("var(--beyond");
    expect(screen.getByTestId("machine-card-t-code").className).toContain(
      "@container",
    );
  });

  // run-view-81: the fade is a fact about the box as much as about the
  // scroll position, so a pane that narrows behind more drawing brings
  // it back with no scroll of the reader's own.
  test("a drawing read to its end regains its fade when the pane narrows", () => {
    const observers = observeResizes();
    renderRun(MACHINE_RUN.slice(0, 13));
    const scroller = screen.getByTestId("machine-scroll-t-code");
    const geometry = { clientWidth: 600, scrollWidth: 1400, scrollLeft: 0 };
    for (const key of Object.keys(geometry) as (keyof typeof geometry)[]) {
      Object.defineProperty(scroller, key, {
        configurable: true,
        get: () => geometry[key],
      });
    }
    // Scrolled to the end, the fade retires: nothing lies beyond.
    geometry.scrollLeft = 800;
    fireEvent.scroll(scroller);
    expect(scroller.style.maskImage).toBe("none");
    // The pane narrows — no scroll event — and 220px of drawing are
    // hidden again, so the fade returns.
    geometry.clientWidth = 380;
    act(() => observers.fire(scroller));
    expect(scroller.style.maskImage).toBe("");
  });
});

describe("run-view-81: the divider lands under the pointer", () => {
  test("the split is read against the box the share resolves against", () => {
    renderRun(MACHINE_RUN.slice(0, 13));
    const divider = screen.getByTestId("captain-divider");
    const container = screen.getByTestId("captain-column").parentElement!;
    // The container's padding and its gap are the offsets the share
    // is carried by; a simulated document reports only what is set.
    container.style.paddingLeft = "12px";
    container.style.paddingRight = "12px";
    container.style.columnGap = "12px";
    container.getBoundingClientRect = () =>
      ({
        left: 0,
        right: 1200,
        width: 1200,
        top: 0,
        bottom: 800,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    divider.setPointerCapture = () => {};
    divider.releasePointerCapture = () => {};

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 600 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 600 });
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 600 });

    const percent = parseFloat(
      screen
        .getByTestId("captain-column")
        .style.getPropertyValue("--captain-split"),
    );
    // The rule sits at the column's trailing edge plus the gap; that
    // place is where the pointer was, not 24px past it. The stored
    // share is rounded, so the rule lands within a pixel of the hand.
    const content = 1200 - 12 - 12;
    const rule = 12 + (percent / 100) * content + 12;
    expect(Math.abs(rule - 600)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Intent ledger coverage (run-view-92..96, DR-035): the composer's
// queue-instead capture, the staged chip, the delivery card with
// confirm-pulls-next, and attention activation landing at the
// intent's place.
// ---------------------------------------------------------------------------

function makeIntent(over: Partial<IntentInfo> & { id: string }): IntentInfo {
  return {
    projectId: "p1",
    text: "Address #7: fix the login bug\nfull context for the run",
    rank: "m",
    createdAt: 0,
    ...over,
  };
}

const EMPTY_LEDGER: LedgerState = { intents: [], attention: [], badge: 0 };

/** The turn-1 intent, finished and awaiting its verdict. */
const FINISHED: DerivedIntent = {
  intent: makeIntent({
    id: "i1",
    source: {
      kind: "issue",
      ref: "7",
      url: "https://github.com/acme/demo/issues/7",
    },
    dispatched: { sessionId: "s1", turnId: 1, at: 1000 },
  }),
  state: "finished",
  stats: { reviewRounds: 2, turns: 1, elapsedMs: 12 * 60_000 },
};

const QUEUED_NEXT: DerivedIntent = {
  intent: makeIntent({ id: "i2", text: "Review PR 45: tighten the docs" }),
  state: "queued",
};

function seedLedger(ledger: LedgerState): void {
  useAppStore.setState({ ledger });
}

function renderRunWith(
  entries: typeof FULL_RUN,
  over: Partial<Parameters<typeof RunView>[0]> = {},
) {
  const view = applyRecords(initialSessionView(PLAYERS), entries);
  return render(
    <RunView
      session={SESSION}
      view={view}
      composer={{ queued: [] }}
      connected
      onSubmit={async () => {}}
      onAbort={() => {}}
      onRemoveQueued={() => {}}
      onDismissError={() => {}}
      {...over}
    />,
  );
}

describe("run-view-92: queue instead of send captures a chat intent", () => {
  const command = vi.fn();

  beforeEach(() => {
    command.mockReset();
    command.mockImplementation(async (type: string) => {
      if (type === "intent.queue") return makeIntent({ id: "chat-1" });
      if (type === "ledger.get") return EMPTY_LEDGER;
      return {};
    });
    setClientForTests({ command } as never);
  });

  afterEach(() => {
    useAppStore.setState({ ledger: undefined, stagedIntents: {} });
    setClientForTests(undefined);
  });

  test("the typed text queues with chat provenance, nothing sends", async () => {
    const onSubmit = vi.fn(async () => {});
    renderRunWith(TURN_ONE, { onSubmit });

    fireEvent.change(screen.getByTestId("boss-composer"), {
      target: { value: "also fix the logout flow later" },
    });
    fireEvent.click(screen.getByTestId("queue-intent-button"));

    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledWith("intent.queue", {
        projectId: "p1",
        text: "also fix the logout flow later",
        source: { kind: "chat", ref: "s1" },
      }),
    );
    // Shelved, not sent (run-view-85): no dispatch, no queued bubble.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalledWith(
      "turn.submit",
      expect.anything(),
    );
    expect(screen.queryByTestId("queue-indicator")).toBeNull();
    // The inline acknowledgment names where the row landed.
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("queued-intent-note").textContent,
      ).toContain("Up next"),
    );
    // The draft cleared: the text lives in the queue now.
    expect(
      (screen.getByTestId("boss-composer") as HTMLTextAreaElement).value,
    ).toBe("");
  });
});

describe("run-view-93: the staged chip governs what a send stamps", () => {
  afterEach(() => {
    useAppStore.setState({ ledger: undefined, stagedIntents: {} });
    setClientForTests(undefined);
  });

  test("the composer wears the staged chip; emptying detaches it", () => {
    useAppStore.setState({
      stagedIntents: {
        s1: { intentId: "i1", title: "Address #7: fix the login bug" },
      },
    });
    renderRunWith(TURN_ONE);
    const chip = screen.getByTestId("staged-intent-chip");
    expect(chip.textContent).toContain("Address #7: fix the login bug");

    const composer = screen.getByTestId("boss-composer");
    fireEvent.change(composer, { target: { value: "extra context" } });
    expect(screen.getByTestId("staged-intent-chip")).toBeTruthy();
    fireEvent.change(composer, { target: { value: "" } });
    // Emptying the composer detaches the intent (run-view-86): the
    // chip leaves and the store drops the staging.
    expect(useAppStore.getState().stagedIntents.s1).toBeUndefined();
    expect(screen.queryByTestId("staged-intent-chip")).toBeNull();
  });

  test("a queued submission carries the chip on its pending bubble", () => {
    const view = applyRecords(initialSessionView(PLAYERS), [
      {
        seq: 1,
        record: {
          type: "turn_started",
          turnId: 9,
          timestamp: 1,
          turn: { id: 9, prompt: "go", timestamp: 1 },
        },
      } as (typeof TURN_ONE)[number],
    ]);
    render(
      <RunView
        session={SESSION}
        view={view}
        composer={{ queued: [{ text: "start the next one", intentId: "i1" }] }}
        connected
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />,
    );
    const queue = screen.getByTestId("queue-indicator");
    expect(within(queue).getByTestId("queued-intent-chip")).toBeTruthy();
    expect(queue.textContent).toContain("sends when this turn ends");
  });
});

describe("run-view-90/89: the working line and the bound turn's chip", () => {
  afterEach(() => {
    useAppStore.setState({ ledger: undefined, stagedIntents: {} });
  });

  test("an open dispatched intent names itself above the composer", () => {
    seedLedger({
      intents: [
        {
          intent: makeIntent({
            id: "i1",
            dispatched: { sessionId: "s1", turnId: 9, at: 1 },
          }),
          state: "working",
        },
      ],
      attention: [],
      badge: 0,
    });
    renderRunWith(TURN_ONLY_STARTED as typeof FULL_RUN);
    const line = screen.getByTestId("working-line");
    expect(line.textContent).toContain("Working:");
    expect(line.textContent).toContain("Address #7: fix the login bug");
    // Hover is never the only channel, but the raw text rides along.
    expect(line.title).toContain("full context for the run");
  });

  test("the newest open intent owns the line; the bubble wears the chip", () => {
    seedLedger({
      intents: [
        {
          intent: makeIntent({
            id: "i-old",
            text: "the older intent",
            dispatched: { sessionId: "s1", turnId: 1, at: 1 },
          }),
          state: "interrupted",
          reason: "question",
        },
        {
          intent: makeIntent({
            id: "i-new",
            text: "the newest intent",
            source: { kind: "chat", ref: "s1" },
            dispatched: { sessionId: "s1", turnId: 2, at: 2 },
          }),
          state: "working",
        },
      ],
      attention: [],
      badge: 0,
    });
    renderRunWith([...TURN_ONE, ...TURN_TWO_QUESTION]);
    expect(screen.getByTestId("working-line").textContent).toContain(
      "the newest intent",
    );
    // The bound turn's Boss bubble wears the source chip (run-view-89);
    // an unsourced intent's bubble wears none.
    const bubbles = screen.getAllByTestId("boss-bubble");
    expect(within(bubbles[1]).getByTestId("intent-source-chip").textContent)
      .toBe("chat");
    expect(within(bubbles[0]).queryByTestId("intent-source-chip")).toBeNull();
  });

  test("Drop asks the inline confirm, closes the intent dropped, and hands focus on (run-view-113)", async () => {
    const command = vi.fn(async (type: string) => {
      // The fold re-derives without the dropped intent.
      if (type === "ledger.get") return { intents: [], attention: [], badge: 0 };
      return {};
    });
    setClientForTests({ command, subscribe: vi.fn(async () => {}) } as never);
    seedLedger({
      intents: [
        {
          intent: makeIntent({
            id: "i1",
            dispatched: { sessionId: "s1", turnId: 9, at: 1 },
          }),
          state: "working",
        },
      ],
      attention: [],
      badge: 0,
    });
    renderRunWith(TURN_ONLY_STARTED as typeof FULL_RUN);
    const drop = screen.getByTestId("working-drop");
    expect(drop.textContent).toBe("Drop");
    // Work is underway: the confirm names the act, its safe default
    // focused; Keep backs out to the control (DR-010 §4, §6).
    fireEvent.click(drop);
    const keep = screen.getByRole("button", { name: "Keep" });
    expect(document.activeElement).toBe(keep);
    expect(command).not.toHaveBeenCalledWith("intent.close", expect.anything());
    fireEvent.click(keep);
    expect(screen.getByTestId("working-line")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("working-drop"));

    fireEvent.click(screen.getByTestId("working-drop"));
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledWith("intent.close", {
        intentId: "i1",
        as: "dropped",
      }),
    );
    // The line leaves with its control, the outcome announces where it
    // stood, and focus lands in the composer — never on the body.
    await vi.waitFor(() =>
      expect(screen.queryByTestId("working-line")).toBeNull(),
    );
    const note = screen.getByTestId("working-note");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("Dropped “Address #7: fix the login bug”");
    expect(document.activeElement).toBe(screen.getByTestId("boss-composer"));
    setClientForTests(undefined);
  });

  test("a refused drop keeps the line, names the refusal, and returns to the control", async () => {
    const command = vi.fn(async (type: string) => {
      if (type === "intent.close") throw new Error("the intent is already closed");
      return {};
    });
    setClientForTests({ command, subscribe: vi.fn(async () => {}) } as never);
    seedLedger({
      intents: [
        {
          intent: makeIntent({
            id: "i1",
            dispatched: { sessionId: "s1", turnId: 9, at: 1 },
          }),
          state: "working",
        },
      ],
      attention: [],
      badge: 0,
    });
    renderRunWith(TURN_ONLY_STARTED as typeof FULL_RUN);
    fireEvent.click(screen.getByTestId("working-drop"));
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    await vi.waitFor(() =>
      expect(screen.getByTestId("working-note").textContent).toContain(
        "Couldn't drop “Address #7: fix the login bug”: the intent is already closed",
      ),
    );
    expect(screen.getByTestId("working-line")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("working-drop"));
    setClientForTests(undefined);
  });
});

describe("run-view-94/87: the delivery card and confirm-pulls-next", () => {
  const command = vi.fn();
  let servedLedger: LedgerState;

  beforeEach(() => {
    servedLedger = { intents: [FINISHED, QUEUED_NEXT], attention: [], badge: 1 };
    command.mockReset();
    command.mockImplementation(async (type: string) => {
      if (type === "ledger.get") return servedLedger;
      if (type === "intent.queue") return makeIntent({ id: "i3" });
      return {};
    });
    setClientForTests({ command, subscribe: vi.fn(async () => {}) } as never);
    useAppStore.setState({
      ledger: { intents: [FINISHED, QUEUED_NEXT], attention: [], badge: 1 },
      sessions: [],
      stagedIntents: {},
    });
  });

  afterEach(() => {
    useAppStore.setState({
      ledger: undefined,
      stagedIntents: {},
      sessions: [],
      homeDraft: "",
    });
    setClientForTests(undefined);
  });

  test("a trailing line repeating the source URL leaves the bubble", () => {
    const url = "https://github.com/acme/demo/issues/7";
    const withUrl = TURN_ONE.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            record: {
              ...(entry.record as unknown as Record<string, unknown>),
              turn: { id: 1, prompt: `Address #7: fix login\n${url}` },
            } as unknown as TmuxPlayRecord,
          }
        : entry,
    );
    renderRunWith(withUrl);
    const bubble = screen.getByTestId("boss-bubble");
    expect(bubble.textContent).toContain("Address #7: fix login");
    expect(bubble.textContent).not.toContain(url);
    expect(within(bubble).getByTestId("intent-source-chip").getAttribute("href")).toBe(url);
  });

  test("the bound bubble wears the source chip as a canonical link", () => {
    renderRunWith(TURN_ONE);
    const bubble = screen.getByTestId("boss-bubble");
    const chip = within(bubble).getByTestId("intent-source-chip");
    expect(chip.textContent).toBe("#7");
    expect(chip.tagName).toBe("A");
    expect(chip.getAttribute("href")).toBe(
      "https://github.com/acme/demo/issues/7",
    );
    // Raw provenance lives in the tooltip (DR-010 §2).
    expect(chip.getAttribute("title")).toContain("issue 7");
  });

  test("the card carries title, chip, stats, verdicts, and the note", () => {
    renderRunWith(TURN_ONE);
    const card = screen.getByTestId("delivery-card-i1");
    expect(card.getAttribute("data-settled")).toBe("0");
    expect(card.textContent).toContain("Address #7: fix the login bug");
    expect(within(card).getByTestId("intent-source-chip").textContent).toBe(
      "#7",
    );
    // Review rounds foremost, then turns, then elapsed (run-view-87).
    expect(within(card).getByTestId("delivery-stats").textContent).toBe(
      "2 review rounds · 1 turn · 12m",
    );
    expect(within(card).getByTestId("delivery-confirm").textContent).toBe(
      "Confirm",
    );
    expect(within(card).getByTestId("delivery-drop").textContent).toBe(
      "Drop",
    );
    expect(card.textContent).toContain(
      "A follow-up message continues this intent.",
    );
  });

  test("a verdict closes over the protocol and resolves into Up next", async () => {
    renderRunWith(TURN_ONE);
    // The verdict re-derives the fold without the closed intent.
    servedLedger = { intents: [QUEUED_NEXT], attention: [], badge: 0 };

    const confirm = screen.getByTestId(
      "delivery-confirm",
    ) as HTMLButtonElement;
    fireEvent.click(confirm);
    // The action acknowledges in place (DR-010): busy until it lands.
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain("Confirming…");

    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledWith("intent.close", {
        intentId: "i1",
        as: "done",
      }),
    );
    // The card resolves in place into the project's next queued
    // unblocked intent with Start (run-view-87).
    await vi.waitFor(() => {
      const card = screen.getByTestId("delivery-card-i1");
      expect(card.getAttribute("data-settled")).toBe("1");
      expect(card.textContent).toContain("Review PR 45: tighten the docs");
    });

    // Start stages the dispatch — no live session here, so it stages
    // the Captain home (run-view-86).
    fireEvent.click(screen.getByTestId("upnext-start"));
    await vi.waitFor(() => {
      expect(useAppStore.getState().stagedIntents.home?.intentId).toBe("i2");
      expect(useAppStore.getState().homeDraft).toBe(
        "Review PR 45: tighten the docs",
      );
    });
  });

  test("an empty queue resolves into the inline add affordance", async () => {
    useAppStore.setState({
      ledger: { intents: [FINISHED], attention: [], badge: 1 },
    });
    servedLedger = EMPTY_LEDGER;
    renderRunWith(TURN_ONE);

    fireEvent.click(screen.getByTestId("delivery-drop"));
    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledWith("intent.close", {
        intentId: "i1",
        as: "dropped",
      }),
    );
    const input = await vi.waitFor(() =>
      screen.getByTestId("upnext-add-input"),
    );
    fireEvent.change(input, { target: { value: "polish the changelog" } });
    fireEvent.click(screen.getByTestId("upnext-add"));
    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledWith("intent.queue", {
        projectId: "p1",
        text: "polish the changelog",
      }),
    );
  });

  test("an ended session's replay renders the card inert", () => {
    renderRunWith(TURN_ONE, {
      session: { ...SESSION, live: false, endedAt: 5 },
      readOnly: true,
      onStartNew: () => {},
    });
    const card = screen.getByTestId("delivery-card-i1");
    expect(card.textContent).toContain("Address #7: fix the login bug");
    expect(
      (within(card).getByTestId("delivery-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(card).getByTestId("delivery-drop") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // And an ended lane shows no working line.
    expect(screen.queryByTestId("working-line")).toBeNull();
  });
});

describe("run-view-96/91: attention activation lands at the place", () => {
  afterEach(() => {
    useAppStore.setState({ ledger: undefined, stagedIntents: {} });
  });

  test("a pending question focuses the question bubble", () => {
    const onFocusHandled = vi.fn();
    renderRunWith([...TURN_ONE, ...TURN_TWO_QUESTION], {
      focusTurn: 2,
      onFocusHandled,
    });
    const wrapper = screen
      .getByTestId("question-bubble")
      .closest("[data-focus-key]");
    expect(wrapper?.getAttribute("data-focused")).toBe("1");
    expect(onFocusHandled).toHaveBeenCalled();
  });

  test("an unacknowledged failure focuses the failure line", () => {
    const TURN_FAILED = [
      {
        seq: 1,
        record: {
          type: "turn_started",
          turnId: 5,
          timestamp: 1,
          turn: { id: 5, prompt: "go", timestamp: 1 },
        },
      },
      {
        seq: 2,
        record: {
          type: "runtime_error",
          turnId: 5,
          timestamp: 2,
          message: "the coder crashed",
        },
      },
      {
        seq: 3,
        record: { type: "turn_finished", turnId: 5, timestamp: 3 },
      },
    ] as typeof FULL_RUN;
    renderRunWith(TURN_FAILED, { focusTurn: 5 });
    const wrapper = screen
      .getByText("the coder crashed")
      .closest("[data-focus-key]");
    expect(wrapper?.getAttribute("data-focused")).toBe("1");
  });

  test("a finish awaiting its verdict focuses the delivery card", async () => {
    useAppStore.setState({
      ledger: { intents: [FINISHED], attention: [], badge: 1 },
    });
    const onFocusHandled = vi.fn();
    const { container } = renderRunWith(TURN_ONE, {
      focusTurn: 1,
      onFocusHandled,
    });
    await vi.waitFor(() => {
      const wrapper = container.querySelector('[data-focus-key="card-i1"]');
      expect(wrapper?.getAttribute("data-focused")).toBe("1");
    });
    expect(onFocusHandled).toHaveBeenCalled();
  });
});

describe("run-view-25, DR-038: the player label wears the fast-mode mark", () => {
  test("a fast-mode player shows the lightning; the other lane does not", () => {
    const view = applyRecords(initialSessionView(PLAYERS), TURN_ONE);
    render(
      <RunView
        session={{
          ...SESSION,
          players: [{ ...PLAYERS[0], fastMode: true }, PLAYERS[1]],
        }}
        view={view}
        composer={{ queued: [] }}
        connected
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />,
    );
    const coder = screen.getByTestId("player-pane-dev.coder");
    expect(within(coder).getByTestId("player-fast-mode").title).toBe(
      "fast mode",
    );
    expect(
      within(screen.getByTestId("player-pane-dev.reviewer")).queryByTestId(
        "player-fast-mode",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session view craft (run-view-2/8/38/50/83/85/87): labels that say
// what happens, every state in more than color, links that leave the
// page instead of replacing it, and focus that is never stranded.
// ---------------------------------------------------------------------------

describe("run-view-8/38: the composer says what a send does mid-turn", () => {
  test("the primary control, the placeholder, and the caption agree", () => {
    const view = applyRecords(initialSessionView(PLAYERS), TURN_ONLY_STARTED);
    render(
      <RunView
        session={SESSION}
        view={view}
        composer={{ queued: [{ text: "and the changelog" }] }}
        connected
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />,
    );
    // The busy form stays within the label budget (DR-041); the
    // sentence rides the tooltip ahead of the keys.
    const send = screen.getByRole("button", { name: "Send next" });
    expect(send.title).toBe(
      "Sends when this turn ends · Enter to send · Shift+Enter for a new line",
    );
    expect(
      screen.getByTestId("boss-composer").getAttribute("placeholder"),
    ).toBe("Sends after this turn…");
    expect(screen.getByTestId("queue-indicator").textContent).toContain(
      "sends when this turn ends",
    );
    // Abort stands beside the primary in the action row, which wraps.
    const row = screen.getByTestId("abort-button").parentElement!;
    expect(row.textContent).toBe("AbortSend next");
    expect(row.parentElement?.className).toContain("flex-wrap");
    // The remove control is a real hit target (run-view-50).
    const remove = screen.getByRole("button", {
      name: "Remove this queued message",
    });
    expect(remove.className).toContain("h-6 w-6");
    expect(remove.title).toBe("Remove this message");
  });

  test("idle, the control reads Send", () => {
    renderRun(TURN_ONE);
    expect(screen.getByRole("button", { name: "Send" }).title).toBe(
      "Enter to send · Shift+Enter for a new line",
    );
  });

  // run-view-106 (DR-041): the composer's shape — a one-row field
  // with no native grip, the caption line under it, placeholders
  // within 24 characters.
  test("the field is one growing row and the caption carries the hint", () => {
    renderRun(TURN_ONE);
    const box = screen.getByTestId("boss-composer") as HTMLTextAreaElement;
    expect(box.rows).toBe(1);
    expect(box.className).toContain("resize-none");
    expect(box.placeholder.length).toBeLessThanOrEqual(24);
    expect(screen.getByTestId("composer-caption").textContent).toBe(
      "/ for playbooks · Enter sends",
    );
  });

  test("a waiting question names the player in the placeholder", () => {
    const view = applyRecords(initialSessionView(PLAYERS), TURN_ONLY_STARTED);
    render(
      <RunView
        session={SESSION}
        view={{ ...view, pendingQuestion: "Migrate?", pendingQuestionPlayer: "coder" }}
        composer={{ queued: [] }}
        connected
        onSubmit={async () => {}}
        onAbort={() => {}}
        onRemoveQueued={() => {}}
        onDismissError={() => {}}
      />,
    );
    const box = screen.getByTestId("boss-composer") as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Reply to coder…");
  });

  test("the staged chip names the task and its control speaks plainly", () => {
    useAppStore.setState({
      stagedIntents: { s1: { intentId: "i1", title: "Address #7" } },
    });
    renderRunWith(TURN_ONE);
    expect(screen.getByTestId("staged-intent-chip").textContent).toContain(
      "Starting: Address #7",
    );
    const detach = screen.getByRole("button", {
      name: "Take the task out of the message",
    });
    expect(detach.className).toContain("h-6 w-6");
    useAppStore.setState({ stagedIntents: {} });
  });
});

describe("run-view-85: Add to Up next says where the text goes", () => {
  afterEach(() => {
    useAppStore.setState({ ledger: undefined, stagedIntents: {} });
    setClientForTests(undefined);
  });

  test("the control and its note both name Up next", async () => {
    const command = vi.fn(async (type: string) =>
      type === "intent.queue"
        ? makeIntent({ id: "chat-2" })
        : type === "ledger.get"
          ? EMPTY_LEDGER
          : {},
    );
    setClientForTests({ command } as never);
    renderRunWith(TURN_ONE);
    const add = screen.getByRole("button", { name: "Add to Up next" });
    expect(add.title).toBe(
      "Add this to the project's Up next without sending it",
    );
    fireEvent.change(screen.getByTestId("boss-composer"), {
      target: { value: "tidy the docs" },
    });
    fireEvent.click(add);
    await vi.waitFor(() =>
      expect(screen.getByTestId("queued-intent-note").textContent).toBe(
        "Added to Up next — see the project's Overview.",
      ),
    );
  });
});

const TURN_FAILING = [
  {
    seq: 1,
    record: {
      type: "turn_started",
      turnId: 5,
      timestamp: 1,
      turn: { id: 5, prompt: "go", timestamp: 1 },
    },
  },
  {
    seq: 2,
    record: {
      type: "runtime_error",
      turnId: 5,
      timestamp: 2,
      message: "the coder crashed",
    },
  },
  {
    seq: 3,
    record: {
      type: "runtime_error",
      turnId: 5,
      timestamp: 3,
      message: "the coder crashed",
    },
  },
  {
    seq: 4,
    record: {
      type: "runtime_error",
      turnId: 5,
      timestamp: 4,
      message: "disk full",
    },
  },
  { seq: 5, record: { type: "turn_finished", turnId: 5, timestamp: 5 } },
] as typeof FULL_RUN;

describe("run-view-2: failure lines fold, and point at the remedy", () => {
  test("a failure line speaks plain with the runtime's words in its tooltip", () => {
    renderRunWith([
      ...TURN_ONLY_STARTED,
      {
        seq: 2,
        record: {
          type: "runtime_error",
          turnId: 9,
          timestamp: 2,
          message: "Error: Claude Code process exited with code 1",
        } as unknown as TmuxPlayRecord,
      },
    ]);
    const text = screen.getByTestId("failure-text");
    expect(text.textContent).toBe("The agent process exited unexpectedly (1)");
    expect(text.title).toBe("Error: Claude Code process exited with code 1");
  });

  test("a repeat counts, and the not-ready hint links to Settings", () => {
    const onOpenSettings = vi.fn();
    renderRunWith(TURN_FAILING, {
      readinessHint: {
        requirement: "ANTHROPIC_API_KEY is not set",
        onOpenSettings,
      },
    });
    const lines = screen.getAllByTestId("failure-line");
    expect(lines).toHaveLength(2);
    expect(within(lines[0]).getByTestId("failure-count").textContent).toContain(
      "×2",
    );
    expect(within(lines[1]).queryByTestId("failure-count")).toBeNull();
    const link = within(lines[0]).getByRole("button", {
      name: "Check agent readiness",
    });
    expect(link.title).toBe("ANTHROPIC_API_KEY is not set");
    fireEvent.click(link);
    expect(onOpenSettings).toHaveBeenCalled();
  });

  test("no hint without the not-ready report, and none in a replay", () => {
    const { unmount } = renderRunWith(TURN_FAILING);
    expect(screen.queryByTestId("failure-readiness-link")).toBeNull();
    unmount();
    renderRunWith(TURN_FAILING, {
      readinessHint: { onOpenSettings: vi.fn() },
      session: { ...SESSION, live: false, endedAt: 5 },
      readOnly: true,
      onStartNew: () => {},
    });
    expect(screen.queryByTestId("failure-readiness-link")).toBeNull();
  });
});

const TOOL_FATES = [
  ...TURN_ONE.slice(0, 4),
  {
    seq: 5,
    record: {
      type: "player_event",
      turnId: 1,
      timestamp: 5,
      playerId: "dev.coder",
      event: {
        type: "tool_use",
        payload: { toolName: "Bash", toolUseId: "tu9", input: "rm -rf build" },
      },
    },
  },
  {
    seq: 6,
    record: {
      type: "player_event",
      turnId: 1,
      timestamp: 6,
      playerId: "dev.coder",
      event: {
        type: "tool_result",
        payload: { toolUseId: "tu9", status: "error", output: "exit 1" },
      },
    },
  },
  {
    seq: 7,
    record: {
      type: "player_event",
      turnId: 1,
      timestamp: 7,
      playerId: "dev.coder",
      event: {
        type: "tool_use",
        payload: { toolName: "Write", toolUseId: "tu10", input: { path: "x" } },
      },
    },
  },
  {
    seq: 8,
    record: {
      type: "player_event",
      turnId: 1,
      timestamp: 8,
      playerId: "dev.coder",
      event: {
        type: "tool_result",
        payload: { toolUseId: "tu10", status: "denied" },
      },
    },
  },
] as typeof FULL_RUN;

describe("run-view-50: color is never the only channel in a player pane", () => {
  test("tool cards say how they ended, and the running mark says running", () => {
    renderRun(TOOL_FATES);
    // The prompt landed and no result yet: the lane runs, in words.
    const running = screen.getByTestId("player-running");
    expect(running.getAttribute("data-running")).toBe("true");
    expect(running.textContent).toBe("running");

    const status = (tool: string) =>
      within(screen.getByText(tool).closest("summary")!).getByTestId(
        /^tool-status-/,
      );
    expect(status("Bash").textContent).toBe("✗failed");
    expect(status("Write").textContent).toBe("✗denied");
  });

  test("a call that succeeded wears the ok mark", () => {
    renderRun(TURN_ONE);
    const edit = screen.getByText("Edit").closest("summary")!;
    expect(within(edit).getByTestId(/^tool-status-/).textContent).toBe("✓ok");
  });
});

describe("run-view-83/87: links leave the page, never replace it", () => {
  afterEach(() => {
    useAppStore.setState({ ledger: undefined });
  });

  test("a transcript's web link and the source chip open a new tab without a referrer", () => {
    useAppStore.setState({
      ledger: { intents: [FINISHED], attention: [], badge: 1 },
    });
    renderRunWith(TURN_ONE);
    const link = screen.getByText("the SDK docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    const chip = within(screen.getByTestId("boss-bubble")).getByTestId(
      "intent-source-chip",
    );
    expect(chip.getAttribute("target")).toBe("_blank");
    expect(chip.getAttribute("rel")).toBe("noreferrer");
  });
});

describe("run-view-50: focus is never stranded", () => {
  test("abort keeps focus in the composer", () => {
    renderRun(TURN_ONLY_STARTED);
    const abort = screen.getByTestId("abort-button");
    abort.focus();
    fireEvent.click(abort);
    expect(document.activeElement).toBe(screen.getByTestId("boss-composer"));
  });

  test("backing out of the end confirm returns to its control", () => {
    renderRunWith(TURN_ONE, { onEnd: () => {} });
    fireEvent.click(screen.getByTestId("end-session"));
    const keep = screen.getByRole("button", { name: "Keep" });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    expect(document.activeElement).toBe(screen.getByTestId("end-session"));
  });
});

describe("run-view-7: a roster with no players", () => {
  test("renders the Captain column alone, with no divider and no player grid", () => {
    renderRunWith(FULL_RUN, {
      session: { ...SESSION, players: [] },
      readOnly: true,
    });
    expect(screen.getByTestId("captain-pane")).toBeTruthy();
    expect(screen.queryByTestId("player-grid")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("captain-column").className).toContain("max-w-2xl");
  });

  test("keeps the divider and the grid while any lane is bound", () => {
    renderRunWith(FULL_RUN, { readOnly: true });
    expect(screen.getByTestId("player-grid")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
  });
});

describe("run-view-4: a runner's shell wrapper", () => {
  test("the inner command is the subject and the wire name reads shell", () => {
    expect(unwrapShell(`/bin/zsh -lc "rg --files -g '!specs/**' | sort"`)).toBe(
      "rg --files -g '!specs/**' | sort",
    );
    expect(unwrapShell("/bin/zsh -lc 'cat guidelines.md | head -120'")).toBe(
      "cat guidelines.md | head -120",
    );
    expect(unwrapShell("bash -c ls")).toBe("ls");
    expect(unwrapShell("ls -la")).toBe("ls -la");
    expect(toolLabel("command_execution")).toBe("shell");
    expect(toolLabel("Bash")).toBe("Bash");
  });
});

describe("run-view-116/117: a lane folds to a rail and returns for its call", () => {
  beforeEach(() => {
    useAppStore.setState({ collapsedLanes: {} });
  });

  test("the header's control folds the pane to a rail, focus handed on", () => {
    renderRun(TURN_ONE);
    fireEvent.click(screen.getByRole("button", { name: "Collapse dev.reviewer" }));
    const rail = screen.getByTestId("player-pane-dev.reviewer");
    expect(rail.dataset.collapsed).toBe("true");
    // A narrow column exempt from the pane floor, naming the lane and
    // offering the way back; the other lane keeps its floor and the
    // slack (run-view-116).
    expect(rail.className).toContain("w-9");
    expect(rail.className).not.toContain("min-w-[280px]");
    const name = within(rail).getByTestId("player-name-dev.reviewer");
    expect(name.textContent).toBe("dev.reviewer");
    expect(name.className).toContain("writing-mode:vertical-rl");
    expect(name.className).toContain("text-ellipsis");
    expect(within(rail).queryByTestId("player-running")).toBeNull();
    const expand = within(rail).getByRole("button", { name: "Expand dev.reviewer" });
    expect(document.activeElement).toBe(expand);
    expect(screen.getByTestId("player-pane-dev.coder").className).toContain(
      "min-w-[280px]",
    );
    expect(useAppStore.getState().collapsedLanes.s1).toEqual(["dev.reviewer"]);

    fireEvent.click(expand);
    const pane = screen.getByTestId("player-pane-dev.reviewer");
    expect(pane.dataset.collapsed).toBeUndefined();
    expect(document.activeElement).toBe(
      within(pane).getByRole("button", { name: "Collapse dev.reviewer" }),
    );
    expect(useAppStore.getState().collapsedLanes.s1).toEqual([]);
  });

  test("the rail wears the running mark while the lane's call is open", () => {
    render(
      <PlayerPane
        view={{ id: "dev.reviewer", running: true, segments: [] }}
        collapsed
      />,
    );
    const rail = screen.getByTestId("player-pane-dev.reviewer");
    expect(within(rail).getByTestId("player-running").dataset.running).toBe("true");
  });

  /** The reviewer's call opens (run-view-117): the record that turns
   * its lane running, delivered as the client would, then the view
   * the fold produced. */
  function openReviewerCall(idle: ReturnType<typeof applyRecords>) {
    act(() => {
      deliverServerMessageForTests({
        type: "record",
        channel: "session",
        sessionId: "s1",
        seq: 90,
        record: {
          type: "player_prompt",
          turnId: 2,
          timestamp: Date.now(),
          playerId: "dev.reviewer",
          prompt: "Review the change",
        },
      });
    });
    return {
      ...idle,
      players: {
        ...idle.players,
        "dev.reviewer": { ...idle.players["dev.reviewer"], running: true },
      },
    };
  }

  test("a collapsed lane opens itself when its call opens, per session", () => {
    useAppStore.setState({
      collapsedLanes: { s1: ["dev.reviewer"], s2: ["dev.reviewer"] },
    });
    const idle = applyRecords(initialSessionView(PLAYERS), TURN_ONE);
    const props = {
      session: SESSION,
      composer: { queued: [] },
      connected: true,
      onSubmit: async () => {},
      onAbort: () => {},
      onRemoveQueued: () => {},
      onDismissError: () => {},
    };
    const { rerender } = render(<RunView {...props} view={idle} />);
    expect(screen.getByTestId("player-pane-dev.reviewer").dataset.collapsed).toBe(
      "true",
    );
    rerender(<RunView {...props} view={openReviewerCall(idle)} />);
    const pane = screen.getByTestId("player-pane-dev.reviewer");
    expect(pane.dataset.collapsed).toBeUndefined();
    const collapse = within(pane).getByRole("button", { name: "Collapse dev.reviewer" });
    // The other session's set stands; the reader's focus — in the
    // composer, where the view put it — was not taken (run-view-117).
    expect(useAppStore.getState().collapsedLanes).toEqual({
      s1: [],
      s2: ["dev.reviewer"],
    });
    expect(document.activeElement).not.toBe(collapse);
    // Folding a lane whose call is already open stands: only the
    // call's opening unfolds it.
    fireEvent.click(collapse);
    expect(screen.getByTestId("player-pane-dev.reviewer").dataset.collapsed).toBe(
      "true",
    );
    expect(useAppStore.getState().collapsedLanes.s1).toEqual(["dev.reviewer"]);
  });

  test("a self-opening lane carries focus from the rail's control it removes", () => {
    useAppStore.setState({ collapsedLanes: { s1: ["dev.reviewer"] } });
    const idle = applyRecords(initialSessionView(PLAYERS), TURN_ONE);
    const props = {
      session: SESSION,
      composer: { queued: [] },
      connected: true,
      onSubmit: async () => {},
      onAbort: () => {},
      onRemoveQueued: () => {},
      onDismissError: () => {},
    };
    const { rerender } = render(<RunView {...props} view={idle} />);
    act(() => {
      screen.getByRole("button", { name: "Expand dev.reviewer" }).focus();
    });
    rerender(<RunView {...props} view={openReviewerCall(idle)} />);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Collapse dev.reviewer" }),
    );
  });
});

describe("run-view-110: explicit uncertain-turn recovery", () => {
  test("external ownership keeps delivery history without allowing its actions", () => {
    const previous = useAppStore.getState();
    useAppStore.setState({ledger: {...EMPTY_LEDGER, intents: [FINISHED, QUEUED_NEXT]}});
    try {
      renderRunWith(TURN_ONE, {session: {...SESSION, externalWriter: "active"}});
      expect(screen.getByTestId("delivery-card-i1")).toBeTruthy();
      expect((screen.getByTestId("delivery-confirm") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("delivery-drop") as HTMLButtonElement).disabled).toBe(true);
    } finally {useAppStore.setState(previous, true);}
  });

  test.each(["active", "unknown"] as const)("external %s ownership hides session controls and keeps streaming history", (externalWriter) => {
    const session = { ...SESSION, externalWriter, live: externalWriter === "active", turnActive: false,
      recovery: { state: "uncertain" as const, input: "Saved request" } };
    const view = applyRecords(initialSessionView(PLAYERS), TURN_ONE);
    const composer = { draft: "Keep draft", queued: [{text: "Keep queue"}] };
    const props = {session, view, composer, connected: true, readOnly: false,
      onSubmit: vi.fn(async () => {}), onRecover: vi.fn(async () => {}), onEnd: vi.fn(),
      onStartNew: vi.fn(), onAbort: vi.fn(), onRemoveQueued: vi.fn(), onDismissError: vi.fn()};
    const rendered = render(<RunView {...props} />);
    expect(screen.getByTestId("session-external-owner").textContent).toContain(externalWriter === "active" ? "in use elsewhere" : "ownership is unknown");
    expect(screen.queryByTestId("session-ended-at")).toBeNull();
    expect(screen.queryByTestId("ended-notice")).toBeNull();
    expect(screen.queryByText("Interrupted turn")).toBeNull();
    expect(screen.queryByTestId("boss-composer")).toBeNull();
    for (const name of ["Retry", "Discard", "End session", "New session"]) {
      expect(screen.queryByRole("button", {name})).toBeNull();
    }
    applyRecords(view, [{seq: view.lastSeq + 1, record: {type: "captain_reply", timestamp: 100, turnId: 1, text: "New external output"} as TmuxPlayRecord}]);
    rendered.rerender(<RunView {...props} view={{...view}} />);
    expect(screen.getByText("New external output")).toBeTruthy();
    expect(composer).toEqual({draft: "Keep draft", queued: [{text: "Keep queue"}]});
  });

  test.each(["active", "unknown"] as const)("external %s ownership blocks queued and direct mutations without losing input", async (externalWriter) => {
    const previous = useAppStore.getState();
    const command = vi.fn(async () => ({}));
    setClientForTests({command} as never);
    const session = {...SESSION, externalWriter, live: externalWriter === "active", turnActive: false};
    const composer = {draft: "Keep draft", queued: [{text: "Keep queue"}]};
    useAppStore.setState({sessions: [session], views: {s1: initialSessionView(PLAYERS)}, composers: {s1: composer}, specTrees: {}, activeSessionId: undefined});
    try {
      deliverServerMessageForTests({type: "record", channel: "session", sessionId: "s1", seq: 1,
        record: {type: "turn_finished", turnId: 1, timestamp: 1} as TmuxPlayRecord});
      deliverServerMessageForTests({type: "session.state", session});
      await expect(useAppStore.getState().submitBossText("s1", "New request")).rejects.toThrow("ownership");
      await expect(useAppStore.getState().recoverSession("s1", "retry")).rejects.toThrow("ownership");
      await expect(useAppStore.getState().recoverSession("s1", "discard")).rejects.toThrow("ownership");
      await expect(useAppStore.getState().disposeSession("s1")).rejects.toThrow("ownership");
      await expect(useAppStore.getState().deleteSession("s1")).rejects.toThrow("ownership");
      expect(command).not.toHaveBeenCalled();
      expect(useAppStore.getState().composers.s1).toEqual(composer);
      expect(useAppStore.getState().views.s1.lastSeq).toBe(1);
      deliverServerMessageForTests({type: "session.state", session: {...SESSION, live: false}});
      expect(command).not.toHaveBeenCalled();
      expect(useAppStore.getState().composers.s1).toEqual(composer);
    } finally {setClientForTests(undefined); useAppStore.setState(previous, true);}
  });

  test("confirmed disposal clears input only after the command succeeds", async () => {
    const previous = useAppStore.getState();
    const command = vi.fn().mockRejectedValueOnce(new Error("cleanup failed")).mockResolvedValueOnce(null);
    setClientForTests({command} as never);
    const composer = {draft: "Keep draft", queued: [{text: "Keep queue"}]};
    useAppStore.setState({sessions: [SESSION], composers: {s1: composer}});
    try {
      await expect(useAppStore.getState().disposeSession("s1")).rejects.toThrow("cleanup failed");
      expect(useAppStore.getState().composers.s1).toEqual(composer);
      await useAppStore.getState().disposeSession("s1");
      expect(useAppStore.getState().composers.s1).toEqual({draft: "", queued: []});
    } finally {setClientForTests(undefined); useAppStore.setState(previous, true);}
  });

  function renderInterrupted(onRecover: (action: "retry" | "discard") => Promise<void> = vi.fn(async () => {}), connected = true) {
    const session = { ...SESSION, live: false, continuable: false, recovery: { state: "uncertain" as const, input: "Original interrupted request" } };
    const props = {
      session, view: initialSessionView(PLAYERS),
      composer: { draft: "Keep my draft", queued: [{ text: "Later" }] },
      connected, readOnly: true, onRecover,
      onDraftChange: vi.fn(), onSubmit: vi.fn(async () => {}),
      onAbort: vi.fn(), onRemoveQueued: vi.fn(), onDismissError: vi.fn(),
    };
    return { ...render(<RunView {...props} />), props, onRecover };
  }

  test("confirms the saved input, prevents duplicate recovery, and retains a refused draft", async () => {
    let refuse!: (error: Error) => void;
    const onRecover = vi.fn(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
    const { props } = renderInterrupted(onRecover);
    expect(screen.getByText("Original interrupted request")).toBeTruthy();
    expect(screen.getByDisplayValue("Keep my draft")).toBeTruthy();
    const send = screen.getAllByRole("button").find((b) => b.textContent === "Send");
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(onRecover).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onRecover).toHaveBeenCalledExactlyOnceWith("discard");
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => refuse(new Error("Effect ledger advanced; discard refused.")));
    expect(screen.getByRole("alert").textContent).toContain("Effect ledger advanced");
    expect(screen.getByDisplayValue("Keep my draft")).toBeTruthy();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  test("sends recovery over the protocol with only the selected session ID", async () => {
    const previous = useAppStore.getState();
    const command = vi.fn(async () => ({ accepted: true }));
    setClientForTests({ command } as never);
    renderInterrupted(async (action) => {
      await useAppStore.getState().recoverSession(SESSION.id, action);
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
      expect(command).toHaveBeenCalledExactlyOnceWith("session.retry", { sessionId: SESSION.id });
    } finally {
      setClientForTests(undefined);
      useAppStore.setState(previous, true);
    }
  });

  test("does not dispatch disconnected recovery", () => {
    renderInterrupted(undefined, false);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("holds queued messages through turn_finished until checkpoint settlement", () => {
    const previous = useAppStore.getState();
    const command = vi.fn(async () => ({}));
    setClientForTests({ command } as never);
    useAppStore.setState({
      sessions: [{ ...SESSION, turnActive: true }],
      views: { s1: initialSessionView(PLAYERS) },
      composers: { s1: { draft: "Draft", queued: [{ text: "After settlement" }] } },
      specTrees: {}, activeSessionId: undefined,
    });
    render(<StoredSessionRun />);
    try {
      act(() => deliverServerMessageForTests({ type: "record", channel: "session", sessionId: "s1", seq: 1,
        record: { type: "turn_finished", turnId: 1, timestamp: 1 } as TmuxPlayRecord }));
      expect(command).not.toHaveBeenCalled();
      expect(useAppStore.getState().views.s1.turnActive).toBe(true);
      expect(screen.getByTestId("working-indicator")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Send next" })).toBeTruthy();
      act(() => deliverServerMessageForTests({ type: "session.state", session: { ...SESSION, live: false, recovery: { state: "uncertain", input: "saved" } } }));
      expect(command).not.toHaveBeenCalled();
      expect(useAppStore.getState().composers.s1.queued).toHaveLength(1);
      act(() => deliverServerMessageForTests({ type: "session.state", session: { ...SESSION, turnActive: false } }));
      expect(command).toHaveBeenCalledExactlyOnceWith("turn.submit", { sessionId: "s1", text: "After settlement" });
      expect(useAppStore.getState().views.s1.turnActive).toBe(false);
    } finally {
      setClientForTests(undefined);
      useAppStore.setState(previous, true);
    }
  });
});

/** Real store actions and server messages drive the rendered session. */
function StoredSessionRun() {
  const state = useAppStore();
  const session = state.sessions.find((entry) => entry.id === "s1");
  const view = state.views.s1;
  if (!session || !view || view.loading) return <span>Loading transcript…</span>;
  return <RunView session={session} view={view}
    composer={state.composers.s1 ?? { queued: [] }} connected
    readOnly={!!session.externalWriter || (!session.live && !session.continuable)}
    error={state.runErrors.s1}
    onRetryLoad={() => { void state.loadPastSession("s1", true).catch(() => {}); }}
    onRecover={(action) => state.recoverSession("s1", action)}
    onDraftChange={(draft) => state.setDraft("s1", draft)}
    onSubmit={(text) => state.submitBossText("s1", text)}
    onAbort={() => state.abortTurn("s1")}
    onRemoveQueued={() => {}} onDismissError={() => state.clearRunError("s1")} />;
}

test("stored mid-turn history stays idle and Discard permits a direct submission", async () => {
  const previous = useAppStore.getState();
  const stopped = { ...SESSION, live: false, turnActive: false, continuable: false,
    recovery: { state: "uncertain" as const, input: "Interrupted request" } };
  const records = [
    { seq: 1, record: { type: "turn_started", timestamp: 1, turnId: 1, turn: { id: 1, prompt: "Interrupted request" } } },
    { seq: 2, record: { type: "player_prompt", timestamp: 2, turnId: 1, playerId: "dev.coder", prompt: "Work in progress" } },
    { seq: 3, record: { type: "player_event", timestamp: 3, turnId: 1, playerId: "dev.coder",
      event: { type: "text_delta", payload: { delta: "Preserve partial output" } } } },
  ] as { seq: number; record: TmuxPlayRecord }[];
  const command = vi.fn(async (type: string) => {
    if (type === "history.get") return { records };
    if (type === "session.discard") {
      deliverServerMessageForTests({ type: "session.state", session: { ...SESSION, live: false, turnActive: false, continuable: true } });
      return { removed: false };
    }
    return {};
  });
  setClientForTests({ command, subscribe: async () => {} } as never);
  useAppStore.setState({ sessions: [stopped], views: {}, runErrors: {}, stagedIntents: {},
    composers: { s1: { draft: "Next request", queued: [{ text: "Keep queued request" }] } },
    activeSessionId: undefined, specTrees: {} });
  render(<StoredSessionRun />);
  try {
    await act(async () => useAppStore.getState().loadPastSession("s1"));
    expect(screen.getByText("Preserve partial output")).toBeTruthy();
    expect(screen.queryByTestId("working-indicator")).toBeNull();
    expect(screen.queryByTestId("player-running")).toBeNull();
    expect(screen.queryByTestId("abort-button")).toBeNull();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("player-pane-dev.coder").querySelector(".animate-pulse")).toBeNull();
    // The display is idle without rewriting the conversation's open
    // segment, so subsequent replay/deltas still combine correctly.
    expect(useAppStore.getState().views.s1.players["dev.coder"].segments.at(-1)).toMatchObject({ text: "Preserve partial output", streaming: true });
    await act(async () => useAppStore.getState().recoverSession("s1", "discard"));
    expect(screen.queryByRole("region", { name: "Interrupted turn" })).toBeNull();
    expect(screen.queryByTestId("working-indicator")).toBeNull();
    expect(screen.queryByTestId("abort-button")).toBeNull();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => useAppStore.getState().submitBossText("s1", "Next request"));
    expect(command).toHaveBeenCalledWith("turn.submit", { sessionId: "s1", text: "Next request" });
    expect(useAppStore.getState().composers.s1.queued).toEqual([{ text: "Keep queued request" }]);
  } finally { setClientForTests(undefined); useAppStore.setState(previous, true); }
});

test.each(["active", "unknown", "continuable", "uncertain"] as const)(
  "%s session history reports load failure and retries without losing input", async (kind) => {
    const previous = useAppStore.getState();
    const externalWriter = kind === "active" || kind === "unknown" ? kind : undefined;
    const session = { ...SESSION, live: kind === "active", turnActive: false, externalWriter,
      continuable: kind === "continuable",
      ...(kind === "uncertain" ? { recovery: { state: "uncertain" as const, input: "Saved input" } } : {}),
    };
    const history = vi.fn().mockRejectedValueOnce(new Error("Cannot read selected transcript"))
      .mockResolvedValueOnce({ records: [{ seq: 1, record: { type: "captain_reply", timestamp: 1, turnId: 1, text: "Recovered history" } }] });
    const command = vi.fn(async (type: string) => type === "history.get" ? history() : {});
    setClientForTests({ command, subscribe: async () => {} } as never);
    const composer = { draft: "Keep draft", queued: [{ text: "Keep queue" }] };
    useAppStore.setState({ sessions: [session], views: {}, composers: { s1: composer },
      runErrors: {}, activeSessionId: undefined, specTrees: {} });
    render(<StoredSessionRun />);
    try {
      await act(async () => {
        await expect(useAppStore.getState().loadPastSession("s1")).rejects.toThrow("Cannot read selected transcript");
      });
      const error = screen.getByTestId("past-load-error");
      expect(error.textContent).toContain("Cannot read selected transcript");
      if (externalWriter) expect(screen.getByTestId("session-external-owner")).toBeTruthy();
      await act(async () => fireEvent.click(within(error).getByRole("button", { name: "Retry" })));
      expect(await screen.findByText("Recovered history")).toBeTruthy();
      expect(screen.queryByTestId("past-load-error")).toBeNull();
      expect(command.mock.calls.every(([type]) => type === "history.get")).toBe(true);
      expect(history).toHaveBeenCalledTimes(2);
      expect(useAppStore.getState().composers.s1).toEqual(composer);
    } finally { setClientForTests(undefined); useAppStore.setState(previous, true); }
  },
);

test("run-view-110: a rejected queued send preserves its text and draft", async () => {
  const previous = useAppStore.getState();
  const command = vi.fn(async () => { throw new Error("Resolve uncertainty first"); });
  setClientForTests({command} as never);
  useAppStore.setState({sessions:[{...SESSION,turnActive:false}],views:{s1:initialSessionView(PLAYERS)},composers:{s1:{draft:"My draft",queued:[{text:"Next request"}]}},specTrees:{},activeSessionId:undefined});
  try {
    await Promise.resolve();
    deliverServerMessageForTests({type:"session.state",session:{...SESSION,turnActive:false}});
    await waitFor(() => expect(useAppStore.getState().runErrors.s1).toContain("Resolve uncertainty first"));
    expect(command).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().composers.s1).toEqual({draft:"My draft",queued:[{text:"Next request"}]});
  } finally {setClientForTests(undefined);useAppStore.setState(previous,true);}
});

describe("run-view-64: immutable graph context", () => {
  test("stored runs keep their own graph after newer context and current-module changes", () => {
    const context = (seq: number, graph: MachineGraph) => ({seq, record:{
      type:"session_context", timestamp:seq, contextVersion:1,
      graphs:[{playbookId:"code", graph}],
    } as unknown as TmuxPlayRecord});
    const entries = MACHINE_RUN.map((entry,index) => ({...entry, seq:index+2,
      record:{...entry.record, contextSeq:1} as TmuxPlayRecord}));
    const view = applyRecords(initialSessionView(PLAYERS), [context(1, codeGraph as MachineGraph), ...entries]);
    const frame = view.captain.find((line) => line.frame?.playbookId === "code")?.frame;
    expect(frame?.historicalGraph).toEqual(codeGraph);
    const replacement: MachineGraph = {initial:"replacement",nodes:[{id:"replacement",kind:"final",tags:[]}],edges:[]};
    applyRecords(view, [context(entries.length+2,replacement)]);
    expect(frame?.historicalGraph).toEqual(codeGraph);
    expect(Object.values(view.contexts).at(-1)?.code).toEqual(replacement);
  });

  test("legacy traces and unknown context use observed states without borrowing a current graph", () => {
    const view = applyRecords(initialSessionView(PLAYERS), MACHINE_RUN);
    const frame = view.captain.find((line) => line.frame?.playbookId === "code")?.frame;
    expect(frame?.historicalGraph).toBeNull();
  });
});

test("run-view-123: reconnect and replacement reload history while preserving drafts", async () => {
  const previous = useAppStore.getState();
  const session = {...SESSION,live:false};
  const old = applyRecords(initialSessionView(PLAYERS), [{seq:30,record:{type:"captain_reply",timestamp:1,turnId:1,text:"Unselected history"} as TmuxPlayRecord}]);
  const records = [{seq:1,record:{type:"captain_reply",timestamp:2,turnId:1,text:"Selected history"} as TmuxPlayRecord}];
  const command = vi.fn(async (type: string) => {
    if (type === "session.list") return [session];
    if (type === "history.get") return {records};
    if (type === "config.get") return {status:"missing",path:"/config"};
    if (type === "project.list" || type === "readiness.get") return [];
    return {};
  });
  setClientForTests({command,subscribe:async () => {}} as never);
  useAppStore.setState({sessions:[session],views:{s1:old},composers:{s1:{draft:"Keep draft",queued:[{text:"Keep queue"}]}},specTrees:{},activeSessionId:undefined,projects:[],history:{}});
  try {
    await useAppStore.getState().refresh();
    expect(command).toHaveBeenCalledWith("history.get", {sessionId:"s1",afterSeq:0});
    expect(useAppStore.getState().views.s1.lastSeq).toBe(1);
    useAppStore.setState({views:{s1:old}});
    deliverServerMessageForTests({type:"session.history-replaced",sessionId:"s1"});
    await waitFor(() => expect(useAppStore.getState().views.s1.lastSeq).toBe(1));
    expect(useAppStore.getState().composers.s1).toEqual({draft:"Keep draft",queued:[{text:"Keep queue"}]});
    expect(JSON.stringify(useAppStore.getState().views.s1)).not.toContain("Unselected history");
  } finally {setClientForTests(undefined);useAppStore.setState(previous,true);}
});
