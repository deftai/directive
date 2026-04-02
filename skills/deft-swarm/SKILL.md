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
- ~ `oz` CLI available (for cloud agent fallback — see Phase 3 Option C)

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

~ For Option A (Warp agent chat), also prepare a plain-text version of each prompt that the user can paste directly. The launch scripts are still useful for Option B/C (they call `oz agent run`).

## Phase 3 — Launch

! **Critical distinction: `oz agent run` launches CLOUD agents, not local agents.** The `oz` CLI always spawns agents on remote VMs. Cloud agents work (they can push, create PRs, run review cycles) but they do NOT have access to the user's local MCP servers, codebase indexing, or Warp Drive rules. For truly local agent execution, the user must paste the prompt into a Warp agent conversation.

! **Warp tabs cannot be opened programmatically.** There is no API or CLI command to open a new Warp terminal tab from an agent or script.

! The monitor agent MUST present all three options and their tradeoffs before launching:

- **Option A (preferred):** User manually opens Warp tabs, pastes prompt into agent chat — fully local, gets MCP, codebase indexing, Warp Drive rules
- **Option B:** `oz agent run` — cloud execution, no local context, but runs in parallel without user tab management
- **Option C:** `Start-Process` standalone terminals with `oz agent run` — same as B but in visible local windows

! If the user says "launch" or "do it", default to Option A (ask user to open tabs). Only use Option B/C if the user explicitly chooses cloud or standalone execution.

⊗ Use `oz agent run` when the user expects local execution — always clarify that `oz` routes to cloud.
⊗ Silently launch any option without presenting the tradeoffs first.

### Option A: Warp Agent Conversations (preferred — truly local)

Ask the user to open N new Warp terminal tabs. For each tab, the user:
1. Navigates to the worktree: `cd <worktree>`
2. Pastes the prompt directly into the Warp agent chat input (not the terminal)

Provide the prompt text for each agent (from the generated launch scripts or the Prompt Template).

This is the only option that preserves MCP server access, codebase indexing, and Warp Drive rules.

### Option B: Cloud Agents via `oz` CLI (parallel, no local context)

```powershell
# From any terminal — agents run on cloud VMs
oz agent run --prompt "TASK: You must complete..."
```

Agents execute on remote VMs with access to the git repo (they can clone, push, create PRs) but without the user's local MCP servers, codebase indexing, or Warp Drive rules. Agents MUST use `gh` CLI for GitHub operations.

### Option C: Standalone Terminal Windows (visible cloud agents)

```powershell
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '<worktree>'; .\launch-agent.ps1"
```

Same as Option B (cloud execution) but launched in visible terminal windows. The worktree directory provides context for the launch script but the actual agent runs remotely.

⊗ Use `--mcp` with Warp MCP server UUIDs from standalone terminals — they require Warp app context and will fail.

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
- ⊗ Launch standalone terminals without first asking the user if they want Warp tabs instead — Warp tabs preserve MCP, codebase indexing, and Warp Drive rules; standalone shells do not. Always default to asking for manual tab opens (Option A) unless the user explicitly requests standalone shells.
- ⊗ Use `oz agent run` when the user asked for local agents — `oz` always spawns cloud agents on remote VMs, not local Warp agents. For truly local execution, the user must paste the prompt into a Warp agent conversation.
