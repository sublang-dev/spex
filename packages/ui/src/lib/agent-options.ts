// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { useEffect, useState } from "react";
import type { AdapterName, AgentOptions } from "@sublang/spex-core/protocol";
import { useAppStore } from "../state/store.js";

/** Discovery belongs to an open editor, never application startup. */
export function useAgentOptions(adapter: AdapterName) {
  const load = useAppStore((state) => state.loadAgentOptions);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ adapter: AdapterName; attempt: number; options?: AgentOptions; error?: string }>();
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => load(adapter)).then(
      (options) => { if (active) setResult({ adapter, attempt, options }); },
      (cause: unknown) => { if (active) setResult({ adapter, attempt, error: cause instanceof Error ? cause.message : String(cause) }); },
    );
    return () => { active = false; };
  }, [adapter, attempt, load]);
  const current = result?.adapter === adapter && result.attempt === attempt ? result : undefined;
  return {
    options: current?.options,
    loading: !current,
    error: current?.error,
    refresh: () => setAttempt((value) => value + 1),
  };
}

export function modelTuning(options: AgentOptions | undefined, model: string) {
  const selected = options?.discovery.status === "available"
    ? options.discovery.models.find((entry) => entry.id === model)
    : undefined;
  return {
    efforts: selected?.effortValues ?? options?.effortValues ?? [],
    effortKnown: selected?.effortValues !== undefined,
    fastModeSupported: selected?.fastModeSupported ?? options?.fastModeSupported,
    fastModeKnown: selected?.fastModeSupported !== undefined,
  };
}
