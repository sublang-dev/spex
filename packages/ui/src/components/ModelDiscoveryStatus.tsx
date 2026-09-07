// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { useAgentOptions } from "../lib/agent-options.js";

export function ModelDiscoveryStatus({ state }: { state: ReturnType<typeof useAgentOptions> }) {
  const reason = state.error ?? (state.options?.discovery.status === "unavailable" ? state.options.discovery.reason : undefined);
  return <div className="flex flex-wrap items-center gap-1 text-xs text-neutral-500" role="status">
    <span>{state.loading ? "Loading model options…" : reason ? `Model list unavailable: ${reason}` : "Models reported by the installed runtime."}</span>
    <button type="button" disabled={state.loading} onClick={state.refresh} className="underline disabled:opacity-40">Refresh models</button>
  </div>;
}
