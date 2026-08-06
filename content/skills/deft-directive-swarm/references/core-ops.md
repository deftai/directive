# Swarm core — Crash recovery, prompts, push autonomy, anti-patterns

## Crash Recovery

When a monitor session crashes or a new session must take over an in-progress swarm, follow these steps to safely reconstruct and continue.

### Checkpoint Guidance

! At each major Phase 6 milestone, record progress so a new session can reconstruct state:

- **PR merged** — note the PR number, merge commit SHA, and which issues it closes
- **Rebase done** — note which branches have been rebased onto the latest master
- **Review passed** — note which PRs have passed the Greptile exit condition post-rebase

~ Use a brief structured note (in the conversation or a scratch file) after each milestone — this is the checkpoint a recovery session will read.

### Recovery Steps

! On a fresh session taking over a swarm, reconstruct the cascade state before taking any action:

1. ! Run `gh pr list --repo <owner>/<repo> --state all` to see all PRs from the swarm (filter by branch prefix, e.g. `agent1/`, `agent2/`)
2. ! For each PR, run `gh pr view <number> --json state,mergeCommit,headRefName,title` to determine:
   - Is this PR already merged? (state = MERGED) → skip, move to issue verification
   - Is this PR still open? → check if it needs rebase, re-review, or merge
   - Is this PR closed without merge? → investigate (was it superseded?)
3. ! For open PRs, check rebase status: `git --no-pager log --oneline <branch> ^origin/<configured-base-branch> -5` — if empty, the branch is already up-to-date with the configured base branch
4. ! For open PRs, check review status: `gh pr checks <number>` and `gh pr view <number> --comments` to verify Greptile review state
5. ! Resume the cascade from the first incomplete step — the idempotent pre-check pattern (see Step 1 above) ensures re-running any step on an already-completed PR is safe

### Idempotent Safety

! Every Phase 6 action MUST be safe to re-run:
- Merging an already-merged PR → `gh pr merge` will report "already merged" and exit cleanly
- Rebasing a branch already on latest configured base branch → rebase is a no-op
- Closing an already-closed issue → `gh issue close` will report "already closed"
- Force-pushing a branch that hasn't changed → push reports "Everything up-to-date"

## Prompt Template

! Use this template for all agent prompts. The first line MUST be an imperative task statement.

```
TASK: You must complete N [type] fixes on this branch ([branch-name]) in the deft directive repo.
This is a git worktree. Do NOT just read files and stop — you must implement all changes,
run iteration-lane validation during implement/fix loops, full task check before push,
commit, push, create a PR, and run the review cycle.
Drive every step to completion, subject to dual-stop (#2442): if a multi-iteration fix/repair
loop hits its failure/budget stop, halt with BLOCKED (operator-visible report) — do not thrash past the envelope.

STEP 1 — Read directives: Read AGENTS.md, vbrief/vbrief.md, and the assigned xBRIEF(s) from xbrief/active/.
Read skills/deft-directive-review-cycle/SKILL.md.

STEP 2 — Implement these N tasks (see assigned xBRIEF(s) for full acceptance criteria):

Task A (xBRIEF: [filename], issue #[N]): [one-paragraph description with specific acceptance criteria]

Task B (xBRIEF: [filename], issue #[N]): [one-paragraph description with specific acceptance criteria]

[...repeat for each task...]

STEP 3 — Validate: Use iteration fast lane during commits (affected/static gates). Run full task check once before push/PR (#1704). Fix any failures.

STEP 4 — Commit: Add CHANGELOG.md entries under [Unreleased].
Commit with message: [type]([scope]): [description] — with bullet-point body.

STEP 5 — Push and PR: Push branch to origin. Create PR targeting <configured-base-branch> using gh CLI.
Note: --body-file must use a temp file in the OS temp directory ($env:TEMP on PowerShell,
$TMPDIR or /tmp on Unix) -- do NOT write temp files in the worktree. See scm/github.md.

STEP 6 — Review cycle: Follow skills/deft-directive-review-cycle/SKILL.md to run the
Greptile review cycle on the PR. Do NOT merge — leave for human review.

CONSTRAINTS:
- Do not touch [list files other agents are working on]
- New source files (scripts/, src/, cmd/, *.py, *.go) must have corresponding test files in the same PR
- Use conventional commits: type(scope): description
- Iteration commits: affected/static fast lane only; full task check required before push (#1704)
- Never force-push
- Dual stop (#2442): multi-iteration fix/repair loops need success + failure/budget stop (build defaults: max 5 quality-fix iters or 3 identical no-progress; pre-PR: max 3 polish passes). On halt: operator-visible report (tried / missing / human decision). Single-turn work is exempt. Delivery/acceptance mechanical ledger is #3143.
```

