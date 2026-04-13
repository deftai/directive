# Agent 2 — Story P: Ancillary doc updates for vBRIEF-centric model (#331)
# Branch: agent2/docs/331-ancillary-doc-updates
# Base: phase2/vbrief-cutover | PR target: phase2/vbrief-cutover

@'
TASK: You must complete 1 documentation rewrite on this branch (agent2/docs/331-ancillary-doc-updates) in the deft directive repo -- Story P of the Phase 2 vBRIEF Architecture Cutover: update all ancillary framework documents for the new vBRIEF-centric document model.
This is a git worktree branched from phase2/vbrief-cutover. Do NOT just read files and stop -- you must implement all changes, run task check, commit, push, create a PR, and run the review cycle.
DO NOT STOP until all steps are complete.

STEP 1 -- Read directives: Read AGENTS.md, main.md, and vbrief/vbrief.md (Story A output -- canonical new model reference).
Also run: gh issue view 331 --repo deftai/directive  (full scope + acceptance criteria)
And:      gh issue view 309 --repo deftai/directive  (RFC design decisions D1-D18)
Read skills/deft-review-cycle/SKILL.md.

STEP 2 -- Implement Story P (issue #331):

Core reference docs:
- REFERENCES.md: rewrite file taxonomy section (lifecycle folders, scope vBRIEFs, PROJECT-DEFINITION.vbrief.json); update loading scenarios and reference chains; remove specification.vbrief.json / PROJECT.md references
- README.md: update skill names (deft-* -> deft-directive-*), directory structure diagram, workflow references
- CONTRIBUTING.md: update process and skill name references

Workflow docs:
- commands.md: update change lifecycle references for scope vBRIEF model
- strategies/interview.md: spec generation flow now produces scope vBRIEFs, not specification.vbrief.json + SPECIFICATION.md
- strategies/map.md: update references to old document model
- strategies/speckit.md: update references to old document model
- templates/make-spec.md: rewrite for scope vBRIEF output instead of specification.vbrief.json + SPECIFICATION.md

Context and resilience docs:
- context/working-memory.md: update for plan.vbrief.json + scope vBRIEF relationship (RFC decision D15)
- resilience/continue-here.md: update for continue.vbrief.json + scope vBRIEF relationship (RFC decision D15)
- context/long-horizon.md: update multi-session patterns for lifecycle folders

Acceptance criteria (from #331):
- All files above updated to reference the new vBRIEF-centric model
- No remaining references to specification.vbrief.json as singular spec source (except in deprecation context)
- No remaining references to PROJECT.md as project config (except in deprecation context)
- All deft-* skill name references updated to deft-directive-*
- task check passes

STEP 3 -- Validate: Run task check. Fix any failures.

STEP 4 -- Commit: Add CHANGELOG.md entry under [Unreleased].
Commit message: docs(vbrief): update ancillary framework docs for vBRIEF-centric model (#331)
Include a bullet-point body summarizing what changed and why.

STEP 5 -- Push and PR: Push branch to origin. Create PR targeting phase2/vbrief-cutover (NOT master):
  gh pr create --base phase2/vbrief-cutover --title "docs(vbrief): update ancillary framework docs for vBRIEF-centric model" --body-file <temp file in $env:TEMP>
PR body must include: Closes #331, summary of changes, and the standard PR template checklist.
Note: --body-file must use a temp file in $env:TEMP -- do NOT write temp files in the worktree.

STEP 6 -- Review cycle: Follow skills/deft-review-cycle/SKILL.md to run the Greptile review cycle on the PR.
Do NOT merge -- leave for human review.

CONSTRAINTS:
- Do NOT touch: main.md, AGENTS.md, SPECIFICATION.md, ROADMAP.md
- SPECIFICATION.md is being retired by this phase -- do NOT add new tasks to it
- Branch and worktree are already set up -- do NOT create a new branch
- PR base is phase2/vbrief-cutover, NOT master
- Use vbrief/vbrief.md (Story A output) as the authoritative reference for the new document model
- New source files (scripts/, src/, cmd/, *.py, *.go) must have corresponding test files in the same PR
- Run task check before every commit
- Never force-push
'@
