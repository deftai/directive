# Interview Strategy

The standard Deft workflow: structured interview → SPECIFICATION. This is the
canonical source of truth for the interview process. All entry points (CLI via
`run spec`, agent via `deft-setup` Phase 3, and `templates/make-spec.md`) MUST
follow this strategy.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/discuss.md](./discuss.md) | [strategies/yolo.md](./yolo.md) | [core/glossary.md](../core/glossary.md)

## When to Use

- ! Default strategy for all new projects
- ~ Projects with unclear or evolving requirements
- ~ When stakeholder alignment is needed before implementation
- ? Skip to SPECIFICATION phase if requirements are already fully documented

---

## Chaining Gate

Before spec generation, offer the user a chance to run preparatory strategies
or switch to a different spec-generating strategy. This gate is the single
orchestration point for strategy composition.

! The chaining gate MUST always be shown — even when the interview strategy is
invoked directly with no prior strategy.
! The chaining gate is a **blocking question**. The AI MUST present the options
and wait for the user to choose before proceeding.
⊗ Skip the chaining gate or proceed to the sizing gate without presenting it.

### When It Appears

- ! Before the [Sizing Gate](#sizing-gate) on every entry to the interview strategy
- ! After each completed preparatory strategy (recursive — the gate reappears)
- ! After the [Acceptance Gate](#acceptance-gate) when the user chooses "Revise" or "Switch"

### Options

Present two groups sourced from the `Type` column in
[strategies/README.md](./README.md#strategy-types):

**Default:**
1. **Proceed to specification** (default) — continue to the [Sizing Gate](#sizing-gate)

**Preparatory strategies** (type: `preparatory` — loops back to this gate on completion):
- Research — investigate the domain, find libraries, identify pitfalls
- Discuss — lock key decisions using Feynman technique
- Map — analyze existing codebase conventions

**Switch spec-generating strategy** (type: `spec-generating` — replaces current pipeline):
- Yolo — auto-pilot, Johnbot picks all answers
- SpecKit — five-phase formal spec process

### Run Count Annotations

- ! Previously-run strategies MUST display with a run count (e.g., `Research (ran 1×)`)
- ! No strategy is ever removed from the gate — users can re-run any strategy
- ! Run counts are read from `completedStrategies` in
  [`./vbrief/plan.vbrief.json`](../vbrief/vbrief.md#strategy-chaining-fields)

### State Tracking

- ! On completion of a preparatory strategy, update `completedStrategies` in
  `./vbrief/plan.vbrief.json`: increment `runCount`, append artifact paths
- ! Append all new artifact paths to the flat `artifacts` array
- ! The next strategy and eventual spec generation MUST load all artifacts
  listed in `plan.vbrief.json`

### Example Prompt

```
Ready to generate the specification. Before we proceed, would you like to:

1. Proceed to specification (default)

--- Preparatory (loops back) ---
2. Run a research phase — investigate the domain, find libraries, identify pitfalls
3. Run a discuss phase — lock key decisions using Feynman technique
4. Run a map phase — analyze existing codebase conventions

--- Switch strategy ---
5. Switch to yolo — auto-pilot picks all answers
6. Switch to speckit — formal five-phase spec process

7. Other (specify)
```

---

## Sizing Gate

Before the interview begins, determine project complexity to select the
appropriate path. The gate runs once, immediately after hearing what the user
wants to build.

! The sizing gate is a **blocking question**. The AI MUST propose a size and
wait for the user to confirm or override before asking any interview questions.
⊗ Combine the sizing proposal with the first interview question in the same message.
⊗ Proceed to interview questions before the user has explicitly confirmed the path.

### Sizing Signals

The AI SHOULD propose a size based on these signals; the user confirms or overrides:

- Number of features (≤5 → Light, >5 → Full)
- Number of components/services (1–2 → Light, 3+ → Full)
- Expected duration (days → Light, weeks/months → Full)
- Team/agent count (solo → Light, multi-agent/swarm → Full)
- Integration complexity (standalone → Light, external APIs/auth/DB → Full)

### PROJECT.md Override

`PROJECT.md` ? declare `**Process**: Light` or `**Process**: Full` to skip the
gate entirely. If the field is absent or empty, the AI MUST ask.

## Workflow Overview

```mermaid
flowchart LR
    subgraph interview ["Interview Strategy"]
        G{"⚖️ Sizing Gate"}
        I_L["💬 Interview<br/><i>Light path</i>"]
        I_F["💬 Interview<br/><i>Full path</i>"]
        P["📄 PRD<br/><i>What to build</i>"]
        S["📋 SPECIFICATION<br/><i>How to build it</i>"]
    end

    G -->|"Light"| I_L
    G -->|"Full"| I_F
    I_L -->|"Ambiguity resolved"| S
    I_F -->|"Ambiguity resolved"| P
    P -->|"Approved"| S
    S -->|"Ready"| IMPL["🔨 Implementation"]

    style G fill:#f0abfc,stroke:#a21caf,color:#000
    style I_L fill:#c4b5fd,stroke:#7c3aed,color:#000
    style I_F fill:#c4b5fd,stroke:#7c3aed,color:#000
    style P fill:#fef08a,stroke:#ca8a04,color:#000
    style S fill:#6ee7b7,stroke:#059669,color:#000
    style IMPL fill:#7dd3fc,stroke:#0284c7,color:#000
```

---

## Interview Rules (shared by both paths)

- ~ Use Claude AskInterviewQuestion when available (emulate if not)
- ! Ask **ONE** focused, non-trivial question per step
- ⊗ Ask multiple questions at once or sneak in "also" questions
- ~ Provide numbered answer options when appropriate
- ! Include "other" option for custom/unknown responses
- ! Indicate which option is RECOMMENDED
- ! When making an opinionated recommendation, state the principle (1 sentence)
- ! When done, append all questions asked and answers given to the working document

### Question Areas

- ! Missing decisions (language, framework, deployment)
- ! Edge cases (errors, boundaries, failure modes)
- ! Implementation details (architecture, patterns, libraries)
- ! Requirements (performance, security, scalability)
- ! UX/constraints (users, timeline, compatibility)
- ! Tradeoffs (simplicity vs features, speed vs safety)

### Transition Criteria (interview complete)

- ! All major decisions have answers
- ! Edge cases are addressed
- ! User has approved key tradeoffs (Interview strategy) or Johnbot has chosen recommended options (Yolo strategy)
- ~ Little ambiguity remains

---

## Light Path (small/medium projects)

Interview → SPECIFICATION with embedded Requirements.

### Flow

1. Sizing gate selects Light
2. Interview (rules above)
3. Write `./vbrief/specification.vbrief.json` with `status: draft`
4. Summarize decisions, ask user to review
5. On approval, update `status` to `approved`
6. Run `task spec:render` (or generate `SPECIFICATION.md` directly if task unavailable)

### SPECIFICATION Structure (Light)

```markdown
# [Project Name] SPECIFICATION

## Overview
Brief summary of the project.

## Requirements

### Functional Requirements
- FR-1: [requirement]
- FR-2: [requirement]

### Non-Functional Requirements
- NFR-1: Performance — [requirement]
- NFR-2: Security — [requirement]

## Architecture
High-level system design, components, data flow.

## Implementation Plan

### Phase 1: Foundation
#### Subphase 1.1: Setup
- Task 1.1.1: [description] (traces: FR-1)
  - Dependencies: none
  - Acceptance: [criteria]

#### Subphase 1.2: Core (depends on: 1.1)
- Task 1.2.1: [description] (traces: FR-2, NFR-1)

### Phase 2: Features (depends on: Phase 1)
...

## Testing Strategy
How to verify the implementation meets requirements.

## Deployment
How to ship it.
```

- ! Requirements section MUST appear in SPECIFICATION.md (embedded, no separate PRD)
- ! Each task SHOULD reference which FR/NFR it implements via `(traces: FR-N)`
- ⊗ Create a separate PRD.md on the Light path

---

## Full Path (large/complex projects)

Interview → PRD → SPECIFICATION with traceability.

### Flow

1. Sizing gate selects Full
2. Interview (rules above)
3. Generate `PRD.md` — user approval gate
4. Write `./vbrief/specification.vbrief.json` with `status: draft`
5. Summarize decisions, ask user to review
6. On approval, update `status` to `approved`
7. Run `task spec:render` (or generate `SPECIFICATION.md` directly if task unavailable)

### PRD Structure (Full path only)

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

### PRD Guidelines

- ! Focus on WHAT, not HOW
- ! Use RFC 2119 language (MUST, SHOULD, MAY)
- ! Number all requirements for traceability
- ~ Include acceptance criteria for each requirement
- ⊗ Include implementation details or architecture

### PRD Transition Criteria

- ! All functional requirements documented
- ! Non-functional requirements specified
- ! User has reviewed and approved PRD
- ~ No blocking open questions remain

### SPECIFICATION Structure (Full)

```markdown
# [Project Name] SPECIFICATION

## Overview
Brief summary and link to PRD.

## Architecture
High-level system design, components, data flow.

## Implementation Plan

### Phase 1: Foundation
#### Subphase 1.1: Setup
- Task 1.1.1: [description] (traces: FR-1)
  - Dependencies: none
  - Acceptance: [criteria]

#### Subphase 1.2: Core (depends on: 1.1)
- Task 1.2.1: [description] (traces: FR-2, NFR-1)

### Phase 2: Features (depends on: Phase 1)
...

## Testing Strategy
How to verify the implementation meets requirements.

## Deployment
How to ship it.
```

---

## SPECIFICATION Guidelines (both paths)

- ! Reference requirement IDs (FR-1, NFR-2, etc.) in each task
- ! Break into phases, subphases, tasks
- ! Mark ALL dependencies explicitly
- ! Design for parallel work (multiple agents)
- ! End each phase/subphase with tests that pass
- ~ Size tasks for 1-4 hours of work
- ~ Minimize inter-task dependencies
- ⊗ Write code (specification only)

### Task Format

Each task SHOULD include:
- ! Clear description
- ! Dependencies (or "none")
- ! Acceptance criteria
- ~ Estimated effort
- ? Assigned agent (for swarm mode)

### Transition Criteria

- ! All requirements mapped to tasks
- ! Dependencies form a valid DAG (no cycles)
- ! `./vbrief/specification.vbrief.json` status is `approved`
- ! `SPECIFICATION.md` has been rendered via `task spec:render`
- ! Proceed to [Acceptance Gate](#acceptance-gate)

---

## Acceptance Gate

After spec generation, present the user with a final decision before
implementation begins.

! The acceptance gate MUST appear after every spec generation (both Light and
Full paths).
! The acceptance gate is a **blocking question**. The AI MUST present the
options and wait for the user to choose.

### Options

1. **Accept** — spec is approved, proceed to implementation
   - ! Before handing off to implementation, verify the project toolchain is installed and functional — see [../coding/toolchain.md](../coding/toolchain.md); stop and report if any required tool is missing
2. **Revise** — return to the [Chaining Gate](#chaining-gate) with all prior
   context preserved (completed strategies, artifacts). Run additional
   preparatory strategies or regenerate the spec.
3. **Switch strategy** — return to the [Chaining Gate](#chaining-gate) to select
   a different spec-generating strategy (e.g., switch from interview to speckit)

### Rejected Spec Archival

- ! When the user chooses "Revise" or "Switch", the current `SPECIFICATION.md`
  MUST be archived to `history/specs/` before regeneration
- ! Archived name format: `SPECIFICATION-rejected-{ISO-timestamp}.md`
  (e.g., `SPECIFICATION-rejected-2026-03-15T19-23-00Z.md`)
- ! If a `PRD.md` exists (Full path), it is NOT archived — only the spec
- ~ Include a one-line header in the archived file noting why it was rejected

### State Preservation

- ! All `completedStrategies` and `artifacts` in `plan.vbrief.json` MUST be
  preserved across revisions
- ! The chaining gate will show updated run counts reflecting the full session history

---

## Artifacts Summary

**Light path:**

| Artifact | Purpose | Created By |
|----------|---------|------------|
| `./vbrief/specification.vbrief.json` | Spec source of truth | Interview |
| `SPECIFICATION.md` | Generated plan with embedded Requirements | Rendered |

**Full path:**

| Artifact | Purpose | Created By |
|----------|---------|------------|
| `PRD.md` | What to build (approval gate) | Interview |
| `./vbrief/specification.vbrief.json` | Spec source of truth | Post-PRD |
| `SPECIFICATION.md` | Generated implementation plan | Rendered |

## Invoking This Strategy

```
/deft:run:interview [project name]
```

Or explicitly:

```
Use the interview strategy to plan [project].
```

After completion:

```
implement SPECIFICATION.md
```
