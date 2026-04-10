# Deft Directive — Testbed Phase 1 SPECIFICATION

## Overview

Establish a QA testbed for the Deft Directive repo that regression-tests both the `run`
Python CLI and the framework's `.md` content integrity. The testbed runs locally as a
pre-commit gate (`task check`) and is designed to catch regressions whenever new features
are added. CI (GitHub Actions) is deferred — see `todo.md`.

**Surfaces covered:**
- **CLI surface** — the `run` Python script (~2300 lines), core commands only
- **Content surface** — all `.md` files: structure, standards compliance, cross-file contracts,
  and content shape (required sections per file type)

**Not in scope for Phase 1:**
- GitHub Actions CI (deferred — see `todo.md`)
- CLI commands beyond core four: `spec`, `install`, `reset`, `update` (deferred)
- Error/edge case testing (deferred)
- LLM-semantic content validation (out of scope — shape/pattern checks only)

---

## Architecture

```
tests/
├── cli/                  # pytest tests for run script core commands
│   ├── test_bootstrap.py
│   ├── test_project.py
│   ├── test_validate.py
│   └── test_doctor.py
├── content/              # framework integrity checks
│   ├── test_structure.py     # file/dir existence checks
│   ├── test_standards.py     # RFC2119 notation, deprecated path patterns
│   ├── test_contracts.py     # REFERENCES.md, strategy index, See also links
│   ├── test_shape.py         # required sections per file type
│   └── snapshots/            # auto-generated baseline fixtures
│       └── baseline.json     # captured state of current beta
└── fixtures/             # shared mock configs, temp dirs, test helpers
    ├── conftest.py
    └── mock_configs/
```

**Python toolchain:** `pyproject.toml` with `uv`, pytest, pytest-cov, ruff, mypy, black.
All consistent with `languages/python.md` standards.

**Taskfile integration:** `task test`, `task test:coverage`, `task check` updated to
include the test suite.

---

## Implementation Plan

---

### Phase 1: Python Project Foundation
*No dependencies — start here first.*

#### Subphase 1.1: pyproject.toml Setup
**Task 1.1.1** — Create `pyproject.toml`
- Add `[project]` with `requires-python = ">=3.11"`
- Add `[project.optional-dependencies] dev` with: pytest≥7.4, pytest-cov≥4.1,
  pytest-mock≥3.12, ruff≥0.1, black≥23, mypy≥1.7
- Add `[tool.pytest.ini_options]` with testpaths=["tests"],
  addopts="--cov=. --cov-report=term-missing"
- Add `[tool.coverage.report]` fail_under=75
- Add `[tool.ruff]` and `[tool.black]` consistent with python.md standards
- Dependencies: none
- Acceptance: `uv sync` installs all dev deps without error;
  `python -m pytest --collect-only` finds tests directory

**Task 1.1.2** — Create `tests/fixtures/conftest.py`
- Shared pytest fixtures: `tmp_project_dir` (temp dir with minimal deft structure),
  `deft_root` (Path to repo root), `mock_user_config` (temp USER.md)
- Dependencies: Task 1.1.1
- Acceptance: `pytest tests/fixtures/` runs without import errors

---

#### Subphase 1.2: Test Directory Scaffold
**Task 1.2.1** — Create directory structure and `__init__.py` files
- Create `tests/`, `tests/cli/`, `tests/content/`, `tests/content/snapshots/`,
  `tests/fixtures/`, `tests/fixtures/mock_configs/`
- Add `__init__.py` to each
- Dependencies: none (can run parallel with 1.1.1)
- Acceptance: all directories exist; `pytest --collect-only` exits 0

---

### Phase 2: Content Integrity Suite
*Depends on: Phase 1 complete*

#### Subphase 2.1: Baseline Snapshot Tool
**Task 2.1.1** — Implement `tests/content/snapshots/capture.py`
- Script that walks the repo and captures: list of all `.md` files, top-level
  section headers per file (lines starting `#`/`##`), all internal markdown links
  `[text](path)` extracted per file
- Outputs `tests/content/snapshots/baseline.json`
- Dependencies: Phase 1
- Acceptance: `python tests/content/snapshots/capture.py` produces valid JSON;
  `baseline.json` contains entries for all current `.md` files

**Task 2.1.2** — Run baseline capture and commit `baseline.json`
- Execute capture script against current beta state
- Manually annotate known-bad entries in a `known_failures.json` alongside baseline
  (e.g. deprecated name references, leaked project config in core/project.md) so tests can
  skip or xfail these without blocking
- Dependencies: Task 2.1.1
- Acceptance: `baseline.json` committed; `known_failures.json` documents at minimum:
  README.md deprecated name references, core/project.md leaked config content

