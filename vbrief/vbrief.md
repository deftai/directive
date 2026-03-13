# vBRIEF Usage in Deft

Canonical reference for vBRIEF file conventions within Deft-managed projects.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [context/working-memory.md](../context/working-memory.md) | [resilience/continue-here.md](../resilience/continue-here.md) | [context/long-horizon.md](../context/long-horizon.md)

---

## File Taxonomy

All vBRIEF files live in `./vbrief/` within the project workspace. There are exactly 5 types:

| File | Purpose | Lifecycle |
|------|---------|-----------|
| `specification.vbrief.json` | Project spec source of truth | Durable (never deleted) |
| `specification-{name}.vbrief.json` | Add-on spec, must include `planRef` back to main spec | Durable |
| `plan.vbrief.json` | Single active work plan; absorbs todo/plan/progress | Session-durable |
| `continue.vbrief.json` | Interruption recovery checkpoint | Ephemeral (consumed on resume) |
| `playbook-{name}.vbrief.json` | Reusable operational knowledge | Permanent |

- ! All vBRIEF files MUST live in `./vbrief/` — never in workspace root or elsewhere
- ! File names MUST use the `.vbrief.json` extension
- ⊗ Use ULID or timestamp suffixes on `continue` or `plan` — they are singular by design
- ⊗ Create multiple `plan.vbrief.json` files — there is exactly one active plan
- ⊗ Create a separate `todo-*.json` — todos live in `plan.vbrief.json`

---

## File Format

All `.vbrief.json` files conform to the **vBRIEF v0.5** specification.
Canonical reference: [https://vbrief.org](https://vbrief.org)

### Required Top-Level Structure

Every vBRIEF file ! MUST contain exactly two top-level keys:

- **`vBRIEFInfo`** — envelope metadata
  - ! `version` MUST be `"0.5"`
  - ? `author`, `description`, `created`, `updated`, `metadata`
- **`plan`** — the plan payload
  - ! `title` (non-empty string), `status`, `items` (array of PlanItems)
  - ? `id`, `narratives`, `edges`, `tags`, `metadata`, `references`, etc.

### Status Enum

The `Status` type is shared by `plan.status` and every `PlanItem.status`:

```
draft | proposed | approved | pending | running | completed | blocked | cancelled
```

- ! Status values MUST be one of the eight values above (case-sensitive, lowercase)
- ~ Use `blocked` with a narrative explaining the blocker
- ~ Use `cancelled` rather than deleting items — preserve history

### Minimal Example

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "Fix login bug",
    "status": "running",
    "items": [
      { "title": "Reproduce the issue", "status": "completed" },
      { "title": "Write regression test", "status": "running" }
    ]
  }
}
```

### Structured Example

```json
{
  "vBRIEFInfo": {
    "version": "0.5",
    "author": "agent:warp-oz",
    "description": "Sprint 4 delivery plan",
    "created": "2026-03-10T14:00:00Z"
  },
  "plan": {
    "id": "sprint-4",
    "title": "Sprint 4 — Auth + Dashboard",
    "status": "running",
    "tags": ["sprint", "q1"],
    "items": [
      {
        "id": "auth",
        "title": "Implement OAuth flow",
        "status": "completed",
        "narrative": { "Outcome": "OAuth2 PKCE flow working with Google and GitHub providers" },
        "tags": ["auth", "security"]
      },
      {
        "id": "dashboard",
        "title": "Build dashboard layout",
        "status": "blocked",
        "narrative": { "Problem": "Waiting on design team to finalize mockups" }
      }
    ]
  }
}
```

### Local Schema

A copy of the canonical JSON Schema is available at
[`./schemas/vbrief-core.schema.json`](./schemas/vbrief-core.schema.json)
for local validation. Source: [github.com/visionik/vBRIEF](https://github.com/visionik/vBRIEF).

---

## specification.vbrief.json

The source-of-truth for project intent. Created via the interview process in
[strategies/interview.md](../strategies/interview.md) (canonical) or
[templates/make-spec.md](../templates/make-spec.md) (template implementation).

**Status lifecycle:** `draft` → `approved` → (locked)

- ! The spec MUST be approved by the user before implementation begins
- ! `SPECIFICATION.md` is generated FROM the vbrief spec — never written directly
- ~ Use `task spec:render` to regenerate `SPECIFICATION.md` after spec edits
- ⊗ Edit `SPECIFICATION.md` directly — edit the source `specification.vbrief.json` instead
- ? Create `specification-{name}.vbrief.json` for add-on specs (e.g. security, deployment)
  — each MUST include a `planRef` pointing back to the main specification

---

## plan.vbrief.json

The single active work plan. Unifies what were previously separate todo, plan, and progress files.

**Status lifecycle per task:** `pending` → `running` → `completed` / `blocked` / `cancelled`

- ! There is exactly ONE `plan.vbrief.json` at a time per project
- ! Use this wherever you would use a Warp `create_todo_list` — externalise to this file instead
- ~ Update task statuses as work progresses
- ! Mark tasks `blocked` with a narrative explaining the blocker
- ~ Record blocked ideas with `blocked` status and a narrative explaining why
- ~ On completion, review for learnings worth persisting to [meta/lessons.md](../meta/lessons.md)

---

## continue.vbrief.json

A single interruption-recovery checkpoint. See [resilience/continue-here.md](../resilience/continue-here.md)
for full protocol.

- ! Singular — `continue.vbrief.json`, not `continue-{ULID}.json`
- ! Ephemeral — consumed on resume; must be deleted (or marked `completed`) afterwards
- ⊗ Accumulate stale continue files

---

## playbook-{name}.vbrief.json

Reusable operational patterns. Examples: `playbook-deploy.vbrief.json`, `playbook-release.vbrief.json`.

- ~ Include a `narrative` on each step explaining intent, not just action
- ~ Reference playbooks from plan tasks via `playbookRef` field

---

## Specification Flow

**Light path** (interview.md → SPECIFICATION with embedded Requirements):
```
Interview (strategies/interview.md, Light path)
        │
        ▼
