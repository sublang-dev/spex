// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AdapterName, AgentOptions } from "@sublang/spex-core/protocol";
import { useAppStore } from "../state/store.js";
import { AgentEditor } from "./AgentEditor.js";
import { BindingEditorPopover } from "./BindingEditor.js";
import { createRef } from "react";

const originalLoad = useAppStore.getState().loadAgentOptions;
const options = (adapter: AdapterName = "claude"): AgentOptions => ({
  adapter, effortValues: ["low", "high", "max"], fastModeSupported: true,
  discovery: { status: "available", models: [
    { id: "claude-fable-5-1", name: "Fable", effortValues: ["low", "high"], fastModeSupported: false },
    { id: "plain-model", name: "Plain", effortValues: [], fastModeSupported: false },
    { id: "unknown-model", name: "Unknown" },
  ] },
});
beforeEach(() => useAppStore.setState({ loadAgentOptions: vi.fn(async (adapter) => options(adapter)) }));
afterEach(() => { cleanup(); useAppStore.setState({ loadAgentOptions: originalLoad }); });

async function ready() { await screen.findByText("Models reported by the installed runtime."); }

test("runtime model selection narrows tuning and preserves a draft needing correction", async () => {
  const save = vi.fn();
  render(<AgentEditor initial={{ adapter: "claude", model: "claude-fable-5.1", effort: "max", fastMode: true }} onSave={save} />);
  await ready();
  expect((screen.getByTestId("agent-model") as HTMLInputElement).value).toBe("claude-fable-5.1");
  fireEvent.change(screen.getByTestId("agent-model-select"), { target: { value: "claude-fable-5-1" } });
  expect(screen.queryByTestId("agent-model")).toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  expect((screen.getByTestId("agent-effort") as HTMLSelectElement).value).toBe("max");
  expect((screen.getByTestId("agent-save") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByTestId("agent-effort"), { target: { value: "high" } });
  fireEvent.click(screen.getByTestId("agent-fast-mode"));
  fireEvent.click(screen.getByTestId("agent-save"));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ adapter: "claude", model: "claude-fable-5-1", effort: "high", fastMode: null }));
});

test("known no effort differs from unknown model support and allows explicit custom models", async () => {
  render(<AgentEditor initial={{ adapter: "claude" }} onSave={vi.fn()} />);
  await ready();
  const select = screen.getByTestId("agent-model-select");
  fireEvent.change(select, { target: { value: "plain-model" } });
  expect(Array.from((screen.getByTestId("agent-effort") as HTMLSelectElement).options).map((entry) => entry.value)).toEqual([""]);
  expect(screen.queryByTestId("agent-fast-mode")).toBeNull();
  fireEvent.change(select, { target: { value: "unknown-model" } });
  expect(screen.getByText(/Effort options apply to the adapter/)).toBeTruthy();
  expect(screen.getByTestId("agent-fast-mode")).toBeTruthy();
  fireEvent.change(select, { target: { value: "__spex_custom__" } });
  fireEvent.change(screen.getByTestId("agent-model"), { target: { value: "private-alias" } });
  expect((screen.getByTestId("agent-model") as HTMLInputElement).value).toBe("private-alias");
});

test("late discovery never replaces another adapter's options; unavailable discovery can refresh", async () => {
  let first!: (value: AgentOptions) => void;
  const load = vi.fn((adapter: AdapterName): Promise<AgentOptions> => adapter === "claude"
    ? new Promise((resolve) => { first = resolve; })
    : Promise.resolve({ ...options(adapter), discovery: { status: "unavailable", reason: "Offline" } }));
  useAppStore.setState({ loadAgentOptions: load });
  render(<AgentEditor initial={{ adapter: "claude", model: "keep-me" }} onSave={vi.fn()} />);
  fireEvent.click(screen.getByTestId("agent-adapter-codex"));
  await screen.findByText("Model list unavailable: Offline");
  first(options());
  await waitFor(() => expect(screen.queryByTestId("agent-model-select")).toBeNull());
  fireEvent.change(screen.getByTestId("agent-model"), { target: { value: "custom-codex" } });
  load.mockResolvedValue({ ...options("codex"), discovery: { status: "available", models: [{ id: "gpt-6-astra", name: "Astra" }] } });
  fireEvent.click(screen.getByText("Refresh models"));
  await ready();
  expect((screen.getByTestId("agent-model") as HTMLInputElement).value).toBe("custom-codex");
  expect(screen.getByRole("option", { name: "Astra · gpt-6-astra" })).toBeTruthy();
});

