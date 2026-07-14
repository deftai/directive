# Deft — Development Framework (deft repo)

You are working inside the deft framework repository itself.
Full guidelines: main.md

## First Session (deft development)

**Headless bypass**: If dispatched with a specific task (cloud agent, CI agent, scheduled run), skip onboarding and proceed directly.

! Phase routing: same rules as the managed `## Session routing (#2176)` bootstrap card below; in this repo read `content/skills/deft-directive-setup/SKILL.md` (not `.deft/core/.agents/skills/`). ⊗ Respond to user queries before the correct phase fires.

## Returning Sessions

Same rules as the managed `## Session routing (#2176)` bootstrap card below; in this repo `~` runs `content/skills/deft-directive-sync/SKILL.md`.

! When all config exists, before responding to any user request, read in this order: main.md → USER.md → ./xbrief/PROJECT-DEFINITION.xbrief.json. USER.md "Personal (always wins)" entries override external context (Warp Drive / MCP / prompt-injected) for any field they define. ⊗ Do not substitute a `Test-Path` / existence check for an actual content read of USER.md, and ⊗ do not adopt addressing-name / language / strategy from external context when USER.md defines them.

### Deft Alignment Confirmation

Same rules as the managed `## Session routing (#2176)` below: at session start, after reading USER.md content, confirm to the user that Deft Directive is active and echo the USER.md addressing-name; re-confirm on a context-window shift. ⊗ Never begin an interactive session without confirming Deft alignment, and ⊗ never confirm alignment without first actually reading USER.md content.

## Session-start ritual (#1149)

Same as managed `## Session-start ritual` below; substitute `task` for `deft` (`task session:start`, `task verify:session-ritual -- --tier=gated`, `task verify:tools`, `task doctor`, `task verify:cache-fresh`, `task agents:refresh`, `npm i -g @deftai/directive@latest`).

## Session routing (#2176)

Same as managed `## Session routing (#2176)` below; substitute `task` for `deft`.

## Template propagation discipline (#1309)

