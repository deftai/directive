# Swarm core — Phase 0 Allocate (host-neutral)

## Phase 0 — Allocate

! Before assigning work to agents, build the cohort from the triage queue (queue-driven per #1142 / N2; see Step 0 below), then read project state and plan allocation against the activated cohort.

### Through-merge / N=1 still uses the launch path (#3032)

! When operator intent is **through merge**, **drive to merge**, **land/ship issue**, or explicit **drive-to: merge-ready** for story work, the parent (monitor) conversation MUST NOT implement product code or own the implementation PR as the leaf. Parent MUST run this skill's launch path: worktree isolation when available, worker envelope with the unit-of-work boundary selected below (`drive-to: merge-ready` default, or deliberate `stop-at: pr-open` per the envelope selection SLA), xBRIEF preflight, pre-pr + review-cycle, then merge/`scope:complete` per #1880 Gap C.
! **Cohort size N=1 is still a cohort for dispatch.** Solo through-merge uses the same swarm/solo-worker launch path as multi-story (`dispatch_kind: solo` or a one-story swarm-cohort). Do not treat "only one issue" as permission for the parent to code.
⊗ Parent implements, babysits product fix loops, or skips worktree + worker dispatch for through-merge / drive-to:merge-ready work when background subagent/worktree dispatch is available (#3032).

### Envelope selection SLA — `drive-to: merge-ready` vs `stop-at: pr-open` (#3153)

! **Cohort through-merge intent still means stories land on master.** Choosing `stop-at: pr-open` changes **who owns which mile** (implement leaf vs review-cycle babysit owner), not whether the cohort ships. Happy-path single-leaf ownership remains valid; this SLA does **not** replace Gap C with "always split."

! **Default for story / through-merge dispatch:** `drive-to: merge-ready` — the implementation leaf owns implement → pre-pr → push → PR → Greptile review-cycle → CI → merge-ready (and `scope:complete` when the envelope includes that step) as **one** unit (#1880 Gap C / #3032).

! **Select the envelope at Phase 0 allocation / Phase 3 dispatch prep** (before spawn). Record the choice in the worker prompt unit-of-work line. Re-evaluate only when a leaf returns `BLOCKED` / thin DONE and a **new** continuation is planned — never re-label a live `drive-to: merge-ready` leaf as if it had been `stop-at: pr-open`.

#### Decision tree (concrete triggers)

| Trigger | Envelope | Notes |
|---------|----------|--------|
| Happy path / short story / green CI expected / no wall-clock budget stated | **`drive-to: merge-ready`** (default) | One leaf owns full path; silent PR-open handback remains forbidden |
| Operator (or xBRIEF) states a wall-clock / context budget that is likely shorter than CI + conf-floor wait | **`stop-at: pr-open` recommended** | Parent/monitor **must** spawn or retain one review-cycle babysit owner on the open PR (partner contract: `skills/deft-directive-review-cycle/SKILL.md` § Partner merge-path) |
| Known or observed **runner capacity stall** (`ci_ready_state=runner_capacity_stall` / #2672) dominating wall clock before implement finishes | **`stop-at: pr-open` recommended** | Do not lower conf floors or `--skip-ci`; split so implement leaf does not burn host budget waiting on runners; babysit owns failover wait |
| Large multi-gate story (many required checks, multi-round Greptile, dogfood conf floor, expected multi-hour non-impl wait) | **`stop-at: pr-open` recommended** | Keeps implement leaf focused; merge path owned by review-cycle babysit with sticky lease (#3090 / #3044) |
| **Conf-only residual** after implement: 0 P0/P1, score below `minGreptileConfidence`, product AC met (#2881 / #3095) | Prefer **`drive-to: merge-ready`** leaf to exit **`BLOCKED`** (not thin DONE) **or** deliberate **`stop-at: pr-open`** + babysit if the split was pre-declared | Confidence-only holds are **not** a mandate to redesign; babysit offers document/accept/minimal polish — not unbounded redesign |
| Host leaf cannot nest a review-monitor (Cursor Task / Claude Code nested-spawn limits #2797 / #3134) **and** Approach 1 sibling is desired | **`stop-at: pr-open` required** for the implement leaf | Orchestrator spawns sibling review-monitor + lease; same as existing leaf-boundary rules |
| Explicit operator override | Honor operator | Still declare envelope in dispatch; partner ownership rules still apply |

#### Thin DONE and recovery (fail-closed)

! A `drive-to: merge-ready` leaf that exits with PR URL but **no** merge / merge-ready evidence is **FAILED thin DONE** (#2943 / preamble §11) — not success and not a designed handoff.
! Recovery: parent/monitor ground-truths once, then backgrounds **exactly one** continuation owner scoped `drive-to: merge-ready` on the same worktree/PR **or** one review-cycle babysit owner with sticky `<!-- deft:review-owner -->` lease. ⊗ Dual lease / parallel babysit (#3044). ⊗ Cursor global babysit freestyle (#2261).
! A **deliberate** `stop-at: pr-open` exit (PR open + structured handback) is **not** thin DONE — it is a designed handoff that **requires** the review-cycle partner merge-path contract immediately (same turn tool dispatch or registered owner).

⊗ Re-scope a live `drive-to: merge-ready` worker mid-flight to "PR-open is enough" without a new dispatch envelope.
⊗ Choose `stop-at: pr-open` without a named babysit / review-monitor owner plan (silent drop of merge path).
⊗ Lower Greptile floors, skip CI, or use `--skip-ci` as the alternative to envelope selection (#2672 / #3095).

Cross-links: Phase 3 Worker-owns-lifecycle (`references/core-phase-3.md`), review-cycle partner merge-path (`skills/deft-directive-review-cycle/SKILL.md`), preamble Gap C (`templates/agent-prompt-preamble.md` § Orchestrator dispatch doctrine).

### Headless cohort fast-path: low-ceremony launch (C1 / #1387)

! When the operator supplies a **pre-approved cohort** via the **C1** `task swarm:launch` CLI, Phase 0 runs in headless / low-ceremony mode: the per-phase interactive approval gates (the Step 0c promote-fill prompts, the Step 0.5 lifecycle-bridge approval, and the Step 4/5 allocation approval) collapse into a SINGLE consent -- the `## Allocation context` token (#1378) carried in the dispatch envelope. The interactive promote-fill loop (Step 0a -- 0d below) is SKIPPED.
! The **C1** signature is `task swarm:launch -- --stories <ids|paths> [--group <label>] [--worktree-map <path>] [--base-branch <branch>] [--autonomous]`. `--stories` names the pre-approved story ids or xBRIEF paths; `--group` is an optional cohort label; `--worktree-map` points at the pre-created **C3** worktree-map JSON consumed in Phase 2; `--base-branch` overrides the default `master`; `--autonomous` runs without the interactive launch confirmation.
! The SINGLE consent is the #1378 `## Allocation context` token with `dispatch_kind: swarm-cohort` and a NON-NULL `allocation_plan_id` AND `batching_rationale` (the recognition contract in `templates/agent-prompt-preamble.md` § 2.5). That token IS the batched approval for the whole cohort -- the deterministic-question gates the interactive path runs (per [`../../contracts/deterministic-questions.md`](../../contracts/deterministic-questions.md)) are bypassed wholesale on the headless path, not asked once per phase.
⊗ Re-prompt the operator for per-phase batching approval, or run the interactive promote-fill loop (Step 0a -- 0d), when a pre-approved cohort is supplied via `task swarm:launch` -- the headless path's single #1378 consent already authorizes the batch, and re-prompting mid-cohort violates the all-or-nothing dispatch-envelope rule (#954).
? The interactive queue-driven path (Step 0 below) remains the DEFAULT when no pre-approved cohort is supplied; the headless fast-path is the opt-in low-ceremony route for a cohort the operator has already curated and approved upstream.


### Ordered-plan / cohort exhaustion (#2402)

! When the approved cohort (or an active `plan-sequence` of kind `swarm`/`cohort`/`delivery`) is exhausted, stop. Do not promote, queue, open, or dispatch adjacent work after the final approved entry unless the operator explicitly authorizes a new cohort or queue-driven selection.

! Continuation language ("next", "proceed") advances only within the approved cohort order — not into triage-queue remainder.

### Step 0: Queue-driven cohort selection (#1142 / N2)

! Phase 0 is queue-driven: consult the triage cache (D2 / #1122 + D11 / #1128) for the ranked promotion candidates, then fill the WIP cap. Do NOT pick the cohort by hand from `xbrief/pending/` or `xbrief/active/` -- the queue is the canonical record of "what's next?" per AGENTS.md `## Cache-as-authoritative work selection (#1149)`. The four sub-phases below run in canonical order; existing Step 0.5 (lifecycle bridge) and Steps 1-5 (readiness / blockers / allocation / present / approval) proceed unchanged after Phase 0d.

#### Phase 0a -- State overview via `task triage:summary` (D2 / #1122)

- ! Run `task triage:summary` to emit the current triage-cache one-liner (`[triage] N untriaged ... WIP X/Y [⚠]`). The monitor uses the result to:
  - confirm the cache is fresh enough to act on (the D5 / #1127 `task verify:cache-fresh` warning is silent on a fresh cache; D2's one-liner is the human-readable parallel for the operator);
  - read the current `pending/ + active/` count against the configured `wipCap` (default 20 per #2319, raised from the original 10 per umbrella #1119 Current Shape v3, exposed via `plan.policy.wipCap`).
- ! If the summary reports an empty cache (no candidates ever ingested), surface the bootstrap remediation (`task triage:bootstrap` or the N3 / #1143 onboarding ritual `task triage:welcome`) and HALT Phase 0 -- there is no queue to drive cohort selection from.

```pwsh path=null start=null
task triage:summary
# [triage] 12 untriaged · 3 in-flight · WIP 4/10
```

#### Phase 0b -- Ranked candidates via `task triage:queue` (D11 / #1128)

- ! Run `task triage:queue --state=accept --limit=20` to surface the top-20 ranked promotion candidates. The queue is grouped (`[RESUME] -> [URGENT] -> untriaged -> other`) and ordered by `updated_at` within group (D11); the `--state=accept` filter restricts to issues whose latest triage decision is `accept` (the canonical "promote-ready" subset).
- ! Treat the queue as authoritative. Do NOT supplement the list with agent recall, open-GitHub-issue intuition, or memory of recent commits -- the queue is the rank; swarm does not re-rank.
- ! Present the candidate list to the operator as a numbered table (issue number, title, age in queue, top-line ranking rationale).

```pwsh path=null start=null
task triage:queue --state=accept --limit=20
```

#### Phase 0c -- Promote-fill-cap loop

! While `pending/ + active/` count < `wipCap` AND the queue is non-empty, prompt the operator to promote the next ranked candidate to `xbrief/pending/`.

Loop body, per candidate (top-of-queue first):

1. ! Render the next queue candidate with brief context (issue title, labels, top-1 ranking rationale).
2. ! Prompt the operator: `Promote #<N> to xbrief/pending/? [yes/skip/stop]`. The final two numbered options remain `Discuss` and `Back` per [`../../contracts/deterministic-questions.md`](../../contracts/deterministic-questions.md).
3. On `yes` -- promote via the canonical lifecycle verb:

   ```pwsh path=null start=null
   # D18 #1136: promote by issue number (provenance locates proposed/ artifact;
   # gates on latest candidates.jsonl decision == accept).
   task scope:promote -- --from-issue=<N> [--repo OWNER/NAME]
   # Path form remains valid for refinement scaffolds / disambiguation:
   # task scope:promote -- xbrief/proposed/<file>.xbrief.json
   ```

   Re-run `task triage:summary` (or read the post-promote count directly) to refresh the `pending/ + active/` total before the next loop iteration.
4. On `skip` -- drop this candidate from the current session's cohort; it stays in the queue for the next session. Advance to the next ranked candidate.
5. On `stop` -- exit the loop early; the partial cohort proceeds to Phase 0d.

! **D18 #1136**: prefer `task scope:promote -- --from-issue=<N>` in this Phase 0c loop so the monitor does not resolve the xBRIEF path by hand. Path-based `task scope:promote -- <file>` remains for scaffolds and multi-match disambiguation (`--path`). Non-accept latest decisions refuse unless `--force-no-cache`; missing decision soft-warns (`--strict` hard-fails).

! **WIP-cap exit-clean prose**: When WIP cap is reached, swarm Phase 0 stops adding to the cohort and exits cleanly with a count of what was filled. Operator can demote (D1 / #1121, `task scope:demote <existing>` or `task scope:demote --batch --older-than-days 30`) to free slots or `--force` to override (the override is audit-logged as `wip_cap_override` in `xbrief/.eval/scope-lifecycle.jsonl` per D4 / #1124).

! **Cohort recovery on cap-fill exit**: If the queue surfaces 10 candidates but the cap allows only 4 more slots, the unpicked 6 stay queued for the next session. No state is lost; the queue is the canonical record. The operator can free a slot via `task scope:demote <existing>` (D1 / #1121) before re-running Phase 0, or accept the smaller cohort for this session.

#### Phase 0d -- Cohort dispatch

- ! After the promote-fill loop exits (cap reached, queue empty, or operator `stop`), `xbrief/pending/` now holds the cohort. Phase 0e below is now deprecated (#1891) -- per-role operator model routing (`task swarm:routing-set`, #1739) supersedes the sub-agent backend enum; `task verify:routing -- --advise` is the session-start disclosure surface. The existing Step 0.5 (Lifecycle Bridge -- Promote and Activate Proposed Scope xBRIEFs, #1025) moves the cohort `pending/ -> active/`, and Steps 1-5 (readiness report, blockers, allocation, present, approval) proceed against the activated set. Existing swarm Phase 1+ (Select, Setup, Launch, Monitor, Review, Close) proceeds unchanged.

#### Phase 0e -- Interactive sub-agent backend selection (DEPRECATED -- #1568 / superseded by #1739)

> **This phase is superseded.** Per-role operator model routing (`.deft/routing.local.json`, #1739) is the current mechanism for recording which model each worker role uses. Run `task verify:routing -- --advise` at session start and `task swarm:routing-set` to configure routing decisions. The `plan.policy.swarmSubagentBackend` enum and `task policy:subagent-backend(s)` surface are still present but deprecated (#1891); do not consult them for new work.

~ If `plan.policy.swarmSubagentBackend` is already set in the project policy and no `.deft/routing.local.json` is present, surface a one-line nudge asking the operator to run `task swarm:routing-set` to migrate to the routing surface before dispatch.

⊗ Prompt the operator to select or persist a `swarmSubagentBackend` enum value for new work -- the routing surface (#1739) supersedes the enum; using the enum steers agents into a dead configuration path.

#### Phase 0f -- Greenfield swarm-ready bootstrap (#1053)

! Before allocation on a greenfield or just-setup project, run a **greenfield swarm-ready bootstrap** check that states project infrastructure is separate from machine-tool availability. A host may have `task`, `uv`, `python`, `gh`, and `git` installed (the #1187 machine-tool lane) while the project is still not swarm-ready.

! Check the project infrastructure needed by swarm launch: a git repository, GitHub remote visibility for later PR handoff, Taskfile wiring for `task swarm:*` / lifecycle gates, install layout consistency between source and consumer projections, `.gitignore` coverage for `.deft-scratch/`, and scratch/worktree readiness under `.deft-scratch/worktrees/`.

! When any required project infrastructure is missing, surface the exact remediation path and ask for explicit approval before creating or changing repo, remote, Taskfile, install layout, or gitignore state. Do not silently initialize a repository, add a remote, rewrite task includes, or create ignored scratch paths on the operator's behalf.

! When all in-scope candidates are freshly setup-created candidates from the same setup session, present one explicit batch confirmation before promoting and activating the full set through Step 0.5. The confirmation must name the candidate list and the lifecycle transition (`proposed/` or `pending/` -> `active/`) so the setup handoff is swarm-ready without asking once per file.

~ Setup-side handoff language SHOULD point here: after setup creates initial scope xBRIEFs, tell the operator that the swarm skill will verify or offer to create the remaining project infrastructure before allocation. #1187 remains the dependency for missing executable tools; #1053 owns the greenfield project-infrastructure bridge.

⊗ Treat #1187 machine-tool success as proof that a greenfield project is swarm-ready -- repo, remote, Taskfile wiring, install layout, gitignore, and scratch/worktree readiness are separate checks (#1053).

#### Manual / GitHub-issue escape hatch

? When the operator explicitly opts out of the queue (e.g. a one-off ad-hoc cohort that has not been ingested into the triage cache yet, or a swarm batch driven from a hand-supplied list of issue numbers), the monitor MAY fall back to the legacy GitHub-issue path:

1. ! Fetch issue data: `gh api repos/<owner>/<repo>/issues/<N>` (REST per `templates/agent-prompt-preamble.md` § 5; never the GraphQL `gh issue view --json` surface).
2. ! Generate a minimal xBRIEF in `xbrief/proposed/` following the `YYYY-MM-DD-descriptive-slug.xbrief.json` naming convention (slug rules: [`../../conventions/vbrief-filenames.md`](../../conventions/vbrief-filenames.md)) and conforming to the canonical v0.6 schema (`xbrief/schemas/xbrief-core.schema.json`, strict `const: "0.6"`; see [`../../conventions/references.md`](../../conventions/references.md)).
3. ! Promote through the canonical lifecycle (`task scope:promote -- <path>` then `task scope:activate -- <path>`), respecting the WIP cap and the same `--force` audit-logged override semantics as the queue-driven loop.
4. ! Surface the opt-out reason in the Step 4 (Present Analysis) summary so a reviewer can see WHY the queue was bypassed.

⊗ Default to the manual escape hatch when the queue is non-empty -- the cache-as-authoritative directive (AGENTS.md `## Cache-as-authoritative work selection (#1149)`) requires consulting the queue first.

### Step 0.5: Lifecycle Bridge -- Promote and Activate Proposed Scope xBRIEFs (#1025)

! Before running the Step 1 preflight gate, scan `xbrief/proposed/` and `xbrief/pending/` for candidate scope xBRIEFs and bridge them to `xbrief/active/`. The deft-directive-setup skill Phase 3 (Output -- Light Path / Output -- Full Path) deposits new scope xBRIEFs in `xbrief/proposed/`; the deft-directive-refinement skill Phase 4 (Promote/Demote) deposits them in `xbrief/pending/`. The swarm Phase 0 Step 1 preflight gate (`task xbrief:preflight`) only accepts xBRIEFs in `xbrief/active/` with `plan.status == "running"`, so candidates in `proposed/` or `pending/` MUST be bridged through the canonical lifecycle (`proposed -> pending -> active`) before allocation. Without this bridge, the monitor discovers the gap at runtime as a wholesale preflight rejection (`Invalid transition: 'activate' requires file in pending/`), as in the originating 2026-05-10 first-session consumer swarm.

! **Scan**: list every `*.xbrief.json` under `xbrief/proposed/` and `xbrief/pending/`. Cross-reference each candidate against the user's stated swarm scope (the issue numbers / xBRIEF filenames the user asked the monitor to swarm on). Candidates outside the stated scope MUST NOT be promoted or activated by this bridge -- they may be in a deliberate refinement queue owned by `skills/deft-directive-refinement/SKILL.md` Phase 4.

! **Present**: render a numbered list of in-scope candidates to the user with their current lifecycle folder (`proposed/` vs `pending/`) and `plan.status`. Render the canonical numbered menu in chat unless the host UI visibly preserves the same numeric option labels and returns numeric selections or exact displayed option text. The final two numbered options MUST be `Discuss` and `Back` per [`../../contracts/deterministic-questions.md`](../../contracts/deterministic-questions.md).

! **Approve**: wait for explicit user approval (`yes`, `confirmed`, `approve`) before any lifecycle mutation. Broad affirmative continuation phrases (`proceed`, `do it`, `go ahead`) are NOT authorisation -- the bridge MUST be explicitly confirmed because promoting + activating a scope xBRIEF is a lifecycle commitment that flips `plan.status` to `running` and clears the #810 implementation-intent gate for downstream agent dispatch.

! **Bridge**: for each approved candidate, run the canonical lifecycle commands in order:

  - For candidates in `xbrief/proposed/`: `task scope:promote -- <path>` (moves to `pending/`, status `pending`), THEN `task scope:activate -- <path-in-pending>` (moves to `active/`, status `running`).
  - For candidates already in `xbrief/pending/`: `task scope:activate -- <path>` alone (moves to `active/`, status `running`).

  Both commands are idempotent: a same-folder move with matching status is a no-op. If either command exits non-zero, surface the exit message verbatim, do NOT attempt to allocate against the failed candidate, and ask the user how to route.

! **Verify**: re-run the scan and confirm each approved candidate now lives in `xbrief/active/` with `plan.status == "running"`. Only candidates that pass this verification advance to Step 1 (Read Project State); the rest stay surfaced as preflight rejections.

⊗ Auto-promote + activate every candidate in `xbrief/proposed/` or `xbrief/pending/` without explicit user approval -- proposed-stage xBRIEFs may be in a deliberate refinement queue (`skills/deft-directive-refinement/SKILL.md` Phase 4) and silent promotion bypasses the user's lifecycle intent.

⊗ Skip the lifecycle bridge and let the Step 1 preflight gate (`task xbrief:preflight`) reject the candidates wholesale -- the gate's exit message tells the user WHAT failed but not WHY the source folder was wrong; the bridge is the contract that prevents that confusion before it surfaces.

⊗ Promote candidates outside the user's stated swarm scope. The bridge is scope-bounded by what the user asked the monitor to swarm on; out-of-scope candidates remain in `proposed/` / `pending/` for the refinement skill to own.

Cross-references:
- Setup-side deposit point: `skills/deft-directive-setup/SKILL.md` Phase 3 Output -- Light Path / Output -- Full Path (scope xBRIEFs land in `xbrief/proposed/`).
- Refinement-side deposit point: `skills/deft-directive-refinement/SKILL.md` Phase 4 -- Promote/Demote (lifecycle transitions via the same `task scope:promote` / `task scope:activate` surface).
- Underlying CLI: `task scope:promote` / `task scope:activate` (the deterministic state machine; idempotent on same-folder moves; three-state exit 0 / 1 / 2).
- Recurrence record: issue #1025 (2026-05-10 first-session consumer tic-tac-toe swarm; monitor hit `Invalid transition: 'activate' requires file in pending/` on all four candidate xBRIEFs because they were still in `proposed/`).

### Step 1: Read Project State and Readiness Report

- ! Scan `xbrief/active/` for candidate xBRIEFs (files matching `*.xbrief.json`)
- ! For each candidate xBRIEF, MUST run `task xbrief:preflight -- <path>` (the structural intent gate, #810) to validate lifecycle eligibility before allocation work. Skip any xBRIEF that exits non-zero -- the helper's stderr message is the actionable redirect (`task xbrief:activate <path>`). Surface the exit message in the Phase 0 Step 4 analysis so the user can route the lifecycle move; do NOT attempt to allocate, dispatch, or implement against a xBRIEF that fails the preflight.
- ! Run `task swarm:readiness -- xbrief/active/*.xbrief.json` before any agent allocation. This deterministic report is the allocator's source of truth for ready stories, blocked stories, decomposition-needed epics/phases, dependency waves, conflict groups, file overlap matrix, and missing fields.
- ! Treat `plan.metadata.kind = "epic"` and `plan.metadata.kind = "phase"` as **needs decomposition**, not merely incomplete. Route broad scopes to `skills/deft-directive-decompose/SKILL.md` instead of assigning them to workers.
- ! Read only readiness-approved story fields for allocation: `plan.title`, `plan.status`, non-empty `plan.items`, `planRef`, `references`, `plan.metadata.kind`, and `plan.metadata.swarm`.
- ! Read `xbrief/PROJECT-DEFINITION.xbrief.json` for project-wide context (narratives, scope registry)
- ! Determine the base branch: ask the user which branch to target for worktree creation, PR targets, and rebase cascade (default: `master`). Record this as the **configured base branch** for all subsequent phases.
- ⊗ Spawn an implementation agent (via `start_agent`, `oz agent run`, Warp tab dispatch, or any other path) for a xBRIEF that has not passed `task xbrief:preflight` -- the gate is the only authorization signal; affirmative continuation phrases and workflow-shape vocabulary are NOT (#810).
- ⊗ Allocate concurrent workers unless candidates are swarm-ready `kind=story` xBRIEFs with non-empty executable `plan.items` and `task swarm:readiness` exits 0.
- ⊗ Use manual file-overlap reasoning as the only safety check; use the readiness report first, then explain any additional human judgment.

### Step 2: Surface Blockers

- ! Identify blocked xBRIEFs (status `blocked`) and their blocking reasons (check `narrative` fields)
- ! Identify xBRIEFs with incomplete acceptance criteria (no `plan.items` or empty items array)
- ! Identify epic/phase scope xBRIEFs from the readiness report and route them to decomposition
- ! Identify dependency conflicts between candidate xBRIEFs (e.g. story A depends on story B via `planRef` or `edges`, but B is assigned to a different agent or is incomplete)
- ! Flag any candidate xBRIEFs whose prerequisites are unmet

### Step 3: Plan Allocation

! The monitor allocates one or more xBRIEFs to each agent based on scope, complexity, and dependencies. There is no fixed per-agent limit.

- ! **Small/independent stories** can be batched to a single agent only after explicit operator approval or an approved allocation plan -- group related or low-complexity xBRIEFs together and record the batching rationale
- ! **Large/complex stories** get dedicated agents — a story with broad file scope or high acceptance criteria count should not share an agent
- ! **Dependency-aware grouping** — xBRIEFs that share `planRef` to the same epic or have `edges` between them should be assigned to the same agent when possible, OR sequenced with clear ordering
- ! The monitor decides allocation dynamically — no hardcoded 1:1 rule
- ! **WIP cap awareness (#1124 / D4 of #1119)** — the cohort + any bridge-promoted candidates (Step 0.5) MUST fit within `plan.policy.wipCap` (default 20 per #2319, raised from the original 10 per umbrella #1119 Current Shape v3). When `pending/ + active/` count is at-or-above the cap, `task scope:promote` refuses with an error message naming `task scope:demote <existing>` and `task scope:demote --batch --older-than-days 30` as the relief valves. The monitor MUST drain the WIP set via `task scope:demote` (D1 / #1121) before promoting more candidates, OR open a per-promote `task scope:promote <file> --force` (audit-logged as `wip_cap_override` in `xbrief/.eval/scope-lifecycle.jsonl`) for the genuinely time-critical case. `task triage:summary` (D2 / #1122) surfaces the cap as `WIP X/Y` with a warning glyph when at-or-above cap.

### Step 4: Present Analysis

! Present a summary to the user containing:

- **Candidate xBRIEFs**: story-level xBRIEFs eligible for assignment (with titles, statuses, and origin references)
- **Readiness report**: ready stories, blocked stories, decomposition-needed epics/phases, dependency waves, conflict groups, file overlap matrix, and missing fields from `task swarm:readiness`.
- **Preflight rejections (#810)**: any xBRIEFs that failed `task xbrief:preflight` in Step 1 -- include the file path AND the helper's exit message verbatim so the user can route the appropriate `task xbrief:activate <path>` move. These xBRIEFs MUST NOT be allocated until they pass the preflight on a re-run.
- **Blockers found**: blocked xBRIEFs, unresolved dependencies, items requiring design decisions
- **Decomposition needed**: epic/phase scopes that must go through `skills/deft-directive-decompose/SKILL.md` before swarm allocation
- **Incomplete xBRIEFs**: stories with missing or empty acceptance criteria
- **Allocation plan**: which agent gets which xBRIEF(s), with reasoning for batching decisions; multi-story batching is allowed only after explicit operator approval or approval of this allocation plan
- **Tentative version bump**: current version (from CHANGELOG.md or latest git tag) and proposed next version (patch/minor/major) based on the scope and nature of candidate items — this is advisory and will be confirmed before merge cascade

### Step 5: Get User Approval

- ! Wait for explicit user approval (`yes`, `confirmed`, `approve`) before proceeding to Phase 1 (Select)
- ! If the user requests changes to the allocation plan, re-analyze and re-present
- ⊗ Proceed to Phase 1 (Select) without completing the allocate phase and receiving explicit user approval
