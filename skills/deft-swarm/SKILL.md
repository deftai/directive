---
name: deft-swarm
description: >
  Parallel local agent orchestration. Use when running multiple agents
  on roadmap items simultaneously — to select non-overlapping tasks, set up
  isolated worktrees, launch agents with proven prompts, monitor progress,
  handle stalled review cycles, and close out PRs cleanly.
---

# Deft Swarm

Structured workflow for a monitor agent to orchestrate N parallel local agents working on roadmap items.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [swarm.md](../../swarm/swarm.md) | [deft-review-cycle](../deft-review-cycle/SKILL.md)

## When to Use

- User says "run agents", "parallel agents", "swarm", or "launch N agents on roadmap items"
- Multiple independent roadmap items need to be worked on simultaneously
- A batch of Phase 1/Phase 2 items are ready and have no mutual dependencies

## Prerequisites

- ! ROADMAP.md and SPECIFICATION.md exist with actionable items
- ! GitHub CLI (`gh`) is authenticated
- ! `git` supports worktrees (`git worktree` available)
- ~ `oz` CLI available (for `oz agent run-cloud` cloud launch — see Phase 3 Step 2c)

## Phase 0 — Analyze

! Before selecting tasks, analyze the roadmap and specification state to surface blockers and missing coverage.

### Step 1: Read Project State

- ! Read ROADMAP.md for open items, priorities, and phase assignments
- ! Read SPECIFICATION.md for task coverage, statuses, and dependency chains
- ! Cross-reference: every candidate roadmap item should have a corresponding spec task

### Step 2: Surface Blockers

- ! Identify blocked spec tasks (status `[blocked]`) and their blocking reasons
- ! Identify roadmap items with no corresponding spec task (missing spec coverage)
- ! For each candidate item missing spec coverage: create a skeleton spec task in SPECIFICATION.md before proceeding to Phase 1. Use the format defined in `skills/deft-roadmap-refresh/SKILL.md` Phase 2 Step 4. Swarm agents cannot implement work that has no spec task -- the skeleton ensures every assigned task has a traceable spec entry.
- ! Identify dependency conflicts between candidate items (e.g. task A depends on task B, but B is assigned to a different agent or is incomplete)
- ! Flag any candidate items whose prerequisites are unmet

### Step 3: Present Analysis

! Present a summary to the user containing:

- **Candidate items**: roadmap items eligible for assignment (with spec task IDs and statuses)
- **Blockers found**: blocked tasks, unresolved dependencies, items requiring design decisions
- **Missing spec tasks**: roadmap items that need spec task creation before work can begin
- **Recommendations**: suggested items to include or exclude, with reasoning
- **Tentative version bump**: current version (from CHANGELOG.md or latest git tag) and proposed next version (patch/minor/major) based on the scope and nature of candidate items — this is advisory and will be confirmed before merge cascade

### Step 4: Get User Approval

- ! Wait for explicit user approval (`yes`, `confirmed`, `approve`) before proceeding to Phase 1 (Select)
- ! If the user requests changes to the candidate list, re-analyze and re-present
- ⊗ Proceed to Phase 1 (Select) without completing the analyze phase and receiving explicit user approval

## Phase 1 — Select

! Pick N items from ROADMAP.md and assign to agents. Each agent gets a coherent set of related work.

### Step 1: Identify Candidates

- ! Use the candidate list and cross-reference produced in Phase 0 — Analyze as the starting point
- ! Re-read ROADMAP.md and SPECIFICATION.md only if Phase 0 was skipped (user override) or context was lost
- ! Cross-reference ROADMAP.md items against SPECIFICATION.md task status — if a roadmap item has a spec task marked `[completed]`, verify the work is actually done (check files) before assigning. ROADMAP.md may lag behind SPECIFICATION.md.
- ! Exclude items that are blocked, have unresolved dependencies, or require design decisions

### Step 2: File-Overlap Audit

! Before assigning tasks to agents, list every file each task is expected to touch.

