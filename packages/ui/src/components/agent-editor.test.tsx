// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-019: the one shared agent editor. Adapters carry their
// readiness, the effort vocabulary is adapter-scoped, a save emits a
// merge patch over the surfaced fields only, and "Same as Captain"
// copies the Captain's settings — never its prose. The popover
// wrapper keeps the at-hand focus discipline of DR-010 §6 that the
// retired profile popover used to hold.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

vi.mock("../lib/agent-options.js", async (original) => {
  const actual = await original<typeof import("../lib/agent-options.js")>();
  const efforts: Record<string, string[]> = {
    claude: ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"],
    codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    gemini: ["minimal", "low", "medium", "high", "xhigh", "max"],
    kimi: ["off", "on"], opencode: ["low", "high"],
  };
  return { ...actual, useAgentOptions: (adapter: string) => ({
    options: { adapter, effortValues: efforts[adapter], fastModeSupported: adapter === "claude",
      discovery: { status: "unavailable", reason: "Fixture has no model catalog" } },
    loading: false, refresh: vi.fn(),
  }) };
});

afterEach(cleanup);

import { AgentEditor, AgentEditorPopover } from "./AgentEditor.js";
import type { ChipAgent } from "./AgentChip.js";
import type { AgentPatch } from "../lib/config-ops.js";
import type { ReadinessEntry } from "@sublang/spex-core/protocol";

const READINESS: ReadinessEntry[] = [
  { adapter: "claude", ready: true, usedBy: ["captain"], fastModeSupported: true },
  {
    adapter: "codex",
    ready: false,
    requirement: "set OPENAI_API_KEY or run `codex login`",
    usedBy: ["code.reviewer"],
    fastModeSupported: false,
  },
  {
    adapter: "gemini",
    ready: null,
    usedBy: ["review.reviewer"],
    fastModeSupported: false,
  },
];

function saver() {
  return vi.fn((_patch: AgentPatch) => {});
}

function renderEditor(
  initial?: ChipAgent,
  extra: { captain?: ChipAgent; readiness?: ReadinessEntry[] } = {},
) {
  const onSave = saver();
  render(
    <AgentEditor
      initial={initial}
      readiness={extra.readiness}
      captain={extra.captain}
      onSave={onSave}
    />,
  );
  return {
    onSave,
    effort: () => screen.getByTestId("agent-effort") as HTMLSelectElement,
    model: () => screen.getByTestId("agent-model") as HTMLInputElement,
    mode: () => screen.getByTestId("agent-mode") as HTMLSelectElement,
    paths: () => screen.getByTestId("agent-paths") as HTMLInputElement,
    save: () => screen.getByTestId("agent-save") as HTMLButtonElement,
    options: () =>
      Array.from(
        (screen.getByTestId("agent-effort") as HTMLSelectElement).options,
      ).map((option) => option.value),
  };
}

describe("DR-019: adapter choice carries readiness", () => {
  test("every runtime adapter is offered with its readiness dot", () => {
    renderEditor({ adapter: "claude" }, { readiness: READINESS });
    const group = screen.getByRole("radiogroup", { name: "Adapter" });
    for (const adapter of ["claude", "codex", "gemini", "kimi", "opencode"]) {
      expect(within(group).getByTestId(`agent-adapter-${adapter}`)).toBeTruthy();
    }
    expect(
      within(screen.getByTestId("agent-adapter-claude")).getByTitle("ready"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("agent-adapter-codex")).getByTitle(
        "set OPENAI_API_KEY or run `codex login`",
      ),
    ).toBeTruthy();
    // No preflight rule for the adapter: verify-yourself guidance.
    expect(
      within(screen.getByTestId("agent-adapter-gemini")).getByTitle(
        /verify sign-in yourself/,
      ),
    ).toBeTruthy();
    // An adapter with no entry at all shows no dot.
    expect(
      within(screen.getByTestId("agent-adapter-kimi")).queryByTitle(/./),
    ).toBeNull();
  });
});

