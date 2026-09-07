// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// One vocabulary for time (DR-010 §2): an age always says "ago" and
// carries the absolute moment for the reader who wants it; a duration
// says how long something took. Every surface draws from here so a
// bare "3m" never means two different things on one screen.

/** A moment's age in words: "just now", "3m ago", "2h ago", "5d ago",
 * "3w ago". */
export function relativeAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

/** The compact age for tight chrome (a sidebar row): "now", "3m",
 * "2h", "5d", "3w" — always paired with `absoluteTitle`. */
export function compactAge(at: number, now: number): string {
  const age = relativeAge(at, now);
  return age === "just now" ? "now" : age.replace(" ago", "");
}

/** A span in words: "<1s", "12s", "3m 12s", "2h 5m" — every span the
 * app shows, a tool call's included, so milliseconds never reach the
 * reader. */
export function duration(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/** The absolute moment for a tooltip, in the reader's locale. */
export function absoluteTitle(at: number): string {
  return new Date(at).toLocaleString();
}

/** A message's clock time for its stamp — "5:22 PM", or "17:22" where
 * the locale says so — always paired with `absoluteTitle` for the date. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