- ! Verify ZERO file overlap between agents — no two agents may modify the same file
- ! Check **transitive** file touches, not just primary scope — trace each task's acceptance criteria to specific files. A task may require changes to files outside its obvious scope (e.g., an enforcement task adding an anti-pattern to a skill file owned by another agent).
- ! Shared files (CHANGELOG.md, SPECIFICATION.md) are exceptions — each agent adds entries but does not edit existing content
- ! If overlap exists, reassign tasks until overlap is eliminated

⊗ Include ROADMAP.md as a shared exception — ROADMAP.md is updated only at release time by the monitor/release manager, not by swarm agents.

⊗ Proceed to Phase 2 while any file overlap exists between agents (excluding shared append-only files).
⊗ Assume a task only touches files in its primary scope — always check acceptance criteria for cross-file requirements.

### Step 3: Present Assignment

- ! Show the user: agent number, branch name, assigned tasks (with issue numbers), and files each agent will touch
- ~ Wait for user approval unless the user explicitly said to proceed autonomously

## Phase 2 — Setup

### Step 1: Create Worktrees

For each agent, create an isolated git worktree:

```
git worktree add <path> -b <branch-name> master
```

- ! One worktree per agent (e.g. `E:\Repos\deft-agent1`, `E:\Repos\deft-agent2`)
- ! Branch naming: `agent<N>/<type>/<issue-numbers>-<short-description>` (e.g. `agent1/cleanup/31-50-23-strategy-consolidation`) — the agent number prefix aids traceability since GitHub PR numbers won't match agent numbers
- ! All worktrees branch from the same base (typically `master`)

### Step 2: Generate Prompt Files

! Create a `launch-agent.ps1` (Windows) or `launch-agent.sh` (Unix) in each worktree using the Prompt Template below.

~ Also prepare plain-text prompt versions for pasting into Warp agent chat or other terminal interfaces.

## Phase 3 — Launch

### Step 1: Runtime Capability Detection

! Before selecting a launch method, probe the environment to determine the best available path.

1. ! **Probe for `start_agent` tool** — check the available tool set for `start_agent` (or equivalent agent-orchestration tool). Its presence indicates a Warp environment with native orchestration support.
2. ! **Probe for Warp environment** — if `start_agent` is not available, check for `WARP_*` environment variables (e.g. `WARP_TERMINAL_SESSION`, `WARP_IS_WARP_TERMINAL`). Their presence indicates Warp without orchestration.
3. ! **Select launch path automatically** based on detection results — do NOT present static options:
   - **`start_agent` available** → Orchestrated launch (Step 2a) — preferred path, fully automated, no manual tab management
   - **`start_agent` unavailable, Warp detected** → Interactive Warp tabs (Step 2b) — full MCP, global rules, warm index; requires manual tab management
   - **No Warp detected** → Manual terminal launch (Step 2b fallback) — paste prompt into any terminal with access to the worktree
4. ? **Cloud escape hatch** — use `oz agent run-cloud` (Step 2c) ONLY if the user explicitly requests cloud execution. Never default to cloud.

⊗ Present static launch options (A/B/C) instead of detecting capabilities at runtime.
⊗ Offer Warp-specific launch paths (tabs, `start_agent`) when not running inside Warp — gate on `WARP_*` environment variables or `start_agent` tool presence.

### Step 2a: Orchestrated Launch (start_agent available)

! When `start_agent` is detected in the tool set, use it directly to launch each agent.

- ! Launch one agent per worktree using `start_agent` with the generated prompt and worktree path as the working directory
- ! Agents inherit the current environment's MCP servers, Warp Drive rules, and codebase index — equivalent to interactive Warp tabs but without manual tab management
- ! No user intervention needed — launch is fully automated
- ~ This is the preferred path: richest context with zero manual overhead

### Step 2b: Interactive Warp Tabs (start_agent unavailable, Warp detected)

! When `start_agent` is not available but Warp is detected (via `WARP_*` environment variables), fall back to manual Warp tab launch — briefly note that orchestrated launch is not available in this session, then proceed with the tab instructions below.

! **Warp tabs cannot be opened programmatically.** There is no API or CLI command to open a new Warp terminal tab from an agent or script.

Ask the user to open N new Warp terminal tabs. For each tab, the user:
1. Navigates to the worktree: `cd <worktree>`
2. Pastes the prompt directly into the **Warp agent chat input** (not the terminal)

