// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import * as cligent from "@sublang/cligent";
import type { AdapterName, AgentOptions } from "./protocol.js";

export type AgentModelDiscovery = (adapter: AdapterName, options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<AgentOptions["discovery"]>;

/** Discovery failures leave configuration editing available. */
export async function readAgentOptions(
  adapter: AdapterName,
  env: NodeJS.ProcessEnv,
  discover: AgentModelDiscovery = cligent.discoverAgentModels,
): Promise<AgentOptions> {
  let discovery: AgentOptions["discovery"];
  try {
    discovery = await discover(adapter, { env, timeoutMs: 10_000 });
  } catch (cause) {
    discovery = { status: "unavailable", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  const effort = cligent.getEffortSupport(adapter);
  return {
    adapter,
    effortValues: effort?.values ?? [],
    fastModeSupported: cligent.isFastModeSupported(adapter),
    discovery,
  };
}
