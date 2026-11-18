section: Fixed
- Setup no longer writes `.deft/core` lines into `.gitattributes`, and `directive upgrade`, `directive install --repair` and automatic setup now remove the `.deft/core` lines Directive wrote earlier in `.gitattributes`, `.prettierignore`, `greptile.json` and the CodeQL config. Files are kept; every other line stays; changed files are listed for review (#5961).
- The managed `.gitattributes` block now keeps the Claude, Codex and Cursor hook files (`deft-hook-*.mjs`) on LF line endings, so Windows checkouts match (#6167).
- If a project already has a `.prettierignore`, setup adds `**/deft-hook-*.mjs` so the committed hook files don't fail the formatter check. UPGRADING explains the matching ESLint ignore (#6167).
- This repository now commits the managed `.gitattributes` block like any project, and the special case that skipped it here is removed, so worker worktrees stay clean (#6256).