**Context advantages of Warp tabs:**
- Global Warp Drive rules (personal rules auto-injected)
- MCP servers via UUID (GitHub, etc. — zero-config)
- Warp Drive notebooks, workflows, and other auto-injected context
- Warm codebase index from the active Warp session (no cold-start delay)
- Agent is interruptible and steerable mid-run

**Tradeoff:** Requires the user to manually open and manage one Warp tab per agent.

? If not running inside Warp at all (no `WARP_*` variables, no `start_agent`), use the same tab approach but with any terminal emulator — the user pastes prompts into their preferred terminal or agent interface.

### Step 2c: Cloud Agents (explicit user request only)

! Use `oz agent run-cloud` ONLY when the user explicitly requests cloud execution. Never default to this path.

```powershell
oz agent run-cloud --prompt "TASK: You must complete..."
```

Agents execute on remote VMs without local MCP servers, codebase indexing, or Warp Drive rules. Agents MUST use `gh` CLI for GitHub operations. `AGENTS.md` is the only behavioral control surface.

**Tradeoff:** Fully automated with zero tab management, but context-starved — no MCP, no Warp Drive rules, no codebase indexing. Best for self-contained tasks that don't need rich local context.

⊗ Default to cloud launch — it is an escape hatch, not a default path.
⊗ Use `oz agent run-cloud` when the user expects local execution — `run-cloud` routes to remote VMs with no local context.

## Phase 4 — Monitor

### Polling Cadence

- ~ Check each agent's worktree every 2–3 minutes: `git status --short` and `git log --oneline -3`
- ~ After 5 minutes with no changes, check if the agent process is still running

### Checkpoints

Track each agent through these stages:

1. **Reading** — agent is loading AGENTS.md, SPECIFICATION.md, project files (no file changes yet)
2. **Implementing** — working tree shows modified files
3. **Validating** — agent running `task check`
4. **Committed** — new commit(s) in `git log`
5. **Pushed** — branch exists on `origin`
6. **PR Created** — PR visible via `gh pr list --head <branch>`
7. **Review Cycling** — additional commits after PR creation (Greptile fix rounds)

### Takeover Triggers

