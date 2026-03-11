# Todo

Prioritized work items. Current goal: **agent-driven skills + installation**.

---

## NOW — Agent Skills & Installation

### 1. Land agent-driven skills (deft-setup + deft-build)
- **Decision (2026-03-10):** adopt agent-driven skills (PR #18 direction) as the
  primary entry point; CLI commands become a fallback/power-user path
- Reference: PR #18 (`skills/deft-setup/SKILL.md`, `skills/deft-build/SKILL.md`,
  `skills/install.sh`) — direction is right, but needs USER.md gate before merge
- Sequencing:
  1. Land `deft-setup` and `deft-build` skills — with tests
  2. Add USER.md gate to `deft-build` (see Enforce USER.md gate below)
  3. Installer: `curl | sh` is good UX; underlying model can stay `git clone`
     for now, npx/CLI-on-PATH deferred to future phase
  4. Demote CLI questionnaire (bootstrap/project/spec) to fallback

---

## NEXT — USER.md Gate

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

### Open issues from review
- **#23** — `yolo.md` duplicates ~80% of `interview.md`
- **#24** — `speckit.md` missing `⚠️ See also` banner
- **#25** — `commands.md` vBRIEF example diverges from `vbrief/vbrief.md`

### Rename:
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

- ~~Convert to TDD mode~~ — Done 2026-03-11
- ~~Land PR #26 on master~~ — Merged 2026-03-11
- ~~Merge master → beta~~ — Done 2026-03-11
- ~~Update test suite for v0.6.0 content~~ — Done 2026-03-11
- ~~Reopen PR #22 and merge testbed to master (PR #22)~~ — Merged 2026-03-11
- ~~Testbed Phases 1–5~~ — 568 passed, 24 xfailed (2026-03-10)
- ~~Add `strategies/discuss.md` to README table~~ — Done in PR #16
- ~~v0.6.0 CHANGELOG entry~~ — Done in PR #20

---

*Created from spec interview — Deft Directive msadams-branch — 2026-03-08*
