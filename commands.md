# Change Lifecycle Commands

Workflows for scoped changes to an existing codebase — propose, implement, verify, archive.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [verification/verification.md](./verification/verification.md) | [resilience/continue-here.md](./resilience/continue-here.md) | [vbrief/vbrief.md](./vbrief/vbrief.md)

---

## Overview

Each change is a self-contained unit of work with its own folder in `history/changes/`. The lifecycle is:

```
/deft:change <name>  →  /deft:change:apply  →  /deft:change:verify  →  /deft:change:archive
        │                          │                          │                          │
   Create proposal          Implement tasks           Verify outcomes          Move to archive
```

---

## `/deft:change <name>`

Create a scoped change proposal.

### Process

- ! Create `history/changes/<name>/` with the artifacts below
- ! Read existing specs in the project (if any) to understand current state
- ~ Run `/deft:run:discuss` first if the change has gray areas
- ~ Run `/deft:run:research` first if the domain is unfamiliar

### Artifacts

```
history/changes/<name>/
├── proposal.md          ← Why this change, what's affected, scope
├── design.md            ← Technical approach, alternatives considered
├── tasks.vbrief.json    ← Implementation tasks in vBRIEF format
└── specs/               ← Spec deltas (how requirements change)
    └── <capability>/
        └── spec.md      ← New or modified requirements
```

### proposal.md

- ! **Problem** — what's wrong or missing
- ! **Change** — what this proposal does about it
- ! **Scope** — what's in, what's explicitly out
- ~ **Impact** — what existing code/specs are affected
- ~ **Risks** — what could go wrong

### design.md

- ! **Approach** — how to implement the change
- ~ **Alternatives** — what else was considered and why not
- ~ **Dependencies** — what must exist before this works
- ? Skip if the change is trivial (< 1 hour of work)

### tasks.vbrief.json

- ! Use vBRIEF format with `blocks` edges for dependencies
- ! Each task has `narrative` with acceptance criteria
- ~ Size tasks for 1–4 hours of work
- ! Status lifecycle: plan-level `draft` → `proposed` → `approved` → `completed`; task-level `pending` → `running` → `completed` / `blocked` / `cancelled`

Example:

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "add-dark-mode",
    "status": "draft",
    "items": [
      {
        "id": "t1",
        "title": "Add theme context provider",
        "status": "pending",
        "narrative": { "Action": "Create ThemeContext with light/dark state and toggle" }
      },
      {
        "id": "t2",
        "title": "Create toggle component",
        "status": "pending",
        "narrative": { "Action": "Toggle button wired to ThemeContext" }
      },
      {
        "id": "t3",
        "title": "Add CSS variables for themes",
        "status": "pending",
        "narrative": { "Action": "Define CSS custom properties for light and dark palettes" }
      }
    ],
    "edges": [
      { "from": "t1", "to": "t2", "type": "blocks" },
      { "from": "t1", "to": "t3", "type": "blocks" }
    ]
  }
}
```

### specs/

Spec deltas capture how requirements change. See [context/spec-deltas.md](./context/spec-deltas.md) for full format and vBRIEF chain pattern.

- ? Create spec files only when the change modifies requirements
- ! Each spec file captures the **new or changed** requirements, not the full system
- ! Separate "New Requirements" from "Modified Requirements" — show **was** and **now** for modifications
- ! Include a **baseline** reference identifying which spec/section is being modified
- ~ Organize by capability: `specs/auth-session/spec.md`, `specs/checkout-cart/spec.md`
- ~ Use RFC 2119 language (MUST, SHOULD, MAY)
- ~ Use GIVEN/WHEN/THEN scenarios for behavioral requirements
- ~ Link to baseline spec via vBRIEF `references` in `tasks.vbrief.json`
- ⊗ Rewrite the full spec — only capture the delta

---

## `/deft:change:apply`

Implement the active change's tasks.

### Process

- ! Read `tasks.vbrief.json` from the active change folder
- ! Confirm the plan status is `approved` (or prompt user to approve)
- ! Follow task ordering from `blocks` edges
- ! Update task statuses as work progresses
- ! Follow TDD: write tests before implementation
- ~ Reference `design.md` for architectural decisions
- ~ Reference `specs/` for requirement details

### Active Change Detection

- ! Look for a single change in `history/changes/` with `status: approved`
- ~ If multiple changes exist, ask the user which one to apply
- ⊗ Apply a change that hasn't been reviewed

---

## `/deft:change:verify`

Verify the active change against its acceptance criteria.

### Process

- ! Read acceptance criteria from `tasks.vbrief.json` task narratives
- ! Apply the verification ladder from [verification/verification.md](./verification/verification.md)
- ! Check for stubs (TODO, FIXME, return null, pass)
- ! Verify all spec requirements in `specs/` are satisfied
- ~ Run `task check` as a baseline
- ! Record verification tier reached per task in `tasks.vbrief.json` metadata

---

## `/deft:change:archive`

Archive a completed change.

### Process

- ! Verify all tasks in `tasks.vbrief.json` have a terminal status (`completed`, `blocked`, or `cancelled`)
- ~ If any tasks are `blocked` or `cancelled`, confirm with the user that archiving is intentional
- ! Update `tasks.vbrief.json` plan status to `completed`
- ! Move `history/changes/<name>/` to `history/archive/<date>-<name>/`
- ! Date format: `YYYY-MM-DD` (e.g., `history/archive/2026-03-10-add-dark-mode/`)

### Spec Delta Merge

If the change included spec deltas (`specs/`), merge them into the project's main spec before archiving. See [context/spec-deltas.md](./context/spec-deltas.md) § After Archiving.

- ! Read each spec delta in the change's `specs/` directory
- ! Apply "New Requirements" to the corresponding section in `SPECIFICATION.md` (or its vBRIEF source)
- ! Apply "Modified Requirements" — replace the **was** with the **now** in the main spec
- ! Verify the main spec is internally consistent after merge
- ~ Use `task spec:render` to regenerate `SPECIFICATION.md` from the vBRIEF source if applicable
- ⊗ Leave spec deltas unmerged — the main spec drifts from reality

### CHANGELOG Entry

- ~ Add a CHANGELOG.md entry summarizing the change
- ~ Use the change's `proposal.md` Problem/Change sections as the source
- ~ Follow the existing CHANGELOG format ([Keep a Changelog](https://keepachangelog.com/en/1.0.0/))
- ? Link to the archived change folder for full context

### What Gets Archived

The entire change folder moves as-is. The archive is a historical record — never modify archived changes.

- ⊗ Delete archived changes
- ⊗ Modify files in `history/archive/`
- ? Prune old archives periodically if disk space is a concern

---

## Anti-Patterns

- ⊗ Creating a change without a proposal (jumping straight to code)
- ⊗ Applying a change that hasn't been reviewed/approved
- ⊗ Modifying archived changes
- ⊗ Having multiple active changes without explicit user coordination
- ⊗ Skipping verification before archiving
