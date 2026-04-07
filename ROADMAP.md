# Deft Directive — Roadmap

Prioritized work items. **Principle: resolve open issues before new features.**

---

## Phase 1 — Bug Fixes & Issue Resolution (Next Up)

Fix reported bugs and UX problems blocking adoption.
### Adoption Blockers (user-reported, highest priority)

- **#217** -- pyproject.toml dev deps in `[project.optional-dependencies]` breaks `task check` in fresh worktrees -- move dev deps to `[dependency-groups]` (PEP 735), update `languages/python.md` template, regenerate `uv.lock`; silently skips Python test suite in swarm worktrees (xrefs #209, #188)
- **#218** -- deft-swarm: add explicit release decision checkpoint to Phase 0 and Phase 6 -- tentative version bump in Phase 0 Analyze, confirmation gate at Phase 5->6 transition before merge cascade (xrefs #199, #206)

### Cleanup

- **#198** — main.md: add rules against mid-task instant-fix drift and skill-context bleed past instruction boundary — add `⊗` prohibitions (fix-in-place vs. file issue, continue skill past instruction scope) and `!` rule (instruction boundary = exit condition) to Decision Making section; companion `meta/lessons.md` entry (xrefs #159, #167, #184)
- **#200** — Agent must scan `skills/` before improvising multi-step workflows — add `!` rule and `⊗` anti-pattern to AGENTS.md; safety net for #147 routing table gaps; companion `meta/lessons.md` entry (xrefs #147, #75, #198)

---

## Phase 2 — Documentation & Content Fixes

Quick doc/content fixes that don't require code changes.

### Philosophy & Positioning

- **#89** — Deft identity and positioning: resolve naming before README reframe (blocks #84 Phase 2 README reframe, `meta/philosophy.md`, interview strategy updates)

### Content & Doc Fixes

- **#151** — [Playtest Feedback] First-time non-technical user session report (19 issues + 4 strategic recommendations) — umbrella issue; content/wording fixes here, strategic recommendations (cost interview, co-pilot, tiered UX, IP risk flagging) deferred to Phase 5 (xrefs #77, #84, #89, #136)
- **#159** — Deterministic > Probabilistic — design principle: prefer deterministic components for repeatable actions; document in `meta/philosophy.md` or `contracts/hierarchy.md`; ongoing application across CLI/skills/workflows is Phase 5 (xrefs #84, #160, #95, #86)
- **#168** — deft-roadmap-refresh skill: add MUST rule to confirm analysis comment posting to user — transparency improvement (xref #147)
- **#174** — deft-roadmap-refresh skill: add PR & review cycle phase — when triage is complete, prompt user for PR readiness; run pre-push pre-flight (CHANGELOG + `task check`) before pushing; after PR creation, automatically sequence into `skills/deft-review-cycle/SKILL.md` (review cycle Phase 1 audit must happen before push, not after) (xrefs #168, #147)
- **#51** — Project should be fully bootstrapped with its own framework (partially done in PR #66)
- Rename: purge remaining "Warping" references from README.md, `warping.sh`, Taskfile.yml; reframe README per #89 resolution (#84 Phase 2, blocked on #89)
  - `README.md` still says "Warping Process", "What is Warping?", "Contributing to Warping"
  - Reframe from "coding standards framework" → resolved tagline from #89
  - `Taskfile.yml` `VERSION` — update to match latest release
  - `warping.sh` still present — remove or deprecate (replaced by `run` in v0.5.0)
  - Verify: `test_standards.py` xfail for Warping references should flip to passing
- Clean leaked personal files:
  - ~~`core/project.md` — Voxio Bot private project config~~ — done (v0.10.0, t2.1.6: replaced with generic template + legacy redirect)
  - `PROJECT.md` (repo root) — leftover from bootstrap test run; remove or replace
  - Verify: `test_standards.py` xfail for Voxio Bot content should flip to passing
