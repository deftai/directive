# Swarm core — Phase 1 Select + Phase 2 Setup (host-neutral)

## Phase 1 — Select

! Finalize assignments from the allocation plan. Each agent gets a coherent set of related work.

### Step 1: Confirm Candidates

- ! Use the allocation plan and xBRIEF analysis from Phase 0 as the starting point
- ! Re-read `xbrief/active/` only if Phase 0 was skipped (user override) or context was lost
- ! For each candidate xBRIEF, verify its `plan.status` is `running` (not `blocked` or `completed`)
- ! Exclude xBRIEFs that are blocked, have unresolved dependencies, or require design decisions

### Step 2: File-Overlap Audit

! Before assigning tasks to agents, start from the `task swarm:readiness` file-overlap matrix and conflict groups, then list every file each xBRIEF's acceptance criteria are expected to touch.

- ! Verify ZERO file overlap between agents — no two agents may modify the same file
- ! Check **transitive** file touches, not just primary scope — trace each xBRIEF's acceptance criteria to specific files. A task may require changes to files outside its obvious scope (e.g., an enforcement task adding an anti-pattern to a skill file owned by another agent).
- ! Shared files (CHANGELOG.md) are exceptions — each agent adds entries but does not edit existing content
- ! If overlap exists, reassign tasks until overlap is eliminated

⊗ Proceed to Phase 2 while any file overlap exists between agents (excluding shared append-only files).
⊗ Assume a task only touches files in its primary scope — always check acceptance criteria for cross-file requirements.

### Step 3: Present Assignment

- ! Show the user: agent number, branch name, assigned xBRIEF(s) (with origin issue numbers), and files each agent will touch
- ~ Wait for user approval unless the user explicitly said to proceed autonomously

## Phase 2 — Setup

### Step 1: Create Worktrees

! **Two modes (C3 / #1387):** Phase 2 either CONSUMES a **pre-created worktree map** (the headless path, when `task swarm:launch --worktree-map <path>` supplied one) or creates worktrees itself (the interactive path). Mode A is preferred whenever a map is present; Mode B is the default otherwise.

#### Mode A -- Pre-created worktree map (C3, headless via `--worktree-map`)

- ! When `task swarm:launch -- ... --worktree-map <path>` supplied a **pre-created worktree map** (**C3**), Phase 2 CONSUMES it instead of running `git worktree add` per agent. The C3 map is a JSON array of `{ "story_id": str, "worktree_path": str, "base_branch": str }`.
- ! The launch engine resolves the worktree map via `resolveWorktreeMap` (`packages/core/src/swarm/worktrees.ts`), which validates normalized C3 records and RAISES on same-path collisions, base-branch mismatches, or a registered path whose HEAD OID differs from the requested base OID. The HEAD check is a snapshot at resolution time -- `swarm:launch` emits a manifest and stops, so HEAD can still move before spawn. The monitor MUST surface any such raise verbatim and HALT setup -- a same-path collision means two agents would share one worktree (the Duplicate-Agent Failure Mode in Phase 4).
- ! Each resolved record's `worktree_path` and `base_branch` feed straight into Phase 3 dispatch and MUST match the **C2** launch-manifest's `worktree_path` / `branch` fields for the same `story_id`.

#### Mode B -- Monitor-created worktrees (interactive path)

For each agent, create an isolated git worktree:

```
git worktree add <path> -b <branch-name> <configured-base-branch>
```

- ! One worktree per agent under deterministic ignored scratch paths by default: `.deft-scratch/worktrees/<story-id>`. This matches the headless `task swarm:launch` default and keeps interactive swarms from cluttering sibling checkout directories in the user's projects folder.
- ! If the C2 launch manifest is present, use the launch manifest's resolved `worktree_path` for that story instead of inventing a new path.
- ? `%TEMP%` or another OS temp location is an explicit override only for throwaway CI or rehearsal runs. When using OS temp, say that the worktree may disappear with temp cleanup and is not the durable default.
- ! Branch naming: `agent<N>/<type>/<issue-numbers>-<short-description>` (e.g. `agent1/cleanup/31-50-23-strategy-consolidation`) — the agent number prefix aids traceability since GitHub PR numbers won't match agent numbers
- ! All worktrees branch from the same base (the configured base branch from Phase 0)

### Step 2: Generate Prompt Files

! Create a `launch-agent.ps1` (Windows) or `launch-agent.sh` (Unix) in each worktree using the Prompt Template below.

~ Also prepare plain-text prompt versions for pasting into Warp agent chat or other terminal interfaces.

## Gate throughput — iteration fast lane vs merge chokepoint (#1704)

> **Invariant:** every change MUST pass the full gate at least once before merge. Swarm workers and human operators share the same commands.

- ! **Iteration lane:** during implement/fix loops, run affected/static gates (targeted tests on changed paths, relevant static `verify:*` gates, `task coverage:hotspots`) — NOT full `task check` on every commit.
- ! **Merge chokepoint:** run full `task check` once before push/PR open; CI enforces the same monolith at merge (#1704). Monitor checkpoints treat "Validating" as iteration-lane OR full gate; push requires full gate green at least once on the branch.
- ! **Escape-rate safety (#1703 Tier-1):** consult `task eval:health` and Tier-1 session telemetry (`helped/crud-metrics.jsonl`) before fleet-wide fast-lane tightening — do NOT invent a separate escape-rate surface.
- ~ **In-engine incrementality (#1713):** content-hash cache + runner-delegated affected plumbing is sibling work; this skill owns process policy only.
- ⊗ Require full `task check` on every swarm iteration commit when affected/static proxies suffice (#1704).

**Swarm cost model:** cohort workers move from `O(commits × full-gate)` toward `O(merges × full-gate) + O(iterations × cheap-proxy)` when they iterate with the fast lane and reserve full `task check` for PR/merge.
