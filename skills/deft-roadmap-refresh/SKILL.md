---
name: deft-roadmap-refresh
description: >
  Structured roadmap refresh workflow. Compares open GitHub issues against
  ROADMAP.md, triages new issues one-at-a-time with human review, and updates
  the roadmap with phase placement, analysis comments, and index entries.
---

# Deft Roadmap Refresh

Structured triage of open issues into the phased roadmap.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- User says "roadmap refresh", "triage issues", or "update the roadmap"
- New issues have accumulated since the last roadmap update
- Periodic maintenance pass (e.g. weekly or after a batch of user feedback)

## Prerequisites

- ! ROADMAP.md exists in the project root
- ! GitHub CLI (`gh`) is authenticated and can access the repo

## Phase 0 — Branch Setup

! Before making any changes, ensure you are working on the correct branch.

1. ! Check if a `roadmap-refresh` branch already exists (`git branch --list roadmap-refresh`)
2. ! Check the current working tree state:
   - If the working tree has uncommitted changes to ROADMAP.md or other files that would conflict, stop and ask the user to resolve them first
   - If you are already on `roadmap-refresh` and it is up to date with the base branch, proceed
3. ! Decide branch vs. worktree:
   - **Branch is sufficient** when: you are in the main working tree, no other long-running work is in progress on the current branch, and the user is not actively developing on another branch
   - **Worktree is needed** when: the user is actively working on another branch they don't want to leave, or parallel work would conflict with a branch switch
   - ? Ask the user if unsure which approach to take
