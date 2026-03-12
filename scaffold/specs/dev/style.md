# STYLE: Authoring Conventions

This component defines authoring conventions, per [DR-000](../decisions/000-initial-specs-structure.md#dr-000-initial-specs-structure).

## Spec Format

### STYLE-001

Each spec file shall be named `<kebab-case-name>.md`.

### STYLE-002

Each item ID shall follow `<COMP>-NNN` format (e.g., AUTH-001, SPDX-003) as a markdown heading for anchor linking.

### STYLE-003

Each item shall use GEARS syntax per [META-001](../user/meta.md#meta-001) and be self-contained:

- No implicit dependency on sibling or containing sections;
- May rely on its own subsections for details;
- Cross-references to other specs or shared sections are allowed.

### STYLE-004

Item IDs shall not be modified once committed; new items shall use higher IDs.

## Record Format

### STYLE-005

Decision records shall follow [ADR](https://github.com/npryce/adr-tools) format with Status, Context, Decision, and Consequences sections, written concisely.

### STYLE-006

When references are appropriate, decision records shall cite authoritative sources (e.g., official docs) with numbered markers (e.g., `[1]`) linked to specific URLs in a `## References` section that has no uncited entries.

### STYLE-007

Iteration records shall include Goal, Deliverables, Tasks, and Verification sections.

## Cross-References

### STYLE-008

Cross-references to specific items shall use relative links with anchors (e.g., `[STYLE-001](style.md#style-001)`).

### STYLE-009

Iterations shall not be cited by decisions or specs.

### STYLE-010

Test specs shall not be cited by other specs.