describe("DR-019: the effort vocabulary is adapter-scoped", () => {
  test("kimi offers only off/on", () => {
    const editor = renderEditor({ adapter: "kimi" });
    expect(editor.options()).toEqual(["", "off", "on"]);
  });

  test("codex offers ultra and never claude's ultracode", () => {
    const editor = renderEditor({ adapter: "codex" });
    expect(editor.options()).toContain("ultra");
    expect(editor.options()).not.toContain("ultracode");
    expect(editor.options()).not.toContain("off");
  });

  test("claude offers ultracode and never codex's ultra", () => {
    const editor = renderEditor({ adapter: "claude" });
    expect(editor.options()).toContain("ultracode");
    expect(editor.options()).not.toContain("ultra");
  });

  test("switching the adapter clears an effort the new one rejects", () => {
    const editor = renderEditor({ adapter: "claude", effort: "ultracode" });
    expect(editor.effort().value).toBe("ultracode");
    fireEvent.click(screen.getByTestId("agent-adapter-codex"));
    expect(editor.effort().value).toBe("");
    expect(editor.options()).toContain("ultra");
  });

  test("switching adapter resets tuning to its defaults", () => {
    const editor = renderEditor({ adapter: "claude", effort: "high" });
    fireEvent.click(screen.getByTestId("agent-adapter-codex"));
    expect(editor.effort().value).toBe("");
    // kimi's binary vocabulary rejects it, so it clears there.
    fireEvent.click(screen.getByTestId("agent-adapter-kimi"));
    expect(editor.effort().value).toBe("");
  });
});