---

#### Subphase 2.2: Structural Checks
*Depends on: Subphase 2.1*

**Task 2.2.1** — Implement `tests/content/test_structure.py`
- Assert required top-level directories exist: `coding/`, `context/`, `contracts/`,
  `core/`, `deployments/`, `interfaces/`, `languages/`, `meta/`, `resilience/`,
  `scm/`, `strategies/`, `swarm/`, `templates/`, `tools/`, `vbrief/`, `verification/`
- Assert required root files exist: `main.md`, `README.md`, `REFERENCES.md`,
  `CHANGELOG.md`, `LICENSE.md`, `Taskfile.yml`, `run`, `run.bat`
- Assert strategy files listed in `strategies/README.md` table exist on disk
  (currently `rapid.md` and `enterprise.md` are absent — mark as xfail)
- Dependencies: Subphase 2.1
- Acceptance: all present-file assertions pass; absent-file assertions are xfail with
  documented reason

---

#### Subphase 2.3: Standards Compliance Checks
*Depends on: Subphase 2.1*

**Task 2.3.1** — Implement `tests/content/test_standards.py`
- RFC2119 check: every `.md` file in `languages/`, `interfaces/`, `tools/`, `strategies/`,
  `context/`, `verification/`, `resilience/` must contain the Legend line
  `!=MUST, ~=SHOULD` (or equivalent symbol set)
- Deprecated path check: no `.md` file should contain the legacy `core/` user config path
  (canonical path is `~/.config/deft/USER.md`); xfail known exceptions
- Deprecated name check: files outside `old/` should not contain the pre-rename project name
  (case-insensitive); flag README.md as xfail known failure
- Dependencies: Subphase 2.1
- Acceptance: all non-xfail assertions pass; xfail list matches `known_failures.json`

---

#### Subphase 2.4: Contract Checks
*Depends on: Subphase 2.1*

**Task 2.4.1** — Implement `tests/content/test_contracts.py`
- REFERENCES.md check: every file linked in REFERENCES.md exists on disk
- Strategy index check: every file linked in `strategies/README.md` exists
  (xfail: `rapid.md`, `enterprise.md`)
- `⚠️ See also` link check: extract all `See also` links from all `.md` files,
  assert each target path resolves
- `discuss.md` check: assert `strategies/discuss.md` IS listed in `strategies/README.md`
  (currently failing — documents the gap)
- Dependencies: Subphase 2.1
- Acceptance: all non-xfail link checks pass

---

#### Subphase 2.5: Content Shape Checks
*Depends on: Subphase 2.1*

**Task 2.5.1** — Define shape schemas in `tests/fixtures/shapes.py`
- Language file shape: must contain `## Standards`, `## Commands`, `## Patterns`
- Strategy file shape: must contain `## When to Use`, `## Workflow`
- Interface file shape: must contain `## Core Architecture` or `## Framework Selection`
- Tool file shape: must contain at least one `##` section

**Task 2.5.2** — Implement `tests/content/test_shape.py`
- Parameterize over all files in each category
- Assert each file matches its shape schema
- Dependencies: Task 2.5.1, Subphase 2.1
- Acceptance: all files that exist pass shape check; any new file added without
  required sections causes test failure

---

### Phase 3: CLI Regression Suite
*Depends on: Phase 1 complete. Can run parallel with Phase 2.*

#### Subphase 3.1: CLI Test Infrastructure
**Task 3.1.1** — Add CLI test helpers to `tests/fixtures/conftest.py`
- `run_command(cmd, args, tmp_path)` — invokes a `cmd_*` function from `run` in
  an isolated temp directory, captures stdout/stderr, returns result
- `mock_user_input(responses)` — patches `ask_input` / `ask_choice` / `ask_confirm`
  with a queue of predetermined responses for non-interactive testing
- Import strategy: import `run` as a module (rename file to `run.py` or use
  `importlib` with path) — document this as a known friction point
- Dependencies: Phase 1
- Acceptance: helper functions importable; `mock_user_input` correctly patches
  interactive prompts in a test call

---

#### Subphase 3.2: `cmd_bootstrap` Tests
*Depends on: Subphase 3.1*

**Task 3.2.1** — Implement `tests/cli/test_bootstrap.py`
- Happy path: `cmd_bootstrap([])` with mocked inputs produces `USER.md` at expected
  path containing expected sections (`## Identity`, `## Communication`)
- Output path: assert file written to path returned by `get_default_paths()['user']`
- No crash: command exits without exception given minimal valid inputs
- Dependencies: Subphase 3.1
- Acceptance: 3 test cases pass; `pytest tests/cli/test_bootstrap.py` exits 0

