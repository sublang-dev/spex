# Spec Map

Quick-reference guide for AI agents to locate the right spec file.
Spec files are source of truth.

## Layout

```text
decisions/   Architectural decision records (DR-NNN)
iterations/  Iteration records (IR-NNN)
dev/         Implementation requirements
user/        User-facing behavior
test/        Verification criteria
```

Specs use GEARS syntax ([META-001](user/meta.md#meta-001)).
Authoring rules: [dev/style.md](dev/style.md).

## Decisions

| ID | File | Summary |
| --- | --- | --- |
| DR-000 | [000-initial-specs-structure.md](decisions/000-initial-specs-structure.md) | Specs directory layout, GEARS syntax, naming conventions |

## Iterations

| ID | File | Goal |
| --- | --- | --- |
| IR-000 | [000-spdx-headers.md](iterations/000-spdx-headers.md) | Add SPDX headers to applicable files |

## Spec Files

### `dev/`

| File | Summary |
| --- | --- |
| [git.md](dev/git.md) | Commit message format and AI co-authorship trailers |
| [style.md](dev/style.md) | Spec naming, ID format, GEARS syntax, cross-refs, record format, and SPDX headers |

### `user/`

| File | Summary |
| --- | --- |
| [meta.md](user/meta.md) | GEARS syntax definition and test-spec mapping |

### `test/`

| File | Summary |
| --- | --- |
| [spdx-headers.md](test/spdx-headers.md) | Copyright and license header presence checks |
