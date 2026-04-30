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
  - roadmap refresh
  - refresh roadmap
  - triage
---

# Deft Directive Refinement

Conversational refinement session -- ingest, evaluate, reconcile, and prioritize scope vBRIEFs with the user.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Platform Requirements

! This skill requires **GitHub** as the SCM platform and the **GitHub CLI (`gh`)** to be installed and authenticated. Issue ingestion, origin freshness checks, and completion lifecycle all depend on `gh`.

## Deterministic Questions Contract

! Every numbered-menu prompt rendered in this skill (Phase 2 Evaluate per-item accept/reject, Phase 3 Reconcile flagged-item walk, Phase 4 Promote/Demote lifecycle gates, Phase 5 Prioritize reorder gates) MUST follow [`../../contracts/deterministic-questions.md`](../../contracts/deterministic-questions.md): the final two numbered options MUST be `Discuss` and `Back`, in that order. The Discuss-pause semantic is documented verbatim there -- on `Discuss` selection the agent MUST halt the in-progress sequence immediately, prompt `What would you like to discuss?`, and resume only on an explicit user signal. Implicit resumption is forbidden.

## When to Use

- User says "refinement", "reprioritize", "refine", "roadmap refresh", "refresh roadmap", or "triage" (legacy v0.19 terms -- deft-directive-refinement is the current skill name)
- New issues have accumulated since the last refinement session
- Periodic maintenance pass (e.g. weekly or after a batch of user feedback)
- User wants to review and organize the backlog

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

1. ? Scan non-GitHub sources (Jira, direct user requests, etc.) manually if applicable — those ingest paths are not yet task-wrapped
2. ! GitHub issues are ingested via the task wrapper documented in Step 3 — the task fetches open issues itself, so no separate `gh issue list` call is needed

### Step 2: Deduplicate via References (Dry-Run Preview)

1. ? Run `task issue:ingest -- --all --dry-run` to preview which issues the ingest task would create scope vBRIEFs for. The task deduplicates candidates against `references` entries in existing vBRIEFs (across all lifecycle folders) so already-tracked issues are skipped automatically.
2. ! Present the user with the list of new-vs-already-tracked items the dry-run reports: "{N} new items found, {M} already tracked"
3. ! Wait for user approval before proceeding to ingest

### Step 3: Ingest Approved Items

