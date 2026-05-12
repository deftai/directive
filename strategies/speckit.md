# SpecKit Strategy

A spec-driven development workflow inspired by [GitHub's spec-kit](https://github.com/github/spec-kit), with a Phase 4.5 readiness layer for decomposing broad implementation scopes into swarm-safe stories.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/interview.md](./interview.md) | [strategies/discuss.md](./discuss.md) | [core/glossary.md](../core/glossary.md)

## When to Use

- ~ Large or complex projects with multiple contributors
- ~ Projects requiring formal specification review
- ~ When parallel agent development is planned
- ~ Enterprise environments with compliance requirements
- ? Skip Phase 1 if PROJECT-DEFINITION.vbrief.json Principles narrative already defined

## Workflow Overview

```mermaid
flowchart LR
    subgraph speckit ["SpecKit Strategy"]
        P["📜 Principles<br/><i>PROJECT-DEFINITION.vbrief.json</i>"]
        S["📝 Specify<br/><i>WHAT/WHY → specification.vbrief.json</i>"]
        PL["🏗️ Plan<br/><i>HOW → specification.vbrief.json</i>"]
        T["✅ Scope<br/><i>Phase/epic vBRIEFs</i>"]
        D["🧩 Decompose<br/><i>Story readiness</i>"]
        I["🔨 Implement<br/><i>Execute</i>"]
    end

    P -->|"Established"| S
    S -->|"Approved"| PL
    PL -->|"Reviewed"| T
    T -->|"Approved"| D
    D -->|"Ready stories"| I

    style P fill:#c4b5fd,stroke:#7c3aed,color:#000
    style S fill:#fef08a,stroke:#ca8a04,color:#000
    style PL fill:#6ee7b7,stroke:#059669,color:#000
    style T fill:#7dd3fc,stroke:#0284c7,color:#000
    style D fill:#fde68a,stroke:#d97706,color:#000
    style I fill:#f0abfc,stroke:#a855f7,color:#000
```

---

## Phase 1: Principles

**Goal:** Establish immutable project principles before any specification.

**Output:** `Principles` narrative in `vbrief/PROJECT-DEFINITION.vbrief.json`

! Before writing output artifacts, follow the [Spec-Generating Guard](./artifact-guards.md#spec-generating-guard-full).

### Process

- ! Define 3-5 non-negotiable principles
- ! Include at least one anti-principle (⊗)
- ! Write principles as the `Principles` narrative in `vbrief/PROJECT-DEFINITION.vbrief.json`
- ~ Interview stakeholders about architectural constraints
- ⊗ Proceed without defined principles
- ⊗ Create a standalone `project.md` -- principles belong in PROJECT-DEFINITION.vbrief.json

### Transition Criteria

- ! `Principles` narrative in `vbrief/PROJECT-DEFINITION.vbrief.json` is complete
- ! All stakeholders have reviewed principles
- ~ No `[NEEDS CLARIFICATION]` markers remain

---

## Phase 2: Specify (WHAT/WHY)

**Goal:** Document WHAT to build and WHY, without implementation details.

**Output:** WHAT/WHY narratives in `vbrief/specification.vbrief.json`

! Before writing output artifacts, follow the [Spec-Generating Guard](./artifact-guards.md#spec-generating-guard-full).

Write the following narrative keys

- `ProblemStatement` -- what problem this solves
- `Goals` -- desired outcomes
- `UserStories` -- user scenarios with priorities (P1, P2, P3) and acceptance scenarios (Given/When/Then)
- `Requirements` -- numbered functional (FR-001) and non-functional (NFR-001) requirements
- `SuccessMetrics` -- measurable success criteria (SC-001)
- `EdgeCases` -- boundary conditions and error handling

### Guidelines

- ! Focus on WHAT users need and WHY
- ! Use `[NEEDS CLARIFICATION: question]` for any ambiguity
- ! Number all requirements (FR-001, NFR-001) for traceability
- ! Prioritize user stories (P1, P2, P3)
- ⊗ Include HOW to implement (no tech stack, APIs, code)
- ⊗ Guess when uncertain -- mark it instead
- ⊗ Create `specs/` directories or standalone `spec.md` files -- all content goes in `vbrief/specification.vbrief.json`

### Transition Criteria

- ! No `[NEEDS CLARIFICATION]` markers remain in narratives
- ! All user stories have acceptance scenarios
- ! Requirements are testable and unambiguous
- ! Stakeholders have approved specification narratives

---

## Phase 3: Plan (HOW)

**Goal:** Document HOW to build it with technical decisions.

**Input:** Approved WHAT/WHY narratives in `vbrief/specification.vbrief.json`

**Output:** HOW narratives enriching `vbrief/specification.vbrief.json`

Add the following narrative keys to `vbrief/specification.vbrief.json` `plan.narratives`:

- `Architecture` -- high-level system design (components, data model, API contracts)
- `TechDecisions` -- technology choices with rationale
- `ImplementationPhases` -- phased delivery plan with dependencies
- `PreImplementationGates` -- simplicity gate, test-first gate

### Guidelines

- ! Reference spec requirements (FR-001, etc.) from Phase 2 narratives
- ! Document rationale for every technology choice
- ! Pass all pre-implementation gates before proceeding
- ⊗ Write implementation code
- ⊗ Create `specs/` directories or standalone `plan.md` files -- all content goes in `vbrief/specification.vbrief.json`

### Post-Phase 3 Transition Gate: Render for Review

! Phase 3 -> Phase 4 is gated on an explicit render-and-review step, mirroring the Phase 2 approval gate. Complete the steps below **in order** before advancing. [skills/deft-directive-setup/SKILL.md](../skills/deft-directive-setup/SKILL.md) is required to invoke `task spec:render` at this boundary when running speckit interactively; the gate fails silently otherwise (yolo-mode agents used to skip it -- that is what this gate exists to prevent).

1. ! Run `task spec:render` to (re-)produce `SPECIFICATION.md` from `vbrief/specification.vbrief.json`.
2. ! Confirm `SPECIFICATION.md` exists at the project root.
3. ! Confirm the hash of `SPECIFICATION.md` matches the hash of the rendered output of `vbrief/specification.vbrief.json` narratives -- re-run `task spec:render` if the file is out of date. This is the Phase 3 **hash-match transition criterion**.
4. ! `SPECIFICATION.md` is a read-only rendered export for human review. `vbrief/specification.vbrief.json` remains the source of truth -- direct edits to `SPECIFICATION.md` are overwritten by the next render.
5. ! Human reviewer approves the rendered spec (or requests changes). On approval, proceed to Phase 4.

### Transition Criteria

- ! All gates pass (or exceptions documented)
- ! Every spec requirement maps to a plan element
- ! Architecture reviewed and approved
- ! **Phase 3 -> Phase 4 transition criterion:** `SPECIFICATION.md` exists AND its hash matches the rendered output of the current `vbrief/specification.vbrief.json` narratives (run `task spec:render` to refresh; agents MUST NOT advance to Phase 4 without this).

---

## Phase 4: Implementation Phase / Epic Scope Emission

**Goal:** Emit one broad scope vBRIEF per implementation phase or epic so downstream tooling (`task roadmap:render`, `task project:render`, and Phase 4.5 decomposition) can operate against the lifecycle model described in [vbrief/vbrief.md](../vbrief/vbrief.md).

**Input:** Approved HOW narratives in `vbrief/specification.vbrief.json` (`ImplementationPhases` narrative describes IP-1..IP-N).

**Output:** N phase/epic scope vBRIEFs in `./vbrief/pending/`, one per implementation phase or epic, using the filename convention `YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json` (NNN = 3-digit zero-padded, 001..N). See [vbrief/vbrief.md — speckit Phase 4 scope vBRIEFs](../vbrief/vbrief.md#speckit-phase-4-scope-vbriefs) for the canonical convention.

Phase 4 scopes are planning containers. They MAY keep broad acceptance in `plan.narratives.Acceptance` and MAY have `plan.items: []`. They are not valid concurrent swarm worker inputs unless explicitly marked as a single-story scope. Broad phase/epic scopes MUST pass through Phase 4.5 before swarm allocation.

### Scope vBRIEF Shape

For each implementation phase IP-N, write a scope vBRIEF with:

- ! `plan.title` — phase title (e.g. "IP-3: Implement data layer")
- ! `plan.status` — `pending`
- ! `plan.narratives.Description` — short human summary of the phase
- ! `plan.narratives.Acceptance` — acceptance criteria copied from the spec
- ! `plan.narratives.Traces` — FR/NFR/IP IDs the phase covers (e.g. `FR-001, FR-003, NFR-002, IP-3`)
- ! `plan.references` — link back to the parent `vbrief/specification.vbrief.json` (`type: x-vbrief/plan`)
- ! `plan.metadata.kind` — `phase` or `epic`
- ! `plan.metadata.dependencies` — array of IP IDs this phase depends on / is blocked by (plan-level; mirrors the `edges[].blocks` structure used in earlier drafts)

```json
{
  "vBRIEFInfo": { "version": "0.6" },
  "plan": {
    "title": "IP-3: Implement data layer",
    "status": "pending",
    "narratives": {
      "Description": "Stand up the data layer described in specification.vbrief.json Architecture.",
      "Acceptance": "Repository interfaces defined; CRUD round-trips pass integration tests.",
      "Traces": "FR-001, FR-003, NFR-002, IP-3"
    },
    "metadata": {
      "kind": "phase",
      "dependencies": ["ip-1", "ip-2"]
    },
    "references": [
      { "type": "x-vbrief/plan", "uri": "./specification.vbrief.json" }
    ],
    "items": []
  }
}
```

### plan.vbrief.json — Session Tracker Only

- ! `plan.vbrief.json` reverts to its canonical session-todo role defined in [vbrief/vbrief.md — plan.vbrief.json](../vbrief/vbrief.md#planvbriefjson). It is the agent-private tactical plan for the current session, not the project-wide IP list.
- ! While working on a specific scope vBRIEF, `plan.vbrief.json` MUST carry a `planRef` to that scope vBRIEF in `vbrief/pending/` or `vbrief/active/`.
- ⊗ Emit the project-wide Phase 4 task list to `plan.vbrief.json` — write per-IP scope vBRIEFs to `vbrief/pending/` instead.

### Migrating Legacy speckit Projects

- ~ Projects that already emitted a speckit-shaped `plan.vbrief.json` (project-wide IP list) can convert to the new model with:
  ```
  python scripts/migrate_vbrief.py --speckit-plan vbrief/plan.vbrief.json
  ```
  The translator emits one scope vBRIEF per IP into `vbrief/pending/` (3-digit padded filenames, bilingual `edges` reader so both `from/to` and legacy `source/target` translate correctly) and writes the remaining session-level scaffold back to `plan.vbrief.json`.

### Guidelines

- ! Derive one scope vBRIEF per implementation phase from `ImplementationPhases`
- ! Populate `Description`, `Acceptance`, and `Traces` narratives per [vbrief/vbrief.md — canonical narrative keys](../vbrief/vbrief.md#scope-vbrief-narrative-keys)
- ! Use `plan.metadata.dependencies` (plan-level) rather than item-level `blocks` edges for cross-scope dependencies
- ! Use `plan.metadata.kind = "phase"` or `"epic"` for broad implementation scopes
- ~ Size each phase for 1-4 hours of work so the swarm allocator can distribute cleanly
- ⊗ Create phases not traceable to a spec requirement
- ⊗ Allocate Phase 4 phase/epic scope vBRIEFs directly to concurrent swarm workers

### Transition Criteria

- ! Every implementation phase from `ImplementationPhases` has a matching scope vBRIEF in `./vbrief/pending/`
- ! Each scope vBRIEF has `Description`, `Acceptance`, and `Traces` narratives
- ! Each scope vBRIEF carries a `references` entry linking back to `vbrief/specification.vbrief.json`
- ! Cross-scope dependencies in `plan.metadata.dependencies` form a valid DAG (no cycles)

---

## Phase 4.5: Story Decomposition / Swarm Readiness

**Goal:** Convert approved Phase 4 phase/epic scopes into child story vBRIEFs suitable for parallel agents.

**Input:** Phase 4 phase/epic vBRIEFs in `./vbrief/pending/` or `./vbrief/active/`.

**Output:** Story-level child vBRIEFs whose executable acceptance criteria live in `plan.items` and whose `plan.metadata.swarm` contract proves they are safe to allocate.

### Process

1. ! Inspect approved specification narratives and Phase 4 scope vBRIEFs.
2. ! Identify `plan.metadata.kind = "phase"` or `"epic"` scopes that are too broad for direct implementation.
3. ! Draft a deterministic decomposition proposal: stories, dependencies, expected file scope, verification commands, traces, and conflict groups.
4. ! Ask for explicit user approval before writing child story vBRIEFs.
5. ! Apply the approved draft with `task scope:decompose -- <parent.vbrief.json> --draft <decomposition.json>`.
6. ! Run `task swarm:readiness -- vbrief/active/*.vbrief.json` before concurrent allocation, or point it at the candidate child story files for a dry readiness review before activation.

### Story vBRIEF Requirements

Each Phase 4.5 child story vBRIEF MUST include:

- ! `plan.metadata.kind = "story"`
- ! non-empty `plan.items`
- ! executable acceptance in each story's `plan.items`
- ! explicit dependencies in `plan.metadata.swarm.depends_on`
- ! traceability back to requirements via `Traces` narratives or explicit trace justification
- ! expected file scope in `plan.metadata.swarm.file_scope`
- ! verify commands in `plan.metadata.swarm.verify_commands`
- ! expected outputs/evidence in `plan.metadata.swarm.expected_outputs`
- ! swarm readiness metadata in `plan.metadata.swarm`
- ! `planRef` pointing to the parent phase/epic scope
- ! parent phase/epic `references` updated to point to every child story

### Decomposition Command

Use the deterministic command surface:

```bash
task scope:decompose -- vbrief/pending/2026-05-12-ip001-auth.vbrief.json --draft decomposition.json
task scope:decompose -- vbrief/pending/2026-05-12-ip001-auth.vbrief.json --draft decomposition.json --check
task scope:decompose -- --check
```

The command validates and applies a proposed decomposition rather than freely inventing one. It creates child story vBRIEFs, preserves origin/provenance references, sets each child `planRef` to the parent scope, updates parent references to include children, validates the dependency DAG, rejects dependency cycles, and rejects ready stories missing acceptance, file scope, verify commands, or traces.

Parent phase/epic acceptance MAY remain in `plan.narratives.Acceptance` as context. Executable acceptance for swarm work MUST be redistributed into child story `plan.items`.

### Swarm Readiness Command

Use the readiness gate before swarm allocation:

```bash
task swarm:readiness -- vbrief/active/*.vbrief.json
```

The readiness report lists ready stories, blocked stories, decomposition-needed epics/phases, dependency waves, conflict groups, a file-overlap matrix, and missing fields. It exits non-zero when candidate work is not swarm-ready.

### Transition Criteria

- ! Candidate swarm work consists only of `kind=story` vBRIEFs
- ! Every candidate story has non-empty `plan.items`
- ! Every candidate story has file scope, verify commands, traces or trace justification, and readiness metadata
- ! Dependencies resolve and form a DAG
- ! No unsafe file-scope overlap exists among parallel stories
- ! No `size=large` story is marked `parallel_safe=true`
- ! Low-confidence file scopes are not treated as parallel-safe by default

---

## Phase 5: Implement

**Goal:** Execute scope vBRIEFs following test-first discipline.

**Input:** Story-level scope vBRIEFs in `./vbrief/pending/` (promote to `./vbrief/active/` via `task scope:activate` when work begins). `./vbrief/plan.vbrief.json` holds the current session's tactical todo list and carries a `planRef` to the active scope. Concurrent swarm implementation requires Phase 4.5-ready stories.

### Process

- ! Write tests BEFORE implementation (Red)
- ! Implement minimal code to pass tests (Green)
- ! Refactor while keeping tests green (Refactor)
- ! Update scope vBRIEF `plan.status` and folder via `task scope:*` commands as work progresses (`pending` → `running` → `completed`)
- ! Update `./vbrief/plan.vbrief.json` session todos as tactical steps progress (session-scoped; do NOT put the project-wide IP list here)
- ~ Work on story vBRIEFs whose `plan.metadata.swarm.depends_on` entries are already completed in parallel when possible

### File Creation Order

1. Create contract/API specifications
2. Create test files (contract → integration → unit)
3. Create source files to make tests pass
4. Refactor and document

### Guidelines

- ! Follow the `Principles` narrative in `vbrief/PROJECT-DEFINITION.vbrief.json` throughout
- ! Move scope vBRIEFs through lifecycle folders using `task scope:activate|complete|cancel|block|unblock`
- ⊗ Implement without failing tests first
- ⊗ Skip refactoring phase
- ⊗ Write the project-wide IP list to `plan.vbrief.json` — use `vbrief/pending/` scope vBRIEFs as the durable task tracker
- ⊗ Allocate broad `kind=epic` or `kind=phase` scopes to concurrent swarm workers before decomposition

---

## Artifacts Summary

| Phase | Artifact | Purpose |
|-------|----------|---------|
| 1. Principles | `vbrief/PROJECT-DEFINITION.vbrief.json` | Governing rules (Principles narrative) |
| 2. Specify | `vbrief/specification.vbrief.json` | WHAT/WHY narratives |
| 3. Plan | `vbrief/specification.vbrief.json` | HOW narratives (enriches Phase 2) |
| 3b. Render SPECIFICATION | `SPECIFICATION.md` (rendered via `task spec:render`) | Read-only human review export |
| 3c. Render PRD | `PRD.md` (rendered via `task prd:render`) | Optional stakeholder-review export |
| 4. Tasks | `./vbrief/pending/YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json` (one per IP/epic) | Phase/epic scope vBRIEFs drive roadmap/project render + decomposition |
| 4.5. Story decomposition | Child story vBRIEFs with `plan.metadata.swarm` | Swarm-ready executable units |
| 4b. Session todos | `./vbrief/plan.vbrief.json` | Session-level tactical plan (carries `planRef` to active scope) |
| 5. Implement | Code + tests | Working software, optionally via swarm |

## Directory Structure

```
project/
├── vbrief/
│   ├── PROJECT-DEFINITION.vbrief.json  # Phase 1: Principles narrative
│   ├── specification.vbrief.json       # Phase 2+3: WHAT/WHY + HOW narratives
│   ├── plan.vbrief.json                # Phase 4b: session todos (planRef to active scope)
│   └── pending/                        # Phase 4/4.5: IP-level scopes + child stories
│       └── YYYY-MM-DD-ip001-....vbrief.json
├── SPECIFICATION.md                    # Rendered export (task spec:render)
├── PRD.md                              # Optional rendered export (task prd:render)
└── src/                                # Phase 5
```

## Invoking This Strategy

Set in PROJECT-DEFINITION.vbrief.json narratives:
```json
"Strategy": "strategies/speckit.md"
```

Or explicitly:
```
Use the speckit strategy for this project.
```

Start with:
```
I want to build [project] with features:
1. [feature]
2. [feature]
```
