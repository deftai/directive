---
name: deft-gh-refactor
description: >
  Plan a safe, incremental refactor through user interview and codebase
  exploration, then file the plan as a GitHub Issue with tiny commits,
  decision document, and testing decisions. Use when planning a refactor,
  creating a refactoring RFC, or breaking a refactor into safe incremental
  steps. Requires the GitHub CLI (gh).
triggers:
  - plan a refactor
  - refactoring RFC
  - refactor plan
  - incremental refactor
  - safe refactor
metadata:
  clawdbot:
    requires:
      bins: ["gh"]
---

# Deft GH Refactor

Plan a safe, incremental refactor through structured interview and codebase exploration, then file it as a GitHub Issue with a tiny-commit plan.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

> Inspired by [request-refactor-plan](https://github.com/mattpocock/skills/tree/main/request-refactor-plan) from [mattpocock/skills](https://github.com/mattpocock/skills). Adapted to deft's TDD standards and GitHub CLI workflow.

## When to Use

- User wants to plan a significant code change before implementing it
- A refactor needs to be safe, incremental, and reviewable
- Unclear scope — need to nail down what changes and what doesn't
- Test coverage in the target area needs assessment before work begins

## Prerequisites

- ! Verify `gh` is authenticated: `gh auth status` — stop and report if not

---

## Process

### Step 1: Capture the problem

- ! Ask the user: describe the problem in detail — what's wrong with the current code and any initial solution ideas
- ~ Ask: "What does success look like after this refactor?"
- ⊗ Start exploring the codebase before hearing the user's framing

### Step 2: Explore the codebase

- ! Explore the relevant parts of the codebase to verify the user's assertions
- ~ Check: is the problem actually where they think it is?
- ~ Check: what does the current code actually do vs what the user described?
- ~ Note adjacent code, existing tests, and patterns used elsewhere

### Step 3: Present alternatives

- ! Ask: "Have you considered these other approaches?" — present 2–3 alternatives to the user's proposed solution with honest trade-offs
- ~ Frame alternatives around deft quality standards: testability, coverage, coupling
- ! Let the user confirm the chosen approach before proceeding

### Step 4: Interview on implementation

Be extremely detailed and thorough:

- ! Scope — what modules/interfaces will change, what will NOT change
- ! API surface — will any public interfaces change? If so, how?
- ! Dependencies — what will the new code depend on? How are dependencies injected?
- ! Data — any schema or data format changes?
- ! Edge cases — what happens at the boundaries?
- ! Rollback — is this reversible? Is a migration needed?
- ~ Naming — if new terms are introduced, do they match `core/glossary.md`?

### Step 5: Lock the scope

- ! Produce an explicit list of what IS in scope
- ! Produce an explicit list of what is NOT in scope
- ! Get user confirmation before proceeding
- ⊗ Proceed with an open-ended scope

### Step 6: Assess test coverage

- ! Check existing test coverage for the affected area
- ~ If coverage is insufficient: ask the user what the testing plan is — ⊗ assume it will be handled later
- ~ Tie test decisions to deft's TDD standard: tests verify behavior through public interfaces, not internal details

### Step 7: Plan tiny commits

Break the implementation into the smallest safe commits possible. Each commit must:

- ! Leave the codebase in a working, passing state
- ! Be independently reviewable
- ~ Be describable in one Conventional Commit subject line

> "Make each refactoring step as small as possible, so that you can always see the program working." — Martin Fowler

### Step 8: File the GitHub Issue

- ! Create the issue using `gh issue create` with the template below
- ! After creating, print the issue URL

**Issue template:**

```
## Problem Statement

The problem from the developer's perspective — what's wrong and why it matters.

## Solution

The chosen approach. Why this over the alternatives considered.

## Commits

A detailed, ordered implementation plan. Each commit leaves the codebase in a
working state. Write in plain English — no file paths or code snippets (they
go stale quickly).

1. commit: [description — what changes and why it's safe]
2. commit: [description]
...

## Decision Document

Implementation decisions locked during the interview:

- Modules to build/modify
- Interface changes
- Technical clarifications
- Architectural decisions
- Schema / data format changes
- API contracts

Do NOT include specific file paths or line numbers.

## Testing Decisions

- What makes a good test for this change (behavior through public interfaces, not internals)
- Which modules will have new tests
- Prior art in the codebase (similar test patterns to follow)

## Out of Scope

Explicitly: what this refactor does NOT change.

## Acceptance Criteria

- [ ] All commits individually pass task check
- [ ] Coverage maintained or improved (≥ PROJECT.md threshold)
- [ ] No existing tests broken
- [ ] Out-of-scope items were not touched
```

---

## Anti-Patterns

- ⊗ Starting the codebase exploration before hearing the user's problem framing
- ⊗ Skipping the alternatives step — always present options
- ⊗ Proceeding with open-ended scope — scope must be locked before planning commits
- ⊗ Proposing a single large commit — each commit must leave the codebase working
- ⊗ Including file paths or line numbers in the issue (couples to current layout)
- ⊗ Skipping test coverage assessment — coverage gaps must be acknowledged before work begins
- ⊗ Proceeding without `gh` authentication