! **Pre-spawn verification:** Before spawning a replacement agent, verify the original is truly unresponsive by waiting for an idle/blocked lifecycle event (e.g. the agent's Warp tab shows no tool calls in progress, no pending shell commands, and no recent output). Do NOT spawn a replacement based solely on message timing, absence of recent commits, or a perceived delay — original Warp tabs can resume after apparent failure, and spawning a new agent creates two concurrent agents on the same worktree (see Duplicate-Tab Failure Mode below).

! Take over an agent's workflow if ANY of these occur:

- Agent process has exited and PR has not been created
- Agent process has exited and Greptile review cycle was not started
- Agent is idle for >5 minutes after PR creation with no review activity
- Agent is stuck in an error loop (same error 3+ times)

When taking over: read the agent's current state (git log, diff, PR comments), complete remaining steps manually following the same deft process.

### Duplicate-Tab Failure Mode

⚠️ **Root cause of #261 and #263:** Original Warp agent tabs may resume after apparent failure (network hiccup, temporary Warp UI freeze, context window pressure). If the monitor spawns a new agent for the same worktree, two concurrent agents execute on the same branch simultaneously. This corrupts the `tool_use`/`tool_result` message chain — both agents issue tool calls, but responses are interleaved unpredictably, causing one or both agents to act on stale or incorrect state.

**Recovery guidance:**
- ! Keep original agent tabs open until their PR is merged — do not close tabs that appear stalled
- ! If an agent appears stalled, go to its original Warp tab and tell it to resume (e.g. "continue from where you left off") rather than spawning a replacement
- ! If the original tab is truly unrecoverable (Warp crash, tab closed), only then create a new agent — and first verify the worktree state (`git status`, `git log`, `gh pr list`) to avoid conflicting with any in-flight work

### Context-Length Warning

! Long monitoring sessions accumulate large conversation history (hundreds of tool_use/tool_result pairs) and are susceptible to conversation corruption — the tool_use/tool_result mismatch observed in #263 occurred at approximately message 158 in a single monitor conversation. To mitigate:

- ! Offload rebase, review-watch, and merge sub-tasks to ephemeral sub-agents using the tiered approach from `skills/deft-review-cycle/SKILL.md` (spawn via `start_agent` when available, discrete tool calls with yield otherwise) — this keeps the monitor conversation shallow
- ~ Target <100 tool-call round-trips in any single monitor conversation before considering a fresh session handoff
- ! If the monitor detects degraded output (repeated errors, inconsistent state references, tool call failures), stop and hand off to a fresh session with a state summary rather than continuing in a corrupted context

## Phase 5 — Review

### Verify Review Cycle Completion

For each agent's PR:

1. ! Check that Greptile has reviewed the latest commit (compare "Last reviewed commit" SHA to branch HEAD)
2. ! Verify Greptile confidence score > 3
3. ! Verify no P0 or P1 issues remain (P2 are non-blocking style suggestions)
4. ! If the agent did not complete its review cycle, the monitor runs it per `skills/deft-review-cycle/SKILL.md`

### Exit Condition

All PRs meet ALL of:
- Greptile confidence > 3
- No P0 or P1 issues remain (P2 issues are non-blocking style suggestions and do not gate merge)
- `task check` passed (or equivalent validation completed)
- CHANGELOG entries present under `[Unreleased]`

### Phase 5→6 Gate: Release Decision Checkpoint

! Before proceeding to Phase 6 (Close), the monitor MUST present the proposed release scope and version bump to the user for confirmation.

⊗ **Context-pressure bypass prohibition:** Even under long-context or time pressure (large conversation history, many tool calls, approaching context limits), this gate MUST NOT be bypassed. The Phase 5→6 gate is mandatory regardless of conversation length, elapsed time, or perceived urgency. If the monitor's context is degraded, hand off to a fresh session rather than skipping the gate.

1. ! Present a summary containing:
   - **PRs ready to merge**: list of PRs with titles, issue numbers, and current review status
   - **Proposed version bump**: the tentative version from Phase 0 (patch/minor/major) with rationale — updated if scope changed during implementation
   - **Release scope**: brief description of what this batch of changes represents
2. ! **Merge-readiness checklist:** Before any `gh pr merge` call, the monitor MUST emit a structured checklist confirming each PR is merge-ready. For each PR, verify and explicitly confirm:
   - Greptile confidence score > 3
   - No P0 or P1 issues remaining
   - `task check` passed on the branch
   - CHANGELOG.md entry present under `[Unreleased]`
   - Explicit user approval received for this merge cascade
3. ! Wait for explicit user approval (`yes`, `confirmed`, `approve`) before proceeding to Phase 6 merge cascade
4. ! If the user requests changes (e.g. different version bump, defer a PR), adjust and re-present

⊗ Begin merge cascade without presenting the version bump proposal and receiving explicit user approval.

## Phase 6 — Close

### Step 1: Merge

! **Per-PR sub-agent identity gate:** Before acting on any PR (merge, force-push, status check), query the specific sub-agent responsible for that PR for live status. Do not infer a PR's status from a different agent's tab, from message timing, or from the absence of recent commits. If the responsible agent is unreachable, verify PR state directly via `gh pr view <number>` and `gh pr checks <number>` before proceeding.

! **Idempotent pre-check pattern:** Before each action in the merge cascade, verify the current PR/branch state to ensure the action is still needed and safe to execute. Check: is this PR already merged (`gh pr view <number> --json state --jq .state`)? Is this branch already rebased onto the latest master? Has this issue already been closed? This makes recovery re-runs safe — a crash mid-cascade can resume from any point without duplicate actions or errors.

! **Merge authority:** Monitor proposes merge order and executes merges; user approves before the first merge. Do not merge without explicit user approval.

! **Rebase cascade ownership:** Monitor owns rebase cascade sequencing. Swarm agents do not rebase -- by the time merges begin, swarm agents are idle or complete. The monitor fetches updated master, rebases each remaining branch, resolves conflicts, and force-pushes.

! **Read-back verification after conflict resolution:** After resolving any rebase conflict and BEFORE running `git add`, re-read the resolved file and verify structural integrity:
- ! No conflict markers remain (`<<<<<<<`, `=======`, `>>>>>>>`)
- ! No collapsed or missing lines (compare line count to pre-rebase version if feasible)
- ! No encoding artifacts (BOM injection, mojibake, replacement characters)
- ! For `CHANGELOG.md` and `SPECIFICATION.md` conflicts: prefer `edit_files` over shell regex (`sed`, `Select-String -replace`) for resolution -- edit_files preserves encoding and provides exact match verification, while regex substitutions risk silent line collapse or encoding corruption
- ⊗ Run `git add` on a conflict-resolved file without first re-reading it and verifying structural integrity

! **Non-interactive rebase:** Monitor MUST set `GIT_EDITOR=true` (Unix/WSL/Git Bash) or `$env:GIT_EDITOR="echo"` (Windows PowerShell) before running `git rebase --continue` during merge cascade to prevent the default editor from blocking the agent.

! **Merge cascade warning:** Shared append-only files (CHANGELOG.md, SPECIFICATION.md) cause merge conflicts when PRs are merged sequentially — each merge changes the insertion point, conflicting remaining PRs. Each conflict requires rebase → push → wait for checks (~3 min) + ~2-5 min Greptile re-review per rebase. Plan for N-1 rebase cycles × ~3 min CI + ~2-5 min Greptile re-review per rebase when merging N PRs.

! **Greptile re-review on rebase force-push:** Force-pushing a rebased branch triggers a **full** Greptile re-review (not an incremental diff), even if the rebase introduced no logic changes. Expected latency is ~2-5 minutes per PR in the cascade. Factor this into merge sequencing.

! **Autonomous re-review monitoring after force-push:** After each `--force-with-lease` push of a rebased branch in the cascade, the monitor MUST autonomously wait for the Greptile re-review to complete before proceeding to the next merge. Use the tiered monitoring approach defined in `skills/deft-review-cycle/SKILL.md` Step 4 Review Monitoring (Approach 1: spawn sub-agent via `start_agent` to poll and report back; Approach 2 fallback: discrete `run_shell_command` wait-mode calls with yield between polls, adaptive cadence -- see deft-review-cycle SKILL.md). Do NOT duplicate the full monitoring logic here -- follow the canonical skill.

! **Gate:** Do NOT proceed to the next merge in the cascade until the Greptile review for the rebased branch is current (pushed SHA matches "Last reviewed commit" SHA) AND the exit condition is met (confidence > 3, no P0/P1 issues remaining). A stale or in-progress review is not sufficient.

? **Rebase-only annotation:** If the force-push contains no logic changes (pure rebase onto updated master), the monitor MAY post a brief PR comment noting "rebase-only, no logic changes" to give Greptile context and help reviewers triage the re-review.

~ To minimize cascades: rebase ALL remaining PRs onto latest master before starting any merges, then merge in rapid succession.

~ **Parallel rebase + review monitoring (start_agent available):** When `start_agent` is available during the merge cascade, the monitor MAY launch parallel sub-agents to overlap rebase and review monitoring work. For example: while Greptile re-reviews PR #A after a rebase push, spawn a sub-agent to begin rebasing PR #B onto the latest master. Each sub-agent reports back via `send_message_to_agent` when its task (rebase complete, review passed) is done. This reduces total cascade wall-clock time from serial (rebase + review per PR) to overlapped. The gate remains: do NOT merge PR #B until its own Greptile review passes the exit condition.

- ! Undraft PRs: `gh pr ready <number> --repo <owner/repo>`
- ! Squash merge: `gh pr merge <number> --squash --delete-branch --admin` (if branch protection requires)
- ! Use descriptive squash subject: `type(scope): description (#issues)`
- ! After each merge, rebase remaining PRs onto updated master before merging the next

### Step 2: Close Issues

- ! Close resolved issues with a comment referencing the PR
- ~ Issues with "Closes #N" in PR body auto-close on squash merge
- ! After each squash merge, verify issues actually closed: `gh issue view <N> --json state --jq .state`. If not closed, close manually with a comment referencing the merged PR. Squash merge + closing keywords can silently fail to close issues (#167).

### Step 3: Update Master

- ! Pull merged changes: `git pull origin master`

### Step 4: Clean Up

- ! Remove worktrees: `git worktree remove <path>`
- ! Delete local branches: `git branch -D <branch>`
- ~ Delete launch scripts if still present
- ? If worktree removal fails (locked files from open terminals), note for manual cleanup

### Step 5: Update ROADMAP.md (release time only)

~ ROADMAP.md is updated during the CHANGELOG promotion commit (the release commit), not during swarm close. Batch-move all issues resolved in this release from their roadmap phase to the Completed section at that time.

⊗ Update ROADMAP.md during swarm close — leave it for the release commit.

### Step 6: Generate Slack Release Announcement

! After creating the GitHub release (or after the final merge if no formal release is created), generate a standard Slack announcement block and present it to the user for copy-paste into the team channel.

! The announcement block MUST include all of the following fields:

```
:rocket: *{Project Name} {version}* -- {release title}

*Summary*: {one-sentence description of the release scope}

*Key Changes*:
- {bullet per significant change, 3-5 items max}

*Stats*: {N} agents | ~{duration} elapsed | {N} PRs merged
*PRs*: {#PR1, #PR2, ...}
*Release*: {GitHub release URL}
```

- ! Populate version from the CHANGELOG promotion commit or git tag
- ! Populate release title from the CHANGELOG section heading or GitHub release title
- ! Key changes summarized from CHANGELOG `[Unreleased]` entries (not raw commit messages)
- ! Agent count and approximate duration from the swarm session (Phase 3 launch to Phase 6 close)
- ! PR numbers from the merged PRs in this swarm run
- ! GitHub release URL from the `gh release create` output (or `gh release view --json url` if already created)
- ~ Present the block as a code-fenced snippet the user can copy directly
- ? If no formal GitHub release was created (e.g. user deferred), still generate the announcement with a placeholder URL and note that the release is pending

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
3. ! For open PRs, check rebase status: `git --no-pager log --oneline <branch> ^origin/master -5` — if empty, the branch is already up-to-date with master
4. ! For open PRs, check review status: `gh pr checks <number>` and `gh pr view <number> --comments` to verify Greptile review state
5. ! Resume the cascade from the first incomplete step — the idempotent pre-check pattern (see Step 1 above) ensures re-running any step on an already-completed PR is safe

### Idempotent Safety

! Every Phase 6 action MUST be safe to re-run:
- Merging an already-merged PR → `gh pr merge` will report "already merged" and exit cleanly
- Rebasing a branch already on latest master → rebase is a no-op
- Closing an already-closed issue → `gh issue close` will report "already closed"
- Force-pushing a branch that hasn't changed → push reports "Everything up-to-date"

## Prompt Template

! Use this template for all agent prompts. The first line MUST be an imperative task statement.

```
TASK: You must complete N [type] fixes on this branch ([branch-name]) in the deft directive repo.
This is a git worktree. Do NOT just read files and stop — you must implement all changes,
run task check, commit, push, create a PR, and run the review cycle.
DO NOT STOP until all steps are complete.

STEP 1 — Read directives: Read AGENTS.md, PROJECT.md, SPECIFICATION.md, main.md.
Read skills/deft-review-cycle/SKILL.md.

STEP 2 — Implement these N tasks (see SPECIFICATION.md for full acceptance criteria):

Task A ([spec-task-id], issue #[N]): [one-paragraph description with specific acceptance criteria]

Task B ([spec-task-id], issue #[N]): [one-paragraph description with specific acceptance criteria]

[...repeat for each task...]

STEP 3 — Validate: Run task check. Fix any failures.

STEP 4 — Commit: Add CHANGELOG.md entries under [Unreleased].
Commit with message: [type]([scope]): [description] — with bullet-point body.

STEP 5 — Push and PR: Push branch to origin. Create PR targeting master using gh CLI.
Note: --body-file must use a temp file in the OS temp directory ($env:TEMP on PowerShell,
$TMPDIR or /tmp on Unix) -- do NOT write temp files in the worktree. See scm/github.md.

STEP 6 — Review cycle: Follow skills/deft-review-cycle/SKILL.md to run the
Greptile review cycle on the PR. Do NOT merge — leave for human review.

CONSTRAINTS:
- Do not touch [list files other agents are working on]
- New source files (scripts/, src/, cmd/, *.py, *.go) must have corresponding test files in the same PR
- Use conventional commits: type(scope): description
- Run task check before every commit
- Never force-push
```

### Template Rules

- ! First line MUST start with `TASK:` followed by an imperative statement
- ! Include `DO NOT STOP until all steps are complete` in the preamble
- ! Each task MUST include its spec task ID and issue number
- ! CONSTRAINTS section MUST list files the agent must not touch (other agents' scope)
- ! Review cycle step MUST reference `skills/deft-review-cycle/SKILL.md` explicitly
- ⊗ Start the prompt with context ("You are working in...") — agents treat this as passive setup and may stop after reading

## Push Autonomy

! Swarm agents operating under this skill with a monitor agent may push, create PRs, and run review cycles autonomously after passing `task check`. The global "never push/commit without explicit user instruction" convention does not apply to swarm agents executing the full STEP 1-6 prompt workflow -- the skill's quality gates (`task check`, Greptile review cycle) replace the interactive confirmation gate.

## Anti-Patterns

- ⊗ Start prompts with context or description instead of an imperative TASK directive
- ⊗ Use `--mcp` with Warp MCP server UUIDs from standalone (non-Warp) terminals
- ⊗ Assign overlapping files to multiple agents
- ⊗ Merge PRs before Greptile exit condition is met (score > 3, no P0/P1)
- ⊗ Assume agents will complete the full workflow — always verify review cycle completion
- ⊗ Launch agents without checking SPECIFICATION.md for task coverage first
- ⊗ Skip the file-overlap audit in Phase 1
- ⊗ Use `git reset --hard` or force-push in any worktree (swarm agents only -- monitor may `--force-with-lease` after rebase cascade per Phase 6 Step 1)
- ⊗ Present static launch options (A/B/C) instead of detecting capabilities at runtime — always probe for `start_agent` and Warp environment variables before choosing a launch path
- ⊗ Offer Warp-specific launch paths (tabs, `start_agent`) when not running inside Warp — gate on `WARP_*` environment variables or `start_agent` tool presence
- ⊗ Default to `oz agent run-cloud` — cloud is an explicit user-requested escape hatch, not a default path
- ⊗ Use `oz agent run-cloud` when the user expects local execution — `run-cloud` routes to remote VMs with no local context
- ⊗ Proceed to Phase 1 (Select) without completing Phase 0 (Analyze) and receiving explicit user approval
- ⊗ Update ROADMAP.md during swarm close — it is updated only at release time (CHANGELOG promotion commit), not by individual agents or during PR merges.
- ⊗ Begin merge cascade without presenting the version bump proposal and receiving explicit user approval — the Phase 5→6 gate is mandatory
- ⊗ Ignore Greptile re-review latency when planning merge cascade timing -- each rebase force-push triggers a full re-review (~2-5 min), not an incremental diff
- ⊗ Proceed to the next merge in the rebase cascade before confirming the Greptile re-review is current (SHA match) and exit condition is met (confidence > 3, no P0/P1) on the rebased branch -- see `skills/deft-review-cycle/SKILL.md` Step 4 for the monitoring approach
- ⊗ Spawn a replacement sub-agent without confirming the original is unresponsive via a lifecycle event (idle/blocked) — original Warp tabs can resume after apparent failure, and two concurrent agents on the same worktree will corrupt the tool_use/tool_result call chain (#261, #263)
- ⊗ Skip Phase 5 or the Phase 5→6 confirmation gate under time pressure or due to long context — the gate is mandatory regardless of conversation length, elapsed time, or context-window pressure
- ⊗ Run `git add` on a conflict-resolved file without re-reading and verifying structural integrity (no conflict markers, no collapsed lines, no encoding artifacts) -- see Phase 6 Step 1 read-back verification rule (#288)
- ⊗ Use shell regex (`sed`, `Select-String -replace`) to resolve `CHANGELOG.md` or `SPECIFICATION.md` rebase conflicts -- prefer `edit_files` for encoding safety and exact match verification (#288)
