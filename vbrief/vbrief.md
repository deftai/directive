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

## specification.vbrief.json

The source-of-truth for project intent. Created via the interview process in
[templates/make-spec.md](../templates/make-spec.md).

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

**Status lifecycle per task:** `todo` → `doing` → `done` / `blocked` / `skip` / `deferred`

- ! There is exactly ONE `plan.vbrief.json` at a time per project
- ! Use this wherever you would use a Warp `create_todo_list` — externalise to this file instead
- ~ Update task statuses as work progresses
- ! Mark tasks `blocked` with a narrative explaining the blocker
- ~ Record deferred ideas with `deferred` status and a narrative explaining why
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

```
Interview (make-spec.md)
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
SPECIFICATION.md                     ← generated, never hand-edited
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
| `mark_todo_as_done`     | update task `status` → `done`              |
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
