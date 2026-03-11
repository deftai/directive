# Spec Deltas

Tracking how requirements evolve across changes using vBRIEF references.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [commands.md](../commands.md) | [vbrief/vbrief.md](../vbrief/vbrief.md) | [context/context.md](./context.md)

---

## Core Principle

Code diffs show *what* changed. Spec deltas show *why* — how the system's requirements shifted. Reviewers can understand a change at the requirement level without reading implementation code.

---

## How It Works

When a change modifies existing requirements (or adds new ones), the change's `specs/` folder captures the delta:

```
history/changes/add-remember-me/
└── specs/
    └── auth-session/
        └── spec.md          ← New/changed requirements for auth-session
```

The spec delta is linked to the project's baseline spec via a vBRIEF reference in the change's `tasks.vbrief.json`:

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "add-remember-me",
    "status": "draft",
    "references": [
      {
        "uri": "file://./vbrief/specification.vbrief.json",
        "type": "x-vbrief/plan",
        "description": "Baseline spec this change modifies"
      }
    ],
    "items": [...]
  }
}
```

---

## Writing Spec Deltas

### Format

Spec delta files use the same RFC 2119 language as full specs but capture only what's new or changed:

```markdown
# auth-session — Spec Delta

**Change**: add-remember-me
**Baseline**: SPECIFICATION.md §auth-session

## New Requirements

### Requirement: Extended session with remember-me

The system SHALL support configurable session expiration periods.

#### Scenario: Extended session with remember me

- GIVEN user checks "Remember me" at login
- WHEN 30 days have passed
- THEN invalidate the session token
- AND clear the persistent cookie

## Modified Requirements

### Requirement: Session expiration (modified)

**Was**: The system SHALL expire sessions after 24 hours without activity.

**Now**: The system SHALL expire sessions after a configured duration.
Default 24 hours; 30 days with "Remember me."
```

### Rules

- ! Each spec delta file identifies its **baseline** — the spec or section it modifies
- ! Separate "New Requirements" from "Modified Requirements"
- ! For modified requirements, show **was** and **now** explicitly
- ~ Organize spec deltas by capability, matching the project's spec structure
- ~ Use GIVEN/WHEN/THEN scenarios for behavioral requirements
- ⊗ Rewrite the full spec — only capture the delta
- ⊗ Omit the baseline reference — the delta is meaningless without it

---

## vBRIEF Chain

Spec deltas form a chain via vBRIEF `references`:

```
SPECIFICATION.md (baseline)
    ↑ referenced by
history/changes/add-auth/tasks.vbrief.json
    ↑ referenced by
history/changes/add-remember-me/tasks.vbrief.json
```

Each change's `tasks.vbrief.json` references what it builds on:

- For the first change: reference the project's `specification.vbrief.json`
- For subsequent changes: reference the prior change's `tasks.vbrief.json` if the changes are related, or the baseline spec if independent

### Reference Types

Use the vBRIEF `references` array with `type: "x-vbrief/plan"`:

```json
"references": [
  {
    "uri": "file://./vbrief/specification.vbrief.json",
    "type": "x-vbrief/plan",
    "description": "Baseline project specification"
  },
  {
    "uri": "file://./history/changes/add-auth/tasks.vbrief.json",
    "type": "x-vbrief/plan",
    "description": "Prior change this builds on"
  }
]
```

### Narratives for Context

Use vBRIEF `narratives` on the plan to capture the **why** of the spec change:

```json
"narratives": {
  "Proposal": "Add remember-me checkbox to extend session duration",
  "Background": "Users report frustration with 24-hour session timeout"
}
```

---

## Reading Spec Deltas

When an agent needs to understand the current state of requirements:

1. ! Read the baseline `SPECIFICATION.md`
2. ! Scan `history/changes/*/specs/` for any deltas that modify relevant sections
3. ! Apply deltas in chronological order (directory timestamps or vBRIEF chain order)
4. ~ Archived changes (`history/archive/`) represent already-merged deltas — skip unless investigating history

---

## When to Create Spec Deltas

- ! When a change adds new behavioral requirements
- ! When a change modifies existing requirements
- ~ When a change has non-obvious acceptance criteria worth documenting as requirements
- ? Skip for pure refactors, dependency bumps, or infrastructure changes that don't alter behavior

---

## After Archiving

When a change is archived via `/deft:change:archive`:

- ~ Merge the spec delta into the project's main `SPECIFICATION.md` (or its vBRIEF source)
- ~ The archived spec delta remains as a historical record of *why* the spec changed
- ! The main spec should always reflect the current state of requirements
- ⊗ Leave spec deltas unmerged after archiving — the main spec drifts from reality

---

## Anti-Patterns

- ⊗ Rewriting the full spec in every delta (capture only what changed)
- ⊗ Spec deltas without a baseline reference (orphaned deltas are useless)
- ⊗ Skipping spec deltas for behavioral changes ("the code is the spec")
- ⊗ Modifying archived spec deltas (history is immutable)
- ⊗ Accumulating unmerged deltas after archiving (spec rot)
