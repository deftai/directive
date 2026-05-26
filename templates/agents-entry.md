<!-- deft:managed-section v3 -->
# Deft — AI Development Framework

Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md

! If any .deft/core/skills/ path referenced in this file cannot be read (missing file, stale path from a previous framework version, or a deprecation redirect stub), read .deft/core/QUICK-START.md instead and follow it. QUICK-START refreshes this section idempotently for the current framework version.

## Pre-Cutover Check (run before First Session / Returning Sessions)

! Before the First Session / Returning Sessions checks below, detect whether this project pre-dates the v0.20 vBRIEF-centric model. If it does, migration MUST happen before any Phase 1, Phase 2, or Returning-Sessions routing fires.

**Pre-cutover detected** if ANY of the following are true:

- ./SPECIFICATION.md exists and its first 200 characters do NOT contain <!-- deft:deprecated-redirect -->
- ./PROJECT.md exists and its first 200 characters do NOT contain <!-- deft:deprecated-redirect -->
- ./vbrief/ exists but any of the five lifecycle subfolders (proposed/, pending/, active/, completed/, cancelled/) is missing

→ On detection: read .deft/core/skills/deft-directive-setup/SKILL.md "Pre-Cutover Detection Guard" section and follow the migration path BEFORE any other action. The Migrating from pre-v0.20 section of the full guidelines has the canonical command, the "task -t ./.deft/core/Taskfile.yml migrate:vbrief" fallback (for when "task migrate:vbrief" is not resolvable from the project root), what migration produces, and the available safety flags.

⊗ Start Phase 1, Phase 2, or a Returning-Sessions workflow while pre-cutover artifacts are present — run migration first.

## First Session

Check what exists before doing anything else:

**USER.md missing** (~/.config/deft/USER.md or %APPDATA%\deft\USER.md):
→ Read .deft/core/skills/deft-directive-setup/SKILL.md and start Phase 1 (user preferences)

**USER.md exists, PROJECT-DEFINITION.vbrief.json missing** (./vbrief/):
→ Read .deft/core/skills/deft-directive-setup/SKILL.md and start Phase 2 (project definition)

## Returning Sessions

When all config exists: read the guidelines, your USER.md preferences, and PROJECT-DEFINITION.vbrief.json, then continue with your task.

~ Run .deft/core/skills/deft-directive-sync/SKILL.md to pull latest framework updates and validate project files.

## Session-start ritual (#1149)

