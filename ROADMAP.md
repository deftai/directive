# Deft Directive -- Roadmap

Prioritized work items. **Principle: resolve open issues before new features.**

---

## Phase 1 -- Bug Fixes & Issue Resolution (Next Up)

Fix reported bugs and UX problems blocking adoption.
Phase 1 is now empty -- all adoption blockers and cleanup items resolved as of v0.19.0.

---

## Phase 2 -- vBRIEF Architecture Cutover

Big-bang cutover to the vBRIEF-centric document model. Individual scope vBRIEFs in a lifecycle folder structure replace SPECIFICATION.md and PROJECT.md. ROADMAP.md becomes a generated artifact. All skills renamed from `deft-*` to `deft-directive-*`. No coexistence period -- clean version boundary cut.

**Prerequisite:** Phase 1 complete. See RFC #309 for all 18 design decisions.

### RFC

- **#309** -- RFC: vBRIEF-centric document model for Deft Directive (D1-D18; authoritative source for all stories below)

### Tier 1 -- Foundation (parallelizable)

- **#310** -- Story A: Update vbrief.md with new vBRIEF-centric document model (lifecycle folders, PROJECT-DEFINITION type, epic-story linking, filename convention, scope splitting pattern)
- **#311** -- Story B: Roadmap generation tool (`task roadmap:render`) + auto-generated banner + drift detection in `task check`
- **#312** -- Story C: Migration script (`task migrate:vbrief`) -- converts SPECIFICATION.md + PROJECT.md + ROADMAP.md to new structure; deprecation redirects for SPECIFICATION.md/PROJECT.md; .agents/skills/ directory restructuring
- **#323** -- Story N: PROJECT-DEFINITION regeneration tool (`task project:render`) -- deterministic items registry + staleness flagging
- **#324** -- Story O: Scope lifecycle task commands (`task scope:promote/activate/complete/cancel/restore/block/unblock`)
- **#333** -- Story R: Validation tooling for vBRIEF-centric model (scope validator, PROJECT-DEFINITION validator, folder/status consistency, epic-story links, task check integration)

### Tier 2 -- Framework docs (depends on Story A)

- **#313** -- Story D: Core doc updates (main.md, AGENTS.md) for vBRIEF-centric model
- **#331** -- Story P: Ancillary doc updates (REFERENCES.md, README.md, CONTRIBUTING.md, commands.md, strategies/, templates/, context/)

### Tier 3 -- Skills (depends on Stories A + D; parallelizable via swarm)

- **#314** -- Story E: deft-directive-setup (rename + rewrite for vBRIEF model)
- **#315** -- Story F: deft-directive-build, review-cycle, pre-pr (rename + update; installer scope moved to Story Q)
- **#332** -- Story Q: Go installer rewrite for `deft-directive-*` namespace (9 thin pointers, agentsMDEntry, allSkillNames)
- **#316** -- Story G: deft-directive-refinement (rename + rewrite from roadmap-refresh -- conversational ingest/promote/reprioritize session; note: also depends on Stories B + O for scope command API shape)
- **#317** -- Story H: deft-directive-swarm (rename + flexible vBRIEF-based allocation)
- **#318** -- Story I: deft-directive-sync (rename + validate new structure + origin freshness)
- **#319** -- Story J: deft-directive-interview (namespace rename)

### Tier 4 -- CLI and tests (depends on all above)

- **#320** -- Story K: CLI updates (cmd_spec, cmd_project) for vBRIEF model
- **#321** -- Story L: Test coverage for vBRIEF-centric document model
- **#334** -- Story S: Pre-cutover detection and backward compatibility guard (old-model detection, error messages, greenfield path, placeholder integrity)

### Tier 5 -- Post-cutover

- **#322** -- Story M: Post-cutover GitHub issue reconciliation
- **#335** -- Story T: Release and version boundary items (v0.20.0 bump, CHANGELOG, CI workflows, PR template)

---

## Phase 3 -- Documentation & Content Fixes

Quick doc/content fixes that don't require code changes.

### Philosophy & Positioning

- **#89** -- Deft identity and positioning: resolve naming before README reframe (blocks #84 Phase 2 README reframe, `meta/philosophy.md`, interview strategy updates)

### Content & Doc Fixes

- **#151** -- [Playtest Feedback] First-time non-technical user session report (19 issues + 4 strategic recommendations) -- umbrella issue; content/wording fixes here, strategic recommendations (cost interview, co-pilot, tiered UX, IP risk flagging) deferred to Phase 5 (xrefs #77, #84, #89, #136)
- Rename: purge remaining "Warping" references from README.md, `warping.sh`, Taskfile.yml; reframe README per #89 resolution (#84 Phase 2, blocked on #89)
  - `README.md` still says "Warping Process", "What is Warping?", "Contributing to Warping"
  - Reframe from "coding standards framework" → resolved tagline from #89
  - `Taskfile.yml` `VERSION` -- update to match latest release
  - `warping.sh` still present -- remove or deprecate (replaced by `run` in v0.5.0)
  - Verify: `test_standards.py` xfail for Warping references should flip to passing
- Clean leaked personal files:
  - ~~Voxio Bot private project config~~ -- done (v0.10.0, t2.1.6: replaced with generic template + legacy redirect)
  - `PROJECT.md` (repo root) -- leftover from bootstrap test run; remove or replace
  - Verify: `test_standards.py` xfail for Voxio Bot content should flip to passing
