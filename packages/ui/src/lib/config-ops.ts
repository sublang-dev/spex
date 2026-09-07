// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Shared config operations for in-place editors (DR-009, DR-019):
// every write goes through the core's validated config.edit path as
// a merge patch — only the provided keys change, so hand-written
// fields (instruction, granular permissions) survive.

import type { AgentBlockInput } from "@sublang/spex-core/protocol";

import { getClient } from "../state/store.js";

/** A merge patch over an existing agent block (DR-019): provided
 * keys change, absent keys survive, and an explicit null unsets a
 * key so the agent falls back to its adapter's default. */
export type AgentPatch = {
  adapter?: string;
  model?: string | null;
  effort?: string | null;
  /** Adapter-scoped fast mode (DR-038); null returns to the default. */
  fastMode?: boolean | null;
  permissions?: AgentBlockInput["permissions"] | null;
};

export function setCaptain(patch: AgentPatch): Promise<unknown> {
  return getClient().command("config.edit", {
    op: { kind: "captain.set", patch },
  });
}

/** Edit a session player's envelope — identity and defaults. Settings
 * owns this; a role binding cannot reach it (DR-032). */
export function patchPlayer(
  playerId: string,
  patch: AgentPatch,
): Promise<unknown> {
  return getClient().command("config.edit", {
    op: { kind: "player.set", playerId, patch },
  });
}

/** Bind a role to a lane, with that role's own tuning. `false` picks
 * the provider default; null clears the override so the role inherits
 * the player's (DR-032). */
export function bindRole(
  playbookId: string,
  role: string,
  next: {
    playerId: string;
    model?: string | false | null;
    effort?: string | false | null;
    fastMode?: boolean | null;
  },
): Promise<unknown> {
  // An untouched tuning is absent, not `undefined`: the op means
  // "preserve the existing value" when a key does not appear; null clears it.
  const tuning = Object.fromEntries(
    Object.entries({ model: next.model, effort: next.effort, fastMode: next.fastMode }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  return getClient().command("config.edit", {
    op: {
      kind: "playbook.role.bind",
      playbookId,
      role,
      playerId: next.playerId,
      ...tuning,
    },
  });
}
