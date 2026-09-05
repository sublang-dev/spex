<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Synchronize Spex home with Git

Use a built Spex checkout and one branch per device. Desktop and CLI on a device share that branch. Complete storage migration before the first commit; Spex writes `.gitignore` and `.gitattributes` for the portable format.

Stop the desktop/server core and all CLI sessions before committing, checking out or merging stored data. Run each session on only one device at a time. The commands below operate locally; use ordinary Git fetch/push for transport.

```sh
cd ~/.spex
umask 077

git fetch origin
node /path/to/spex/scripts/storage-git.mjs --home . plan HEAD origin/main
git merge --no-commit --no-ff origin/main
```

The plan compares both revisions with their common ancestor. Each `sessions/<id>` entry is one manifest/replay pair; a configuration file, project registry or intent log is one separate entry. A `conflict` requires an explicit choice even if Git reports a clean text merge.

While the merge is pending, choose each conflicting entry and apply the validated selection:

```sh
node /path/to/spex/scripts/storage-git.mjs --home . select \
  sessions/<session-id>=theirs \
  intents/<project-id>.jsonl=ours

git diff --cached
git commit
```

Omit choices for entries that changed on only one side or agree. `select` applies those entries automatically, validates the complete candidate, takes the home and session leases, then stages each selected file. A session is selected or deleted as a pair. Replaced sessions lose local hints and viewed markers. No history is combined or discarded outside Git; the unselected revision remains available there.

Validation failure leaves the selected files unapplied. Resolve the reported issue or use `git merge --abort`. A filesystem failure during application may leave an incomplete merge; run `select` again before reopening. Never bypass a held or unverifiable lease.

After an ordinary checkout or fast-forward, validate before reopening:

```sh
node /path/to/spex/scripts/storage-git.mjs --home . validate
```

Validation tightens safe session permissions, rejects malformed data or mismatched replay bytes, and reports missing project bindings. With the core stopped, bind an existing project ID to its local repository root:

```sh
node /path/to/spex/scripts/storage-git.mjs --home . rebind <project-id> /local/repository \
  --alias /recorded/repository
```

Repeat `--alias` for other recorded paths. Omit it to retain existing aliases; supplied aliases replace that list. If Git selection removed the registration, add `--revision <ancestor>` to restore that ID's exact registry entry from a chosen ancestor of the current branch. The command rescans history and reports remaining unresolved bindings. Aliases associate history with projects; they do not relocate checkpoints.

**Different repository or module paths permit history only under schema 7.** Git does not undo external actions; continuation still requires repository/effect reconciliation.

For Library entries, retain the authored `<id>.md`, the compiler's `<id>.ts` and `<id>.playbook/` files, and Spex's `<id>.registry.ts`. Spex can rebuild omitted `<id>.registry.mjs` and `<id>.fsm.bundle.mjs` files locally from those inputs. Missing or incompatible inputs leave the playbook unavailable with a reason; no model call runs automatically to replace them.

See the [catalog](storage.md) for file ownership and the [storage contract](../specs/packages/storage.md) for exact validation and selection rules.
