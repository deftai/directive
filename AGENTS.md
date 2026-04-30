# Deft — Development Framework (deft repo)

You are working inside the deft framework repository itself.
Full guidelines: main.md

## First Session (deft development)

**Headless bypass**: If you have been dispatched with a specific task (e.g. cloud agent, CI agent, scheduled run), skip the onboarding checks below and proceed directly to your task. The onboarding flow is for interactive sessions only.

Check what exists before doing anything else:

**USER.md missing** (~/.config/deft/USER.md or %APPDATA%\deft\USER.md):
→ Read skills/deft-directive-setup/SKILL.md and start Phase 1 (user preferences)

**USER.md exists, PROJECT-DEFINITION.vbrief.json missing** (./vbrief/):
→ Read skills/deft-directive-setup/SKILL.md and start Phase 2 (project definition)

## Returning Sessions

When all config exists: read the guidelines, your USER.md preferences, and PROJECT-DEFINITION.vbrief.json, then continue with your task.

~ Run `skills/deft-directive-sync/SKILL.md` to pull latest framework updates and validate project files.

### Deft Alignment Confirmation

! At the start of each interactive session, after loading AGENTS.md, confirm to the user that Deft Directive is active. The confirmation must be unambiguous -- for example: "Deft Directive active -- AGENTS.md loaded."

! If the agent detects a context window shift or is asked "are you using Deft?", re-confirm alignment by stating that Deft Directive is active and AGENTS.md was loaded.

⊗ Begin an interactive session without confirming Deft alignment to the user.

Note: A true UI indicator (e.g. Warp status bar) is deferred to Phase 5. This is a behavioral rule only.

## Skill Completion Gate

! When a skill's final step is complete, explicitly confirm skill exit and provide chaining instructions if applicable. The confirmation must be unambiguous -- for example: "{skill-name} complete -- exiting skill." followed by what the user/agent should do next (e.g. wait for PR review, return to monitor, chain into another skill).

⊗ Exit a skill silently without confirming completion or providing next-step instructions.

## Before Improvising

- ! Before designing a multi-step workflow from scratch, scan `skills/` for an existing skill that covers the task — skills are versioned, tested, and encode lessons from prior runs
- ⊗ Improvise a multi-step workflow without first checking `skills/` for coverage

## Skill Routing

When user input matches a trigger keyword, read the corresponding skill:

