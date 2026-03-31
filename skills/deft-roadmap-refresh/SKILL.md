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
- ~ A dedicated branch for the refresh (e.g. `roadmap-refresh`)

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
- **Your take** — brief recommendation

### Step 3: Wait for User Decision

- ! Stop after each analysis. Do not proceed until the user confirms or overrides the placement.
- ~ The user may change the phase, reject the issue, or ask for more research.

### Step 4: Apply (on user approval)

- ! Post the analysis as a comment on the GitHub issue
- ! Add the issue to the correct phase section in ROADMAP.md
- ! Add the issue to the Open Issues Index table
- ! Update the changelog line at the bottom of ROADMAP.md
- ~ If the user approves commit+push: commit with a descriptive message and push

## Phase 3 — Cleanup

After all new issues are triaged:

- ! Strike through or move any stale entries (closed issues still in the index)
- ! Move closed issues to the Completed section if they aren't there already
- ~ Verify the Open Issues Index matches the phase sections

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

## Anti-Patterns

- ⊗ Triage multiple issues without stopping for user review
- ⊗ Make changes to ROADMAP.md before the user approves placement
- ⊗ Skip the analysis comment on the GitHub issue
- ⊗ Forget to update the Open Issues Index when adding to a phase
- ⊗ Leave closed issues in the index without striking through
