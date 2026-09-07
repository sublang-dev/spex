// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { useState } from "react";
import type { AgentModelOption } from "@sublang/spex-core/protocol";

const CUSTOM = "__spex_custom__";
const fieldClass = "w-full min-w-0 rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900";

/** A real selector prevents misspellings; explicit custom input retains
 * provider aliases and configurations missing from today's catalog. */
export function ModelField({ value, models, onChange, testId, defaultLabel = "Provider default" }: {
  value: string;
  models: readonly AgentModelOption[];
  onChange(value: string): void;
  testId: string;
  defaultLabel?: string;
}) {
  const [custom, setCustom] = useState(false);
  const unlisted = Boolean(value) && !models.some((entry) => entry.id === value);
  const manual = custom || unlisted || models.length === 0;
  return <>
    {models.length > 0 && <select
      aria-label="Model"
      data-testid={`${testId}-select`}
      value={manual ? CUSTOM : value}
      onChange={(event) => {
        if (event.target.value === CUSTOM) setCustom(true);
        else { setCustom(false); onChange(event.target.value); }
      }}
      className={fieldClass}
    >
      <option value="">{defaultLabel}</option>
      {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name === entry.id ? entry.id : `${entry.name} · ${entry.id}`}</option>)}
      <option value={CUSTOM}>Custom model…</option>
    </select>}
    {manual && <input
      aria-label="Custom model"
      data-testid={testId}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={defaultLabel}
      className={fieldClass}
    />}
    {unlisted && models.length > 0 && <span className="text-xs text-neutral-500">Not in this runtime's list. Check the model ID.</span>}
  </>;
}
