---
name: deft-directive-refinement
description: >
  Conversational refinement session. Ingests external work items into
  vBRIEF proposed/ scope, deduplicates via origin references, evaluates
  proposals with the user, reconciles stale origins, and promotes/demotes
  scopes through the lifecycle using deterministic task commands.
triggers:
  - refinement
  - reprioritize
  - refine
---

# Deft Directive Refinement

Conversational refinement session -- ingest, evaluate, reconcile, and prioritize scope vBRIEFs with the user.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- User says "refinement", "reprioritize", or "refine"
- New issues have accumulated since the last refinement session
- Periodic maintenance pass (e.g. weekly or after a batch of user feedback)
- User wants to review and reorganize the backlog

## Prerequisites

- ! `vbrief/` directory exists with lifecycle folders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`)
- ! GitHub CLI (`gh`) is authenticated and can access the repo
- ~ `PROJECT-DEFINITION.vbrief.json` exists (run `task project:render` if missing)

## Session Model

Refinement is a **conversational loop**, not a batch job. The user directs the flow:

- "Pull in issues" / "ingest" -> Phase 1 (Ingest)
- "Show proposed" / "evaluate" -> Phase 2 (Evaluate)
- "Check origins" / "reconcile" -> Phase 3 (Reconcile)
- "Accept these" / "reject that" / "promote" / "demote" -> Phase 4 (Promote/Demote)
- "Reprioritize" / "reorder pending" -> Phase 5 (Prioritize)
- "Close out" / "scope is done" / "completion" -> Phase 6 (Completion Lifecycle)
- "Done" / "exit" -> Exit

The agent may suggest the next phase, but the user decides. Phases can be entered in any order and repeated.

## Phase 0 -- Branch Setup

! Before making any changes, ensure you are working on a feature branch.

1. ! Check if the working tree has uncommitted changes that would conflict -- stop and ask the user to resolve them first
2. ! Create or switch to a refinement branch (e.g. `refinement/YYYY-MM-DD`) if not already on one
3. ! Confirm the branch and working directory to the user before proceeding

## Phase 1 -- Ingest

! Scan external sources for new work items and create proposed scope vBRIEFs.

### Step 1: Gather Sources

1. ! Fetch all open GitHub issues: `gh issue list --repo {owner/repo} --state open --limit 200 --json number,title,labels,createdAt,updatedAt`
2. ? Scan other configured sources (Jira, user requests, etc.) if applicable

### Step 2: Deduplicate via References

1. ! Read all existing vBRIEFs across all lifecycle folders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`)
2. ! Extract `references` entries from each vBRIEF to build a known-origins set
3. ! Diff the fetched issues against the known-origins set to identify:
   - **New items** -- issues not tracked by any existing vBRIEF reference (ingest targets)
   - **Already tracked** -- issues with an existing vBRIEF reference (skip)
4. ! Present the summary to the user: "{N} new items found, {M} already tracked"

### Step 3: Create Proposed vBRIEFs

! For each new item the user approves for ingest:

