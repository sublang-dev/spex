# META: Specification Format

This component defines how to read specifications using GEARS syntax, per [DR-000](../decisions/000-initial-specs-structure.md#dr-000-initial-specs-structure).

## GEARS Syntax

### META-001

Each specification shall use the [GEARS](https://sublang.ai/ref/gears-ai-ready-spec-syntax) pattern:

```text
[Where <static precondition(s)>] [While <stateful precondition(s)>] [When <trigger>] The <subject> shall <behavior>.
```

Clause keywords and punctuation follow natural language conventions.

| Clause | Purpose | Example |
| ------ | ------- | ------- |
| Where | Static preconditions (features, config) | Where debug mode is enabled |
| While | Stateful preconditions (runtime state) | While the connection is active |
| When | Trigger event (at most one) | When the user clicks submit |
| shall | Required behavior | The form shall validate inputs |

### META-002

Test specifications shall use the same pattern, mapping Given-When-Then:

| GWT | Clause |
| --- | ------ |
| Given | Where + While |
| When | When |
| Then | shall |
