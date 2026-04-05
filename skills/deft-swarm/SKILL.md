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
- ~ `oz` CLI available (for `oz agent run` local launch — see Phase 3 Option A)

## Phase 1 — Select

! Pick N items from ROADMAP.md and assign to agents. Each agent gets a coherent set of related work.

### Step 1: Identify Candidates

- ! Read ROADMAP.md for open items, prioritizing Phase 1 before Phase 2
- ! Read SPECIFICATION.md for acceptance criteria of candidate tasks
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

~ Generate `launch-agent.ps1` scripts using `oz agent run --cwd <worktree> --prompt` (Option A). Also prepare plain-text prompt versions for users who prefer Option B (manual Warp tab paste).

## Phase 3 — Launch

! **Warp tabs cannot be opened programmatically.** There is no API or CLI command to open a new Warp terminal tab from an agent or script.

! **⚠️ Option A (`oz agent run`) is currently limited** — it does NOT receive global Warp Drive rules, MCP server UUIDs, or auto-injected context. It is effectively as limited as cloud agents with respect to global context. A future Warp build with experimental orchestration support is expected to bring Option A to full parity. See issue #179 for details.

! The monitor agent MUST present options and their tradeoffs before launching:

- **Option A (automated local — currently limited):** `oz agent run --cwd <worktree> --prompt "..."` — local execution, codebase indexing, agent profiles; does NOT get global Warp Drive rules or MCP via UUID; inline MCP JSON workaround available but not zero-config
- **Option B (recommended — interactive local):** User manually opens Warp tabs, pastes prompt into agent chat — full MCP, codebase indexing, global Warp Drive rules, warm index from active session; requires manual tab management
- **Option C (cloud):** `oz agent run-cloud --prompt "..."` — remote VM execution, fully automated, no local context (no MCP, no codebase indexing, no Warp Drive rules); agents must rely on `gh` CLI and `AGENTS.md` only

! If the user says "launch" or "do it", default to Option B. Only use Option C if the user explicitly requests cloud execution. Option A may be used if the user explicitly requests it after being informed of its limitations.

⊗ Use `oz agent run-cloud` when the user expects local execution — `run-cloud` routes to remote VMs with no local context.
⊗ Silently launch any option without presenting the tradeoffs first.
⊗ Default to Option A without informing the user of its current limitations — always explain that it lacks global rules and MCP UUID support.

### Option A: oz agent run (automated local — currently limited)

