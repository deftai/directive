<!-- deft:managed-section v3 -->
# Deft — AI Development Framework

Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md

! If any .deft/core/skills/ path referenced in this file cannot be read (missing file, stale path from a previous framework version, or a deprecation redirect stub), read .deft/core/QUICK-START.md instead and follow it. QUICK-START refreshes this section idempotently for the current framework version.

## Pre-Cutover Check (run before First Session / Returning Sessions)

! Before the First Session / Returning Sessions checks below, detect whether this project pre-dates the v0.20 vBRIEF-centric model. If it does, migration MUST happen before any Phase 1, Phase 2, or Returning-Sessions routing fires.

**Pre-cutover detected** if ANY of the following are true:

- ./SPECIFICATION.md exists and is neither a deprecation redirect nor a current generated spec export. A current generated spec export contains `<!-- Purpose: rendered specification -->` and `<!-- Source of truth: vbrief/specification.vbrief.json -->`, and `./vbrief/specification.vbrief.json` plus all five lifecycle folders exist. This mirrors `.deft/core/scripts/_precutover.py`.
- ./PROJECT.md exists and is not a deprecation redirect (`<!-- deft:deprecated-redirect -->` or `<!-- Purpose: deprecation redirect -->`).
- ./vbrief/ exists but any of the five lifecycle subfolders (proposed/, pending/, active/, completed/, cancelled/) is missing

