---
name: deft-gh-arch
description: >
  Explore a codebase for architectural improvement opportunities, focusing on
  deepening shallow modules and improving testability. Uses parallel sub-agents
  to generate competing interface designs, then files a refactor RFC as a GitHub
  Issue. Use when improving architecture, finding refactoring opportunities, or
  making a codebase more testable and AI-navigable. Requires the GitHub CLI (gh).
triggers:
  - improve architecture
  - shallow modules
  - deepen module
  - architectural debt
  - make more testable
metadata:
  clawdbot:
    requires:
      bins: ["gh"]
---

# Deft GH Arch

Explore a codebase for architectural friction, surface opportunities to deepen shallow modules, generate competing interface designs in parallel, and file a refactor RFC as a GitHub Issue.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

> Inspired by [improve-codebase-architecture](https://github.com/mattpocock/skills/tree/main/improve-codebase-architecture) from [mattpocock/skills](https://github.com/mattpocock/skills). Adapted to deft's domain model conventions and GitHub CLI workflow.

## When to Use

- Codebase has grown and modules feel tightly coupled or hard to test
- New feature work keeps touching the same files unexpectedly
- User says "improve the architecture" or "this is hard to test"
- Pre-implementation cleanup before a major new feature

## Prerequisites

- ! Verify `gh` is authenticated: `gh auth status` — stop and report if not

---

## Core Concept: Deep Modules

A **deep module** (John Ousterhout, *A Philosophy of Software Design*) has a small interface hiding a large implementation. Deep modules are more testable, more AI-navigable, and let you test at the boundary instead of inside.

Shallow modules are the inverse: their interface is nearly as complex as the implementation. They force callers to know too much.

---

## Process

### Step 1: Explore the codebase

Navigate the codebase naturally. Note where you experience friction — **the friction IS the signal**:

- ~ Where does understanding one concept require bouncing between many small files?
- ~ Where are modules so shallow that the interface is nearly as complex as the implementation?
- ~ Where have pure functions been extracted just for testability, but real bugs hide in how they're called?
- ~ Where do tightly-coupled modules create risk at integration seams?
- ~ Which parts are untested, or hard to test?

- ! If `core/glossary.md` or `UBIQUITOUS_LANGUAGE.md` exists, read it — domain term precision matters when naming interfaces
- ⊗ Follow rigid heuristics — explore organically

### Step 2: Present candidates

Present a numbered list of deepening opportunities. For each:

- **Cluster** — which modules/concepts are involved
- **Why they're coupled** — shared types, call patterns, co-ownership of a concept
- **Test impact** — what existing tests would be replaced by clean boundary tests

⊗ Propose interfaces yet — just the candidates.

! Ask: "Which of these would you like to explore?"

### Step 3: Frame the problem space

Before spawning sub-agents, write a brief user-facing explanation:
- The constraints any new interface must satisfy
- The dependencies it must manage
- A rough illustrative sketch to make constraints concrete (not a proposal)

Show this to the user, then immediately proceed to Step 4. The user reads while sub-agents work.

### Step 4: Design multiple interfaces in parallel

Spawn 3+ sub-agents with **radically different** design constraints. Each produces:

1. Interface signature (types, methods, params)
2. Usage example showing how callers use it
3. What complexity it hides internally
4. How dependencies are handled
5. Trade-offs

**Agent constraints:**
- Agent 1: "Minimize the interface — aim for 1–3 entry points max"
- Agent 2: "Maximize flexibility — support many use cases and extension points"
- Agent 3: "Optimize for the most common caller — make the default case trivial"
- Agent 4 (if applicable): "Design around ports & adapters for cross-boundary dependencies"

Present designs sequentially, then compare in prose. Give your own recommendation — which is strongest and why. If elements combine well, propose a hybrid. Be opinionated.

### Step 5: User picks an interface

! Wait for explicit user selection (or acceptance of your recommendation) before filing.

### Step 6: File the GitHub Issue

- ! Create a refactor RFC immediately using `gh issue create` with the template below
- ! After creating, print the issue URL

**Issue template:**

```
## Problem

Describe the coupling or shallowness found. What makes this hard to test or extend?
Describe modules and behaviors — NOT specific file paths or line numbers.

## Proposed Interface

The chosen interface design (from the parallel session).

Include:
- Interface signature (types / methods / params)
- Usage example
- What complexity it hides

## Dependency Strategy

How the new interface handles its dependencies (injection, ports & adapters, etc.)

## Test Impact

What existing tests this replaces, and what new boundary tests become possible.

## Trade-offs

What this design gains and gives up vs the current implementation.

## Acceptance Criteria

- [ ] Interface is implemented and passes all boundary tests
- [ ] Existing callers are migrated
- [ ] Old internal tests replaced by boundary tests
- [ ] task check passes
```

---

## Anti-Patterns

- ⊗ Proposing an interface before presenting candidates to the user
- ⊗ Designing only one interface — parallel designs are required to surface real trade-offs
- ⊗ Filing the issue before the user approves the chosen design
- ⊗ Including specific file paths or line numbers in the issue body (couples to current layout)
- ⊗ Proceeding without `gh` authentication