- Update `strategies/interview.md` to probe language/tool choices through the contract lens — when user picks a language, prompt to consider habit vs. suitability (#84 Phase 2)
- Create `meta/philosophy.md` — full contract hierarchy narrative for agent reference and direct user reading (#84 Phase 2)
- **#82** — Replacement strategies need accept-or-scrap exit when plan artifacts already exist (design: artifact awareness for chaining gate)
- **#81** — Add BDD/acceptance-test-first strategy (`strategies/bdd.md` — Given/When/Then scenarios drive requirements)
- **#134** — Visual indicator that Deft is active — add behavioral rule for agent to confirm Deft alignment at session start and after context resets (true UI indicator deferred to Phase 5 / platform support)
- **#103** — Standalone brownfield/map analysis without requiring interview (allow `/deft:run:map` as independent entry point)
- **#127** — Improved support for Deft in existing repositories — bootstrap should detect existing code and offer brownfield/map analysis path instead of greenfield-only questionnaire (related to #103; CLI integration in Phase 4 with #53)
- Add missing strategies:
  - `strategies/rapid.md` — Quick prototypes, SPECIFICATION only workflow
  - `strategies/enterprise.md` — Compliance-heavy, PRD → ADR → SPECIFICATION workflow
  - Both listed in `strategies/README.md` as "(future)" with no backing file
- Port any remaining `SKILL.md` carry-forward content from master
  - Three commits on master updated SKILL.md (`a6f120a`, `cc442fc`, `2f2a89e`)
  - Largely superseded by `deft-setup`/`deft-build` skills; review for carry-forward content
- **#197** — Create `scm/github.md` — standing `gh` CLI rules (`--body-file` as default, immediate verification), PR workflow conventions (squash-merge, single-purpose, branch lifecycle), and Windows/PS 5.x encoding guidance (UTF8 no BOM); absorbs #201; expanded from untracked ROADMAP item based on PR #193 incidents (xrefs #184, #196, #114)
- ~~Write remaining CHANGELOG entries~~ — tracked by #71 (Phase 1)
- **#112** — External “Deft Directive” PDF is premature — describes post-Phase-1-3 state; defer distribution or add known-issues caveat; incorporate as `docs/getting-started.md` after Phases 1–3 ship
- **#114** — Document all global Warp rules used for deft development; migrate project-scope rules to `AGENTS.md`/`CONVENTIONS.md`; inventory remaining global-only rules in `CONTRIBUTING.md`
- **#136** — Warp doesn't load deft's AGENTS.md by default — document global rule workaround in README/installer output; real fix is Warp platform feature request (to be done with #114)
- **#146** — Add `skills/deft-sync/SKILL.md` — session-start sync skill: submodule update, vBRIEF file validation, AGENTS.md freshness check, new-skills listing; design complete in issue body (related: #140 CLI counterpart, #75 auto-discovery)
- **#147** — Skills undiscoverable — no keyword routing in AGENTS.md, 3 skills missing from README — add keyword→skill routing table to AGENTS.md, add `deft-review-cycle`/`deft-roadmap-refresh`/`deft-swarm` to README directory tree and Skills section (xrefs #114, #75, #136, #200)
- **#182** -- Add skills/deft-rwldl/SKILL.md -- iterative pre-PR quality improvement loop (read-write-lint-diff-loop); structured self-review before PR submission
- **#194** — User-facing best practices guide (`docs/best-practices.md`) — Directive contract hierarchy usage, Warp swarming patterns, and user-oriented skill documentation; in-repo successor to premature PDF guide (#112); depends on #147 and #188 for stable content (xrefs #112, #84, #114)
- **#195** — Replace blocking Start-Sleep polling with multi-agent orchestration in review monitor — spawn `start_agent` sub-agent (preferred) or discrete tool-call polling (fallback) to keep conversation pane interactive during review cycle; depends on #188 for capability detection pattern (xrefs #184, #192)
- **#202** — Convention: prefer ASCII in machine-editable structured sections (ROADMAP.md, CHANGELOG.md) — em-dashes, arrows, and emoji cause edit_files failures on Windows; add ~ guidance to use ASCII in phase body entries, index rows, changelog footer; pragmatic workaround for warpdotdev/warp#9022 (xrefs #197, #196)
- **#196** — deft-roadmap-refresh skill: clarify cleanup convention — replace ambiguous "strike through or move" with explicit `!` remove-from-phase-body rule and `⊗` anti-pattern; Completed section is sole record for closed issues; bundle with #168/#174 (xrefs #167)
- **#207** -- Greptile re-review latency on force-push after rebase during swarm merge cascade -- document expected time cost per PR count in swarm skill Phase 6; design decision on skip-re-review convention for rebase-only force-pushes (xrefs #206, #184, #195)
- **#219** -- README.md stale: missing CONTRIBUTING.md, 3 skills, contracts/hierarchy.md, and stale directory tree -- factual corrections to directory tree, Skills section, Contracts section, Contributing section; coordinate with #147 (xrefs #147, #114, #89)

---

## Phase 3 — Test Infrastructure & CI

- **#74** — Automate release process (`task release`) and CI changelog enforcement
- **#57** — Add GitHub Actions CI workflow for linting and tests on PRs and pushes (minimal Python CI landed in PR #130; Go matrix + coverage remain)
- **#128** — CI vBRIEF schema sync check: fetch upstream `vbrief-core.schema.json` from `deftai/vBRIEF`, diff against vendored copy, fail on divergence (depends on #57)
- **#115** — Strengthen spec validation gate: add CI freshness check detecting stale `SPECIFICATION.md` (schema checks landed in PR #130 — `spec_validate.py` now enforces vBRIEF v0.5 structure, status enum, legacy key detection)
- **#33** — When using Docker, smoke tests and e2e tests should validate Docker (docker:up, /healthz)
- CLI tests for remaining commands: `cmd_spec`, `cmd_install`, `cmd_reset`, `cmd_update`
- Error and edge case testing for core CLI commands
- **#163** — Enforce USER.md gate in CLI path — parity with agentic (skills) path
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
- **#160** — Consider TypeScript instead of Python for `run` CLI — architectural decision for CLI overhaul; decide before #11 and #12 (xrefs #118)
- **#212** -- discussion: Process control belongs in Directive -- universal process principles (review cycle, parallel work, batch-fix) as first-class Directive content; skills become tool-specific adapters; explicitly DO NOT IMPLEMENT until team decision reached (xrefs #89, #147, #194, #159)
- LLM-assisted content validation
- Self-upgrade to Deft Directive product (branding, public docs, distribution packaging)

---

## Completed
- ~~#167 -- PR merge hygiene: squash-merge issue-close verification -- PR template, deft-review-cycle Post-Merge Verification, AGENTS.md convention, meta/lessons.md root cause~~ -- 2026-04-06 (v0.12.1)
- ~~#116 -- Installer now creates all 6 skill thin pointers (deft-review-cycle, deft-roadmap-refresh, deft-swarm were missing) -- consistent ./deft/ paths, 3 new path consistency tests~~ -- 2026-04-06 (v0.12.1)
- ~~#84 Phase 1 -- Deft as teacher Phase 1 complete: contracts/hierarchy.md (v0.10.0), adaptive teaching main.md (v0.10.0), State WHY rule interview.md (v0.12.1)~~ -- 2026-04-06 (v0.12.1)
- ~~#209 -- Swarm force-push anti-pattern scope fix + GIT_EDITOR Windows portability + 7 regression tests~~ -- 2026-04-06 (v0.12.0)
- ~~#206 -- Swarm close-out orchestration rules for start_agent monitor workflow -- merge authority, rebase ownership, GIT_EDITOR, post-merge verification, push autonomy, MCP fallback~~ -- 2026-04-06 (v0.12.0)
- ~~#199 -- deft-swarm mandatory analyze phase with user approval gate before launch~~ -- 2026-04-06 (v0.12.0)
- ~~#192 -- Proactively add test coverage after review-fix commits before CI re-run~~ -- 2026-04-06 (v0.12.0)
- ~~#191 -- Remove defensive vBRIEF reference-type workarounds -- deftai/vBRIEF#2 resolved~~ -- 2026-04-06 (v0.12.0)
- ~~#188 -- deft-swarm runtime capability detection for start_agent + Warp environment gate~~ -- 2026-04-06 (v0.12.0)
- ~~#184 -- deft-review-cycle autonomous polling imperative after push~~ -- 2026-04-06 (v0.12.0)
- ~~#166 — Greptile Review status check blocks merge — .greptile/config.json added with triggerOnUpdates, deft-review-cycle pre-flight check~~ — 2026-04-06 (closed)
- ~~#189 — vBRIEF defensive reference-type mitigations — superseded by #191 (deftai/vBRIEF#2 resolved; mitigations no longer needed)~~ — 2026-04-06 (closed, superseded)
- ~~#133 — Generated vBRIEF files use invalid reference types — upstream deftai/vBRIEF#2 resolved; cleanup tracked in #191~~ — 2026-04-05 (closed)
- ~~#58 — Stale cross-references to legacy `core/user.md` and `core/project.md` paths~~ — 2026-04-06 (closed)
- ~~#185 — Change gate UX: replace name-echo with yes/no confirmation — main.md, deft-build, deft-review-cycle, PR template all updated~~ — 2026-04-05 (v0.11.0)
- ~~#179 — deft-swarm Option A limitations documented — Option A demoted, Option B elevated as recommended~~ — 2026-04-05 (v0.11.0)
- ~~#186 — AGENTS.md pre-implementation gate enforcement — ! markers added to Before code changes checklist~~ — 2026-04-05 (v0.11.0)
- ~~#170 — Move ROADMAP.md updates from merge-time to release-time — AGENTS.md convention updated, deft-swarm SKILL.md Phase 6 Step 5 added, ⊗ swarm anti-patterns added~~ — 2026-04-05 (PR #183, v0.10.3)
- ~~#102 — Codify Mermaid gist-rendering best practices — RFC2119 MUST/SHOULD rules + box/end pattern in `languages/mermaid.md`, regression tests added~~ — 2026-04-05 (PR #176, v0.10.3)
- ~~#144 — vBRIEF wrong narrative type (object) + wrong child key (`items` vs `subItems`) — fixed in agent guidance + spec_validate.py (with #126)~~ — 2026-04-05 (PR #181, v0.10.3)
- ~~#126 — specification.vbrief.json schema non-conformance — agent generation guidance, subItems/narrative rules, spec_validate.py hardened, 5 new tests~~ — 2026-04-05 (PR #181, v0.10.3)
- ~~#175 — deft-review-cycle: no-push-while-reviewing + 60s poll cadence — ⊗ rule + ~ guidance + meta/lessons.md #2+#3~~ — 2026-04-03 (PR #178, v0.10.2)
- ~~#172 — deft-swarm skill: oz agent run is local, oz agent run-cloud is cloud — corrected Phase 3, lessons #1+#7, SPECIFICATION.md t2.5.4~~ — 2026-04-03 (PR #177, v0.10.2)
- ~~#171 — No direct-to-master agent commits — ⊗ gate + PROJECT.md trunk-based opt-in, full agentic + CLI parity~~ — 2026-04-03 (PR #178, v0.10.2)
- ~~#145 — deft-review-cycle Greptile issue comment as primary review signal~~ — 2026-04-02 (v0.10.1)
- ~~#142 — AGENTS.md onboarding gate blocks headless/cloud agents — headless bypass added~~ — 2026-04-02 (v0.10.1)
- ~~#139 — Agent skips vbrief source step — ⊗ rule added to main.md and deft-build SKILL.md~~ — 2026-04-02 (v0.10.1)
- ~~#138 — Branching requirement too prescriptive — context-aware solo-project qualifier~~ — 2026-04-02 (v0.10.1)
- ~~#135 — Greptile review rules SKILL.md in repo~~ — 2026-03-31 (PR #143, v0.10.0)
- ~~#131 — Mac installer post-install text~~ — 2026-04-02 (verified fixed in v0.8.0)
- ~~#123 — Change lifecycle gate enforcement — strengthened /deft:change rule~~ — 2026-04-02 (v0.10.1)
- ~~#118 — CLI code quality sweep~~ — 2026-04-02 (v0.10.1)
- ~~#108 — Ask deployment platform before language~~ — 2026-04-02 (v0.10.1)
- ~~#107 — Remove language defaults from USER.md~~ — 2026-04-02 (v0.10.1)
- ~~#80 — deft-setup project name fallback~~ — 2026-04-02 (v0.10.1)
- ~~#79 — deft-setup inference boundary guards~~ — 2026-04-02 (v0.10.1)
- ~~#137 — README: move startup instructions higher, clarify installer location~~ — 2026-04-02 (v0.10.1)
- ~~#68 — Testing enforcement gate — hard gate rule added to main.md~~ — 2026-04-02 (v0.10.1)
- ~~#59 — history/changes/ directory created with README.md~~ — 2026-04-02 (v0.10.0)
- ~~#50 — Strategies redundant old names — brownfield.md redirect, default.md deleted~~ — 2026-04-02 (v0.10.0)
- ~~#49 — All CLI commands display version on startup~~ — 2026-04-02 (v0.10.1)
- ~~#31 — Merge default.md into interview.md~~ — 2026-04-02 (v0.10.0)
- ~~#25 — commands.md vBRIEF example fixed~~ — 2026-04-02 (v0.10.0)
- ~~#24 — speckit.md See also banner~~ — 2026-04-02 (v0.10.0)
- ~~#23 — yolo.md refactored to reference interview.md shared phases~~ — 2026-04-02 (v0.10.0)
- ~~#104 — Add Holzmann Power of 10 rules as opt-in coding standard (`coding/holzmann.md`)~~ — 2026-04-03 (PR #158)
- ~~#124 — Warp context window improvements: behavioral rule for periodic context checkpointing and structured handoff notes~~ — closed (completed)
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
| ~~#23~~ | ~~yolo.md duplicates interview.md~~ | completed — v0.10.0 |
| ~~#24~~ | ~~speckit.md missing See also banner~~ | completed — v0.10.0 |
| ~~#25~~ | ~~commands.md vBRIEF example diverges~~ | completed — v0.10.0 |
| ~~#31~~ | ~~Merge default.md into interview.md~~ | completed — v0.10.0 |
| #33 | Docker smoke/e2e tests | 3 |
| #46 | Provide way to update meta MD files | 5 |
| ~~#49~~ | ~~All CLI commands should display version~~ | completed — v0.10.1 |
| ~~#50~~ | ~~Strategies still have redundant old names~~ | completed — v0.10.0 |
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
| #163 | Enforce USER.md gate in CLI path — parity with agentic (skills) path | 3 |
| ~~#58~~ | ~~Stale cross-references to legacy paths~~ | closed 2026-04-06 |
| ~~#59~~ | ~~history/changes/ directory missing~~ | completed — v0.10.0 |
| ~~#67~~ | ~~Write SPECIFICATION.md and proper PROJECT.md for deft~~ | completed |
| ~~#68~~ | ~~Warp not always enforcing Deft testing protocols~~ | completed — v0.10.1 |
| ~~#72~~ | ~~vBRIEF files still invalid on master~~ | completed — PR #130 |
| #74 | Automate release process and CI changelog enforcement | 3 |
| #75 | Skill auto-discovery for deft skills | 4 |
| #76 | Obsidian Vault generation as structured agent memory | 5 |
| #77 | Allow users to change technical rating per project | 5 |
| #78 | Bootstrap: offer to update user preferences | 5 |
| ~~#79~~ | ~~deft-setup inference bleeds into ./deft/ internals~~ | completed — v0.10.1 |
| ~~#80~~ | ~~deft-setup project name inference no fallback~~ | completed — v0.10.1 |
| #81 | Add BDD/acceptance-test-first strategy | 2 |
| #82 | Replacement strategies need accept-or-scrap exit | 2 |
|| ~~#84~~ | ~~Deft as teacher Phase 1: contract hierarchy, adaptive teaching, State WHY~~ | completed -- v0.12.1 |
| ~~#85~~ | ~~Installer instructions inaccurate/unclear~~ | closed — absorbed by #54 |
| #95 | Compliance templates + readiness scanners (SOC 2, ISO 27001, HIPAA; sub-issues #96-#100) | 5 |
| #86 | Artifact-branch binding and complete audit trail for SDD | 5 |
| #89 | Deft identity and positioning: resolve naming before README reframe | 2 |
| ~~#101~~ | ~~Should manual clone path exist?~~ | closed — absorbed by #56 |
| ~~#102~~ | ~~Codify Mermaid gist-rendering best practices~~ | completed — v0.10.3 |
| #103 | Standalone brownfield/map analysis without requiring interview | 2 |
| ~~#104~~ | ~~Holzmann Power of 10 rules (`coding/holzmann.md`)~~ | completed — PR #158 |
| ~~#105~~ | ~~Build output validation directive for custom build scripts~~ | completed — PR #121 |
| ~~#106~~ | ~~Toolchain/environment validation gate before implementation~~ | completed — PR #122 |
| ~~#107~~ | ~~Remove language defaults from USER.md~~ | completed — v0.10.1 |
| ~~#108~~ | ~~Ask deployment platform before language~~ | completed — v0.10.1 |
| #96 | [Compliance] Config schema + compliance-aware constitution templates | 5 |
| #97 | [Compliance] Framework control mapping registry | 5 |
| #98 | [Compliance] Readiness scanner — control design scoring | 5 |
| #99 | [Compliance] Readiness scanner — operating effectiveness + evidence gap analysis | 5 |
| #100 | [Compliance] Evidence collection automation hooks | 5 |
| #112 | External instruction guide (DEFT Directive PDF) is premature relative to current state | 2 |
| #114 | Document all global Warp rules used for deft directive development | 2 |
| #115 | Strengthen spec validation gate and rendered artifact freshness | 3 |
|| ~~#116~~ | ~~All files must be installed consistently under `./deft/`~~ | completed -- v0.12.1 |
| ~~#123~~ | ~~Change lifecycle gate skipped on broad 'proceed' instruction~~ | completed — v0.10.1 |
| ~~#118~~ | ~~CLI code quality sweep (version mismatch, bare except, undocumented flags, env var naming)~~ | completed — v0.10.1 |
| ~~#124~~ | ~~Warp context window improvements (behavioral rule + handoff notes)~~ | completed |
| ~~#126~~ | ~~specification.vbrief.json does not conform to vbrief schema/spec~~ | completed — v0.10.3 |
| ~~#144~~ | ~~Directive giving invalid vBRIEF files & wrong key names (address with #126)~~ | completed — v0.10.3 |
| #127 | Improved support for Deft in existing repositories (brownfield bootstrap path; related #103, #53) | 2 |
| ~~#131~~ | ~~Mac installer post-install text wording fix~~ | completed — v0.10.1 |
| ~~#133~~ | ~~Generated vBRIEF files use invalid reference types~~ | closed 2026-04-05 |
| #134 | Visual indicator that Deft is active (behavioral rule; true UI deferred Phase 5) | 2 |
| ~~#135~~ | ~~Greptile review rules SKILL.md in repo~~ | completed — PR #143 |
| #136 | Warp doesn't auto-load AGENTS.md — document workaround (with #114) | 2 |
| ~~#137~~ | ~~README: move startup instructions higher, clarify installer location~~ | completed — v0.10.1 |
| ~~#138~~ | ~~Branching requirement too prescriptive for solo projects~~ | completed — v0.10.1 |
| ~~#139~~ | ~~Agent skips vbrief source step, writes SPECIFICATION.md directly~~ | completed — v0.10.1 |
| #140 | Automatically check for updates to cloned repos in a project (deft doctor/update) | 5 |
| ~~#142~~ | ~~AGENTS.md onboarding gate blocks headless/cloud agents~~ | completed — v0.10.1 |
| ~~#145~~ | ~~deft-review-cycle: Greptile issue comment not primary review signal (false wait loops)~~ | completed — v0.10.1 |
| ~~#172~~ | ~~deft-swarm skill: oz agent run correction (Phase 3, lessons, SPECIFICATION.md)~~ | completed — v0.10.2 |
| ~~#166~~ | ~~Greptile Review status check blocks merge~~ | closed |
|| ~~#192~~ | ~~Proactively add test coverage after review-fix commits before CI re-run~~ | completed -- v0.12.0 |
|| ~~#191~~ | ~~Remove defensive vBRIEF reference-type workarounds -- deftai/vBRIEF#2 resolved~~ | completed -- v0.12.0 |
|| ~~#184~~ | ~~deft-review-cycle: add autonomous polling imperative after push~~ | completed -- v0.12.0 |
|| ~~#167~~ | ~~PRs merged but issues not closed and roadmap not updated~~ | completed -- v0.12.1 |
| ~~#171~~ | ~~No direct-to-master agent commits — ⊗ gate + PROJECT.md opt-in~~ | completed — v0.10.2 |
| ~~#175~~ | ~~deft-review-cycle: no-push-while-reviewing + 60s poll cadence~~ | completed — v0.10.2 |
| #151 | [Playtest Feedback] First-time non-technical user session report (umbrella) | 2 |
| #159 | Deterministic > Probabilistic — design principle documentation | 2 |
| #160 | Consider TypeScript instead of Python for run CLI | 5 |
| #168 | deft-roadmap-refresh skill: confirm analysis comment posting to user | 2 |
| #174 | deft-roadmap-refresh skill: add review cycle step after PR push | 2 |
| #146 | Add skills/deft-sync/SKILL.md — session-start framework sync skill | 2 |
| #147 | Skills undiscoverable — no keyword routing in AGENTS.md, 3 skills missing from README | 2 |
|| ~~#188~~ | ~~Update deft-swarm: runtime start_agent capability detection + Warp environment gate~~ | completed -- v0.12.0 |
|| ~~#199~~ | ~~deft-swarm skill: add mandatory analyze phase with user approval gate before launch~~ | completed -- v0.12.0 |
| #194 | User-facing best practices guide — Directive usage, Warp swarming, skill documentation | 2 |
| #195 | Replace blocking Start-Sleep polling with multi-agent orchestration in review monitor | 2 |
| #196 | deft-roadmap-refresh skill: clarify cleanup convention — remove from phase body, not strike through | 2 |
| #197 | Create scm/github.md — gh CLI rules, PR workflow conventions, Windows encoding guidance (absorbs #201) | 2 |
| #198 | main.md: rules against instant-fix drift and skill-context bleed | 1 |
| #200 | Agent must scan skills/ before improvising multi-step workflows | 1 |
| ~~#201~~ | ~~scm/github.md: add --body-file convention~~ | closed — absorbed by #197 |
|| #202 | Convention: prefer ASCII in machine-editable structured sections | 2 |
|| #207 | Greptile re-review latency on force-push after rebase during swarm merge cascade | 2 |
|| #212 | discussion: Process control belongs in Directive (DO NOT IMPLEMENT -- discussion only) | 5 |
|| #218 | deft-swarm: add explicit release decision checkpoint to Phase 0 and Phase 6 | 1 |
|| #219 | README.md stale: missing CONTRIBUTING.md, 3 skills, contracts/hierarchy.md, stale directory tree | 2 |
|| #217 | pyproject.toml dev deps breaks task check in fresh worktrees (swarm adoption blocker) | 1 |
| #182 | Add skills/deft-rwldl/SKILL.md — iterative pre-PR quality improvement loop | 2 |
| ~~#170~~ | ~~Move ROADMAP.md updates from merge-time to release-time~~ | completed — v0.10.3 |

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
*Updated 2026-03-31 — roadmap refresh: added #142 to Phase 1 Adoption Blockers; moved #124 to completed; updated #134 description (no longer grouped with #124); improved deft-roadmap-refresh skill with Phase 0 branch/worktree setup*
*Updated 2026-04-02 — roadmap refresh: added #144 to Phase 1 (vBRIEF wrong narrative type + items/subItems bug, address with #126); fixed stray pipes in index*
*Updated 2026-04-02 — roadmap refresh: added #145 to Phase 1 Adoption Blockers (deft-review-cycle Greptile signal bug, split from #135)*
*Updated 2026-04-02 — roadmap refresh: added #146 to Phase 2 (deft-sync skill, session-start framework sync); added #147 to Phase 2 (skills undocumented in README/AGENTS.md)*
*Updated 2026-04-02 — note: #143 is a merged PR (feat: add deft-review-cycle skill, PR #143), not an open issue; correctly absent from triage*
*Updated 2026-04-02 — added #163 to Phase 3 (Enforce USER.md gate in CLI path — parity with agentic skills path)*
*Updated 2026-04-03 — stale entry cleanup: moved 21 closed issues (#23, #24, #25, #31, #49, #50, #59, #68, #79, #80, #107, #108, #118, #123, #131, #135, #137, #138, #139, #142, #145) from Phase 1/2 body to Completed section; struck through in Open Issues Index; closed #104, #137, #145 on GitHub*
*Updated 2026-04-03 — roadmap refresh triage: added #166 (Greptile re-review, Phase 1), #167 (PR merge hygiene, Phase 1), #151 (playtest feedback umbrella, Phase 2), #159 (deterministic principle, Phase 2), #160 (TypeScript CLI, Phase 5), #168 (skill transparency, Phase 2)*
*Updated 2026-04-03 — roadmap refresh triage: added #170 (ROADMAP update timing, Phase 2)*
*Updated 2026-04-03 — roadmap refresh triage: added #171 (no direct-to-master agent commits, Phase 1 Cleanup)*
*Updated 2026-04-03 — roadmap refresh triage: added #172 (deft-swarm oz agent run correction, Phase 1 Adoption Blockers, priority next)*
*Updated 2026-04-03 — filed and triaged #175 (deft-review-cycle no-push-during-review gate, Phase 1 Cleanup)*
*Updated 2026-04-03 — filed and triaged #174 (deft-roadmap-refresh review cycle chaining, Phase 2)*
*Updated 2026-04-03 — v0.10.2 release: moved #171, #172, #175 to Completed*
*Updated 2026-04-05 — v0.10.3 release: moved #126, #144 (vBRIEF conformance), #102 (Mermaid guidance), #170 (ROADMAP update convention) to Completed; cleaned #171/#175 from Phase 1 Cleanup body (already completed in v0.10.2)*
*Updated 2026-04-06 — roadmap refresh triage: added #192 to Phase 1 Adoption Blockers (proactive test coverage after review-fix commits)*
*Updated 2026-04-06 — roadmap refresh triage: added #191 to Phase 1 Adoption Blockers (remove vBRIEF defensive workarounds, deftai/vBRIEF#2 resolved)*
*Updated 2026-04-06 — roadmap refresh triage: added #188 to Phase 2 (deft-swarm runtime capability detection + Warp environment gate; issue reshaped from static Option D to tool-presence-based detection)*
*Updated 2026-04-06 — roadmap refresh triage: added #184 to Phase 1 Adoption Blockers (deft-review-cycle autonomous polling imperative)*
*Updated 2026-04-06 — roadmap refresh cleanup: moved #133 (closed 2026-04-05) and #58 (closed 2026-04-06) to Completed; struck through in phase bodies and index*
*Updated 2026-04-06 — closed #189 on GitHub as superseded by #191 (vBRIEF defensive mitigations no longer needed now that deftai/vBRIEF#2 is resolved)*
*Updated 2026-04-06 — roadmap refresh triage: added #182 to Phase 2 (deft-rwldl skill: iterative pre-PR quality loop)*
*Updated 2026-04-06 — roadmap refresh: triaged #194 (Phase 2), #195 (Phase 2), #196 (Phase 2), #197 (Phase 2, absorbs #201), #198 (Phase 1), #199 (Phase 1), #200 (Phase 1); promoted #188 Phase 2→Phase 1; closed #201 (absorbed by #197); moved #166 to Completed; updated #147 title/body for expanded scope; added #202 (ASCII convention for machine-editable sections, Phase 2)*
*Updated 2026-04-06 -- v0.12.1 release: moved #116 (installer path consistency), #167 (PR merge hygiene), #84 Phase 1 (Deft as teacher Phase 1 complete) to Completed; added CONTRIBUTING.md (t2.3.1)*
*Updated 2026-04-07 -- roadmap refresh triage: added #217 to Phase 1 Adoption Blockers (pyproject.toml dev deps breaks task check in fresh worktrees; swarm adoption blocker), #218 to Phase 1 Adoption Blockers (swarm release decision checkpoint), #207 to Phase 2 (Greptile re-review latency on swarm merge cascade), #219 to Phase 2 (README.md stale content), #212 to Phase 5 (process control in Directive -- discussion only); cleanup: struck through #184/#188/#191/#192/#199 in index (completed v0.12.0), removed duplicate bare #198, added #182 description*
