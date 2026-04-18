---
name: deft-gh-slice
description: >
  Break a SPECIFICATION.md, PRD, or plan into independently-grabbable GitHub
  Issues using tracer-bullet vertical slices. Use after spec generation, when
  the user wants to create implementation tickets, or when breaking work into
  parallel-assignable issues. Requires the GitHub CLI (gh).
metadata:
  clawdbot:
    requires:
      bins: ["gh"]
---

# Deft GH Slice

Convert a specification or plan into independently-grabbable GitHub Issues using tracer-bullet vertical slices.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

> Inspired by [to-issues](https://github.com/mattpocock/skills/tree/main/to-issues) from [mattpocock/skills](https://github.com/mattpocock/skills). Adapted to deft's spec-driven workflow and GitHub CLI conventions.

## When to Use

- After `deft-setup` completes and `SPECIFICATION.md` is approved
- User says "create issues", "slice this into tickets", or "break this into GitHub issues"
- When a spec needs to be handed off to multiple agents or collaborators working in parallel

## Prerequisites

- ! Verify `gh` is authenticated: `gh auth status` — stop and report if not
- ~ Confirm the current git remote maps to the intended GitHub repository

---

## Process

### Step 1: Gather context

- ! Work from whatever is already in the conversation context
- ~ If a `SPECIFICATION.md` exists at the project root, read it
- ~ If the user passes a GitHub issue number or URL, fetch it: `gh issue view <number> --comments`
- ⊗ Ask the user to re-explain content that is already available in context

### Step 2: Explore the codebase (if needed)

- ? If you have not already explored the codebase, do so to understand what is already built vs what remains
- ~ Use existing code as a signal for which slices may already be partially complete

### Step 3: Draft vertical slices

Break the plan into **tracer bullet** issues — thin vertical slices that cut through ALL integration layers end-to-end, not horizontal slices of one layer.

Each slice is either:
- **AFK** — can be implemented and merged without human interaction (preferred)
- **HITL** (Human In The Loop) — requires a decision, design review, or approval before proceeding

**Vertical slice rules:**
- ! Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- ! A completed slice is independently demoable or verifiable
- ~ Prefer many thin slices over few thick ones
- ~ Prefer AFK over HITL wherever possible
- ⊗ Create horizontal slices (e.g. "implement all data models", "write all tests")

### Step 4: Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: AFK / HITL
- **Blocked by**: which other slices must complete first (or "none")
- **Tasks covered**: which SPECIFICATION.md tasks or phases this addresses

Then ask:

1. Does the granularity feel right? (too coarse / too fine)
2. Are the dependency relationships correct?
3. Should any slices be merged or split?
4. Are HITL/AFK labels correct?

Iterate until the user approves the breakdown.

! Wait for explicit approval before proceeding to issue creation.

### Step 5: Create the GitHub issues

- ! Create issues in dependency order (blockers first) so you can reference real issue numbers
- ! Use `gh issue create` for each approved slice with the template below
- ! Trace each issue back to the relevant SPECIFICATION.md phase/task IDs where applicable
- ⊗ Modify or close any existing parent issue

**Issue template:**

```
## Parent

#<parent-issue-number>
(omit this section if the source was not a GitHub issue)

## What to build

A concise description of this vertical slice. Describe the end-to-end
behavior, not layer-by-layer implementation. Reference the relevant
SPECIFICATION.md phase/task IDs (e.g. "Implements Phase 2 / Task 2.1.3").

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] All new tests pass
- [ ] task check passes

## Type

AFK / HITL

## Blocked by

- Blocked by #<issue-number>
(or "None — can start immediately")
```

After all issues are created, print a summary table: issue number, title, type, and blockers.

---

## Anti-Patterns

- ⊗ Creating horizontal slices (all models, all tests, all routes in one ticket)
- ⊗ Creating issues before the user approves the breakdown
- ⊗ Proceeding without `gh` authentication
- ⊗ Omitting dependency ordering — blockers must be created first
- ⊗ Describing implementation internals instead of observable behavior in issue bodies
