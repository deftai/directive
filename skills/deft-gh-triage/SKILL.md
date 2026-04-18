---
name: deft-gh-triage
description: >
  Triage a bug or issue by exploring the codebase to find the root cause, then
  create a GitHub Issue with a TDD-based fix plan. Use when a user reports a
  bug, wants to investigate a problem, or mentions "triage". Requires the
  GitHub CLI (gh).
metadata:
  clawdbot:
    requires:
      bins: ["gh"]
---

# Deft GH Triage

Investigate a reported problem, identify the root cause, and file a GitHub Issue with a concrete TDD fix plan.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

> Inspired by [triage-issue](https://github.com/mattpocock/skills/tree/main/triage-issue) from [mattpocock/skills](https://github.com/mattpocock/skills). Adapted to deft's TDD standards, RFC2119 notation, and GitHub CLI conventions.

## When to Use

- User reports a bug or unexpected behavior
- User says "triage this", "investigate", or "file an issue for this bug"
- A GitHub issue exists but lacks root cause analysis or a fix plan
- You want to produce a ticket before handing off a fix to another agent

## Prerequisites

- ! Verify `gh` is authenticated: `gh auth status` — stop and report if not

---

## Process

This is a mostly hands-off workflow — minimize questions to the user. Investigate first, ask only when stuck.

### Step 1: Capture the problem

- ~ If the user has described the problem, use that description directly
- ~ If no description exists, ask ONE question: "What's the problem you're seeing?"
- ⊗ Ask follow-up questions before starting investigation

### Step 2: Explore and diagnose

Deeply investigate the codebase. Your goal is to find:

- **Where** the bug manifests — entry points, API responses, UI behaviour, CLI output
- **What** code path is involved — trace the flow from trigger to failure
- **Why** it fails — the root cause, not just the symptom
- **What** related code exists — similar patterns, existing tests, adjacent modules

Look at:
- ! Related source files and their dependencies
- ! Existing tests — what's covered, what's missing
- ~ Recent changes to affected files: `git --no-pager log --oneline -20 -- <file>`
- ~ Error handling in the code path
- ~ Similar patterns elsewhere in the codebase that work correctly

### Step 3: Identify the fix approach

Based on your investigation, determine:

- ! The minimal change needed to fix the root cause
- ! Which modules or interfaces are affected
- ! What behaviours need to be verified via tests
- ~ Whether this is a regression, missing feature, or design flaw

### Step 4: Design the TDD fix plan

Create a concrete, ordered list of RED-GREEN cycles. Each cycle is one vertical slice:

- **RED**: A specific failing test that captures the broken or missing behaviour
- **GREEN**: The minimal code change to make that test pass

**Rules:**
- ! Tests verify behaviour through public interfaces, not implementation details
- ! One test at a time — vertical slices, NOT all tests first then all code
- ! Tests must survive internal refactors (assert on observable outcomes, not internal state)
- ~ Include a final REFACTOR step if cleanup is needed after all tests pass
- ⊗ Suggest fixes that couple to current file layout or internal structure — describe behaviours and contracts instead

### Step 5: Create the GitHub Issue

- ! Create the issue immediately using `gh issue create` — do NOT ask the user to review first
- ! Use the template below
- ! After creating, print the issue URL and a one-line summary of the root cause

**Issue template:**

```
## Problem

What happens (actual behavior):

What should happen (expected behavior):

How to reproduce (if applicable):

## Root Cause Analysis

Describe what you found during investigation:
- The code path involved
- Why the current code fails
- Any contributing factors

Do NOT include specific file paths, line numbers, or implementation details
that couple to the current code layout. Describe modules, behaviours, and
contracts. The issue should remain useful after major refactors.

## TDD Fix Plan

1. **RED**: Write a test that [describes expected behavior]
   **GREEN**: [Minimal change to make it pass]

2. **RED**: Write a test that [describes next behavior]
   **GREEN**: [Minimal change to make it pass]

**REFACTOR**: [Any cleanup needed after all tests pass — omit if not needed]

## Acceptance Criteria

- [ ] Root cause is addressed, not just the symptom
- [ ] All RED tests are now GREEN
- [ ] Existing tests still pass
- [ ] task check passes
```

---

## Anti-Patterns

- ⊗ Asking the user for information the codebase can answer
- ⊗ Describing the fix in terms of specific files or line numbers (couples to current layout)
- ⊗ Writing all tests first then all code — each RED-GREEN is one vertical slice
- ⊗ Asking the user to review the issue before filing it — file immediately
- ⊗ Fixing the symptom without identifying the root cause
- ⊗ Proceeding without `gh` authentication
