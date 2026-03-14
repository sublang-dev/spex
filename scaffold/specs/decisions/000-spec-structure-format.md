# DR-000: Spec Structure and Format

## Status

Accepted

## Context

Specifications (specs) need a standardized format and structure to support iterative development and collaboration between AI and humans.

## Decision

### Elements

Spex organizes specs around three essential elements of software development:

- **Decisions**. The choices made in product and system *design*.
- **Iterations**. The incremental plans for *implementation*.
- **Requirements**. The *behaviors* and *constraints* of the product and system.

### Forms

Spex uses two forms of specs to balance unification and flexibility.

- **Records** must follow specified formats and may use free-form content within those formats.
Decisions and iterations are stored as records.
  - Decision records (DRs) follow the ADR (Architectural Decision Record) format [[1]].
  - Iteration records (IRs) contain four sections: Goal, Deliverables, Tasks, and Acceptance criteria.
- **Items** must follow the GEARS pattern [[2]] to specify requirements and constraints.
Each item file must include an intent statement.

### Organization

Spex creates the default `specs/` directory under the repo root, with the following subdirectories and files.

| Path | Content | File Naming |
| --------- | ------- | ------ |
| `decisions/` | DRs | \<NNN\>-\<kebab-case\>.md |
| `iterations/` | IRs | \<NNN\>-\<kebab-case\>.md |
| `items/` | item files | [\<path\>/]\<kebab-case\>.md |
| `map.md` | spec index for navigation | - |
| `meta.md` | the spec of specs | - |

### Item groups

Item files are grouped into three subdirectories under `items/`:

| Subdirectory | Purpose |
| ----- | ------- |
| `user/` | What the system does. User-visible behavior. |
| `dev/` | How the system is built. Not user-visible. |
| `test/` | Acceptance testing. Each item cites the user or dev item it tests. |

### Item syntax

A spec item must follow the GEARS syntax:

```text
[Where <static precondition(s)>] [While <stateful precondition(s)>] [When <trigger>] The <subject> shall <behavior>.
```

| Keyword | Purpose |
| ------ | ------- |
| Where | Static preconditions (features, config) |
| While | Stateful preconditions (runtime state) |
| When | Trigger event (at most one) |
| shall | Required behavior |

For test specs, Given-When-Then maps to: Given → Where+While, When → When, Then → shall.

### Spec packages

A spec package is a coherent set of spec items for a *single* intent.
It is the basic unit for spec composition, reuse, and extension.

A spec package consists of one to three coordinated item files sharing the same relative path and basename.
The item files are located in `user/`, `dev/`, or `test/` according to which [groups](#item-groups) they belong to.

For example, a spec package for generating short URLs may be named `gen-url` and consist of:

- `items/user/signing/gen-url.md` for user-facing behaviors (e.g., basic operations, URL format)
- `items/dev/signing/gen-url.md` for internal-implementation behaviors (e.g., algorithms)
- `items/test/signing/gen-url.md` for tests covering the corresponding user and dev items

Here, `signing/` is a local collection of related spec packages for development convenience.

`map.md` organizes item files by package.

### Citations

DRs and items are persistent and may cite each other.
IRs may be temporary and must not be cited by DRs or items.
`map.md` may cite IRs, as it indexes all spec files and is kept in sync as files change.

## Consequences

- Consistent structure and format across development cycles
- Clear positions of directories and files
- Flexible expression of design and implementation

## References

[1]: https://github.com/npryce/adr-tools "ADR Tools"
[2]: https://sublang.ai/ref/gears-ai-ready-spec-syntax "GEARS: AI-Ready Spec Syntax"
