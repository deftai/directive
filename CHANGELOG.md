# Changelog

All notable changes to the Deft framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **vBRIEF-centric document model in vbrief.md** (#310, Part of #309): Rewrote File Taxonomy section with lifecycle folder structure (proposed/, pending/, active/, completed/, cancelled/), status-to-folder mapping, PROJECT-DEFINITION.vbrief.json type, scope vBRIEF filename convention (YYYY-MM-DD-descriptive-slug.vbrief.json), status-driven moves (plan.status as source of truth), origin provenance requirement, bidirectional epic-story linking, plan.vbrief.json and continue.vbrief.json coexistence with scope vBRIEFs (planRef), scope splitting pattern; added PROJECT-DEFINITION.vbrief.json section; updated plan.vbrief.json and continue.vbrief.json sections with scope vBRIEF references; added 4 new anti-patterns
- **Scope lifecycle task commands for vBRIEF model** (#324, RFC #309 D16): Created `scripts/scope_lifecycle.py` with 7 deterministic lifecycle transitions (`task scope:promote`, `scope:activate`, `scope:complete`, `scope:cancel`, `scope:restore`, `scope:block`, `scope:unblock`); each command validates the transition is legal, updates `plan.status` and `plan.updated` timestamp, moves the file to the target lifecycle folder (or keeps in place for block/unblock), and reports the transition performed; invalid transitions rejected with descriptive errors; block/unblock are idempotent (no-op if already in target state); target folders created automatically if missing; created `tasks/scope.yml` with all 7 task definitions; added `scope` include to `Taskfile.yml`; created `tests/cli/test_scope_lifecycle.py` with 38 tests covering all transitions, invalid transitions, idempotent behavior, validation edge cases, full lifecycle round-trips, and CLI subprocess integration
- **Roadmap generation tool (`task roadmap:render`) with drift detection** (#311, #309): Created `scripts/roadmap_render.py` -- deterministic script that generates ROADMAP.md from `vbrief/pending/*.vbrief.json` files; groups by phase (vBRIEF item hierarchy), orders by dependencies (vBRIEF edges), surfaces GitHub issue numbers from references entries, adds auto-generated banner warning against manual edits; handles empty/missing pending/ gracefully (produces valid empty ROADMAP.md); drift detection via `task roadmap:check` or `--check` flag compares current ROADMAP.md against expected output; registered as `task roadmap:render` and `task roadmap:check` in `tasks/roadmap.yml`; 26 tests in `tests/cli/test_roadmap_render.py` covering phase grouping, dependency ordering, issue refs, banner, determinism, drift detection, CLI modes, and edge cases
- **PROJECT-DEFINITION regeneration tool (`task project:render`)** (#323, RFC #309 D14): Created `scripts/project_render.py` with deterministic two-layer regeneration for `vbrief/PROJECT-DEFINITION.vbrief.json` -- scans all 5 lifecycle folders (proposed/, pending/, active/, completed/, cancelled/) for `*.vbrief.json` files, updates items registry with scope entries (title, status, file path, references), timestamps freshness (`vBRIEFInfo.updated`), flags narratives that may be stale based on completed scope topics (keyword matching + general review threshold); creates skeleton with empty narratives if no PROJECT-DEFINITION exists; handles missing/empty folders and malformed files gracefully; agent-assisted narrative review layer documented in code comments; registered as `task project:render` via `tasks/project.yml` with alias in `Taskfile.yml`; 23 subprocess-based tests in `tests/cli/test_project_render.py` covering skeleton creation, all 5 folder scans, update preservation, timestamp refresh, staleness flagging, determinism, graceful error handling, and CLI usage
- **feat(tasks): add migrate:vbrief migration script for vBRIEF-centric cutover** (#312): Created `scripts/migrate_vbrief.py` and registered as `task migrate:vbrief` -- automated migration converts existing Deft projects to vBRIEF-centric folder structure (RFC #309); parses `specification.vbrief.json` + `PROJECT.md` to generate `PROJECT-DEFINITION.vbrief.json` with narratives + items registry (D3); creates 5 lifecycle folders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/` per D13); converts `ROADMAP.md` items to individual `pending/` scope vBRIEFs with origin provenance references (D11); replaces `SPECIFICATION.md` and `PROJECT.md` with deprecation redirects containing `<!-- deft:deprecated-redirect -->` sentinel for Story S (#334) integrity checks; detects user-customized content before replacing and preserves it in PROJECT-DEFINITION narratives; migration is idempotent; 40 unit tests in `tests/cli/test_migrate_vbrief.py`
- **vBRIEF validation tooling for centric document model** (#333, RFC #309): Created `scripts/vbrief_validate.py` with 6 validators -- scope vBRIEF schema validation (vBRIEFInfo.version, plan.title/status/items, status enum, narratives), filename convention check (YYYY-MM-DD-descriptive-slug.vbrief.json per D7), folder/status consistency (D2/D13), PROJECT-DEFINITION.vbrief.json validation (D3 -- narratives keys, items registry references), epic-story bidirectional link validation (D4 -- forward references + planRef back-references), origin provenance warnings (D11 -- pending/active without origin type). Created `tasks/vbrief.yml` with `vbrief:validate` task; wired as dependency of `task check` pipeline. Created `tests/cli/test_vbrief_validate.py` with 43 subprocess-based tests covering all validator checks. ASCII-safe output for Windows cp1252 compatibility.

## [0.19.0] - 2026-04-13

### Added
- **Regression tests for deft-setup Phase 1/2 deft-interview references** (#304, t1.29.1): Added `test_deft_setup_phase1_references_deft_interview` and `test_deft_setup_phase2_references_deft_interview` to `tests/content/test_skills.py` verifying both phases reference deft-interview
- **Greptile review cycle optimization -- 5-change bundle** (#305, t1.30.1): Mandated deft-pre-pr before PR creation (upgraded AGENTS.md rule from ~ to !, added Phase 1 verification gate); added PR scope gate warning for 3+ unrelated surfaces; replaced fixed 60s poll with adaptive cadence (~20-30s/60s/90s); added parallel rebase + review monitoring guidance to deft-swarm Phase 6; elevated .greptile/rules.md to SHOULD with starter template
- **deft-review-cycle Approach 3 -- interactive blocking fallback** (#307, t1.31.1): Added Approach 3 as last-resort blocking Start-Sleep loop for interactive sessions with no start_agent and no timer; gated by ! user warning rule; updated capability detection to 3 tiers
- **Select-String fallback for oversized gh pr view output** (#328, t1.32.1): Added ~ fallback command to deft-review-cycle Phase 2 Step 1 for when do_not_summarize_output produces output too large to process (Windows/PowerShell context)
- **Subprocess-based unit tests for v0.17.0 task scripts** (#293, t3.3.4): Created `tests/cli/test_task_scripts.py` with 25 subprocess-based tests covering `scripts/toolchain-check.py` (happy path, missing tool, NOT FOUND reporting, timeout parameter), `scripts/verify-stubs.py` (clean source, TODO/FIXME/HACK/bare-pass detection, excluded dirs, encoding edge case), `scripts/validate-links.py` (valid links, broken strict/warning modes, external URL skip, archive exclusion, --strict argv), `change:init` task (directory structure, path traversal rejection, empty name, duplicate handling), and `commit:lint` task (valid conventional commit, missing type, breaking change, all 11 types); filled t3.3.4 acceptance criteria in SPECIFICATION.md; coverage remains at 87.58% (>=85%)

### Fixed
- **deft-interview invocation contract clarification** (#302, t1.27.1): Added embedded mode vs delegation mode distinction to Invocation Contract section of `skills/deft-interview/SKILL.md` -- embedded mode (calling skill references rules inline, no contract object needed, used by deft-setup) vs delegation mode (explicit sub-skill invocation with formal contract object)
- **deft-interview Rule 5 vs Rule 6 ok inconsistency** (#303, t1.28.1): Added clarifying note to Rule 6 confirmation gate explaining intentional strictness asymmetry -- Rule 5 accepts casual `ok` for individual defaults (low cost, correctable), Rule 6 requires explicit `yes`/`confirmed`/`approve` for entire artifact (high cost, guards against auto-fill)
- **Tighten deft-interview routing keyword** (#301, t1.26.1): Replaced bare interview keyword in AGENTS.md Skill Routing with interview loop / q&a loop / run interview loop to avoid collision with strategies/interview.md
- **Spec status sync -- flip 24 stale `[pending]` task statuses to `[completed]`** (#298, t1.25.1): Full audit of SPECIFICATION.md against CHANGELOG.md and ROADMAP.md identified 24 tasks showing `[pending]` that shipped in v0.14.0 (t3.1.1, t3.1.2, t3.1.3, t2.7.1--t2.7.8), v0.16.0 (t1.14.1, t1.15.1, t1.18.1, t1.19.1, t1.20.1), v0.17.0 (t3.3.1, t3.3.2, t3.3.3), and v0.18.0 (t1.21.1, t1.22.1, t1.23.1, t1.24.1, t2.11.1); flipped all 24 in one pass; no task body content changed

### Changed
- **Roadmap Refresh (2026-04-13)**: Triaged 8 items (23 individual issues including a 16-issue RFC bundle) -- #301 (Phase 1 Cleanup: tighten deft-interview routing keyword, t1.26.1), #302 (Phase 1 Cleanup: clarify deft-interview invocation contract embedded vs delegation modes, t1.27.1), #303 (Phase 1 Cleanup: fix deft-interview Rule 5 vs Rule 6 ok/confirmation-gate inconsistency, t1.28.1), #304 (Phase 1 Cleanup: regression test for deft-setup Phase 1/2 referencing deft-interview, t1.29.1), #305 (Phase 1 Adoption Blockers: Greptile review cycle bottlenecks -- 5-change bundle: mandatory deft-pre-pr, PR scope gate, adaptive poll cadence, parallel swarm cascade monitoring, .greptile/rules.md template, t1.30.1), #307 (Phase 1 Adoption Blockers: deft-review-cycle Approach 2 silent failure in interactive sessions -- add Approach 3 blocking fallback with user warning, t1.31.1), #309 + stories #310-#324 (Phase 2 vBRIEF Architecture Cutover RFC: 18 design decisions + 15 stories; big-bang cutover to vBRIEF lifecycle folders, ROADMAP.md as generated artifact, all skills renamed to deft-directive-*, t2.12.1); closed #308 (absorbed by #309 RFC); restructured roadmap phases -- inserted Phase 2 (vBRIEF Architecture Cutover), shifted Phases 2-5 to 3-6; stale cleanup: moved #293 and #298 (both closed) to Completed; analysis comments posted on all triaged issues
- **Roadmap Refresh (2026-04-12)**: Triaged 1 new issue -- #298 (Phase 1 Cleanup: flip 5 stale `[pending]` spec task statuses to `[completed]` in SPECIFICATION.md -- t1.14.1, t1.15.1, t1.18.1, t1.19.1, t1.20.1 -- shipped v0.16.0 but SPECIFICATION.md not synced, t1.25.1); no stale entries; analysis comment posted on #298

## [0.18.0] - 2026-04-10

### Added
- **skills/deft-interview/SKILL.md -- deterministic structured Q&A interview skill** (#296, t2.11.1): Created `skills/deft-interview/SKILL.md` with RFC2119 legend and YAML frontmatter encoding a deterministic interview loop any skill can invoke -- 7 rules: one-question-per-turn, numbered options with stated default (`[default: N]`), explicit other/IDK escape option, depth gate, default-acceptance, confirmation gate, and structured handoff contract (answers map); created `.agents/skills/deft-interview/SKILL.md` thin pointer; added AGENTS.md Skill Routing entry; updated deft-setup Phase 1 and Phase 2 to reference deft-interview; added 12 tests
- **deft-swarm Phase 6 Slack release announcement** (#292, t1.22.1): Added Step 6 to `skills/deft-swarm/SKILL.md` Phase 6 -- generates standard Slack announcement block with version, release title, summary, key changes, swarm agent count, duration, PR numbers, and GitHub release URL

### Fixed
- **deft-swarm Phase 6 read-back verification after rebase conflict resolution** (#288, t1.21.1): Added `!` rule to Phase 6 Step 1 requiring re-read and structural integrity verification after resolving rebase conflicts and before `git add`; added `!` rule preferring `edit_files` over shell regex for CHANGELOG.md/SPECIFICATION.md; added 2 anti-patterns
- **Strengthen test-with-code rule across 4 surfaces** (#294, t1.23.1): Added `!` rule to AGENTS.md Before committing requiring new source files to include test files; updated main.md testing gate to distinguish regression vs forward coverage; added constraint to deft-swarm Prompt Template; added forward test coverage check to deft-build pre-commit checklist
- **Resolve 5 untracked xfail gaps in known_failures.json** (#295, t1.24.1): Flipped 20 xfail entries to passing across 5 gap categories -- (1) flipped 3 stale xfails for root PROJECT.md and core/project.md (already cleaned in prior PRs); (2) created tools/taskfile-migration.md stub to resolve broken See also link from tools/taskfile.md; (3) standardized RFC2119 legend format in 5 context/*.md files and added legend to languages/commands.md; (4) added missing shape sections to 8 files (## Commands to languages/6502-DASM.md, languages/markdown.md, languages/mermaid.md; ## Workflow to strategies/discuss.md, strategies/research.md; ## Framework Selection or ## Core Architecture to interfaces/cli.md, interfaces/rest.md, interfaces/web.md); (5) rephrased deprecated path and legacy name references in specs/testbed/SPECIFICATION.md to avoid triggering content tests

### Changed
- **Roadmap Refresh (2026-04-10)**: Triaged 6 new issues -- #288 (Phase 1 Cleanup: deft-swarm Phase 6 read-back verification after rebase conflict resolution, t1.21.1), #292 (Phase 1 Cleanup: auto-generate Slack release announcement after swarm release, t1.22.1), #293 (Phase 3: unit tests for v0.17.0 deterministic task scripts, t3.3.4), #294 (Phase 1 Cleanup: strengthen test-with-code rule across AGENTS.md/main.md/deft-swarm/deft-build, t1.23.1), #295 (Phase 1 Cleanup: resolve 5 untracked xfail gaps in known_failures.json, t1.24.1), #296 (Phase 2: skills/deft-interview/SKILL.md -- deterministic structured Q&A interview skill, t2.11.1); no stale entries; analysis comments posted on all 6 issues

## [0.17.0]

### Added
- **Taskfile modular restructure** (#233, t3.3.1): Restructured monolithic `Taskfile.yml` into modular includes under `tasks/` -- created `tasks/core.yml` (validate, fmt, lint, test, test:coverage, build, clean, stats), `tasks/spec.yml` (validate, render, pipeline), `tasks/install.yml` (install, uninstall), `tasks/deployments.yml` (moved from `taskfiles/`); root `Taskfile.yml` is now version + vars + includes + default task + backward-compatible aliases; fixed stale VERSION var (0.14.0 -> 0.17.0); deleted `taskfiles/` directory
- **Toolchain verification task** (#233, #235, t3.3.2): Created `tasks/toolchain.yml` with `toolchain:check` task and `scripts/toolchain-check.py` -- verifies go, uv, task, git, gh are installed; wired as dep of enhanced `check` task
- **Code verification tasks** (#235, t3.3.2): Created `tasks/verify.yml` with `verify:stubs` (scans .py/.go/.sh for TODO/FIXME/HACK/stub patterns via `scripts/verify-stubs.py`) and `verify:links` (checks .md internal link targets via `scripts/validate-links.py`, warning mode for pre-existing broken links, `--strict` flag or `LINK_CHECK_STRICT=1` for strict mode); both wired as deps of enhanced `check` task
- **Spec tasks t3.3.1 and t3.3.2** added to `SPECIFICATION.md` for Taskfile restructure and verification tasks
- **changelog:check, change:init, and commit:lint tasks** (#233, #235, t3.3.3): Created `tasks/change.yml` with `changelog:check` (verifies CHANGELOG.md [Unreleased] section has at least one entry, exits non-zero if missing) and `change:init` (scaffolds `history/changes/<name>/` with proposal.md, design.md, tasks.vbrief.json, and specs/ subdirectory per commands.md templates). Created `tasks/commit.yml` with `commit:lint` (validates HEAD commit message against conventional commit format -- type(scope): description; accepted types: feat, fix, docs, chore, refactor, test, style, perf, ci, build; exits non-zero on violation). Both task files are standalone with `version: '3'` for independent testability.

## [0.16.0] - 2026-04-10

### Added
- **deft-setup USER.md/PROJECT.md versioning** (#270, t3.2.1): Added `deft_version` field to USER.md and PROJECT.md templates in `skills/deft-setup/SKILL.md`; added USER.md Freshness Detection subsection -- detects stale USER.md via missing or outdated `deft_version`, queries missing fields individually without re-running full interview, writes current version after migration; added `!` rule requiring `deft_version` on every generate/update and anti-pattern against omitting it; added 4 tests to `tests/content/test_skills.py`
- **deft-setup post-interview confirmation gate and Warp auto-approve warning** (#269, t1.17.1, absorbs #271): Added Post-Interview Confirmation Gate section to `skills/deft-setup/SKILL.md` -- after completing all interview questions for any phase, agent must display a summary of all captured values and require explicit yes/no confirmation before writing USER.md, PROJECT.md, or any other artifacts; includes auto-fill filler detection warning; added Warp Auto-Approve Warning section documenting that Warp AI autonomy must be set to "Always ask" in AI -> Profile Settings before running deft-setup; added 2 anti-patterns against writing without confirmation and treating broad "proceed" as file-write confirmation

### Fixed
- **deft-review-cycle Approach 2 idle-stoppage warning** (#279, t1.14.1): Added warning to Approach 2 section documenting that yield-between-polls is NOT autonomous for swarm agents -- yielding ends the agent's turn with no self-wake mechanism; added `!` rule directing swarm agents to prefer Approach 1 when `start_agent` is available; added anti-pattern against assuming Approach 2 produces a self-sustaining polling loop
- **deft-review-cycle MCP capability detection + task check carve-out** (#282, t1.19.1): Added MCP capability probe to Phase 2 Step 1 mirroring deft-swarm Phase 3 pattern -- if MCP unavailable, use `gh api` as explicit fallback with documentation requirement; added pre-existing failure carve-out to Step 3 allowing partial `task check` only when failure is pre-existing with open issue number AND PR description notes the failure; added 2 new anti-patterns (skip second review source without capability probe, run partial test suite without documenting pre-existing failure)
- **deft-setup path resolution anchored to pwd at skill entry** (#272, t1.16.1): Added `!` Path Resolution Anchor rule to `skills/deft-setup/SKILL.md` Phase 2 -- all paths must be resolved relative to the user's working directory (pwd) at skill entry, never relative to the skill file, AGENTS.md, or any framework directory; prevents silent false-positive bootstrap detection when deft is cloned into a project subdirectory; added corresponding anti-pattern
- **Semantic accuracy check in mandatory pre-commit file review** (#274, t1.15.1): Added semantic accuracy check as a fourth check category to `skills/deft-roadmap-refresh/SKILL.md` Phase 4 pre-flight mandatory file review and `skills/deft-build/SKILL.md` pre-commit checklist -- verify that counts, claims, and summaries in CHANGELOG entries and ROADMAP changelog lines match the actual data in the commit
- **WinError 448 pytest-current symlink cleanup on Windows 11 24H2+** (#281, t1.18.1): Added `tmp_path_retention_count = 0` to `[tool.pytest.ini_options]` in `pyproject.toml` to prevent old-session temp dir retention; added module-level monkeypatch in `tests/conftest.py` wrapping `cleanup_dead_symlinks` and `cleanup_numbered_dir` in `_pytest.pathlib` and `_pytest.tmpdir` to suppress `OSError` during session-finish and atexit cleanup -- pytest creates `*current` directory symlinks that Windows 11 24H2+ flags as untrusted mount points (WinError 448)
- **AGENTS.md BOM-safe PowerShell file write rule** (#283, t1.20.1): Added `## PowerShell` section to `AGENTS.md` with `!` rule requiring `New-Object System.Text.UTF8Encoding $false` for file writes -- prevents agents from using `[System.Text.Encoding]::UTF8` which writes a BOM; cross-references `scm/github.md` PS 5.1 section
- **--body-file convention updated to OS temp directory** (#256, t1.13.2): Updated `scm/github.md` `--body-file` rules to write temp files to the OS temp directory (`$env:TEMP`/`GetTempFileName` on PowerShell, `mktemp`/`$TMPDIR` on Unix) instead of the worktree -- eliminates the `rm` denylist collision that blocks autonomous swarm agents in Warp; added PowerShell and Unix examples; noted no explicit `rm` needed (OS handles cleanup); added `⊗` anti-pattern against writing temp files in the worktree; updated `skills/deft-swarm/SKILL.md` Prompt Template Step 5 with OS temp dir note; added `test_body_file_os_temp_dir_guidance` to `tests/content/test_standards.py`
- **Deft-swarm Phase 5->6 gate hardening + crash recovery** (#261, #263, t1.13.1): Strengthened Phase 5->6 gate with explicit context-pressure bypass prohibition and structured merge-readiness checklist; added pre-spawn verification gate in Takeover Triggers (wait for lifecycle idle/blocked event before replacing agent); added per-PR sub-agent identity check in Phase 6; documented duplicate-tab failure mode (root cause of tool_use/tool_result corruption); added context-length warning for long monitoring sessions; added Crash Recovery section with idempotent pre-checks and gh-based state reconstruction; added 2 new anti-patterns; added companion meta/lessons.md entries; added 7 test_skills.py coverage tests

### Changed
- **Roadmap Refresh (2026-04-09)**: Triaged 4 new issues -- #256 (Phase 1 Adoption Blockers: `--body-file` temp file writes to worktree + `rm` denylist collision; fix: use OS temp dir, t1.13.2), #258 (Phase 2: Warp Drive global rules inventory for CONTRIBUTING.md, spinoff of #114, blocked on #89, t2.9.1), #261 + #263 (bundled, Phase 1 Adoption Blockers: swarm monitor bypassed Phase 5->6 gate under context pressure and merged untested code into master; separate crash at message ~158 left merge cascade in ambiguous state; both root-caused to long-context conversation corruption, t1.13.1); no stale entries; analysis comments posted on all 4 issues
- **Roadmap Refresh (2026-04-09, session 2)**: Triaged 3 new issues -- #266 (Phase 2: move installer asset links to top of README, t2.10.1), #268 (Phase 2: wrap install commands in fenced code blocks for copy button, t2.10.2), #270 (Phase 3: validate USER.md against current schema + artifact format versioning with `deft_version` field, t3.2.1); held #269 pending Warp team response (auto-approve silently skips interview questions -- investigating Mac-vs-Windows platform difference); closed #271 as duplicate of #269 (same root cause, deft-side sentry/guard mitigation tracked in #269); no stale entries; analysis comments posted on all triaged issues
- **Roadmap Refresh (2026-04-10)**: Triaged 4 new issues -- #279 (Phase 1 Adoption Blocker: deft-review-cycle Approach 2 yield/idle stoppage breaks swarm polling loop, t1.14.1), #272 (Phase 1 Adoption Blocker: deft-setup agent conflates framework directory with project root during bootstrap, t1.16.1), #269 (Phase 1 Adoption Blocker: Warp auto-approve silently self-answers deft-setup interview, producing garbage USER.md/PROJECT.md; post-interview confirmation gate + Warp setting doc, absorbs #271, t1.17.1), #274 (Phase 1 Cleanup: add semantic accuracy check to mandatory pre-commit file review, t1.15.1); filed #281 (Phase 1 Cleanup: WinError 448 pytest-current symlink cleanup fails on Windows 11 24H2+, t1.18.1), #282 (Phase 1 Cleanup: deft-review-cycle MCP capability detection + task check pre-existing failure carve-out, t1.19.1), #283 (Phase 1 Cleanup: AGENTS.md ! rule for BOM-safe PowerShell file writes, t1.20.1); stripped BOM from CHANGELOG.md; no stale entries; analysis comments posted on all 4 triaged issues
- **docs(readme): move installer asset links to top near install instructions** (#266, t2.10.1): Added Quick Download callout with platform-specific binary links adjacent to the Getting Started section, visible without scrolling past architecture details; all existing content preserved
- **docs(readme): wrap install commands in fenced code blocks for GitHub copy button** (#268, t2.10.2): Wrapped all install/run commands in the Getting Started section (macOS chmod+run, macOS quarantine removal, Linux chmod+run, build-from-source go run) in fenced code blocks with `bash` language tags so GitHub renders a copy button; replaced Unicode arrows with ASCII equivalents

## [0.15.0]

### Changed
- **Rename deft-rwldl skill to deft-pre-pr** (#226, t2.8.3): Renamed `skills/deft-rwldl/` to `skills/deft-pre-pr/` for clarity -- the acronym "RWLDL" was opaque and collided with the RWLDL tool pattern; updated frontmatter, `.agents/skills/` thin pointer, AGENTS.md Skill Routing table, and `tests/content/test_skills.py`; added auto-suggestion to AGENTS.md Development Process section

### Added
- **Strategy stubs: rapid.md and enterprise.md** (#51, t2.8.5): Created `strategies/rapid.md` (quick prototyping workflow -- SPECIFICATION-only output, minimal gates, forced-Light path) and `strategies/enterprise.md` (compliance-heavy workflow -- PRD -> ADR -> SPECIFICATION with explicit approval gates); both have RFC2119 legend, See also banner, and full workflow structure; updated `strategies/README.md` to remove "(future)" annotations and add links; added `test_rapid_strategy_exists` and `test_enterprise_strategy_exists` to `tests/content/test_structure.py`; flipped xfail entries in `known_failures.json`
- **docs/getting-started.md stub** (#112, t2.8.6): Created `docs/getting-started.md` with title, purpose statement, deferred-content note, and placeholder section outline (Prerequisites, Installation, First Project, Using Strategies, Agent Configuration); added `test_getting_started_exists` to `tests/content/test_structure.py`; posted confirmation comment on GitHub issue #112
- **README.md "Your Artifacts" section** (#234, t2.8.4): Added concise bulleted list documenting where user-generated artifacts live in a consumer project -- `./vbrief/`, `SPECIFICATION.md`, `PROJECT.md`, `USER.md`, and `./deft/`
- **deft-pre-pr in README.md and AGENTS.md**: Added skill to README.md directory tree and Skills listing; added keyword routing entry ("pre-pr" / "quality loop" / "rwldl" / "self-review") to AGENTS.md Skill Routing table

### Fixed
- **Roadmap-refresh explicit row format template** (#221, t2.8.1): Added explicit `| #NNN | title | Phase |` row format template to `skills/deft-roadmap-refresh/SKILL.md` Phase 2 Step 4 for Open Issues Index rows; added 2 anti-patterns: creating rows without the template format, and double-pipe `||` entries from omitting a column value
- **Spec task scaffolding in roadmap-refresh and swarm Phase 0** (#248, t2.8.2): Added skeleton spec task creation step to `skills/deft-roadmap-refresh/SKILL.md` Phase 2 Step 4 -- for each newly triaged issue, create a skeleton entry in SPECIFICATION.md if none exists; added "Spec coverage" transparency note to Phase 2 Step 2 analysis output; added `!` rule to `skills/deft-swarm/SKILL.md` Phase 0 Step 2 requiring skeleton spec tasks for candidates missing spec coverage before proceeding
- **Purge stale core/user.md and core/project.md references** (#51, t2.1.1): Updated all non-history .md files referencing legacy `core/user.md` and `core/project.md` paths to canonical locations (`~/.config/deft/USER.md` and `./PROJECT.md`); affected files include 22 language standards files, 2 platform files, `scm/git.md`, `coding/coding.md`, `meta/code-field.md`, `meta/morals.md`, `main.md`, `REFERENCES.md`, `SKILL.md`, `ROADMAP.md`, `PRD.md`, `.planning/codebase/CONCERNS.md`; flipped 3 deprecated-path xfail entries in `known_failures.json`

## [0.14.2] - 2026-04-09

### Fixed
- **Strengthen batch-fix enforcement in deft-review-cycle** (#250, t1.12.2): Added `!` pre-commit gate to Phase 2 Step 3 requiring agents to re-read the FULL current Greptile review and confirm all P0/P1 issues are addressed in staged changes before committing -- prevents per-finding fix commits that cause N re-review cycles instead of 1; added 2 new `âŠ—` anti-patterns: push a fix commit addressing fewer findings than the review surfaces, push after fixing a P1 without checking for additional P0/P1 findings
- **Autonomous Greptile re-review monitoring in swarm merge cascade** (#249, t1.12.1): Added `!` rule to `skills/deft-swarm/SKILL.md` Phase 6 Step 1 requiring the monitor to autonomously wait for Greptile re-review completion after each `--force-with-lease` push during rebase cascade -- references `skills/deft-review-cycle/SKILL.md` Step 4 tiered monitoring approach (start_agent sub-agent preferred, discrete tool-call polling fallback); added gate prohibiting proceeding to next merge until review is current (SHA match) and exit condition met (confidence > 3, no P0/P1); added corresponding anti-pattern

### Added
- **Semantic contradiction check for !/âŠ— rules** (#251, t1.12.3): Added 2 `!` rules to `skills/deft-build/SKILL.md` pre-commit checklist and `skills/deft-pre-pr/SKILL.md` Read phase (formerly `deft-rwldl`, renamed in [Unreleased]) -- when adding a `!` or `âŠ—` rule, search the same file for conflicting `~`/`â‰‰` rules referencing the same term; when strengthening a rule, verify no weaker-strength duplicate remains; added `âŠ—` anti-pattern to both skills prohibiting adding a prohibition without scanning for softer-strength conflicts

### Changed
- **Roadmap Refresh (2026-04-09)**: Triaged 2 new issues -- #228 (bring run CLI into test coverage measurement, Phase 3 -- confirm #160 before implementing), #248 (roadmap refresh does not surface spec task coverage, Phase 2 -- strengthen swarm Phase 0 skeleton spec tasks); no stale entries; analysis comments posted on both issues

## [0.14.1] - 2026-04-09

### Fixed
- **ROADMAP.md em-dash migration for Windows compatibility** (#237, t1.11.6): Replaced all 317 Unicode em-dash characters (U+2014) with ASCII `--` in ROADMAP.md phase bodies, Completed section, Open Issues Index rows, and changelog notes -- enables `edit_files` tool on Windows without PowerShell fallback (warpdotdev/warp#9022)
- **Blocker carve-out for main.md instant-fix drift rule** (#241, t1.11.7): Added carve-out to `main.md` Decision Making instant-fix `âŠ—` rule -- hard blockers (current task literally cannot complete without the fix) are now permitted in-scope with mandatory GitHub issue filing; non-blocking nice-to-fix, quality improvements, and adjacent issues remain prohibited

### Added
- **Skill completion gates and pre-commit file review** (#238, #239, #243; t1.11.3, t1.11.4, t1.11.5): Added batch CHANGELOG convention to `skills/deft-roadmap-refresh/SKILL.md` -- one entry at session end, not per-issue; added mandatory pre-commit file review step (encoding, duplication, structural checks) to roadmap-refresh Phase 4 pre-flight and `skills/deft-build/SKILL.md`; added Skill Completion Gate rule to `AGENTS.md` requiring explicit exit confirmation and chaining instructions; added EXIT block to roadmap-refresh Phase 4; added chaining annotations to AGENTS.md Skill Routing table (swarm chains to review-cycle, roadmap-refresh chains to review-cycle)
- **PS 5.1 Get-Content -Raw footgun and BOM-safe round-trip rules** (#236, t1.11.1): Added two `!` rules to `scm/github.md` PS 5.1 section -- use `Get-Content -Raw` to read files as a single string (avoids line-by-line BOM injection and Unicode mangling), and use `[System.IO.File]::WriteAllText` with the BOM-free UTF8 constructor for safe writes (PS 5.1 `Set-Content` and `Out-File` both inject a BOM even with `-Encoding UTF8`; `Out-File -Encoding utf8NoBOM` requires PS 7+); rationale paragraph documenting PS 5.1's UTF-16LE/UTF-8-with-BOM defaults
- **Warp terminal multi-line PS string temp-file rule** (#240, t1.11.2): Added `!` rule to `scm/github.md` new Warp Terminal Multi-Line String Handling subsection -- never paste multi-line PS here-strings into Warp agent input (Warp splits across command blocks); always write to a temp file first; corresponding lesson entry in `meta/lessons.md` documenting root cause and fix

### Changed
- **Roadmap Refresh (2026-04-09)**: Triaged 5 issues -- #221 (deft-roadmap-refresh explicit row format template, Phase 2), #226 (deft-rwldl rename + auto-suggestion triggers, Phase 2), #233 (More Determinism full initiative, Phase 5), #234 (README artifacts section, Phase 2); filed #235 as Phase 3 split-off from #233 (toolchain:check + changelog:check); filed #236/#237/#238/#239/#240/#241 to Phase 1 (#236: Get-Content -Raw UTF-8 footgun; #237: ROADMAP.md em-dash migration; #238: roadmap-refresh batch changelog; #239: mandatory pre-commit file review; #240: multi-line PS string Warp block splitting; #241: main.md blocker carve-out for instant-fix rule; #243: skill completion gate for chaining instructions); analysis comments posted

## [0.14.0] - 2026-04-08

### Added
- **meta/philosophy.md -- deterministic > probabilistic design principle** (#159, t2.7.7): Created `meta/philosophy.md` documenting the "prefer deterministic components for repeatable actions" design principle -- definition, rationale, examples (Taskfile tasks, spec_validate.py, CI workflows), and scope note deferring broad application to Phase 5; referenced from `contracts/hierarchy.md` See also banner
- **strategies/bdd.md -- BDD/acceptance-test-first strategy** (#81, t2.7.8): Created `strategies/bdd.md` with RFC2119 legend and See also banner -- 6-step workflow (scenarios, failing tests, surface ambiguity, lock decisions, generate spec, chain into sizing gate), output artifacts (`specs/{feature}/acceptance-tests/` + `{feature}-bdd-context.md`), chaining gate integration as preparatory strategy, anti-patterns; added to `strategies/README.md`; added `test_bdd_strategy_exists` to `tests/content/test_structure.py`
- **deft-roadmap-refresh: analysis comment transparency** (#168, t2.7.1): Added `!` rule to Phase 2 Step 4 requiring agent to confirm to the user that an analysis comment was posted -- includes issue number and direct link to the comment
- **deft-roadmap-refresh: Phase 4 -- PR & Review Cycle** (#174, t2.7.2): Added Phase 4 after Phase 3 Cleanup -- asks user confirmation, runs pre-flight checks (CHANGELOG, task check, PR template) before pushing, commits/pushes/creates PR, then automatically sequences into `skills/deft-review-cycle/SKILL.md`
- **deft-roadmap-refresh: explicit cleanup convention** (#196, t2.7.3): Replaced ambiguous Phase 3 cleanup instruction with explicit rules -- remove entries from phase body entirely (Completed section is sole record), strike through in Open Issues Index with 'completed -- YYYY-MM-DD', added anti-pattern against duplicate records
- **skills/deft-sync/SKILL.md -- session-start framework sync skill** (#146, t2.7.5): Created `skills/deft-sync/SKILL.md` with RFC2119 legend and frontmatter -- 4-phase workflow (pre-flight dirty check, submodule update, project sync with vBRIEF validation + AGENTS.md freshness + new skills listing, summary with commit prompt); anti-patterns prohibit auto-commit, vbrief file overwrites, skipping dirty check, and upstream schema fetch; `.agents/skills/deft-sync/SKILL.md` thin pointer for auto-discovery; AGENTS.md Returning Sessions section and Skill Routing table updated
- **Deft alignment confirmation rule** (#134, t2.7.6): Added behavioral rule to AGENTS.md requiring agents to confirm "Deft Directive active -- AGENTS.md loaded" at the start of each interactive session; covers context reset recovery (re-confirm after context window shifts); anti-pattern for starting without confirmation; true UI indicator deferred to Phase 5
- **GitHub Actions CI workflow** (#57, t3.1.1): Created `.github/workflows/ci.yml` with two jobs -- Python (ruff lint, mypy type-check on tests/, pytest with coverage) and Go (go test + cross-compile builds for linux/amd64, darwin/arm64, windows/amd64); triggers on pull_request and push to master; uses actions/checkout@v4, actions/setup-python@v5, actions/setup-go@v5, astral-sh/setup-uv@v5
- **Run CLI coverage tracking issue** (#228, t3.1.2): Opened GitHub issue "Bring run CLI into test coverage measurement" documenting why `run` and `run.py` are excluded from coverage (terminal-only CLI, needs refactor before coverage is meaningful); labeled Phase 4 backlog

### Changed
- **deft-review-cycle tiered review monitoring** (#195, t2.7.4): Replaced blocking `Start-Sleep`/`time.sleep()` shell polling in `skills/deft-review-cycle/SKILL.md` Step 4 with tiered monitoring -- Approach 1 (preferred): spawn sub-agent via `start_agent` to poll autonomously while main conversation stays interactive; Approach 2 (fallback): discrete `run_shell_command` (wait mode) calls with yield between checks; capability detection reuses `start_agent` tool-presence pattern from #188; existing exit conditions preserved; added 7 tests covering tiered monitoring section, both approaches, capability detection, and blocking sleep prohibition
- **Coverage threshold raised to 85%** (#57, t3.1.3): Updated `pyproject.toml` `fail_under` from 75 to 85; added inline comments to `[tool.coverage.run]` omit entries explaining why `run` and `run.py` are excluded (references #228)

## [0.13.0] - 2026-04-07

### Added
- **scm/github.md rewrite -- gh CLI rules, PR conventions, Windows encoding guidance** (#197, absorbs #201, t2.6.6): Rewrote `scm/github.md` with standing `gh` CLI rules (`--body-file` for multi-line bodies, immediate post-create verification), PR workflow conventions (squash-merge default, single-purpose branches, branch lifecycle, closing keywords), Windows/PowerShell 5.x encoding guidance (UTF-8 without BOM, avoid piping through PS 5.x redirection), and post-merge issue verification section
- **ASCII convention for machine-editable sections** (#202, t2.6.7): Added Windows/ASCII Conventions section to `scm/github.md` -- prefer `--` over em-dash, `->` over arrows, avoid emoji in body text for ROADMAP.md phase bodies, CHANGELOG.md entries, and Open Issues Index rows; `!` rule against Unicode em-dashes, curly quotes, and non-ASCII arrows in these sections; rationale references warpdotdev/warp#9022
- **skills/deft-rwldl/SKILL.md -- iterative pre-PR quality loop** (#182, t2.6.8): Created `skills/deft-rwldl/SKILL.md` with RFC2119 legend and frontmatter -- structured self-review loop (Read-Write-Lint-Diff-Loop) agents run before pushing a branch for PR creation; 5 phases with exit condition (full cycle with zero changes); anti-patterns section; `.agents/skills/deft-rwldl/SKILL.md` thin pointer for auto-discovery
- **Swarm release decision checkpoint** (#218, t1.10.2): Added tentative version bump suggestion to `skills/deft-swarm/SKILL.md` Phase 0 Step 3 analysis summary -- agent surfaces current version and proposes next version (patch/minor/major) based on scope; added Phase 5->6 confirmation gate requiring user approval of version bump and release scope before merge cascade begins; added anti-pattern prohibiting merge cascade without version bump proposal and user approval
- **Greptile rebase re-review latency guidance** (#207, t1.10.3): Documented in `skills/deft-swarm/SKILL.md` Phase 6 that force-pushing a rebased branch triggers a full Greptile re-review (~2-5 min per PR), not an incremental diff; added rebase-only annotation guidance (MAY note in PR comment); updated merge cascade warning with Greptile re-review time cost; recorded finding in `meta/lessons.md`
- **Instant-fix drift and skill-context bleed rules** (#198, t1.10.4): Added `âŠ—` rules to `main.md` Decision Making prohibiting mid-task instant fixes (must file issue instead) and skill-context bleed (must stop at skill boundary); added `!` exit-condition rule; companion `meta/lessons.md` entries (xrefs #159, #167, #184)
- **Mandatory skills/ scan rule** (#200, t1.10.5): Added `!` rule and `âŠ—` anti-pattern to `AGENTS.md` requiring agents to scan `skills/` before designing multi-step workflows; companion `meta/lessons.md` entry
- **Keyword-to-skill routing table** (#147, t2.6.4): Added Skill Routing section to `AGENTS.md` mapping trigger keywords to skill paths; added 3 missing skills (deft-review-cycle, deft-roadmap-refresh, deft-swarm) to `README.md` Skills section
- **README stale content fixes** (#219, t2.6.5): Added `CONTRIBUTING.md` and `contracts/hierarchy.md` to README directory tree; updated skills/ subtree to list all 5 skills; added hierarchy.md to Contracts section

### Fixed
- **pyproject.toml dev deps break task check in fresh worktrees** (#217, t1.10.1): Moved dev dependencies from `[project.optional-dependencies]` to `[dependency-groups]` (PEP 735); `uv sync` now installs dev deps by default in fresh worktrees without needing `--extra dev`; regenerated `uv.lock`; updated `languages/python.md` template to show `[dependency-groups]` pattern

### Changed
- **Roadmap Refresh (2026-04-07)**: Triaged 5 new issues â€” #217 (pyproject.toml dev deps breaks task check in fresh worktrees, Phase 1 Adoption Blockers), #218 (deft-swarm release decision checkpoint, Phase 1 Adoption Blockers), #207 (Greptile re-review latency on swarm merge cascade, Phase 2), #219 (README.md stale content, Phase 2), #212 (process control in Directive discussion, Phase 5); cleanup: struck through #184/#188/#191/#192/#199 in index (completed v0.12.0), removed duplicate bare #198 entry, added #182 description; analysis comments posted on all 5 issues

## [0.12.1] - 2026-04-06

### Added
- **State WHY rule for interview strategy** (#84, t2.2.3): Added `!` rule to `strategies/interview.md` Interview Rules requiring agents to state the underlying principle (1 sentence) when making an opinionated recommendation â€” part of "Deft as teacher" so users understand the contract hierarchy reasoning behind recommendations
- **CONTRIBUTING.md contributor bootstrap guide** (#67, t2.3.1): Created `CONTRIBUTING.md` at repo root with full contributor onboarding â€” prerequisites (Go 1.22+, Python 3.11+, uv, task), dev environment setup, running tests (`task test`, `task check`), running CLI locally (`uv run python run`), building the Go installer (`go build ./cmd/deft-install/`); documents `task check` as the authoritative pre-commit gate and defines a passing `task check` as the definition of ready-to-commit

### Fixed
- **PR merge hygiene -- squash-merge issue-close verification** (#167, t1.8.4): Root cause documented in `meta/lessons.md` -- GitHub squash merges can silently fail to process closing keywords (`Closes #N`) from PR bodies, leaving referenced issues open with no error; added closing keyword guidance and post-merge verification checklist to `.github/PULL_REQUEST_TEMPLATE.md`; added Post-Merge Verification section to `skills/deft-review-cycle/SKILL.md` mirroring `deft-swarm` Phase 6 Step 2; added issue-close verification convention to `AGENTS.md` PR conventions; added anti-pattern for assuming squash merge auto-closed issues
- **Consistent ./deft/ installation path** (#116, t1.8.3): Installer now creates thin pointers for all 6 skills (deft, deft-setup, deft-build, deft-review-cycle, deft-roadmap-refresh, deft-swarm) instead of only 3 -- previously deft-review-cycle, deft-roadmap-refresh, and deft-swarm were missing from the installer's `.agents/skills/` setup, making them undiscoverable in installed projects; all thin pointers consistently use `deft/`-prefixed paths; added 3 path consistency tests verifying skill pointer `deft/` prefix, only expected files at project root, and DeftDir placement

## [0.12.0] - 2026-04-06

### Added
- **Swarm close-out orchestration rules** (#206, t2.6.3): Added monitor-centric close-out rules to skills/deft-swarm/SKILL.md Phase 6 -- merge authority (monitor proposes, user approves), rebase cascade ownership (monitor owns), GIT_EDITOR=true for non-interactive rebase, post-merge issue verification step; added push autonomy carve-out for swarm agents; added MCP fallback note to skills/deft-review-cycle/SKILL.md (gh-only when MCP unavailable)
- **Deft-swarm runtime capability detection** (#188, t1.9.3): Replaced static Option A/B/C launch path selection in `skills/deft-swarm/SKILL.md` Phase 3 with runtime capability detection â€” agent probes for `start_agent` tool at runtime, uses it as preferred path if available (Warp orchestration), falls back to manual Warp tabs silently when unavailable but Warp detected, gates Warp-specific paths on `WARP_*` environment variables; cloud (`oz agent run-cloud`) preserved as explicit user-requested escape hatch only; anti-patterns updated for dynamic approach
- **Deft-swarm mandatory analyze phase** (#199, t1.9.4): Added Phase 0 â€” Analyze to `skills/deft-swarm/SKILL.md` before Phase 1 (Select) â€” reads ROADMAP.md and SPECIFICATION.md, surfaces blockers (blocked spec tasks, missing spec coverage, dependency conflicts), presents analysis summary to user, requires explicit user approval before proceeding to task selection; anti-pattern added prohibiting Phase 1 entry without Phase 0 completion

### Fixed
- **vBRIEF reference type schema vendor** (#133, t1.8.2): Vendored updated upstream vBRIEF schema â€” `VBriefReference.type` expanded from `{"enum": ["x-vbrief/plan"]}` to pattern-based `^x-vbrief/` accepting all `x-vbrief/*` reference types (e.g. `x-vbrief/plan`, `x-vbrief/context`, `x-vbrief/research`); unblocks generated vBRIEF files that use context/research references; task t1.8.2 moved from `[blocked]` to `[completed]`
- **deft-review-cycle autonomous polling** (#184, t1.9.4): Added `!` rule to Step 4 requiring agents to autonomously poll for Greptile review updates after pushing without stopping to ask the user; added `âŠ—` anti-pattern for pausing the review/fix loop for user confirmation; added candidate lesson to `meta/lessons.md` Review Cycle Monitoring section
- **deft-review-cycle proactive test coverage** (#192, t1.9.5): Added Step 3b (between fix commit and push) requiring agents to scan changed lines for untested code paths and write tests in the same batch; eliminates one CI round-trip per fix cycle; added `âŠ—` anti-pattern for pushing without coverage scan
- **Swarm force-push anti-pattern scope fix** (#209): Scoped blanket force-push anti-pattern to swarm agents only -- monitor may --force-with-lease after rebase cascade per Phase 6; fixed GIT_EDITOR portability (added Windows PowerShell fallback echo); added 7 regression tests for Phase 6, Push Autonomy, and MCP fallback content
- **vBRIEF reference-type workaround removal** (#191, t1.9.3): Verified no defensive workarounds remain in `vbrief/vbrief.md`, `templates/make-spec.md`, or `scripts/spec_validate.py` after upstream deftai/vBRIEF#2 resolution; spec task added and marked completed

### Changed
- **Roadmap Refresh (2026-04-06)**: Triaged 14 new issues, promoted 1, closed 2, cleaned 1 stale entry â€” #192 (proactive test coverage after review-fix commits, Phase 1 Adoption Blockers), #191 (remove vBRIEF defensive workarounds, deftai/vBRIEF#2 resolved, Phase 1 Adoption Blockers), #189 (closed as superseded by #191), #184 (deft-review-cycle autonomous polling imperative after push, Phase 1 Adoption Blockers), #188 (deft-swarm runtime `start_agent` capability detection + Warp environment gate, Phase 2; reshaped from static Option D label to tool-presence-based detection), #182 (deft-rwldl skill: iterative pre-PR quality loop, Phase 2), #194 (user-facing best practices guide, Phase 2), #195 (review monitor orchestration, Phase 2), #196 (roadmap-refresh cleanup convention, Phase 2), #197 (scm/github.md with gh CLI rules and Windows encoding guidance, Phase 2 -- absorbs #201), #198 (instant-fix drift and skill-context bleed rules for main.md, Phase 1), #199 (deft-swarm mandatory analyze phase, Phase 1), #200 (scan skills/ before improvising workflows, Phase 1), #202 (ASCII convention for machine-editable sections, Phase 2); promoted #188 from Phase 2 to Phase 1 (user actively testing swarm); closed #201 (absorbed by #197); moved #166 to Completed (closed on GitHub); cleaned up 2 stale entries (#133 closed 2026-04-05, #58 closed 2026-04-06); updated #147 title and scope (expanded to cover keyword routing + 3 missing skills); analysis comments posted on all issues

## [0.11.0] - 2026-04-05

### Fixed
- **Change gate UX â€” replace name-echo with yes/no confirmation** (#185, t1.9.1):
  - `/deft:change` confirmation gate no longer requires users to retype the full change name; agents now present the change name and ask for explicit yes/no confirmation
  - Accepted responses: `yes`, `confirmed`, `approve`; vague responses (`proceed`, `do it`, `go ahead`) still rejected
  - Updated across all framework surfaces: `main.md` Decision Making rule, `skills/deft-build/SKILL.md` Change Lifecycle Gate, `skills/deft-review-cycle/SKILL.md` Phase 1 audit, `.github/PULL_REQUEST_TEMPLATE.md` checklist
  - Spec task t1.9.1 added to `vbrief/specification.vbrief.json` and rendered to `SPECIFICATION.md`
- **deft-swarm Option A limitations documented** (#179): Updated `skills/deft-swarm/SKILL.md` Phase 3 â€” demoted Option A (`oz agent run`) from preferred to "currently limited"; elevated Option B (interactive Warp tab) as recommended launch method; added known-limitations callout noting Option A does not receive global Warp Drive rules, MCP UUIDs, or auto-injected context; documented inline MCP JSON workaround; added two new anti-patterns; updated default launch from Option A to Option B; recorded finding in `meta/lessons.md`
- **AGENTS.md pre-implementation gate enforcement** (#186): Added `!` (MUST) markers to "Before code changes" checklist items in `AGENTS.md`; added `âŠ—` anti-pattern prohibiting file edits before spec coverage check and branch creation â€” even if user says "yes" or "proceed"; root cause: agent loaded AGENTS.md but treated pre-implementation checklist as advisory due to missing RFC2119 enforcement markers

## [0.10.3] - 2026-04-05

### Fixed
- **vBRIEF schema conformance â€” agent generation guidance + validation** (#126, #144):
  - Fixed `speckit.md` Phase 4 Task Structure: replaced legacy flat format (`vbrief`, `tasks`, `do`, `todo/doing/done`) with correct vBRIEF v0.5 envelope (`vBRIEFInfo` + `plan` object, `title` field, `pending/running/completed` lifecycle)
  - Added hierarchical `subItems` guidance and examples to `vbrief/vbrief.md`, `skills/deft-setup/SKILL.md`, and `templates/make-spec.md` â€” agents now have explicit instructions for representing Phase â†’ Subphase â†’ Task nesting in vBRIEF JSON
  - Added narrative-must-be-string rules (`plan.narratives` and `PlanItem.narrative` values must be plain strings, never objects or arrays) across all generation docs
  - Strengthened `spec_validate.py`: recursive `subItems` validation (title, status, narrative types at all nesting levels), `plan.narratives` string enforcement, detection of `items` key misuse inside PlanItems (should be `subItems`)
  - Added 5 new tests: narrative object detection, item narrative array detection, `items`-inside-PlanItem detection, recursive subItems invalid status, valid hierarchical spec passthrough

### Changed
- **ROADMAP.md update convention** (#170): Changed PR conventions in `AGENTS.md` from "updates happen on merge" to "updates happen at release time â€” batch-move merged issues to Completed during the CHANGELOG promotion commit"; added Phase 6 Step 5 to `skills/deft-swarm/SKILL.md` codifying this as the release-time checkpoint; added âŠ— anti-pattern prohibiting ROADMAP.md edits during swarm close; added âŠ— to Phase 1 Step 2 excluding ROADMAP.md from swarm shared-file exceptions
- **Mermaid gist-rendering guidance**: Codified GitHub/Gist sequence-diagram readability rules in `languages/mermaid.md` as explicit RFC2119 MUST/SHOULD guidance: do not rely on `init.background`/`themeCSS` alone, use a grey participant-only `box ... end`, keep messages/notes outside the box, and keep sequence workarounds diagram-type-scoped; added regression tests in `tests/content/test_mermaid_guidance.py` (#102)
- **Specification sync**: Full sync of `vbrief/specification.vbrief.json` and rendered `SPECIFICATION.md` â€” corrected 15 stale task statuses (t1.1.1â€“t1.5.2, t1.6.1â€“t1.6.4, t2.1.2â€“t2.2.2, t2.5.1â€“t2.5.5 all now `completed`); added 9 missing tasks: retroactive coverage for completed work (t1.7.1 #166, t1.7.2 #171, t1.7.3 #175, t1.7.4 #172, t2.6.1 #104), new tasks for open Phase 1 issues (t1.8.1 #126/#144, t1.8.2 #133, t1.8.3 #116, t1.8.4 #167); reordered all tasks by phase (1â†’2â†’3); total 46 tasks (34 completed, 9 pending, 3 blocked)

## [0.10.2] - 2026-04-03

### Added
- **Branching preference in project setup**: `cmd_project` and `deft-setup` Phase 2 Track 1 now ask branching preference (branch-based â€” default/recommended, or trunk-based); emits `Allow direct commits to master: true` under `## Branching` in PROJECT.md if trunk-based is chosen (#171)

### Fixed
- **No direct-to-master agent commits**: Added `âŠ—` hard gate to `main.md`, `AGENTS.md`, and `skills/deft-build/SKILL.md` â€” agents must always create a feature branch and open a PR; `Allow direct commits to master: true` in `PROJECT.md ## Branching` provides opt-in escape hatch for solo/trunk-based projects (#171)
- **Review cycle push discipline + polling cadence**: Added `âŠ—` rule to `skills/deft-review-cycle/SKILL.md` Step 4 prohibiting additional commits while Greptile is reviewing current head; added `~` `60s` minimum poll interval guidance; codified both as `meta/lessons.md` Review Cycle Monitoring lessons #2 and #3 (#175)

### Fixed
- **oz agent run correction**: Corrected `skills/deft-swarm/SKILL.md` Phase 3 â€” `oz agent run` is local (preferred automated launch path), `oz agent run-cloud` is the cloud path; rewrote options A/B/C, fixed prerequisites and anti-patterns; added correction addenda to `meta/lessons.md` lessons #1 and #7; updated `SPECIFICATION.md` t2.5.4 acceptance criteria (#172)

### Changed
- **Roadmap Refresh (2026-04-03)**: Triaged 5 new issues â€” #170 (move ROADMAP.md updates to release-time, Phase 2), #171 (hard gate against agent direct-to-master commits, Phase 1 Cleanup), #172 (deft-swarm skill oz agent run/run-cloud correction, Phase 1 Adoption Blockers â€” priority next), #174 (deft-roadmap-refresh review cycle chaining after PR push, Phase 2), #175 (deft-review-cycle no-push-during-review + polling cadence, Phase 1 Cleanup); analysis comments posted on all issues; meta/lessons.md updated with 3 new Windows/review-cycle encoding and monitoring lessons

### Added
- **Greptile integration guide**: Added tools/greptile.md â€” recommended Greptile dashboard and per-repo settings for teams using deft, covering triggerOnUpdates/statusCheck configuration, check runs vs. commit statuses distinction, troubleshooting, and anti-patterns (#166, t1.7.1)

- **Holzmann Power of Ten adaptation**: Added `coding/holzmann.md` â€” JPL/NASA Power of Ten rules (Holzmann, 2006) adapted for Deft with RFC 2119 notation; covers simple control flow, bounded loops, fixed resource allocation, small functions, runtime checks, minimal data scope, error/return checking, restricted metaprogramming/indirection, and maximum static checking (#104)
- **Superpowers adoption plan**: Added `docs/superpowers.md` â€” prioritized adoption plan identifying 8 patterns from [obra/superpowers](https://github.com/obra/superpowers) worth integrating into the Deft Directive (systematic debugging, verification gate, code review protocol, rationalization prevention, subagent dispatch, no-placeholders rule, git worktrees, branch completion)

## [0.10.1] - 2026-04-02

### Changed
- **README restructure**: Moved Getting Started section (install, setup, spec, build) from below the architecture/layers documentation to immediately after the TL;DR; added prominent installer download callout at the top of the page (#137, t2.5.3)
- **Language removed from USER.md**: Removed `**Primary Languages**` field from USER.md template and Phase 1 interview (Track 1 Step 2, Track 2 Step 2, Track 3 language inference) â€” language is a project-level concern determined per-project via codebase inference, not a user preference (#107, t1.1.3)
- **Deployment platform question**: Phase 2 Track 1 now asks deployment platform (cross-platform, Windows-native, macOS-native, Linux/Unix, embedded, web/cloud, mobile, other) before language â€” platform context drives a filtered language shortlist with progressive "Other" disclosure and missing-standards-file warning (#108, t1.1.4)

### Fixed
- **deft-review-cycle Greptile pre-flight**: Added Pre-Flight Check section to skills/deft-review-cycle/SKILL.md â€” verifies triggerOnUpdates is enabled before entering the review/fix loop, documents that Greptile posts check runs (Checks API) not commit statuses, adds @greptileai manual re-trigger fallback and anti-pattern for using wrong API endpoint (#166, t1.7.1)

- **Testing enforcement gate**: Added `!` hard gate rule to `main.md` Decision Making â€” no implementation is complete until tests written and `task check` passes; a general 'proceed' does not waive testing; added anti-pattern to `deft-build/SKILL.md` (#68, t1.6.1)
- **Change lifecycle gate enforcement**: Strengthened `/deft:change` rule in `main.md` â€” broad 'proceed'/'do it'/'go ahead' explicitly does NOT satisfy the gate; user must acknowledge the **named** change; added pre-flight gate to `deft-build/SKILL.md`, checklist item to `.github/PULL_REQUEST_TEMPLATE.md`, verification step to `deft-review-cycle/SKILL.md` Phase 1 audit; Phase 1 audit gaps now batched with Phase 2 fixes (#123, t1.6.2)
- **Context-aware branching for solo projects**: Added solo-project qualifier to `main.md` change lifecycle rule â€” `/deft:change` mandatory for team projects (2+ contributors), recommended for solo projects with quality gate as enforcement; mandatory regardless of team size for cross-cutting, architectural, or high-risk changes; full config-driven approach deferred to Phase 5 (#138, t1.6.3)
- **vBRIEF source step enforcement**: Added `âŠ—` rule to `main.md` vBRIEF Persistence â€” SPECIFICATION.md must never be written directly, must be generated from `specification.vbrief.json`; added anti-pattern to `deft-build/SKILL.md` (#139, t1.6.4)
- **deft-review-cycle Greptile signal**: Updated `skills/deft-review-cycle/SKILL.md` Step 4 to document that Greptile may advance its review by editing an existing PR issue comment rather than creating a new PR review object; added dual-surface detection guidance (issue comments as primary signal, PR review objects as secondary) with `updated_at` timestamp checking; added anti-pattern for relying solely on `pulls/{number}/reviews` (#145, t2.5.2)
- **Phase 2 inference boundary**: Added âŠ— rules to `deft-setup/SKILL.md` Phase 2 Inference section â€” MUST NOT scan `./deft/` for build files or run git commands inside `./deft/`; only inspect project root and non-deft subdirectories (#79, t1.1.1)
- **Phase 2 project name fallback**: Added fallback rule â€” when no build files exist at project root, default project name to current directory name and ask for confirmation (#80, t1.1.2)
- **AGENTS.md headless bypass**: Added headless/task-mode bypass to First Session gate so cloud agents, CI agents, and scheduled tasks skip interactive onboarding when dispatched with an explicit task (#142, t1.1.5)
- **CLI version display**: All `cmd_*` functions now print `Deft CLI v{VERSION}` on startup â€” previously `cmd_validate`, `cmd_doctor`, and `cmd_update` had no version display; existing headers normalized from `Deft v` to `Deft CLI v` (#49, t1.3.2)
- **CLI code quality sweep** (#118):
  - Removed stale `v0.3.7` from module docstring â€” VERSION constant (`0.4.2`) is the single source of truth
  - Removed `Requires: Python 3.6+` from docstring â€” conflicts with `run.bat` enforcing 3.13+; `run.bat` handles Windows version check independently
  - Changed bare `except:` in `cmd_spec` project-name parsing to `except (OSError, UnicodeDecodeError):` â€” no longer swallows `KeyboardInterrupt`/`SystemExit`
  - Documented `--force` flag in `usage()` help text for the `spec` command
  - Fixed `DEFT_PRD_PATH` env var misuse on Light sizing path â€” Light path now reads `DEFT_INTERVIEW_PATH` instead of overloading the PRD env var
- **Installer post-install text** (#131): Verified already fixed in v0.8.0 â€” `PrintNextSteps` says "Use AGENTS.md" (not "read agents.md")

## [0.10.0] - 2026-04-02

### Added
- **Review Cycle Skill**: Added `skills/deft-review-cycle/SKILL.md` â€” Greptile bot reviewer response workflow covering Phase 1 deft process audit, Phase 2 review/fix loop (batch fixes, wait-for-bot, exit condition), GitHub review submission rules, and anti-patterns; enables cloud agents to run autonomous PR review cycles; thin pointer added at `.agents/skills/deft-review-cycle/SKILL.md` (#135)
- **Roadmap Refresh Skill**: Added `skills/deft-roadmap-refresh/SKILL.md` â€” structured contributor workflow for triaging open issues into the phased roadmap (discovery, one-at-a-time analysis with human review, cleanup)
- **Roadmap Maintenance Strategy**: Added `strategies/roadmap.md` â€” optional user-facing guide for maintaining a living roadmap with agent-assisted triage
- **Agent Skill Pointer**: Added `.agents/skills/deft-roadmap-refresh/SKILL.md` thin pointer for auto-discovery
- **Swarm Skill**: Added `skills/deft-swarm/SKILL.md` â€” parallel local agent orchestration workflow with 6 phases (Select, Setup, Launch, Monitor, Review, Close), proven prompt template, file-overlap audit gate, monitoring checkpoints, takeover triggers, and anti-patterns; thin pointer at `.agents/skills/deft-swarm/SKILL.md` (#152)
- **history/changes/ README**: Added `history/changes/README.md` documenting the change lifecycle artifact structure â€” directory layout, lifecycle stages, and rules (#59, t2.1.2)
- **Contract hierarchy**: Created `contracts/hierarchy.md` documenting two hierarchy lenses â€” durability axis (Standards > APIs > Specs > Code) and generative axis (Spec â†’ Contracts â†’ Code); includes RFC2119 legend, examples, and anti-patterns (#84 Phase 1, t2.2.1)
- **Adaptive teaching behavior**: Added three adaptive teaching rules to `main.md` Agent Behavior section â€” be concise when accepted, explain reasoning when questioned, never lecture unprompted (#84 Phase 1, t2.2.2)

### Fixed
- **commands.md vBRIEF vocabulary**: Status lifecycle rule and example now use canonical vBRIEF v0.5 vocabulary â€” plan-level `draft`/`proposed`/`approved`, task-level `pending`/`running`/`completed`/`blocked`/`cancelled`; added missing `narrative` to task t3 in example; no use of legacy `todo`/`doing`/`done` (#25, t2.1.5)
- **core/project.md cleanup**: Replaced leaked personal project content with generic template; added legacy-location redirect note pointing to `./PROJECT.md` as the canonical path (t2.1.6)

### Changed
- **Yolo Strategy Deduplication**: Refactored `strategies/yolo.md` to reference `interview.md` for shared Light/Full path flows, SPECIFICATION guidelines, and Artifacts Summary â€” reduced from 165 to ~115 lines (#23)
- **Chaining Gate Cleanup**: Removed "Brownfield" alias from `interview.md` chaining gate options â€” now just "Map"
- **SpecKit Cross-Reference**: Added **âš ï¸ See also** banner to `strategies/speckit.md` (#24)
- **Strategies README**: Removed redundant `brownfield.md` row from strategy table; added roadmap strategy
- **README.md**: Updated directory tree and strategies reference list to reflect `default.md` deletion and `brownfield.md` redirect
- **Baseline Snapshot**: Regenerated `tests/content/snapshots/baseline.json` to reflect strategy file changes
- **Roadmap Refresh**: Triaged 12 new issues (#124, #126, #127, #131, #133â€“#140) into roadmap phases; moved #67, #91, #92 to Completed; cleaned stale index entries; filed upstream deftai/vBRIEF#2 for #133
- **Roadmap Refresh (2026-04-02)**: Triaged 5 new issues â€” #142 (AGENTS.md onboarding gate blocks headless/cloud agents, Phase 1), #144 (vBRIEF wrong narrative type + items/subItems, Phase 1 with #126), #145 (deft-review-cycle Greptile signal bug, Phase 1), #146 (deft-sync session-start skill, Phase 2), #147 (skills undocumented in README/AGENTS.md, Phase 2); fixed index formatting

### Removed
- **Redundant Strategy Files**: Deleted `strategies/default.md` (fully superseded by `interview.md`) and replaced `strategies/brownfield.md` with a redirect to `map.md` (#31, #50)

## [0.9.0] - 2026-03-29

### Added
- **Minimal CI Workflow**: Added .github/workflows/ci.yml â€” runs 	ask check (ruff, mypy, pytest) on all PRs and master pushes; gates merges until lint + tests pass (#57 partial)
- **Toolchain Validation Directive**: Added `coding/toolchain.md` with RFC2119 pre-implementation gate â€” MUST verify task runner, language compiler/runtime, and platform SDK (if applicable) before beginning implementation, stop and report if any are missing; pointer added to `coding/coding.md`; toolchain check added to `strategies/interview.md` Acceptance Gate and `skills/deft-build/SKILL.md` Step 2; iOS/Swift incident codified in `meta/lessons.md` (#106)
- **Build Output Validation Directive**: Added `coding/build-output.md` with RFC2119 rules for post-build artifact verification â€” MUST verify expected output files exist and are structurally valid after custom build scripts, especially non-compiled assets bundlers don't track; referenced from `coding/coding.md`; added `### Build Output Tests` section to `coding/testing.md`; codified root cause in `meta/lessons.md` (#105)
- **AGENTS.md Development Process**: Added "Development Process (always follow)" section codifying pre-code spec review, pre-commit `task check` gate, CHANGELOG/PR-template requirements, and commit message conventions â€” ensures agents follow deft conventions automatically via Warp project rules (partially addresses #114)

### Fixed
- **vBRIEF Generation Chain**: Fixed five-component vBRIEF generation chain that produced invalid `specification.vbrief.json` files â€” validator now enforces vBRIEF v0.5 schema (`vBRIEFInfo` envelope + `plan` object with `title`/`status`/`items`); migrated `specification.vbrief.json` and `plan.vbrief.json` from legacy flat format to conformant v0.5; renderer reads from new structure; `make-spec.md` and `deft-setup/SKILL.md` now include concrete vBRIEF output examples; `CONVENTIONS.md` corrected from documenting wrong format; `working-memory.md` example and `long-horizon.md` status lifecycle updated to v0.5 vocabulary; vBRIEF file validation tests added (#72, t1.2.1, t1.2.2)
- **vBRIEF Repo Reference Inconsistency**: Normalized vBRIEF source repo URL from `visionik/vBRIEF` to `deftai/vBRIEF` across `REFERENCES.md` and `vbrief/vbrief.md`
- **CLI Command Chaining Loop**: `cmd_project` no longer falls through and re-runs the entire questionnaire after `cmd_install` chains through `cmd_project` â†’ `cmd_spec` â€” the original call now returns cleanly (#117, closes #91)
- **Strategy Selection Infinite Loop**: Strategy selection in `cmd_bootstrap` and `cmd_project` no longer enters an unbreakable loop when `strategies/` is empty or unresolvable â€” callers now warn and default to Interview when no strategy files are found (#92)
- **Strategy Fallback Value**: Strategy parsing fallback changed from deprecated `("default", "Default")` to `("interview", "Interview")` in both `cmd_bootstrap` and `cmd_project`
- **Broken Strategy Link in Generated Files**: Generated USER.md/PROJECT.md no longer writes a broken markdown link to `strategies/interview.md` when `strategies/` is empty â€” uses plain text instead (PR #120 review fix)

### Changed
- **Roadmap Triage**: Triaged issues #101â€“#108 into roadmap phases; #101 absorbed into #56; #105/#106 (directive gaps) and #107/#108 (language selection UX) added to Phase 1; #102/#103/#104 (docs/standards) added to Phase 2

## [0.8.0] - 2026-03-22

### Added
- **Agent Skill Auto-Discovery**: Added `.agents/skills/deft/`, `deft-setup/`, `deft-build/` thin pointer files to the repo â€” Warp and other agents now auto-discover deft skills on startup without user prompting (#94)
- **WriteAgentsSkills**: Installer now creates `.agents/skills/` in user project root during install so agents auto-discover deft skills immediately (#94)
- **Prescriptive Change Lifecycle Rule**: Added `! Before implementing any planned change that touches 3+ files or has an accepted plan artifact, propose /deft:change <name> and wait for confirmation` to `main.md` Decision Making section (#94)

### Changed
- **PrintNextSteps**: Installer output updated to reflect auto-discovery â€” no longer tells users to manually say 'read AGENTS.md and follow it' (#94)
- **AGENTS.md** (in-repo): Removed redundant Skills line â€” `.agents/skills/` handles discovery (#94)
- **agentsMDEntry**: Removed Skills line from install-generated AGENTS.md â€” `.agents/skills/` handles discovery, resolving the TODO from #75 (#94)

## [0.7.1] - 2026-03-20

### Fixed
- **AGENTS.md Onboarding**: Install-generated `AGENTS.md` now contains self-contained bootstrap logic â€” first-session phase detection (USER.md â†’ Phase 1, PROJECT.md â†’ Phase 2, SPECIFICATION.md â†’ Phase 3), returning-session guidance, and available commands reference (#54, closes #85)
- **Installer 'Next Steps' Output**: Removed false claim that agents read AGENTS.md automatically; users are now told to explicitly say `read AGENTS.md and follow it` with a note that auto-discovery is planned for a future release (#54, #85)
- **README Getting Started**: Removed false-automatic claims from Step 2 and manual clone path; added explicit agent kick-off instructions (#54, #85)
- **In-repo AGENTS.md**: Updated deft repo's own AGENTS.md with developer-focused content and correct root-relative paths (no `deft/` prefix) (#54)

## [0.7.0] - 2026-03-19

### Added
- **Go Installer**: Cross-platform self-contained installer in `cmd/deft-install/` with 5 platform binaries, interactive setup wizard, and platform-aware git installation paths (#34, #35)
- **Agent Skills**: Added `skills/deft-setup/SKILL.md` and `skills/deft-build/SKILL.md` for agent-driven setup and spec implementation workflows (#34, #35)
- **GitHub Actions Release Workflow**: Multi-platform release pipeline with cross-compilation, macOS universal binary creation, and smoke tests
- **Context Engineering Module**: Added `context/` guides for deterministic split, long-horizon context, fractal summaries, working memory, and tool design
- **Canonical vBRIEF Pattern**: Standardized vBRIEF workflow and persistence pattern in `vbrief/vbrief.md`
- **vBRIEF Schema and Validation Tests**: Added `vbrief/schemas/vbrief-core.schema.json` and schema/doc consistency checks (#28, #29)
- **Strategy Chaining Gates**: Added chaining and acceptance gates to support preparatory/spec-generating strategy composition (#39, #41)
- **Testbed Regression Suite**: Expanded content and CLI regression coverage in `tests/` with Taskfile integration (#21, #22)
- **AGENTS.md Project Entry Point**: Added project-level agent onboarding entry point and wiring guidance in docs (#10, #51, #66)
- **ROADMAP.md Consolidation**: Added consolidated roadmap replacing scattered planning artifacts

### Changed
- **Bootstrap Parity**: Aligned CLI and agentic setup paths to produce consistent USER.md output (#45, #14, #61, #65)
  - CLI strategy picker now shows one-line descriptions and a â˜… RECOMMENDED marker for `interview`
  - CLI custom rules prompt now collects actual rules line-by-line instead of accepting a single silent string
  - CLI meta-guidelines (SOUL.md, morals.md, code-field.md) now default to **included** with paragraph descriptions; users can drop any they don't want
  - `deft-setup` SKILL.md strategies table corrected: `interview`, `yolo`, `map`, `discuss`, `research`, `speckit`
  - `deft-setup` Track 1 now presents all three meta-guidelines as included by default with descriptions; user can drop any; Tracks 2/3 include all silently
  - `deft-setup` USER.md template now includes `## Experimental Rules` section when rules are selected
  - `deft-setup` custom rules step now instructs agents to collect rules one per line
- **Interview Strategy Reconciliation**: Unified CLI and agent entry points around strategy-driven spec flow, including sizing gate behavior (#36, #35)
- **Repository URL Migration**: Updated hardcoded repository references from `visionik/deft` to `deftai/directive` across source and documentation (#63, #64)
- **Trunk-Based Workflow**: Updated docs/workflow to remove stale beta-branch model and reflect short-lived feature branches (#69, #70)
- **Bootstrap Defaults**: `cmd_project` defaults project name from current directory and defaults "run spec now" to Yes (#47, #66)
- **Bootstrap Strategy Default**: Default strategy now uses `interview` instead of alphabetical first match (#66)
- **Tooling Dependency**: Bumped `black` from `26.3.0` to `26.3.1` (#48)
- **CHANGELOG Cleanup**: Backfilled post-0.6.0 entries, corrected release links to `deftai/directive`, and added missing `[Unreleased]` link reference (#71)

### Fixed
- **Double Prompting in Bootstrap Chain**: `cmd_project` now reads USER.md defaults (languages/strategy/coverage) instead of re-asking from scratch (#7, #43)
- **Ctrl+C Resume Protection**: Bootstrap/project flows now persist progress and support resume after interruption (#8, #66)
- **Input Validation Gaps**: Added validation for project type, language/strategy selections, coverage bounds, and duplicate selections (#44, #47, #66)
- **USER.md Overwrite Flow**: Added explicit keep/overwrite behavior when USER.md already exists (#44, #66)
- **Installer Exit Prompt on Unix**: `pressEnterToExit()` is now Windows-only, removing extra pause on macOS/Linux (#60, #66)

### Removed
- **Stale `beta` Branch**: Removed legacy beta-branch workflow and references from active docs (#69, #70)
- **Leaked `old/` Directory**: Removed stale personal configuration artifacts from repository (#51, #66)

## [0.6.0] - 2026-03-11

### Added
- **Slash Commands**: `/deft:run:<name>` dispatches to `strategies/<name>.md` (#16)
  - `/deft:run:interview`, `/deft:run:yolo`, `/deft:run:map`, `/deft:run:discuss`, `/deft:run:research`, `/deft:run:speckit`
- **Yolo Strategy**: `strategies/yolo.md` â€” auto-pilot interview where the agent picks all recommended options via "Johnbot" (#16)
- **Change Lifecycle**: Scoped change proposals with `/deft:change` commands (#17, #20)
  - `/deft:change <name>` â€” create proposal in `history/changes/<name>/`
  - `/deft:change:apply` â€” implement tasks from active change
  - `/deft:change:verify` â€” verify against acceptance criteria
  - `/deft:change:archive` â€” archive to `history/archive/<date>-<name>/`
  - `commands.md` â€” full workflow documentation
- **History Directory**: `history/changes/` and `history/archive/` for change tracking (#17)
- **Spec Deltas**: `context/spec-deltas.md` â€” track how requirements evolve across changes (#19)
  - vBRIEF chain pattern linking deltas to baseline specs
  - GIVEN/WHEN/THEN scenario format for behavioral requirements
  - Reading protocol: baseline â†’ active deltas in chronological order
- **Archive Merge Protocol**: Spec delta merge into main spec + CHANGELOG entry on archive (#20)
- **Session Commands**: `/deft:continue` and `/deft:checkpoint` for session management (#16, #20)
- **Glossary**: Added "Spec delta" term definition (#19)
- **Unity Platform Standards**: `platforms/unity.md` â€” Unity 6+ development standards covering project structure, MonoBehaviours, ScriptableObjects, performance, Addressables, testing, and source control (#27)

### Changed
- **Strategy Renames**: `default.md` â†’ `interview.md`, `brownfield.md` â†’ `map.md` (#16)
- **Command Prefix**: Change lifecycle uses `/deft:change` (not `/deft:run:change`); session uses `/deft:continue`/`/deft:checkpoint` (#20)
- **Cross-references updated** across PROJECT.md, REFERENCES.md, core/glossary.md, and all strategy files (#16)
- **strategies/README.md**: Added Command column to strategy table, updated selection examples (#16)

## [0.5.2] - 2026-03-09

### Changed
- **Branch sync**: Merged master (v0.2.3 through v0.4.3) into beta (v0.5.0/v0.5.1) to unify both branches after significant divergence from the v0.2.2 fork point

### Conflict Resolutions
- **CHANGELOG.md**: interleaved both sides chronologically (v0.5.1 â†’ v0.2.3)
- **templates/make-spec.md**: kept beta's vBRIEF specification flow
- **templates/user.md.template**: kept beta's slim override-only template (v0.5.0 intentionally removed duplicated Workflow/AI Behavior sections)
- **core/project.md**: kept master's generic Iglesia template with Volatile Dependency Abstraction rules (beta had project-specific voxio-bot config)
- **docs/claude-code-integration.md**: kept beta's relocated paths (USER.md at ~/.config/deft/, PROJECT.md at project root)
- **run / run.bat**: kept beta's more evolved CLI (2500+ lines with strategies, vBRIEF, and expanded language/deployment support)
- **README.md**: hybrid â€” master's Mermaid diagrams and copyright notice combined with beta's updated file paths and next-steps text

### Removed
- **implementation-plan-phase-1.md**: completed, no longer needed
- **msadams-branch**: retired (all commits absorbed into merge)

## [0.5.1] - 2026-03-08

### Added
- **Phase 1 Testbed**: Implementation plan for intrinsic regression testing
- **SPECIFICATION.md**: Generated specification via deft beta workflow
- **todo.md**: Captured deferred work items and Phase 2 refactoring roadmap

## [0.5.0] - 2026-02-23

### Added
- **`run` CLI/TUI Tool**: Cross-platform Python wizard (2,500+ lines) replacing `warping.sh`
  - `run bootstrap` - User preferences setup (writes to `~/.config/deft/USER.md`)
  - `run project` - Project configuration (writes to `./PROJECT.md`)
  - `run spec` - PRD generation via AI interview
  - `run install` - Install deft in a project directory
  - `run reset` - Reset configuration files
  - `run validate` / `run doctor` - Configuration and system checks
  - TUI mode via Textual (interactive wizard with checkboxes, selects)
  - Rich output support with fallback to plain text
- **Strategies System**: Pluggable development workflows
  - `strategies/interview.md` - Interview (standard) workflow
  - `strategies/speckit.md` - SpecKit spec-driven workflow
  - Strategy selection in bootstrap and project commands
- **RWLDL Tool**: Ralph Wiggum's Loop-de-Loop (`tools/RWLDL.md`)
  - Iterative micro/macro code refinement loop with RFC2119 notation
- **Meta Files**: `meta/SOUL.md` (agent persona), `meta/morals.md` (ethical guidelines)
- **Docs**: `docs/claude-code-integration.md` (AgentSkills integration guide)

### Changed
- **USER.md relocated**: Default path moved from `core/user.md` to `~/.config/deft/USER.md`
  - Configurable via `DEFT_USER_PATH` env var
  - Legacy fallback to `core/user.md` preserved
- **PROJECT.md relocated**: Default path moved from `core/project.md` to `./PROJECT.md`
  - Configurable via `DEFT_PROJECT_PATH` env var
- **Templates slimmed to override-only**: `user.md.template` and `project.md.template`
  - Removed sections that duplicated core deft rules (Workflow Preferences, AI Behavior, Standards)
  - Coverage threshold only emitted when non-default (â‰ 85%)
- **All path references updated** across main.md, REFERENCES.md, README.md, SKILL.md,
  core/project.md, and docs/claude-code-integration.md
- **Principles section** added to project.md template

### Removed
- Redundant Workflow Preferences and AI Behavior sections from generated user.md
- Redundant Workflow commands and Standards sections from generated project.md
- vBRIEF integration section from ideas.md (moved to future consideration)

## [0.4.3] - 2026-02-04

### Added
- **README Mermaid Diagrams**: Added 5 visual diagrams to improve documentation clarity
  - Layer Precedence: Visual hierarchy from user.md to specification.md
  - Continuous Improvement: Feedback loop showing framework evolution
  - TDD Cycle: Classic red-green-refactor loop visualization
  - SDD Flow: Spec-driven development from idea to multi-agent build
  - Example Workflows: Three parallel workflow diagrams for new projects, existing projects, and code review

## [0.4.2] - 2026-01-31

### Changed
- **TUI UX Improvements**: Enhanced form design and user experience
  - Replaced all y/n text inputs with checkboxes for boolean options
  - Converted multi-selection fields to checkboxes (programming languages, project types)
  - BootstrapScreen: Programming languages and experimental rules now use checkboxes
  - ProjectScreen: Project types and primary language now use checkboxes
  - Fixed button visibility: Moved Submit/Cancel buttons outside ScrollableContainer
  - Added CSS styling to make buttons auto-sized (not 50% of screen)
  - Consistent TUI pattern: checkboxes for boolean/multi-choice, buttons for actions, inputs for text only
- **TUI Navigation**: Fixed markdown viewer navigation for internal links
  - Added history tracking to README, CHANGELOG, and Main.md viewers
  - Fixed SKILL.md link issue (was being converted to http://SKILL.md domain)
  - Internal .md links now navigate within viewer instead of opening browser
  - External http/https URLs still open in browser as expected
  - ESC key navigates back through document history or returns to menu
  - 'q' key always returns to menu from any document
- **TUI Documentation**: Added CHANGELOG and Main.md viewers to menu
  - New menu options after README for viewing CHANGELOG.md and main.md
  - All three markdown viewers support full navigation and history

### Fixed
- **TUI Import Error**: Removed Slider widget import (not available in Textual 7.5.0)
  - Slider widget attempted but not available in current Textual version
  - Reverted coverage threshold back to Input fields
  - TUI now launches properly with `./run` command

## [0.4.1] - 2026-01-31

### Changed
- **Documentation Optimization**: Reduced token usage across core documentation files
  - SKILL.md: 451 â†’ 170 lines (62% reduction) - Removed redundant workflow examples, kept core concepts
  - github.md: 640 â†’ 254 lines (60% reduction) - Removed CLI command reference, kept best practices and templates
  - git.md: 378 â†’ 139 lines (63% reduction) - Removed basic command examples, kept standards and safety rules
  - telemetry.md: 337 â†’ 254 lines (25% reduction) - Condensed tool examples while keeping Sentry config
  - Total: ~989 lines removed (55% overall reduction) while preserving all essential standards
- **Testing Standards**: Enhanced test-first development requirements
  - Added "Test-First Development" section to testing.md with mandatory test coverage rules
  - Implementation now INCOMPLETE until tests written AND `task test:coverage` passes
  - New functions/classes MUST have tests in same commit
  - Modified functions MUST update existing tests
  - Added test coverage anti-patterns to coding.md and testing.md
- **GitHub Standards**: Added post-1.0.0 issue linking guidelines
  - MUST link commits to issues for: features, bugs, breaking changes, architecture decisions
  - SHOULD NOT create issues for: typos, formatting, dependency bumps, refactoring
  - SHOULD create issues for: searchable items or items needing discussion
- **Taskfile Standards**: Added common task commands reference
  - Moved from coding.md to tools/taskfile.md for better organization
  - Includes: fmt, lint, test, test:coverage, quality, check, build
- **SKILL.md Updates**: 
  - Changed all `./run` and `deft.sh` references to `deft/run` for consistency
  - Added first-use bootstrap guidance for existing projects
  - Reduced from 451 to 170 lines while keeping all essential information

### Fixed
- **Documentation Consistency**: Aligned command references across all files to use `deft/run` prefix

## [0.4.0] - 2026-01-31

### Added
- **TUI Wizard Mode**: Full Textual-based interactive wizard interface
  - Launches with `./run`, `./run tui`, or `./run wizard`
  - Interactive menu with 10 screens: Bootstrap, Project, Spec, Install, Reset, Validate, Doctor, README, Help, Exit
  - BootstrapScreen: User preferences form with name, coverage, languages, custom rules
  - ProjectScreen: Project configuration form with type, language, tech stack
  - SpecScreen: Specification generator with dynamic feature list (add/remove features)
  - InstallScreen: Framework installation with directory input
  - ResetScreen: Configuration reset with file status display
  - ValidateScreen: Configuration validation with scrollable results
  - DoctorScreen: System dependency check with scrollable results
  - ReadmeScreen: MarkdownViewer with table of contents and navigation
  - HelpScreen: Usage information display
  - Centered menu layout with aligned option descriptions
  - Consistent cyan accent theme matching CLI aesthetic
  - Navigation: Escape/Q to quit, context-specific keybindings
  - SuccessScreen: Reusable success messages with optional next-step navigation
- **Enhanced CLI UX**: Improved rich output formatting
  - Markdown ## headers for section titles (cleaner than horizontal rules)
  - Prompt_toolkit integration with colored prompts and arrow key editing
  - HTML-formatted prompts with cyan ? prefix
  - Graceful fallback when dependencies not installed

### Changed
- **Help System**: `-h`, `--help`, `-help` flags show usage (TUI no longer launches for `./run` with no args if textual not installed)
- **Menu Design**: Aligned option labels with minimal dots (longest command name sets alignment)
- **Empty Separators**: Replaced `---` separators with empty lines for cleaner menu

### Fixed
- **ANSI Codes**: Fixed raw ANSI escape codes displaying literally in prompt_toolkit prompts
- **Import Compatibility**: Fixed Separator import from textual (use Option with empty string instead)

## [0.3.7] - 2026-01-29

### Changed
- **README Getting Started**: Complete rewrite with clearer workflow
  - New structure: Install â†’ Bootstrap â†’ Generate Spec â†’ Build with AI
  - Added git clone installation instructions
  - Streamlined command examples
  - Removed platform-specific sections

### Removed
- **Platform-specific content**: Removed "Integration with Warp AI" section
- **notes-keys.html**: Removed development file from repository

## [0.3.6] - 2026-01-29

### Changed
- **README Quick Start**: Updated run command examples
  - Changed from `run` to `deft/run` prefix for clarity
  - Removed `run install` command
  - Updated workflow to: bootstrap â†’ project â†’ spec

## [0.3.5] - 2026-01-29

### Changed
- **README Structure**: Moved copyright notice to end of file for better flow
  - Copyright and license info now appears at bottom after main content
  - Cleaner opening for new readers

## [0.3.4] - 2026-01-29

### Changed
- **README Formatting**: Consolidated file descriptions to one line per file for better readability
  - Core, Languages, Interfaces, Tools, Templates, and Meta sections now use single-line format
  - Improved scannability and reduced visual clutter

## [0.3.3] - 2026-01-29

### Changed
- **README TL;DR Enhancements**: 
  - Emphasized Deft as a SKILL.md format for AI coding effectiveness
  - Added platform compatibility note for systems without SKILL.md support (e.g. Warp.dev)
  - Added context efficiency explanation: RFC 2119 notation and lazy-loading keep context windows lean
  - Clarified that Deft is markdown-first with optional Python CLI for setup

## [0.3.2] - 2026-01-29

### Changed
- **README TL;DR**: Added note about professional-grade defaults
  - Highlights that Deft works out of the box without customization
  - Emphasizes built-in standards for Python, Go, TypeScript, C++

## [0.3.1] - 2026-01-29

### Changed
- **MIT License**: Updated from temporary usage terms to full MIT License
  - Users can now freely use, modify, distribute, and sell Deft
  - Only requirement: retain copyright notice and license text
  - Updated LICENSE.md with standard MIT text
- **Branding**: Updated copyright notices to include website
  - Copyright now reads: Jonathan "visionik" Taylor
  - Added https://deft.md reference in LICENSE.md and README.md
- **README Improvements**: Added TL;DR section
  - Quick summary of what Deft is and why it's valuable
  - Highlights key benefits before diving into details

## [0.3.0] - 2026-01-29

### Changed
- **Project renamed from Warping to Deft**: Complete rebrand across all files and documentation
  - CLI command renamed from `wrun` to `run`
  - All references to "Warping" replaced with "Deft" throughout documentation
  - GitHub repository renamed from `visionik/warping` to `visionik/deft`
  - Local directory renamed to match new project name
  - Updated LICENSE.md, README.md, and all markdown files
  - Updated Taskfile.yml project name variable

## [0.2.5] - 2026-01-23

### Added
- **`run reset` command**: Reset configuration files to default/empty state
  - Interactive mode: prompts for each file individually
  - Batch mode (`--all`): resets all files without prompting
  - Resets user.md to default template, deletes project.md/PRD.md/SPECIFICATION.md
- **Guided workflow prompts**: Commands now chain together interactively
  - `run install` asks to run `run project` after completion
  - `run bootstrap` asks to run `run project` after completion (if in deft directory)
  - `run project` asks to run `run spec` after completion
  - Creates smooth guided flow: install â†’ bootstrap â†’ project â†’ spec
- **Enhanced command descriptions**: Each command now shows detailed explanation at startup
  - `run install`: Shows what will be created (deft/, secrets/, docs/, Taskfile.yml, .gitignore)
  - `run project`: Explains project.md purpose (tech stack, quality standards, workflow)
  - `run spec`: Explains PRD.md creation and AI interview process
- **Smart project name detection**: `run spec` reads project name from project.md
  - Auto-suggests project name if project.md exists
  - Falls back to manual input if not found
- **Improved prompt_toolkit installation**: Better detection and instructions
  - Shows exact Python interpreter path being used
  - Detects externally-managed Python (PEP 668)
  - Automatically includes `--break-system-packages` flag when needed
  - Provides clear explanation and alternatives (venv, pipx)
  - Links to PEP 668 documentation

### Changed
- **Renamed `run.py` â†’ `run`**: Removed .py extension for cleaner command
  - Follows Unix convention for executables
  - More professional appearance
  - All documentation updated
- **Renamed `run init` â†’ `run install`**: Better matches common tooling patterns
  - Aligns with Makefile/Taskfile conventions (make install, task install)
  - Clearer intent: "install deft framework"
  - Less confusion with bootstrap command
  - Updated all references: "initialized" â†’ "installed", "Reinitialize" â†’ "Reinstall"
- **Updated README.md**: Added Quick Start section with run commands
  - Shows complete workflow: install â†’ bootstrap â†’ project â†’ spec
  - Lists all available commands with descriptions

### Fixed
- **prompt_toolkit installation issues**: Python version mismatch detection
  - Now uses `python -m pip` instead of bare `pip` command
  - Ensures package installs for correct Python interpreter
  - Prevents "module not found" errors when Python 3.x versions differ

## [0.2.4] - 2026-01-22

### Added
- **AgentSkills Integration**: Added `SKILL.md` for Claude Code and clawd.bot compatibility
  - Follows AgentSkills specification for universal AI assistant compatibility
  - Auto-invokes when working in deft projects or mentioning deft standards
  - Teaches AI assistants about rule precedence, lazy loading, TDD, SDD, and quality standards
  - Includes comprehensive "New Project Workflow" section with step-by-step guidance
  - Documents complete SDD process: PRD â†’ AI Interview â†’ Specification â†’ Implementation
  - Compatible with both Claude Code (IDE) and clawd.bot (messaging platforms)
- **clawd.bot Support**: Added clawd.bot-specific metadata to SKILL.md
  - Requires `task` binary (specified in metadata)
  - Supports macOS and Linux platforms
  - Homepage reference to GitHub repository
  - Installation paths for shared and per-agent skills
- **Integration Documentation**: Created `docs/claude-code-integration.md` (renamed to include clawd.bot)
  - Installation instructions for both Claude Code and clawd.bot
  - Usage examples across IDE and messaging platforms
  - Publishing guidance for Skills Marketplace and ClawdHub
  - Multi-agent setup documentation
  - Cross-platform benefits and compatibility notes

### Changed
- **SKILL.md Structure**: Enhanced with detailed workflow sections
  - Step-by-step initialization workflow (init â†’ bootstrap â†’ project â†’ spec)
  - Conditional logic for first-time user setup
  - Complete SDD workflow documentation with user review gates
  - Context-aware workflows for new projects vs existing projects vs new features
  - Integration notes expanded to cover multiple AI platforms

## [0.2.3] - 2026-01-22

### Added
- **Project Type Selection**: Added "Other" option (option 6) to project type selection in `deft.sh project`
  - Prompts for custom project type when selected
  - Allows flexibility for project types beyond CLI, TUI, REST API, Web App, and Library

### Changed
- **Spec Command Output**: Improved next steps messaging in `deft.sh spec`
  - Now displays full absolute paths to PRD.md and SPECIFICATION.md
  - Updated AI assistant references to "Claude, Warp.dev, etc."
  - Added steps 5-7 with guidance on reviewing, implementing, and continuing with AI
  - Clearer instructions: "Ask your AI to read and run {full_path}"

## [0.2.2] - 2026-01-21

### Added
- **LICENSE.md**: Added license file with temporary usage terms through 2026
  - Permission to use (but not distribute) for repository collaborators
  - Future plans for permissive license preventing resale
- **Copyright Notice**: Added copyright to README.md with contact email

## [0.2.1] - 2026-01-18

### Added
- **SCM Directory**: Created `scm/` directory for source control management standards
  - `scm/git.md` - Git workflow and conventions
  - `scm/github.md` - GitHub workflows and releases
  - `scm/changelog.md` - Changelog maintenance standards (releases only)
- **Versioning Standards**: Added `core/versioning.md` with RFC2119-style Semantic Versioning guide
  - Applies to all software types (APIs, UIs, CLIs, libraries)
  - Decision trees, examples, and FAQ
  - Integration with git tags and GitHub releases

### Changed
- **SCM Reorganization**: Moved `tools/git.md` and `tools/github.md` to `scm/` directory
- **Documentation Standards**: All technical docs now use strict RFC2119 notation
  - Use symbols (!, ~, ?, âŠ—, â‰‰) only, no redundant MUST/SHOULD keywords
  - Minimizes token usage while maintaining clarity
- **Internal References**: All docs reference internal files instead of external websites
  - semver.org â†’ `core/versioning.md`
  - keepachangelog.com â†’ `scm/changelog.md`

### Fixed
- Removed all redundant MUST/SHOULD/MAY keywords from technical documentation
- Corrected RFC2119 syntax throughout framework (swarm.md, git.md, github.md)
- Fixed grammar issues in changelog.md

## [0.2.0] - 2026-01-18

### Added

#### Core Features
- **CLI Tool**: New `deft.sh` script for bootstrapping and project setup
  - `deft.sh bootstrap` - Set up user preferences
  - `deft.sh project` - Configure project settings
  - `deft.sh init` - Initialize deft in a new project
  - `deft.sh validate` - Validate configuration files
- **Task Automation**: Added `Taskfile.yml` with framework management tasks
  - `task validate` - Validate all markdown files
  - `task build` - Package framework for distribution
  - `task install` - Install CLI to /usr/local/bin
  - `task stats` - Show framework statistics
- **Template System**: User and project configuration templates
  - `templates/user.md.template` - Template for new users
  - Generic templates in `core/user.md` and `core/project.md`

#### Documentation
- **REFERENCES.md**: Comprehensive lazy-loading guide for when to read which files
- **Expanded Language Support**: Added detailed standards for:
  - C++ (cpp.md) - C++20/23, Catch2/GoogleTest, GSL
  - TypeScript (typescript.md) - Vitest/Jest, strict mode
- **Interface Guidelines**: New interface-specific documentation
  - `interfaces/cli.md` - Command-line interface patterns
  - `interfaces/rest.md` - REST API design
  - `interfaces/tui.md` - Terminal UI (Textual, ink)
  - `interfaces/web.md` - Web UI (React, Tailwind)

#### Organization
- **New `coding/` directory**: Reorganized coding-specific standards
  - `coding/coding.md` - General coding guidelines
  - `coding/testing.md` - Universal testing standards
- **Meta files**: Added self-improvement documentation
  - `meta/code-field.md` - Coding mindset and philosophy
  - `meta/lessons.md` - Codified learnings (AI-updatable)
  - `meta/ideas.md` - Future directions
  - `meta/suggestions.md` - Improvement suggestions

### Changed

#### Breaking Changes
- **Directory Restructure**: Moved files to new locations
  - `core/coding.md` â†’ `coding/coding.md`
  - `tools/testing.md` â†’ `coding/testing.md`
  - All cross-references updated throughout framework
- **User Configuration**: `core/user.md` now in `.gitignore`
  - Users should copy from `templates/user.md.template`
  - Prevents accidental commits of personal preferences

#### Improvements
- **Enhanced README.md**: Comprehensive overview with examples
- **Better Documentation**: Clearer hierarchy and precedence rules
- **Framework Philosophy**: Documented key principles (TDD, SDD, Task-centric workflows)
- **Coverage Requirements**: Standardized at â‰¥85% across all languages
- **Fuzzing Standards**: Added â‰¥50 fuzzing tests per input point requirement

### Removed
- **Pronouns Field**: Removed from user bootstrap process in `deft.sh`

### Fixed
- All internal references updated to reflect new directory structure
- Consistent path references across all markdown files
- Cross-reference links in language and interface files

## [0.1.0] - Initial Release

Initial release of the Deft framework with:
- Core AI guidelines (main.md)
- Python and Go language standards
- Basic project structure
- Taskfile integration guidelines
- Git and GitHub workflows

---

## Migration Guide: 0.1.0 â†’ 0.2.0

### File Paths
If you have custom scripts or references to deft files, update these paths:
- `core/coding.md` â†’ `coding/coding.md`
- `tools/testing.md` â†’ `coding/testing.md`

### User Configuration
1. Copy `templates/user.md.template` to `core/user.md`
2. Customize with your preferences
3. Your `core/user.md` will be ignored by git

### New Features to Explore
- Run `deft.sh bootstrap` to set up user preferences interactively
- Check out `REFERENCES.md` for lazy-loading guidance
- Explore new interface guidelines if building CLIs, APIs, or UIs
- Review enhanced language standards for Python, Go, TypeScript, and C++

[Unreleased]: https://github.com/deftai/directive/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/deftai/directive/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/deftai/directive/compare/v0.14.2...v0.15.0
[0.14.2]: https://github.com/deftai/directive/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/deftai/directive/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/deftai/directive/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/deftai/directive/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/deftai/directive/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/deftai/directive/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/deftai/directive/compare/v0.10.3...v0.11.0
[0.10.3]: https://github.com/deftai/directive/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/deftai/directive/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/deftai/directive/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/deftai/directive/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/deftai/directive/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/deftai/directive/compare/v0.7.1...v0.8.0
[0.7.0]: https://github.com/deftai/directive/releases/tag/v0.7.0
<!-- [0.6.0] has no git tag â€” it was a beta-only version that was never tagged on master. -->
[0.5.2]: https://github.com/deftai/directive/releases/tag/v0.5.2
[0.5.1]: https://github.com/deftai/directive/releases/tag/v0.5.1
[0.5.0]: https://github.com/deftai/directive/releases/tag/v0.5.0
[0.4.3]: https://github.com/deftai/directive/releases/tag/v0.4.3
[0.4.2]: https://github.com/deftai/directive/releases/tag/v0.4.2
[0.4.1]: https://github.com/deftai/directive/releases/tag/v0.4.1
[0.4.0]: https://github.com/deftai/directive/releases/tag/v0.4.0
[0.7.1]: https://github.com/deftai/directive/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/deftai/directive/releases/tag/v0.7.0
[0.3.7]: https://github.com/deftai/directive/releases/tag/v0.3.7
[0.3.6]: https://github.com/deftai/directive/releases/tag/v0.3.6
[0.3.5]: https://github.com/deftai/directive/releases/tag/v0.3.5
[0.3.4]: https://github.com/deftai/directive/releases/tag/v0.3.4
[0.3.3]: https://github.com/deftai/directive/releases/tag/v0.3.3
[0.3.2]: https://github.com/deftai/directive/releases/tag/v0.3.2
[0.3.1]: https://github.com/deftai/directive/releases/tag/v0.3.1
[0.3.0]: https://github.com/deftai/directive/releases/tag/v0.3.0
[0.2.5]: https://github.com/deftai/directive/releases/tag/v0.2.5
[0.2.4]: https://github.com/deftai/directive/releases/tag/v0.2.4
[0.2.3]: https://github.com/deftai/directive/releases/tag/v0.2.3
[0.2.2]: https://github.com/deftai/directive/releases/tag/v0.2.2
[0.2.1]: https://github.com/visionik/warping/releases/tag/v0.2.1
[0.2.0]: https://github.com/visionik/warping/releases/tag/v0.2.0
[0.1.0]: https://github.com/visionik/warping/releases/tag/v0.1.0
