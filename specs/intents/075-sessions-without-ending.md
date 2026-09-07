<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-075: Sessions Without Ending

## Status

Done (2026-09-07)

## Intent

Answer the owner's four points in one pass: settings re-read after each turn, the Captain row in Settings shaped like a player's, an Up next removal that visibly lands, and no ending concept once a message continues a session — per [DR-051](../decisions/051-runtime-held-for-a-turn.md).

## Deliverables

- [x] The core releases a session's runtime when its turn settles behind the continuable guard, projects the current config onto a stored session's members with named drift, folds each project's current conversation as its lane, and refuses by name while a turn is in flight.
- [x] The run view loses the End control, confirm, and ended notice; tabs, rows, and headers name only history; the Now band and intent staging follow the current conversation; queued messages dispatch after settlement; the send reads "Sending…".
- [x] Settings shows the Captain as a collapsed row with the players' edit toggle, the shared editor closing on Save or Cancel, one open editor at a time.
- [x] A pointer removal of an Up next intent leaves focus alone so the Undo line lapses on schedule, on the Captain home and the Dashboard alike.

## Tasks

1. Specs: DR-051 with its reciprocal links; core-service, run-view, dashboard, projects, app-shell, settings items.
2. Core: release at settle, member narrowing and drift naming, current-conversation lanes, pause-aware fold, reload awaited, busy wording.
3. UI: End removal and vocabulary, sidebar ordering and marks, Now band and staging, queued dispatch, Sending…, Settings rows, Undo line hook.
4. Tests and journeys: core, UI, and the four browser journeys that ended sessions; the smoke driver and release smoke doc.

## Verification

- `npm test -w packages/core`, `npm test -w packages/ui`, `npm run e2e` (hermetic lane), `spex lint`.
- On a scratch server shell with the real Captain shell over fake adapters: a settled session's dispose leaves its manifest bytes and provider hints bound; on the demo shell, a pointer Remove on the Up next card lapses within six seconds, and the Captain row opens and cancels its editor in place.
