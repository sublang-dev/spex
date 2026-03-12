# SPDX: SPDX Headers

## Exclusions

- No comment syntax: e.g., JSON, binaries
- Config: e.g., `.gitignore`, `.editorconfig`, `**/settings.json`, `AGENTS.md`, `.github/workflows/ci.yml`, lock files
- Generated/vendor: e.g., `dist/`, `node_modules/`, vendor directories
- License/legal documents

## SPDX-001: Copyright Header Presence

While the file is git-tracked or `git add`-able, with comment syntax (see [Exclusions](#exclusions)), when checking its first comment block (after shebang if present), the file shall contain `SPDX-FileCopyrightText`.

## SPDX-002: License Header Presence

While the file is git-tracked or `git add`-able, with comment syntax (see [Exclusions](#exclusions)) and one or more license files exist at project root, when checking its first comment block (after shebang if present), the file shall contain `SPDX-License-Identifier`.

### License File Detection

Recognized patterns at project root:

- `LICENSE`, `LICENSE.txt`, `LICENSE.md`, `COPYING`
- `LICENSE-CONTENT`, `LICENSE-APACHE`, etc. (named variants)
- `LICENCE`, `LICENCE.txt` (British spelling)
- `LICENSES/` folder (REUSE convention)