! Delegate ingest to `task issue:ingest` — the task is the canonical implementation of scope-vBRIEF creation. Skills MUST NOT reinvent the slug rules, reference shape, or deduplication logic inline (see #537 for background).

- **Single issue**: `task issue:ingest -- <N>` — creates `vbrief/proposed/YYYY-MM-DD-<slug>.vbrief.json` with origin `references`, canonical slug from `scripts/slug_normalize.py` (see [`../../conventions/vbrief-filenames.md`](../../conventions/vbrief-filenames.md)), and schema-conformant shape.
- **Batch**: `task issue:ingest -- --all [--label <L>] [--status <S>]` — ingests every open issue matching the filters, skipping duplicates by `references.uri` match.
- **Preview**: add `--dry-run` to either form to preview without writing files.

The task emits vBRIEFs conforming to the canonical v0.6 schema (`vbrief/schemas/vbrief-core.schema.json`) with origin references in the form documented in [`../../conventions/references.md`](../../conventions/references.md):

```json
"references": [
  {
    "uri": "https://github.com/{owner}/{repo}/issues/{N}",
    "type": "x-vbrief/github-issue",
    "title": "Issue #{N}: {issue title}"
  }
]
```

- ! New scope vBRIEFs MUST target `"vBRIEFInfo": { "version": "0.6" }` (the task handles this automatically)
- ! `plan.status` starts at `"proposed"`; the task sets this
- ! Conform to `vbrief/schemas/vbrief-core.schema.json` (v0.6) -- the task validates before writing
- ~ After ingest, review the generated vBRIEFs with the user before promoting any of them to `pending/`

⊗ Hand-author scope vBRIEFs inside the skill when the ingest task exists — duplicating the narrative logic is how #534 (non-conformant references) and #537 (drift between skill and task) arise
⊗ Write references with `url`/`id`/bare `github-issue` types — use the schema-conformant `{uri, type, title}` shape above
⊗ Ingest an item that already has a matching vBRIEF reference -- `task issue:ingest` handles deduplication; skills MUST NOT duplicate that logic inline

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

! Check if linked origins have changed since the vBRIEF was last touched. Delegate the scan to `task reconcile:issues` and walk the user through flagged items for approval (see #537 for why the skill is a thin wrapper over the task).

### Step 1: Run the Reconciler

```
task reconcile:issues
```

The task scans every vBRIEF with a GitHub-backed reference (whether the reference uses the legacy `github-issue` bare type or the canonical `x-vbrief/github-issue` shape), fetches each linked issue, compares timestamps and state, and reports items in four buckets:

- **Linked & current** — origin has not changed since the vBRIEF was last updated (no action)
- **Stale** — origin `updatedAt` is newer than the vBRIEF (propose an update)
- **Externally closed** — origin issue is `CLOSED` (propose cancellation or reconcile if intentional divergence)
- **Unlinked** — vBRIEF has no GitHub reference (flag for review)

### Step 2: Walk Flagged Items with the User

1. ! For each **stale** item the task surfaces, show the user the diff between the current vBRIEF and the refreshed origin. Propose edits; ! wait for explicit user approval before writing anything.
2. ! For each **externally closed** item, ask the user whether to `task scope:cancel <file>` it or preserve intentional divergence.
3. ! For each **unlinked** item, ask whether to attach an origin reference or leave the vBRIEF as-is.

### Step 3: Apply User-Approved Updates

- ! Agent proposes edits; ! user approves each change
- ! Never auto-update vBRIEFs — intentional divergence (vBRIEF refined beyond original issue scope) must be preserved
- ! For approved updates, update the vBRIEF content and `vBRIEFInfo.updated` timestamp; prefer the task commands (`task scope:cancel`, `task scope:block`, etc.) over hand-editing where they apply

⊗ Replace the task invocation with a hand-written `gh issue view` loop — the task is the canonical implementation; skills MUST NOT duplicate it (#537)
⊗ Auto-update vBRIEFs based on origin changes without user approval
⊗ Overwrite intentional divergence -- if a vBRIEF has been refined beyond the original issue, preserve the refinement

## Phase 4 -- Promote/Demote

! Move vBRIEFs between lifecycle folders using deterministic task commands. The status values below align with the canonical v0.6 Status enum (`draft | proposed | approved | pending | running | completed | blocked | failed | cancelled`) — note that `failed` is also a valid terminal transition for active work that could not complete.

### Available Commands

- `task scope:promote <file>` -- proposed/ -> pending/ (status: pending)
- `task scope:activate <file>` -- pending/ -> active/ (status: running)
- `task scope:complete <file>` -- active/ -> completed/ (status: completed)
- `task scope:cancel <file>` -- any -> cancelled/ (status: cancelled)
- `task scope:restore <file>` -- cancelled/ -> proposed/ (status: proposed)
- `task scope:block <file>` -- stays in active/ (status: blocked)
- `task scope:unblock <file>` -- stays in active/ (status: running)
- `task scope:fail <file>` (v0.6+) -- active/ -> completed/ (status: failed) — record a failure terminal state when a scope cannot complete but should not be cancelled

### Workflow

1. ! Execute transitions using the task commands above -- they handle `plan.status` updates, `plan.updated` timestamps, and file moves atomically
2. ! Derived-artifact renders (`task roadmap:render`, `task project:render`) happen after a **batch** of promotions/demotions, not after each individual item. During high-volume triage (e.g. dozens of accept/reject decisions in one session), defer both renders until the end of the batch -- the source of truth is the lifecycle folder contents under `vbrief/`, so ROADMAP.md and PROJECT-DEFINITION.vbrief.json can be refreshed once per batch without losing correctness.
3. ! `task roadmap:render` regenerates ROADMAP.md from the updated lifecycle folder contents. Call it once per batch (typically at the end of Phase 4, before handing back to the user or transitioning to Phase 5), not after every single promote/demote.
4. ! `task project:render` refreshes the PROJECT-DEFINITION items registry. Call it **once per refinement pass** -- usually at the end of the session alongside the final roadmap render -- unless the user explicitly needs an intermediate registry refresh. It is not a per-edit tax.
5. ! Before the user is shown the final backlog state (end of Phase 4, end of Phase 5, or session exit), both `task roadmap:render` AND `task project:render` MUST have been run at least once so ROADMAP.md and PROJECT-DEFINITION.vbrief.json reflect the current lifecycle folder truth. This preserves correctness while allowing N promotions/demotions to share one render checkpoint.
6. ! Mark rejected items as `cancelled` via `task scope:cancel` (never delete vBRIEFs)

~ Operationally: a large refinement session can ingest/evaluate/promote multiple issues and close out with **one** final render checkpoint, rather than N repetitive renders after every individual item.

⊗ Rerender derived artifacts (`task roadmap:render`, `task project:render`) after every single accept/reject/promote/demote during high-volume triage -- batch the lifecycle edits and render once at the end of the batch
⊗ Move vBRIEFs between folders manually (cp/mv) -- always use `task scope:*` commands
⊗ Delete vBRIEFs -- use `task scope:cancel` to preserve history

## Phase 5 -- Prioritize

! Reorder and organize the pending backlog.

1. ! List all vBRIEFs in `vbrief/pending/` with titles, origins, and any phase/dependency metadata
2. ~ Help the user set phases and dependencies:
   - Group related items into phases (via vBRIEF `items` hierarchy or `tags`)
   - Identify dependencies between items (via `edges` in vBRIEF schema)
3. ! `task roadmap:render` is the **checkpoint** before showing the reordered backlog to the user -- not a per-edit tax. Run it ONCE at the end of the reorder pass to regenerate ROADMAP.md from the updated pending/ contents. Do not invoke it after each individual reorder action.
4. ~ Present the regenerated roadmap summary to the user for confirmation

## Phase 6 -- Completion Lifecycle

! On scope completion, update origins to close the loop.

### When a Scope Completes

1. ! Read the completed vBRIEF's `references` array
2. ! For each GitHub-issue reference (either the legacy bare `github-issue` type or the canonical `x-vbrief/github-issue` shape):
   - Close the issue with a comment linking to the implementing PR:
     ```
     gh issue close {N} --comment "Completed via PR #{PR} -- scope vBRIEF: {filename}"
     ```
   - The issue number is extracted from the reference `uri` (e.g. `https://github.com/o/r/issues/{N}`)
3. ? For other reference types (`x-vbrief/jira-ticket`, `x-vbrief/user-request`, `x-vbrief/github-pr`, etc.), follow the appropriate update mechanism
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
3. ! Verify `.github/PULL_REQUEST_TEMPLATE.md` checklist is satisfiable for this PR. If the file is **missing**, do NOT block — copy the canonical template from `templates/PULL_REQUEST_TEMPLATE.md` (ship-with-deft) to `.github/PULL_REQUEST_TEMPLATE.md` in the consumer project, then proceed with pre-flight (#531). If the file exists but contains unsatisfiable checklist items for this PR, call them out to the user before pushing.
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
   - If review cycle is still in progress: "Review cycle handed off to deft-review-cycle. Monitor PR #{N} for Greptile findings."
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
- ⊗ Rerender ROADMAP.md or PROJECT-DEFINITION.vbrief.json after every single accept/reject/promote/demote during high-volume triage -- `task roadmap:render` and `task project:render` are batch checkpoints, not per-edit taxes, and calling them N times for N lifecycle edits turns O(1) render work into O(N) without changing correctness (see #638)
- ⊗ Return a final backlog view to the user without having run `task roadmap:render` and `task project:render` at least once since the last lifecycle edit -- batch the renders, but do not skip them
