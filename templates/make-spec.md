# Specification Generation

Agent workflow for creating project specifications via structured interview.
This template implements [strategies/interview.md](../strategies/interview.md).
See that file for the full canonical strategy including the sizing gate,
Light/Full paths, and transition criteria.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Input Template

```
I want to build [project name] that has the following features:
1. [feature]
2. [feature]
...
N. [feature]
```

## Sizing Gate

! Before starting the interview, determine project complexity per
[strategies/interview.md](../strategies/interview.md#sizing-gate).

- ! Check `PROJECT.md` for `**Process**: Light` or `**Process**: Full` — if declared, use that path
- ! If not declared, propose a size and **wait for the user to confirm** before proceeding
- ⊗ Combine the sizing proposal with the first interview question

**Light** (small/medium): Interview → SPECIFICATION with embedded Requirements.
**Full** (large/complex): Interview → PRD (approval gate) → SPECIFICATION with traceability.

## Interview Process

- ~ Use Claude AskInterviewQuestion when available (emulate it if not available)
- ! If Input Template fields are empty: ask overview, then features, then details
- ! Ask **ONE** focused, non-trivial question per step
- ⊗ Ask more than one question per step; or try to sneak-in "also" questions
- ~ Provide numbered answer options when appropriate
- ! Include "other" option for custom/unknown responses
- ! Make it clear which option you feel is RECOMMENDED
- ! When you are done, append to the end of this file all questions asked and answers given

**Question Areas:**

- ! Missing decisions (language, framework, deployment)
- ! Edge cases (errors, boundaries, failure modes)
- ! Implementation details (architecture, patterns, libraries)
- ! Requirements (performance, security, scalability)
- ! UX/constraints (users, timeline, compatibility)
- ! Tradeoffs (simplicity vs features, speed vs safety)

**Completion:**

- ! Continue until little ambiguity remains
- ! Ensure spec is comprehensive enough to implement

## Output Generation

### Full Path: PRD Generation

Only on the **Full** path — generate `PRD.md` before the specification:

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

- ! Focus on WHAT, not HOW
- ! Use RFC 2119 language (MUST, SHOULD, MAY)
- ! Number all requirements for traceability
- ! User MUST review and approve PRD before specification generation begins

### Specification Flow (both paths)

1. ! Write `./vbrief/specification.vbrief.json` with `status: draft`
2. ! Summarize what was decided and ask the user to review
3. ! On user approval, update `status` to `approved` in the vbrief file
4. ! Run `task spec:render` (or generate `SPECIFICATION.md` directly if task unavailable)
5. ? For add-on specs: write `./vbrief/specification-{name}.vbrief.json` → `SPECIFICATION-{name}.md`

! The vBRIEF file MUST use this exact top-level structure:

- ! All `narratives` and `narrative` values MUST be plain strings — never objects or arrays
- ! Nested children within a PlanItem MUST use `subItems` (not `items`)
- ⊗ Use `items` inside a PlanItem — only `plan.items` is valid; within items use `subItems`

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "Project Name SPECIFICATION",
    "status": "draft",
    "narratives": {
      "Overview": "Brief project summary as a plain string.",
      "Architecture": "System design as a plain string."
    },
    "items": [
      {
        "id": "phase-1",
        "title": "Phase 1: Foundation",
        "status": "pending",
        "subItems": [
          {
            "id": "1.1",
            "title": "Subphase 1.1: Setup",
            "status": "pending",
            "subItems": [
              {
                "id": "1.1.1",
                "title": "Task description",
                "status": "pending",
                "narrative": { "Acceptance": "...", "Traces": "FR-1" }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

~ See [vbrief/vbrief.md](../vbrief/vbrief.md) for full schema documentation and [vbrief/schemas/vbrief-core.schema.json](../vbrief/schemas/vbrief-core.schema.json) for the JSON Schema.

- ⊗ Write `SPECIFICATION.md` directly — it is generated from the vbrief source
- ! Follow all relevant deft guidelines
- ! Use RFC 2119 MUST, SHOULD, MAY, SHOULD NOT, MUST NOT wording
- ! Break into phases, subphases, tasks
- ! End of each phase/subphase must implement and run testing until it passes
- ! Mark all dependencies explicitly: "Phase 2 (depends on: Phase 1)"
- ! Design for parallel work (multiple agents)
- ⊗ Write code (specification only)

## Afterwards

- ! Let user know to type "implement SPECIFICATION.md" to start implementation

**SPECIFICATION Structure (Light path — embedded Requirements):**

```markdown
# Project Name

## Overview

## Requirements

### Functional Requirements
- FR-1: [requirement]
- FR-2: [requirement]

### Non-Functional Requirements
- NFR-1: [requirement]
- NFR-2: [requirement]

## Architecture

## Implementation Plan

### Phase 1: Foundation

#### Subphase 1.1: Setup

- Task 1.1.1: (description, traces: FR-1, dependencies, acceptance criteria)

#### Subphase 1.2: Core (depends on: 1.1)

### Phase 2: Features (depends on: Phase 1)

## Testing Strategy

## Deployment
```

**SPECIFICATION Structure (Full path — references PRD):**

```markdown
# Project Name

## Overview
Brief summary and link to PRD.

## Architecture

## Implementation Plan

### Phase 1: Foundation

#### Subphase 1.1: Setup

- Task 1.1.1: (description, traces: FR-1, dependencies, acceptance criteria)

#### Subphase 1.2: Core (depends on: 1.1)

### Phase 2: Features (depends on: Phase 1)

## Testing Strategy

## Deployment
```

## Best Practices

- ! Detailed enough to implement without guesswork
- ! Clear scope boundaries (in vs out)
- ! Include rationale for major decisions
- ~ Size tasks for 1-4 hours
- ! Minimize inter-task dependencies
- ! Define clear component interfaces
- ! Each task SHOULD reference which FR/NFR it implements via `(traces: FR-N)`

## Anti-Patterns

- ⊗ Multiple questions at once
- ⊗ Assumptions without clarifying
- ⊗ Vague requirements
- ⊗ Missing dependencies
- ⊗ Sequential tasks that could be parallel
- ⊗ Creating PRD.md on the Light path
- ⊗ Skipping the sizing gate
