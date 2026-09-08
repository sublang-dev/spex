// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// An anchored popover lies inside the box that must show it (DR-041
// §9): a dialog sized against nothing and pinned to a small anchor
// hangs out of its pane, and left or upward overflow never becomes
// scrollable, so what leaves the box is unreachable. The box is the
// nearest ancestor that clips — a surface's own scroll box — else the
// window. Placement is measured, not a width hook: the popover keeps
// one shape at every width and is moved to a place that can show it.

import { useLayoutEffect, type RefObject } from "react";

/** Breathing room between a popover and the edge of its box. */
export const POPOVER_INSET = 8;

export interface FitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How far a box must move along each axis to lie inside `bounds`.
 * A box wider or taller than the room lands on the leading edge, so
 * its start — the side a reader reads from — is never the part cut. */
export function fitOffset(
  box: FitRect,
  bounds: FitRect,
  inset = POPOVER_INSET,
): { dx: number; dy: number } {
  const shift = (
    start: number,
    size: number,
    boundStart: number,
    boundSize: number,
  ): number => {
    const min = boundStart + inset;
    const max = boundStart + boundSize - inset;
    const over = start + size - max;
    const moved = over > 0 ? start - over : start;
    return (moved < min ? min : moved) - start;
  };
  return {
    dx: shift(box.left, box.width, bounds.left, bounds.width),
    dy: shift(box.top, box.height, bounds.top, bounds.height),
  };
}

/** The box that must show `el`: the nearest ancestor that clips, else
 * the window. */
function boundsOf(el: HTMLElement): FitRect {
  const view = el.ownerDocument.defaultView;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (!style) break;
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      const box = node.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    }
  }
  const root = el.ownerDocument.documentElement;
  return { left: 0, top: 0, width: root.clientWidth, height: root.clientHeight };
}

/**
 * Keep the popover on `ref` inside the box that must show it: bound
 * its width and height to that box — it scrolls its own content when
 * the box is the shorter of the two — and move it off the edge it
 * would otherwise cross. A document that cannot measure layout is
 * left with the stylesheet's own bounds.
 */
export function useFitInBox<T extends HTMLElement>(ref: RefObject<T | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = (): void => {
      el.style.maxWidth = "";
      el.style.maxHeight = "";
      el.style.transform = "";
      const bounds = boundsOf(el);
      if (bounds.width <= 0 || bounds.height <= 0) return;
      el.style.maxWidth = `${Math.max(bounds.width - POPOVER_INSET * 2, 0)}px`;
      el.style.maxHeight = `${Math.max(bounds.height - POPOVER_INSET * 2, 0)}px`;
      // Read after the bounds land: a right-anchored box moves its
      // own left edge as it narrows, so the shift is measured from
      // the box the reader will actually see.
      const box = el.getBoundingClientRect();
      const { dx, dy } = fitOffset(
        { left: box.left, top: box.top, width: box.width, height: box.height },
        bounds,
      );
      if (dx !== 0 || dy !== 0) el.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    fit();
    const view = el.ownerDocument.defaultView;
    // Discovery and editable fields can grow an already-open dialog.
    // Fitting keeps the same size cap and only translates its position,
    // so observing the resulting size does not feed back on placement.
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(fit);
    observer?.observe(el);
    view?.addEventListener("resize", fit);
    return () => {
      observer?.disconnect();
      view?.removeEventListener("resize", fit);
    };
  }, [ref]);
}
