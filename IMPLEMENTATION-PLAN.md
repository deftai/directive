# Testbed — v0.6.0 Content Update

## Current State

Testbed Phases 1–5 are complete (568 passed, 24 xfailed as of 2026-03-10).
The master→beta merge (1eb23fb, 2026-03-11) landed v0.6.0 content from PRs #16–#20.
Tests need updating to account for new files, renames, and issues fixed by those PRs.

All test infrastructure is in place: `pyproject.toml`, `conftest.py` (with `run_command`,
`mock_user_input`, `deft_run_module` fixtures), content tests (structure, standards,
contracts, shape), CLI tests (bootstrap, project, validate, doctor), `Taskfile.yml`
integration, and baseline snapshot tooling.

---

## What v0.6.0 Changed

### New files
- `commands.md` — change lifecycle workflows (RFC2119 legend ✓)
- `context/spec-deltas.md` — spec delta format and vBRIEF chain (RFC2119 legend ✓)
- `history/README.md` — change folder conventions (index file, no legend needed)
- `history/archive/.gitkeep`, `history/changes/.gitkeep`
- `strategies/interview.md` — renamed from `default.md` (legend ✓, shape ✓)
- `strategies/map.md` — renamed from `brownfield.md` (legend ✓, shape ✓)
- `strategies/yolo.md` — auto-pilot interview strategy (legend ✓, shape ✓)

### Modified files
- `CHANGELOG.md` — v0.6.0 entry
- `PROJECT.md` — strategy ref → `interview.md`
- `REFERENCES.md` — "When Working with Changes" section added, `map.md` ref
- `core/glossary.md` — "Spec delta" term, `map.md` ref
- `main.md` — Slash Commands section
- `strategies/README.md` — Command column in table, `discuss.md` now listed
- `strategies/discuss.md`, `strategies/research.md` — updated cross-references

### Issues now fixed
- `discuss.md` IS listed in `strategies/README.md` (PR #16 added it)
- Old files `default.md` and `brownfield.md` still exist but are no longer in the README table

---

## Required Changes

### 1. test_structure.py

- Add `"history"` to `REQUIRED_DIRS` (new directory from change lifecycle)
- Add `"commands.md"` to `REQUIRED_ROOT_FILES` (root-level command reference)

### 2. test_contracts.py

- Remove the hardcoded `@pytest.mark.xfail` from `test_discuss_in_strategy_index` —
  the assertion now passes (discuss.md is in the README table since PR #16)
- No other code changes needed — REFERENCES.md and strategy index link tests are
  parametrized and will auto-discover the new links

### 3. known_failures.json

- **Remove** `discuss-missing-from-strategy-index` (fixed by PR #16)
- Run tests to identify any new failures from v0.6.0 files
- Add entries for any new files that fail checks

Based on pre-analysis, the new files should pass cleanly:
- All new strategy files have RFC2119 legend and shape compliance
- `commands.md` and `context/spec-deltas.md` have RFC2119 legend
- No new files reference deprecated paths or "warping"
- New REFERENCES.md links (`commands.md`, `history/README.md`, `context/spec-deltas.md`) all resolve

Existing xfail entries that remain valid:
- `missing-strategy-rapid`, `missing-strategy-enterprise` — still future/unwritten
- `leaked-personal-project-config` — core/project.md still has Iglesia content
- All shape xfails (language files missing sections, discuss/research missing ## Workflow)
- All deprecated-path and warping xfails (unchanged)

### 4. Regenerate baseline.json

- Run `python tests/content/snapshots/capture.py` to capture current beta state
- New files will appear in the baseline; removed/renamed refs will update
- Commit updated `baseline.json`

### 5. Run full test suite and fix

- Run `uv run pytest tests/` — identify all failures
- For each failure: fix the test code, fix the content, or add a known_failures.json entry
- Target: all tests pass or are documented xfail
- Update the baseline test count (was 568 passed / 24 xfailed)

### 6. Verify `task check` passes clean

- Run `task check` — must pass lint + tests + validation
- This is the gate before pushing beta and reopening PR #22

---

## Dependency Order

```
1 (structure) ──┐
                ├── 3 (known_failures) ──► 4 (baseline) ──► 5 (test suite) ──► 6 (task check)
2 (contracts) ──┘
```

Steps 1 and 2 can be done in parallel.
Step 3 depends on 1 and 2 (need to know what changed before updating failure list).
Step 4 must come before 5. Step 6 is the final gate.

---

## After Tests Pass

Once `task check` is green:
1. Commit and push beta
2. Reopen PR #22 (testbed → master)
3. Get visionik approval
4. Merge to master

See `todo.md` § NOW for the full sequence.

---

## Workflow Rules

- **No auto-push.** Commit locally, then STOP. Push only on explicit instruction.
- **Author on all commits.** Scott Adams <msadams@msadams.com>

*Updated 2026-03-11 — post v0.6.0 merge (PRs #16–#20)*
