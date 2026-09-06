// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

/** Observe the dispatched player's provider output, excluding local startup. */
export function livePlayerOutput(records, prompt) {
  const playerId = prompt.record.playerId;
  const nonempty = (value) => typeof value === "string" && value.trim() !== "";
  let diagnostic = "";
  for (const message of records) {
    if (message.sessionId !== prompt.sessionId || message.seq <= prompt.seq) continue;
    const record = message.record;
    let terminal;
    if (record.type === "player_event" && record.playerId === playerId) {
      const event = record.event;
      const payload = event.payload ?? {};
      if (
        (event.type === "text" && nonempty(payload.content)) ||
        (event.type === "text_delta" && nonempty(payload.delta)) ||
        (event.type === "thinking" && nonempty(payload.summary)) ||
        (["tool_use", "tool_result"].includes(event.type) &&
          nonempty(payload.toolUseId) && nonempty(payload.toolName))
      ) return message;
      if (event.type === "error") diagnostic = [payload.code, payload.message].filter(Boolean).join(": ");
      if (event.type === "done") terminal = payload.status ?? "done";
    }
    if (record.type === "player_finished" && record.playerId === playerId) {
      terminal = record.result?.status ?? "finished";
    }
    if (["turn_finished", "turn_aborted"].includes(record.type)) terminal = record.type;
    if (terminal) {
      throw new Error(`coder ${playerId} ended (${terminal}) before provider output${diagnostic ? `: ${diagnostic}` : ""}`);
    }
  }
  return undefined;
}
