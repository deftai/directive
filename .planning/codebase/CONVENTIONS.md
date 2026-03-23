# CONVENTIONS.md — Deft Directive Code Conventions

## Markdown (Primary Product)

**Every framework `.md` file MUST open with:**
```
Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.
```
Use these symbols consistently — no raw "MUST/SHOULD" prose without the symbol prefix.

**Link style:** Use relative paths from the file's own location (e.g., `../strategies/interview.md`).

**File naming:** Lowercase hyphen-separated (e.g., `make-spec.md`, `code-field.md`).

**Cross-references:** Top of file with `**⚠️ See also**: [file](./path)` pattern for related files.

**Where to add new content:**
- New language standard → `languages/{language}.md` (copy an existing one for structure)
- New strategy → `strategies/{name}.md` + register in `strategies/README.md`
- New template → `templates/{name}.md`
- New skill → `skills/{name}/SKILL.md` with YAML frontmatter (`name`, `description`)

---

## Python (`run` script and `tests/`)

**Command functions:** Prefix with `cmd_` (e.g., `cmd_bootstrap`, `cmd_project`, `cmd_spec`).

**Naming:** `snake_case` for all functions, variables, modules. `UPPER_SNAKE_CASE` for constants.

**Type hints:** Required on all function signatures (mypy enforced). Use `List`, `Optional` from `typing` for 3.11 compat.

**Docstrings:** All public functions require a docstring. Format: one-line summary, blank line, Args/Returns if non-trivial.

**User interaction:** Always use `ask_input()`, `ask_choice()`, `ask_confirm()` — never `input()` directly. These are patchable in tests.

**File writes:** Use `_atomic_write(path, content)` for all config file output — never `open().write()` directly.

**Resume support:** Use `_resume_or_ask()` + `_save_progress()` for multi-step questionnaires.

**Line length:** 100 characters (ruff + black).

**Test file naming:** `tests/cli/test_{command}.py` for CLI tests, `tests/content/test_{domain}.py` for content tests.

**Test fixtures:** Add shared fixtures to `tests/conftest.py`. Use `isolated_env` for any test that reads/writes config files.

**Mocking user input:** Use `mock_user_input([...])` fixture — never patch `input()` directly.

---

## Go (`cmd/deft-install/`)

**Naming:** `CamelCase` for exported symbols, `camelCase` for unexported.

**String templates:** Use `const` blocks for multi-line embedded strings (e.g., `agentsMDEntry`).

**Error handling:** Wrap with `fmt.Errorf("context: %w", err)`. Return errors up; only handle at `main()` or `install()`.

**Platform conditionals:** Use `//go:build` or `runtime.GOOS` checks. Windows-specific code in `drives_windows.go`, other platforms in `drives_other.go`.

**Idempotency:** All write operations (AGENTS.md, skill files) MUST check for existing content before writing. Use sentinel strings.

**No external deps:** Keep `go.mod` stdlib-only.

---

## vBRIEF Files

**Location:** Always in `./vbrief/` — never at workspace root.

**Naming:**
- `plan.vbrief.json` — todos, strategy state, chaining
- `specification.vbrief.json` — spec source of truth (draft → approved)
- `continue.vbrief.json` — interruption recovery

**Schema:** Follow `https://github.com/deftai/vBRIEF` spec. Use `blocks` edges for task dependencies (not `[P]`/`[S]`/`[B]` markers).

---

## SKILL.md Files

**Must include YAML frontmatter:**
```yaml
---
name: {skill-name}
description: >-
  One sentence describing when this skill activates.
---
```

**Thin pointer pattern** (for `.agents/skills/`):
```markdown
---
name: deft
description: ...
---

Read and follow: deft/SKILL.md
```

**Root SKILL.md** (`SKILL.md`) is the canonical skill; files under `.agents/skills/` are thin pointers only.
