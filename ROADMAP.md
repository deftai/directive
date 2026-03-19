# Deft Directive — Roadmap

Prioritized work items. **Principle: resolve open issues before new features.**

---

## Phase 1 — Bug Fixes & Issue Resolution (Next Up)

Fix reported bugs and UX problems. All are against the existing `run` CLI.

- **#31** — `default.md` and `interview.md` need to be merged into `interview.md` (duplicate strategy files)
- **#50** — Strategies still have redundant old names (`brownfield.md` → `map.md`, `default.md` → `interview.md`)
- **#49** — All CLI commands should display version on startup

---

## Phase 2 — Documentation & Content Fixes

Quick doc/content fixes that don't require code changes.

### Philosophy & Positioning

- **#84 Phase 1** — Deft as teacher: contract hierarchy, adaptive teaching, and "state WHY"
  - Add `! State WHY` rule to `strategies/interview.md` — when making an opinionated recommendation, state the principle (1 sentence)
  - Create `contracts/hierarchy.md` — Standards > APIs > Specs > Code ranking, Phoenix architecture concept, "contracts are your IP" framing
  - Add adaptive teaching behavior to `main.md` (always-loaded; not `SOUL.md` — opt-in only):
    - `~ When a recommendation is accepted without question, be concise`
    - `! When a recommendation is questioned or overridden, explain the reasoning`
    - `⊗ Lecture unprompted on every decision`

### Content & Doc Fixes

