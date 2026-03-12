# DR-000: Initial Specs Structure

## Status

Accepted

## Context

Projects need a standardized structure and format for specifications to support iterative development and collaboration between AI and humans.

## Decision

Use `boss scaffold` to create the following.

### Records

| Directory | Format | Naming |
| --------- | ------- | ------ |
| decisions/ | [ADR](https://github.com/npryce/adr-tools) (Architectural Decision Record) | `NNN-<kebab-case-title>.md` |
| iterations/ | Goal, deliverables, tasks, verification | `NNN-<kebab-case-title>.md` |

### Specs

Spec files follow [GEARS](https://sublang.ai/ref/gears-ai-ready-spec-syntax) syntax and can be organized hierarchically. Suggested top-level groups:

| Group | Purpose |
| ----- | ------- |
| user/ | What the system does |
| dev/ | How the system is built |
| test/ | Verification criteria |

Naming: `<kebab-case-name>.md`

GEARS pattern:

```text
[Where <static precondition(s)>] [While <stateful precondition(s)>] [When <trigger>] The <subject> shall <behavior>.
```

| Clause | Purpose |
| ------ | ------- |
| Where | Static preconditions (features, config) |
| While | Stateful preconditions (runtime state) |
| When | Trigger event (at most one) |
| shall | Required behavior |

Test specs map Given-When-Then: Given → Where+While, When → When, Then → shall.

### Initial Files

| Path | Content |
| ---- | ------- |
| `spec-map.md` | Spec index for navigation (non-normative) |
| `decisions/000-initial-specs-structure.md` | This DR |
| `iterations/000-spdx-headers.md` | Initial IR |
| `user/meta.md` | GEARS syntax guide |
| `dev/git.md` | Git workflow rules |
| `dev/style.md` | Authoring conventions |
| `test/spdx-headers.md` | SPDX headers verification |

## Consequences

- Consistent structure and format across iterations
- Clear separation of records and specs
- Specs can be grouped hierarchically as needed
