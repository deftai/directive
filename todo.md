# Todo

Deferred work items captured during planning. See SPECIFICATION.md for Phase 1 scope.

---

## Testbed — Complete (Phases 1–5)

All testbed phases are implemented and passing.

**Baseline result (2026-03-10):** 568 passed, 24 xfailed, 0 failures.
All 24 xfails are documented in `tests/content/snapshots/known_failures.json`.
`task check` (validate + lint + test) passes clean.

See `SPECIFICATION.md` and `IMPLEMENTATION-PLAN.md` for full details.

---

## Deferred from Testbed — Future Test Coverage

### CI: GitHub Actions workflow
- Create `.github/workflows/test.yml`
- Trigger on push to `beta` and on all PRs targeting `beta`
- Steps: checkout, setup Python, `uv sync`, `task test:coverage`
- Blocked by: Phase 1 testbed must be stable first
- Context: agreed during spec interview to defer; local `task check` gate is Phase 1 scope

### CLI tests: additional commands
- Add tests for `cmd_spec`, `cmd_install`, `cmd_reset`, `cmd_update`
- Happy path + key error cases for each
- Context: Phase 1 covers core four only (bootstrap, project, validate, doctor)

### CLI tests: error and edge cases
- Invalid input handling, missing config files, bad paths, permission errors
- Currently only happy path tested in Phase 1
- Context: deferred to keep Phase 1 scope manageable

### GitHub Issues migration
- Migrate items from this file to GitHub Issues
- Link issues to PRs as work is completed
- Context: owner is new to GitHub; defer until comfortable with PR workflow

---

## Priority Refactors (Before Phase 2)

### Convert to TDD mode
- Set up test infrastructure and convert existing code to TDD workflow
- Must be completed before starting the installation model refactor
- Prerequisite for validating all subsequent changes

### Enforce bootstrap as mandatory onboarding gate
- Root cause: on initial setup, agent bypassed `run bootstrap` and jumped directly
  to `run spec`; `~/.config/deft/USER.md` was never generated via the intended path
  (identified 2026-03-09)
- `cmd_spec` and `cmd_project` should check for USER.md at entry; if absent, warn
  and redirect to `run bootstrap` before continuing
- SKILL.md entry point must include the same bootstrap check as its first step
- Protection must live in the repo — not reliant on user knowledge of the flow

### Refactor: git submodule → npx/CLI installation model
- **High priority** — first major feature change after TDD conversion
- Current model: install via `git clone` as a git submodule in project dir
- New model: install as a skill and/or via `npx`; `deft` command available on PATH
- `deft project` starts the project workflow from any directory
- Creates `./deft/` dir in the project as the "deft is active here" flag; per-project files stored there
- `USER.md` moves to `~/.config/deft/USER.md` (global, not per-project)
- Should work as a `SKILL.md`
- Some work already done but untested; npx install scaffolding not yet started

---

## Phase 2 — Deft Directive v0.6.0 Upgrade

*Do not start until Phase 1 testbed is complete and passing — tests will validate this work.*

### Rename: "Warping" → "Deft Directive"
- `README.md` still says "Warping Process", "What is Warping?", "Contributing to Warping", etc.
- `Taskfile.yml` `VERSION` — update to match latest release (currently 0.5.2)
- `warping.sh` still present — remove or deprecate (replaced by `run` in v0.5.0)
- `CHANGELOG.md` header says "Warping framework"
- Verify: `test_standards.py` xfail for Warping references should flip to passing

### Clean leaked personal files
- `core/project.md` — contains Voxio Bot private project config; replace with generic
  framework template (see `templates/project.md.template` for reference)
- `PROJECT.md` (repo root) — leftover from bootstrap test run; remove or replace with
  a proper example
- Verify: `test_standards.py` xfail for Voxio Bot content should flip to passing

### Add missing strategies
- `strategies/rapid.md` — Quick prototypes, SPECIFICATION only workflow
- `strategies/enterprise.md` — Compliance-heavy, PRD → ADR → SPECIFICATION workflow
- Both listed in `strategies/README.md` as "(future)" with no backing file
- Verify: `test_structure.py` xfails for these should flip to passing

### Add `strategies/discuss.md` to README table
- File exists and is complete but missing from `strategies/README.md` strategy table
- Verify: `test_contracts.py` discuss.md assertion should flip to passing

### Port `SKILL.md` from master
- Three commits on master updated SKILL.md that never landed in beta:
  - `a6f120a` Add Claude Code skill integration
  - `cc442fc` Add comprehensive New Project Workflow
  - `2f2a89e` Add clawd.bot compatibility
- Cherry-pick or manually apply these changes
- See "Enforce bootstrap as mandatory onboarding gate" — entry point must invoke this check

### Codify PR workflow standards into `scm/github.md`
- Add opinionated PR workflow rules to the PR Workflow section of `scm/github.md`:
  - Private branches stay private until ready; a PR is opened only when the work is ready for merge
  - PRs require at least one human review before merge (no self-merge)
  - Each PR carries a single purpose; if it changes more than one thing, split it into separate PRs
  - PRs are squashed to a single merge commit on landing — preserves readable project history
  - PRs must be well documented: title, problem statement, and solution description; cannot be overdocumented
- These are Deft Directive opinions (not generic best practices); users who disagree should override in `user.md` or `project.md`
- Cross-reference the squash-merge rule in the Branch Protection settings section

### Write CHANGELOG for post-v0.5.0 work
- No changelog entries exist for context engineering module, canonical vBRIEF pattern,
  or any of the work above
- Add v0.6.0 entry covering all Phase 2 changes

---

## Future Phases (Unscheduled)

### testbed: LLM-assisted content validation
- Explore using an LLM to verify semantic correctness of `.md` files
  (e.g. "does this strategy file give actionable guidance?")
- Currently out of scope — shape/pattern checks are sufficient for regression testing
- Revisit when framework content volume makes manual review impractical

### Spec: self-upgrade to Deft Directive product
- Use the framework to spec its own evolution as a product ("Deft Directive")
- Includes branding, public docs, distribution packaging
- Deferred until Phase 1 + Phase 2 are stable

---

*Created from spec interview — Deft Directive msadams-branch — 2026-03-08*