- "review cycle" / "check reviews" / "run review cycle" → `skills/deft-directive-review-cycle/SKILL.md`
- "swarm" / "parallel agents" / "run agents" → `skills/deft-directive-swarm/SKILL.md` — chains to `deft-directive-review-cycle` at Phase 5
- "refinement" / "reprioritize" / "refine" → `skills/deft-directive-refinement/SKILL.md` — chains to `deft-directive-review-cycle` at exit
- "build" / "implement" / "implement spec" → `skills/deft-directive-build/SKILL.md`
- "cost" / "budget" / "pre-build cost" / "how much will this cost" → `skills/deft-directive-cost/SKILL.md`
- "setup" / "bootstrap" / "onboard" → `skills/deft-directive-setup/SKILL.md`
- "sync" / "good morning" / "update deft" / "update vbrief" / "sync frameworks" → `skills/deft-directive-sync/SKILL.md`
- "pre-pr" / "quality loop" / "rwldl" / "self-review" → `skills/deft-directive-pre-pr/SKILL.md`
- "interview loop" / "q&a loop" / "run interview loop" → `skills/deft-directive-interview/SKILL.md`
- "release" / "cut release" / "v0.X.Y" / "publish release" → `skills/deft-directive-release/SKILL.md` — operationalizes the `task release` / `task release:publish` / `task release:rollback` / `task release:e2e` surface (#74 + #716 safety hardening); re-uses the `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 5 Slack announcement template

## Development Process (always follow)

**Before code changes:**
- ! Check `./vbrief/` lifecycle folders for existing scope vBRIEF coverage of the issue being fixed
- ! If no scope vBRIEF exists for the work, create one in `./vbrief/proposed/` before implementing
- ⊗ Begin editing files before checking scope vBRIEF coverage and creating a feature branch — even if the user says "yes" or "proceed"

! Before opening a PR, run `skills/deft-directive-pre-pr/SKILL.md` for an iterative quality loop.

**Before committing:**
- Run `task check` (validate + lint + test) — this is the pre-commit gate
- ! New source files (`scripts/`, `src/`, `cmd/`, `*.py`, `*.go`) MUST include corresponding test files in the same PR -- running existing tests alone is not sufficient for new code; forward coverage requires new tests that exercise the new code paths
- Add CHANGELOG.md entry under `[Unreleased]`
- Verify .github/PULL_REQUEST_TEMPLATE.md checklist items are satisfied

**Branching:**
- ! Always work on a feature branch — never commit directly to master/main unless the user explicitly instructs it or `PROJECT-DEFINITION.vbrief.json` has `plan.policy.allowDirectCommitsToMaster = true` (typed flag, #746). The legacy `Allow direct commits to master:` narrative key is recognised at read time with a deprecation warning; new writes go through the typed surface only.
- ! Three enforcement surfaces back this rule (#747): (1) `.githooks/pre-commit` and `.githooks/pre-push` hooks call `scripts/preflight_branch.py`; install via `task setup` (idempotent `git config core.hooksPath .githooks`); verify via `task verify:hooks-installed`. (2) `task verify:branch` is wired into the `task check` aggregate so any pre-commit run flags a default-branch commit. (3) The `branch-gate` GH Actions workflow (`.github/workflows/branch-gate.yml`) refuses PRs whose `head_ref` equals `base_ref`. Override paths: `task policy:allow-direct-commits -- --confirm` writes the typed flag with a capability-cost disclosure; `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` is the emergency env-var bypass.

**Branch Policy Disclosure (session start):**
- ! When `plan.policy.allowDirectCommitsToMaster = true` on the active project's `vbrief/PROJECT-DEFINITION.vbrief.json`, the agent MUST surface the policy state at the start of any interactive session (alongside or after the Deft Directive alignment confirmation). Use the disclosure phrasing from `scripts/policy.py::disclosure_line` -- e.g. `[deft policy] Direct commits to the default branch are ENABLED (source: typed). Branch-protection policy is OFF.`
- ⊗ Begin a session that will commit/push without surfacing the policy state when `allowDirectCommitsToMaster=true` -- the user needs visibility that the gate is OFF for this project

**PR conventions:**
- ROADMAP.md updates happen at release time — batch-move merged issues to Completed during the CHANGELOG promotion commit
- Commit messages: `feat/fix/docs/chore` prefix, concise subject, bullet-point body
- When running a review cycle on a PR, follow `skills/deft-directive-review-cycle/SKILL.md`
- ! After squash merge, verify issues actually closed: `gh issue view <N> --json state --jq .state`. Squash merges can silently fail to process closing keywords (`Closes #N`). If still open, close manually with a comment referencing the merged PR (#167)

## Commands

- /deft:change <name>        — Propose a scoped change
- /deft:run:interview        — Structured spec interview
- /deft:run:speckit          — Five-phase spec workflow (large projects)
- /deft:run:discuss <topic>  — Feynman-style alignment
- /deft:run:research <topic> — Research before planning
- /deft:run:map              — Map an existing codebase
- run bootstrap              — CLI setup (terminal users)
- run spec                   — CLI spec generation

## PowerShell

! When writing files using PowerShell, MUST use `New-Object System.Text.UTF8Encoding $false` -- never `[System.Text.Encoding]::UTF8` (writes BOM). See `scm/github.md` PS 5.1 section.

Note: paths here are root-relative — this repo IS the deft directory.
Install-generated AGENTS.md uses deft/-prefixed paths.

