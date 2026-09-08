// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import * as cligent from "@sublang/cligent";
import type { AdapterName, AgentOptions } from "./protocol.js";

export type AgentModelDiscovery = (adapter: AdapterName, options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<AgentOptions["discovery"]>;

/** Registry builds without discovery retain configuration editing. */
export async function readAgentOptions(
  adapter: AdapterName,
  env: NodeJS.ProcessEnv,
  discover: AgentModelDiscovery | undefined = (cligent as typeof cligent & { discoverAgentModels?: AgentModelDiscovery }).discoverAgentModels,
): Promise<AgentOptions> {
  let discovery: AgentOptions["discovery"];
  try {
    discovery = discover
      ? await discover(adapter, { env, timeoutMs: 10_000 })
      : { status: "unavailable", reason: "This Spex build does not include model discovery." };
  } catch (cause) {
    discovery = { status: "unavailable", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  const effort = cligent.getEffortSupport(adapter);
  return {
    adapter,
    effortValues: effort?.values ?? [],
    orchestrationValues: effort?.orchestrationValues ?? [],
    fastModeSupported: cligent.isFastModeSupported(adapter),
    discovery,
  };
}
