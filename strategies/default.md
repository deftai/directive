# DEFaulT Strategy

The standard Deft workflow: structured interview → PRD → SPECIFICATION.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- ! Default strategy for all new projects
- ~ Projects with unclear or evolving requirements
- ~ When stakeholder alignment is needed before implementation
- ? Skip to Phase 2 if PRD already exists

## Workflow Overview

```mermaid
flowchart LR
    subgraph default ["DEFaulT Strategy"]
        I["💬 Interview<br/><i>Gather requirements</i>"]
        P["📄 PRD<br/><i>What to build</i>"]
        S["📋 SPECIFICATION<br/><i>How to build it</i>"]
    end

    I -->|"Ambiguity resolved"| P
    P -->|"Approved"| S
    S -->|"Ready"| IMPL["🔨 Implementation"]

    style I fill:#c4b5fd,stroke:#7c3aed,color:#000
    style P fill:#fef08a,stroke:#ca8a04,color:#000
    style S fill:#6ee7b7,stroke:#059669,color:#000
    style IMPL fill:#7dd3fc,stroke:#0284c7,color:#000
```

---

## Phase 1: Interview

**Goal:** Eliminate ambiguity through structured questioning.

**Input:** User's initial idea (can be vague)

**Output:** Comprehensive answers to all key decisions; key decisions tracked in `./vbrief/plan.vbrief.json`

### Process

- ~ Use Claude AskInterviewQuestion when available (emulate if not)
- ! Ask **ONE** focused, non-trivial question per step
- ⊗ Ask multiple questions at once or sneak in "also" questions
- ~ Provide numbered answer options when appropriate
- ! Include "other" option for custom/unknown responses
- ! Indicate which option is RECOMMENDED

### Question Areas

- ! Missing decisions (language, framework, deployment)
- ! Edge cases (errors, boundaries, failure modes)
- ! Implementation details (architecture, patterns, libraries)
- ! Requirements (performance, security, scalability)
- ! UX/constraints (users, timeline, compatibility)
- ! Tradeoffs (simplicity vs features, speed vs safety)

### Transition Criteria

- ! All major decisions have answers
- ! Edge cases are addressed
- ! User has approved key tradeoffs
- ~ Little ambiguity remains

---

## Phase 2: PRD Generation

**Goal:** Document WHAT to build (not how).

**Input:** Interview answers

**Output:** `PRD.md` — Product Requirements Document

### PRD Structure

```markdown
# [Project Name] PRD

## Problem Statement
What problem does this solve? Who has this problem?

## Goals
- Primary goal
- Secondary goals
- Non-goals (explicitly out of scope)

## User Stories
As a [user type], I want [capability] so that [benefit].

## Requirements

### Functional Requirements
- FR-1: [requirement]
- FR-2: [requirement]

### Non-Functional Requirements
- NFR-1: Performance — [requirement]
- NFR-2: Security — [requirement]

## Success Metrics
How do we know this succeeded?

## Open Questions
Any remaining decisions deferred to implementation.
```

### Guidelines

- ! Focus on WHAT, not HOW
- ! Use RFC 2119 language (MUST, SHOULD, MAY)
- ! Number all requirements for traceability
- ~ Include acceptance criteria for each requirement
- ⊗ Include implementation details or architecture

### Transition Criteria

- ! All functional requirements documented
- ! Non-functional requirements specified
- ! User has reviewed and approved PRD
- ~ No blocking open questions remain

---

## Phase 3: SPECIFICATION Generation

**Goal:** Document HOW to build it with parallel-ready tasks.

**Input:** Approved `PRD.md`

**Output:** `./vbrief/specification.vbrief.json` (status: draft → approved) → `task spec:render` → `SPECIFICATION.md`

### SPECIFICATION Structure

```markdown
# [Project Name] SPECIFICATION

## Overview
Brief summary and link to PRD.

## Architecture
High-level system design, components, data flow.

## Implementation Plan

### Phase 1: Foundation
#### Subphase 1.1: Setup
- Task 1.1.1: [description]
  - Dependencies: none
  - Acceptance: [criteria]

#### Subphase 1.2: Core (depends on: 1.1)
- Task 1.2.1: [description]

### Phase 2: Features (depends on: Phase 1)
...

## Testing Strategy
How to verify the implementation meets requirements.

## Deployment
How to ship it.
```

### Guidelines

- ! Reference PRD requirements (FR-1, NFR-2, etc.)
- ! Break into phases, subphases, tasks
- ! Mark ALL dependencies explicitly
- ! Design for parallel work (multiple agents)
- ! End each phase/subphase with tests that pass
- ~ Size tasks for 1-4 hours of work
- ~ Minimize inter-task dependencies
- ⊗ Write code (specification only)

### Task Format

Each task should include:
- ! Clear description
- ! Dependencies (or "none")
- ! Acceptance criteria
- ~ Estimated effort
- ? Assigned agent (for swarm mode)

### Transition Criteria

- ! All PRD requirements mapped to tasks
- ! Dependencies form a valid DAG (no cycles)
- ! `./vbrief/specification.vbrief.json` status is `approved`
- ! `SPECIFICATION.md` has been rendered via `task spec:render`
- ! Ready for "implement SPECIFICATION.md"

---

## Artifacts Summary

| Artifact | Purpose | Created By |
|----------|---------|------------|
| `./vbrief/plan.vbrief.json` | Decision log + tracking | Phase 1 |
| `PRD.md` | What to build | Phase 2 |
| `./vbrief/specification.vbrief.json` | Spec source of truth | Phase 3 |
| `SPECIFICATION.md` | Generated implementation plan | Phase 3 (rendered) |

## Invoking This Strategy

```
I want to build [project] with features:
1. [feature]
2. [feature]
```

Or explicitly:

```
Use the default strategy to plan [project].
```

After completion:

```
implement SPECIFICATION.md
```
