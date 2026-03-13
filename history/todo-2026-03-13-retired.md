# Todo

Prioritized work items. Current goal: **agent-driven skills + installation**.

---

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

### Enforce USER.md gate in CLI path
- `cmd_spec` and `cmd_project` should check for USER.md at entry; if absent,
  warn and redirect to `run bootstrap` before continuing
- Skills path is already done (deft-build); this covers the CLI fallback path only

### CLI tests: additional commands
- `cmd_spec`, `cmd_install`, `cmd_reset`, `cmd_update` — happy path + key error cases

### CLI tests: error and edge cases
- Invalid input, missing config, bad paths, permission errors

---

## LATER — Future Phases (Unscheduled)

### Code signing for installer binaries
- Windows: Authenticode signing to avoid SmartScreen warnings
- macOS: Apple Developer ID signing + notarisation to avoid Gatekeeper blocks
- Prerequisite for broad adoption; currently documented as manual workaround in README

### LLM-assisted content validation
- Explore using an LLM to verify semantic correctness of `.md` files
- Revisit when framework content volume makes manual review impractical

### Spec: self-upgrade to Deft Directive product
- Use the framework to spec its own evolution as a product
- Includes branding, public docs, distribution packaging

---

## Completed

- ~~Single entry point Go installer~~ — Done 2026-03-12 (Phases 1–8: Go binary replaces install.py/install.bat, GitHub Actions release workflow, 5-platform binaries)
- ~~Land agent-driven skills (deft-setup + deft-build)~~ — Done 2026-03-12 (Phases 1–4: skills, installer, Taskfile, docs)
- ~~Enforce USER.md gate (skills path: deft-build)~~ — Done 2026-03-12; CLI path deferred to LATER
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
