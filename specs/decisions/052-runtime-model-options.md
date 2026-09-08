<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-052: Runtime Model Options

## Status

Accepted.
Amends [DR-019](019-inline-agent-configuration.md), [DR-032](032-session-players.md), and [DR-038](038-history-is-done-work.md): runtime model choices and explicit role fast-mode tuning.

## Context

Free-text models invite spelling errors, and adapter-wide effort lists cannot describe a model's supported settings.
The installed agent runtime and account determine the available choices.

## Decision

- Cligent owns runtime discovery and adapter capabilities; Spex carries its results over the core protocol to every agent and role-binding editor.
- Discovery runs on demand without sending a task or creating a conversation; failure leaves configuration editing available.
- Model choices write the runtime's reported IDs, including aliases, with provider default and explicit custom entry retained.
  An alias's resolved model identifies existing canonical pins without rewriting them.
  Existing values are never silently rewritten because discovery omitted them.
- Known model effort and fast-mode support narrow the editor's choices.
  Cligent's orchestration efforts remain adapter-wide choices.
  Role bindings check inherited tuning too and expose fast-mode inheritance explicitly.
  Missing model metadata remains unknown; adapter-wide options are labeled as such.
- Discovery does not become an online prerequisite for loading or saving shared config.
  Existing launcher validation remains the durable gate.
- Spex's shell dependencies supply SDK runtimes; refresh their lockfile versions to adopt newer runtimes, independently of system CLI installations.

## Consequences

Settings can offer current model IDs without maintaining a second catalog.
A listed model is discovery evidence, not a promise that a later request will succeed.
