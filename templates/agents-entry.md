<!-- deft:managed-section v1 -->
# Deft — AI Development Framework

Deft is installed in deft/. Full guidelines: deft/main.md

! If any deft/skills/ path referenced in this file cannot be read (missing file, stale path from a previous framework version, or a deprecation redirect stub), read deft/QUICK-START.md instead and follow it. QUICK-START refreshes this section idempotently for the current framework version.

## Pre-Cutover Check (run before First Session / Returning Sessions)

! Before the First Session / Returning Sessions checks below, detect whether this project pre-dates the v0.20 vBRIEF-centric model. If it does, migration MUST happen before any Phase 1, Phase 2, or Returning-Sessions routing fires.

**Pre-cutover detected** if ANY of the following are true:

- ./SPECIFICATION.md exists and its first 200 characters do NOT contain <!-- deft:deprecated-redirect -->
- ./PROJECT.md exists and its first 200 characters do NOT contain <!-- deft:deprecated-redirect -->
- ./vbrief/ exists but any of the five lifecycle subfolders (proposed/, pending/, active/, completed/, cancelled/) is missing

→ On detection: read deft/skills/deft-directive-setup/SKILL.md "Pre-Cutover Detection Guard" section and follow the migration path BEFORE any other action. The Migrating from pre-v0.20 section of the full guidelines has the canonical command, the "task -t ./deft/Taskfile.yml migrate:vbrief" fallback (for when "task migrate:vbrief" is not resolvable from the project root), what migration produces, and the available safety flags.

⊗ Start Phase 1, Phase 2, or a Returning-Sessions workflow while pre-cutover artifacts are present — run migration first.

## First Session

Check what exists before doing anything else:

**USER.md missing** (~/.config/deft/USER.md or %APPDATA%\deft\USER.md):
→ Read deft/skills/deft-directive-setup/SKILL.md and start Phase 1 (user preferences)

**USER.md exists, PROJECT-DEFINITION.vbrief.json missing** (./vbrief/):
→ Read deft/skills/deft-directive-setup/SKILL.md and start Phase 2 (project definition)

## Returning Sessions

When all config exists: read the guidelines, your USER.md preferences, and PROJECT-DEFINITION.vbrief.json, then continue with your task.

~ Run deft/skills/deft-directive-sync/SKILL.md to pull latest framework updates and validate project files.

## Branch Policy Disclosure (#746)

When the active project's `vbrief/PROJECT-DEFINITION.vbrief.json` has `plan.policy.allowDirectCommitsToMaster = true`, the agent MUST surface the policy state at the start of any interactive session (immediately after the Deft Directive alignment confirmation):

> "[deft policy] Direct commits to the default branch are ENABLED (source: typed). Branch-protection policy is OFF."

This phrasing comes from `deft/scripts/policy.py::disclosure_line` and stays in lockstep with the typed surface (#746). When the policy is OFF (default; `allowDirectCommitsToMaster=false`), no session-start disclosure is required -- the absence of the disclosure line itself signals the default-enforcing state.

Override paths the user may invoke:
- `task policy:show` -- inspect resolved policy
- `task policy:enforce-branches` -- re-enable branch protection
- `task policy:allow-direct-commits -- --confirm` -- re-confirm opt-out (audited)
- `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` -- emergency env-var bypass

⊗ Begin a session that will commit/push without surfacing the policy state when allowDirectCommitsToMaster=true.

## Commands

- /deft:change <name>        — Propose a scoped change
- /deft:run:interview        — Structured spec interview
- /deft:run:speckit          — Five-phase spec workflow (large projects)
- /deft:run:discuss <topic>  — Feynman-style alignment
- /deft:run:research <topic> — Research before planning
- /deft:run:map              — Map an existing codebase
- deft/run bootstrap         — CLI setup (terminal users)
- deft/run spec              — CLI spec generation
<!-- /deft:managed-section -->
