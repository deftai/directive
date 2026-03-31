# Deft Directive — Roadmap

Prioritized work items. **Principle: resolve open issues before new features.**

---

## Phase 1 — Bug Fixes & Issue Resolution (Next Up)

Fix reported bugs and UX problems blocking adoption.

### Adoption Blockers (user-reported, highest priority)

- **#126** — specification.vbrief.json does not conform to vbrief schema/spec — agent generates wildly non-conformant output (possibly fixed by #72 / PR #130; verify before working)
- **#133** — Generated vBRIEF files use invalid reference types (`x-vbrief/context`, `x-vbrief/research`) that fail schema validation — blocked on upstream `deftai/vBRIEF#2` to expand the enum; vendor updated schema once resolved
- **#79** — deft-setup Phase 2 inference bleeds into `./deft/` framework internals (misidentifies project as "deft")
- **#80** — deft-setup Phase 2 project name inference has no fallback when no build files exist
- **#107** — Remove language defaults from USER.md — language is a project-level concern (deft-setup interview noise)

- **#108** — Ask deployment platform before language — platform context drives language shortlist (depends on #107)

- **#68** — Warp not always enforcing Deft testing protocols (core quality gates silently skipped)
- **#137** — README: move startup instructions higher and clarify where to get installers — new users can't find how to get started (quick win, independent of #89 reframe)
- **#138** — Branching requirement too prescriptive for single-author projects — relax change lifecycle rule in `main.md` for solo contexts (easy content fix; full config-driven approach deferred to Phase 5 with #77)
- **#139** — Agent skips vbrief source step and writes SPECIFICATION.md directly — strengthen prohibition in `main.md`/deft-build skill; add validation step (address with #68, #123)

### Cleanup

- **#31** — `default.md` and `interview.md` need to be merged into `interview.md` (duplicate strategy files)
- **#50** — Strategies still have redundant old names (`brownfield.md` → `map.md`, `default.md` → `interview.md`)
- **#49** — All CLI commands should display version on startup
- **#116** — All deft files must be installed consistently under `./deft/` — placement is inconsistent across projects
- **#123** — Change lifecycle gate skipped when agent receives broad ‘proceed’ instruction on multi-file changes — strengthen /deft:change rule, add PR template checklist item, add enforcement to deft-build SKILL.md
- **#118** — CLI code quality sweep: version mismatch in docstring, bare `except` swallowing critical errors, undocumented `--force` flag, `DEFT_PRD_PATH` env var misused on Light path
- **#131** — Mac installer 0.7.1: post-install text says "read agents.md" — should say "use agents.md" (trivial string fix; can bundle with #118)

---

## Phase 2 — Documentation & Content Fixes

Quick doc/content fixes that don't require code changes.

### Philosophy & Positioning

- **#89** — Deft identity and positioning: resolve naming before README reframe (blocks #84 Phase 2 README reframe, `meta/philosophy.md`, interview strategy updates)
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
- **#51** — Project should be fully bootstrapped with its own framework (partially done in PR #66)
- Rename: purge remaining "Warping" references from README.md, `warping.sh`, Taskfile.yml; reframe README per #89 resolution (#84 Phase 2, blocked on #89)
  - `README.md` still says "Warping Process", "What is Warping?", "Contributing to Warping"
  - Reframe from "coding standards framework" → resolved tagline from #89
  - `Taskfile.yml` `VERSION` — update to match latest release
  - `warping.sh` still present — remove or deprecate (replaced by `run` in v0.5.0)
  - Verify: `test_standards.py` xfail for Warping references should flip to passing
- Clean leaked personal files:
  - `core/project.md` — contains Voxio Bot private project config; replace with generic template
  - `PROJECT.md` (repo root) — leftover from bootstrap test run; remove or replace
  - Verify: `test_standards.py` xfail for Voxio Bot content should flip to passing
