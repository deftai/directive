# Deft Directive — Roadmap

Prioritized work items. **Principle: resolve open issues before new features.**

---

## In Progress — Merge to Master

Work completed on `beta` that needs validation and merge to `master`.

- **#34** — Zero-prerequisite installer for novice users (Windows, macOS, Linux)
  - Go binary implemented on `beta` (`cmd/deft-install/`), 5 platform targets
  - Remaining: validate macOS + Linux paths, merge to master, tag release, update README

---

## Phase 1 — Bug Fixes & Issue Resolution (Next Up)

Fix reported bugs and UX problems. All are against the existing `run` CLI.

- **#32** — Strategy selection in `run project` does not work (selecting "map" still runs "interview")
- **#7** — Double prompting for programming languages during bootstrap → project flow
- **#8** — Don't commit until questionnaires are finished (Ctrl+C mid-bootstrap leaves partial files)
- **#14** — Bootstrap nits: strategy picker needs descriptions per option, unclear defaults on y/N prompts
- **#31** — `default.md` and `interview.md` need to be merged into `interview.md` (duplicate strategy files)

---

## Phase 2 — Documentation & Content Fixes

Quick doc/content fixes that don't require code changes.

- **#23** — `yolo.md` duplicates ~80% of `interview.md` — refactor to reference shared phases
- **#24** — `speckit.md` missing `⚠️ See also` cross-reference banner
- **#25** — `commands.md` vBRIEF example diverges from `vbrief/vbrief.md` spec (status vocabulary mismatch)
- **#10** — README Getting Started should explicitly call out AGENTS.md setup step
- Rename: purge remaining "Warping" references from README.md, `warping.sh`, Taskfile.yml
  - `README.md` still says "Warping Process", "What is Warping?", "Contributing to Warping"
  - `Taskfile.yml` `VERSION` — update to match latest release
  - `warping.sh` still present — remove or deprecate (replaced by `run` in v0.5.0)
  - Verify: `test_standards.py` xfail for Warping references should flip to passing
- Clean leaked personal files:
  - `core/project.md` — contains Voxio Bot private project config; replace with generic template
  - `PROJECT.md` (repo root) — leftover from bootstrap test run; remove or replace
  - Verify: `test_standards.py` xfail for Voxio Bot content should flip to passing
- Add missing strategies:
  - `strategies/rapid.md` — Quick prototypes, SPECIFICATION only workflow
  - `strategies/enterprise.md` — Compliance-heavy, PRD → ADR → SPECIFICATION workflow
  - Both listed in `strategies/README.md` as "(future)" with no backing file
- Port any remaining `SKILL.md` carry-forward content from master
  - Three commits on master updated SKILL.md (`a6f120a`, `cc442fc`, `2f2a89e`)
  - Largely superseded by `deft-setup`/`deft-build` skills; review for carry-forward content
- Codify PR workflow standards into `scm/github.md`
  - Opinionated PR workflow rules: single-purpose PRs, review required, squash-merge, well-documented
  - Cross-reference squash-merge rule in Branch Protection settings section