describe("DR-019: a save emits a merge patch over surfaced fields", () => {
  test("nothing to save until the draft differs", () => {
    const editor = renderEditor({ adapter: "claude", model: "claude-opus-4-8" });
    expect(editor.save().disabled).toBe(true);
    fireEvent.change(editor.model(), { target: { value: "claude-sonnet-4-8" } });
    expect(editor.save().disabled).toBe(false);
  });

  test("the patch carries adapter, model, effort and permissions only", () => {
    const editor = renderEditor({
      adapter: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      instruction: "Keep the diff small.",
      permissions: {
        mode: "auto",
        fileWrite: "ask",
        writablePaths: [".git"],
      },
    });
    fireEvent.change(editor.model(), {
      target: { value: "claude-opus-4-8[1m]" },
    });
    fireEvent.click(editor.save());
    expect(editor.onSave).toHaveBeenCalledTimes(1);
    const patch = editor.onSave.mock.calls[0][0];
    expect(patch).toEqual({
      adapter: "claude",
      model: "claude-opus-4-8[1m]",
      effort: "high",
      // Unsurfaced policies ride along: permissions replace wholesale
      // on merge, so dropping them would erase hand-written values.
      permissions: {
        mode: "auto",
        fileWrite: "ask",
        writablePaths: [".git"],
      },
    });
    // The hand-written instruction is never written back — merge
    // semantics keep it because the patch omits it.
    expect(patch).not.toHaveProperty("instruction");
  });

  test("blanking a pinned model unsets it, never an empty string", () => {
    // Clearing must mean what it shows (DR-019): an explicit null
    // unsets the key so the agent falls back to its adapter default.
    const editor = renderEditor({
      adapter: "kimi",
      model: "kimi-k2",
      effort: "on",
    });
    fireEvent.change(editor.model(), { target: { value: "   " } });
    fireEvent.click(editor.save());
    const patch = editor.onSave.mock.calls[0][0];
    expect(patch).toEqual({ adapter: "kimi", model: null, effort: "on" });
    expect(patch).not.toHaveProperty("permissions");
  });

  test("a never-pinned model stays absent rather than nulled", () => {
    // Nothing to unset: an agent with no pinned model emits no model
    // key at all, so the patch stays minimal.
    const editor = renderEditor({ adapter: "kimi", effort: "on" });
    fireEvent.change(editor.effort(), { target: { value: "off" } });
    fireEvent.click(editor.save());
    const patch = editor.onSave.mock.calls[0][0];
    expect(patch).toEqual({ adapter: "kimi", effort: "off" });
    expect(patch).not.toHaveProperty("model");
  });

  test("mode none drops the mode and keeps unsurfaced policies", () => {
    const editor = renderEditor({
      adapter: "claude",
      permissions: { mode: "auto", shellExecute: "deny" },
    });
    expect(editor.mode().value).toBe("auto");
    fireEvent.change(editor.mode(), { target: { value: "none" } });
    fireEvent.click(editor.save());
    expect(editor.onSave.mock.calls[0][0]).toEqual({
      adapter: "claude",
      permissions: { shellExecute: "deny" },
    });
  });

  test("writable paths split on commas and trim", () => {
    const editor = renderEditor({ adapter: "claude" });
    fireEvent.change(editor.paths(), {
      target: { value: " .git , docs/ ,, build " },
    });
    fireEvent.click(editor.save());
    expect(editor.onSave.mock.calls[0][0]).toEqual({
      adapter: "claude",
      permissions: { writablePaths: [".git", "docs/", "build"] },
    });
  });

  test("a rejected save surfaces its message and re-enables the button", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("coder would be unresolved");
    });
    render(
      <AgentEditor
        initial={{ adapter: "claude" }}
        onSave={onSave}
        saveLabel="Use"
      />,
    );
    const save = screen.getByTestId("agent-save") as HTMLButtonElement;
    expect(save.textContent).toBe("Use");
    fireEvent.change(screen.getByTestId("agent-model"), {
      target: { value: "claude-opus-4-8" },
    });
    fireEvent.click(save);
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("agent-editor").textContent,
      ).toContain("coder would be unresolved"),
    );
    expect((screen.getByTestId("agent-save") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("settings-10: the permission mode explains itself", () => {
  test("each mode carries its own line, bypass naming the sandbox rule", () => {
    const editor = renderEditor({ adapter: "claude", permissions: { mode: "auto" } });
    const help = () => screen.getByTestId("agent-mode-help").textContent;
    expect(help()).toMatch(/^auto: /);
    fireEvent.change(editor.mode(), { target: { value: "bypass" } });
    expect(help()).toBe("bypass: no permission prompts — sandboxed repos only");
    fireEvent.change(editor.mode(), { target: { value: "none" } });
    expect(help()).toMatch(/^none: /);
    // Writable paths carry a worked example.
    expect(editor.paths().placeholder).toContain(".git");
  });
});

describe("DR-019: Same as Captain copies settings, not prose", () => {
  const CAPTAIN: ChipAgent = {
    adapter: "codex",
    model: "gpt-5.5-codex",
    effort: "ultra",
    instruction: "Route the boss's words to a playbook.",
    permissions: {
      mode: "bypass",
      networkAccess: "allow",
      writablePaths: ["docs"],
    },
  };

  test("the action is offered only where a Captain is known", () => {
    renderEditor({ adapter: "claude" });
    expect(screen.queryByTestId("agent-same-as-captain")).toBeNull();
    cleanup();
    renderEditor({ adapter: "claude" }, { captain: CAPTAIN });
    expect(screen.getByTestId("agent-same-as-captain")).toBeTruthy();
  });

  test("it copies adapter, model, effort and permissions into the draft", () => {
    const editor = renderEditor(
      {
        adapter: "claude",
        model: "claude-opus-4-8",
        effort: "high",
        permissions: { mode: "auto" },
      },
      { captain: CAPTAIN },
    );
    fireEvent.click(screen.getByTestId("agent-same-as-captain"));
    expect(
      screen.getByTestId("agent-adapter-codex").getAttribute("aria-checked"),
    ).toBe("true");
    expect(editor.model().value).toBe("gpt-5.5-codex");
    expect(editor.effort().value).toBe("ultra");
    expect(editor.mode().value).toBe("bypass");
    expect(editor.paths().value).toBe("docs");

    fireEvent.click(editor.save());
    const patch = editor.onSave.mock.calls[0][0];
    expect(patch).toEqual({
      adapter: "codex",
      model: "gpt-5.5-codex",
      effort: "ultra",
      permissions: {
        mode: "bypass",
        networkAccess: "allow",
        writablePaths: ["docs"],
      },
    });
    // Only settings are copied: the Captain's instruction is its own.
    expect(patch).not.toHaveProperty("instruction");
  });
});

describe("DR-019/DR-010 §6: the popover's at-hand discipline", () => {
  function renderPopover(onClose = vi.fn()) {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const view = render(
      <AgentEditorPopover
        title="coder agent"
        initial={{ adapter: "claude", model: "claude-opus-4-8" }}
        readiness={READINESS}
        onSave={saver()}
        onClose={onClose}
      />,
    );
    return { onClose, opener, view };
  }

  test("it is a labelled dialog carrying the shared editor", () => {
    renderPopover();
    const popover = screen.getByTestId("agent-popover");
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(popover.getAttribute("aria-label")).toBe("coder agent");
    expect(within(popover).getByTestId("agent-editor")).toBeTruthy();
  });

  test("focus enters on mount and returns to the opener on unmount", () => {
    const { opener, view } = renderPopover();
    expect(document.activeElement).toBe(
      screen.getByTestId("agent-adapter-claude"),
    );
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  test("Escape closes it", () => {
    const { onClose } = renderPopover();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("the close control closes it", () => {
    const { onClose } = renderPopover();
    fireEvent.click(screen.getByTestId("agent-cancel"));
    expect(onClose).toHaveBeenCalled();
  });

  test("a click outside closes it; one inside does not", () => {
    const { onClose } = renderPopover();
    fireEvent.mouseDown(screen.getByTestId("agent-model"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  test("it asks for no more width than the window can show", () => {
    // The stylesheet's own floor under the measured placement
    // (settings-33): the dialog never exceeds the window, and it
    // scrolls its own content rather than leaving its box.
    renderPopover();
    const popover = screen.getByTestId("agent-popover");
    expect(popover.className).toContain("max-w-[calc(100vw-1rem)]");
    expect(popover.className).toContain("overflow-y-auto");
  });

  test("a dialog hanging out of its pane is moved inside it", () => {
    // A simulated document measures nothing, so the boxes are given:
    // a 264px pane and a dialog pinned to an anchor near its left
    // edge, the case that clips at every real width (settings-33).
    const pane = document.createElement("div");
    pane.style.overflowX = "hidden";
    pane.style.overflowY = "hidden";
    document.body.appendChild(pane);
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const box =
        this === pane
          ? { left: 56, top: 0, width: 264, height: 800 }
          : this.getAttribute("data-testid") === "agent-popover"
            ? { left: -140, top: 0, width: 248, height: 300 }
            : { left: 0, top: 0, width: 0, height: 0 };
      return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) } as DOMRect;
    };
    try {
      render(
        <AgentEditorPopover
          title="coder agent"
          initial={{ adapter: "claude" }}
          onSave={saver()}
          onClose={vi.fn()}
        />,
        { container: pane },
      );
      const popover = screen.getByTestId("agent-popover");
      expect(popover.style.maxWidth).toBe("248px");
      expect(popover.style.maxHeight).toBe("784px");
      // -140 → 64, the pane's left edge plus the inset.
      expect(popover.style.transform).toBe("translate(204px, 8px)");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
      pane.remove();
    }
  });
});

describe("DR-038: fast mode is offered where the runtime declares it", () => {
  test("the switch shows for a supporting adapter and hides for the rest", () => {
    renderEditor({ adapter: "claude" }, { readiness: READINESS });
    expect(screen.getByTestId("agent-fast-mode")).toBeTruthy();
    fireEvent.click(screen.getByTestId("agent-adapter-codex"));
    expect(screen.queryByTestId("agent-fast-mode")).toBeNull();
  });

  test("discovery supplies capabilities independently of readiness", () => {
    renderEditor({ adapter: "claude" });
    expect(screen.getByTestId("agent-fast-mode")).toBeTruthy();
  });

  test("checking writes true; unchecking a set value unsets it", () => {
    const first = renderEditor({ adapter: "claude" }, { readiness: READINESS });
    fireEvent.click(screen.getByTestId("agent-fast-mode"));
    fireEvent.click(first.save());
    expect(first.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ fastMode: true }),
    );
    cleanup();

    const second = renderEditor(
      { adapter: "claude", fastMode: true },
      { readiness: READINESS },
    );
    const box = screen.getByTestId("agent-fast-mode") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(second.save());
    expect(second.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ fastMode: null }),
    );
  });

  test("an untouched switch emits no fastMode key", () => {
    const { onSave, model, save } = renderEditor(
      { adapter: "claude" },
      { readiness: READINESS },
    );
    fireEvent.change(model(), { target: { value: "claude-opus-5" } });
    fireEvent.click(save());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("fastMode");
  });

  test("switching to an adapter without fast mode unsets the value", () => {
    const { onSave, save } = renderEditor(
      { adapter: "claude", fastMode: true },
      { readiness: READINESS },
    );
    fireEvent.click(screen.getByTestId("agent-adapter-codex"));
    fireEvent.click(save());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "codex", fastMode: null }),
    );
  });
});