- Update `strategies/interview.md` to probe language/tool choices through the contract lens — when user picks a language, prompt to consider habit vs. suitability (#84 Phase 2)
- Create `meta/philosophy.md` — full contract hierarchy narrative for agent reference and direct user reading (#84 Phase 2)
- **#82** — Replacement strategies need accept-or-scrap exit when plan artifacts already exist (design: artifact awareness for chaining gate)
- **#81** — Add BDD/acceptance-test-first strategy (`strategies/bdd.md` — Given/When/Then scenarios drive requirements)
- **#102** — Codify Mermaid gist-rendering best practices as must/should rules (`coding/mermaid.md`)
- **#124** — Warp context window improvements: add behavioral rule for periodic context checkpointing and structured handoff notes before context resets (lightweight; deeper Warp platform integration deferred to Phase 5)
- **#134** — Visual indicator that Deft is active — add behavioral rule for agent to confirm Deft alignment at session start and after context resets (to be done with #124; true UI indicator deferred to Phase 5 / platform support)
- **#103** — Standalone brownfield/map analysis without requiring interview (allow `/deft:run:map` as independent entry point)
- **#127** — Improved support for Deft in existing repositories — bootstrap should detect existing code and offer brownfield/map analysis path instead of greenfield-only questionnaire (related to #103; CLI integration in Phase 4 with #53)
- **#104** — Add Holzmann Power of 10 rules as opt-in coding standard (`coding/holzmann.md`)
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
  - Branch lifecycle: delete remote branch on merge; prune local branches after pull
- ~~Write remaining CHANGELOG entries~~ — tracked by #71 (Phase 1)
- **#112** — External “Deft Directive” PDF is premature — describes post-Phase-1-3 state; defer distribution or add known-issues caveat; incorporate as `docs/getting-started.md` after Phases 1–3 ship
- **#114** — Document all global Warp rules used for deft development; migrate project-scope rules to `AGENTS.md`/`CONVENTIONS.md`; inventory remaining global-only rules in `CONTRIBUTING.md`
- **#135** — Greptile review rules SKILL.md should be in the Directive repo — version and co-locate bot reviewer configuration (to be done with #114)
- **#136** — Warp doesn't load deft's AGENTS.md by default — document global rule workaround in README/installer output; real fix is Warp platform feature request (to be done with #114)

---

## Phase 3 — Test Infrastructure & CI

- **#74** — Automate release process (`task release`) and CI changelog enforcement
- **#57** — Add GitHub Actions CI workflow for linting and tests on PRs and pushes (minimal Python CI landed in PR #130; Go matrix + coverage remain)
- **#128** — CI vBRIEF schema sync check: fetch upstream `vbrief-core.schema.json` from `deftai/vBRIEF`, diff against vendored copy, fail on divergence (depends on #57)
- **#115** — Strengthen spec validation gate: add CI freshness check detecting stale `SPECIFICATION.md` (schema checks landed in PR #130 — `spec_validate.py` now enforces vBRIEF v0.5 structure, status enum, legacy key detection)
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
- Upgrade GitHub Actions to Node.js 24
  - `actions/checkout`, `actions/setup-go`, `actions/upload-artifact`, `actions/download-artifact`
  - Bump to versions that support Node.js 24 when available (v5+), or set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`

---

## Phase 4 — Package Distribution & Install UX

Publish deft as NPM + PIP CLI packages for developer-audience install.
Complements the Go installer (which targets novice/bare-machine users).

- **#56** — Reduce installation friction — add shell one-liner, Homebrew, and platform package managers (absorbed #101: decide whether manual clone path stays or goes)
- **#53** — deft-install should bootstrap the current directory by default
- **#75** — Skill auto-discovery: make deft skills work in both user projects and deft development (symlinks/copies to `.agents/skills/`, `.claude/skills/`, etc.)
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
- **#55** — Register Deft commands as native agent slash commands (Claude Code, Copilot, Gemini, etc.) — also absorbs slash-command registration scope from #54
- **#46** — Provide a way for users to update meta MD files (SOUL, MORALS, CODE-FIELD, USER, etc.)
- **#77** — Allow users to change technical rating (1/2/3) when starting a new project
- **#78** — Bootstrap: offer to update user preferences when USER.md already exists
- **#86** — Artifact-branch binding and complete audit trail for SDD (dual-format persistence, branch lifecycle hooks, artifact manifest)
- **#76** — Obsidian Vault generation as structured agent memory (interlinked markdown notes, per-agent knowledge scopes)
- **#12** — Deft Bootstrap CLI with TUI (Typer + Textual, strategy-aware feature branching, agent config generation)
- **#9** — Issue tracking system integration (GitHub Issues, Jira, Asana — optional, via MCP)
- **#95** — Compliance-aligned constitution templates + readiness scanners (SOC 2, ISO 27001, HIPAA, HiTrust); sub-issues #96–#100 cover config schema, control mapping registry, scoring, evidence gap analysis, and automation hooks
- **#140** — Automatically check for updates to cloned repos in a project — detect stale cloned dependencies, notify user; part of future `deft doctor`/`deft update` (new CLI tooling)
- LLM-assisted content validation
- Self-upgrade to Deft Directive product (branding, public docs, distribution packaging)

---

## Completed
- ~~#67 — Write SPECIFICATION.md and proper PROJECT.md for the deft project itself~~ — closed (completed)
- ~~#72 — vBRIEF files still invalid on master — five-component generation chain fix (CONVENTIONS.md root cause, validator, renderer, data migration, templates, 7 new tests, minimal CI)~~ — 2026-03-29 (PR #130)
- ~~#91 — run bootstrap goes in a loop~~ — closed (completed)
- ~~#92 — Strategy selection infinite loop when strategies/ empty~~ — closed (completed)
- ~~#106 — Add toolchain/environment validation gate (coding/toolchain.md, deft-build Step 2, strategies/interview.md Acceptance Gate, meta/lessons.md incident entry)~~ — 2026-03-24 (PR #122)
- ~~#105 — Add build output validation directive for custom build scripts (`coding/build-output.md`, `coding/testing.md` Build Output Tests, `meta/lessons.md` incident entry)~~ — 2026-03-24 (PR #121)
- ~~#117 — Interview command loops in CLI — `cmd_project` no longer re-runs questionnaire after `cmd_install` chains through `cmd_spec`~~ — 2026-03-24 (Unreleased)
- ~~#94 — Agent auto-alignment on startup: thin skill pointer + change lifecycle rule~~ — 2026-03-22 (PR #109)
- ~~#54 — AGENTS.md provides no actionable onboarding~~ — 2026-03-20 (PR #93: actionable AGENTS.md, honest installer output, README fixes; absorbed #85)
- ~~#45 — Bootstrap parity~~ — 2026-03-19 (PR #83: CLI and agentic paths produce consistent output, released as v0.7.0)
- ~~#39 — Strategy chaining options before spec generation~~ — 2026-03-16 (bidirectional orchestration, chaining gate, acceptance gate)
- ~~#71 — CHANGELOG catch-up~~ — 2026-03-18 (PR #73: backfilled post-0.6.0 entries, updated release links to `deftai/directive` for v0.2.2+, preserved historical `visionik` links for older versions)
- ~~#63 — Installer hardcodes old repo URL~~ — 2026-03-17 (PR #64: all `visionik/deft` → `deftai/directive`)
- ~~#69 — Remove stale beta branch and update docs~~ — 2026-03-17 (trunk-based workflow, beta branch deleted)
- ~~#34 — Zero-prerequisite installer~~ — 2026-03-17 (merged via PR #42, released as v0.5.0)
- ~~#10 — AGENTS.md setup improvement in docs~~ — 2026-03-17 (PR #66: added manual-clone wiring note in Getting Started)
- ~~#51 — Project bootstrap (partial)~~ — 2026-03-17 (PR #66: AGENTS.md added, old/ removed, core/project.md cleaned; remaining work in #67)
- ~~#60 — pressEnterToExit() Windows-only~~ — 2026-03-17 (PR #66: runtime.GOOS guard)
- ~~#62 — beta branch 50+ unmerged commits~~ — 2026-03-17 (already merged via PR #42)
- ~~#47 — PROJECT.md defaults + input validation~~ — 2026-03-17 (PR #66: all items addressed)
- ~~#44 — CLI bootstrap overwrites USER.md + input validation~~ — 2026-03-17 (PR #66: items 1-4 done; item 5 split to #65, absorbed into #45 — all resolved)
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
| #9 | Issue tracking system integration | 5 |
| #11 | NPM + PIP CLI distribution | 4 |
| #12 | Deft Bootstrap CLI with TUI | 5 |
| #23 | yolo.md duplicates interview.md | 2 |
| #24 | speckit.md missing See also banner | 2 |
| #25 | commands.md vBRIEF example diverges | 2 |
| #31 | Merge default.md into interview.md | 1 |
| #33 | Docker smoke/e2e tests | 3 |
| #46 | Provide way to update meta MD files | 5 |
| #49 | All CLI commands should display version | 1 |
| #50 | Strategies still have redundant old names | 1 |
| #51 | Project should be bootstrapped with own framework (partially done — see PR #66; #67 now complete) | 2 |
| #52 | Install into .deft/ hidden directory | 5 |
| #53 | deft-install should bootstrap current directory | 4 |
| ~~#91~~ | ~~run bootstrap goes in a loop~~ | completed |
| ~~#92~~ | ~~Strategy selection infinite loop when strategies/ empty~~ | completed |
| ~~#94~~ | ~~Agent auto-alignment on startup: thin skill pointer + change lifecycle rule~~ | completed — PR #109 |
| ~~#54~~ | ~~AGENTS.md provides no actionable onboarding (absorbed #85)~~ | completed — PR #93 |
| #55 | Register Deft commands as native agent slash commands (absorbs slash-command scope from #54) | 5 |
| #56 | Reduce installation friction (shell one-liner, Homebrew) | 4 |
| #57 | Add GitHub Actions CI workflow | 3 |
| #128 | CI vBRIEF schema sync check (depends on #57) | 3 |
| #58 | Stale cross-references to legacy paths | 2 |
| #59 | history/changes/ directory missing | 2 |
| ~~#67~~ | ~~Write SPECIFICATION.md and proper PROJECT.md for deft~~ | completed |
| #68 | Warp not always enforcing Deft testing protocols | 1 |
| ~~#72~~ | ~~vBRIEF files still invalid on master~~ | completed — PR #130 |
| #74 | Automate release process and CI changelog enforcement | 3 |
| #75 | Skill auto-discovery for deft skills | 4 |
| #76 | Obsidian Vault generation as structured agent memory | 5 |
| #77 | Allow users to change technical rating per project | 5 |
| #78 | Bootstrap: offer to update user preferences | 5 |
| #79 | deft-setup inference bleeds into ./deft/ internals | 1 |
| #80 | deft-setup project name inference no fallback | 1 |
| #81 | Add BDD/acceptance-test-first strategy | 2 |
| #82 | Replacement strategies need accept-or-scrap exit | 2 |
| #84 | Deft as teacher: contract hierarchy, explain WHY, adaptive teaching mode | 2/5 |
| ~~#85~~ | ~~Installer instructions inaccurate/unclear~~ | closed — absorbed by #54 |
| #95 | Compliance templates + readiness scanners (SOC 2, ISO 27001, HIPAA; sub-issues #96-#100) | 5 |
| #86 | Artifact-branch binding and complete audit trail for SDD | 5 |
| #89 | Deft identity and positioning: resolve naming before README reframe | 2 |
| ~~#101~~ | ~~Should manual clone path exist?~~ | closed — absorbed by #56 |
| #102 | Codify Mermaid gist-rendering best practices | 2 |
| #103 | Standalone brownfield/map analysis without requiring interview | 2 |
| #104 | Holzmann Power of 10 rules (`coding/holzmann.md`) | 2 |
| ~~#105~~ | ~~Build output validation directive for custom build scripts~~ | completed — PR #121 |
| ~~#106~~ | ~~Toolchain/environment validation gate before implementation~~ | completed — PR #122 |
| #107 | Remove language defaults from USER.md | 1 |
| #108 | Ask deployment platform before language | 1 |
| #96 | [Compliance] Config schema + compliance-aware constitution templates | 5 |
| #97 | [Compliance] Framework control mapping registry | 5 |
| #98 | [Compliance] Readiness scanner — control design scoring | 5 |
| #99 | [Compliance] Readiness scanner — operating effectiveness + evidence gap analysis | 5 |
| #100 | [Compliance] Evidence collection automation hooks | 5 |
| #112 | External instruction guide (DEFT Directive PDF) is premature relative to current state | 2 |
| #114 | Document all global Warp rules used for deft directive development | 2 |
| #115 | Strengthen spec validation gate and rendered artifact freshness | 3 |
| #116 | All files must be installed consistently under `./deft/` | 1 |
| #123 | Change lifecycle gate skipped on broad ‘proceed’ instruction | 1 |
| #118 | CLI code quality sweep (version mismatch, bare except, undocumented flags, env var naming) | 1 |
| #124 | Warp context window improvements (behavioral rule + handoff notes) | 2 |
| #126 | specification.vbrief.json does not conform to vbrief schema/spec (verify post-PR #130) | 1 |
| #127 | Improved support for Deft in existing repositories (brownfield bootstrap path; related #103, #53) | 2 |
| #131 | Mac installer post-install text wording fix (bundle with #118) | 1 |
| #133 | Generated vBRIEF files use invalid reference types (blocked on upstream deftai/vBRIEF#2) | 1 |
| #134 | Visual indicator that Deft is active (behavioral rule with #124; true UI deferred Phase 5) | 2 |
| #135 | Greptile review rules SKILL.md in repo (with #114) | 2 |
| #136 | Warp doesn't auto-load AGENTS.md — document workaround (with #114) | 2 |
| #137 | README: move startup instructions higher, clarify installer location | 1 |
| #138 | Branching requirement too prescriptive for solo projects (content fix; full config Phase 5) | 1 |
| #139 | Agent skips vbrief source step, writes SPECIFICATION.md directly (with #68, #123) | 1 |
| #140 | Automatically check for updates to cloned repos in a project (deft doctor/update) | 5 |

---

*Created 2026-03-13 — consolidates todo.md and GitHub Issues into a single roadmap*
*Updated 2026-03-17 — added issues #44-#65, moved #8/#44/#47 to Completed*
*Updated 2026-03-19 — added #84 (Deft as teacher: contract hierarchy, Phase 2 Philosophy & Positioning sub-section, Phase 5 teach strategy); moved #45 to Completed (v0.7.0)*
*Updated 2026-03-20 — added #89 (naming/positioning); moved #39 to Completed; full refresh: added #68/#72/#75-#82/#85/#86; promoted user-reported bugs to Phase 1; resolved #44 (all items done); cleaned stale entries from index; #84 Phase 2 README reframe blocked on #89 resolution*
*Updated 2026-03-20 — promoted #54 to Phase 1 (absorbed #85); #54 scope narrowed (slash-command registration moved to #55); #75 gains depends-on-#54 note; #85 closed as duplicate*
*Updated 2026-03-20 — added #94 to Phase 1 (thin skill pointer + change lifecycle rule; prerequisite for all deft behavior improvements)*
*Updated 2026-03-20 — added #91/#92 (bootstrap loop) to Phase 1; added #95 compliance cluster to Phase 5 (#96–#100 sub-issues)*
*Updated 2026-03-22 — triaged #101–#108: #101 absorbed into #56 (install path decision); #102 (Mermaid rules), #103 (standalone map), #104 (Holzmann rules) added to Phase 2; #105/#106 (build output + toolchain validation), #107/#108 (remove language from USER.md + platform-driven language shortlist) added to Phase 1*
*Updated 2026-03-24 — moved #54/#94 to Completed (PRs #93/#109); added #112/#114 to Phase 2, #115 to Phase 3, #116/#117/#118 to Phase 1; indexed #96–#100 (compliance sub-issues individually); removed incorrect Node.js 24 deadline note*
*Updated 2026-03-24 — moved #117 to Completed (CLI command chaining loop fixed, Unreleased)*
*Updated 2026-03-24 — moved #105 to Completed (PR #121)*
*Updated 2026-03-24 — moved #106 to Completed (PR #122); added #123 to Phase 1 Cleanup*
*Updated 2026-03-29 — added #128 (CI vBRIEF schema sync check, depends on #57) to Phase 3*
*Updated 2026-03-29 — moved #72 to Completed (PR #130); updated #57 (minimal CI landed) and #115 (schema checks landed) descriptions*
*Updated 2026-03-31 — roadmap refresh pass: added #124, #126, #127, #131, #133–#140; moved #67, #91, #92 to Completed; cleaned stale index entries; filed upstream deftai/vBRIEF#2 for #133*