./vbrief/specification.vbrief.json   ← status: draft
        │
   user reviews
        │
        ▼
./vbrief/specification.vbrief.json   ← status: approved
        │
   task spec:render
        │
        ▼
SPECIFICATION.md                     ← generated, with embedded Requirements
```

**Full path** (interview.md → PRD → SPECIFICATION with traceability):
```
Interview (strategies/interview.md, Full path)
        │
        ▼
PRD.md                               ← user approval gate
        │
        ▼
./vbrief/specification.vbrief.json   ← status: draft
        │
   user reviews
        │
        ▼
./vbrief/specification.vbrief.json   ← status: approved
        │
   task spec:render
        │
        ▼
SPECIFICATION.md                     ← generated, traces to PRD requirement IDs
```

Add-on specs follow the same flow:
```
./vbrief/specification-{name}.vbrief.json  →  SPECIFICATION-{name}.md
```

---

## Tool Mappings

| Warp / agent tool       | vBRIEF equivalent                          |
|-------------------------|--------------------------------------------|
| `create_todo_list`      | write `./vbrief/plan.vbrief.json`          |
| `mark_todo_as_done`     | update task `status` → `completed`         |
| `add_todos`             | append task to `./vbrief/plan.vbrief.json` |
| `remove_todos`          | set task `status` → `cancelled` (never delete) |
| session end / interrupt | write `./vbrief/continue.vbrief.json`      |
| spec interview output   | write `./vbrief/specification.vbrief.json` |

---

## Anti-Patterns

- ⊗ Placing vBRIEF files in workspace root (`./plan.vbrief.json`, `./progress.vbrief.json`)
- ⊗ Using ULID suffixes on `plan`, `continue`, or `todo` files — they are singular
- ⊗ Creating `todo-{ULID}.json` — todos live in `plan.vbrief.json`
- ⊗ Editing `SPECIFICATION.md` directly — it is a generated artifact
- ⊗ Treating `plan.vbrief.json` as a scratch file and deleting it mid-task
- ⊗ Creating both a `plan.vbrief.json` and a separate `progress.vbrief.json` — they are the same file
