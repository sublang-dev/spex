// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import assert from "node:assert/strict";
import test from "node:test";
import { livePlayerOutput } from "./live-output.mjs";

const prompt = { sessionId: "session", seq: 10, record: { type: "player_prompt", playerId: "dev.coder" } };
const event = (seq, type, payload = {}) => ({
  sessionId: "session", seq,
  record: { type: "player_event", playerId: "dev.coder", event: { type, payload } },
});

test("initialization followed by interruption does not pass the live gate", () => {
  const init = event(11, "init", { model: "model", tools: [], capabilities: {} });
  assert.equal(livePlayerOutput([init], prompt), undefined);
  assert.throws(() => livePlayerOutput([
    init, event(12, "error", { code: "unavailable", message: "provider unavailable" }),
    event(13, "done", { status: "interrupted", usage: { toolUses: 0 } }),
  ], prompt), /ended \(interrupted\).*unavailable: provider unavailable/);
});

test("meaningful provider responses pass after empty streaming fragments", () => {
  for (const [type, payload] of [
    ["text", { content: "Ready" }], ["text_delta", { delta: "Hello" }],
    ["thinking", { summary: "Inspecting the repository" }],
    ["tool_use", { toolUseId: "call", toolName: "read_file", input: {} }],
    ["tool_result", { toolUseId: "call", toolName: "read_file", output: "" }],
  ]) {
    const output = event(14, type, payload);
    assert.equal(livePlayerOutput([
      event(11, "init"), event(12, "text_delta", { delta: " " }),
      event(13, "thinking", { summary: "" }), output,
    ], prompt), output);
  }
});

test("other sessions, earlier calls and other players cannot satisfy the gate", () => {
  const otherPlayer = event(12, "text", { content: "Other player" });
  otherPlayer.record.playerId = "dev.reviewer";
  const otherSession = { ...event(13, "text", { content: "Other session" }), sessionId: "other" };
  assert.equal(livePlayerOutput([
    event(9, "text", { content: "Earlier call" }), otherPlayer, otherSession,
    event(14, "permission_request", { toolName: "read", toolUseId: "approval" }),
  ], prompt), undefined);
});

test("player or enclosing turn completion fails without waiting for a timeout", () => {
  for (const record of [
    { type: "player_finished", playerId: "dev.coder", result: { status: "error" } },
    { type: "turn_finished" }, { type: "turn_aborted" },
  ]) {
    assert.throws(() => livePlayerOutput([{ sessionId: "session", seq: 11, record }], prompt), /before provider output/);
  }
});