1. ! Create a scope vBRIEF in `vbrief/proposed/` with filename `YYYY-MM-DD-descriptive-slug.vbrief.json` (date is today's creation date)
2. ! Include origin provenance in `references`:
   ```json
   "references": [
     { "type": "github-issue", "url": "https://github.com/{owner}/{repo}/issues/{N}", "id": "#{N}" }
   ]
   ```
3. ! Set `plan.status` to `"proposed"`
4. ! Populate `plan.title` from the issue title
5. ~ Populate `plan.narratives` with a summary extracted from the issue body
6. ! Conform to vBRIEF v0.5 schema (`vBRIEFInfo.version: "0.5"`, `plan.title`, `plan.status`, `plan.items`)

⊗ Create vBRIEFs without origin provenance (`references` linking to the source)
⊗ Ingest an item that already has a matching vBRIEF reference -- deduplication must be checked first

## Phase 2 -- Evaluate

! List proposed items for interactive user review.

### Step 1: List Proposed Items

1. ! Read all vBRIEFs in `vbrief/proposed/`
2. ! Present each item with:
   - Title and filename
   - Origin link(s) from `references`
   - Summary from `narratives` (if populated)
   - Labels/category (if available from origin)
3. ! Sort by creation date (oldest first) or as user prefers

### Step 2: Interactive Review

! For each proposed item (or batch, as user directs):

- ! Present the item and wait for user decision
- ~ The user may: accept (promote to pending), reject (cancel), defer (keep in proposed), or request more detail
- ! Do not proceed to the next item until the user responds
- ? The user may batch-accept or batch-reject multiple items at once

⊗ Auto-accept or auto-reject proposed items without user review

## Phase 3 -- Reconcile (RFC D12)

! Check if linked origins have changed since the vBRIEF was last touched.

### Step 1: Scan for Staleness

1. ! For each vBRIEF in `proposed/` and `pending/` with a `github-issue` reference:
   - Fetch the issue: `gh issue view {N} --repo {owner/repo} --json updatedAt,state,title,body,comments`
   - Compare the issue's `updatedAt` against the vBRIEF's `vBRIEFInfo.updated` (or `vBRIEFInfo.created` if no `updated` field)
2. ! Categorize results:
   - **Stale** -- origin updated after vBRIEF was last modified
   - **Externally closed** -- origin issue is closed (duplicate, won't-fix, completed elsewhere)
   - **Current** -- no changes detected

### Step 2: Present Changes

1. ! For each stale vBRIEF, show the user what changed in the origin:
   - "Issue #{N} was updated {time ago} -- here's what changed: {summary of changes}"
   - Propose vBRIEF edits if the origin changes are material
2. ! For each externally closed vBRIEF:
   - "Issue #{N} was closed ({reason}) -- cancel this vBRIEF?"
   - Flag for user decision: cancel the vBRIEF or keep it (intentional divergence)

### Step 3: Apply Updates (User-Approved Only)

- ! Agent proposes vBRIEF edits; user approves each change
- ! Never auto-update vBRIEFs -- intentional divergence (vBRIEF refined beyond original issue scope) must be preserved
- ! For approved updates, update the vBRIEF content and `vBRIEFInfo.updated` timestamp

⊗ Auto-update vBRIEFs based on origin changes without user approval
⊗ Overwrite intentional divergence -- if a vBRIEF has been refined beyond the original issue, preserve the refinement

## Phase 4 -- Promote/Demote

! Move vBRIEFs between lifecycle folders using deterministic task commands.

### Available Commands

- `task scope:promote <file>` -- proposed/ -> pending/ (status: pending)
- `task scope:activate <file>` -- pending/ -> active/ (status: running)
- `task scope:complete <file>` -- active/ -> completed/ (status: completed)
- `task scope:cancel <file>` -- any -> cancelled/ (status: cancelled)
- `task scope:restore <file>` -- cancelled/ -> proposed/ (status: proposed)
- `task scope:block <file>` -- stays in active/ (status: blocked)
- `task scope:unblock <file>` -- stays in active/ (status: running)

### Workflow

1. ! Execute transitions using the task commands above -- they handle `plan.status` updates, `plan.updated` timestamps, and file moves atomically
2. ! After promotions/demotions, call `task roadmap:render` to regenerate ROADMAP.md
3. ! After significant lifecycle changes, call `task project:render` to update the PROJECT-DEFINITION items registry
4. ! Mark rejected items as `cancelled` via `task scope:cancel` (never delete vBRIEFs)

⊗ Move vBRIEFs between folders manually (cp/mv) -- always use `task scope:*` commands
⊗ Delete vBRIEFs -- use `task scope:cancel` to preserve history

## Phase 5 -- Prioritize

! Reorder and organize the pending backlog.

1. ! List all vBRIEFs in `vbrief/pending/` with titles, origins, and any phase/dependency metadata
2. ~ Help the user set phases and dependencies:
   - Group related items into phases (via vBRIEF `items` hierarchy or `tags`)
   - Identify dependencies between items (via `edges` in vBRIEF schema)
3. ! After reordering, call `task roadmap:render` to regenerate ROADMAP.md from the updated pending/ contents
4. ~ Present the regenerated roadmap summary to the user for confirmation

## Phase 6 -- Completion Lifecycle

! On scope completion, update origins to close the loop.

### When a Scope Completes

1. ! Read the completed vBRIEF's `references` array
2. ! For each `github-issue` reference:
   - Close the issue with a comment linking to the implementing PR:
     ```
     gh issue close {N} --comment "Completed via PR #{PR} -- scope vBRIEF: {filename}"
     ```
3. ? For other reference types (jira-ticket, user-request), follow the appropriate update mechanism
4. ! Update PROJECT-DEFINITION via `task project:render`

⊗ Complete a scope without updating its origins
~ Completion lifecycle can be triggered during refinement or as a standalone action after a PR merge

## CHANGELOG Convention

- ! Write ONE batch `CHANGELOG.md` entry at the END of the full refinement session -- not one entry per vBRIEF created or promoted. The batch entry summarizes all changes made during the session.
- ⊗ Add a CHANGELOG entry after each individual action during refinement -- wait until the full session is complete and write a single summary entry.

## PR & Review Cycle

After all refinement work is complete:

1. ! Ask the user: "Ready to commit and create a PR?"
2. ! Wait for explicit user confirmation before proceeding.

### Pre-Flight (before pushing)

! Run all pre-flight checks BEFORE committing and pushing:

1. ! Verify `CHANGELOG.md` has an `[Unreleased]` entry covering the refinement changes
2. ! Run `task check` -- all checks must pass
3. ! Verify `.github/PULL_REQUEST_TEMPLATE.md` checklist is satisfiable for this PR
4. ! **Mandatory file review**: Re-read ALL modified files before committing. Explicitly check for:
   - Encoding errors (em-dashes corrupted to replacement characters, BOM artifacts)
   - Unintended duplication (accidental double vBRIEFs or duplicate entries)
   - Structural issues (malformed vBRIEF JSON, broken references)
   - Semantic accuracy (verify that counts and claims in CHANGELOG entries match the actual data)

### Commit, Push, and Create PR

1. ! Commit with a descriptive message: `docs(vbrief): refinement session -- {summary}`
2. ! Push the branch to origin
3. ! Create a PR targeting the appropriate base branch

### Review Cycle Handoff

! After the PR is created, automatically sequence into `skills/deft-directive-review-cycle/SKILL.md`.

- ! Inform the user: "PR #{N} created -- starting review cycle."
- ! Follow the full review cycle skill from Phase 1 (Deft Process Audit) onward.

### EXIT

! When the review cycle completes (exit condition met) or the PR is ready for human review:

1. ! Explicitly confirm skill exit: "deft-directive-refinement complete -- exiting skill."
2. ! Provide chaining instructions to the user/agent:
   - If review cycle is complete and PR is approved: "PR #{N} is ready for human merge review."
   - If review cycle is still in progress: "Review cycle handed off to deft-directive-review-cycle. Monitor PR #{N} for Greptile findings."
   - If returning to a monitor agent: "Returning control to monitor agent -- refinement PR #{N} created and review cycle initiated."
3. ! Do NOT continue into adjacent work after this point -- the skill boundary is an exit condition.

## Anti-Patterns

- ⊗ Auto-accept or auto-reject proposed items without user review
- ⊗ Create vBRIEFs without origin provenance (`references` linking to the source)
- ⊗ Ingest items without deduplicating against existing vBRIEF references first
- ⊗ Auto-update vBRIEFs based on origin changes -- user approves all updates
- ⊗ Overwrite intentional divergence when reconciling stale origins
- ⊗ Move vBRIEFs between folders manually -- always use `task scope:*` commands
- ⊗ Delete vBRIEFs -- use `task scope:cancel` to preserve history
- ⊗ Complete a scope without updating its origins (closing issues, posting comments)
- ⊗ Skip deduplication during ingest -- always diff against existing references
- ⊗ Add a CHANGELOG entry per individual action during refinement -- write one batch entry at the end of the full session
- ⊗ Proceed to the next proposed item without waiting for user decision during evaluate
- ⊗ Auto-push without explicit user instruction