⚠️ **Known limitations (see issue #179):** Option A agents do NOT receive global Warp Drive rules, MCP server UUIDs, Warp Drive notebooks, or any other auto-injected context. The only context they get is: `AGENTS.md` in the `--cwd` directory, the agent profile, and codebase indexing (non-blocking). This makes Option A as context-limited as Option C (cloud) — the only difference is execution location (local vs remote VM). A future Warp build with experimental orchestration support is expected to resolve this.

! For each agent, launch via the `oz` CLI:

```powershell
oz agent run --cwd "<worktree-path>" --prompt "TASK: You must complete..."
```

- ! `--cwd` sets the working directory to the agent's worktree
- ~ `--profile <id>` sets the agent profile; get IDs with `oz agent profile list`
- ! Codebase indexing is non-blocking — agent starts immediately, indexing completes in the background (not pre-warmed like Option B)
- ~ The generated `launch-agent.ps1` scripts should use this command
- ! `--mcp` with Warp MCP server UUIDs does NOT work — fails with "Failed to start MCP servers"
- ? **Inline MCP JSON workaround** — MCP can be passed as inline JSON instead of UUID, but requires knowing the endpoint URL and managing auth externally (not zero-config):

```powershell
oz agent run --cwd "<worktree-path>" --mcp '{"github": {"url": "https://api.githubcopilot.com/mcp/"}}' --prompt "TASK: ..."
```

- ! `AGENTS.md` in the worktree is the only reliable behavioral control surface for Option A agents — do not assume global rules are available
- ! Option A runs fully headless — permissions must be pre-configured in the agent profile; commands will silently fail if not
- ! Option A agents cannot be steered mid-run without going to oz.warp.dev; Option B agents are interruptible

### Option B: Warp Agent Conversations (recommended — interactive local)

! **This is the recommended launch method** until Option A gains parity with Warp's interactive context injection.

Ask the user to open N new Warp terminal tabs. For each tab, the user:
1. Navigates to the worktree: `cd <worktree>`
2. Pastes the prompt directly into the **Warp agent chat input** (not the terminal)

**What Option B gets that Option A does not:**
- Global Warp Drive rules (personal rules auto-injected)
- MCP servers via UUID (GitHub, etc. — zero-config)
- Warp Drive notebooks, workflows, and other auto-injected context
- Warm codebase index from the active Warp session (no cold-start delay)
- Agent is interruptible and steerable mid-run

**Tradeoff:** Requires the user to manually open and manage one Warp tab per agent. Not as scalable for large swarms, but provides the richest agent context.

### Option C: Cloud Agents via oz agent run-cloud (remote, no local context)

```powershell
# Agents run on remote VMs — no local MCP, codebase indexing, or Warp Drive rules
oz agent run-cloud --prompt "TASK: You must complete..."
```

Agents execute on remote VMs without local MCP servers, codebase indexing, or Warp Drive rules. Agents MUST use `gh` CLI for GitHub operations.

**Tradeoff vs Option B:** Fully automated with zero tab management, but context-starved — the agent has no MCP, no Warp Drive rules, and no codebase indexing. Best for tasks that are self-contained and don't need MCP or local file context. `AGENTS.md` is the only behavioral control surface.

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

! Take over an agent's workflow if ANY of these occur:

- Agent process has exited and PR has not been created
- Agent process has exited and Greptile review cycle was not started
- Agent is idle for >5 minutes after PR creation with no review activity
- Agent is stuck in an error loop (same error 3+ times)

When taking over: read the agent's current state (git log, diff, PR comments), complete remaining steps manually following the same deft process.

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

## Phase 6 — Close

### Step 1: Merge

! **Merge cascade warning:** Shared append-only files (CHANGELOG.md, SPECIFICATION.md) cause merge conflicts when PRs are merged sequentially — each merge changes the insertion point, conflicting remaining PRs. Each conflict requires rebase → push → wait for checks (~3 min). Plan for N-1 rebase cycles when merging N PRs.

~ To minimize cascades: rebase ALL remaining PRs onto latest master before starting any merges, then merge in rapid succession.

- ! Undraft PRs: `gh pr ready <number> --repo <owner/repo>`
- ! Squash merge: `gh pr merge <number> --squash --delete-branch --admin` (if branch protection requires)
- ! Use descriptive squash subject: `type(scope): description (#issues)`
- ! After each merge, rebase remaining PRs onto updated master before merging the next

### Step 2: Close Issues

- ! Close resolved issues with a comment referencing the PR
- ~ Issues with "Closes #N" in PR body auto-close on merge

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

STEP 6 — Review cycle: Follow skills/deft-review-cycle/SKILL.md to run the
Greptile review cycle on the PR. Do NOT merge — leave for human review.

CONSTRAINTS:
- Do not touch [list files other agents are working on]
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

## Anti-Patterns

- ⊗ Start prompts with context or description instead of an imperative TASK directive
- ⊗ Use `--mcp` with Warp MCP server UUIDs from standalone (non-Warp) terminals
- ⊗ Assign overlapping files to multiple agents
- ⊗ Merge PRs before Greptile exit condition is met (score > 3, no P0/P1)
- ⊗ Assume agents will complete the full workflow — always verify review cycle completion
- ⊗ Launch agents without checking SPECIFICATION.md for task coverage first
- ⊗ Skip the file-overlap audit in Phase 1
- ⊗ Use `git reset --hard` or force-push in any worktree
- ⊗ Launch agents without presenting all options and their tradeoffs — always show Option A/B/C tradeoffs and confirm with the user before launching.
- ⊗ Use `oz agent run-cloud` when the user asked for local agents — `run-cloud` spawns agents on remote VMs with no local context. Use `oz agent run` for local execution.
- ⊗ Assume Option A (`oz agent run`) gets global Warp Drive rules — it only gets `AGENTS.md` and explicitly passed context. Global rules, MCP UUIDs, and Warp Drive context require Option B (interactive Warp tab).
- ⊗ Default to Option A without disclosing its current limitations — always inform the user that Option A lacks global rules and MCP UUID support before launching.
- ⊗ Update ROADMAP.md during swarm close — it is updated only at release time (CHANGELOG promotion commit), not by individual agents or during PR merges.
