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

- ! Check `PROJECT-DEFINITION.vbrief.json` narratives or `PROJECT.md` (deprecated) for `Light` or `Full` process — if declared, use that path
- ! If not declared, propose a size and **wait for the user to confirm** before proceeding
- ⊗ Combine the sizing proposal with the first interview question

**Light** (small/medium): Interview → PROJECT-DEFINITION narratives + proposed scopes → SPECIFICATION with embedded Requirements.
**Full** (large/complex): Interview → PROJECT-DEFINITION narratives + proposed scopes with traceability → SPECIFICATION. `PRD.md` is never an approval gate (? optional `task prd:render` export only).

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

### Optional PRD export (never authoritative)

! Greenfield authority is PROJECT-DEFINITION narratives + lifecycle scopes in `proposed/`. `PRD.md` is never authoritative.

? Users MAY run `task prd:render` for a read-only stakeholder rendered PRD export after scopes sit in `proposed/`.
⊗ Generate an authoritative `PRD.md` as an interview approval gate
⊗ Require PRD approval before writing scopes or PROJECT-DEFINITION
! Scope xBRIEFs / PROJECT-DEFINITION remain authoritative; rendered PRD/SPEC files are exports, not the source of truth

### Specification Flow (both paths)

1. ! Write scope vBRIEF(s) to `./vbrief/proposed/` with `status: proposed` using `YYYY-MM-DD-descriptive-slug.vbrief.json` naming
2. ! Summarize what was decided and ask the user to review
3. ! On user approval, leave scopes in `proposed/` with `status: proposed`. ⊗ Auto-run `task scope:promote` or `task scope:activate` as the effect of approving planning artifacts. Downstream build/swarm/refinement with explicit operator lifecycle intent remains the promote/activate bridge.
4. ! Update `./vbrief/PROJECT-DEFINITION.vbrief.json` items registry to include the new scope vBRIEF(s)
5. ? For project-wide spec: write `./vbrief/specification.vbrief.json` and run `task spec:render` to generate `SPECIFICATION.md`
6. ? Optionally run `task prd:render` for a read-only rendered PRD export

! The vBRIEF file MUST use this exact top-level structure:

- ! All `narratives` and `narrative` values MUST be plain strings — never objects or arrays
- ! Nested children within a PlanItem MUST use `items` (the preferred v0.6 PlanItem field)
- ≉ Use deprecated `subItems` for new content; it remains a compatibility alias only

```json
{
  "xBRIEFInfo": { "version": "0.8" },
  "plan": {
    "title": "Project Name SPECIFICATION",
    "status": "proposed",
    "narratives": {
      "Overview": "Brief project summary as a plain string.",
      "Architecture": "System design as a plain string."
    },
    "items": [
      {
        "id": "phase-1",
        "title": "Phase 1: Foundation",
        "status": "pending",
        "items": [
          {
            "id": "1.1",
            "title": "Subphase 1.1: Setup",
            "status": "pending",
            "items": [
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

- ! Tell the user scopes remain in `proposed/` until a downstream build/swarm/refinement step with explicit lifecycle intent runs promote/activate
- ⊗ Instruct `task scope:promote` solely because planning artifacts were approved

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

**SPECIFICATION Structure (Full path — requirements in PROJECT-DEFINITION / scopes):**

```markdown
# Project Name

## Overview
Brief summary (optional link to a rendered PRD export if one exists).

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
- ⊗ Generate an authoritative PRD.md — if needed, users run `task prd:render`
- ⊗ Auto-run `task scope:promote` or `task scope:activate` when the user approves planning artifacts
- ⊗ Skipping the sizing gate
