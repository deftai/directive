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
- ! `oz` CLI is available (for `oz agent run` fallback path)
- ! `git` supports worktrees (`git worktree` available)

## Phase 1 — Select

! Pick N items from ROADMAP.md and assign to agents. Each agent gets a coherent set of related work.

### Step 1: Identify Candidates

- ! Read ROADMAP.md for open items, prioritizing Phase 1 before Phase 2
- ! Read SPECIFICATION.md for acceptance criteria of candidate tasks
- ! Exclude items that are blocked, have unresolved dependencies, or require design decisions

### Step 2: File-Overlap Audit

! Before assigning tasks to agents, list every file each task is expected to touch.

- ! Verify ZERO file overlap between agents — no two agents may modify the same file
- ! Shared files (CHANGELOG.md, SPECIFICATION.md) are exceptions — each agent adds entries but does not edit existing content
- ! If overlap exists, reassign tasks until overlap is eliminated

⊗ Proceed to Phase 2 while any file overlap exists between agents (excluding shared append-only files).

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
- ! Branch naming: `<type>/<issue-numbers>-<short-description>` (e.g. `cleanup/31-50-23-strategy-consolidation`)
- ! All worktrees branch from the same base (typically `master`)

### Step 2: Generate Prompt Files

! Create a `launch-agent.ps1` (Windows) or `launch-agent.sh` (Unix) in each worktree using the Prompt Template below.

## Phase 3 — Launch

### Option A: Warp Terminal Tabs (preferred)

Open a new Warp terminal tab for each agent, navigate to its worktree, and run the generated launch script:

```powershell
# The launch script sets $prompt from a here-string and passes it to oz
.\launch-agent.ps1
```

Alternatively, paste the prompt directly:

```
oz agent run --prompt "TASK: You must complete..."
```

This preserves MCP server access, codebase indexing, and Warp Drive rules.

### Option B: Standalone Terminals (fallback)

If Warp tabs are not available, launch via the generated scripts:

```powershell
Start-Process powershell -ArgumentList "-NoExit", "-File", "<worktree>/launch-agent.ps1"
```

⊗ Use `--mcp` with Warp MCP server UUIDs from standalone terminals — they require Warp app context and will fail with "Failed to start MCP servers". Agents MUST use `gh` CLI for GitHub operations in this mode.

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

- ! Undraft PRs: `gh pr ready <number> --repo <owner/repo>`
- ! Squash merge: `gh pr merge <number> --squash --delete-branch --admin` (if branch protection requires)
- ! Use descriptive squash subject: `type(scope): description (#issues)`

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
