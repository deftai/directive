# Map Strategy

Structured analysis of an existing codebase before adding features.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/interview.md](./interview.md) | [strategies/discuss.md](./discuss.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) map-codebase workflow.

---

## When to Use

- ! When adding features to an existing codebase the agent hasn't seen before
- ~ When onboarding to a project with unknown conventions
- ! When exploring an unfamiliar codebase before deciding what to build
- ? Skip if the codebase is small (<10 files) or the agent already has context

## Invocation Modes

Map supports two modes, determined automatically by context:

- **Standalone** -- invoked directly via `/deft:run:map` with no active interview or
  spec workflow. Runs mapping, presents artifacts, and offers next-step options.
- **Chained** -- invoked from the [chaining gate](./interview.md#chaining-gate) during
  an active interview/spec workflow. Runs mapping, registers artifacts, and returns to
  the chaining gate.

The mapping workflow and artifact format are identical in both modes. Only the
completion behavior differs (see [Completion](#completion) below).

## Workflow

```
Map Codebase → Review Artifacts → Next Steps
```

Mapping produces artifacts that feed into planning so the agent **follows existing conventions** instead of inventing new ones.

---

## Mapping Artifacts

! Before writing output artifacts, follow the [Preparatory Guard](./artifact-guards.md#preparatory-guard-light).

Produce a single `vbrief/proposed/{project}-codebase-map.vbrief.json` with four narratives:

### `Stack` narrative -- Technology inventory

- ! Languages, versions, runtimes
- ! Frameworks and key dependencies
- ! Build tools and package managers
- ~ Environment configuration approach

### `Architecture` narrative -- System design

- ! Layers/components and their responsibilities
- ! Data flow between components
- ! Entry points (API routes, CLI, server start)
- ~ Error handling strategy

### `Conventions` narrative -- How code is written here

- ! Naming conventions (files, functions, variables)
- ! Import patterns and module organization
- ! Testing patterns (framework, file naming, assertion style)
- ! **Be prescriptive**: "Use camelCase for functions" not "some functions use camelCase"

### `Concerns` narrative -- Technical debt and risks

- ~ TODO/FIXME/HACK inventory with file paths
- ~ Large files (>500 lines) that may need splitting
- ~ Stubs and placeholder implementations
- ~ Missing test coverage areas

---

## Mapping Rules

- ! Include **file paths** with backticks — vague descriptions are not actionable
- ! Write **current state only** — never what was or what you considered
- ! Be **prescriptive** — "Use X pattern" guides future work; "X pattern is used" doesn't
- ! Answer **"where do I put new code?"** — not just what exists
- ⊗ Read `.env` contents or expose secrets — note existence only
- ~ Keep each artifact under 200 lines — detail over brevity, but focused

## How Artifacts Feed Downstream

- ! **Planning** loads relevant mapping narratives based on feature type
- ! **Execution** references `Conventions` narrative to match existing patterns
- ! **Verification** uses `Concerns` narrative to avoid introducing more debt

---

## Completion

### Artifact Registration (both modes)

- ! On completion, register artifacts in `./vbrief/plan.vbrief.json`:
  - Update `completedStrategies`: increment `runCount` for `"map"`,
    append artifact path (`vbrief/proposed/{project}-codebase-map.vbrief.json`)
  - Append the path to the flat `artifacts` array
- ! The mapping narratives MUST inform subsequent strategies and spec generation:
  - `Conventions` -> implementation constraints
  - `Architecture` -> where new code fits
  - `Concerns` -> things to avoid or fix

### Chained Mode (invoked from chaining gate)

- ! Return to [interview.md Chaining Gate](./interview.md#chaining-gate)
- ⊗ End the session after mapping without returning to the chaining gate

### Standalone Mode (invoked directly)

After presenting the mapping narratives to the user, offer next steps:

```
Mapping complete. Here's what I found:
  - Stack: [brief summary]
  - Architecture: [brief summary]
  - Conventions: [brief summary]
  - Concerns: [brief summary]

Artifact: vbrief/proposed/{project}-codebase-map.vbrief.json

What would you like to do next?

1. Start an interview — build a specification informed by this analysis
2. Run a discuss phase — lock key decisions using Feynman technique
3. Run a research phase — investigate libraries, alternatives, pitfalls
4. Done for now — review the artifact and come back later
```

- ! Present the narrative summary before offering options
- ! If the user chooses a strategy, invoke it (the artifact persists in `vbrief/proposed/`)
- ! If the user chooses "done", confirm the artifact location and exit cleanly
- ~ Recommend option 1 (interview) when the user's goal is to build or extend
- ~ Recommend option 4 (done) when the user's goal is exploration or onboarding

---

## Invoking This Strategy

```
/deft:run:map
```

Standalone — explore a codebase without starting an interview:
```
Map this codebase so I can understand it.
```

Before an interview — analysis-first, then spec:
```
Map this codebase, then use the interview strategy to plan [feature].
```

Or set in PROJECT-DEFINITION.vbrief.json narratives:
```json
"Strategy": "strategies/map.md"
```