### Template Rules

- ! First line MUST start with `TASK:` followed by an imperative statement
- ! Include a drive-to-completion instruction that is **subordinate to dual-stop** (#2442): complete all steps unless a multi-iteration failure/budget envelope is exhausted — then `BLOCKED` with an operator-visible report (do not use unconditional "DO NOT STOP" language that overrides the failure stop)
- ! Each task MUST include its xBRIEF filename and origin issue number
- ! CONSTRAINTS section MUST list files the agent must not touch (other agents' scope)
- ! Review cycle step MUST reference `skills/deft-directive-review-cycle/SKILL.md` explicitly
- ! Multi-iteration prompts MUST name dual-stop defaults (or point at `main.md` / build skill #2442) so workers do not thrash without a failure envelope
- ! **Unit-of-work envelope (#3153 / Gap C):** The prompt MUST declare `drive-to: merge-ready` **or** `stop-at: pr-open` (default merge-ready for story work). When `stop-at: pr-open`, state that the parent/monitor owns review-cycle babysit + post-merge `scope:complete` (worker MUST NOT `scope:complete` at exit). Selection tree: `references/core-phase-0.md` Envelope selection SLA.
- ⊗ Start the prompt with context ("You are working in...") — agents treat this as passive setup and may stop after reading
- ⊗ Write unconditional `DO NOT STOP until all steps are complete` without a dual-stop exception — that conflicts with the failure stop and causes thrash (#2442)
- ⊗ Omit the unit-of-work envelope line or leave merge-path ownership ambiguous after a deliberate `stop-at: pr-open` (#3153)

## Push Autonomy

! Swarm agents operating under this skill with a monitor agent may push, create PRs, and run review cycles autonomously after passing full `task check` at the merge chokepoint (#1704). The global "never push/commit without explicit user instruction" convention does not apply to swarm agents executing the full STEP 1-6 prompt workflow -- the skill's quality gates (merge chokepoint `task check`, Greptile review cycle) replace the interactive confirmation gate.

## Anti-Patterns

- ⊗ Parent conversation implements or babysits product fix/CI loops for **through merge** / **drive-to: merge-ready** story work when background subagent/worktree dispatch is available — even if cohort size is 1; use the swarm/solo-worker launch path (#3032 / #1880 Gap C)
- ⊗ Start prompts with context or description instead of an imperative TASK directive
- ⊗ Use `--mcp` with Warp MCP server UUIDs from standalone (non-Warp) terminals
- ⊗ Assign overlapping files to multiple agents
- ⊗ Merge PRs before Greptile exit condition is met (score > 3, no P0/P1)
- ⊗ Assume agents will complete the full workflow — always verify review cycle completion
- ⊗ Launch agents without checking xBRIEF acceptance criteria first
- ⊗ Skip the file-overlap audit in Phase 1
- ⊗ Use `git reset --hard` or force-push in any worktree (swarm agents only -- monitor may `--force-with-lease` after rebase cascade per Phase 6 Step 1)
- ⊗ Present static launch options (A/B/C) instead of detecting capabilities at runtime — always probe for `start_agent` and Warp environment variables before choosing a launch path
- ⊗ Offer Warp-specific launch paths (tabs, `start_agent`) when not running inside Warp — gate on `WARP_*` environment variables or `start_agent` tool presence
- ⊗ Default to `oz agent run-cloud` — cloud is an explicit user-requested escape hatch, not a default path
- ⊗ Use `oz agent run-cloud` when the user expects local execution — `run-cloud` routes to remote VMs with no local context
- ⊗ Proceed to Phase 1 (Select) without completing Phase 0 (Allocate) and receiving explicit user approval
- ⊗ Begin merge cascade without presenting the version bump proposal and receiving explicit user approval — the Phase 5→6 gate is mandatory
- ⊗ Ignore Greptile re-review latency when planning merge cascade timing -- each rebase force-push triggers a full re-review (~2-5 min), not an incremental diff
- ⊗ Proceed to the next merge in the rebase cascade before confirming the Greptile re-review is current (SHA match) and exit condition is met (confidence > 3, no P0/P1) on the rebased branch -- see `skills/deft-directive-review-cycle/SKILL.md` Step 4 for the monitoring approach
- ⊗ Spawn a replacement sub-agent without confirming the original is unresponsive via a lifecycle event (idle/blocked) — original agents (Warp tabs or Grok Build / spawn_subagent processes) can resume after apparent failure, and two concurrent agents on the same worktree will corrupt the tool_use/tool_result call chain (#261, #263)
- ⊗ Hardcode `start_agent` (or any single primitive) for Phase 6 review-cycle poller / post-PR sub-agent dispatch -- always delegate spawn to the platform adapter (per runtime detection from slices 1-3) so Grok Build / spawn_subagent and future platforms are first-class (#1342 Phase 6 unification)
- ⊗ Skip Phase 5 or the Phase 5→6 confirmation gate under time pressure or due to long context — the gate is mandatory regardless of conversation length, elapsed time, or context-window pressure
- ⊗ Run `git add` on a conflict-resolved file without re-reading and verifying structural integrity (no conflict markers, no collapsed lines, no encoding artifacts) -- see Phase 6 Step 1 read-back verification rule (#288)
- ⊗ Use shell regex (`sed`, `Select-String -replace`) to resolve `CHANGELOG.md` rebase conflicts -- prefer `task changelog:resolve-unreleased` (#911) for `[Unreleased]` conflicts; fall back to `edit_files` for encoding safety and exact match verification when the helper exits 1 (#288, #911)
- ⊗ Resolve a `CHANGELOG.md` `[Unreleased]` conflict by HEAD-take-and-discard -- the rebasing branch's new entry MUST land in the resolved file. Use `task changelog:resolve-unreleased` (#911) for the canonical union-merge or apply the union-merge pattern manually when the helper cannot mechanize the conflict
- ⊗ Hardcode a 1:1 xBRIEF-per-agent allocation rule — the monitor decides allocation dynamically based on scope, complexity, and dependencies
- ⊗ Complete a story without moving its xBRIEF from `active/` to `completed/` and updating its origin references
- ⊗ Declare a swarm closed without running the Phase 6 Step 1.5 cohort completion sweep (`task swarm:complete-cohort`) and confirming `task xbrief:validate` is green -- skipping it leaves the cohort's story xBRIEFs stranded in `active/` and their decompose-created epic parents stranded in `pending/`, the exact #1487 recurrence (the headless / multi-worker close-out is where the sweep was historically missed)
- ⊗ Declare a swarm closed while the cohort's `active/` -> `completed/` lifecycle moves remain uncommitted -- after the Step 1.5 sweep the monitor MUST commit them in a single `chore(xbrief): complete <slugs> post-merge` commit on the base branch and `git push origin <configured-base-branch>` (Phase 6 Step 2b). An uncommitted lifecycle record is invisible to every other clone and re-surfaces as lifecycle-sync drift at the next release; the post-merge commit is the prevention, `task reconcile:issues -- --apply-lifecycle-fixes` is only the recovery (#1358)
- ⊗ Hardcode `master` as the base branch -- always use the configured base branch from Phase 0
- ⊗ Treat a Greptile GitHub CheckRun of COMPLETED/NEUTRAL as equivalent to a passing review without inspecting the comment body. NEUTRAL is the result both when Greptile intentionally has nothing to say AND when it errored out mid-review; the two cases require opposite responses (#526)
- ⊗ Loop the monitor indefinitely on the Greptile-service-errored state or time out silently at the poll cap -- detect the "Greptile encountered an error" comment body, retry once via `@greptileai review` with a 10-minute cap, and on second error escalate to the user with the three-way choice (wait / empty retrigger commit / documented override) per Phase 6 Step 1 (#526)
- ⊗ Merge a rebased PR on the basis of the NEUTRAL CheckRun alone when the Greptile comment body is the error sentinel -- the service-side failure is indistinguishable from a clean pass at the CheckRun level, and any merge taken must be recorded as a documented override in the merge commit body (#526)
- ⊗ Omit override-merged PRs from the Phase 6 Step 5 Slack release announcement -- any merge that used the Greptile-service-errored override path MUST be called out with its one-line rationale so downstream readers can trace the documented override trail (#526)
- ⊗ Run `gh pr merge` on a PR that has any protected (umbrella / staying-OPEN) issue listed in `gh pr view <N> --json closingIssuesReferences` -- the link is persistent in GitHub's database from a prior PR body revision (or sidebar attachment) and survives body edits, commit-message edits, and explicit `--subject` / `--body-file` overrides; manually unlink via the PR's Development sidebar panel before merging (Layer 3, #701)
- ⊗ Skip the post-merge protected-issue reopen sweep for any squash merge that referenced an umbrella / staying-OPEN issue -- defense in depth catches Layer 3 false-positives the pre-merge inspection missed (#701)
- ⊗ Merge on the basis of a SUCCESS Greptile CheckRun alone -- the CheckRun signals review **completion**, not review **approval** (PR #652 incident; symmetric blind spot to the NEUTRAL CheckRun #526 case). Always run `task pr:merge-ready -- <N>` before `gh pr merge` to parse the comment body for confidence + P0 / P1 findings
- ⊗ Run `git checkout` (any branch) -- including the brief `cd <other-worktree>; git checkout master --quiet` shape -- in a worktree the merging agent does not own during Phase 6 Step 3 (Update Master) or Step 4 (Clean Up). Post-merge state-update semantics MUST be performed via `git fetch origin <base-branch>` from the merger's OWN worktree, never by switching HEAD on a sibling worktree another agent is actively using. Recurrence record: PR #797 merge session (2026-05-01); companion to the Sub-Agent Role Separation rules (#727) -- this anti-pattern extends the same boundary discipline from sub-agent spawn shape to worktree HEAD operations (#800)
- ⊗ Skip the Phase 0 Step 0.5 lifecycle bridge (#1025) and let the Step 1 preflight gate reject candidate scope xBRIEFs wholesale. The setup skill deposits scope xBRIEFs in `xbrief/proposed/` and the refinement skill leaves them in `xbrief/pending/`; the swarm Phase 0 Step 1 preflight only accepts `xbrief/active/` with `plan.status == "running"`. The bridge step (`task scope:promote -- <path>` then `task scope:activate -- <path>`) is the contract that converts proposed/pending candidates to active before allocation -- bypassing it re-surfaces the originating 2026-05-10 first-session consumer-swarm failure mode (`Invalid transition: 'activate' requires file in pending/`)
- ⊗ Auto-promote + activate every candidate in `xbrief/proposed/` or `xbrief/pending/` during the Phase 0 Step 0.5 bridge without explicit user approval (#1025). Proposed-stage xBRIEFs may be in a deliberate refinement queue (`skills/deft-directive-refinement/SKILL.md` Phase 4); silent promotion bypasses the user's lifecycle intent and may flip `plan.status` to `running` on scopes the user has not yet refined. Broad affirmatives (`proceed`, `do it`, `go ahead`) do NOT satisfy the bridge approval gate -- require an explicit `yes` / `confirmed` / `approve`
- ⊗ Describe heterogeneous sub-agent routing as Grok Build-only — provider-neutral dispatch separates dispatch provider, worker role, and model or agent selection; Composer-class coding agents, Cursor/cloud agents, and future adapters are first-class backends alongside Grok Build `spawn_subagent` (#1531)
- ⊗ Assume parent-shell `gh auth status` proves a worker sandbox can authenticate or reach GitHub — always run `task verify:gh-auth` from the worker envelope and surface full-access execution, trusted `gh` allowlisting, or injected-token handoff when sandbox auth fails (#1557)
- ⊗ Present Cursor sandbox UID 0 or sandbox-root cwd ownership as host-root access — `sandbox_uid_remap` means the sandbox identity is remapped to the host user, not real root (#1557)
- ⊗ Fall through to the manual-terminal fallback (Step 2b) when spawn_subagent is available -- Step 2d is the first-class grok-build launch path; manual terminal is for environments with no orchestration primitive at all (#1331)
- ⊗ Misclassify OpenClaw `sessions_spawn` as `grok-build` / `spawn_subagent` or fall through to `generic-terminal` when `sessions_spawn` is present — Step 2f is the first-class OpenClaw path and descriptor `openclaw` is Tier 1 (#2875)
- ⊗ Hardcode Cursor/Warp/grok-only launch, monitor, or Phase 6 post-PR dispatch branches when the platform descriptor is `openclaw` — use `sessions_spawn` and the openclaw completion channel (#2875)
- ⊗ Surface, propose, or discuss the Phase 5 -> 6 merge cascade gate while `task swarm:verify-review-clean -- <pr-numbers...>` has not yet exited 0 on the current cohort (#1364). Keying the transition on poller lifecycle completion alone -- i.e. treating "every poller sub-agent returned a terminal message" as sufficient to surface the merge gate -- is the recurrence pattern from the #1166 swarm execution where multiple pollers exited with `clean_gate_holdout=confidence` (confidence == 3) and the monitor still raised the Phase 5 -> 6 gate. The cohort verifier is the only authoritative CLEAN signal at the cohort level; a poller's `clean_gate_holdout=*` exit IS a non-CLEAN report and MUST hold the gate even when every sub-agent has technically returned

- ⊗ Load all host adapters “just in case” — detect host, then load core + **one** `references/host-*.md` only (#2928)
- ⊗ DIY parallel `sessions_spawn` (or any multi-leaf OpenClaw dispatch) on the shared repo root without worktree prep or a worktree-map (#2929)
- ⊗ End a cohort phase-boundary turn with only narrative “I will spawn…” / “review next” and zero next-phase tool calls and no explicit terminal status (`blocked` / `awaiting-human` / `done`) (#2934)
- ⊗ Multi-sentence progress-only first response after leaf completion announce (`subagent_announce` / parent-push) with zero tools / yield — tool-first ground-truth batch, host yield, or one short non-repeated answer only (#2943 text-repetition hang)
- ⊗ N>2 near-identical assistant sentences in one turn with no tool_use / yield — FC14 hard-stop (`evaluateParentTurnShape` in `packages/core/src/parent-turn-shape/`; soft prose not sole mitigation) (#3131 / #2943)
- ⊗ Treat thin DONE (completion without PR URL / merge evidence) as success — re-dispatch or take over after ground truth (#2943)
- ⊗ Treat a `drive-to: merge-ready` exit with PR open but no merge-ready evidence as a designed handoff — it is FAILED thin DONE; recover with **one** continuation or review-cycle babysit owner, never dual lease (#3153 / #2943 / #3044)
- ⊗ Dispatch `stop-at: pr-open` without a named review-cycle partner merge-path owner (babysit / Approach 1 monitor + sticky lease + post-merge `scope:complete` plan) (#3153)
- ⊗ Freestyle Cursor global babysit or a second parallel review-monitor when recovering thin DONE or owning a stop-at:pr-open handoff (#2261 / #3044 / #3153)
- ⊗ Second+ user-visible consolidate / final for the same child `runId` / settle batch without new evidence or principal reopen — completion latch silent-replay path (`templates/agent-prompt-preamble.md` §11.5 / #3092)
- ⊗ Full dual-source re-QC solely because the harness re-delivered the same settle event (#3092)
- ⊗ Run multi-iteration repair, monitor, or implement-fix loops without a dual-stop failure envelope (max iterations and/or no-progress and/or budget) (#2442)
- ⊗ Silently continue, re-dispatch, or open another identical attempt after the failure stop fires — halt with an operator-visible report (what was tried, what is missing, what human decision is needed) (#2442)
- ⊗ Treat dual-stop skill defaults as a durable delivery-attempt ledger — mechanical cross-revision circuit breaker is #3143, not prompt-only thrashing control (#2442)
