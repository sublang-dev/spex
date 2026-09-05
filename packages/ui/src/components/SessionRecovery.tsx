// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { useEffect, useRef, useState } from "react";
import { InlineConfirm } from "./InlineConfirm.js";

type Action = "retry" | "discard";

export function SessionRecovery({ input, connected, onRecover }: {
  input: string;
  connected: boolean;
  onRecover?: (action: Action) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<Action>();
  const [pending, setPending] = useState<Action>();
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const controls = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Action | undefined>(undefined);
  useEffect(() => {
    if (!confirm && returnFocus.current) {
      controls.current?.querySelector<HTMLButtonElement>(`[data-action="${returnFocus.current}"]`)?.focus();
      returnFocus.current = undefined;
    }
  }, [confirm]);

  async function recover(action: Action) {
    if (busy.current || !connected || !onRecover) return;
    busy.current = true;
    setPending(action);
    setConfirm(undefined);
    setError(undefined);
    try {
      await onRecover(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  }

  return (
    <section aria-label="Interrupted turn" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950">
      <p className="font-medium">Interrupted turn</p>
      <details className="my-1" open>
        <summary>Saved input</summary>
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{input}</p>
      </details>
      {error ? <p role="alert" className="my-2 text-red-700 dark:text-red-300">{error}</p> : null}
      {pending ? <p role="status">{pending === "retry" ? "Retrying…" : "Discarding…"}</p> : null}
      <div ref={controls}>
        {confirm ? (
          <InlineConfirm
            question={confirm === "retry"
              ? "Retry the saved input with its saved configuration after checking completed work?"
              : "Discard this attempt? The previous checkpoint is restored only if no effects were added. A fresh session may be removed."}
            confirmLabel={confirm === "retry" ? "Retry" : "Discard"}
            disabled={!connected || !!pending || !onRecover}
            onConfirm={() => void recover(confirm)}
            onCancel={() => { returnFocus.current = confirm; setConfirm(undefined); }}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {(["retry", "discard"] as const).map((action) => (
              <button
                type="button"
                key={action}
                data-action={action}
                disabled={!connected || !!pending || !onRecover}
                onClick={() => setConfirm(action)}
                className="min-h-6 rounded border border-neutral-400 px-2 py-1 disabled:opacity-40 dark:border-neutral-600"
              >{action === "retry" ? "Retry" : "Discard"}</button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
