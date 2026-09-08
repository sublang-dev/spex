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
  adapter, effortValues: ["low", "high", "max", ...(adapter === "claude" ? ["ultracode"] : adapter === "codex" ? ["ultra"] : [])], fastModeSupported: true,
  discovery: { status: "available", ...(adapter === "claude" ? { unreportedEffortValues: ["ultracode"] } : {}), models: [
    { id: "claude-fable-5-1", name: "Fable", effortValues: ["low", "high"], fastModeSupported: false },
    { id: "plain-model", name: "Plain", effortValues: [], fastModeSupported: false },
    { id: "unknown-model", name: "Unknown" },
    { id: "fable", name: "Fable alias", resolvedModel: "claude-fable-5-1-resolved", effortValues: ["high"], fastModeSupported: false },
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
  expect(Array.from((screen.getByTestId("agent-effort") as HTMLSelectElement).options).map((entry) => entry.value)).toEqual(["", "ultracode"]);
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
  fireEvent.change(screen.getByTestId("binding-model-mode"), { target: { value: "provider" } });
  expect((screen.getByTestId("binding-model-mode") as HTMLSelectElement).value).toBe("provider");
  fireEvent.change(screen.getByTestId("binding-model-mode"), { target: { value: "pin" } });
  fireEvent.change(screen.getByTestId("binding-effort-mode"), { target: { value: "pin" } });
  expect(Array.from((screen.getByTestId("binding-effort-value") as HTMLSelectElement).options).map((entry) => entry.value)).toEqual(["", "low", "high", "ultracode"]);
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

test.each(["claude-fable-5-1", "plain-model"])("discovery-unreported effort remains available for %s in both editors", async (model) => {
  const saveAgent = vi.fn();
  const agent = render(<AgentEditor initial={{ adapter: "claude", model, effort: "ultracode" }} allowUnchanged onSave={saveAgent} />);
  await ready();
  expect(screen.getByRole("option", { name: "ultracode (adapter-wide)" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByTestId("agent-save"));
  expect(saveAgent).toHaveBeenCalledWith({ adapter: "claude", model, effort: "ultracode" });
  agent.unmount();

  const saveBinding = vi.fn(async () => {});
  render(<BindingEditorPopover role="analyst" position="dev.analyst" binding={{ playerId: "analyst", model, display: "Claude" }}
    players={[{ id: "analyst", agent: { adapter: "claude", effort: "ultracode" }, display: "Claude", boundBy: [] }]}
    anchorRef={createRef<HTMLButtonElement>()} onSave={saveBinding} onClose={vi.fn()} />);
  await ready();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByTestId("binding-save"));
  expect(saveBinding).toHaveBeenCalledWith(expect.objectContaining({ effort: undefined }));
  fireEvent.change(screen.getByTestId("binding-effort-mode"), { target: { value: "pin" } });
  expect(screen.getByRole("option", { name: "ultracode (adapter-wide)" })).toBeTruthy();
  await waitFor(() => expect((screen.getByTestId("binding-save") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("binding-save"));
  expect(saveBinding).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "ultracode" }));
});

test("canonical pins use alias metadata without rewriting; selecting an alias writes its ID", async () => {
  const save = vi.fn();
  const canonical = "claude-fable-5-1-resolved";
  render(<AgentEditor initial={{ adapter: "claude", model: canonical, effort: "high" }} allowUnchanged onSave={save} />);
  await ready();
  expect(screen.queryByText(/Not in this runtime's list/)).toBeNull();
  expect((screen.getByTestId("agent-model-select") as HTMLSelectElement).value).toBe(canonical);
  expect(Array.from((screen.getByTestId("agent-effort") as HTMLSelectElement).options).map((entry) => entry.value)).toEqual(["", "high", "ultracode"]);
  expect(screen.queryByTestId("agent-fast-mode")).toBeNull();
  fireEvent.click(screen.getByTestId("agent-save"));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ model: canonical }));
  await waitFor(() => expect((screen.getByTestId("agent-save") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByTestId("agent-model-select"), { target: { value: "fable" } });
  fireEvent.click(screen.getByTestId("agent-save"));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ model: "fable" }));
});