test("role binding uses its player's discovered model while preserving inheritance", async () => {
  const save = vi.fn(async () => {});
  render(<BindingEditorPopover role="analyst" position="dev.analyst" binding={{ playerId: "analyst", display: "Fable" }}
    players={[{ id: "analyst", agent: { adapter: "claude", model: "claude-fable-5-1", effort: "high" }, display: "Fable", boundBy: [] }]}
    anchorRef={createRef<HTMLButtonElement>()} onSave={save} onClose={vi.fn()} />);
  await ready();
  fireEvent.change(screen.getByTestId("binding-model-mode"), { target: { value: "pin" } });
  expect((screen.getByTestId("binding-model-value-select") as HTMLSelectElement).value).toBe("claude-fable-5-1");
  fireEvent.change(screen.getByTestId("binding-model-value-select"), { target: { value: "" } });
  expect((screen.getByTestId("binding-model-mode") as HTMLSelectElement).value).toBe("provider");
  fireEvent.change(screen.getByTestId("binding-model-mode"), { target: { value: "pin" } });
  fireEvent.change(screen.getByTestId("binding-effort-mode"), { target: { value: "pin" } });
  expect(Array.from((screen.getByTestId("binding-effort-value") as HTMLSelectElement).options).map((entry) => entry.value)).toEqual(["", "low", "high"]);
  fireEvent.change(screen.getByTestId("binding-effort-mode"), { target: { value: "provider" } });
  fireEvent.click(screen.getByTestId("binding-save"));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ playerId: "analyst", model: "claude-fable-5-1", effort: false }));
});


test("role model choices validate inherited effort and fast mode", async () => {
  render(<BindingEditorPopover role="analyst" position="dev.analyst" binding={{ playerId: "analyst", model: "claude-fable-5-1", display: "Fable" }}
    players={[{ id: "analyst", agent: { adapter: "claude", effort: "max", fastMode: true }, display: "Claude", boundBy: [] }]}
    anchorRef={createRef<HTMLButtonElement>()} onSave={vi.fn(async () => {})} onClose={vi.fn()} />);
  await ready();
  expect((screen.getByTestId("binding-effort-mode") as HTMLSelectElement).value).toBe("inherit");
  expect((screen.getByTestId("binding-save") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByTestId("binding-effort-mode"), { target: { value: "provider" } });
  expect((screen.getByTestId("binding-save") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByTestId("binding-fast-mode"), { target: { value: "off" } });
  expect((screen.getByTestId("binding-save") as HTMLButtonElement).disabled).toBe(false);
});


test("an adapter without fast-mode requests cannot acquire an explicit Off override", async () => {
  useAppStore.setState({ loadAgentOptions: async (adapter) => ({ ...options(adapter), fastModeSupported: false }) });
  const save = vi.fn(async () => {});
  render(<BindingEditorPopover role="analyst" position="dev.analyst" binding={{ playerId: "analyst", fastMode: false, display: "Gemini" }}
    players={[{ id: "analyst", agent: { adapter: "gemini" }, display: "Gemini", boundBy: [] }]}
    anchorRef={createRef<HTMLButtonElement>()} onSave={save} onClose={vi.fn()} />);
  await ready();
  expect(screen.getByRole("option", { name: "Off (unsupported)" })).toBeTruthy();
  expect((screen.getByTestId("binding-save") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByTestId("binding-fast-mode"), { target: { value: "inherit" } });
  expect(screen.queryByTestId("binding-fast-mode")).toBeNull();
  fireEvent.click(screen.getByTestId("binding-save"));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ fastMode: null })));
});
