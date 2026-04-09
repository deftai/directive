# CONCERNS.md — Deft Directive Technical Debt & Risks

## Large Files

- **`run`** — 3000+ lines, monolithic Python CLI. All commands (`cmd_bootstrap`, `cmd_project`, `cmd_spec`, etc.) live in one file. Makes it hard to test in isolation and adds lint exclusion (`run` excluded from ruff). Candidate for splitting into `run_core.py` + per-command modules.
- **`tests/content/snapshots/baseline.json`** — ~14,000+ lines snapshot file. Any change to `.md` content requires regenerating this file. High maintenance cost when adding new framework files.

## Coverage Gap

- `pyproject.toml` sets `fail_under = 75` — below the stated 85% project standard.
- `run` (the primary CLI) is **excluded from coverage measurement** (`omit = ["run", "run.py"]`), meaning the most important file has no coverage enforcement.
- `run.py` (importlib shim) is also excluded.

## Linting Exclusion

- `run` is excluded from ruff lint and black format (`exclude = ["run"]` in pyproject.toml).
- This means the primary CLI bypasses all automated style/quality checks.

## Importlib Test Shim

- `run.py` at repo root is an importlib shim that loads the extension-less `run` file for the test suite.
- Tests must use `deft_run_module` (not `deft_module`) when monkeypatching module-level globals.
- This indirect loading makes tracing test failures to source lines harder.

## Version Drift

- Three separate version numbers exist: `VERSION=0.5.2` (Taskfile), `version = "0.5.0"` (pyproject.toml), `VERSION = "0.4.2"` (`run` script), and the Go installer has its own version set at build time.
- No single source of truth for version.

## Legacy Paths

- `USER.md` and `PROJECT.md` are legacy locations — both still referenced in `main.md` and `SKILL.md` as fallback paths. Code in `run` also has `_legacy_user_path()` and `_legacy_project_path()` helpers.
- These add complexity to path resolution; could be removed in a future breaking version.

## Missing Test Coverage Areas

- `cmd/deft-install/` Go code — no automated tests visible in the test suite except `main_test.go`; integration-level testing may be incomplete.
- TUI mode (`textual` path in `run`) — not easily testable in CI without a real terminal.
- Resume/progress file behavior — partial coverage (test_resume.py exists but edge cases may be missing).

## Stubs / Placeholders

- `templates/specification.md` contains only `see ../SPECIFICATION.md` — effectively a redirect stub with no content.
- `specs/testbed/SPECIFICATION.md` is a testbed fixture, not production content — could be confused with real specs.