4. ! Set up the workspace:
   - **Branch path:** `git checkout roadmap-refresh` (or `git checkout -b roadmap-refresh` if new), then rebase/merge from the base branch if needed
   - **Worktree path:** `git worktree add ../deft-roadmap-refresh roadmap-refresh` (or create the branch first if it doesn't exist), then work from that directory
5. ! Confirm the branch and working directory to the user before proceeding to Discovery

## Phase 1 — Discovery

! Gather both sources before analyzing anything:

1. ! Read `ROADMAP.md` — note all issue numbers currently tracked (body + Open Issues Index)
2. ! Fetch all open GitHub issues: `gh issue list --repo {owner/repo} --state open --limit 200 --json number,title,labels,createdAt`
3. ! Diff the two lists to identify:
   - **New issues** — open on GitHub but not in the roadmap (these are the triage targets)
   - **Stale entries** — in the roadmap but closed on GitHub (cleanup targets)
4. ! Present the summary to the user before proceeding

## Phase 2 — One-at-a-Time Triage

! Process each new issue individually. For each issue:

### Step 1: Fetch Details

- ! `gh issue view {number} --repo {owner/repo} --json number,title,body,labels,comments,createdAt`

### Step 2: Analyze

Present analysis to the user covering:

- **Summary** — what the issue is about (1-2 sentences)
- **Category** — bug, enhancement, documentation, platform limitation, etc.
- **Relationship to existing issues** — overlaps, dependencies, can-be-bundled-with
- **Scope** — small/medium/large, what's involved
- **Suggested phase** — which roadmap phase and why
- **Spec coverage** — whether a SPECIFICATION.md task already exists for this issue (cite task ID if yes, note "no spec task -- will create skeleton on approval" if no)
- **Your take** — brief recommendation

### Step 3: Wait for User Decision

- ! Stop after each analysis. Do not proceed until the user confirms or overrides the placement.
- ~ The user may change the phase, reject the issue, or ask for more research.

### Step 4: Apply (on user approval)

- ! Post the analysis as a comment on the GitHub issue
- ! After posting the analysis comment, confirm to the user that the comment was posted -- include the issue number and a direct link to the comment.
- ! Add the issue to the correct phase section in ROADMAP.md
- ! Add the issue to the Open Issues Index table using the exact row format:
  ```
  | #NNN | title | Phase |
  ```
  Every column MUST have a value -- do NOT leave a column empty between pipes.
- ! **Spec task scaffolding**: If no spec task exists in SPECIFICATION.md for this issue, create a skeleton entry:
  ```
  ## tX.Y.Z: <short title> (#NNN)  `[pending]`

  <one-line description of what the task covers>

  - <first acceptance criterion placeholder>

  **Traces**: #NNN
  ```
  Use the next available task ID in the current phase sequence. The skeleton is a placeholder -- full acceptance criteria are written at implementation time.
- ! Update the changelog line at the bottom of ROADMAP.md
- ~ If the user approves commit+push: commit with a descriptive message and push

## Phase 3 — Cleanup

After all new issues are triaged:

- ! Remove the entry from the phase section body entirely -- do NOT leave a struck-through line in place. The Completed section is the sole record for closed issues.
- ! In the Open Issues Index: strike through the row (keep for history), update Phase column to 'completed -- YYYY-MM-DD'.
- ! Move closed issues to the Completed section if they aren't there already
- ~ Verify the Open Issues Index matches the phase sections

~ When cleanup is complete, proceed to Phase 4 -- PR & Review Cycle.

## Analysis Comment Template

When posting to a GitHub issue, use this structure:

```markdown
## Roadmap Refresh Analysis ({date})

**Category:** {category}

**Summary:** {1-2 sentence summary}

**Relationship to existing issues:**
- **#{n}** ({phase}) — {how it relates}

**Scope:** {small/medium/large} — {what's involved}

**Recommendation:** {phase and reasoning}
```

## Commit Strategy

- ~ One commit per issue or small batch (2-3 related issues)
- ! Descriptive commit messages: `docs(roadmap): add #{n} to Phase {x}`
- ! Include bullet-point body summarizing what changed
- ⊗ Auto-push without explicit user instruction

## CHANGELOG Convention

- ! Write ONE batch `CHANGELOG.md` entry at the END of the full triage session -- not one entry per issue triaged. The batch entry summarizes all issues triaged, filed, and cleaned up during the session.
- ⊗ Add a CHANGELOG entry after each individual issue is triaged -- wait until the full session is complete and write a single summary entry.

## Anti-Patterns

- ⊗ Triage multiple issues without stopping for user review
- ⊗ Make changes to ROADMAP.md before the user approves placement
- ⊗ Skip the analysis comment on the GitHub issue
- ⊗ Forget to update the Open Issues Index when adding to a phase
- ⊗ Leave closed issues in the index without striking through
- ⊗ Strike through an entry in the phase body AND add it to Completed -- this creates a duplicate record and breaks the single-record convention
- ⊗ Add a CHANGELOG entry per individual issue during triage -- write one batch entry at the end of the full session
- ⊗ Create Open Issues Index rows without using the `| #NNN | title | Phase |` template format -- freeform or inconsistent rows break downstream tooling and cleanup scripts
- ⊗ Leave empty columns between pipes (e.g. `|| title | Phase |` or `| #NNN || Phase |`) -- every column must have a value; a double-pipe `||` entry means a column was omitted

## Phase 4 — PR & Review Cycle

After all triage and cleanup is complete:

1. ! Ask the user: "Ready to commit and create a PR?"
2. ! Wait for explicit user confirmation before proceeding.

### Pre-Flight (before pushing)

! Run all pre-flight checks BEFORE committing and pushing:

1. ! Verify `CHANGELOG.md` has an `[Unreleased]` entry covering the roadmap refresh changes
2. ! Run `task check` -- all checks must pass
3. ! Verify `.github/PULL_REQUEST_TEMPLATE.md` checklist is satisfiable for this PR
4. ! **Mandatory file review**: Re-read ALL modified files before committing. Explicitly check for:
   - Encoding errors (em-dashes corrupted to replacement characters, BOM artifacts)
   - Unintended duplication (accidental double entries in ROADMAP.md, CHANGELOG.md, or index tables)
   - Structural issues (malformed CHANGELOG entries, broken ROADMAP rows, mismatched index entries)
   - Semantic accuracy (verify that counts, claims, and summaries in CHANGELOG entries and ROADMAP changelog lines match the actual data in the commit -- e.g. "triaged 4 issues" must match the number of issues actually triaged, issue numbers cited must match the issues actually added)

### Commit, Push, and Create PR

1. ! Commit with a descriptive message: `docs(roadmap): refresh -- add #{n}, #{n}, ... to Phase {x}`
2. ! Push the branch to origin
3. ! Create a PR targeting `master` with a summary of triaged issues and cleanup performed

### Review Cycle Handoff

! After the PR is created, automatically sequence into `skills/deft-review-cycle/SKILL.md`.

- ! Inform the user: "PR #{N} created -- starting review cycle."
- ! Follow the full review cycle skill from Phase 1 (Deft Process Audit) onward.

### EXIT

! When the review cycle completes (exit condition met) or the PR is ready for human review:

1. ! Explicitly confirm skill exit: "deft-roadmap-refresh complete -- exiting skill."
2. ! Provide chaining instructions to the user/agent:
   - If review cycle is complete and PR is approved: "PR #{N} is ready for human merge review."
   - If review cycle is still in progress: "Review cycle handed off to deft-review-cycle. Monitor PR #{N} for Greptile findings."
   - If returning to a monitor agent: "Returning control to monitor agent -- roadmap refresh PR #{N} created and review cycle initiated."
3. ! Do NOT continue into adjacent work after this point -- the skill boundary is an exit condition.
