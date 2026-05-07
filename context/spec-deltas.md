# Spec Deltas

Tracking how requirements evolve across changes using vBRIEF references.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [commands.md](../commands.md) | [vbrief/vbrief.md](../vbrief/vbrief.md) | [context/context.md](./context.md)

---

## Core Principle

Code diffs show *what* changed. Spec deltas show *why* — how the system's requirements shifted. Reviewers can understand a change at the requirement level without reading implementation code.

---

## How It Works

When a change modifies existing requirements (or adds new ones), the change's `specs/` folder captures the delta as a vBRIEF file:

```
history/changes/add-remember-me/
└── specs/
    └── auth-session.delta.vbrief.json  ← New/changed requirements for auth-session
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

Spec delta files are vBRIEF v0.5 files with `plan.narratives` capturing requirement changes:

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "auth-session-delta",
    "status": "draft",
    "narratives": {
      "Baseline": "specification.vbrief.json -- auth-session scope",
      "NewRequirements": "FR-4: The system SHALL support configurable session expiration periods. GIVEN user checks 'Remember me' at login WHEN 30 days have passed THEN invalidate the session token AND clear the persistent cookie.",
      "ModifiedRequirements": "FR-1 (Session expiration): was: The system SHALL expire sessions after 24 hours without activity. now: The system SHALL expire sessions after a configured duration. Default 24 hours; 30 days with 'Remember me'.",
      "RemovedRequirements": ""
    }
  }
}
```

### Rules

- ! Each delta vBRIEF identifies its **Baseline** narrative — the spec or section it modifies
- ! Separate `NewRequirements` from `ModifiedRequirements` narratives
- ! For modified requirements, show **was** and **now** explicitly within the `ModifiedRequirements` narrative
- ! All narrative values MUST be plain strings — never objects or arrays
- ~ Organize spec deltas by capability: `specs/auth-session.delta.vbrief.json`
- ~ Use GIVEN/WHEN/THEN scenarios for behavioral requirements within narrative values
- ~ Use RFC 2119 language (MUST, SHOULD, MAY) within narrative values
- ⊗ Rewrite the full spec — only capture the delta
- ⊗ Omit the Baseline narrative — the delta is meaningless without it
- ⊗ Use markdown spec files (`spec.md`) — all spec deltas must be vBRIEF format

---

## vBRIEF Chain

Spec deltas form a chain via vBRIEF `references`:

```
specification.vbrief.json (baseline)
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

1. ! Read the baseline `specification.vbrief.json` (or relevant scope vBRIEFs)
2. ! Scan `history/changes/*/specs/` for any `*.delta.vbrief.json` files that modify relevant sections
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

- ! Read each `*.delta.vbrief.json` file's narratives and apply to the target scope vBRIEF
- ! Apply `NewRequirements` narrative to the scope vBRIEF
- ! Apply `ModifiedRequirements` narrative — replace **was** with **now** in the scope vBRIEF
- ! Apply `RemovedRequirements` narrative — remove identified requirements from the scope vBRIEF
- ~ The archived delta vBRIEF remains as a historical record of *why* the spec changed
- ! The main spec (scope vBRIEFs) should always reflect the current state of requirements
- ⊗ Leave spec deltas unmerged after archiving — the scope vBRIEF drifts from reality
- ⊗ Parse markdown to extract delta content — read vBRIEF narratives directly

---

## Anti-Patterns

- ⊗ Rewriting the full spec in every delta (capture only what changed)
- ⊗ Spec deltas without a Baseline narrative (orphaned deltas are useless)
- ⊗ Skipping spec deltas for behavioral changes ("the code is the spec")
- ⊗ Modifying archived spec deltas (history is immutable)
- ⊗ Accumulating unmerged deltas after archiving (spec rot)
- ⊗ Using markdown spec files (`spec.md`) — all spec deltas must be vBRIEF format