- **#58** — Stale cross-references to legacy `core/user.md` and `core/project.md` paths throughout framework
- **#59** — `history/changes/` directory referenced by `commands.md` doesn't exist
- **#23** — `yolo.md` duplicates ~80% of `interview.md` — refactor to reference shared phases
- **#24** — `speckit.md` missing `⚠️ See also` cross-reference banner
- **#25** — `commands.md` vBRIEF example diverges from `vbrief/vbrief.md` spec (status vocabulary mismatch)
- **#67** — Write SPECIFICATION.md and proper PROJECT.md for the deft project itself
- **#51** — Project should be fully bootstrapped with its own framework (partially done in PR #66)
- Rename: purge remaining "Warping" references from README.md, `warping.sh`, Taskfile.yml; reframe README as "contract engineering framework" (#84 Phase 2)
  - `README.md` still says "Warping Process", "What is Warping?", "Contributing to Warping"
  - Reframe from "coding standards framework" → "contract engineering framework: specifications are your IP, code is a renewable output"
  - `Taskfile.yml` `VERSION` — update to match latest release
  - `warping.sh` still present — remove or deprecate (replaced by `run` in v0.5.0)
  - Verify: `test_standards.py` xfail for Warping references should flip to passing
- Clean leaked personal files:
  - `core/project.md` — contains Voxio Bot private project config; replace with generic template
  - `PROJECT.md` (repo root) — leftover from bootstrap test run; remove or replace
  - Verify: `test_standards.py` xfail for Voxio Bot content should flip to passing
- Update `strategies/interview.md` to probe language/tool choices through the contract lens — when user picks a language, prompt to consider habit vs. suitability (#84 Phase 2)
- Create `meta/philosophy.md` — full contract hierarchy narrative for agent reference and direct user reading (#84 Phase 2)
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
- ~~Write remaining CHANGELOG entries~~ — tracked by #71 (Phase 1)

---

## Phase 3 — Test Infrastructure & CI

- **#74** — Automate release process (`task release`) and CI changelog enforcement
- **#57** — Add GitHub Actions CI workflow for linting and tests on PRs and pushes
- **#33** — When using Docker, smoke tests and e2e tests should validate Docker (docker:up, /healthz)
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

## Phase 4 — Package Distribution & Install UX

Publish deft as NPM + PIP CLI packages for developer-audience install.
Complements the Go installer (which targets novice/bare-machine users).

- **#56** — Reduce installation friction — add shell one-liner, Homebrew, and platform package managers
- **#53** — deft-install should bootstrap the current directory by default
- **#11** — NPM + PIP CLI distribution (`npm i -g @deftai/directive`, `pipx install deft-cli`)

**Prerequisites:** Phase 2 complete (clean content), issue #4 resolved (project-local layout)

Scope: `deft install`, `deft bootstrap`, `deft update`, `deft doctor` commands,
GitHub Actions publish workflows (tag → npm publish + twine upload),
README updated with NPM + PIP install paths alongside Go binary.

---

## Phase 5 — CLI Overhaul & New Features

Larger feature work — only after issues are resolved and content is stable.

- **#84 Phase 3** — Deft as teacher: teach strategy, lessons evolution
  - Build `strategies/teach.md` — Feynman technique applied to Deft itself, philosophy as a conversation
  - Evolve `lessons.md` — when adding a lesson, include not just *what* was learned but *why it matters* in the contract hierarchy
- **#52** — Install into `.deft/` (hidden directory) instead of `deft/`
- **#54** — AGENTS.md provides no actionable onboarding — agents don't know what to do after deft-install
- **#55** — Register Deft commands as native agent slash commands (Claude Code, Copilot, Gemini, etc.)
- **#46** — Provide a way for users to update meta MD files (SOUL, MORALS, CODE-FIELD, USER, etc.)
- **#39** — Strategy chaining options before spec generation (bidirectional strategy orchestration, chaining gate, acceptance gate)
- **#12** — Deft Bootstrap CLI with TUI (Typer + Textual, strategy-aware feature branching, agent config generation)
- **#9** — Issue tracking system integration (GitHub Issues, Jira, Asana — optional, via MCP)
- LLM-assisted content validation
- Self-upgrade to Deft Directive product (branding, public docs, distribution packaging)

---

## Completed

- ~~#45 — Bootstrap parity~~ — 2026-03-19 (PR #83: CLI and agentic paths produce consistent output, released as v0.7.0)
- ~~#71 — CHANGELOG catch-up~~ — 2026-03-18 (PR #73: backfilled post-0.6.0 entries, updated release links to `deftai/directive` for v0.2.2+, preserved historical `visionik` links for older versions)
- ~~#63 — Installer hardcodes old repo URL~~ — 2026-03-17 (PR #64: all `visionik/deft` → `deftai/directive`)
- ~~#69 — Remove stale beta branch and update docs~~ — 2026-03-17 (trunk-based workflow, beta branch deleted)
- ~~#34 — Zero-prerequisite installer~~ — 2026-03-17 (merged via PR #42, released as v0.5.0)
- ~~#10 — AGENTS.md setup improvement in docs~~ — 2026-03-17 (PR #66: added manual-clone wiring note in Getting Started)
- ~~#51 — Project bootstrap (partial)~~ — 2026-03-17 (PR #66: AGENTS.md added, old/ removed, core/project.md cleaned; remaining work in #67)
- ~~#60 — pressEnterToExit() Windows-only~~ — 2026-03-17 (PR #66: runtime.GOOS guard)
- ~~#62 — beta branch 50+ unmerged commits~~ — 2026-03-17 (already merged via PR #42)
- ~~#47 — PROJECT.md defaults + input validation~~ — 2026-03-17 (PR #66: all items addressed)
- ~~#44 — CLI bootstrap overwrites USER.md + input validation~~ — 2026-03-17 (PR #66: items 1-4 done, item 5 split to #65)
- ~~#8 — Don't commit until questionnaires finished~~ — 2026-03-17 (PR #66: Ctrl+C resume protection)
- ~~#7 — Double prompting for languages during bootstrap~~ — 2026-03-16 (PR #43: `cmd_project` reads USER.md defaults)
- ~~#32 — Strategy selection doesn't work~~ — 2026-03-16 (fixed on beta: `cmd_spec` now reads strategy from PROJECT.md)
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
| #84 | Deft as teacher: contract hierarchy, explain WHY, adaptive teaching mode | 2/5 |
| #9 | Issue tracking system integration | 5 |
| #11 | NPM + PIP CLI distribution | 4 |
| #12 | Deft Bootstrap CLI with TUI | 5 |
| #14 | ~~Bootstrap nits~~ (absorbed into #45) | — |
| #23 | yolo.md duplicates interview.md | 2 |
| #24 | speckit.md missing See also banner | 2 |
| #25 | commands.md vBRIEF example diverges | 2 |
| #31 | Merge default.md into interview.md | 1 |
| #33 | Docker smoke/e2e tests | 3 |
| #34 | ~~Zero-prerequisite installer~~ (completed, released v0.5.0) | — |
| #39 | Strategy chaining options before spec generation | 5 |
| #45 | ~~Bootstrap parity: CLI and agentic paths consistent output~~ (completed, v0.7.0) | — |
| #46 | Provide way to update meta MD files | 5 |
| #49 | All CLI commands should display version | 1 |
| #50 | Strategies still have redundant old names | 1 |
| #51 | Project should be bootstrapped with own framework (partial — #67 tracks remainder) | 2 |
| #67 | Write SPECIFICATION.md and proper PROJECT.md for deft | 2 |
| #52 | Install into .deft/ hidden directory | 5 |
| #53 | deft-install should bootstrap current directory | 4 |
| #54 | AGENTS.md provides no actionable onboarding | 5 |
| #55 | Register Deft commands as native agent slash commands | 5 |
| #56 | Reduce installation friction (shell one-liner, Homebrew) | 4 |
| #57 | Add GitHub Actions CI workflow | 3 |
| #74 | Automate release process and CI changelog enforcement | 3 |
| #58 | Stale cross-references to legacy paths | 2 |
| #59 | history/changes/ directory missing | 2 |
| #61 | ~~deft-setup SKILL.md strategies table stale~~ (absorbed into #45) | — |
| #63 | ~~Installer hardcodes old repo URL~~ (completed) | — |
| #65 | ~~Bootstrap custom rules stub~~ (absorbed into #45) | — |
| #69 | ~~Remove stale beta branch~~ (completed) | — |
| #71 | ~~CHANGELOG catch-up since v0.6.0 + stale release links~~ (completed) | — |

---

*Created 2026-03-13 — consolidates todo.md and GitHub Issues into a single roadmap*
*Updated 2026-03-17 — added issues #44-#65, moved #8/#44/#47 to Completed*
*Updated 2026-03-19 — added #84 (Deft as teacher: contract hierarchy, Phase 2 Philosophy & Positioning sub-section, Phase 5 teach strategy); moved #45 to Completed (v0.7.0)*
