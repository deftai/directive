# CONVENTIONS.md — Deft Directive Code Conventions

## Markdown (Primary Product)

**Every framework `.md` file MUST open with:**
```
Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.
```
Use these symbols consistently — no raw "MUST/SHOULD" prose without the symbol prefix.

**Link style:** Use relative paths from the file's own location (e.g., `../strategies/interview.md`).

**File naming:** Lowercase hyphen-separated (e.g., `make-spec.md`, `code-field.md`).

**Cross-references:** Top of file with `**⚠️ See also**: [file](./relative-path)` pattern for related files.

**Where to add new content:**
- New language standard → `languages/{language}.md` (copy an existing one for structure)
- New strategy → `strategies/{name}.md` + register in `strategies/README.md`
- New template → `templates/{name}.md`
- New skill → `skills/{name}/SKILL.md` with YAML frontmatter (`name`, `description`)

---

## Python (`run` script and `tests/`)

**Command functions:** Prefix with `cmd_` (e.g., `cmd_bootstrap`, `cmd_project`, `cmd_spec`).

**Naming:** `snake_case` for all functions, variables, modules. `UPPER_SNAKE_CASE` for constants.

**Type hints:** Required on all function signatures. `mypy` is enforced on `tests/` only; `run` and `run.py` are excluded from mypy (see CONCERNS.md — Linting Exclusion). Prefer built-in generics (`list[X]`, `dict[K, V]`, `X | None`) available since Python 3.10+; `typing.List` / `typing.Optional` are accepted for consistency with existing code.

**Docstrings:** All public functions require a docstring. Format: one-line summary, blank line, Args/Returns if non-trivial.

**User interaction:** Always use `ask_input()`, `ask_choice()`, `ask_confirm()` — never `input()` directly. These are patchable in tests.

**File writes:** Use `_atomic_write(path, content)` for all config file output — never `open().write()` directly.

**Resume support:** Use `_resume_or_ask()` + `_save_progress()` for multi-step questionnaires.

**Line length:** 100 characters (ruff + black). Note: `run` is excluded from both ruff and black (see CONCERNS.md — Linting Exclusion); line-length is a convention, not an enforced gate, for code in `run`.

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

**Schema:** Follow `https://github.com/deftai/vBRIEF` spec. Use `blocks` edges in `plan.vbrief.json` (outbound: "task A blocks task B"). Use `dependencies` in `specification.vbrief.json` (inbound: "task B depends on task A"). Both express the same relationship from different perspectives. Do not use `[P]`/`[S]`/`[B]` markers.

**Required top-level fields (in order):**
- `"vbrief": "0.5.0"` — schema version (must be first field)
- `"plan"` — spec/plan name
- `"status"` — document lifecycle state:
  - `specification.vbrief.json`: `draft` | `proposed` | `approved`
  - `plan.vbrief.json`: `pending` | `completed`

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

---

## Review Workflow (Bot Reviewers)

This project uses Greptile for automated PR review. Follow these conventions to avoid fix→review→fix loops:

**Preflight validation — run before every commit that touches structured data:**
```bash
# Unix (bash/zsh)
python -m json.tool vbrief/specification.vbrief.json > /dev/null
python -m json.tool vbrief/plan.vbrief.json > /dev/null

# PowerShell
python -m json.tool vbrief/specification.vbrief.json > $null
python -m json.tool vbrief/plan.vbrief.json > $null
```
Do not push until all vBRIEF JSON files parse cleanly.

**Batch fixes, never drip-feed:**
- Collect ALL bot reviewer findings before making any edits.
- For each finding, grep the term/value across the full PR file set (SPECIFICATION.md, vbrief/*.json, PRD.md, CONVENTIONS.md, research docs) and fix every occurrence in the same commit.
- Do a cross-file consistency audit before pushing: verify shared terms (status enums, task IDs, field names, acceptance criteria) match across all files.

**Cross-file consistency checklist (spec PRs):**
- vbrief/specification.vbrief.json ↔ SPECIFICATION.md (rendered output must match source)
- vbrief/specification.vbrief.json ↔ PRD.md (traces, requirement IDs, enum values)
- vbrief/*.json ↔ CONVENTIONS.md (required fields, schema rules)
- Narrative ↔ acceptance criteria within each task (no contradictions)

**Review timing:**
- After pushing fixes, wait for the bot to review the latest commit before re-triggering.
- Do not re-trigger while the bot's last review targets an older commit.
