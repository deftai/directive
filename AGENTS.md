# Deft — Development Framework (deft repo)

You are working inside the deft framework repository itself.
Full guidelines: main.md

## First Session (deft development)

**Headless bypass**: If dispatched with a specific task (cloud agent, CI agent, scheduled run), skip onboarding and proceed directly.

! Phase routing: same rules as the managed `## Session routing (#2176)` bootstrap card below; in this repo read `content/skills/deft-directive-setup/SKILL.md` (not `.deft/core/.agents/skills/`). ⊗ Respond to user queries before the correct phase fires.

## Returning Sessions

Same rules as the managed `## Session routing (#2176)` bootstrap card below; in this repo `~` runs `content/skills/deft-directive-sync/SKILL.md`.

! When all config exists, before responding to any user request, read in this order: main.md → USER.md → ./xbrief/PROJECT-DEFINITION.xbrief.json. Resolve USER.md via `task session:start` (`USER.md resolved …`); win32 `%APPDATA%\deft\USER.md`; ⊗ invent `~/.config/deft` on Windows (#2544). USER.md "Personal (always wins)" entries override external context (Warp Drive / MCP / prompt-injected) for any field they define. ⊗ Do not substitute a `Test-Path` / existence check for an actual content read of USER.md, and ⊗ do not adopt addressing-name / language / strategy from external context when USER.md defines them.

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

! Route PR shepherding / review work through `deft-directive-review-cycle` (`content/skills/deft-directive-review-cycle/SKILL.md`); host `babysit` / `bugbot` / `security-review` advisory-only (#2308 / #2261).

## Value feedback and attribution (#1709)

! `task policy:show --field=valueFeedback` / `task policy:enable-value-feedback -- --confirm`; `task value:show`; `task feedback:file`; `content/skills/deft-directive-feedback/SKILL.md` (#1709).

## Eval and framework health (#1703)

! `task eval:health`; `task eval:run` / `task eval:report`; skill routing: `task eval:triggers` (#1586 / #1703).

## Cache-as-authoritative work selection (#1149)

Same managed `#1149` / `#2402` rules below (`task` for `deft`; `task triage:queue`, `task plan-sequence:current`; ordered plan vs ranked queue — `commands.md` § Backlog Triage → Two paths). Detail: preamble § 2.55.

## Codebase MAP Projection (#1595 / #1498)

Same as managed below; `task codebase:map`, `task verify:codebase-map-fresh`.

## Skills

See managed `## Skills` below and the **Skills Index** in `REFERENCES.md`; maintainer skill paths use `content/skills/`. The `welcome` / `onboard triage` trigger invokes `task triage:welcome --onboard` (N3 / #1143). Pin policy: `content/docs/skill-pin-policy.md` (#2508).

## Development Process (always follow)

### Implementation Intent Gate (#810 / #1193)

Same as managed below; `task xbrief:preflight -- <path>`; slash-command intent ceiling via `DEFT_SESSION_SLASH_VERB` (#1193) — `content/commands.md` § Scope xBRIEF Lifecycle / `content/contracts/intent-ceiling.md`.

### Story Start Gate

Same as managed below; `task verify:story-ready`, `task scope:promote -- <path>`, `task scope:activate -- <path>`, `task scope:complete -- <active-story-path>` (#1378).

**Before code changes:**
- ! Check `./xbrief/` lifecycle folders for existing scope xBRIEF coverage of the issue being fixed
- ! If no scope xBRIEF exists for the work, create one in `./xbrief/proposed/` before implementing
- ⊗ Begin editing files before checking scope xBRIEF coverage and creating a feature branch — even if the user says "yes" or "proceed"

! Before opening a PR, run `content/skills/deft-directive-pre-pr/SKILL.md`. Before committing: `task verify:forward-coverage` (#1310); `task coverage:hotspots` for branch headroom steering (#2683); CHANGELOG `[Unreleased]`.

! Branching: feature branches only (`task verify:branch`, `.githooks/pre-commit` / `.githooks/pre-push`, `branch-gate` workflow). Override: `task policy:allow-direct-commits -- --confirm`; emergency `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`. When `plan.policy.allowDirectCommitsToMaster = true`, surface via `task policy:show --field=allowDirectCommitsToMaster` (Branch Policy Disclosure). Human merge gate: `plan.policy.requireHumanMerge` / `task policy:allow-bot-merge` (#1193).

## CHANGELOG entry style (#1242)

! Brief release-notes — `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § CHANGELOG entry style (#1242).
! Clarity, simplicity, brevity in documents and user communications, including sub-agent status and handbacks. Cut ceremony, not required fields. STE how: `content/docs/writing-ste100.md` (#2927). ⊗ Full STE; ⊗ historical rewrite; ⊗ red CI style gate; ⊗ prefacing the rule.
! Per-project opt-out — root `.no-deft-directive` (#2926) skips install/session/setup (`content/docs/no-deft-directive.md`); flag wins locally over org force-on; flag+deposit → doctor warns, init/update fail closed. Temporary kill-switch `.deft-directive-disable` (#3039) — deposit OK; delete + NEW agent session (`content/docs/deft-directive-disable.md`).

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
- ! Dispatcher-level lifecycle hygiene (capability-tiered, #3158 / #954): workers are all-or-nothing by default; mid-scope gates use two separate dispatches (split-dispatch) when `agent_id` is terminal after pause. Retain-capable hosts MAY single-dispatch and re-message the live child (continue-by-agent-id / message-later / steer-mid-flight). Retention = orchestration only (#3164); topology #3155 nuclear-family. Depth: preamble §10; pin `## Mid-scope gate capability tier (#3158 / #954)`.
- ! Orchestrators dispatching implementation sub-agents MUST include the canonical preamble verbatim (or by reference) in the worker's dispatch envelope -- see `content/templates/agent-prompt-preamble.md`. The preamble covers AGENTS.md read mandate, the #810 xBRIEF gate walkthrough, the PowerShell 5.1 non-ASCII rule (#798), pre-pr + review-cycle skill mandates, the four rules above, sub-agent spawn rules per #727, orchestrator dispatch doctrine (#1880), and the mandatory DONE message protocol.
- ⊗ Dispatch an implementation sub-agent without including the canonical preamble (or a reference to `content/templates/agent-prompt-preamble.md` it can read directly) -- the recurrence patterns above re-fire on every fresh dispatch that omits this institutional memory.

Orchestrator dispatch doctrine (#1880): `docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md` § Multi-agent orchestration discipline (#954); canonical prose in `content/templates/agent-prompt-preamble.md` §9.

- ! **Through-merge worker dispatch (#3032):** On **through merge** / **drive to merge** / land-ship / **drive-to: merge-ready** story intent, parent MUST dispatch a merge-ready worker via the **swarm/solo-worker launch path** even if **cohort size is 1** (worktree, preflight, pre-pr, review-cycle, merge/`scope:complete`); parent MUST NOT implement as the leaf. ⊗ Parent conversation implements or babysits product fix/CI loops when subagent/worktree dispatch is available (#3032 / #1880 Gap C).
- ! **Worker-owns-lifecycle (Gap C):** When dispatching an implementation worker, the envelope MUST declare `stop-at: pr-open` OR `drive-to: merge-ready` (default for story work). Workers scoped `drive-to: merge-ready` own PR + review cycle + fix batches through merge-ready as ONE unit of work — they spawn their own review poller per review-cycle monitoring tiers; the orchestrator MUST NOT hand back at PR-open and re-dispatch separate leaf agents for review/fixes.
- ! **Post-merge scope lifecycle (#2321 / Gap C):** Workers scoped `stop-at: pr-open` MUST NOT run `scope:complete` before exit; the orchestrator (or Phase 6 `task swarm:finalize-cohort` / `task swarm:complete-cohort`) MUST run `scope:complete` or `scope:cancel` after merge. Workers scoped `drive-to: merge-ready` (or `drive-to: merge`) MUST include `scope:complete` in their unit of work. `task verify:orphan-active` fails closed on active/running briefs whose issues are closed or linked PR is merged.
- ! **Background dispatch (Gap D):** Long-running workers (>~3 min: implementation, fix batches, review-cycle owners, pollers) MUST dispatch independently / in the background (on Cursor: Task tool `run_in_background: true`) so the conversation channel stays interactive; foreground dispatch is for short tasks only.
- ! **Deliberate model routing:** Before ANY sub-agent dispatch (cohort OR single), make a deliberate per-`worker_role` routing decision via `task verify:routing` / `task swarm:routing-set` — never silently inherit the parent model. Deterministic gate enforcement is #1877; this bullet is behavioral doctrine only.
- ⊗ Re-dispatch separate review/fix leaf agents after a `drive-to: merge-ready` implementation worker exits at PR-open (#1880 Gap C).
- ⊗ Foreground/blocking dispatch for long-running implementation, fix, or review-cycle workers when background dispatch is available (#1880 Gap D).
- ! **Deterministic PR-verdict polling (Tier-4 pointer, #1056):** A `drive-to: merge-ready` worker (or a review poller it spawns) that needs to wait on a Greptile/SLizard verdict MUST poll via `task pr:watch -- <N>` — a blocking-by-default poll to a terminal three-state verdict (exit `0` CLEAN / `1` NEW_P0_P1 / `2` ERRORED|STALL|TIMEOUT|config, `--one-shot` for a single probe, `--json` for the structured shape). The invocation IS the wait, so a promise-to-poll cannot silently evaporate. It reuses the canonical Greptile detector and SHA-match gates the verdict to the current HEAD (a stale pre-push review is never read as NEW_P0_P1). The rule body and full flag surface live in the #1056 task/xBRIEF; this is the discovery pointer only.
- ! **Deterministic review-monitor gate (Tier-4 pointer, #2655):** When Tier 1 is available, a parent MUST NOT yield, enter Approach 3, or claim review ownership without a recorded active review-monitor — run `task verify:review-monitor -- --pr <N>` (exit `0` ready / `1` not ready / `2` config) before those transitions; after spawning Approach 1 register via `task review-monitor:register`. Skill contract: `content/skills/deft-directive-review-cycle/SKILL.md` Review Monitoring; closes #380 / #1386 recurrence class.

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

<!-- deft:managed-section v3 sha=f0acd3f89b8c refreshed=2026-08-18T02:03:52Z session=ae059d1b6089 -->
# Deft — AI Development Framework

Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md

! If any .deft/core/.agents/skills/ path referenced in this file cannot be read (missing file, stale path from a previous framework version, or a deprecation redirect stub), read .deft/core/QUICK-START.md instead and follow it. QUICK-START refreshes this section idempotently for the current framework version.

## Temporary test kill-switch (#3039)

! Before further Directive process load, check root `.deft-directive-disable` (presence = flag). If present → stop DD load; recovery = delete file + NEW agent session. Deposit OK; not `.no-deft-directive` (#2926). Docs: `.deft/core/docs/deft-directive-disable.md`.
⊗ Claim full operation while the flag exists or after delete without a NEW agent session.

## Session routing (#2176)

! **Read-only default** until mutation intent: load AGENTS.md / main.md / USER.md / `xbrief/PROJECT-DEFINITION.xbrief.json`; resolve USER.md via `deft session:start` (`USER.md resolved …`; win32 `%APPDATA%\deft\USER.md`; unix `~/.config/deft/USER.md`; ⊗ invent `~/.config/deft` on Windows #2544); confirm Deft alignment + addressing-name; ⊗ no mutable `deft session:start` / triage welcome / sync / branch-policy unless asked or implementation-ready (#2176) — `.deft/core/commands.md` § Session routing. Bootstrap: cold-start → README § Cold-start (#2273) ⊗ never `.deft/core/`; pre-cutover → setup Pre-Cutover (#2068); missing USER.md / PROJECT-DEFINITION → setup Phase 1/2 (#1813) ⊗ before answering; else main → USER → PROJECT-DEFINITION; ~ sync. Mutation → `deft session:start` then `deft verify:session-ritual -- --tier=gated` (#1149). ? `deft session:start -- --read-only` (#2176).

## Session-start ritual (#1149)

! On **mutation** session start, run `deft session:start`; before code-writing or `start_agent` dispatch run `deft verify:session-ritual -- --tier=gated` (stale after `plan.policy.sessionRitualStalenessHours`; records `deft verify:tools` / `deft doctor` / `deft verify:cache-fresh` / `deft agents:refresh` / `npm i -g @deftai/directive@latest`; #1149 / #1348) — `.deft/core/commands.md` § Session-start ritual. ! SCM mirror tip (#3124): restate existence + get-the-most user-visible when tip fires (depth `commands.md`). ⊗ Absorb tip without restating.

## WIP cap

! Respect `plan.policy.wipCap` (default 20) — at cap `deft scope:promote` refuses; relief via `deft scope:demote --batch --older-than-days 30` (#2319 / #1121). Full WIP: `.deft/core/.agents/skills/deft-directive-swarm/SKILL.md`.

## xBRIEF layout (#2034 / #2110)

Legacy `vbrief/` read-accepted; `deft migrate:xbrief` for `xbrief/` (v0.6→v0.8). `x-vbrief/` tokens read-accepted until migrated.
! Completed xBRIEFs are record of *what is*, zero authority over *what to build next* (#3383). Current contract = active xBRIEF + human operator live instruction. Depth: `main.md` Persistence; build skill declare-the-contract / halt-and-ask.
⊗ Treat a completed xBRIEF as the next-build contract.

## Unmanaged project header (#2065)

! Do NOT treat the unmanaged AGENTS.md header as the work queue; ⊗ Do NOT add `Status`, `Next:`, or `Known Issues` blocks — they rot silently. See UPGRADING.md § AGENTS.md: managed vs unmanaged header for the Session orientation pointer and rationale.

## Cache-as-authoritative work selection (#1149)

! "what next?" → two work-selection modes (#2402): **ordered plan** (`deft plan-sequence:*`) or **ranked queue** (`deft triage:queue`) — `commands.md` § Backlog Triage → Two paths. ordered-plan first; else `deft-directive-triage` + `deft triage:queue --limit=10` (D11). Empty cache auto-populates from GitHub (#2575).

⊗ Recommend work without queue/plan consult; ⊗ widen past an exhausted plan; ⊗ conclude "nothing to do" from `xbrief/{pending,active}` folder scans or GitHub-only reads without `deft triage:queue` (#2576).

## Umbrella status reading (#1152 / #2066)

! `issues/<N>/comments` via REST → `## Current shape (as of pass-N)` + linked context (claim-cites-state-surface, #2066); body → shape → amendments. Prefer `deft umbrella:current-shape <N>` — full contract: `.deft/core/templates/agent-prompt-preamble.md` § 5.6.

⊗ Conclude umbrella or epic status from the issue body alone — cite current-shape or another state artifact (#2066).

## Deterministic questions runtime obligation (#1470)

! Structured questions MUST end with `Discuss` and `Back` — `.deft/core/contracts/deterministic-questions.md` (#1470 / #767).

## Issue body→comments reading (#2143)

! Fetch body + `issues/<N>/comments` via REST before requirements or dispatch — `.deft/core/templates/agent-prompt-preamble.md` § 5.6 / `deft issue:ingest` (#2143). ⊗ Build a dispatch envelope from the issue body alone when the issue has comments.

## Content packs

! Before improvising: `deft packs:slice --list-packs`, then `deft packs:slice <pack> --list` / `deft packs:slice <pack> <slice>` — `commands.md` (§ packs); never enumerate names here.
## Codebase MAP Projection (#1595 / #1498)

! `plan.architecture.codeStructure` is durable SoT; `.planning/codebase/MAP.md` is generated — `deft codebase:map` / `deft verify:codebase-map-fresh` (`commands.md`). ⊗ Do not hand-edit MAP, block on stale/absent MAP, or elevate projection above xBRIEF (#1595 / #1498).

## Skills

! **Skills Index** (Level-0) in `.deft/core/REFERENCES.md` — scan before improvising; read `SKILL.md` only on index match. `welcome` / `onboard triage` → `deft triage:welcome --onboard` (N3 / #1143); lessons → packs:slice.
## Skill pin policy (#2508)

! Process-critical skills with false-negative risk MUST be named in AGENTS.md (always-pin tier) — tier definitions: `.deft/core/docs/skill-pin-policy.md` (#2508).
! **Default always-pins:** `deft-directive-build`, `deft-directive-pre-pr`, `deft-directive-review-cycle`, `deft-directive-swarm` — read each `SKILL.md` when that work type starts.
⊗ Pin entire language packs, deployment docs, or framework bulk into AGENTS.md — pins are for false-negative-sensitive process gates only (#2508).
! **Dual stop (#2442):** multi-iteration work MUST have success + failure/budget stop (max iters / no-progress / budget); single-turn exempt; halt with operator-visible report; ⊗ thrash. Defaults: build, swarm, review-cycle skills. See main.md Dual Stop Rule. Ledger #3143 (`packages/core/src/delivery-attempt/`).
## Rule Authority [AXIOM]
! Prefer `task deft:*` over AGENTS.md prose. See main.md.
## Thin Fail-Closed Design (#3265)
! One fail-closed `task deft:*` check + one remediation. See main.md.
## Writing bar (#3368)
! Clarity, simplicity, brevity in documents and user communications, including sub-agent status and handbacks. Cut ceremony, not required fields. STE how: `.deft/core/docs/writing-ste100.md` (#2927). ⊗ Full STE; ⊗ historical rewrite; ⊗ red CI style gate; ⊗ prefacing the rule.

## Continuous Improvement Learning (#607 / #3164)

! After a failure: ask if it could recur with a different query or session. One-off → write and later re-read `./lessons.md` inbox (also load packs:slice; ⊗ hand-edit generated `meta/lessons.md`); recurrable structural → propose skill/directive via issue/PR under Self-Improving gates — never mid-run constitution self-edit. Depth: Continuous Improvement in main.md; stance #3164; optional #666.

## Through-merge worker dispatch (#3032)

! On **through merge** / **drive to merge** / land-ship / **drive-to: merge-ready** story intent: parent MUST dispatch a `drive-to: merge-ready` worker (worktree, preflight, pre-pr, review-cycle, merge/`scope:complete`) via the **swarm/solo-worker launch path** even if **cohort size is 1** — parent MUST NOT implement as the leaf. Depth: swarm Phase 0 + skill-pin-policy (#3032 / #1880 Gap C).
⊗ Parent conversation implements or babysits product fix/CI loops for drive-to:merge-ready work when background subagent/worktree dispatch is available (#3032).
! After leaf announce: tool-first / yield / one short non-repeated answer; ⊗ N>2 near-identical zero-tool (FC14 / #3131). Machine: `evaluateParentTurnShape` (`parent-turn-shape`). Depth: preamble §11 + `docs/openclaw-agent-host.md`.

## Envelope selection SLA (#3153)

! Default story / through-merge unit of work is `drive-to: merge-ready`. Deliberate `stop-at: pr-open` is allowed only when a **partner merge-path owner** is planned (review-cycle babysit / Approach 1 lease / parent-retained) for Greptile + CI + post-merge `scope:complete` — triggers: capacity stall, wall-clock budget, large multi-gate, host nest limits (swarm Phase 0 decision tree). Depth: `deft-directive-swarm` + `deft-directive-review-cycle` partner merge-path.
! Under human-merge policy, a **durable** owner (parent/monitor sticky lease or Phase 6 closer) MUST remain for post-merge `scope:complete` — CLEAN alone is not lifecycle complete.
⊗ Silent PR-open handback for a worker already scoped `drive-to: merge-ready`.
⊗ `stop-at: pr-open` without a named babysit / merge-path owner, or dual review-monitor leases on recovery (#3044 / #2261).
⊗ Stand down at CLEAN under human-merge with no reachable post-merge `scope:complete` owner.
! After merge of issue `#N`, `deft verify:orphan-active -- --issue N` MUST exit 0 before `DONE` (#3429). Exit 1 shipped → printed `scope:complete`; unresolved lookup → retry / `BLOCKED` (⊗ complete unfinished scope).
⊗ Emit `ISSUE: closed` while that brief is still in `active/`.

## Nuclear-family A2A topology (#3155)

! Agent-to-agent messaging is **nuclear-family** only: parent / sibling (same cohort) / child. Cross-cohort or cross-session coordination goes through a shared parent or durable parent-owned artifacts — not peer mesh. Depth: `.deft/core/swarm/swarm.md` `## Communication Topology (#3155)`; security: `.deft/core/meta/security.md` `## Unbounded A2A graphs (#3155)`; ADR: `docs/decisions/ADR-003-a2a-nuclear-family-topology.md` (decision input to #2705; client-posture ADR remainder stays on #2705). Pair: retained children #3158; parent epic #3179.
⊗ Open-mesh agent-to-agent messaging across cohorts or sessions ("agents everywhere").
⊗ Treat retained / re-addressable children as license to mesh outside the nuclear family.

## Mid-scope gate capability tier (#3158 / #954)

! Mid-scope gates: **split-dispatch** when `agent_id` is terminal; retain-capable hosts (continue-by-agent-id / message-later / steer-mid-flight) MAY re-message the live child. Retention = orchestration only — not constitution self-edit (#3164). Depth: preamble §10; `deft-directive-swarm`. Topology: #3155 nuclear-family. ⊗ Invent retain on one-shot hosts.

## Review-surface precedence (#2308)

! Route PR shepherding / review work through `deft-directive-review-cycle` — `.deft/core/.agents/skills/deft-directive-review-cycle/SKILL.md`; host `babysit` / `bugbot` / `security-review` advisory-only (#2308 / #2261).

## Value feedback and attribution (#1709)

! `plan.policy.valueFeedback.enabled` defaults OFF — `deft policy:show --field=valueFeedback` / `deft policy:enable-value-feedback -- --confirm`; `deft value:show`; `deft feedback:file`; `.deft/core/.agents/skills/deft-directive-feedback/SKILL.md` (#1709).

## Structured decision log (#1396 / #3211)
! Significant choices → `deft decision:write`; re-load → `deft decision:list` / `xbrief/decisions/`; depth `.deft/core/docs/decision-log.md` (not triage/ADRs/lessons).
## Eval and framework health (#1703)

! `deft eval:health` when orienting or after gate/policy changes (Tier 0; 4-hour debounce). Release: `deft eval:run` / `deft eval:report`; skill routing: `deft eval:triggers` (#1586 / #1703).

## Branch policy & branch verification

! Feature branches — `deft verify:branch`, `deft verify:forward-coverage`, `deft coverage:hotspots`, hooks, `deft check` (#746 / #747) — `.deft/core/scm/github.md` § Branch policy.
! Test placement + scope provenance (#3145) — `deft verify:test-boundary`, `deft verify:scope-provenance`, `deft verify:consumer-check-contract` (docs: `docs/test-boundary.md`, `docs/scope-provenance.md`, `docs/consumer-check-contract.md`); defaults warn-only until authored policy.

## Branch Policy Disclosure (#746)

! When `plan.policy.allowDirectCommitsToMaster = true`, surface via `deft policy:show --field=allowDirectCommitsToMaster` (#746) — `.deft/core/scm/github.md` § Branch policy.

## Windows PowerShell: multi-line git/gh bodies (#2646 / #2744)

! Multi-line git commit / gh issue|pr|comment bodies: write UTF-8 (no BOM) to OS temp, then `git commit -F` / `gh --body-file` / `deft scm:body:* --body-file`. Issue-body RMW on win32: `deft scm:body:issue:fetch --out-file` then edit the file then `deft scm:body:issue:edit --body-file` (#2607 postcondition verify). ⊗ bash heredocs, `<<<`, inline multi-line `--body`, or PS capture-concat of `gh api --jq .body` (string[]/$OFS destroys bodies — #2087, #2741, #1492). Detail: `.deft/core/scm/github.md` § #2646 / #2744. `ghx` is read-only — mutations stay on live `gh`.

## Contextual guardrails (runtime-detect lazy-load)

! Detect OS/shell; use portable syntax or explicit shell (#2568). `.deft/core/scm/github.md` (#2157/#2369): PS encoding→`deft verify:encoding` (#798); TS capture; cascade→`deft pr:wait-mergeable-and-merge`; SCM→`deft verify:scm-boundary`.
! Forge outage (#3422): drop GitHub I/O on attributed outage or repeated 429/502/503; report once to the human; re-probe on `plan.policy.forgeOutageRetryMinutes` (default 30; USER.md Personal wins). Depth: `scm/github.md` § #3180. Complements #3167 / #3180.

## Development Process

### Gate integrity (#3156)

! When a quality gate fails, fix the product/process/test under test — ⊗ clear red by editing the gate definition, verifier, reward, required check, coverage floor, or policy flag solely to go green. Deliberate gate changes go through issue/PR + review. Depth: `.deft/core/docs/gate-integrity.md` (refine-internal SkillOpt stays on #2436).

### Implementation Intent Gate (#810 / #1193)

! `deft xbrief:preflight -- <path>` on `xbrief/active/` before code-writing; action-verb (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`) (#810). Slash-command sessions inherit only that verb (`DEFT_SESSION_SLASH_VERB`); non-implement verbs (`/github-issue`, `/triage`, …) MUST NOT authorize implement/push/PR/merge/deploy (#1193) — `commands.md` / `contracts/intent-ceiling.md`.

## Human merge gate (#1193)

! When `plan.policy.requireHumanMerge` is true (default if `autoDeployOnMerge`), agents may open PRs, may not merge. Override: `deft policy:allow-bot-merge -- --confirm` or `DEFT_ALLOW_BOT_MERGE=1` — `commands.md` / `contracts/intent-ceiling.md`.

### Story Start Gate

! `git status --short --branch` + `deft verify:story-ready`; `deft scope:promote -- <path>` / `deft scope:activate -- <path>` / `deft scope:complete -- <active-story-path>` (#1378) — `commands.md` § Scope xBRIEF Lifecycle.

## Commands

! `/deft:directive:*` namespace (#418 / #1670); full table in `.deft/core/commands.md` — load on demand.
<!-- /deft:managed-section -->