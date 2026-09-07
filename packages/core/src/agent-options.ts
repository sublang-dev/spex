// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import * as cligent from "@sublang/cligent";
import type { AdapterName, AgentOptions } from "./protocol.js";

type Discovery = (adapter: AdapterName, options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<AgentOptions["discovery"]>;

/** Discovery is additive to the supported Cligent floor. Older installs
 * retain configuration editing and report their missing capability. */
export async function readAgentOptions(adapter: AdapterName, env: NodeJS.ProcessEnv): Promise<AgentOptions> {
  const discover = (cligent as typeof cligent & { discoverAgentModels?: Discovery }).discoverAgentModels;
  let discovery: AgentOptions["discovery"];
  try {
    discovery = discover
      ? await discover(adapter, { env, timeoutMs: 10_000 })
      : { status: "unavailable", reason: "Update Cligent to enable model discovery." };
  } catch (cause) {
    discovery = { status: "unavailable", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  return {
    adapter,
    effortValues: cligent.getEffortSupport(adapter)?.values ?? [],
    fastModeSupported: cligent.isFastModeSupported(adapter),
    discovery,
  };
}
