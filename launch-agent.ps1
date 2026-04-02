$prompt = @"
TASK: You must complete 4 enforcement/rules fixes on this branch (fix/68-123-138-139-enforcement-rules) in the deft directive repo.
This is a git worktree. Do NOT just read files and stop — you must implement all changes,
run task check, commit, push, create a PR, and run the review cycle.
DO NOT STOP until all steps are complete.

STEP 1 — Read directives: Read AGENTS.md, PROJECT.md, SPECIFICATION.md, main.md.
Read skills/deft-review-cycle/SKILL.md. Read skills/deft-build/SKILL.md.

STEP 2 — Implement these 4 tasks. None have spec tasks yet — create spec tasks in SPECIFICATION.md before implementing each:

Task A (create spec task, issue #68): Warp not always enforcing Deft testing protocols — core quality gates are silently skipped. Strengthen enforcement in main.md and skills/deft-build/SKILL.md: add explicit MUST rules requiring agents to run task check (or equivalent validation) before committing, and to never skip test execution even when changes appear trivial. Add a MUST NOT rule against committing without validation.

Task B (create spec task, issue #123): Change lifecycle gate skipped when agent receives broad 'proceed' instruction on multi-file changes. Strengthen the /deft:change rule in main.md to require per-change spec coverage even when user says 'proceed'. Add a PR template checklist item in .github/PULL_REQUEST_TEMPLATE.md confirming spec coverage. Add enforcement to deft-build SKILL.md.

Task C (create spec task, issue #138): Branching requirement too prescriptive for single-author projects. Relax the change lifecycle rule in main.md for solo contexts — when a project has a single author (or user opts in), allow direct commits to the default branch for small changes. Full config-driven approach deferred to Phase 5 (#77). This is a content fix only.

Task D (create spec task, issue #139): Agent skips vbrief source step and writes SPECIFICATION.md directly. Strengthen the prohibition in main.md and skills/deft-build/SKILL.md: add MUST NOT rule against writing SPECIFICATION.md without first generating or updating the vbrief source file. Add a validation step that checks vbrief source exists and is newer than SPECIFICATION.md before allowing spec generation. Address together with #68 and #123 enforcement improvements.

STEP 3 — Validate: Run task check. Fix any failures.

STEP 4 — Commit: Add CHANGELOG.md entries under [Unreleased].
Commit with message: fix(enforcement): strengthen testing protocols, change lifecycle gate, solo branching, vbrief source prohibition (#68, #123, #138, #139) — with bullet-point body.

STEP 5 — Push and PR: Push branch to origin. Create draft PR targeting master using gh CLI.
PR title: fix(enforcement): core quality gates and lifecycle rules (#68, #123, #138, #139)
PR body must include: Closes #68, Closes #123, Closes #138, Closes #139

STEP 6 — Review cycle: Follow skills/deft-review-cycle/SKILL.md to run the
Greptile review cycle on the PR. Do NOT merge — leave for human review.

CONSTRAINTS:
- Do not touch skills/deft-setup/SKILL.md, AGENTS.md, skills/deft-review-cycle/SKILL.md, README.md, or any file under cmd/deft-install/
- CHANGELOG.md and SPECIFICATION.md are append-only — add entries, do not edit existing content
- Use conventional commits: type(scope): description
- Run task check before every commit
- Never force-push
"@

oz agent run --prompt $prompt