- Write remaining CHANGELOG entries
  - v0.6.0 done (PRs #16–20). Still needed: context engineering module, canonical vBRIEF pattern

---

## Phase 3 — Test Infrastructure & CI

- **#33** — When using Docker, smoke tests and e2e tests should validate Docker (docker:up, /healthz)
- GitHub Actions CI workflow (`.github/workflows/test.yml`) — trigger on push to `beta` and PRs
- CLI tests for remaining commands: `cmd_spec`, `cmd_install`, `cmd_reset`, `cmd_update`
- Error and edge case testing for core CLI commands
- Enforce USER.md gate in CLI path
  - `cmd_spec` and `cmd_project` should check for USER.md at entry; if absent, warn and redirect to `run bootstrap`
  - Skills path already done (deft-build); this covers the CLI fallback path only
- Code signing for installer binaries (Windows Authenticode, macOS Developer ID + notarisation)
- Low-end LLM compatibility testing
  - Validate installer and agent process (deft-setup, deft-build) on small/quantised models (e.g. Qwen3-9B)
  - Ensure strategies, interview flow, and spec generation still produce good results
  - Document minimum recommended model size in README or AGENTS.md
- Upgrade GitHub Actions to Node.js 24 before June 2, 2026 deadline
  - `actions/checkout`, `actions/setup-go`, `actions/upload-artifact`, `actions/download-artifact`
  - Bump to versions that support Node.js 24 when available (v5+), or set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`

---

## Phase 4 — Package Distribution (#11)

Publish deft as NPM + PIP CLI packages for developer-audience install.
Complements the Go installer (which targets novice/bare-machine users).

- **#11** — NPM + PIP CLI distribution (`npm i -g @visionik/deft`, `pipx install deft-cli`)

**Prerequisites:** Phase 2 complete (clean content), issue #4 resolved (project-local layout)

Scope: `deft install`, `deft bootstrap`, `deft update`, `deft doctor` commands,
GitHub Actions publish workflows (tag → npm publish + twine upload),
README updated with NPM + PIP install paths alongside Go binary.

---

## Phase 5 — CLI Overhaul & New Features

Larger feature work — only after issues are resolved and content is stable.

- **#39** — Strategy chaining options before spec generation (bidirectional strategy orchestration, chaining gate, acceptance gate)
- **#12** — Deft Bootstrap CLI with TUI (Typer + Textual, strategy-aware feature branching, agent config generation)
- **#9** — Issue tracking system integration (GitHub Issues, Jira, Asana — optional, via MCP)
- LLM-assisted content validation
- Self-upgrade to Deft Directive product (branding, public docs, distribution packaging)

---

## Completed

- ~~Single entry point Go installer~~ — 2026-03-12 (5-platform binaries, GitHub Actions release workflow)
- ~~Agent-driven skills (deft-setup + deft-build)~~ — 2026-03-12
- ~~Enforce USER.md gate (skills path)~~ — 2026-03-12
- ~~#28 — vBRIEF schema reference + fix non-conforming status values~~ — 2026-03-11
- ~~#21 — Testbed regression testing suite~~ — 2026-03-11 (568 passed, 24 xfailed)
- ~~Convert to TDD mode~~ — 2026-03-11
- ~~Land PR #26 on master~~ — 2026-03-11
- ~~Merge master → beta~~ — 2026-03-11
- ~~v0.6.0 content (PRs #16–20)~~ — 2026-03-11
- ~~Reopen PR #22 and merge testbed to master~~ — Merged 2026-03-11
- ~~Add `strategies/discuss.md` to README table~~ — Done in PR #16
- ~~v0.6.0 CHANGELOG entry~~ — Done in PR #20
- ~~#6 — Programming languages asked too early / limited options~~ — closed
- ~~#5 — SDD should focus on intent first~~ — closed
- ~~#4 — Make /deft read-only (project-local layout)~~ — closed
- ~~#3 — Add run.bat for Windows~~ — closed (superseded by Go installer)
- ~~#2 — CLI output cleanup~~ — closed

---

## Open Issues Index

| Issue | Title | Phase |
|-------|-------|-------|
| #7 | Double prompting for languages during bootstrap | 1 |
| #8 | Don't commit until questionnaires finished | 1 |
| #9 | Issue tracking system integration | 5 |
| #10 | AGENTS.md setup improvement in docs | 2 |
| #11 | NPM + PIP CLI distribution | 4 |
| #12 | Deft Bootstrap CLI with TUI | 5 |
| #14 | Bootstrap nits (defaults, strategy descriptions) | 1 |
| #23 | yolo.md duplicates interview.md | 2 |
| #24 | speckit.md missing See also banner | 2 |
| #25 | commands.md vBRIEF example diverges | 2 |
| #31 | Merge default.md into interview.md | 1 |
| #32 | Strategy selection doesn't work | 1 |
| #33 | Docker smoke/e2e tests | 3 |
| #34 | Zero-prerequisite installer (merge to master) | In Progress |
| #39 | Strategy chaining options before spec generation | 5 |

---

*Created 2026-03-13 — consolidates todo.md and GitHub Issues into a single roadmap*
