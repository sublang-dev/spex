// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { SessionInfo } from "@sublang/spex-core/protocol";

/** A project's current conversation, derived exactly as the core derives
 * its lane (core-service-93, DR-051): the live session — a turn in
 * flight or settling — else the most recently active session that
 * continues and no other host owns. */
export function currentSessionOf(
  sessions: readonly SessionInfo[],
  projectId: string,
): SessionInfo | undefined {
  const own = sessions.filter((session) => session.projectId === projectId);
  return (
    own.find((session) => session.live) ??
    own
      .filter((session) => session.continuable && !session.externalWriter)
      .sort(
        (a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt),
      )[0]
  );
}

/** History the core cannot continue: read-only, and named so. */
export function isHistory(session: SessionInfo): boolean {
  return (
    !session.live &&
    !session.continuable &&
    !session.externalWriter &&
    !session.recovery
  );
}
