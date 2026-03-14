# META: Spec Definition

## Intent

This spec defines the structure and organization of specifications (specs), per [DR-000](decisions/000-spec-structure-format.md).

## Organization

### META-1

The `specs/` directory shall contain the following subdirectories and files:

| Path | Content | File Naming |
| --------- | ------- | ------ |
| `decisions/` | Decision records (DRs) | \<NNN\>-\<kebab-case\>.md |
| `iterations/` | Iteration records (IRs) | \<NNN\>-\<kebab-case\>.md |
| `items/` | item files | [\<path\>/]\<kebab-case\>.md |
| `map.md` | spec index for navigation with item files organized by packages | - |
| `meta.md` | the spec of specs | - |

### META-2

Item files shall be grouped into three subdirectories under `items/`:

| Subdirectory | Purpose |
| ----- | ------- |
| `user/` | What the system does. User-visible behavior. |
| `dev/` | How the system is built. Not user-visible. |
| `test/` | Acceptance testing. Each item cites the user or dev item it tests. |

### META-3

Each item file shall include an `## Intent` section stating its purpose.

## Record format

### META-4

Each decision record (DR) shall follow the ADR format [[2]] with the following sections: Status, Context, Decision, and Consequences.

### META-5

Each iteration record (IR) shall contain the following sections: Goal, Deliverables, Tasks, and Acceptance criteria.

## Item syntax

### META-6

Each spec item shall use the GEARS pattern [[1]]:

```text
[Where <static precondition(s)>] [While <stateful precondition(s)>] [When <trigger>] The <subject> shall <behavior>.
```

Clauses and punctuation shall follow standard English conventions.

| Clause | Purpose | Example |
| ------ | ------- | ------- |
| Where | Static preconditions (features, config) | Where debug mode is enabled |
| While | Stateful preconditions (runtime state) | While the connection is active |
| When | Trigger event (at most one) | When the user clicks submit |
| shall | Required behavior | The form shall validate inputs |

### META-7

Where test cases are expressed by Given-When-Then (GWT), their spec items shall map GWT to GEARS [[1]]:

| GWT | Clause |
| --- | ------ |
| Given | Where + While |
| When | When |
| Then | shall |

### META-8

Each item shall be self-contained:

- It shall have no implicit dependency on sections other than its own subsections.
- Citations to other specs or shared sections shall be explicit.

## Spec packages

### META-9

A spec package shall consist of one to three coordinated item files sharing the same relative path and basename under `user/`, `dev/`, or `test/`.

### META-10

A spec package shall have a basename \<kebab-case\>.md unique within `specs/items/`, with a short form \<ALLCAPS\>.

Example. `package-management.md` has short form `PKGMGT`.

### META-11

Each item shall have an ID unique within the repo, following \<PACK\>-\<N...\> format (e.g., AUTH-11, URL-3) as a markdown heading for anchor linking.

Note. \<PACK\> refers to the short form of the package name.

### META-12

Item IDs shall not be modified once committed; new items shall use higher IDs per package.

### META-13

A spec package shall define a closed set of subjects and their behaviors for a single intent. The shall clause (see [META-6](#meta-6)) of any item shall only involve subjects and behaviors within its own package.

### META-14

The precondition and trigger clauses (Where, While, When; see [META-6](#meta-6)) of items shall be allowed to reference subjects and behaviors from other spec packages.

## Citation

### META-15

Citations to specific items shall use relative links with anchors (e.g., `[META-1](meta.md#meta-1)`).

### META-16

DRs and items shall be allowed to cite each other.

### META-17

IRs shall not be cited by any spec except `map.md`.

### META-18

External references in specs shall cite authoritative sources (e.g., official docs) with numbered markers (e.g., `[[1]]`) linked to specific URLs in a `## References` section that shall have no uncited entries.

## References

[1]: https://sublang.ai/ref/gears-ai-ready-spec-syntax "GEARS: AI-Ready Spec Syntax"
[2]: https://github.com/npryce/adr-tools "ADR Tools"