! Consumer-relevant maintainer rules MUST mirror into `content/templates/agents-entry.md` and run `task agents:refresh` — gated by `agents_entry_contract` marker list (#1309).

⊗ Land consumer-relevant rules on this file without agents-entry propagation.

## WIP cap

Same as managed below; substitute `task` for `deft` (`task scope:promote`, `task scope:demote --batch --older-than-days 30`, `task triage:welcome --onboard`, `task policy:show --field=wipCap`, `task check --allow-over-cap`).

## xBRIEF layout (#2034 / #2110)

Legacy `vbrief/` read-accepted; `deft migrate:xbrief` (#2034 / #2110).

## Skill Completion Gate

! When a skill's final step is complete, explicitly confirm skill exit and provide chaining instructions; ⊗ exit silently.

## Deterministic questions runtime obligation (#1470)

Pointer-sufficient managed section below; `content/contracts/deterministic-questions.md` (#767).

## Review-surface precedence (#2308)

! `content/skills/deft-directive-review-cycle/SKILL.md`; host tools advisory-only (#2308).

## Value feedback and attribution (#1709)

! `task policy:show --field=valueFeedback` / `task policy:enable-value-feedback -- --confirm`; `task value:show`; `task feedback:file`; `content/skills/deft-directive-feedback/SKILL.md` (#1709).

## Eval and framework health (#1703)

! `task eval:health`; `task eval:run` / `task eval:report` (#1703).

## Cache-as-authoritative work selection (#1149)

Same managed `#1149` / `#2402` rules below (`task` for `deft`; `task triage:queue`, `task plan-sequence:current`). Detail: preamble § 2.55 + `commands.md` § Backlog Triage.

## Codebase MAP Projection (#1595 / #1498)

Same as managed below; `task codebase:map`, `task verify:codebase-map-fresh`.

## Skills

See managed `## Skills` below and the **Skills Index** in `REFERENCES.md`; maintainer skill paths use `content/skills/`. The `welcome` / `onboard triage` trigger invokes `task triage:welcome --onboard` (N3 / #1143).

## Development Process (always follow)

### Implementation Intent Gate (#810)

Same as managed below; `task xbrief:preflight -- <path>` — `content/commands.md` § Scope xBRIEF Lifecycle (#810).

### Story Start Gate

Same as managed below; `task verify:story-ready`, `task scope:promote -- <path>`, `task scope:activate -- <path>`, `task scope:complete -- <active-story-path>` (#1378).

**Before code changes:**
- ! Check `./xbrief/` lifecycle folders for existing scope xBRIEF coverage of the issue being fixed
- ! If no scope xBRIEF exists for the work, create one in `./xbrief/proposed/` before implementing
- ⊗ Begin editing files before checking scope xBRIEF coverage and creating a feature branch — even if the user says "yes" or "proceed"

! Before opening a PR, run `content/skills/deft-directive-pre-pr/SKILL.md`. Before committing: `task check`; `task verify:forward-coverage` (#1310); CHANGELOG `[Unreleased]`.

! Branching: feature branches only (`task verify:branch`, `.githooks/pre-commit` / `.githooks/pre-push`, `branch-gate` workflow). Override: `task policy:allow-direct-commits -- --confirm`; emergency `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`. When `plan.policy.allowDirectCommitsToMaster = true`, surface via `task policy:show --field=allowDirectCommitsToMaster` (Branch Policy Disclosure).

## CHANGELOG entry style (#1242)

! Brief release-notes — `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § CHANGELOG entry style (#1242).

## Contextual guardrails (runtime-detect lazy-load)

Same as managed below; `task verify:encoding`, `task verify:scm-boundary`, `task pr:wait-mergeable-and-merge`; `content/scm/github.md` (#2157 / #2369).

## Headless swarm launch gate-stack (#1387)

Rationale + cross-references: `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Headless swarm launch gate-stack (#1387).

- ! When the operator supplies a pre-approved cohort via the **C1** CLI `task swarm:launch -- --stories <ids|paths> [--group <label>] [--worktree-map <path>] [--base-branch <branch>] [--autonomous]`, the swarm skill's Phase 0 per-phase approval gates collapse into the SINGLE #1378 `## Allocation context` consent token (`dispatch_kind: swarm-cohort` + non-null `allocation_plan_id` + `batching_rationale`); the interactive promote-fill loop is skipped.
- ! Phase 2 accepts a **pre-created worktree map** (the **C3** JSON array of `{ story_id, worktree_path, base_branch }`) resolved via `resolveWorktreeMap` (`packages/core/src/swarm/worktrees.ts`) -- which raises on same-path collisions or base-branch mismatches -- instead of always running `git worktree add` per agent.
- ! Phase 3 consumes the **C2** launch-manifest (the JSON array of `{ story_id, xbrief_path, worktree_path, branch, allocation_context }`, where `allocation_context` is the #1378 token) emitted by `task swarm:launch` as dispatch PREP before spawning; the spawn itself stays agent-driven via the platform adapter (`start_agent` / `spawn_subagent`). `task swarm:launch` does NOT spawn agents -- it emits the manifest and stops.
- ⊗ Re-prompt the operator for per-phase batching approval when a pre-approved cohort is launched via `task swarm:launch` -- the #1378 allocation-context token is the batched consent (all-or-nothing dispatch envelope, #954).

## Test performance discipline (#975)

! `@pytest.mark.slow` / sub-1s refactor — `CONTRIBUTING.md` § Slow tests (#975); rationale in `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Test performance discipline.

## Multi-agent orchestration discipline (#954)

Rationale: `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Multi-agent orchestration discipline (#954). Canonical preamble: `content/templates/agent-prompt-preamble.md`.

- ! When invoking `gh` for read-only operations, prefer REST surfaces over GraphQL -- forbid `gh issue view --json`, `gh pr view --json`, `gh pr ready`, `gh pr update-branch` (all GraphQL); use `gh api repos/<owner>/<repo>/issues/<N>` / `gh api repos/<owner>/<repo>/pulls/<N>` (REST) or `ghx api` (cached REST) instead. The GraphQL bucket is shared across all workers under the same identity and is the operational bottleneck, not the REST `core` bucket.
- ! Within a single review cycle, toggle PR Draft↔Ready state at most once. Once Ready, stay Ready unless a P0 finding demands a re-Draft -- each toggle costs a GraphQL mutation and stale Draft re-toggles are the documented failure mode for the PR #652-class merge cascades.
- ! Before any GraphQL-heavy operation (PR readiness check, review polling, batch issue ingest, mass `gh pr list`), probe `gh api rate_limit` (the live, uncached form) and inspect `graphql.remaining`. If < 500, switch to REST equivalents or batch+wait until the bucket resets. The decision tree lives in `content/templates/agent-prompt-preamble.md` § 7. Do NOT use `ghx api rate_limit` for the throttle probe -- ghx is a cached read-only GET proxy, so the cached value can be stale; under N-concurrent-workers the GraphQL bucket can deplete within minutes between probe and use, causing an agent to proceed into GraphQL-heavy work against an exhausted bucket.
- ! Dispatcher-level lifecycle hygiene: workers MUST be all-or-nothing on their dispatch envelope. Mid-scope user-approval gates require two separate dispatches (Scope A → worker reports back → user approves → Scope B). A worker that finishes its tool loop while emitting a "paused, awaiting reply" status message will be observed as `succeeded` (terminal) by the platform; its `agent_id` then becomes unreachable and reply messages have no live runtime to deliver to. Splitting at the gate is the only enforceable mitigation. See `content/templates/agent-prompt-preamble.md` § 9.
- ! Orchestrators dispatching implementation sub-agents MUST include the canonical preamble verbatim (or by reference) in the worker's dispatch envelope -- see `content/templates/agent-prompt-preamble.md`. The preamble covers AGENTS.md read mandate, the #810 xBRIEF gate walkthrough, the PowerShell 5.1 non-ASCII rule (#798), pre-pr + review-cycle skill mandates, the four rules above, sub-agent spawn rules per #727, orchestrator dispatch doctrine (#1880), and the mandatory DONE message protocol.
- ⊗ Dispatch an implementation sub-agent without including the canonical preamble (or a reference to `content/templates/agent-prompt-preamble.md` it can read directly) -- the recurrence patterns above re-fire on every fresh dispatch that omits this institutional memory.

Orchestrator dispatch doctrine (#1880): `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Multi-agent orchestration discipline (#954); canonical prose in `content/templates/agent-prompt-preamble.md` §9.

- ! **Worker-owns-lifecycle (Gap C):** When dispatching an implementation worker, the envelope MUST declare `stop-at: pr-open` OR `drive-to: merge-ready` (default for story work). Workers scoped `drive-to: merge-ready` own PR + review cycle + fix batches through merge-ready as ONE unit of work — they spawn their own review poller per review-cycle monitoring tiers; the orchestrator MUST NOT hand back at PR-open and re-dispatch separate leaf agents for review/fixes.
- ! **Background dispatch (Gap D):** Long-running workers (>~3 min: implementation, fix batches, review-cycle owners, pollers) MUST dispatch independently / in the background (on Cursor: Task tool `run_in_background: true`) so the conversation channel stays interactive; foreground dispatch is for short tasks only.
- ! **Deliberate model routing:** Before ANY sub-agent dispatch (cohort OR single), make a deliberate per-`worker_role` routing decision via `task verify:routing` / `task swarm:routing-set` — never silently inherit the parent model. Deterministic gate enforcement is #1877; this bullet is behavioral doctrine only.
- ⊗ Re-dispatch separate review/fix leaf agents after a `drive-to: merge-ready` implementation worker exits at PR-open (#1880 Gap C).
- ⊗ Foreground/blocking dispatch for long-running implementation, fix, or review-cycle workers when background dispatch is available (#1880 Gap D).
- ! **Deterministic PR-verdict polling (Tier-4 pointer, #1056):** A `drive-to: merge-ready` worker (or a review poller it spawns) that needs to wait on a Greptile/SLizard verdict MUST poll via `task pr:watch -- <N>` — a blocking-by-default poll to a terminal three-state verdict (exit `0` CLEAN / `1` NEW_P0_P1 / `2` ERRORED|STALL|TIMEOUT|config, `--one-shot` for a single probe, `--json` for the structured shape). The invocation IS the wait, so a promise-to-poll cannot silently evaporate. It reuses the canonical Greptile detector and SHA-match gates the verdict to the current HEAD (a stale pre-push review is never read as NEW_P0_P1). The rule body and full flag surface live in the #1056 task/xBRIEF; this is the discovery pointer only.

ghx surface clarification (#954): `ghx` is a cached read-only GET proxy for `gh`, NOT a full drop-in passthrough; `ghx api` accepts a single positional path arg only. Writes (POST/PATCH/PUT/DELETE via `gh api -X ...`) MUST fall through to `gh` directly. Detail: `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Multi-agent orchestration discipline (#954).

## Umbrella current-shape convention (#1152)

Rationale + cross-references: `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Umbrella current-shape convention (#1152). For status reporting, see also managed `## Umbrella status reading` below.

- ! Every umbrella issue MUST have a single canonical `## Current shape (as of pass-N)` comment, edited in place after each design pass.
- ! The current-shape comment MUST list open children, closed children, wave order, and the child-count history.
- ! Before stating an umbrella or epic's current status (what is done, what blocks, wave order), an agent MUST fetch `repos/<owner>/<repo>/issues/<N>/comments` via REST, read the `## Current shape (as of pass-N)` comment, and any linked context or `LockedDecisions` xBRIEF referenced there — following the reading order body -> current-shape comment -> amendment comments (claim-cites-state-surface, #2066). Prefer the deterministic read path: `task umbrella:current-shape <N>` (native deft-ts verb; `--json` / `--strict` supported) — it never falls back to the issue body.
- ~ Pass-N skills SHOULD update the current-shape comment as their Phase 4 step.
- ⊗ Do NOT delete prior amendment comments when updating the current-shape comment — they remain the audit trail.
- ⊗ Do NOT replace the current-shape comment with a fresh comment — it must be edited in place so its permalink is stable.
- ⊗ Conclude umbrella or epic status from the issue body alone. The body is the pass-1 plan (stale by design). Any "X is done" / "X is the blocker" assertion about an umbrella MUST cite the current-shape comment or another state artifact, not the body (#2066).

Canonical body structure (9 required sections): `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Umbrella current-shape convention (#1152).

## Issue body→comments reading (#2143)

Same `!` / `⊗` rules as managed below; `task issue:ingest` (#2143).

Note: root-relative paths (this repo IS deft/); run `task agents:refresh` after agents-entry edits (#1309).

<!-- deft:managed-section v3 sha=38e4871278ce refreshed=2026-07-14T14:16:20Z session=49c5d1308f74 -->
# Deft — AI Development Framework

Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md

! If any .deft/core/.agents/skills/ path referenced in this file cannot be read (missing file, stale path from a previous framework version, or a deprecation redirect stub), read .deft/core/QUICK-START.md instead and follow it. QUICK-START refreshes this section idempotently for the current framework version.

## Session routing (#2176)

! **Read-only default** until mutation intent (Q&A, Plan Mode, ticket-shaping): load AGENTS.md, main.md, USER.md, `xbrief/PROJECT-DEFINITION.xbrief.json`; confirm Deft alignment ("Deft Directive active" + addressing-name from USER.md); ⊗ do not run mutable `deft session:start`, triage welcome, sync, or branch-policy ceremony unless the operator asks or the task is implementation-ready (#2176). Full contract: `.deft/core/commands.md` § Session routing.

**Bootstrap card** (before answering):
- `deft` / `directive` won't run → README.md § Cold-start bootstrap (#2273); ⊗ never `.deft/core/`
- Pre-cutover artifacts → `.deft/core/.agents/skills/deft-directive-setup/SKILL.md` § Pre-Cutover Detection Guard (#2068)
- USER.md missing → setup SKILL Phase 1; `xbrief/PROJECT-DEFINITION.xbrief.json` missing → setup SKILL Phase 2 (#1813); ⊗ respond before phase completes
- Config complete → read main.md → USER.md → PROJECT-DEFINITION (USER.md wins on conflicts); ~ `deft-directive-sync` on return

**Mutation boundary:** code-writing, scope lifecycle, `start_agent`, commits, push, or release → `deft session:start` then `deft verify:session-ritual -- --tier=gated` per `.deft/core/commands.md` § Session-start ritual (#1149).
- ? `deft session:start -- --read-only` — alignment only, no ritual-state (#2176)

## Session-start ritual (#1149)

! On **mutation** session start, run `deft session:start`; before code-writing or `start_agent` dispatch run `deft verify:session-ritual -- --tier=gated` (stale after `plan.policy.sessionRitualStalenessHours`; records `deft verify:tools` / `deft doctor` / `deft verify:cache-fresh` / `deft agents:refresh` / `npm i -g @deftai/directive@latest`; #1149 / #1348) — `.deft/core/commands.md` § Session-start ritual.

## WIP cap

! Respect `plan.policy.wipCap` (default 20) — at cap `deft scope:promote` refuses; relief via `deft scope:demote --batch --older-than-days 30` (#2319 / #1121). Full WIP workflow: `.deft/core/.agents/skills/deft-directive-swarm/SKILL.md`.

## xBRIEF layout (#2034 / #2110)

Projects on legacy `vbrief/` still read-accepted; run `deft migrate:xbrief` for `xbrief/` (v0.6→v0.8). `x-vbrief/` tokens read-accepted until migrated.

## Unmanaged project header (#2065)

! Do NOT treat the unmanaged AGENTS.md header as the work queue; ⊗ Do NOT add `Status`, `Next:`, or `Known Issues` blocks — they rot silently. See UPGRADING.md § AGENTS.md: managed vs unmanaged header for the Session orientation pointer and rationale.

## Cache-as-authoritative work selection (#1149)

! "what next?" → ordered-plan first (#2402 / `deft plan-sequence:*`); else `deft triage:queue --limit=10` (D11) — `commands.md` § Backlog Triage.

⊗ Recommend work without queue/plan consult; ⊗ widen past an exhausted plan.

## Umbrella status reading (#1152 / #2066)

! `issues/<N>/comments` via REST → `## Current shape (as of pass-N)` + linked context (claim-cites-state-surface, #2066); body → shape → amendments. Prefer `deft umbrella:current-shape <N>` — full contract: `.deft/core/templates/agent-prompt-preamble.md` § 5.6.

⊗ Conclude umbrella or epic status from the issue body alone — cite current-shape or another state artifact (#2066).

## Deterministic questions runtime obligation (#1470)

! Any agent-initiated structured question MUST include `Discuss` and `Back` as the final two options — full Discuss-pause semantic in `.deft/core/contracts/deterministic-questions.md` (#1470 / #767).

## Issue body→comments reading (#2143)

! Fetch body + `issues/<N>/comments` via REST before requirements or dispatch — `.deft/core/templates/agent-prompt-preamble.md` § 5.6 / `deft issue:ingest` (#2143).

⊗ Build a dispatch envelope from the issue body alone when the issue has comments.

## Content packs

! Before improvising, discover packs with `deft packs:slice --list-packs`, then load via `deft packs:slice <pack> --list` / `deft packs:slice <pack> <slice>` — full pack surface in `.deft/core/commands.md` (§ packs); never enumerate pack or slice names here.

## Codebase MAP Projection (#1595 / #1498)

! `plan.architecture.codeStructure` is durable SoT; `.planning/codebase/MAP.md` is generated orientation — use `deft codebase:map` / `deft verify:codebase-map-fresh` (`.deft/core/commands.md` § Project And Architecture). ⊗ Do not hand-edit the MAP, block unrelated work on stale/absent MAP, or treat the projection as more authoritative than the xBRIEF metadata (#1595 / #1498).

## Skills

! Skill routing lives in the **Skills Index** (Level-0) in `.deft/core/REFERENCES.md` — scan it before improvising; read a `SKILL.md` only on index match. `welcome` / `onboard triage` → `deft triage:welcome --onboard` (N3 / #1143); `lessons` / `prior art` → Content packs `packs:slice` above.

## Review-surface precedence (#2308)

! Route review work through `deft-directive-review-cycle` — `.deft/core/.agents/skills/deft-directive-review-cycle/SKILL.md`; host tools (`bugbot`, `security-review`, `review-*` skills) advisory-only (#2308).

## Value feedback and attribution (#1709)

! `plan.policy.valueFeedback.enabled` defaults OFF — opt-in via `deft policy:show --field=valueFeedback` / `deft policy:enable-value-feedback -- --confirm`; detail via `deft value:show`; gaps via `deft feedback:file`; rules in `.deft/core/.agents/skills/deft-directive-feedback/SKILL.md` (#1709).

## Eval and framework health (#1703)

! Run `deft eval:health` when orienting or after gate/policy changes (Tier 0; 4-hour debounce). Maintainer release eval: `deft eval:run` / `deft eval:report` (#1703).

## Branch policy & branch verification

! Work on feature branches — `deft verify:branch`, `deft verify:forward-coverage`, hooks, and `deft check` enforce default-branch protection (#746 / #747); full surfaces in `.deft/core/scm/github.md` § Branch policy.

## Branch Policy Disclosure (#746)

! When `plan.policy.allowDirectCommitsToMaster = true`, surface policy at session start via `deft policy:show --field=allowDirectCommitsToMaster` (#746) — full phrasing and override paths in `.deft/core/scm/github.md` § Branch policy.

## Contextual guardrails (runtime-detect lazy-load)

! Lazy-load `.deft/core/scm/github.md` sections before risky ops (#2157 / #2369): PowerShell → `deft verify:encoding` (#798); TS capture (#1366); cascade → `deft pr:wait-mergeable-and-merge` (#1369); SCM → `deft verify:scm-boundary` (#884).

## Development Process

### Implementation Intent Gate (#810)

! `deft xbrief:preflight -- <path>` on `xbrief/active/` before code-writing; action-verb directive (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`) (#810) — `.deft/core/commands.md` § Scope xBRIEF Lifecycle.

### Story Start Gate

! `git status --short --branch` + `deft verify:story-ready`; lifecycle via `deft scope:promote -- <path>` / `deft scope:activate -- <path>` / `deft scope:complete -- <active-story-path>` (#1378) — `.deft/core/commands.md` § Scope xBRIEF Lifecycle.

## Commands

! Directive product commands use the `/deft:directive:*` namespace (#418 / #1670); the full command and alias table lives in `.deft/core/commands.md` — load on demand, not rendered here.
<!-- /deft:managed-section -->