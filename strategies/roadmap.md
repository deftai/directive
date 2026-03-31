# Roadmap Maintenance Strategy

A pattern for maintaining a living, phased roadmap with agent-assisted triage.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Type:** preparatory (produces a maintained roadmap artifact, not a spec)

## When to Use

- ~ Your project uses a phased roadmap (e.g. `ROADMAP.md`) alongside an issue tracker
- ~ New issues have accumulated and need to be placed into the roadmap
- ? Periodic maintenance (weekly, after milestones, or after a batch of user feedback)

## Overview

This strategy helps you keep a phased roadmap in sync with your issue tracker.
The agent compares open issues against the roadmap, analyzes each new issue,
recommends a phase placement, and waits for your approval before making changes.

This is an **optional best practice** — adapt it to your project's needs.

## Workflow

### Step 1 — Discover

- ~ Read your roadmap file and note all tracked issue numbers
- ~ Fetch open issues from your issue tracker (GitHub Issues, Jira, etc.)
- ~ Identify new issues (not yet in roadmap) and stale entries (closed but still listed)

### Step 2 — Triage One-at-a-Time

For each new issue:

1. ~ Fetch full details (title, body, labels, comments)
2. ~ Analyze: category, scope, relationship to existing work, suggested phase
3. ~ Present the analysis and wait for human decision
4. ~ On approval: update the roadmap and comment on the issue with the analysis

### Step 3 — Clean Up

- ~ Remove or strike through closed issues still in the roadmap
- ~ Move completed work to a "Completed" section for historical reference
- ~ Verify the roadmap index matches the phase sections

## Roadmap Structure (Suggested)

A phased roadmap works well with this structure:

```markdown
# Project Roadmap

## Phase 1 — {Urgent / Bugs / Blockers}
## Phase 2 — {Content / Documentation}
## Phase 3 — {Infrastructure / CI}
## Phase 4 — {Distribution / Packaging}
## Phase 5 — {New Features / Long-term}

## Completed
{Struck-through items with dates/PRs}

## Open Issues Index
{Table mapping issue numbers to phases}
```

Adapt the phases to your project. The key principle: **resolve open issues before new features.**

## Analysis Template (Suggested)

When analyzing an issue, cover:

- **Summary** — what the issue is about
- **Category** — bug, enhancement, documentation, etc.
- **Relationship to existing issues** — overlaps, dependencies, bundling opportunities
- **Scope** — small / medium / large
- **Recommended phase** — where it fits and why

## Tips

- ~ One issue at a time with human review prevents misplacement
- ~ Commenting the analysis on the issue itself creates an audit trail
- ~ A dedicated branch for roadmap changes keeps the diff reviewable
- ~ Batch commits by issue or small group — don't commit the whole refresh as one giant diff
- ? File upstream issues when a problem lives in a dependency, not your project
