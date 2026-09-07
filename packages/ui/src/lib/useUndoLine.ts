// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The Undo line behind a one-click removal (dashboard-29,
// run-view-114): "Removed “…” — Undo" stands six seconds, then lapses
// on its own. Its control takes focus only from a keyboard-driven
// removal — the removed control took the keyboard's place with it, and
// a keyboard user on Undo is never raced — while a pointer removal
// leaves the pointer where it is, so the line lapses on schedule and a
// removal never reads as a prompt still waiting for an answer.

import { useEffect, useRef, useState } from "react";

/** How long a removal stays undoable. */
export const UNDO_MS = 6_000;

/** A removal's click is keyboard-driven when the activating event
 * carries no pointer click count — Enter or Space on the control. */
export function activatedByKeyboard(event: { detail: number }): boolean {
  return event.detail === 0;
}

export function useUndoLine<T extends { error?: string }>() {
  const [removed, setRemoved] = useState<T>();
  const [byKeyboard, setByKeyboard] = useState(false);
  const undoRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Longer while its control holds focus: a keyboard user reading
      // the line is never raced.
      if (document.activeElement === undoRef.current) {
        arm();
        return;
      }
      setRemoved(undefined);
    }, UNDO_MS);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // The removed control took the keyboard's place with it; Undo is
  // the next sensible place for it. A pointer removal moves nothing.
  useEffect(() => {
    if (removed && !removed.error && byKeyboard) undoRef.current?.focus();
  }, [removed, byKeyboard]);

  /** Show the line for a removal, armed to lapse. */
  const show = (value: T, options: { byKeyboard: boolean }) => {
    setByKeyboard(options.byKeyboard);
    setRemoved(value);
    arm();
  };
  /** Take the line down now — Undo pressed, or its work superseded. */
  const dismiss = () => {
    if (timer.current) clearTimeout(timer.current);
    setRemoved(undefined);
  };

  return { removed, undoRef, show, dismiss };
}
