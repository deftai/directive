# Changelog

All notable changes to the Deft framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Instant-fix drift and skill-context bleed rules** (#198, t1.10.4): Added `⊗` rules to `main.md` Decision Making prohibiting mid-task instant fixes (must file issue instead) and skill-context bleed (must stop at skill boundary); added `!` exit-condition rule; companion `meta/lessons.md` entries (xrefs #159, #167, #184)
- **Mandatory skills/ scan rule** (#200, t1.10.5): Added `!` rule and `⊗` anti-pattern to `AGENTS.md` requiring agents to scan `skills/` before designing multi-step workflows; companion `meta/lessons.md` entry
- **Keyword-to-skill routing table** (#147, t2.6.4): Added Skill Routing section to `AGENTS.md` mapping trigger keywords to skill paths; added 3 missing skills (deft-review-cycle, deft-roadmap-refresh, deft-swarm) to `README.md` Skills section
- **README stale content fixes** (#219, t2.6.5): Added `CONTRIBUTING.md` and `contracts/hierarchy.md` to README directory tree; updated skills/ subtree to list all 5 skills; added hierarchy.md to Contracts section

### Fixed
- **pyproject.toml dev deps break task check in fresh worktrees** (#217, t1.10.1): Moved dev dependencies from `[project.optional-dependencies]` to `[dependency-groups]` (PEP 735); `uv sync` now installs dev deps by default in fresh worktrees without needing `--extra dev`; regenerated `uv.lock`; updated `languages/python.md` template to show `[dependency-groups]` pattern

### Changed
- **Roadmap Refresh (2026-04-07)**: Triaged 5 new issues — #217 (pyproject.toml dev deps breaks task check in fresh worktrees, Phase 1 Adoption Blockers), #218 (deft-swarm release decision checkpoint, Phase 1 Adoption Blockers), #207 (Greptile re-review latency on swarm merge cascade, Phase 2), #219 (README.md stale content, Phase 2), #212 (process control in Directive discussion, Phase 5); cleanup: struck through #184/#188/#191/#192/#199 in index (completed v0.12.0), removed duplicate bare #198 entry, added #182 description; analysis comments posted on all 5 issues

## [0.12.1] - 2026-04-06

### Added
- **State WHY rule for interview strategy** (#84, t2.2.3): Added `!` rule to `strategies/interview.md` Interview Rules requiring agents to state the underlying principle (1 sentence) when making an opinionated recommendation — part of "Deft as teacher" so users understand the contract hierarchy reasoning behind recommendations
- **CONTRIBUTING.md contributor bootstrap guide** (#67, t2.3.1): Created `CONTRIBUTING.md` at repo root with full contributor onboarding — prerequisites (Go 1.22+, Python 3.11+, uv, task), dev environment setup, running tests (`task test`, `task check`), running CLI locally (`uv run python run`), building the Go installer (`go build ./cmd/deft-install/`); documents `task check` as the authoritative pre-commit gate and defines a passing `task check` as the definition of ready-to-commit

### Fixed
- **PR merge hygiene -- squash-merge issue-close verification** (#167, t1.8.4): Root cause documented in `meta/lessons.md` -- GitHub squash merges can silently fail to process closing keywords (`Closes #N`) from PR bodies, leaving referenced issues open with no error; added closing keyword guidance and post-merge verification checklist to `.github/PULL_REQUEST_TEMPLATE.md`; added Post-Merge Verification section to `skills/deft-review-cycle/SKILL.md` mirroring `deft-swarm` Phase 6 Step 2; added issue-close verification convention to `AGENTS.md` PR conventions; added anti-pattern for assuming squash merge auto-closed issues
- **Consistent ./deft/ installation path** (#116, t1.8.3): Installer now creates thin pointers for all 6 skills (deft, deft-setup, deft-build, deft-review-cycle, deft-roadmap-refresh, deft-swarm) instead of only 3 -- previously deft-review-cycle, deft-roadmap-refresh, and deft-swarm were missing from the installer's `.agents/skills/` setup, making them undiscoverable in installed projects; all thin pointers consistently use `deft/`-prefixed paths; added 3 path consistency tests verifying skill pointer `deft/` prefix, only expected files at project root, and DeftDir placement

## [0.12.0] - 2026-04-06

### Added
- **Swarm close-out orchestration rules** (#206, t2.6.3): Added monitor-centric close-out rules to skills/deft-swarm/SKILL.md Phase 6 -- merge authority (monitor proposes, user approves), rebase cascade ownership (monitor owns), GIT_EDITOR=true for non-interactive rebase, post-merge issue verification step; added push autonomy carve-out for swarm agents; added MCP fallback note to skills/deft-review-cycle/SKILL.md (gh-only when MCP unavailable)
- **Deft-swarm runtime capability detection** (#188, t1.9.3): Replaced static Option A/B/C launch path selection in `skills/deft-swarm/SKILL.md` Phase 3 with runtime capability detection — agent probes for `start_agent` tool at runtime, uses it as preferred path if available (Warp orchestration), falls back to manual Warp tabs silently when unavailable but Warp detected, gates Warp-specific paths on `WARP_*` environment variables; cloud (`oz agent run-cloud`) preserved as explicit user-requested escape hatch only; anti-patterns updated for dynamic approach
- **Deft-swarm mandatory analyze phase** (#199, t1.9.4): Added Phase 0 — Analyze to `skills/deft-swarm/SKILL.md` before Phase 1 (Select) — reads ROADMAP.md and SPECIFICATION.md, surfaces blockers (blocked spec tasks, missing spec coverage, dependency conflicts), presents analysis summary to user, requires explicit user approval before proceeding to task selection; anti-pattern added prohibiting Phase 1 entry without Phase 0 completion

### Fixed
- **vBRIEF reference type schema vendor** (#133, t1.8.2): Vendored updated upstream vBRIEF schema — `VBriefReference.type` expanded from `{"enum": ["x-vbrief/plan"]}` to pattern-based `^x-vbrief/` accepting all `x-vbrief/*` reference types (e.g. `x-vbrief/plan`, `x-vbrief/context`, `x-vbrief/research`); unblocks generated vBRIEF files that use context/research references; task t1.8.2 moved from `[blocked]` to `[completed]`
- **deft-review-cycle autonomous polling** (#184, t1.9.4): Added `!` rule to Step 4 requiring agents to autonomously poll for Greptile review updates after pushing without stopping to ask the user; added `⊗` anti-pattern for pausing the review/fix loop for user confirmation; added candidate lesson to `meta/lessons.md` Review Cycle Monitoring section
- **deft-review-cycle proactive test coverage** (#192, t1.9.5): Added Step 3b (between fix commit and push) requiring agents to scan changed lines for untested code paths and write tests in the same batch; eliminates one CI round-trip per fix cycle; added `⊗` anti-pattern for pushing without coverage scan
- **Swarm force-push anti-pattern scope fix** (#209): Scoped blanket force-push anti-pattern to swarm agents only -- monitor may --force-with-lease after rebase cascade per Phase 6; fixed GIT_EDITOR portability (added Windows PowerShell fallback echo); added 7 regression tests for Phase 6, Push Autonomy, and MCP fallback content
- **vBRIEF reference-type workaround removal** (#191, t1.9.3): Verified no defensive workarounds remain in `vbrief/vbrief.md`, `templates/make-spec.md`, or `scripts/spec_validate.py` after upstream deftai/vBRIEF#2 resolution; spec task added and marked completed

### Changed
- **Roadmap Refresh (2026-04-06)**: Triaged 14 new issues, promoted 1, closed 2, cleaned 1 stale entry — #192 (proactive test coverage after review-fix commits, Phase 1 Adoption Blockers), #191 (remove vBRIEF defensive workarounds, deftai/vBRIEF#2 resolved, Phase 1 Adoption Blockers), #189 (closed as superseded by #191), #184 (deft-review-cycle autonomous polling imperative after push, Phase 1 Adoption Blockers), #188 (deft-swarm runtime `start_agent` capability detection + Warp environment gate, Phase 2; reshaped from static Option D label to tool-presence-based detection), #182 (deft-rwldl skill: iterative pre-PR quality loop, Phase 2), #194 (user-facing best practices guide, Phase 2), #195 (review monitor orchestration, Phase 2), #196 (roadmap-refresh cleanup convention, Phase 2), #197 (scm/github.md with gh CLI rules and Windows encoding guidance, Phase 2 -- absorbs #201), #198 (instant-fix drift and skill-context bleed rules for main.md, Phase 1), #199 (deft-swarm mandatory analyze phase, Phase 1), #200 (scan skills/ before improvising workflows, Phase 1), #202 (ASCII convention for machine-editable sections, Phase 2); promoted #188 from Phase 2 to Phase 1 (user actively testing swarm); closed #201 (absorbed by #197); moved #166 to Completed (closed on GitHub); cleaned up 2 stale entries (#133 closed 2026-04-05, #58 closed 2026-04-06); updated #147 title and scope (expanded to cover keyword routing + 3 missing skills); analysis comments posted on all issues

## [0.11.0] - 2026-04-05

### Fixed
- **Change gate UX — replace name-echo with yes/no confirmation** (#185, t1.9.1):
  - `/deft:change` confirmation gate no longer requires users to retype the full change name; agents now present the change name and ask for explicit yes/no confirmation
  - Accepted responses: `yes`, `confirmed`, `approve`; vague responses (`proceed`, `do it`, `go ahead`) still rejected
  - Updated across all framework surfaces: `main.md` Decision Making rule, `skills/deft-build/SKILL.md` Change Lifecycle Gate, `skills/deft-review-cycle/SKILL.md` Phase 1 audit, `.github/PULL_REQUEST_TEMPLATE.md` checklist
  - Spec task t1.9.1 added to `vbrief/specification.vbrief.json` and rendered to `SPECIFICATION.md`
- **deft-swarm Option A limitations documented** (#179): Updated `skills/deft-swarm/SKILL.md` Phase 3 — demoted Option A (`oz agent run`) from preferred to "currently limited"; elevated Option B (interactive Warp tab) as recommended launch method; added known-limitations callout noting Option A does not receive global Warp Drive rules, MCP UUIDs, or auto-injected context; documented inline MCP JSON workaround; added two new anti-patterns; updated default launch from Option A to Option B; recorded finding in `meta/lessons.md`
- **AGENTS.md pre-implementation gate enforcement** (#186): Added `!` (MUST) markers to "Before code changes" checklist items in `AGENTS.md`; added `⊗` anti-pattern prohibiting file edits before spec coverage check and branch creation — even if user says "yes" or "proceed"; root cause: agent loaded AGENTS.md but treated pre-implementation checklist as advisory due to missing RFC2119 enforcement markers

## [0.10.3] - 2026-04-05

### Fixed
- **vBRIEF schema conformance — agent generation guidance + validation** (#126, #144):
  - Fixed `speckit.md` Phase 4 Task Structure: replaced legacy flat format (`vbrief`, `tasks`, `do`, `todo/doing/done`) with correct vBRIEF v0.5 envelope (`vBRIEFInfo` + `plan` object, `title` field, `pending/running/completed` lifecycle)
  - Added hierarchical `subItems` guidance and examples to `vbrief/vbrief.md`, `skills/deft-setup/SKILL.md`, and `templates/make-spec.md` — agents now have explicit instructions for representing Phase → Subphase → Task nesting in vBRIEF JSON
  - Added narrative-must-be-string rules (`plan.narratives` and `PlanItem.narrative` values must be plain strings, never objects or arrays) across all generation docs
  - Strengthened `spec_validate.py`: recursive `subItems` validation (title, status, narrative types at all nesting levels), `plan.narratives` string enforcement, detection of `items` key misuse inside PlanItems (should be `subItems`)
  - Added 5 new tests: narrative object detection, item narrative array detection, `items`-inside-PlanItem detection, recursive subItems invalid status, valid hierarchical spec passthrough

### Changed
- **ROADMAP.md update convention** (#170): Changed PR conventions in `AGENTS.md` from "updates happen on merge" to "updates happen at release time — batch-move merged issues to Completed during the CHANGELOG promotion commit"; added Phase 6 Step 5 to `skills/deft-swarm/SKILL.md` codifying this as the release-time checkpoint; added ⊗ anti-pattern prohibiting ROADMAP.md edits during swarm close; added ⊗ to Phase 1 Step 2 excluding ROADMAP.md from swarm shared-file exceptions
- **Mermaid gist-rendering guidance**: Codified GitHub/Gist sequence-diagram readability rules in `languages/mermaid.md` as explicit RFC2119 MUST/SHOULD guidance: do not rely on `init.background`/`themeCSS` alone, use a grey participant-only `box ... end`, keep messages/notes outside the box, and keep sequence workarounds diagram-type-scoped; added regression tests in `tests/content/test_mermaid_guidance.py` (#102)
- **Specification sync**: Full sync of `vbrief/specification.vbrief.json` and rendered `SPECIFICATION.md` — corrected 15 stale task statuses (t1.1.1–t1.5.2, t1.6.1–t1.6.4, t2.1.2–t2.2.2, t2.5.1–t2.5.5 all now `completed`); added 9 missing tasks: retroactive coverage for completed work (t1.7.1 #166, t1.7.2 #171, t1.7.3 #175, t1.7.4 #172, t2.6.1 #104), new tasks for open Phase 1 issues (t1.8.1 #126/#144, t1.8.2 #133, t1.8.3 #116, t1.8.4 #167); reordered all tasks by phase (1→2→3); total 46 tasks (34 completed, 9 pending, 3 blocked)

## [0.10.2] - 2026-04-03

### Added
- **Branching preference in project setup**: `cmd_project` and `deft-setup` Phase 2 Track 1 now ask branching preference (branch-based — default/recommended, or trunk-based); emits `Allow direct commits to master: true` under `## Branching` in PROJECT.md if trunk-based is chosen (#171)

### Fixed
- **No direct-to-master agent commits**: Added `⊗` hard gate to `main.md`, `AGENTS.md`, and `skills/deft-build/SKILL.md` — agents must always create a feature branch and open a PR; `Allow direct commits to master: true` in `PROJECT.md ## Branching` provides opt-in escape hatch for solo/trunk-based projects (#171)
- **Review cycle push discipline + polling cadence**: Added `⊗` rule to `skills/deft-review-cycle/SKILL.md` Step 4 prohibiting additional commits while Greptile is reviewing current head; added `~` `60s` minimum poll interval guidance; codified both as `meta/lessons.md` Review Cycle Monitoring lessons #2 and #3 (#175)

### Fixed
- **oz agent run correction**: Corrected `skills/deft-swarm/SKILL.md` Phase 3 — `oz agent run` is local (preferred automated launch path), `oz agent run-cloud` is the cloud path; rewrote options A/B/C, fixed prerequisites and anti-patterns; added correction addenda to `meta/lessons.md` lessons #1 and #7; updated `SPECIFICATION.md` t2.5.4 acceptance criteria (#172)

### Changed
- **Roadmap Refresh (2026-04-03)**: Triaged 5 new issues — #170 (move ROADMAP.md updates to release-time, Phase 2), #171 (hard gate against agent direct-to-master commits, Phase 1 Cleanup), #172 (deft-swarm skill oz agent run/run-cloud correction, Phase 1 Adoption Blockers — priority next), #174 (deft-roadmap-refresh review cycle chaining after PR push, Phase 2), #175 (deft-review-cycle no-push-during-review + polling cadence, Phase 1 Cleanup); analysis comments posted on all issues; meta/lessons.md updated with 3 new Windows/review-cycle encoding and monitoring lessons

### Added
- **Greptile integration guide**: Added tools/greptile.md — recommended Greptile dashboard and per-repo settings for teams using deft, covering triggerOnUpdates/statusCheck configuration, check runs vs. commit statuses distinction, troubleshooting, and anti-patterns (#166, t1.7.1)

- **Holzmann Power of Ten adaptation**: Added `coding/holzmann.md` — JPL/NASA Power of Ten rules (Holzmann, 2006) adapted for Deft with RFC 2119 notation; covers simple control flow, bounded loops, fixed resource allocation, small functions, runtime checks, minimal data scope, error/return checking, restricted metaprogramming/indirection, and maximum static checking (#104)
- **Superpowers adoption plan**: Added `docs/superpowers.md` — prioritized adoption plan identifying 8 patterns from [obra/superpowers](https://github.com/obra/superpowers) worth integrating into the Deft Directive (systematic debugging, verification gate, code review protocol, rationalization prevention, subagent dispatch, no-placeholders rule, git worktrees, branch completion)

## [0.10.1] - 2026-04-02

### Changed
- **README restructure**: Moved Getting Started section (install, setup, spec, build) from below the architecture/layers documentation to immediately after the TL;DR; added prominent installer download callout at the top of the page (#137, t2.5.3)
- **Language removed from USER.md**: Removed `**Primary Languages**` field from USER.md template and Phase 1 interview (Track 1 Step 2, Track 2 Step 2, Track 3 language inference) — language is a project-level concern determined per-project via codebase inference, not a user preference (#107, t1.1.3)
- **Deployment platform question**: Phase 2 Track 1 now asks deployment platform (cross-platform, Windows-native, macOS-native, Linux/Unix, embedded, web/cloud, mobile, other) before language — platform context drives a filtered language shortlist with progressive "Other" disclosure and missing-standards-file warning (#108, t1.1.4)

### Fixed
- **deft-review-cycle Greptile pre-flight**: Added Pre-Flight Check section to skills/deft-review-cycle/SKILL.md — verifies triggerOnUpdates is enabled before entering the review/fix loop, documents that Greptile posts check runs (Checks API) not commit statuses, adds @greptileai manual re-trigger fallback and anti-pattern for using wrong API endpoint (#166, t1.7.1)

- **Testing enforcement gate**: Added `!` hard gate rule to `main.md` Decision Making — no implementation is complete until tests written and `task check` passes; a general 'proceed' does not waive testing; added anti-pattern to `deft-build/SKILL.md` (#68, t1.6.1)
- **Change lifecycle gate enforcement**: Strengthened `/deft:change` rule in `main.md` — broad 'proceed'/'do it'/'go ahead' explicitly does NOT satisfy the gate; user must acknowledge the **named** change; added pre-flight gate to `deft-build/SKILL.md`, checklist item to `.github/PULL_REQUEST_TEMPLATE.md`, verification step to `deft-review-cycle/SKILL.md` Phase 1 audit; Phase 1 audit gaps now batched with Phase 2 fixes (#123, t1.6.2)
- **Context-aware branching for solo projects**: Added solo-project qualifier to `main.md` change lifecycle rule — `/deft:change` mandatory for team projects (2+ contributors), recommended for solo projects with quality gate as enforcement; mandatory regardless of team size for cross-cutting, architectural, or high-risk changes; full config-driven approach deferred to Phase 5 (#138, t1.6.3)
- **vBRIEF source step enforcement**: Added `⊗` rule to `main.md` vBRIEF Persistence — SPECIFICATION.md must never be written directly, must be generated from `specification.vbrief.json`; added anti-pattern to `deft-build/SKILL.md` (#139, t1.6.4)
- **deft-review-cycle Greptile signal**: Updated `skills/deft-review-cycle/SKILL.md` Step 4 to document that Greptile may advance its review by editing an existing PR issue comment rather than creating a new PR review object; added dual-surface detection guidance (issue comments as primary signal, PR review objects as secondary) with `updated_at` timestamp checking; added anti-pattern for relying solely on `pulls/{number}/reviews` (#145, t2.5.2)
- **Phase 2 inference boundary**: Added ⊗ rules to `deft-setup/SKILL.md` Phase 2 Inference section — MUST NOT scan `./deft/` for build files or run git commands inside `./deft/`; only inspect project root and non-deft subdirectories (#79, t1.1.1)
- **Phase 2 project name fallback**: Added fallback rule — when no build files exist at project root, default project name to current directory name and ask for confirmation (#80, t1.1.2)
- **AGENTS.md headless bypass**: Added headless/task-mode bypass to First Session gate so cloud agents, CI agents, and scheduled tasks skip interactive onboarding when dispatched with an explicit task (#142, t1.1.5)
- **CLI version display**: All `cmd_*` functions now print `Deft CLI v{VERSION}` on startup — previously `cmd_validate`, `cmd_doctor`, and `cmd_update` had no version display; existing headers normalized from `Deft v` to `Deft CLI v` (#49, t1.3.2)
- **CLI code quality sweep** (#118):
  - Removed stale `v0.3.7` from module docstring — VERSION constant (`0.4.2`) is the single source of truth
  - Removed `Requires: Python 3.6+` from docstring — conflicts with `run.bat` enforcing 3.13+; `run.bat` handles Windows version check independently
  - Changed bare `except:` in `cmd_spec` project-name parsing to `except (OSError, UnicodeDecodeError):` — no longer swallows `KeyboardInterrupt`/`SystemExit`
  - Documented `--force` flag in `usage()` help text for the `spec` command
  - Fixed `DEFT_PRD_PATH` env var misuse on Light sizing path — Light path now reads `DEFT_INTERVIEW_PATH` instead of overloading the PRD env var
- **Installer post-install text** (#131): Verified already fixed in v0.8.0 — `PrintNextSteps` says "Use AGENTS.md" (not "read agents.md")

## [0.10.0] - 2026-04-02

### Added
- **Review Cycle Skill**: Added `skills/deft-review-cycle/SKILL.md` — Greptile bot reviewer response workflow covering Phase 1 deft process audit, Phase 2 review/fix loop (batch fixes, wait-for-bot, exit condition), GitHub review submission rules, and anti-patterns; enables cloud agents to run autonomous PR review cycles; thin pointer added at `.agents/skills/deft-review-cycle/SKILL.md` (#135)
- **Roadmap Refresh Skill**: Added `skills/deft-roadmap-refresh/SKILL.md` — structured contributor workflow for triaging open issues into the phased roadmap (discovery, one-at-a-time analysis with human review, cleanup)
- **Roadmap Maintenance Strategy**: Added `strategies/roadmap.md` — optional user-facing guide for maintaining a living roadmap with agent-assisted triage
- **Agent Skill Pointer**: Added `.agents/skills/deft-roadmap-refresh/SKILL.md` thin pointer for auto-discovery
- **Swarm Skill**: Added `skills/deft-swarm/SKILL.md` — parallel local agent orchestration workflow with 6 phases (Select, Setup, Launch, Monitor, Review, Close), proven prompt template, file-overlap audit gate, monitoring checkpoints, takeover triggers, and anti-patterns; thin pointer at `.agents/skills/deft-swarm/SKILL.md` (#152)
- **history/changes/ README**: Added `history/changes/README.md` documenting the change lifecycle artifact structure — directory layout, lifecycle stages, and rules (#59, t2.1.2)
- **Contract hierarchy**: Created `contracts/hierarchy.md` documenting two hierarchy lenses — durability axis (Standards > APIs > Specs > Code) and generative axis (Spec → Contracts → Code); includes RFC2119 legend, examples, and anti-patterns (#84 Phase 1, t2.2.1)
- **Adaptive teaching behavior**: Added three adaptive teaching rules to `main.md` Agent Behavior section — be concise when accepted, explain reasoning when questioned, never lecture unprompted (#84 Phase 1, t2.2.2)

### Fixed
- **commands.md vBRIEF vocabulary**: Status lifecycle rule and example now use canonical vBRIEF v0.5 vocabulary — plan-level `draft`/`proposed`/`approved`, task-level `pending`/`running`/`completed`/`blocked`/`cancelled`; added missing `narrative` to task t3 in example; no use of legacy `todo`/`doing`/`done` (#25, t2.1.5)
- **core/project.md cleanup**: Replaced leaked personal project content with generic template; added legacy-location redirect note pointing to `./PROJECT.md` as the canonical path (t2.1.6)

### Changed
- **Yolo Strategy Deduplication**: Refactored `strategies/yolo.md` to reference `interview.md` for shared Light/Full path flows, SPECIFICATION guidelines, and Artifacts Summary — reduced from 165 to ~115 lines (#23)
- **Chaining Gate Cleanup**: Removed "Brownfield" alias from `interview.md` chaining gate options — now just "Map"
- **SpecKit Cross-Reference**: Added **⚠️ See also** banner to `strategies/speckit.md` (#24)
- **Strategies README**: Removed redundant `brownfield.md` row from strategy table; added roadmap strategy
- **README.md**: Updated directory tree and strategies reference list to reflect `default.md` deletion and `brownfield.md` redirect
- **Baseline Snapshot**: Regenerated `tests/content/snapshots/baseline.json` to reflect strategy file changes
- **Roadmap Refresh**: Triaged 12 new issues (#124, #126, #127, #131, #133–#140) into roadmap phases; moved #67, #91, #92 to Completed; cleaned stale index entries; filed upstream deftai/vBRIEF#2 for #133
- **Roadmap Refresh (2026-04-02)**: Triaged 5 new issues — #142 (AGENTS.md onboarding gate blocks headless/cloud agents, Phase 1), #144 (vBRIEF wrong narrative type + items/subItems, Phase 1 with #126), #145 (deft-review-cycle Greptile signal bug, Phase 1), #146 (deft-sync session-start skill, Phase 2), #147 (skills undocumented in README/AGENTS.md, Phase 2); fixed index formatting

### Removed
- **Redundant Strategy Files**: Deleted `strategies/default.md` (fully superseded by `interview.md`) and replaced `strategies/brownfield.md` with a redirect to `map.md` (#31, #50)

## [0.9.0] - 2026-03-29

### Added
- **Minimal CI Workflow**: Added .github/workflows/ci.yml — runs 	ask check (ruff, mypy, pytest) on all PRs and master pushes; gates merges until lint + tests pass (#57 partial)
- **Toolchain Validation Directive**: Added `coding/toolchain.md` with RFC2119 pre-implementation gate — MUST verify task runner, language compiler/runtime, and platform SDK (if applicable) before beginning implementation, stop and report if any are missing; pointer added to `coding/coding.md`; toolchain check added to `strategies/interview.md` Acceptance Gate and `skills/deft-build/SKILL.md` Step 2; iOS/Swift incident codified in `meta/lessons.md` (#106)
- **Build Output Validation Directive**: Added `coding/build-output.md` with RFC2119 rules for post-build artifact verification — MUST verify expected output files exist and are structurally valid after custom build scripts, especially non-compiled assets bundlers don't track; referenced from `coding/coding.md`; added `### Build Output Tests` section to `coding/testing.md`; codified root cause in `meta/lessons.md` (#105)
- **AGENTS.md Development Process**: Added "Development Process (always follow)" section codifying pre-code spec review, pre-commit `task check` gate, CHANGELOG/PR-template requirements, and commit message conventions — ensures agents follow deft conventions automatically via Warp project rules (partially addresses #114)

### Fixed
- **vBRIEF Generation Chain**: Fixed five-component vBRIEF generation chain that produced invalid `specification.vbrief.json` files — validator now enforces vBRIEF v0.5 schema (`vBRIEFInfo` envelope + `plan` object with `title`/`status`/`items`); migrated `specification.vbrief.json` and `plan.vbrief.json` from legacy flat format to conformant v0.5; renderer reads from new structure; `make-spec.md` and `deft-setup/SKILL.md` now include concrete vBRIEF output examples; `CONVENTIONS.md` corrected from documenting wrong format; `working-memory.md` example and `long-horizon.md` status lifecycle updated to v0.5 vocabulary; vBRIEF file validation tests added (#72, t1.2.1, t1.2.2)
- **vBRIEF Repo Reference Inconsistency**: Normalized vBRIEF source repo URL from `visionik/vBRIEF` to `deftai/vBRIEF` across `REFERENCES.md` and `vbrief/vbrief.md`
- **CLI Command Chaining Loop**: `cmd_project` no longer falls through and re-runs the entire questionnaire after `cmd_install` chains through `cmd_project` → `cmd_spec` — the original call now returns cleanly (#117, closes #91)
- **Strategy Selection Infinite Loop**: Strategy selection in `cmd_bootstrap` and `cmd_project` no longer enters an unbreakable loop when `strategies/` is empty or unresolvable — callers now warn and default to Interview when no strategy files are found (#92)
- **Strategy Fallback Value**: Strategy parsing fallback changed from deprecated `("default", "Default")` to `("interview", "Interview")` in both `cmd_bootstrap` and `cmd_project`
- **Broken Strategy Link in Generated Files**: Generated USER.md/PROJECT.md no longer writes a broken markdown link to `strategies/interview.md` when `strategies/` is empty — uses plain text instead (PR #120 review fix)

### Changed
- **Roadmap Triage**: Triaged issues #101–#108 into roadmap phases; #101 absorbed into #56; #105/#106 (directive gaps) and #107/#108 (language selection UX) added to Phase 1; #102/#103/#104 (docs/standards) added to Phase 2

## [0.8.0] - 2026-03-22

### Added
- **Agent Skill Auto-Discovery**: Added `.agents/skills/deft/`, `deft-setup/`, `deft-build/` thin pointer files to the repo — Warp and other agents now auto-discover deft skills on startup without user prompting (#94)
- **WriteAgentsSkills**: Installer now creates `.agents/skills/` in user project root during install so agents auto-discover deft skills immediately (#94)
- **Prescriptive Change Lifecycle Rule**: Added `! Before implementing any planned change that touches 3+ files or has an accepted plan artifact, propose /deft:change <name> and wait for confirmation` to `main.md` Decision Making section (#94)

### Changed
- **PrintNextSteps**: Installer output updated to reflect auto-discovery — no longer tells users to manually say 'read AGENTS.md and follow it' (#94)
- **AGENTS.md** (in-repo): Removed redundant Skills line — `.agents/skills/` handles discovery (#94)
- **agentsMDEntry**: Removed Skills line from install-generated AGENTS.md — `.agents/skills/` handles discovery, resolving the TODO from #75 (#94)

## [0.7.1] - 2026-03-20

### Fixed
- **AGENTS.md Onboarding**: Install-generated `AGENTS.md` now contains self-contained bootstrap logic — first-session phase detection (USER.md → Phase 1, PROJECT.md → Phase 2, SPECIFICATION.md → Phase 3), returning-session guidance, and available commands reference (#54, closes #85)
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
  - CLI strategy picker now shows one-line descriptions and a ★ RECOMMENDED marker for `interview`
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
- **Yolo Strategy**: `strategies/yolo.md` — auto-pilot interview where the agent picks all recommended options via "Johnbot" (#16)
- **Change Lifecycle**: Scoped change proposals with `/deft:change` commands (#17, #20)
  - `/deft:change <name>` — create proposal in `history/changes/<name>/`
  - `/deft:change:apply` — implement tasks from active change
  - `/deft:change:verify` — verify against acceptance criteria
  - `/deft:change:archive` — archive to `history/archive/<date>-<name>/`
  - `commands.md` — full workflow documentation
- **History Directory**: `history/changes/` and `history/archive/` for change tracking (#17)
- **Spec Deltas**: `context/spec-deltas.md` — track how requirements evolve across changes (#19)
  - vBRIEF chain pattern linking deltas to baseline specs
  - GIVEN/WHEN/THEN scenario format for behavioral requirements
  - Reading protocol: baseline → active deltas in chronological order
- **Archive Merge Protocol**: Spec delta merge into main spec + CHANGELOG entry on archive (#20)
- **Session Commands**: `/deft:continue` and `/deft:checkpoint` for session management (#16, #20)
- **Glossary**: Added "Spec delta" term definition (#19)
- **Unity Platform Standards**: `platforms/unity.md` — Unity 6+ development standards covering project structure, MonoBehaviours, ScriptableObjects, performance, Addressables, testing, and source control (#27)

### Changed
- **Strategy Renames**: `default.md` → `interview.md`, `brownfield.md` → `map.md` (#16)
- **Command Prefix**: Change lifecycle uses `/deft:change` (not `/deft:run:change`); session uses `/deft:continue`/`/deft:checkpoint` (#20)
- **Cross-references updated** across PROJECT.md, REFERENCES.md, core/glossary.md, and all strategy files (#16)
- **strategies/README.md**: Added Command column to strategy table, updated selection examples (#16)

## [0.5.2] - 2026-03-09

### Changed
- **Branch sync**: Merged master (v0.2.3 through v0.4.3) into beta (v0.5.0/v0.5.1) to unify both branches after significant divergence from the v0.2.2 fork point

### Conflict Resolutions
- **CHANGELOG.md**: interleaved both sides chronologically (v0.5.1 → v0.2.3)
- **templates/make-spec.md**: kept beta's vBRIEF specification flow
- **templates/user.md.template**: kept beta's slim override-only template (v0.5.0 intentionally removed duplicated Workflow/AI Behavior sections)
- **core/project.md**: kept master's generic Iglesia template with Volatile Dependency Abstraction rules (beta had project-specific voxio-bot config)
- **docs/claude-code-integration.md**: kept beta's relocated paths (USER.md at ~/.config/deft/, PROJECT.md at project root)
- **run / run.bat**: kept beta's more evolved CLI (2500+ lines with strategies, vBRIEF, and expanded language/deployment support)
- **README.md**: hybrid — master's Mermaid diagrams and copyright notice combined with beta's updated file paths and next-steps text

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
  - Coverage threshold only emitted when non-default (≠85%)
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
  - SKILL.md: 451 → 170 lines (62% reduction) - Removed redundant workflow examples, kept core concepts
  - github.md: 640 → 254 lines (60% reduction) - Removed CLI command reference, kept best practices and templates
  - git.md: 378 → 139 lines (63% reduction) - Removed basic command examples, kept standards and safety rules
  - telemetry.md: 337 → 254 lines (25% reduction) - Condensed tool examples while keeping Sentry config
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
  - New structure: Install → Bootstrap → Generate Spec → Build with AI
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
  - Updated workflow to: bootstrap → project → spec

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
  - Creates smooth guided flow: install → bootstrap → project → spec
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
- **Renamed `run.py` → `run`**: Removed .py extension for cleaner command
  - Follows Unix convention for executables
  - More professional appearance
  - All documentation updated
- **Renamed `run init` → `run install`**: Better matches common tooling patterns
  - Aligns with Makefile/Taskfile conventions (make install, task install)
  - Clearer intent: "install deft framework"
  - Less confusion with bootstrap command
  - Updated all references: "initialized" → "installed", "Reinitialize" → "Reinstall"
- **Updated README.md**: Added Quick Start section with run commands
  - Shows complete workflow: install → bootstrap → project → spec
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
  - Documents complete SDD process: PRD → AI Interview → Specification → Implementation
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
  - Step-by-step initialization workflow (init → bootstrap → project → spec)
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
  - Use symbols (!, ~, ?, ⊗, ≉) only, no redundant MUST/SHOULD keywords
  - Minimizes token usage while maintaining clarity
- **Internal References**: All docs reference internal files instead of external websites
  - semver.org → `core/versioning.md`
  - keepachangelog.com → `scm/changelog.md`

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
  - `core/coding.md` → `coding/coding.md`
  - `tools/testing.md` → `coding/testing.md`
  - All cross-references updated throughout framework
- **User Configuration**: `core/user.md` now in `.gitignore`
  - Users should copy from `templates/user.md.template`
  - Prevents accidental commits of personal preferences

#### Improvements
- **Enhanced README.md**: Comprehensive overview with examples
- **Better Documentation**: Clearer hierarchy and precedence rules
- **Framework Philosophy**: Documented key principles (TDD, SDD, Task-centric workflows)
- **Coverage Requirements**: Standardized at ≥85% across all languages
- **Fuzzing Standards**: Added ≥50 fuzzing tests per input point requirement

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

## Migration Guide: 0.1.0 → 0.2.0

### File Paths
If you have custom scripts or references to deft files, update these paths:
- `core/coding.md` → `coding/coding.md`
- `tools/testing.md` → `coding/testing.md`

### User Configuration
1. Copy `templates/user.md.template` to `core/user.md`
2. Customize with your preferences
3. Your `core/user.md` will be ignored by git

### New Features to Explore
- Run `deft.sh bootstrap` to set up user preferences interactively
- Check out `REFERENCES.md` for lazy-loading guidance
- Explore new interface guidelines if building CLIs, APIs, or UIs
- Review enhanced language standards for Python, Go, TypeScript, and C++

[Unreleased]: https://github.com/deftai/directive/compare/v0.13.0...HEAD
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
<!-- [0.6.0] has no git tag — it was a beta-only version that was never tagged on master. -->
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