test("exact model rows take precedence over another alias's resolution", async () => {
  const catalog = options();
  if (catalog.discovery.status === "available") catalog.discovery.models = [...catalog.discovery.models,
    { id: "claude-fable-5-1-resolved", name: "Exact model", effortValues: ["low"], fastModeSupported: true }];
  useAppStore.setState({ loadAgentOptions: async () => catalog });
  render(<AgentEditor initial={{ adapter: "claude", model: "claude-fable-5-1-resolved", effort: "low" }} allowUnchanged onSave={vi.fn()} />);
  await ready();
  expect(Array.from((screen.getByTestId("agent-effort") as HTMLSelectElement).options).map((entry) => entry.value)).toEqual(["", "low", "ultracode"]);
  expect(screen.getByTestId("agent-fast-mode")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each(["available", "unavailable"] as const)("empty custom role model remains a pin with %s discovery", async (status) => {
  if (status === "unavailable") useAppStore.setState({ loadAgentOptions: async () => ({ ...options(), discovery: { status, reason: "Offline" } }) });
  const save = vi.fn(async () => {});
  render(<BindingEditorPopover role="analyst" position="dev.analyst" binding={{ playerId: "analyst", display: "Claude" }}
    players={[{ id: "analyst", agent: { adapter: "claude" }, display: "Claude", boundBy: [] }]}
    anchorRef={createRef<HTMLButtonElement>()} onSave={save} onClose={vi.fn()} />);
  await screen.findByText(status === "available" ? "Models reported by the installed runtime." : "Model list unavailable: Offline");
  fireEvent.change(screen.getByTestId("binding-model-mode"), { target: { value: "pin" } });
  expect(screen.getByRole("alert").textContent).toContain("Enter a model ID");
  const input = screen.getByTestId("binding-model-value");
  fireEvent.change(input, { target: { value: "temporary" } });
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByTestId("binding-model-value")).toBe(input);
  expect((screen.getByTestId("binding-model-mode") as HTMLSelectElement).value).toBe("pin");
  expect((screen.getByTestId("binding-save") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Enter a model ID");
  fireEvent.change(input, { target: { value: "private-alias" } });
  fireEvent.click(screen.getByTestId("binding-save"));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ model: "private-alias" }));
});

test.each([
  { scope: "reported ultra", efforts: ["high", "ultra"], valid: true },
  { scope: "excluded ultra", efforts: ["high"], valid: false },
  { scope: "known no effort", efforts: [], valid: false },
  { scope: "unknown efforts", efforts: undefined, valid: true },
])("Codex $scope governs agent and inherited role tuning", async ({ efforts, valid }) => {
  useAppStore.setState({ loadAgentOptions: async () => ({
    adapter: "codex", effortValues: ["low", "high", "ultra"], fastModeSupported: true,
    discovery: { status: "available", models: [{ id: "codex-fixture", name: "Codex", effortValues: efforts }] },
  }) });
  const save = vi.fn();
  const agent = render(<AgentEditor initial={{ adapter: "codex", model: "codex-fixture", effort: "ultra" }} allowUnchanged onSave={save} />);
  await ready();
  expect((screen.getByTestId("agent-save") as HTMLButtonElement).disabled).toBe(!valid);
  expect(screen.queryByRole("option", { name: "ultra (adapter-wide)" })).toBeNull();
  if (valid) {
    expect(screen.getByRole("option", { name: "ultra" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("agent-save"));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ effort: "ultra" }));
  } else {
    expect(screen.getByRole("option", { name: "ultra (unsupported)" })).toBeTruthy();
    fireEvent.change(screen.getByTestId("agent-effort"), { target: { value: "" } });
    expect(screen.queryByRole("option", { name: /ultra/ })).toBeNull();
  }
  agent.unmount();

  render(<BindingEditorPopover role="analyst" position="dev.analyst" binding={{ playerId: "analyst", display: "Codex" }}
    players={[{ id: "analyst", agent: { adapter: "codex", model: "codex-fixture", effort: "ultra" }, display: "Codex", boundBy: [] }]}
    anchorRef={createRef<HTMLButtonElement>()} onSave={vi.fn(async () => {})} onClose={vi.fn()} />);
  await ready();
  expect((screen.getByTestId("binding-save") as HTMLButtonElement).disabled).toBe(!valid);
  fireEvent.change(screen.getByTestId("binding-effort-mode"), { target: { value: "provider" } });
  expect((screen.getByTestId("binding-save") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByTestId("binding-effort-mode"), { target: { value: "pin" } });
  expect((screen.getByTestId("binding-save") as HTMLButtonElement).disabled).toBe(!valid);
  expect(screen.queryByRole("option", { name: "ultra (adapter-wide)" })).toBeNull();
});

test("a reported tier is never relabeled as an added adapter choice", async () => {
  const catalog = options();
  catalog.discovery = { status: "available", unreportedEffortValues: ["ultracode"],
    models: [{ id: "future-model", name: "Future", effortValues: ["high", "ultracode"] }] };
  useAppStore.setState({ loadAgentOptions: async () => catalog });
  render(<AgentEditor initial={{ adapter: "claude", model: "future-model", effort: "ultracode" }} allowUnchanged onSave={vi.fn()} />);
  await ready();
  expect(screen.getByRole("option", { name: "ultracode" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "ultracode (adapter-wide)" })).toBeNull();
});