---

#### Subphase 3.3: `cmd_project` Tests
*Depends on: Subphase 3.1*

**Task 3.3.1** — Implement `tests/cli/test_project.py`
- Happy path: `cmd_project([])` with mocked inputs produces `PROJECT.md` at expected path
- Content check: generated `PROJECT.md` contains `## Project Configuration` and
  `## Standards` sections
- Strategy selection: assert selected strategy name appears in output file
- Dependencies: Subphase 3.1
- Acceptance: 3 test cases pass

---

#### Subphase 3.4: `cmd_validate` Tests
*Depends on: Subphase 3.1*

**Task 3.4.1** — Implement `tests/cli/test_validate.py`
- Valid state: `cmd_validate([])` against a valid temp deft directory exits without error
- Missing file: command reports failure (non-zero or prints error) when a required
  file is absent
- Dependencies: Subphase 3.1
- Acceptance: 2 test cases pass; validate correctly distinguishes valid from invalid state

---

#### Subphase 3.5: `cmd_doctor` Tests
*Depends on: Subphase 3.1*

**Task 3.5.1** — Implement `tests/cli/test_doctor.py`
- Runs without crash: `cmd_doctor([])` completes without exception
- Output contains checks: stdout includes at least one check result line (✓ or ⚠)
- Dependencies: Subphase 3.1
- Acceptance: 2 test cases pass

---

### Phase 4: Taskfile Integration
*Depends on: Phase 2 and Phase 3 both complete*

**Task 4.1.1** — Update `Taskfile.yml`
- Add `task test` — runs `uv run pytest tests/`
- Add `task test:coverage` — runs `uv run pytest tests/ --cov --cov-report=html`;
  fails if coverage < 75%
- Add `task fmt` — runs `uv run ruff format . && uv run black .`
- Add `task lint` — runs `uv run ruff check . && uv run mypy run`
- Update `task check` deps to include `lint` and `test`
- Fix `PROJECT_NAME` var from legacy name to `deft` and `VERSION` to current
- Dependencies: Phase 2 + Phase 3
- Acceptance: `task test` runs full suite; `task check` includes test run;
  `task test:coverage` fails if coverage drops below 75%

---

### Phase 5: Baseline Finalization and todo.md
*Depends on: Phase 4 complete*

**Task 5.1.1** — Final baseline pass
- Run full `task test` against current beta state
- Update `known_failures.json` to reflect actual failures vs expected
- Ensure all unexpected failures are either fixed or documented
- Dependencies: Phase 4
- Acceptance: `task test` runs to completion with a known, documented result;
  no unexpected failures

**Task 5.2.1** — Create `todo.md`
- Document all deferred items with context:
  - GitHub Actions CI workflow (`.github/workflows/test.yml`)
  - CLI commands: `spec`, `install`, `reset`, `update` test coverage
  - Error/edge case testing for core CLI commands
  - GitHub Issues migration from todo.md
  - Phase 2: Deft Directive v0.6.0 upgrade (complete project rename,
    add `strategies/rapid.md` + `strategies/enterprise.md`, remove legacy scripts,
    clean leaked `core/project.md`, port `SKILL.md` from master, write CHANGELOG)
- Dependencies: Phase 4
- Acceptance: `todo.md` exists at repo root with all items listed

---

## Dependency Map

```
Phase 1 (Foundation)
  └── Phase 2 (Content Suite) ─┐
  └── Phase 3 (CLI Suite)    ──┤── Phase 4 (Taskfile) ── Phase 5 (Baseline + todo.md)
```

Phases 2 and 3 can be worked in parallel once Phase 1 is complete.
Within Phase 2, subphases 2.2, 2.3, 2.4, 2.5 can run in parallel after 2.1.
Within Phase 3, subphases 3.2–3.5 can run in parallel after 3.1.

---

## Acceptance Criteria (Definition of Done)

- `task test` runs without unexpected failures from a clean checkout
- `task check` is blocked if any test fails
- All known failures are documented in `known_failures.json` with reason
- `todo.md` lists all deferred work with enough context to resume later
- Coverage ≥ 75% across tested code
- No new `.md` file can be added to `languages/`, `strategies/`, `interfaces/` without
  a shape check failure if required sections are missing

---

## Workflow Rules

- **No auto-push.** Commit completed work locally, then STOP. Do not push to `origin`
  until the author has vetted locally and explicitly instructs a push.
- **Author on all commits.** Every commit must carry `Scott Adams <msadams@msadams.com>`
  as author with the current timestamp.

---

*Generated from interview — Deft Directive msadams-branch — 2026-03-08*
