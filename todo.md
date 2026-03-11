# Todo

Prioritized work items. Current goal: **get testbed into master**.

---

## NOW — Blockers for testbed → master

*These must be completed in order before PR #22 (testbed) can merge to master.*

### 1. Land PR #26 on master
- PR #26 completes the stacked chain — PRs #17, #19, #20 content needs visionik approval
- **Blocked by**: visionik review (branch protection on master requires 1 approval)
- Once approved, merge PR #26 via GitHub

### 2. Merge master → beta
- After PR #26 lands, pull master into beta to pick up all v0.6.0 content
- Expect merge conflicts in: `CHANGELOG.md`, `main.md`, `core/glossary.md`, `REFERENCES.md`, `strategies/README.md`

### 3. Update test suite for v0.6.0 content
- **File renames**: update existence tests — old `default.md`/`brownfield.md` → new `interview.md`/`map.md`; add `yolo.md`
- **New files**: add to expected file lists — `commands.md`, `history/README.md`, `context/spec-deltas.md`
- **New directories**: add structure tests for `history/changes/`, `history/archive/`
- **Shape tests**: add checks for new sections in `main.md` (Slash Commands), `commands.md`, updated `REFERENCES.md` and glossary
- **strategies/README.md**: table now has Command column; discuss.md included
- Update `known_failures.json` as xfails flip to passing
- Run `task check` — must pass clean before proceeding

### 4. Reopen PR #22 and merge testbed to master
- Reopen PR #22 (closed, not merged — head branch is `beta`)
- PR will auto-update once beta is pushed with updated tests
- Resolve any remaining conflicts with master
- Get visionik approval (already a requested reviewer)
- Testbed baseline will need a new count (currently 568 passed, 24 xfailed)

---

## What landed on master (PRs #16–#20, 2026-03-11)

### PR #16 — Slash commands, strategy renames, yolo strategy
- `/deft:run:<name>` dispatch to `strategies/<name>.md`
- `default.md` → `interview.md`, `brownfield.md` → `map.md`
- New `strategies/yolo.md` (auto-pilot interview)

### PR #17 — Change lifecycle workflow and history directory
- `commands.md` — full `/deft:change` workflow
- `history/changes/`, `history/archive/` directory structure

### PR #19 — Spec deltas with vBRIEF chain pattern
- `context/spec-deltas.md` — delta format, reading protocol, merge rules

### PR #20 — Archive lifecycle expansion
- Spec delta merge protocol, CHANGELOG entry guidance, v0.6.0 CHANGELOG entry

### Open issues from review
- **#23** — `yolo.md` duplicates ~80% of `interview.md`
- **#24** — `speckit.md` missing `⚠️ See also` banner
- **#25** — `commands.md` vBRIEF example diverges from `vbrief/vbrief.md`

---

## NEXT — Priority Refactors (after testbed lands on master)

### Convert to TDD mode
- Set up test infrastructure and convert existing code to TDD workflow
- Must be completed before starting the skills/installation refactor
- Prerequisite for validating all subsequent changes

### Agent-driven skills as primary onboarding path
- **Decision (2026-03-10):** adopt agent-driven skills (PR #18 direction) as the
  primary entry point; CLI commands become a fallback/power-user path
- Rationale: deft is a framework for AI agents — the setup conversation belongs
  inside the agent session, not in a 25-prompt CLI questionnaire
- Reference implementation: PR #18 (`skills/deft-setup/SKILL.md`,
  `skills/deft-build/SKILL.md`, `skills/install.sh`) — direction is right,
  but needs TDD coverage and the USER.md gate before merge
- Sequencing:
  1. TDD infrastructure (see above)
  2. Land `deft-setup` and `deft-build` skills — with tests
  3. Add USER.md gate to `deft-build` (see below)
  4. Installer: `curl | sh` is good UX; underlying model can stay `git clone`
     for now, npx/CLI-on-PATH deferred to future phase
  5. Demote CLI questionnaire (bootstrap/project/spec) to fallback

### Enforce USER.md gate in both paths
- Root cause: on initial setup, agent bypassed `run bootstrap` and jumped directly
  to `run spec`; `~/.config/deft/USER.md` was never generated via the intended path
  (identified 2026-03-09)
- **CLI path:** `cmd_spec` and `cmd_project` should check for USER.md at entry;
  if absent, warn and redirect to `run bootstrap` before continuing
- **Skills path:** `deft-build` must check for USER.md at entry; if absent,
  redirect to `deft-setup` Phase 1 before continuing
- Protection must live in the repo — not reliant on user knowledge of the flow

---

## LATER — Phase 2 (Deft Directive Upgrade)

### Rename: "Warping" → "Deft Directive"
- `README.md` still says "Warping Process", "What is Warping?", "Contributing to Warping", etc.
- `Taskfile.yml` `VERSION` — update to match latest release
- `warping.sh` still present — remove or deprecate (replaced by `run` in v0.5.0)
- Verify: `test_standards.py` xfail for Warping references should flip to passing

### Clean leaked personal files
- `core/project.md` — contains Voxio Bot private project config; replace with generic template
- `PROJECT.md` (repo root) — leftover from bootstrap test run; remove or replace
- Verify: `test_standards.py` xfail for Voxio Bot content should flip to passing

### Add missing strategies
- `strategies/rapid.md` — Quick prototypes, SPECIFICATION only workflow
- `strategies/enterprise.md` — Compliance-heavy, PRD → ADR → SPECIFICATION workflow
- Both listed in `strategies/README.md` as "(future)" with no backing file

### Port `SKILL.md` from master → superseded by agent skills
- Three commits on master updated SKILL.md (`a6f120a`, `cc442fc`, `2f2a89e`)
- Largely superseded by `deft-setup`/`deft-build` skills; review for carry-forward content

### Codify PR workflow standards into `scm/github.md`
- Opinionated PR workflow rules: single-purpose PRs, review required, squash-merge, well-documented
- Cross-reference squash-merge rule in Branch Protection settings section

### Write remaining CHANGELOG entries
- v0.6.0 done (PRs #16–20). Still needed: context engineering module, canonical vBRIEF pattern

---

## LATER — Deferred Test Coverage

### CI: GitHub Actions workflow
- Create `.github/workflows/test.yml`
- Trigger on push to `beta` and on all PRs targeting `beta`

### CLI tests: additional commands
- `cmd_spec`, `cmd_install`, `cmd_reset`, `cmd_update` — happy path + key error cases

### CLI tests: error and edge cases
- Invalid input, missing config, bad paths, permission errors

---

## LATER — Future Phases (Unscheduled)

### LLM-assisted content validation
- Explore using an LLM to verify semantic correctness of `.md` files
- Revisit when framework content volume makes manual review impractical

### Spec: self-upgrade to Deft Directive product
- Use the framework to spec its own evolution as a product
- Includes branding, public docs, distribution packaging

---

## Completed

- ~~Testbed Phases 1–5~~ — 568 passed, 24 xfailed (2026-03-10)
- ~~Add `strategies/discuss.md` to README table~~ — Done in PR #16
- ~~v0.6.0 CHANGELOG entry~~ — Done in PR #20

---

*Created from spec interview — Deft Directive msadams-branch — 2026-03-08*