! On every interactive session start, the agent performs these five steps in the canonical order below. Each step is a hand-off into a more specific rule documented elsewhere in this file; the ordering itself is the rule and downstream gates (the #810 implementation-intent gate, the branch-policy gate, the pre-`start_agent` gate stack) rely on it.

1. **Deft alignment confirmation** -- state that Deft Directive is active and AGENTS.md was loaded (the unambiguous confirmation phrase the user expects at the top of every interactive session).
2. **`task doctor`** -- install-integrity + toolchain + AGENTS.md managed-section freshness probe (#1308). Halts the ritual on a persistent-dirty state; surfaces remediation hints. When the managed-section is stale, the doctor points the operator at `task agents:refresh` to regenerate AGENTS.md from `templates/agents-entry.md`.
3. **Branch-policy disclosure** -- see `## Branch Policy Disclosure (#746)` below; emitted only when `plan.policy.allowDirectCommitsToMaster = true`.
4. **`task triage:welcome`** -- emits the triage one-liner and, when state is incomplete, nudges the operator at `task triage:welcome --onboard` (#1143). Default mode is non-interactive; the `--onboard` flag runs the 6-phase interactive ritual.
5. **`task verify:cache-fresh`** -- warning is printed only when the cache is stale (#1127); silent on a fresh cache.

## Resume nudge (conditional, #1269)

Reserved placement for the optional 6th conditional step (resume nudge from the ritual sentinel) tracked by #1269. The substance lands with that PR; this anchor exists today so consumers see the canonical placement once #1269 merges and the sentinel becomes available.

⊗ Reorder, skip, or merge the five steps above without an explicit operator override -- the canonical order is what makes the downstream gate stack composable.

## WIP cap

The `plan.policy.wipCap` field caps the number of in-flight scope vBRIEFs (`vbrief/pending/` + `vbrief/active/`). The framework default is 10 (per umbrella #1119 Current Shape v3). When the cap is reached, `task scope:promote` refuses with a relief hint pointing at `task scope:demote --batch --older-than-days 30` (D1 / #1121). Operators can override the cap from the consumer side via `task triage:welcome --onboard` (the Phase 4 wipCap prompt) or by inspecting / editing the typed field via `task policy:show --field=wipCap`.

## Cache-as-authoritative work selection (#1149)

! When the operator asks "what should I work on next?" / "build a cohort" / "what's the queue?", run `task triage:queue --limit=10` (D11 / #1128) and present the ranked list before suggesting anything else. The agent MUST NOT recommend work from memory or open-GitHub-issue intuition. This is the consumer-side mirror of the maintainer rule of the same name; the triage queue is the source of truth for what to work on next.

⊗ Recommend a specific issue or vBRIEF without consulting `task triage:queue` (or showing the operator the result of the consultation).

## Skill Routing

When user input matches a trigger keyword, read the corresponding skill (paths are relative to the consumer's project root and resolve under `.deft/core/skills/`):

- "review cycle" / "check reviews" / "run review cycle" -> `.deft/core/skills/deft-directive-review-cycle/SKILL.md`
- "swarm" / "parallel agents" / "run agents" -> `.deft/core/skills/deft-directive-swarm/SKILL.md`
- "decompose" / "story decomposition" / "swarm readiness" -> `.deft/core/skills/deft-directive-decompose/SKILL.md`
- "refinement" / "reprioritize" / "refine" -> `.deft/core/skills/deft-directive-refinement/SKILL.md`
- "triage <N>" / "triage issue" / "ingest issue" -> `.deft/core/skills/deft-directive-refinement/SKILL.md`
- "build" / "implement" / "implement spec" -> `.deft/core/skills/deft-directive-build/SKILL.md`
- "cost" / "budget" / "pre-build cost" / "how much will this cost" -> `.deft/core/skills/deft-directive-cost/SKILL.md`
- "setup" / "bootstrap" / "onboard" -> `.deft/core/skills/deft-directive-setup/SKILL.md`
- "sync" / "good morning" / "update deft" / "update vbrief" / "sync frameworks" -> `.deft/core/skills/deft-directive-sync/SKILL.md`
- "pre-pr" / "quality loop" / "rwldl" / "self-review" -> `.deft/core/skills/deft-directive-pre-pr/SKILL.md`
- "interview loop" / "q&a loop" / "run interview loop" -> `.deft/core/skills/deft-directive-interview/SKILL.md`
- "glossary" / "ubiquitous language" / "domain model" / "DDD" / "define terms" -> `.deft/core/skills/deft-directive-glossary/SKILL.md`
- "improve architecture" / "deep modules" / "interface design" / "refactor RFC" -> `.deft/core/skills/deft-directive-gh-arch/SKILL.md`
- "triage hygiene" / "work the cache" -> `.deft/core/skills/deft-directive-triage/SKILL.md`
- "what's next" / "queue" / "build a cohort" -> `.deft/core/skills/deft-directive-triage/SKILL.md`
- "welcome" / "onboard triage" -> invokes `task triage:welcome --onboard` (N3 / #1143)

The `deft-directive-release` skill is intentionally excluded -- it cuts deft framework releases against a temp clone of `deftai/directive` and is not a consumer-facing surface.

## Branch policy & branch verification

Three consumer-facing surfaces enforce the branch-policy contract (#746 / #747):

- `task verify:branch` -- pre-commit gate wired into the `task check` aggregate; refuses a commit on the default branch unless `plan.policy.allowDirectCommitsToMaster = true` (typed) or `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` is set.
- `.githooks/pre-commit` / `pre-push` -- local hooks installed via `task setup`; verify via `task verify:hooks-installed`.
- `task policy:show --field=allowDirectCommitsToMaster` -- inspect the resolved policy; `task policy:allow-direct-commits -- --confirm` writes the typed override with an audit row.

## Branch Policy Disclosure (#746)

When the active project's `vbrief/PROJECT-DEFINITION.vbrief.json` has `plan.policy.allowDirectCommitsToMaster = true`, the agent MUST surface the policy state at the start of any interactive session (immediately after the Deft Directive alignment confirmation):

> "[deft policy] Direct commits to the default branch are ENABLED (source: typed). Branch-protection policy is OFF."

This phrasing comes from `.deft/core/scripts/policy.py::disclosure_line` and stays in lockstep with the typed surface (#746). When the policy is OFF (default; `allowDirectCommitsToMaster=false`), no session-start disclosure is required -- the absence of the disclosure line itself signals the default-enforcing state.

Override paths the user may invoke:
- `task policy:show` -- inspect resolved policy
- `task policy:enforce-branches` -- re-enable branch protection
- `task policy:allow-direct-commits -- --confirm` -- re-confirm opt-out (audited)
- `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` -- emergency env-var bypass

⊗ Begin a session that will commit/push without surfacing the policy state when allowDirectCommitsToMaster=true.

## PowerShell

**Grok Build Windows capture limitations (#1353):** When running under the Grok Build runtime on Windows + pwsh 7+, `run_terminal_command` leaks internal wrapper text (Get-Content and redirection fragments) whenever the command string contains `|`, `2>&1`, `| cat`, `>`, or similar metacharacters. Non-piped commands execute cleanly.

- ! Never emit commands containing pipes or redirections through the agent shell tool on this platform. For anything requiring a pipe, use one of: Python one-liners with `pathlib` / `subprocess.run(capture_output=True)` (preferred -- bypasses the wrapper at the OS level), run the operation in the user's native terminal and paste the result back, or isolate the work in a dedicated worktree and mark the step as "user shell required".
- ! This rule applies to the Grok Build runtime (pwsh 7+); Warp + Claude (PTY-based) is not affected.

Cross-reference: `.deft/core/docs/analysis/2026-05-26-issue-1353-grok-windows-capture-opensrc-audit.md`. Refs #1353.

## Development Process

### Implementation Intent Gate (#810)

- ! Run `task vbrief:preflight -- <path>` before any code-writing tool call or `start_agent` dispatch -- the gate exits 0 only when the candidate vBRIEF lives in `vbrief/active/` AND `plan.status == "running"`. The Taskfile target resolves the wrapped script via `.deft/core/scripts/_resolve_preflight_path.py` (which probes the canonical, legacy, and in-repo install layouts in priority order) and fails closed with a structured `gate misconfigured` error pointing at `task framework:doctor` if no candidate resolves -- the gate cannot silently fail open on a misconfigured install (#1046 / #1047). The ONLY supported way to satisfy a non-zero gate exit is `task vbrief:activate <path>` (idempotent).
- ! Require an explicit action-verb directive (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`) from the user before invoking the preflight gate or `start_agent` for implementation. When intent is ambiguous, ask one targeted question instead of inferring.
- ⊗ Infer implementation intent from lifecycle vocabulary ("do the full PR process", "start the work", "poller agents"), branching language, or workflow shape. Workflow-shape vocabulary is NOT authorization to spawn an implementation agent.
- ⊗ Treat affirmative continuation phrases (`yes`, `go`, `proceed`, `do it`) as implementation authorization unless the prior turn explicitly proposed implementation. Broad approval is not a substitute for an explicit action-verb directive.

## Commands

- /deft:change <name>        — Propose a scoped change
- /deft:run:interview        — Structured spec interview
- /deft:run:speckit          — Five-phase spec workflow (large projects)
- /deft:run:discuss <topic>  — Feynman-style alignment
- /deft:run:research <topic> — Research before planning
- /deft:run:map              — Map an existing codebase
- .deft/core/run bootstrap         — CLI setup (terminal users)
- .deft/core/run spec              — CLI spec generation
<!-- /deft:managed-section -->
