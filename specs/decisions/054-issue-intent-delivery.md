<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-054: Issue Intent Delivery

## Status

Accepted (2026-09-08).
Amends [DR-035](035-intent-ledger.md)'s issue capture seed only.

## Context

An issue title alone leaves a session's delivery unclear.
A Boss turn runs one playbook, and a CODE implementation phase is accepted only when HEAD advances by one descendant commit before REVIEW runs.
The built-ins have no post-review executor for merging or pulling the default branch.

## Decision

Issue seeds retain their title and canonical URL, adding brief instructions to read the issue and comments, work on a new branch from the current default-branch commit, implement the change, and run relevant checks.
The session pushes that branch and opens a PR against the default branch with a summary, test results, and `Closes #N` in its description, so merging it closes the source issue [[1]].
Delivery stops at opening the PR; the seed requests no merge, pull, or checkout cleanup.
The Boss merges and restores the default-branch checkout, for example with `gh pr merge --delete-branch` [[2]].

## Consequences

Newly queued issues carry the delivery instructions as editable text.
Existing intents and PR or record seeds retain their text.

## References

[1]: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue "Linking a pull request to an issue"
[2]: https://cli.github.com/manual/gh_pr_merge "GitHub CLI: gh pr merge"