→ On detection: read .deft/core/skills/deft-directive-setup/SKILL.md "Pre-Cutover Detection Guard" section and follow the migration path BEFORE any other action. The Migrating from pre-v0.20 section of the full guidelines has the canonical command, the "task -t ./.deft/core/Taskfile.yml migrate:vbrief" fallback (for when "task deft:migrate:vbrief" is not resolvable from the project root), what migration produces, and the available safety flags.

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
2. **`task deft:doctor`** -- install-integrity + toolchain + AGENTS.md managed-section freshness probe (#1308). Halts the ritual on a persistent-dirty state; surfaces remediation hints. When the managed-section is stale, the doctor points the operator at `task deft:agents:refresh` to regenerate AGENTS.md from `templates/agents-entry.md`.
   The canonical `scripts/doctor.py` (single owner post #1335/#1336) also detects payload staleness from the `<install>/VERSION` manifest and, when behind, emits the canonical headless upgrade command `deft-install --yes --upgrade --repo-root . --json` (#1339 / #1409). The installer itself calls `scripts/doctor.py --session --json` at the end of every run for the unified handoff.

**Canonical bootstrap / update path (#1339 #1340 #1409 Epic-5/6):** Use the published platform installer binary (from GitHub Releases) as the single deterministic entrypoint. For an existing install, the canonical headless refresh is `deft-install --yes --upgrade --repo-root . --json` (drop `--json` for human-readable output) -- it replaces the payload + manifest + AGENTS.md in one shot. Legacy `task deft:upgrade` / `run upgrade` are metadata-only acknowledgment (they do NOT replace the payload) and `task deft:relocate -- --confirm` is back-compat only; git-clone / submodule / legacy doctor surfaces are de-emphasized in UPGRADING.md / README / skills. Agent example: after running the installer command, start your session; the doctor output (or `task deft:doctor`) tells you the exact state and whether a re-install is needed for freshness.
3. **Branch-policy disclosure** -- see `## Branch Policy Disclosure (#746)` below; emitted only when `plan.policy.allowDirectCommitsToMaster = true`.
4. **`task deft:triage:welcome`** -- emits the triage one-liner and, when state is incomplete, nudges the operator at `task deft:triage:welcome --onboard` (#1143). Default mode is non-interactive; the `--onboard` flag runs the 6-phase interactive ritual.
5. **`task deft:verify:cache-fresh`** -- warning is printed only when the cache is stale (#1127); silent on a fresh cache.

## Resume nudge (conditional, #1269)

Reserved placement for the optional 6th conditional step (resume nudge from the ritual sentinel) tracked by #1269. The substance lands with that PR; this anchor exists today so consumers see the canonical placement once #1269 merges and the sentinel becomes available.

⊗ Reorder, skip, or merge the five steps above without an explicit operator override -- the canonical order is what makes the downstream gate stack composable.

## WIP cap

The `plan.policy.wipCap` field caps the number of in-flight scope vBRIEFs (`vbrief/pending/` + `vbrief/active/`). The framework default is 10 (per umbrella #1119 Current Shape v3). When the cap is reached, `task deft:scope:promote` refuses with a relief hint pointing at `task deft:scope:demote --batch --older-than-days 30` (D1 / #1121). Operators can override the cap from the consumer side via `task deft:triage:welcome --onboard` (the Phase 4 wipCap prompt) or by inspecting / editing the typed field via `task deft:policy:show --field=wipCap`.

## Cache-as-authoritative work selection (#1149)

! When the operator asks "what should I work on next?" / "build a cohort" / "what's the queue?", run `task deft:triage:queue --limit=10` (D11 / #1128) and present the ranked list before suggesting anything else. The agent MUST NOT recommend work from memory or open-GitHub-issue intuition. This is the consumer-side mirror of the maintainer rule of the same name; the triage queue is the source of truth for what to work on next.

⊗ Recommend a specific issue or vBRIEF without consulting `task deft:triage:queue` (or showing the operator the result of the consultation).

## Skill Routing

When user input matches a trigger keyword, read the corresponding skill (paths are relative to the consumer's project root and resolve under `.deft/core/skills/`):

- "review cycle" / "check reviews" / "run review cycle" -> `.deft/core/skills/deft-directive-review-cycle/SKILL.md`
- "swarm" / "parallel agents" / "run agents" -> `.deft/core/skills/deft-directive-swarm/SKILL.md`
- "decompose" / "story decomposition" / "swarm readiness" -> `.deft/core/skills/deft-directive-decompose/SKILL.md`
- "refinement" / "reprioritize" / "refine" / "triage" / "pre-ingest" / "action menu" -> `.deft/core/skills/deft-directive-refinement/SKILL.md` -- the `work the cache` phrase routes to the dedicated `deft-directive-triage` entry below (#1130), not here, to keep routing unambiguous.
- "triage <N>" / "triage issue" / "ingest issue" -> `.deft/core/skills/deft-directive-refinement/SKILL.md`
- "build" / "implement" / "implement spec" -> `.deft/core/skills/deft-directive-build/SKILL.md`
- "cost" / "budget" / "pre-build cost" / "how much will this cost" -> `.deft/core/skills/deft-directive-cost/SKILL.md`
- "setup" / "bootstrap" / "onboard" -> `.deft/core/skills/deft-directive-setup/SKILL.md`
- "sync" / "good morning" / "update deft" / "update vbrief" / "sync frameworks" -> `.deft/core/skills/deft-directive-sync/SKILL.md`
- "pre-pr" / "quality loop" / "rwldl" / "self-review" -> `.deft/core/skills/deft-directive-pre-pr/SKILL.md`
- "interview loop" / "q&a loop" / "run interview loop" -> `.deft/core/skills/deft-directive-interview/SKILL.md`
- "run probe" / "/deft:run:probe" / "probe" -> `.deft/core/skills/deft-directive-probe/SKILL.md`
- "glossary" / "ubiquitous language" / "domain model" / "DDD" / "define terms" -> `.deft/core/skills/deft-directive-glossary/SKILL.md`
- "improve architecture" / "deep modules" / "interface design" / "refactor RFC" -> `.deft/core/skills/deft-directive-gh-arch/SKILL.md`
- "triage hygiene" / "work the cache" -> `.deft/core/skills/deft-directive-triage/SKILL.md`
- "what's next" / "queue" / "build a cohort" -> `.deft/core/skills/deft-directive-triage/SKILL.md`
- "welcome" / "onboard triage" -> invokes `task deft:triage:welcome --onboard` (N3 / #1143)

The `deft-directive-release` skill is intentionally excluded -- it cuts deft framework releases against a temp clone of `deftai/directive` and is not a consumer-facing surface.

## Branch policy & branch verification

Three consumer-facing surfaces enforce the branch-policy contract (#746 / #747):

- `task deft:verify:branch` -- pre-commit gate wired into the `task deft:check` aggregate; refuses a commit on the default branch unless `plan.policy.allowDirectCommitsToMaster = true` (typed) or `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` is set.
- `.githooks/pre-commit` / `pre-push` -- local hooks installed via `task deft:setup`; verify via `task deft:verify:hooks-installed`.
- `task deft:policy:show --field=allowDirectCommitsToMaster` -- inspect the resolved policy; `task deft:policy:allow-direct-commits -- --confirm` writes the typed override with an audit row.

## Branch Policy Disclosure (#746)

When the active project's `vbrief/PROJECT-DEFINITION.vbrief.json` has `plan.policy.allowDirectCommitsToMaster = true`, the agent MUST surface the policy state at the start of any interactive session (immediately after the Deft Directive alignment confirmation):

> "[deft policy] Direct commits to the default branch are ENABLED (source: typed). Branch-protection policy is OFF."

This phrasing comes from `.deft/core/scripts/policy.py::disclosure_line` and stays in lockstep with the typed surface (#746). When the policy is OFF (default; `allowDirectCommitsToMaster=false`), no session-start disclosure is required -- the absence of the disclosure line itself signals the default-enforcing state.

Override paths the user may invoke:
- `task deft:policy:show` -- inspect resolved policy
- `task deft:policy:enforce-branches` -- re-enable branch protection
- `task deft:policy:allow-direct-commits -- --confirm` -- re-confirm opt-out (audited)
- `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` -- emergency env-var bypass

⊗ Begin a session that will commit/push without surfacing the policy state when allowDirectCommitsToMaster=true.

## PowerShell

**Grok Build Windows capture limitations (#1353):** When running under the Grok Build runtime on Windows + pwsh 7+, `run_terminal_command` leaks internal wrapper text (Get-Content and redirection fragments) whenever the command string contains `|`, `2>&1`, `| cat`, `>`, or similar metacharacters. Non-piped commands execute cleanly.

- ! Never emit commands containing pipes or redirections through the agent shell tool on this platform. For anything requiring a pipe, use one of: Python one-liners with `pathlib` / `subprocess.run(capture_output=True)` (preferred -- bypasses the wrapper at the OS level), run the operation in the user's native terminal and paste the result back, or isolate the work in a dedicated worktree and mark the step as "user shell required".
- ! This rule applies to the Grok Build runtime (pwsh 7+); Warp + Claude (PTY-based) is not affected.

Cross-reference: `.deft/core/docs/analysis/2026-05-26-issue-1353-grok-windows-capture-opensrc-audit.md`. Refs #1353.

## Development Process

### Implementation Intent Gate (#810)

- ! Run `task deft:vbrief:preflight -- <path>` before any code-writing tool call or `start_agent` dispatch -- the gate exits 0 only when the candidate vBRIEF lives in `vbrief/active/` AND `plan.status == "running"`. The Taskfile target resolves the wrapped script via `.deft/core/scripts/_resolve_preflight_path.py` (which probes the canonical, legacy, and in-repo install layouts in priority order) and fails closed with a structured `gate misconfigured` error pointing at `task deft:framework:doctor` if no candidate resolves -- the gate cannot silently fail open on a misconfigured install (#1046 / #1047). The helper names `task deft:vbrief:activate <path>` as its idempotent activation companion; story workflows should use the Story Start Gate below to bridge proposed/pending scope through `task deft:scope:promote` and `task deft:scope:activate` before invoking preflight.
- ! Require an explicit action-verb directive (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`) from the user before invoking the preflight gate or `start_agent` for implementation. When intent is ambiguous, ask one targeted question instead of inferring.
- ⊗ Infer implementation intent from lifecycle vocabulary ("do the full PR process", "start the work", "poller agents"), branching language, or workflow shape. Workflow-shape vocabulary is NOT authorization to spawn an implementation agent.
- ⊗ Treat affirmative continuation phrases (`yes`, `go`, `proceed`, `do it`) as implementation authorization unless the prior turn explicitly proposed implementation. Broad approval is not a substitute for an explicit action-verb directive.

### Story Start Gate

- ! Before starting any new implementation story or switching from one story to another, run `git status --short --branch`.
- ! If the working tree is dirty, stop and summarize the current branch, modified/untracked files, and whether the changes appear related to the next story. Ask the operator to choose one path: commit existing work, stash existing work, include existing work in the current story, or stop.
- ⊗ Begin a new story while unrelated dirty work is present without explicit operator approval.
- ! Resolve exactly one target story vBRIEF path by default. Batching multiple stories requires explicit operator approval and a short rationale.
- ! When invoked as part of a swarm cohort dispatch, the approved Phase 5 allocation plan satisfies the "explicit operator approval and a short rationale" requirement above -- the dispatched paths and allocation rationale ARE the consent token. Do NOT re-prompt the parent for batching approval mid-cohort; the all-or-nothing dispatch envelope rule (#954) forbids mid-scope user-approval gates.
- ! Within a swarm cohort, between stories, the working tree MUST be clean (a checkpoint commit + `task deft:scope:complete` just landed). If `git status --short` shows uncommitted state between stories, checkpoint-commit it and proceed -- do NOT pause to ask the operator. The dirty-tree "ask the operator" branch above applies only at the FIRST story-start of a fresh branch.
- ! If the target story is in `vbrief/proposed/`, run `task deft:scope:promote -- <path>` first; if it is in `vbrief/pending/`, run `task deft:scope:activate -- <path>`. After activation, run `task deft:vbrief:preflight -- <active-story-path>` before code-writing.
- ! Default to one story per branch/PR. Create a checkpoint commit after each completed story before beginning another story, unless the operator explicitly approved batching.
- ! After checks pass for the story, complete the lifecycle with `task deft:scope:complete -- <active-story-path>` before final PR handoff.
- ! Before dispatching an implementation sub-agent, run the deterministic Gate 0 `task deft:verify:story-ready -- --vbrief-path <active-story-path> [--allocation-context <dispatch-envelope-file>]` ahead of `task deft:vbrief:preflight`. It machine-checks a clean working tree (or `--allow-dirty`), the target vBRIEF in `vbrief/active/` with `plan.status == "running"`, and the dispatch envelope's `## Allocation context` consent token; three-state exit (0 ready / 1 not ready / 2 config error). A `swarm-cohort` section is ready only when `allocation_plan_id` AND `batching_rationale` are non-null; an absent section is the solo path. Any non-zero exit aborts dispatch.

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
