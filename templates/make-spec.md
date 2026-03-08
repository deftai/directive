# Specification Generation

Agent workflow for creating project specifications via structured interview.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Input Template

```
I want to build [project name] that has the following features:
1. [feature]
2. [feature]
...
N. [feature]
```

## Interview Process

- ~ Use Claude AskInterviewQuestion when available (emulate it if not available)
- ! If Input Template fields are empty: ask overview, then features, then details
- ! Ask **ONE** focused, non-trivial question per step
- ⊗ ask more than one question per step; or try to sneak-in "also" questions
- ~ Provide numbered answer options when appropriate
- ! Include "other" option for custom/unknown responses
- ! make it clear which option you feel is RECOMMENDED
- ! when you are done, append to the end of this file all questions asked and answers given.

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

**Specification flow:**
1. ! Write `./vbrief/specification.vbrief.json` with `status: draft`
2. ! Summarize what was decided and ask the user to review
3. ! On user approval, update `status` to `approved` in the vbrief file
4. ! Run `task spec:render` (or generate `SPECIFICATION.md` directly if task unavailable)
5. ? For add-on specs: write `./vbrief/specification-{name}.vbrief.json` → `SPECIFICATION-{name}.md`

- ⊗ Write `SPECIFICATION.md` directly — it is generated from the vbrief source
- ! follow all relevant deft guidelines
- ! use RFC2119 MUST, SHOULD, MAY, SHOULD NOT, MUST NOT wording
- ! Break into phases, subphases, tasks
- ! end of each phase/subphase must implement and run testing until it passes
- ! Mark all dependencies explicitly: "Phase 2 (depends on: Phase 1)"
- ! Design for parallel work (multiple agents)
- ⊗ Write code (specification only)

## Afterwards

- ! let user know to type "implement SPECIFICATION.md" to start implementation

**Structure:**

```markdown
# Project Name

## Overview

## Requirements

## Architecture

## Implementation Plan

### Phase 1: Foundation

#### Subphase 1.1: Setup

- Task 1.1.1: (description, dependencies, acceptance criteria)

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

## Anti-Patterns

- ⊗ Multiple questions at once
- ⊗ Assumptions without clarifying
- ⊗ Vague requirements
- ⊗ Missing dependencies
- ⊗ Sequential tasks that could be parallel
