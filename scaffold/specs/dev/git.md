# GIT: Git Workflow

This component defines git workflow rules for the project.

## Commits

### GIT-001

The AI agent shall verify `user.name` and `user.email` are configured before committing.

### GIT-002

Each commit message shall use `<type>(<scope>)<!>: <subject>` format, where `<scope>` is optional, `!` is included for breaking changes, `<type>` is one of `feat|fix|docs|style|refactor|test|ci|build|perf|chore`, and `<subject>` is imperative, ≤50 chars, with no trailing period.

### GIT-003

The commit body shall explain what/why (not how), wrap at 72 chars, and use bullets if clearer.

### GIT-004

When AI assists in coding or authoring, the message shall include a `Co-authored-by` trailer in the format `<model> (<role>) <email>`, where `<role>` is one of `coder|reviewer|maintainer` and `<email>` is `cligent@sublang.ai`.

Example: `Co-authored-by: GPT-5.2-Codex (coder) <cligent@sublang.ai>`