- Update `strategies/interview.md` to probe language/tool choices through the contract lens -- when user picks a language, prompt to consider habit vs. suitability (#84 Phase 2)
- Create `meta/philosophy.md` -- full contract hierarchy narrative for agent reference and direct user reading (#84 Phase 2)
- **#82** -- Replacement strategies need accept-or-scrap exit when plan artifacts already exist (design: artifact awareness for chaining gate)
- **#103** -- Standalone brownfield/map analysis without requiring interview (allow `/deft:run:map` as independent entry point)
- **#127** -- Improved support for Deft in existing repositories -- bootstrap should detect existing code and offer brownfield/map analysis path instead of greenfield-only questionnaire (related to #103; CLI integration in Phase 4 with #53)
- Port any remaining `SKILL.md` carry-forward content from master
  - Three commits on master updated SKILL.md (`a6f120a`, `cc442fc`, `2f2a89e`)
  - Largely superseded by `deft-setup`/`deft-build` skills; review for carry-forward content
- ~~Write remaining CHANGELOG entries~~ -- tracked by #71 (Phase 1)
- **#112** -- External “Deft Directive” PDF is premature -- describes post-Phase-1-3 state; defer distribution or add known-issues caveat; incorporate as `docs/getting-started.md` after Phases 1–3 ship
- **#114** -- Document all global Warp rules used for deft development; migrate project-scope rules to `AGENTS.md`/`CONVENTIONS.md`; inventory remaining global-only rules in `CONTRIBUTING.md`
- **#258** -- Inventory Warp Drive global rules used for deft development and document in `CONTRIBUTING.md` under a Warp-specific section (spinoff of #114; blocked on #89 positioning resolution; with #136)
- **#136** -- Warp doesn't load deft's AGENTS.md by default
- **#194** -- User-facing best practices guide (`docs/best-practices.md`) -- Directive contract hierarchy usage, Warp swarming patterns, and user-oriented skill documentation; in-repo successor to premature PDF guide (#112); depends on #147 and #188 for stable content (xrefs #112, #84, #114)

---

## Phase 4

- **#74** -- Automate release process
- **#128** -- CI vBRIEF schema sync check: fetch upstream `vbrief-core.schema.json` from `deftai/vBRIEF`, diff against vendored copy, fail on divergence (depends on #57)
- **#115** -- Strengthen spec validation gate: add CI freshness check detecting stale `SPECIFICATION.md` (schema checks landed in PR #130 -- `spec_validate.py` now enforces vBRIEF v0.5 structure, status enum, legacy key detection)
- **#33** -- When using Docker, smoke tests and e2e tests should validate Docker (docker:up, /healthz)
- CLI tests for remaining commands: `cmd_spec`, `cmd_install`, `cmd_reset`, `cmd_update`
- Error and edge case testing for core CLI commands
- **#163** -- Enforce USER.md gate in CLI path -- parity with agentic (skills) path
  - `cmd_spec` and `cmd_project` should check for USER.md at entry; if absent, warn and redirect to `run bootstrap`
  - Skills path already done (deft-build); this covers the CLI fallback path only
- **#228** -- Bring run CLI into test coverage measurement -- refactor run/run.py to separate pure logic from terminal I/O, add unit tests, remove pyproject.toml omit entries (confirm #160 disposition before implementing)
- Code signing
- Low-end LLM compatibility testing
  - Validate installer and agent process (deft-setup, deft-build) on small/quantised models (e.g. Qwen3-9B)
  - Ensure strategies, interview flow, and spec generation still produce good results
  - Document minimum recommended model size in README or AGENTS.md
- Upgrade GitHub Actions to Node.js 24
  - `actions/checkout`, `actions/setup-go`, `actions/upload-artifact`, `actions/download-artifact`
  - Bump to versions that support Node.js 24 when available (v5+), or set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`

---

## Phase 5 -- Package Distribution & Install UX

Publish deft as NPM + PIP CLI packages for developer-audience install.
Complements the Go installer (which targets novice/bare-machine users).

- **#56** -- Reduce installation friction -- add shell one-liner, Homebrew, and platform package managers (absorbed #101: decide whether manual clone path stays or goes)
- **#53** -- deft-install should bootstrap the current directory by default
- **#75** -- Skill auto-discovery: make deft skills work in both user projects and deft development (symlinks/copies to `.agents/skills/`, `.claude/skills/`, etc.)
- **#11** -- NPM + PIP CLI distribution (`npm i -g @deftai/directive`, `pipx install deft-cli`)

**Prerequisites:** Phase 3 complete (clean content), issue #4 resolved (project-local layout)

Scope: `deft install`, `deft bootstrap`, `deft update`, `deft doctor` commands,
GitHub Actions publish workflows (tag → npm publish + twine upload),
README updated with NPM + PIP install paths alongside Go binary.

---

## Phase 6 -- CLI Overhaul & New Features

Larger feature work -- only after issues are resolved and content is stable.

- **#84 Phase 3** -- Deft as teacher: teach strategy, lessons evolution
  - Build `strategies/teach.md` -- Feynman technique applied to Deft itself, philosophy as a conversation
  - Evolve `lessons.md` -- when adding a lesson, include not just *what* was learned but *why it matters* in the contract hierarchy
- **#52** -- Install into `.deft/` (hidden directory) instead of `deft/`
- **#55** -- Register Deft commands as native agent slash commands (Claude Code, Copilot, Gemini, etc.) -- also absorbs slash-command registration scope from #54
- **#46** -- Provide a way for users to update meta MD files (SOUL, MORALS, CODE-FIELD, USER, etc.)
- **#77** -- Allow users to change technical rating (1/2/3) when starting a new project
- **#78** -- Bootstrap: offer to update user preferences when USER.md already exists
- **#86** -- Artifact-branch binding and complete audit trail for SDD (dual-format persistence, branch lifecycle hooks, artifact manifest)
- **#76** -- Obsidian Vault generation as structured agent memory (interlinked markdown notes, per-agent knowledge scopes)
- **#12** -- Deft Bootstrap CLI with TUI (Typer + Textual, strategy-aware feature branching, agent config generation)
- **#9** -- Issue tracking system integration (GitHub Issues, Jira, Asana -- optional, via MCP)
- **#95** -- Compliance-aligned constitution templates + readiness scanners (SOC 2, ISO 27001, HIPAA, HiTrust); sub-issues #96–#100 cover config schema, control mapping registry, scoring, evidence gap analysis, and automation hooks
- **#140** -- Automatically check for updates to cloned repos in a project -- detect stale cloned dependencies, notify user; part of future `deft doctor`/`deft update` (new CLI tooling)
- **#160** -- Consider TypeScript instead of Python for `run` CLI -- architectural decision for CLI overhaul; decide before #11 and #12 (xrefs #118)
- **#212** -- discussion: Process control belongs in Directive -- universal process principles (review cycle, parallel work, batch-fix) as first-class Directive content; skills become tool-specific adapters; explicitly DO NOT IMPLEMENT until team decision reached (xrefs #89, #147, #194, #159)
- **#233** -- More Determinism: full initiative -- Phase 0 spec scaffolding (generated per-phase task gates), task doctor, and remaining deterministic enforcement tasks (build:verify, change:archive); tasks/ restructure, toolchain:check, verify:stubs, validate:links, changelog:check, change:init, commit:lint completed in v0.17.0; early-win subset #235 closed in v0.17.0
- LLM-assisted content validation
- Self-upgrade to Deft Directive product (branding, public docs, distribution packaging)

---

## Completed
- ~~#305 -- perf(review-cycle): Greptile review cycle bottlenecks -- 5-change optimization bundle (mandate deft-pre-pr, PR scope gate, adaptive poll cadence, parallel swarm cascade monitoring, .greptile/rules.md template)~~ -- 2026-04-13 (v0.19.0)
- ~~#307 -- fix(skill): deft-review-cycle Approach 2 capability detection gap -- add Approach 3 interactive blocking fallback with user warning~~ -- 2026-04-13 (v0.19.0)
- ~~#328 -- docs(deft-review-cycle): add Select-String fallback for oversized gh pr view output~~ -- 2026-04-13 (v0.19.0)
- ~~#301 -- fix(agents): tighten deft-interview routing keyword -- replace bare interview with interview loop / q&a loop / run interview loop~~ -- 2026-04-13 (v0.19.0)
- ~~#302 -- fix(skill): deft-interview invocation contract -- clarify embedded vs delegation usage modes~~ -- 2026-04-13 (v0.19.0)
- ~~#303 -- fix(skill): deft-interview Rule 5 vs Rule 6 inconsistency -- ok accepted for default but not confirmation gate~~ -- 2026-04-13 (v0.19.0)
- ~~#304 -- test(skill): add regression test for deft-setup Phase 1/2 referencing deft-interview~~ -- 2026-04-13 (v0.19.0)
- ~~#293 -- test(cli): add subprocess-based unit tests for v0.17.0 task scripts -- 25 test cases in tests/cli/test_task_scripts.py~~ -- 2026-04-13
- ~~#298 -- chore(spec): flip all 24 stale [pending] task statuses to [completed] in SPECIFICATION.md~~ -- 2026-04-13
- ~~#235 -- feat(tasks): toolchain:check + changelog:check as task check deps
- ~~#233 (partial) -- More Determinism: tasks/ restructure, toolchain:check, verify:stubs, validate:links, spec:pipeline, changelog:check, change:init, commit:lint, enhanced check -- remaining items (Phase 0 generation, build:verify, change:archive, doctor) still open~~ -- 2026-04-10 (v0.17.0)
- ~~#256 -- fix(docs): use OS temp directory for --body-file to avoid rm denylist collision~~ -- 2026-04-10 (v0.16.0)
- ~~#261 + #263 -- fix(skill): deft-swarm Phase 5->6 gate hardening + crash recovery -- context-pressure bypass prohibition + structured merge-readiness checklist~~ -- 2026-04-10 (v0.16.0)
- ~~#279 -- fix(skill): deft-review-cycle Approach 2 idle-stoppage warning + prefer Approach 1 rule for swarm agents~~ -- 2026-04-10 (v0.16.0)
- ~~#272 -- fix(skill): deft-setup pwd path anchor -- ! rule anchoring all paths to pwd at skill entry~~ -- 2026-04-10 (v0.16.0)
- ~~#269 -- fix(skill): deft-setup post-interview confirmation gate + Warp auto-approve warning; absorbs #271~~ -- 2026-04-10 (v0.16.0)
- ~~#274 -- fix(workflow): semantic accuracy check in mandatory pre-commit file review~~ -- 2026-04-10 (v0.16.0)
- ~~#281 -- fix(test): WinError 448 pytest-current symlink cleanup -- tmp_path_retention_count + conftest.py monkeypatch~~ -- 2026-04-10 (v0.16.0)
- ~~#282 -- fix(skill): deft-review-cycle MCP capability detection + task check pre-existing failure carve-out~~ -- 2026-04-10 (v0.16.0)
- ~~#283 -- fix(agents): AGENTS.md ! rule for BOM-safe PowerShell file writes~~ -- 2026-04-10 (v0.16.0)
- ~~#266 -- docs(readme): move installer asset links to top near install instructions~~ -- 2026-04-10 (v0.16.0)
- ~~#268 -- docs(readme): wrap install commands in fenced code blocks for GitHub copy button~~ -- 2026-04-10 (v0.16.0)
- ~~#270 -- feat(setup): validate USER.md against current schema + artifact format versioning (deft_version field)~~ -- 2026-04-10 (v0.16.0)
- ~~#51 -- Project bootstrap: purge stale legacy path references across 42 files; add strategy stubs (rapid.md, enterprise.md); add docs/getting-started.md stub~~ -- 2026-04-09 (v0.15.0)
- ~~#221 -- fix(skill): deft-roadmap-refresh explicit row format template + double-pipe anti-pattern~~ -- 2026-04-09 (v0.15.0)
- ~~#226 -- refactor(skills): rename deft-rwldl to deft-pre-pr + AGENTS.md auto-suggestion + keyword routing~~ -- 2026-04-09 (v0.15.0)
- ~~#234 -- docs(readme): add "Your Artifacts" section documenting user-generated artifact locations~~ -- 2026-04-09 (v0.15.0)
- ~~#248 -- fix(skill): roadmap-refresh + swarm Phase 0 spec task scaffolding and transparency note~~ -- 2026-04-09 (v0.15.0)
- ~~#249 -- fix(skill): deft-swarm Phase 6 autonomous Greptile re-review monitoring in rebase cascade -- tiered monitoring step after each force-push~~ -- 2026-04-09 (v0.14.2)
- ~~#250 -- fix(skill): deft-review-cycle batch-fix enforcement -- ! pre-commit gate + 2 anti-patterns against per-finding commits~~ -- 2026-04-09 (v0.14.2)
- ~~#251 -- fix(skill): deft-build + deft-rwldl semantic contradiction check -- ! rules + ⊗ anti-pattern for conflicting rule strengths~~ -- 2026-04-09 (v0.14.2)
- ~~#236 -- fix(docs): Get-Content -Raw UTF-8 footgun + BOM-safe round-trip rules for PS 5.1 -- scm/github.md PS 5.1 section updated with ! rules~~ -- 2026-04-09 (v0.14.1)
- ~~#237 -- chore(docs): migrate ROADMAP.md em-dashes to ASCII -- (317 replacements) -- enables edit_files on Windows without PowerShell fallback~~ -- 2026-04-09 (v0.14.1)
- ~~#238 -- fix(skill): deft-roadmap-refresh batch changelog convention -- one batch entry at session end, anti-pattern added~~ -- 2026-04-09 (v0.14.1)
- ~~#239 -- fix(workflow): mandatory pre-commit file review step -- added to deft-roadmap-refresh Phase 4 pre-flight and deft-build checklist~~ -- 2026-04-09 (v0.14.1)
- ~~#240 -- fix(docs): Warp terminal multi-line PS string temp-file rule -- scm/github.md + meta/lessons.md~~ -- 2026-04-09 (v0.14.1)
- ~~#241 -- fix(docs): main.md blocker carve-out for instant-fix drift rule -- hard blockers in-scope with mandatory issue filing~~ -- 2026-04-09 (v0.14.1)
- ~~#243 -- fix(workflow): skill completion gate -- AGENTS.md rule + deft-roadmap-refresh EXIT block + routing table chaining annotations~~ -- 2026-04-09 (v0.14.1)
- ~~#57 -- GitHub Actions CI workflow -- Python (ruff, mypy, pytest+cov) + Go (test + 3-platform build); pyproject.toml fail_under raised to 85%~~ -- 2026-04-08 (v0.14.0)
- ~~#81 -- BDD/acceptance-test-first strategy -- strategies/bdd.md with 6-step Given/When/Then workflow and chaining gate integration~~ -- 2026-04-08 (v0.14.0)
- ~~#134 -- Deft alignment confirmation rule -- AGENTS.md behavioral rule: confirm Deft Directive active at session start and after context resets~~ -- 2026-04-08 (v0.14.0)
- ~~#146 -- skills/deft-sync/SKILL.md -- session-start framework sync: pre-flight, submodule update, vBRIEF validation, AGENTS.md freshness, new skills listing~~ -- 2026-04-08 (v0.14.0)
- ~~#159 -- meta/philosophy.md -- deterministic > probabilistic design principle: definition, rationale, examples, Phase 5 scope note~~ -- 2026-04-08 (v0.14.0)
- ~~#168 -- deft-roadmap-refresh: ! rule confirming analysis comment post to user with issue number and link~~ -- 2026-04-08 (v0.14.0)
- ~~#174 -- deft-roadmap-refresh: Phase 4 PR & Review Cycle -- user confirmation gate, pre-flight before push, auto-chains to deft-review-cycle~~ -- 2026-04-08 (v0.14.0)
- ~~#195 -- deft-review-cycle: replace blocking polling with tiered start_agent monitoring -- Approach 1 (sub-agent + send_message), Approach 2 (tool-call + yield fallback)~~ -- 2026-04-08 (v0.14.0)
- ~~#196 -- deft-roadmap-refresh: explicit cleanup convention -- remove from phase body, strike in index with date, anti-pattern against duplicates~~ -- 2026-04-08 (v0.14.0)
- ~~#217 -- pyproject.toml dev deps breaks task check in fresh worktrees -- moved to [dependency-groups] (PEP 735), languages/python.md updated, uv.lock regenerated~~ -- 2026-04-07 (v0.13.0)
- ~~#218 -- deft-swarm release decision checkpoint -- Phase 0 version bump proposal + Phase 5->6 confirmation gate before merge cascade~~ -- 2026-04-07 (v0.13.0)
- ~~#207 -- Greptile re-review latency on force-push after rebase -- documented in swarm Phase 6 with time estimates and annotation guidance~~ -- 2026-04-07 (v0.13.0)
- ~~#198 -- main.md instant-fix drift and skill-context bleed rules -- prohibited in Decision Making with companion meta/lessons.md entries~~ -- 2026-04-07 (v0.13.0)
- ~~#200 -- Agent must scan skills/ before improvising multi-step workflows -- ! rule + ⊗ anti-pattern added to AGENTS.md~~ -- 2026-04-07 (v0.13.0)
- ~~#147 -- Skills undiscoverable -- keyword->skill routing table added to AGENTS.md, 3 missing skills added to README~~ -- 2026-04-07 (v0.13.0)
- ~~#219 -- README stale content -- CONTRIBUTING.md, contracts/hierarchy.md, 3 skills added to directory tree and Skills section~~ -- 2026-04-07 (v0.13.0)
- ~~#197 -- scm/github.md -- gh CLI rules, PR conventions, Windows/PS 5.x encoding guidance (absorbs #201)~~ -- 2026-04-07 (v0.13.0)
- ~~#202 -- ASCII convention for machine-editable sections -- Windows/ASCII rules documented in scm/github.md~~ -- 2026-04-07 (v0.13.0)
- ~~#182 -- skills/deft-rwldl/SKILL.md -- iterative pre-PR quality improvement loop (Read-Write-Lint-Diff) with thin pointer~~ -- 2026-04-07 (v0.13.0)
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
- ~~#166 -- Greptile Review status check blocks merge -- .greptile/config.json added with triggerOnUpdates, deft-review-cycle pre-flight check~~ -- 2026-04-06 (closed)
- ~~#189 -- vBRIEF defensive reference-type mitigations -- superseded by #191 (deftai/vBRIEF#2 resolved; mitigations no longer needed)~~ -- 2026-04-06 (closed, superseded)
- ~~#133 -- Generated vBRIEF files use invalid reference types -- upstream deftai/vBRIEF#2 resolved; cleanup tracked in #191~~ -- 2026-04-05 (closed)
- ~~#58 -- Stale cross-references to legacy paths~~ -- 2026-04-06 (closed)
- ~~#185 -- Change gate UX: replace name-echo with yes/no confirmation -- main.md, deft-build, deft-review-cycle, PR template all updated~~ -- 2026-04-05 (v0.11.0)
- ~~#179 -- deft-swarm Option A limitations documented -- Option A demoted, Option B elevated as recommended~~ -- 2026-04-05 (v0.11.0)
- ~~#186 -- AGENTS.md pre-implementation gate enforcement -- ! markers added to Before code changes checklist~~ -- 2026-04-05 (v0.11.0)
- ~~#170 -- Move ROADMAP.md updates from merge-time to release-time -- AGENTS.md convention updated, deft-swarm SKILL.md Phase 6 Step 5 added, ⊗ swarm anti-patterns added~~ -- 2026-04-05 (PR #183, v0.10.3)
- ~~#102 -- Codify Mermaid gist-rendering best practices -- RFC2119 MUST/SHOULD rules + box/end pattern in `languages/mermaid.md`, regression tests added~~ -- 2026-04-05 (PR #176, v0.10.3)
- ~~#144 -- vBRIEF wrong narrative type (object) + wrong child key (`items` vs `subItems`) -- fixed in agent guidance + spec_validate.py (with #126)~~ -- 2026-04-05 (PR #181, v0.10.3)
- ~~#126 -- specification.vbrief.json schema non-conformance -- agent generation guidance, subItems/narrative rules, spec_validate.py hardened, 5 new tests~~ -- 2026-04-05 (PR #181, v0.10.3)
- ~~#175 -- deft-review-cycle: no-push-while-reviewing + 60s poll cadence -- ⊗ rule + ~ guidance + meta/lessons.md #2+#3~~ -- 2026-04-03 (PR #178, v0.10.2)
- ~~#172 -- deft-swarm skill: oz agent run is local, oz agent run-cloud is cloud -- corrected Phase 3, lessons #1+#7, SPECIFICATION.md t2.5.4~~ -- 2026-04-03 (PR #177, v0.10.2)
- ~~#171 -- No direct-to-master agent commits -- ⊗ gate + PROJECT.md trunk-based opt-in, full agentic + CLI parity~~ -- 2026-04-03 (PR #178, v0.10.2)
- ~~#145 -- deft-review-cycle Greptile issue comment as primary review signal~~ -- 2026-04-02 (v0.10.1)
- ~~#142 -- AGENTS.md onboarding gate blocks headless/cloud agents -- headless bypass added~~ -- 2026-04-02 (v0.10.1)
- ~~#139 -- Agent skips vbrief source step -- ⊗ rule added to main.md and deft-build SKILL.md~~ -- 2026-04-02 (v0.10.1)
- ~~#138 -- Branching requirement too prescriptive -- context-aware solo-project qualifier~~ -- 2026-04-02 (v0.10.1)
- ~~#135 -- Greptile review rules SKILL.md in repo~~ -- 2026-03-31 (PR #143, v0.10.0)
- ~~#131 -- Mac installer post-install text~~ -- 2026-04-02 (verified fixed in v0.8.0)
- ~~#123 -- Change lifecycle gate enforcement -- strengthened /deft:change rule~~ -- 2026-04-02 (v0.10.1)
- ~~#118 -- CLI code quality sweep~~ -- 2026-04-02 (v0.10.1)
- ~~#108 -- Ask deployment platform before language~~ -- 2026-04-02 (v0.10.1)
- ~~#107 -- Remove language defaults from USER.md~~ -- 2026-04-02 (v0.10.1)
- ~~#80 -- deft-setup project name fallback~~ -- 2026-04-02 (v0.10.1)
- ~~#79 -- deft-setup inference boundary guards~~ -- 2026-04-02 (v0.10.1)
- ~~#137 -- README: move startup instructions higher, clarify installer location~~ -- 2026-04-02 (v0.10.1)
- ~~#68 -- Testing enforcement gate -- hard gate rule added to main.md~~ -- 2026-04-02 (v0.10.1)
- ~~#59 -- history/changes/ directory created with README.md~~ -- 2026-04-02 (v0.10.0)
- ~~#50 -- Strategies redundant old names -- brownfield.md redirect, default.md deleted~~ -- 2026-04-02 (v0.10.0)
- ~~#49 -- All CLI commands display version on startup~~ -- 2026-04-02 (v0.10.1)
- ~~#31 -- Merge default.md into interview.md~~ -- 2026-04-02 (v0.10.0)
- ~~#25 -- commands.md vBRIEF example fixed~~ -- 2026-04-02 (v0.10.0)
- ~~#24 -- speckit.md See also banner~~ -- 2026-04-02 (v0.10.0)
- ~~#23 -- yolo.md refactored to reference interview.md shared phases~~ -- 2026-04-02 (v0.10.0)
- ~~#104 -- Add Holzmann Power of 10 rules as opt-in coding standard (`coding/holzmann.md`)~~ -- 2026-04-03 (PR #158)
- ~~#124 -- Warp context window improvements: behavioral rule for periodic context checkpointing and structured handoff notes~~ -- closed (completed)
- ~~#67 -- Write SPECIFICATION.md and proper PROJECT.md for the deft project itself~~ -- closed (completed)
- ~~#72 -- vBRIEF files still invalid on master -- five-component generation chain fix (CONVENTIONS.md root cause, validator, renderer, data migration, templates, 7 new tests, minimal CI)~~ -- 2026-03-29 (PR #130)
- ~~#91 -- run bootstrap goes in a loop~~ -- closed (completed)
- ~~#92 -- Strategy selection infinite loop when strategies/ empty~~ -- closed (completed)
- ~~#106 -- Add toolchain/environment validation gate (coding/toolchain.md, deft-build Step 2, strategies/interview.md Acceptance Gate, meta/lessons.md incident entry)~~ -- 2026-03-24 (PR #122)
- ~~#105 -- Add build output validation directive for custom build scripts (`coding/build-output.md`, `coding/testing.md` Build Output Tests, `meta/lessons.md` incident entry)~~ -- 2026-03-24 (PR #121)
- ~~#117 -- Interview command loops in CLI -- `cmd_project` no longer re-runs questionnaire after `cmd_install` chains through `cmd_spec`~~ -- 2026-03-24 (Unreleased)
- ~~#94 -- Agent auto-alignment on startup: thin skill pointer + change lifecycle rule~~ -- 2026-03-22 (PR #109)
- ~~#54 -- AGENTS.md provides no actionable onboarding~~ -- 2026-03-20 (PR #93: actionable AGENTS.md, honest installer output, README fixes; absorbed #85)
- ~~#45 -- Bootstrap parity~~ -- 2026-03-19 (PR #83: CLI and agentic paths produce consistent output, released as v0.7.0)
- ~~#39 -- Strategy chaining options before spec generation~~ -- 2026-03-16 (bidirectional orchestration, chaining gate, acceptance gate)
- ~~#71 -- CHANGELOG catch-up~~ -- 2026-03-18 (PR #73: backfilled post-0.6.0 entries, updated release links to `deftai/directive` for v0.2.2+, preserved historical `visionik` links for older versions)
- ~~#63 -- Installer hardcodes old repo URL~~ -- 2026-03-17 (PR #64: all `visionik/deft` → `deftai/directive`)
- ~~#69 -- Remove stale beta branch and update docs~~ -- 2026-03-17 (trunk-based workflow, beta branch deleted)
- ~~#34 -- Zero-prerequisite installer~~ -- 2026-03-17 (merged via PR #42, released as v0.5.0)
- ~~#10 -- AGENTS.md setup improvement in docs~~ -- 2026-03-17 (PR #66: added manual-clone wiring note in Getting Started)
- ~~#51 -- Project bootstrap (partial)~~ -- 2026-03-17 (PR #66: AGENTS.md added, old/ removed, project config cleaned; remaining work in #67)
- ~~#60 -- pressEnterToExit() Windows-only~~ -- 2026-03-17 (PR #66: runtime.GOOS guard)
- ~~#62 -- beta branch 50+ unmerged commits~~ -- 2026-03-17 (already merged via PR #42)
- ~~#47 -- PROJECT.md defaults + input validation~~ -- 2026-03-17 (PR #66: all items addressed)
- ~~#44 -- CLI bootstrap overwrites USER.md + input validation~~ -- 2026-03-17 (PR #66: items 1-4 done; item 5 split to #65, absorbed into #45 -- all resolved)
- ~~#8 -- Don't commit until questionnaires finished~~ -- 2026-03-17 (PR #66: Ctrl+C resume protection)
- ~~#7 -- Double prompting for languages during bootstrap~~ -- 2026-03-16 (PR #43: `cmd_project` reads USER.md defaults)
- ~~#32 -- Strategy selection doesn't work~~ -- 2026-03-16 (fixed on beta: `cmd_spec` now reads strategy from PROJECT.md)
- ~~Single entry point Go installer~~ -- 2026-03-12 (5-platform binaries, GitHub Actions release workflow)
- ~~Agent-driven skills (deft-setup + deft-build)~~ -- 2026-03-12
- ~~Enforce USER.md gate (skills path)~~ -- 2026-03-12
- ~~#28 -- vBRIEF schema reference + fix non-conforming status values~~ -- 2026-03-11
- ~~#21 -- Testbed regression testing suite~~ -- 2026-03-11 (568 passed, 24 xfailed)
- ~~Convert to TDD mode~~ -- 2026-03-11
- ~~Land PR #26 on master~~ -- 2026-03-11
- ~~Merge master → beta~~ -- 2026-03-11
- ~~v0.6.0 content (PRs #16–20)~~ -- 2026-03-11
- ~~Reopen PR #22 and merge testbed to master~~ -- Merged 2026-03-11
- ~~Add `strategies/discuss.md` to README table~~ -- Done in PR #16
- ~~v0.6.0 CHANGELOG entry~~ -- Done in PR #20
- ~~#6 -- Programming languages asked too early / limited options~~ -- closed
- ~~#5 -- SDD should focus on intent first~~ -- closed
- ~~#4 -- Make /deft read-only (project-local layout)~~ -- closed
- ~~#3 -- Add run.bat for Windows~~ -- closed (superseded by Go installer)
- ~~#2 -- CLI output cleanup~~ -- closed

---

## Open Issues Index

| Issue | Title | Phase |
|-------|-------|-------|
| #9 | Issue tracking system integration | 6 |
| #11 | NPM + PIP CLI distribution | 5 |
| #12 | Deft Bootstrap CLI with TUI | 6 |
| ~~#23~~ | ~~yolo.md duplicates interview.md~~ | completed -- v0.10.0 |
| ~~#24~~ | ~~speckit.md missing See also banner~~ | completed -- v0.10.0 |
| ~~#25~~ | ~~commands.md vBRIEF example diverges~~ | completed -- v0.10.0 |
| ~~#31~~ | ~~Merge default.md into interview.md~~ | completed -- v0.10.0 |
| #33 | Docker smoke/e2e tests | 4 |
| #46 | Provide way to update meta MD files | 6 |
| ~~#49~~ | ~~All CLI commands should display version~~ | completed -- v0.10.1 |
| ~~#50~~ | ~~Strategies still have redundant old names~~ | completed -- v0.10.0 |
| ~~#51~~ | ~~Project bootstrap: stale refs purge, strategy stubs, getting-started stub~~ | completed -- v0.15.0 |
| #52 | Install into .deft/ hidden directory | 6 |
| #53 | deft-install should bootstrap current directory | 5 |
| ~~#91~~ | ~~run bootstrap goes in a loop~~ | completed |
| ~~#92~~ | ~~Strategy selection infinite loop when strategies/ empty~~ | completed |
| ~~#94~~ | ~~Agent auto-alignment on startup: thin skill pointer + change lifecycle rule~~ | completed -- PR #109 |
| ~~#54~~ | ~~AGENTS.md provides no actionable onboarding (absorbed #85)~~ | completed -- PR #93 |
| #55 | Register Deft commands as native agent slash commands (absorbs slash-command scope from #54) | 6 |
| #56 | Reduce installation friction (shell one-liner, Homebrew) | 5 |
| ~~#57~~ | ~~Add GitHub Actions CI workflow~~ | completed -- v0.14.0 |
| #128 | CI vBRIEF schema sync check (depends on #57) | 4 |
| #163 | Enforce USER.md gate in CLI path -- parity with agentic (skills) path | 4 |
| ~~#58~~ | ~~Stale cross-references to legacy paths~~ | closed 2026-04-06 |
| ~~#59~~ | ~~history/changes/ directory missing~~ | completed -- v0.10.0 |
| ~~#67~~ | ~~Write SPECIFICATION.md and proper PROJECT.md for deft~~ | completed |
| ~~#68~~ | ~~Warp not always enforcing Deft testing protocols~~ | completed -- v0.10.1 |
| ~~#72~~ | ~~vBRIEF files still invalid on master~~ | completed -- PR #130 |
| #74 | Automate release process and CI changelog enforcement | 4 |
| #75 | Skill auto-discovery for deft skills | 5 |
| #76 | Obsidian Vault generation as structured agent memory | 6 |
| #77 | Allow users to change technical rating per project | 6 |
| #78 | Bootstrap: offer to update user preferences | 6 |
| ~~#79~~ | ~~deft-setup inference bleeds into ./deft/ internals~~ | completed -- v0.10.1 |
| ~~#80~~ | ~~deft-setup project name inference no fallback~~ | completed -- v0.10.1 |
| ~~#81~~ | ~~Add BDD/acceptance-test-first strategy~~ | completed -- v0.14.0 |
| #82 | Replacement strategies need accept-or-scrap exit | 3 |
| ~~#84~~ | ~~Deft as teacher Phase 1: contract hierarchy, adaptive teaching, State WHY~~ | completed -- v0.12.1 |
| ~~#85~~ | ~~Installer instructions inaccurate/unclear~~ | closed -- absorbed by #54 |
| #95 | Compliance templates + readiness scanners (SOC 2, ISO 27001, HIPAA; sub-issues #96-#100) | 6 |
| #86 | Artifact-branch binding and complete audit trail for SDD | 6 |
| #89 | Deft identity and positioning: resolve naming before README reframe | 3 |
| ~~#101~~ | ~~Should manual clone path exist?~~ | closed -- absorbed by #56 |
| ~~#102~~ | ~~Codify Mermaid gist-rendering best practices~~ | completed -- v0.10.3 |
| #103 | Standalone brownfield/map analysis without requiring interview | 3 |
| ~~#104~~ | ~~Holzmann Power of 10 rules (`coding/holzmann.md`)~~ | completed -- PR #158 |
| ~~#105~~ | ~~Build output validation directive for custom build scripts~~ | completed -- PR #121 |
| ~~#106~~ | ~~Toolchain/environment validation gate before implementation~~ | completed -- PR #122 |
| ~~#107~~ | ~~Remove language defaults from USER.md~~ | completed -- v0.10.1 |
| ~~#108~~ | ~~Ask deployment platform before language~~ | completed -- v0.10.1 |
| #96 | [Compliance] Config schema + compliance-aware constitution templates | 6 |
| #97 | [Compliance] Framework control mapping registry | 6 |
| #98 | [Compliance] Readiness scanner -- control design scoring | 6 |
| #99 | [Compliance] Readiness scanner -- operating effectiveness + evidence gap analysis | 6 |
| #100 | [Compliance] Evidence collection automation hooks | 6 |
| #112 | External instruction guide (DEFT Directive PDF) is premature relative to current state | 3 |
| #114 | Document all global Warp rules used for deft directive development | 3 |
| #115 | Strengthen spec validation gate and rendered artifact freshness | 4 |
| ~~#116~~ | ~~All files must be installed consistently under `./deft/`~~ | completed -- v0.12.1 |
| ~~#123~~ | ~~Change lifecycle gate skipped on broad 'proceed' instruction~~ | completed -- v0.10.1 |
| ~~#118~~ | ~~CLI code quality sweep (version mismatch, bare except, undocumented flags, env var naming)~~ | completed -- v0.10.1 |
| ~~#124~~ | ~~Warp context window improvements (behavioral rule + handoff notes)~~ | completed |
| ~~#126~~ | ~~specification.vbrief.json does not conform to vbrief schema/spec~~ | completed -- v0.10.3 |
| ~~#144~~ | ~~Directive giving invalid vBRIEF files & wrong key names (address with #126)~~ | completed -- v0.10.3 |
| #127 | Improved support for Deft in existing repositories (brownfield bootstrap path; related #103, #53) | 3 |
| ~~#131~~ | ~~Mac installer post-install text wording fix~~ | completed -- v0.10.1 |
| ~~#133~~ | ~~Generated vBRIEF files use invalid reference types~~ | closed 2026-04-05 |
| ~~#134~~ | ~~Visual indicator that Deft is active (behavioral rule; true UI deferred Phase 5)~~ | completed -- v0.14.0 |
| ~~#135~~ | ~~Greptile review rules SKILL.md in repo~~ | completed -- PR #143 |
| #136 | Warp doesn't auto-load AGENTS.md -- document workaround (with #114) | 3 |
| ~~#137~~ | ~~README: move startup instructions higher, clarify installer location~~ | completed -- v0.10.1 |
| ~~#138~~ | ~~Branching requirement too prescriptive for solo projects~~ | completed -- v0.10.1 |
| ~~#139~~ | ~~Agent skips vbrief source step, writes SPECIFICATION.md directly~~ | completed -- v0.10.1 |
| #140 | Automatically check for updates to cloned repos in a project (deft doctor/update) | 6 |
| ~~#142~~ | ~~AGENTS.md onboarding gate blocks headless/cloud agents~~ | completed -- v0.10.1 |
| ~~#145~~ | ~~deft-review-cycle: Greptile issue comment not primary review signal (false wait loops)~~ | completed -- v0.10.1 |
| ~~#172~~ | ~~deft-swarm skill: oz agent run correction (Phase 3, lessons, SPECIFICATION.md)~~ | completed -- v0.10.2 |
| ~~#166~~ | ~~Greptile Review status check blocks merge~~ | closed |
| ~~#192~~ | ~~Proactively add test coverage after review-fix commits before CI re-run~~ | completed -- v0.12.0 |
| ~~#191~~ | ~~Remove defensive vBRIEF reference-type workarounds -- deftai/vBRIEF#2 resolved~~ | completed -- v0.12.0 |
| ~~#184~~ | ~~deft-review-cycle: add autonomous polling imperative after push~~ | completed -- v0.12.0 |
| ~~#167~~ | ~~PRs merged but issues not closed and roadmap not updated~~ | completed -- v0.12.1 |
| ~~#171~~ | ~~No direct-to-master agent commits -- ⊗ gate + PROJECT.md opt-in~~ | completed -- v0.10.2 |
| ~~#175~~ | ~~deft-review-cycle: no-push-while-reviewing + 60s poll cadence~~ | completed -- v0.10.2 |
| #151 | [Playtest Feedback] First-time non-technical user session report (umbrella) | 3 |
| ~~#159~~ | ~~Deterministic > Probabilistic -- design principle documentation~~ | completed -- v0.14.0 |
| #160 | Consider TypeScript instead of Python for run CLI | 6 |
| ~~#168~~ | ~~deft-roadmap-refresh skill: confirm analysis comment posting to user~~ | completed -- v0.14.0 |
| ~~#174~~ | ~~deft-roadmap-refresh skill: add review cycle step after PR push~~ | completed -- v0.14.0 |
| ~~#146~~ | ~~Add skills/deft-sync/SKILL.md -- session-start framework sync skill~~ | completed -- v0.14.0 |
| ~~#147~~ | ~~Skills undiscoverable -- no keyword routing in AGENTS.md, 3 skills missing from README~~ | completed -- v0.13.0 |
| ~~#188~~ | ~~Update deft-swarm: runtime start_agent capability detection + Warp environment gate~~ | completed -- v0.12.0 |
| ~~#199~~ | ~~deft-swarm skill: add mandatory analyze phase with user approval gate before launch~~ | completed -- v0.12.0 |
| #194 | User-facing best practices guide -- Directive usage, Warp swarming, skill documentation | 3 |
| ~~#195~~ | ~~Replace blocking Start-Sleep polling with multi-agent orchestration in review monitor~~ | completed -- v0.14.0 |
| ~~#196~~ | ~~deft-roadmap-refresh skill: clarify cleanup convention -- remove from phase body, not strike through~~ | completed -- v0.14.0 |
| ~~#197~~ | ~~Create scm/github.md -- gh CLI rules, PR workflow conventions, Windows encoding guidance (absorbs #201)~~ | completed -- v0.13.0 |
| ~~#198~~ | ~~main.md: rules against instant-fix drift and skill-context bleed~~ | completed -- v0.13.0 |
| ~~#200~~ | ~~Agent must scan skills/ before improvising multi-step workflows~~ | completed -- v0.13.0 |
| ~~#201~~ | ~~scm/github.md: add --body-file convention~~ | closed -- absorbed by #197 |
| ~~#202~~ | ~~Convention: prefer ASCII in machine-editable structured sections~~ | completed -- v0.13.0 |
| ~~#207~~ | ~~Greptile re-review latency on force-push after rebase during swarm merge cascade~~ | completed -- v0.13.0 |
| #212 | discussion: Process control belongs in Directive (DO NOT IMPLEMENT -- discussion only) | 6 |
| ~~#218~~ | ~~deft-swarm: add explicit release decision checkpoint to Phase 0 and Phase 6~~ | completed -- v0.13.0 |
| ~~#219~~ | ~~README.md stale: missing CONTRIBUTING.md, 3 skills, contracts/hierarchy.md, stale directory tree~~ | completed -- v0.13.0 |
| ~~#217~~ | ~~pyproject.toml dev deps breaks task check in fresh worktrees~~ | completed -- v0.13.0 |
| ~~#182~~ | ~~Add skills/deft-rwldl/SKILL.md -- iterative pre-PR quality improvement loop~~ | completed -- v0.13.0 |
| ~~#170~~ | ~~Move ROADMAP.md updates from merge-time to release-time~~ | completed -- v0.10.3 |
| ~~#221~~ | ~~deft-roadmap-refresh: explicit row format template + double-pipe anti-pattern~~ | completed -- v0.15.0 |
| ~~#226~~ | ~~refactor: rename deft-rwldl to deft-pre-pr + auto-suggestion + keyword routing~~ | completed -- v0.15.0 |
| #233 | More Determinism: full deterministic task initiative (Phase 0, tasks/ restructure, doctor, etc.) | 6 |
| ~~#234~~ | ~~docs: README Your Artifacts section~~ | completed -- v0.15.0 |
| ~~#235~~ | ~~feat(tasks): toolchain:check + changelog:check as task check deps (split from #233)~~ | completed -- v0.17.0 |
| ~~#236~~ | ~~fix(docs): Get-Content -Raw UTF-8 footgun + BOM-safe round-trip pattern for PS 5.1~~ | completed -- v0.14.1 |
| ~~#237~~ | ~~chore(docs): migrate ROADMAP.md existing em-dashes to ASCII -- to enable edit_files on Windows~~ | completed -- v0.14.1 |
| ~~#238~~ | ~~fix(skill): deft-roadmap-refresh batch changelog line at session end, not per-issue~~ | completed -- v0.14.1 |
| ~~#239~~ | ~~fix(workflow): mandatory pre-commit file review step -- encoding, duplication, structural checks before PR~~ | completed -- v0.14.1 |
| ~~#240~~ | ~~fix(docs): multi-line PS string literal Warp block splitting -- use temp file rule + lessons.md~~ | completed -- v0.14.1 |
| ~~#241~~ | ~~fix(docs): main.md instant-fix drift rule -- add blocker carve-out with mandatory issue filing~~ | completed -- v0.14.1 |
| ~~#243~~ | ~~fix(workflow): skill completion gate -- prevent missing chaining instructions at skill exit~~ | completed -- v0.14.1 |
| ~~#249~~ | ~~deft-swarm Phase 6: missing autonomous Greptile re-review monitoring in rebase cascade~~ | completed -- v0.14.2 |
| ~~#250~~ | ~~deft-review-cycle: strengthen batch-fix enforcement -- anti-pattern against per-finding commits~~ | completed -- v0.14.2 |
| ~~#251~~ | ~~deft-build + deft-rwldl: semantic contradiction check when adding ! or ⊗ rules~~ | completed -- v0.14.2 |
| #228 | Bring run CLI into test coverage measurement (confirm #160 before implementing) | 4 |
| ~~#248~~ | ~~roadmap-refresh + swarm Phase 0 spec task scaffolding~~ | completed -- v0.15.0 |
| #258 | docs(warp): inventory Warp Drive global rules used for deft directive development | 3 |
| ~~#256~~ | ~~fix(docs): use OS temp directory for --body-file to avoid rm denylist collision~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#261~~ | ~~bug(swarm): monitor skips Phase 5 and slam-merges untested code into main~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#263~~ | ~~chore(swarm): monitor crash during multi-PR merge -- add checkpoint/recovery resilience~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#266~~ | ~~docs(readme): move installer asset links to top near install instructions~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#268~~ | ~~docs(readme): wrap install commands in fenced code blocks for copy button~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#269~~ | ~~deft-setup: Warp auto-approve silently self-answers interview -- post-interview confirmation gate~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#270~~ | ~~feat(setup): validate USER.md against current schema + artifact format versioning~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#272~~ | ~~deft-setup: agent conflates framework directory with project root during bootstrap~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#274~~ | ~~fix(workflow): add semantic accuracy check to mandatory pre-commit file review~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#279~~ | ~~fix(skill): deft-review-cycle Approach 2 idle stoppage -- yield ends turn, polling loop broken for swarm agents~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#281~~ | ~~fix(test): WinError 448 -- pytest-current symlink cleanup fails on Windows 11 24H2+~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#282~~ | ~~fix(skill): deft-review-cycle -- MCP capability detection + task check pre-existing failure carve-out~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#283~~ | ~~fix(agents): add ! rule to AGENTS.md for BOM-safe PowerShell file writes~~ | completed -- 2026-04-10 (v0.16.0) |
| ~~#288~~ | ~~fix(skill): deft-swarm Phase 6 -- read-back verification after rebase conflict resolution~~ | completed -- v0.18.0 |
| ~~#292~~ | ~~feat(swarm): auto-generate Slack release announcement after swarm release~~ | completed -- v0.18.0 |
| ~~#293~~ | ~~test: add unit tests for v0.17.0 deterministic task scripts~~ | completed -- 2026-04-13 |
| ~~#294~~ | ~~fix(enforcement): strengthen test-with-code rule -- new source files must include tests~~ | completed -- v0.18.0 |
| ~~#295~~ | ~~chore: resolve 5 untracked xfail gaps in known_failures.json~~ | completed -- v0.18.0 |
| ~~#296~~ | ~~Create skills/deft-interview/SKILL.md -- deterministic structured Q&A interview skill~~ | completed -- v0.18.0 |
| #309 | RFC: vBRIEF-centric document model for Deft Directive | 2 |
| #310 | Story A: Update vbrief.md with new vBRIEF-centric document model | 2 |
| #311 | Story B: Roadmap generation tool (task roadmap:render) + drift detection | 2 |
| #312 | Story C: Migration script (task migrate:vbrief) | 2 |
| #313 | Story D: Core doc updates (main.md, AGENTS.md) for vBRIEF-centric model | 2 |
| #314 | Story E: deft-directive-setup (rename + rewrite) | 2 |
| #315 | Story F: deft-directive-build, review-cycle, pre-pr (rename + update) | 2 |
| #316 | Story G: deft-directive-refinement (rename + rewrite from roadmap-refresh) | 2 |
| #317 | Story H: deft-directive-swarm (rename + flexible allocation) | 2 |
| #318 | Story I: deft-directive-sync (rename + validate new structure) | 2 |
| #319 | Story J: deft-directive-interview (namespace rename) | 2 |
| #320 | Story K: CLI updates (cmd_spec, cmd_project) for vBRIEF model | 2 |
| #321 | Story L: Test coverage for vBRIEF-centric document model | 2 |
| #322 | Story M: Post-cutover GitHub issue reconciliation | 2 |
| #323 | Story N: PROJECT-DEFINITION regeneration tool (task project:render) | 2 |
| #324 | Story O: Scope lifecycle task commands (task scope:*) | 2 |
| #331 | Story P: Ancillary doc updates for vBRIEF-centric model | 2 |
| #332 | Story Q: Go installer rewrite for deft-directive-* namespace | 2 |
| #333 | Story R: Validation tooling for vBRIEF-centric model | 2 |
| #334 | Story S: Pre-cutover detection and backward compatibility guard | 2 |
| #335 | Story T: Release and version boundary items (v0.20.0) | 2 |
| ~~#305~~ | ~~perf(review-cycle): Greptile review cycle bottlenecks -- 5-change optimization bundle~~ | completed -- v0.19.0 |
| ~~#307~~ | ~~fix(skill): deft-review-cycle Approach 2 capability detection gap -- no start_agent + no sleep fallback~~ | completed -- v0.19.0 |
| ~~#298~~ | ~~chore(spec): flip 5 stale [pending] statuses to [completed] in SPECIFICATION.md~~ | completed -- 2026-04-13 |
| ~~#301~~ | ~~fix(agents): tighten deft-interview routing keyword~~ | completed -- v0.19.0 |
| ~~#302~~ | ~~fix(skill): deft-interview invocation contract -- clarify embedded vs delegation usage modes~~ | completed -- v0.19.0 |
| ~~#303~~ | ~~fix(skill): deft-interview Rule 5 vs Rule 6 inconsistency -- 'ok' accepted for default but not confirmation gate~~ | completed -- v0.19.0 |
| ~~#304~~ | ~~test(skill): add regression test for deft-setup Phase 1/2 referencing deft-interview~~ | completed -- v0.19.0 |
| ~~#328~~ | ~~docs(deft-review-cycle): add Select-String fallback for oversized gh pr view output~~ | completed -- v0.19.0 |

---

*Created 2026-03-13
*Updated 2026-03-17 -- added issues #44-#65, moved #8/#44/#47 to Completed*
*Updated 2026-03-19 -- added #84 (Deft as teacher: contract hierarchy, Phase 2 Philosophy & Positioning sub-section, Phase 5 teach strategy); moved #45 to Completed (v0.7.0)*
*Updated 2026-03-20 -- added #89 (naming/positioning); moved #39 to Completed; full refresh: added #68/#72/#75-#82/#85/#86; promoted user-reported bugs to Phase 1; resolved #44 (all items done); cleaned stale entries from index; #84 Phase 2 README reframe blocked on #89 resolution*
*Updated 2026-03-20 -- promoted #54 to Phase 1 (absorbed #85); #54 scope narrowed (slash-command registration moved to #55); #75 gains depends-on-#54 note; #85 closed as duplicate*
*Updated 2026-03-20 -- added #94 to Phase 1 (thin skill pointer + change lifecycle rule; prerequisite for all deft behavior improvements)*
*Updated 2026-03-20 -- added #91/#92 (bootstrap loop) to Phase 1; added #95 compliance cluster to Phase 5 (#96–#100 sub-issues)*
*Updated 2026-03-22 -- triaged #101–#108: #101 absorbed into #56 (install path decision); #102 (Mermaid rules), #103 (standalone map), #104 (Holzmann rules) added to Phase 2; #105/#106 (build output + toolchain validation), #107/#108 (remove language from USER.md + platform-driven language shortlist) added to Phase 1*
*Updated 2026-03-24 -- moved #54/#94 to Completed (PRs #93/#109); added #112/#114 to Phase 2, #115 to Phase 3, #116/#117/#118 to Phase 1; indexed #96–#100 (compliance sub-issues individually); removed incorrect Node.js 24 deadline note*
*Updated 2026-03-24 -- moved #117 to Completed (CLI command chaining loop fixed, Unreleased)*
*Updated 2026-03-24 -- moved #105 to Completed (PR #121)*
*Updated 2026-03-24 -- moved #106 to Completed (PR #122); added #123 to Phase 1 Cleanup*
*Updated 2026-03-29 -- added #128 (CI vBRIEF schema sync check, depends on #57) to Phase 3*
*Updated 2026-03-29 -- moved #72 to Completed (PR #130); updated #57 (minimal CI landed) and #115 (schema checks landed) descriptions*
*Updated 2026-03-31 -- roadmap refresh pass: added #124, #126, #127, #131, #133–#140; moved #67, #91, #92 to Completed; cleaned stale index entries; filed upstream deftai/vBRIEF#2 for #133*
*Updated 2026-03-31 -- roadmap refresh: added #142 to Phase 1 Adoption Blockers; moved #124 to completed; updated #134 description (no longer grouped with #124); improved deft-roadmap-refresh skill with Phase 0 branch/worktree setup*
*Updated 2026-04-02 -- roadmap refresh: added #144 to Phase 1 (vBRIEF wrong narrative type + items/subItems bug, address with #126); fixed stray pipes in index*
*Updated 2026-04-02 -- roadmap refresh: added #145 to Phase 1 Adoption Blockers (deft-review-cycle Greptile signal bug, split from #135)*
*Updated 2026-04-02 -- roadmap refresh: added #146 to Phase 2 (deft-sync skill, session-start framework sync); added #147 to Phase 2 (skills undocumented in README/AGENTS.md)*
*Updated 2026-04-02 -- note: #143 is a merged PR (feat: add deft-review-cycle skill, PR #143), not an open issue; correctly absent from triage*
*Updated 2026-04-02 -- added #163 to Phase 3 (Enforce USER.md gate in CLI path -- parity with agentic skills path)*
*Updated 2026-04-03 -- stale entry cleanup: moved 21 closed issues (#23, #24, #25, #31, #49, #50, #59, #68, #79, #80, #107, #108, #118, #123, #131, #135, #137, #138, #139, #142, #145) from Phase 1/2 body to Completed section; struck through in Open Issues Index; closed #104, #137, #145 on GitHub*
*Updated 2026-04-03 -- roadmap refresh triage: added #166 (Greptile re-review, Phase 1), #167 (PR merge hygiene, Phase 1), #151 (playtest feedback umbrella, Phase 2), #159 (deterministic principle, Phase 2), #160 (TypeScript CLI, Phase 5), #168 (skill transparency, Phase 2)*
*Updated 2026-04-03 -- roadmap refresh triage: added #170 (ROADMAP update timing, Phase 2)*
*Updated 2026-04-03 -- roadmap refresh triage: added #171 (no direct-to-master agent commits, Phase 1 Cleanup)*
*Updated 2026-04-03 -- roadmap refresh triage: added #172 (deft-swarm oz agent run correction, Phase 1 Adoption Blockers, priority next)*
*Updated 2026-04-03 -- filed and triaged #175 (deft-review-cycle no-push-during-review gate, Phase 1 Cleanup)*
*Updated 2026-04-03 -- filed and triaged #174 (deft-roadmap-refresh review cycle chaining, Phase 2)*
*Updated 2026-04-03 -- v0.10.2 release: moved #171, #172, #175 to Completed*
*Updated 2026-04-05 -- v0.10.3 release: moved #126, #144 (vBRIEF conformance), #102 (Mermaid guidance), #170 (ROADMAP update convention) to Completed; cleaned #171/#175 from Phase 1 Cleanup body (already completed in v0.10.2)*
*Updated 2026-04-06 -- roadmap refresh triage: added #192 to Phase 1 Adoption Blockers (proactive test coverage after review-fix commits)*
*Updated 2026-04-06 -- roadmap refresh triage: added #191 to Phase 1 Adoption Blockers (remove vBRIEF defensive workarounds, deftai/vBRIEF#2 resolved)*
*Updated 2026-04-06 -- roadmap refresh triage: added #188 to Phase 2 (deft-swarm runtime capability detection + Warp environment gate; issue reshaped from static Option D to tool-presence-based detection)*
*Updated 2026-04-06 -- roadmap refresh triage: added #184 to Phase 1 Adoption Blockers (deft-review-cycle autonomous polling imperative)*
*Updated 2026-04-06 -- roadmap refresh cleanup: moved #133 (closed 2026-04-05) and #58 (closed 2026-04-06) to Completed; struck through in phase bodies and index*
*Updated 2026-04-06 -- closed #189 on GitHub as superseded by #191 (vBRIEF defensive mitigations no longer needed now that deftai/vBRIEF#2 is resolved)*
*Updated 2026-04-06 -- roadmap refresh triage: added #182 to Phase 2 (deft-rwldl skill: iterative pre-PR quality loop)*
*Updated 2026-04-06 -- roadmap refresh: triaged #194 (Phase 2), #195 (Phase 2), #196 (Phase 2), #197 (Phase 2, absorbs #201), #198 (Phase 1), #199 (Phase 1), #200 (Phase 1); promoted #188 Phase 2→Phase 1; closed #201 (absorbed by #197); moved #166 to Completed; updated #147 title/body for expanded scope; added #202 (ASCII convention for machine-editable sections, Phase 2)*
*Updated 2026-04-06 -- v0.12.1 release: moved #116 (installer path consistency), #167 (PR merge hygiene), #84 Phase 1 (Deft as teacher Phase 1 complete) to Completed; added CONTRIBUTING.md (t2.3.1)*
*Updated 2026-04-07 -- roadmap refresh triage: added #217 to Phase 1 Adoption Blockers (pyproject.toml dev deps breaks task check in fresh worktrees; swarm adoption blocker), #218 to Phase 1 Adoption Blockers (swarm release decision checkpoint), #207 to Phase 2 (Greptile re-review latency on swarm merge cascade), #219 to Phase 2 (README.md stale content), #212 to Phase 5 (process control in Directive -- discussion only); cleanup: struck through #184/#188/#191/#192/#199 in index (completed v0.12.0), removed duplicate bare #198, added #182 description*
*Updated 2026-04-08 -- v0.14.0 release: moved #57 (CI workflow), #81 (BDD strategy), #134 (alignment confirmation), #146 (deft-sync skill), #159 (philosophy.md), #168 (roadmap-refresh transparency), #174 (roadmap-refresh PR phase), #195 (review-cycle tiered polling), #196 (roadmap-refresh cleanup convention) to Completed; removed from phase bodies; struck through in Open Issues Index*
*Updated 2026-04-09 -- roadmap refresh triage: added #221, #226, #234 to Phase 2; #235 to Phase 3; #233 to Phase 5 (More Determinism); filed #235 as split-off from #233; filed #236/#237/#238/#239 to Phase 1 (#236: Get-Content -Raw footgun; #237: ROADMAP.md em-dash migration; #238: roadmap-refresh batch changelog; #239: mandatory pre-commit file review; #240: multi-line PS string Warp block splitting; #241: main.md blocker carve-out for instant-fix rule; #243: skill completion gate for chaining instructions); analysis comments posted*
*Updated 2026-04-09 -- v0.14.1 release: moved #236, #237, #238, #239, #240, #241, #243 (Phase 1 Cleanup) to Completed; filed #249 (swarm Phase 6 rebase monitoring gap), #250 (review-cycle batch-fix enforcement), #251 (deft-build semantic contradiction check) to Phase 1 Cleanup from swarm lessons learned*
*Updated 2026-04-09 -- roadmap refresh triage: added #228 (run CLI test coverage, Phase 3 -- confirm #160 before implementing), #248 (spec task coverage gap in roadmap refresh, Phase 2 -- strengthen swarm Phase 0); analysis comments posted*
*Updated 2026-04-09 -- v0.14.2 release: moved #249 (swarm rebase monitoring), #250 (batch-fix enforcement), #251 (semantic contradiction check) to Completed; Phase 1 Cleanup now empty*
*Updated 2026-04-09 -- v0.15.0 release: moved #51 (stale refs purge + strategy stubs + getting-started), #221 (row format template), #226 (deft-rwldl rename), #234 (README artifacts), #248 (spec task scaffolding) to Completed; struck through in Open Issues Index; removed from Phase 2 body*
*Updated 2026-04-09 -- roadmap refresh triage: added #261 + #263 (Phase 1, t1.13.1), #256 (Phase 1, t1.13.2), #258 (Phase 2, t2.9.1); analysis comments posted on all 4 issues*
*Updated 2026-04-09 -- roadmap refresh triage: added #266 (Phase 2, t2.10.1), #268 (Phase 2, t2.10.2), #270 (Phase 3, t3.2.1); analysis comments posted*
*Updated 2026-04-10 -- roadmap refresh triage: added #279 (Phase 1 Adoption Blocker, t1.14.1); analysis comment posted*
*Updated 2026-04-10 -- roadmap refresh triage: added #274 (Phase 1 Cleanup, t1.15.1); analysis comment posted*
*Updated 2026-04-10 -- roadmap refresh triage: added #272 (Phase 1 Adoption Blocker, t1.16.1); analysis comment posted*
*Updated 2026-04-10 -- roadmap refresh triage: added #269 (Phase 1 Adoption Blocker, t1.17.1); analysis comment posted*
*Updated 2026-04-10 -- filed and triaged #281 (Phase 1 Cleanup, t1.18.1): WinError 448 pytest-current symlink cleanup on Windows 11 24H2+*
*Updated 2026-04-10 -- filed and triaged #282 (Phase 1 Cleanup, t1.19.1): deft-review-cycle MCP capability detection + task check carve-out*
*Updated 2026-04-10 -- filed and triaged #283 (Phase 1 Cleanup, t1.20.1): AGENTS.md ! rule for BOM-safe PowerShell file writes*
*Updated 2026-04-10 -- v0.16.0 release: moved #256, #261, #263, #269, #272, #279 (Phase 1 Adoption Blockers), #274, #281, #282, #283 (Phase 1 Cleanup), #266, #268 (Phase 2), #270 (Phase 3) to Completed; struck through in Open Issues Index; Phase 1 Adoption Blockers and Cleanup sections now empty*
*Updated 2026-04-10 -- v0.17.0 release: #235 closed (toolchain:check + changelog:check as check deps); #233 partial progress (tasks/ restructure + 7 new deterministic tasks); removed #235 from Phase 3 body; updated #233 in Phase 5; struck through #235 in Open Issues Index*
*Updated 2026-04-10 -- roadmap refresh triage: added #288 (Phase 1 Cleanup, t1.21.1): deft-swarm Phase 6 read-back verification after rebase conflict resolution; analysis comment posted*
*Updated 2026-04-10 -- roadmap refresh triage: added #292 (Phase 1 Cleanup, t1.22.1): deft-swarm Phase 6 auto-generate Slack release announcement; analysis comment posted*
*Updated 2026-04-10 -- roadmap refresh triage: added #293 (Phase 3, t3.3.4): unit tests for v0.17.0 deterministic task scripts; analysis comment posted*
*Updated 2026-04-10 -- roadmap refresh triage: added #294 (Phase 1 Cleanup, t1.23.1): strengthen test-with-code rule across AGENTS.md, main.md, deft-swarm, deft-build; analysis comment posted*
*Updated 2026-04-10 -- roadmap refresh triage: added #295 (Phase 1 Cleanup, t1.24.1): resolve 5 untracked xfail gaps in known_failures.json; analysis comment posted*
*Updated 2026-04-10 -- roadmap refresh triage: added #296 (Phase 2, t2.11.1): skills/deft-interview/SKILL.md -- deterministic structured Q&A interview skill; analysis comment posted*
*Updated 2026-04-10 -- v0.18.0 release: moved #288, #292, #294, #295 (Phase 1 Cleanup), #296 (Phase 2) to Completed; struck through in Open Issues Index; Phase 1 Cleanup now empty*
*Updated 2026-04-12 -- roadmap refresh triage: added #298 (Phase 1 Cleanup, t1.25.1): flip 5 stale [pending] spec task statuses to [completed] in SPECIFICATION.md (t1.14.1, t1.15.1, t1.18.1, t1.19.1, t1.20.1); analysis comment posted*
*Updated 2026-04-13 -- roadmap refresh triage: added #301 (Phase 1 Cleanup, t1.26.1): tighten deft-interview routing keyword collision; analysis comment posted*
*Updated 2026-04-13 -- roadmap refresh triage: added #302 (Phase 1 Cleanup, t1.27.1): clarify deft-interview invocation contract embedded vs delegation modes; analysis comment posted*
*Updated 2026-04-13 -- roadmap refresh triage: added #303 (Phase 1 Cleanup, t1.28.1): fix deft-interview Rule 5 vs Rule 6 inconsistency -- ok accepted for default but not confirmation gate; analysis comment posted*
*Updated 2026-04-13 -- roadmap refresh triage: added #304 (Phase 1 Cleanup, t1.29.1): add regression test for deft-setup Phase 1/2 referencing deft-interview; analysis comment posted*
*Updated 2026-04-13 -- roadmap refresh triage: added #305 (Phase 1 Adoption Blockers, t1.30.1): Greptile review cycle bottlenecks -- 5-change optimization bundle; analysis comment posted*
*Updated 2026-04-13 -- roadmap refresh triage: added #307 (Phase 1 Adoption Blockers, t1.31.1): deft-review-cycle Approach 2 silent failure -- add Approach 3 interactive blocking fallback; analysis comment posted*
*Updated 2026-04-13 -- roadmap refresh: restructured phases -- inserted Phase 2 (vBRIEF Architecture Cutover, RFC #309 + stories #310-#324); shifted Documentation & Content Fixes to Phase 3, CI/Testing to Phase 4, Distribution to Phase 5, Features to Phase 6; closed #308 (absorbed by #309); analysis comment posted on #309*
*Updated 2026-04-13 -- roadmap refresh cleanup: moved #293 (closed) and #298 (closed) to Completed; removed from phase bodies; struck through in Open Issues Index*
*Updated 2026-04-13 -- v0.19.0 release: moved #305, #307, #328, #301, #302, #303, #304 to Completed; emptied Phase 1 body; added #328 to Open Issues Index; struck through all 7 + #328 in index; Phase 1 now empty*
