# vBRIEF Usage in Deft

Canonical reference for vBRIEF file conventions within Deft-managed projects.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [context/working-memory.md](../context/working-memory.md) | [resilience/continue-here.md](../resilience/continue-here.md) | [context/long-horizon.md](../context/long-horizon.md)

---

## File Taxonomy

All vBRIEF files live in `./vbrief/` within the project workspace. Files are organized into **singular operational files** at the vbrief root and **scope vBRIEFs** in lifecycle folders.

### Directory Structure

```
vbrief/
  PROJECT-DEFINITION.vbrief.json   <- project identity gestalt
  specification.vbrief.json        <- project spec source of truth
  specification-{name}.vbrief.json <- add-on specs
  plan.vbrief.json                 <- session-level tactical plan (singular)
  continue.vbrief.json             <- interruption checkpoint (singular, ephemeral)
  playbook-{name}.vbrief.json      <- reusable operational patterns
  proposed/                         <- ideas, not committed to (draft, proposed)
  pending/                          <- accepted backlog (approved, pending)
  active/                           <- in progress (running, blocked)
  completed/                        <- done (completed)
  cancelled/                        <- rejected/abandoned (cancelled), restorable
```

### Root-Level Files

| File | Purpose | Lifecycle |
|------|---------|----------|
| `PROJECT-DEFINITION.vbrief.json` | Project identity gestalt — `narratives` for identity (overview, tech stack, architecture, risks/unknowns, config), `items` as scope registry; uses existing v0.5 schema | Durable (regenerated on demand) |
| `specification.vbrief.json` | Project spec source of truth | Durable (never deleted) |
| `specification-{name}.vbrief.json` | Add-on spec with `planRef` back to main spec | Durable |
| `plan.vbrief.json` | Session-level tactical plan; the *how right now*; carries `planRef` to scope vBRIEFs | Session-durable |
| `continue.vbrief.json` | Interruption recovery checkpoint; carries `planRef` to scope vBRIEFs | Ephemeral (consumed on resume) |
| `playbook-{name}.vbrief.json` | Reusable operational knowledge | Permanent |

### Scope vBRIEFs and Lifecycle Folders

Individual units of work (features, bugs, initiatives) live as scope vBRIEFs in five lifecycle folders:

| Folder | Status Values | Description |
|--------|---------------|-------------|
| `proposed/` | `draft`, `proposed` | Ideas and proposals, not yet committed |
| `pending/` | `approved`, `pending` | Accepted backlog, ready for work |
| `active/` | `running`, `blocked` | In progress; `blocked` is temporary — stays in `active/` |
| `completed/` | `completed` | Done — terminal state |
| `cancelled/` | `cancelled` | Rejected/abandoned — restorable to `proposed/` |

### Status-Driven Moves

- ! `plan.status` inside each scope vBRIEF is the **source of truth** — not the folder location
- ! Folder location is a convenience view for humans; metadata is authoritative
- ! Agents MUST move files to the matching lifecycle folder when status changes
- ! When moving a file, agents MUST update all `planRef` and `references[].url` values in other scope vBRIEFs and in `PROJECT-DEFINITION.vbrief.json` that point to the moved file
- ~ When folder/status drift is detected, trust the status field and correct the folder
- ⊗ Move files between folders without updating `plan.status`

### Filename Convention

- ! Scope vBRIEF filenames MUST follow: `YYYY-MM-DD-descriptive-slug.vbrief.json`
- ! The date MUST be the **creation date** (immutable — does not change as the scope progresses)
- ~ Use lowercase hyphen-separated slugs (e.g. `2026-04-12-add-oauth-flow.vbrief.json`)

### Origin Provenance

- ! Every ingested scope vBRIEF MUST carry `references` linking to its origin
- ! Enables deduplication during ingest (diff open issues against existing vBRIEF references)
- ~ On scope completion, update the origin (close the issue, post a comment linking to the PR)

Reference types (extensible by convention): `github-issue`, `jira-ticket`, `user-request`

```json
"references": [
  { "type": "github-issue", "url": "https://github.com/deftai/directive/issues/123", "id": "#123" }
]
```

### Epic-Story Linking

Larger initiatives use **epic vBRIEFs** linking to child **story vBRIEFs**. Linking is bidirectional:

- ! All `url` and `planRef` path values in scope vBRIEF JSON are **relative to the `vbrief/` directory** — not relative to the containing file's location
- ! Epic `references` array MUST list child story file paths (type: `x-vbrief/plan`)
- ! Story vBRIEFs MUST carry `planRef` back to their parent epic
- ~ The decision to create an epic vs. a standalone story is made collaboratively between user and agent

**Epic → Stories** (via `references`):
```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "Auth system overhaul",
    "status": "running",
    "references": [
      { "type": "x-vbrief/plan", "url": "./active/2026-04-12-oauth-flow.vbrief.json" },
      { "type": "x-vbrief/plan", "url": "./active/2026-04-12-session-mgmt.vbrief.json" }
    ]
  }
}
```

**Story → Epic** (via `planRef`):
```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "Implement OAuth flow",
    "status": "running",
    "planRef": "./active/2026-04-10-auth-system-overhaul.vbrief.json"
  }
}
```

### Coexistence: Scope vBRIEFs, plan.vbrief.json, and continue.vbrief.json

Scope vBRIEFs are durable scope records (the *what*); `plan.vbrief.json` remains the ephemeral session-level tactical plan (the *how right now*); `continue.vbrief.json` remains the interruption checkpoint. Both gain a parent reference to scope vBRIEFs via `planRef`.

- **Scope vBRIEF** — acceptance criteria, scope definition, origin provenance. Durable across sessions. Shared between agents.
- **plan.vbrief.json** — granular implementation steps for this session. Session-durable. Agent-private.
- **continue.vbrief.json** — interruption checkpoint. References scope vBRIEF(s) being worked on.

- ! When scope vBRIEFs exist, plan.vbrief.json and continue.vbrief.json MUST carry a `planRef` to the scope vBRIEF(s) they relate to
- ⊗ Use scope vBRIEFs as session scratchpads — that is what plan.vbrief.json is for

### Scope Splitting

When a scope grows too large, the parent vBRIEF becomes an epic and children are created:

1. Agent identifies the scope is too large (collaboratively with user)
2. Parent vBRIEF promoted to epic
3. Child story vBRIEFs created with `planRef` back to parent
4. Parent epic's `references` updated to list all child paths
5. Update `plan.vbrief.json` (and `continue.vbrief.json` if present) `planRef` to reference child scope vBRIEFs
6. Acceptance criteria redistributed by agent with user approval
7. Origin provenance stays on the parent epic; children inherit via epic relationship

- ! Scope splitting is agent-driven using existing tools — no dedicated split command
- ~ Uses existing `scope:*` commands for lifecycle transitions after splitting

### General Rules

- ! All vBRIEF files MUST live in `./vbrief/` or its lifecycle subfolders — never in workspace root
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

### Narratives

- ! `plan.narratives` values MUST be plain strings — never objects or arrays
- ! `PlanItem.narrative` values MUST be plain strings — never objects or arrays
- ⊗ Use `{"Requirements": {"Functional": [...], "NonFunctional": [...]}}` — split into separate string keys instead (e.g. `"FunctionalRequirements": "FR-1: ...\nFR-2: ..."`, `"NonFunctionalRequirements": "NFR-1: ...\nNFR-2: ..."`)

### Hierarchical Items (subItems)

Specs with phases, subphases, and tasks use `subItems` to express nesting:

- ! Nested children within a PlanItem MUST use `subItems` (not `items`)
- ! `items` is ONLY valid at the `plan` level — inside a PlanItem it is ignored by tools
- ⊗ Use `items` inside a PlanItem — it will be silently dropped by vBRIEF-Studio and other tools

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "Project SPECIFICATION",
    "status": "draft",
    "narratives": {
      "Overview": "Brief project summary as a plain string.",
      "Architecture": "System design description as a plain string."
    },
    "items": [
      {
        "id": "phase-1",
        "title": "Phase 1: Foundation",
        "status": "pending",
        "subItems": [
          {
            "id": "1.1",
            "title": "Subphase 1.1: Setup",
            "status": "pending",
            "subItems": [
              {
                "id": "1.1.1",
                "title": "Project scaffolding",
                "status": "pending",
                "narrative": {
                  "Acceptance": "Build succeeds with empty project",
                  "Traces": "FR-1"
                }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### Local Schema

A copy of the canonical JSON Schema is available at
[`./schemas/vbrief-core.schema.json`](./schemas/vbrief-core.schema.json)
for local validation. Source: [github.com/deftai/vBRIEF](https://github.com/deftai/vBRIEF).

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

## PROJECT-DEFINITION.vbrief.json

The synthesized project identity — what this project IS right now. Uses the existing vBRIEF v0.5 schema:

- `narratives` holds project identity: overview, tech stack, architecture, risks/unknowns, configuration
- `items` acts as a registry of project scopes across all lifecycle folders, each referencing its individual scope vBRIEF file via `references`
- `plan.status` represents overall project state (e.g. `running`, `draft`)

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "My Project",
    "status": "running",
    "narratives": {
      "Overview": "A CLI tool for ...",
      "TechStack": "Go 1.22, Python 3.11",
      "Risks": "No known blockers"
    },
    "items": [
      {
        "title": "Add OAuth flow",
        "status": "running",
        "references": [
          { "type": "x-vbrief/plan", "url": "./active/2026-04-12-add-oauth-flow.vbrief.json" }
        ]
      }
    ]
  }
}
```

**Regeneration**: Deterministic tooling updates the items registry from folder contents; agent-assisted layer reviews and proposes narrative updates with user approval.

- ! Singular — exactly one per project at `./vbrief/` root
- ~ Regenerated on scope completion and callable on demand

---

## plan.vbrief.json

The single active work plan. Unifies what were previously separate todo, plan, and progress files. When scope vBRIEFs are in use, plan.vbrief.json is the session-level tactical plan (the *how right now*) and carries a `planRef` to the scope vBRIEF(s) being implemented.

**Status lifecycle per task:** `pending` → `running` → `completed` / `blocked` / `cancelled`

- ! There is exactly ONE `plan.vbrief.json` at a time per project
- ! Use this wherever you would use a Warp `create_todo_list` — externalise to this file instead
- ! When scope vBRIEFs exist, MUST include `planRef` to the scope vBRIEF(s) being implemented
- ~ Update task statuses as work progresses
- ! Mark tasks `blocked` with a narrative explaining the blocker
- ~ Record blocked ideas with `blocked` status and a narrative explaining why
- ~ On completion, review for learnings worth persisting to [meta/lessons.md](../meta/lessons.md)

### Strategy Chaining Fields

When the [chaining gate](../strategies/interview.md#chaining-gate) is active, the plan
tracks which strategies have been run and what artifacts they produced.

- ? `completedStrategies` — array of objects tracking each strategy invocation:
  - ! `strategy` — strategy name (e.g. `"research"`, `"discuss"`, `"map"`)
  - ! `runCount` — number of times this strategy has been run in the current session
  - ! `artifacts` — array of file paths produced by this strategy
- ? `artifacts` — flat array of all artifact paths across all completed strategies.
  The next strategy and spec generation MUST load all listed artifacts.

**Example:**

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "Auth feature planning",
    "status": "running",
    "completedStrategies": [
      {
        "strategy": "research",
        "runCount": 1,
        "artifacts": ["docs/research/auth-research.md"]
      },
      {
        "strategy": "discuss",
        "runCount": 1,
        "artifacts": ["auth-context.md"]
      }
    ],
    "artifacts": [
      "docs/research/auth-research.md",
      "auth-context.md"
    ],
    "items": []
  }
}
```

- ~ Each preparatory strategy SHOULD append its artifact paths on completion
- ~ The chaining gate reads `completedStrategies` to display run count annotations

---

## continue.vbrief.json

A single interruption-recovery checkpoint. See [resilience/continue-here.md](../resilience/continue-here.md)
for full protocol. When scope vBRIEFs are in use, continue.vbrief.json carries a `planRef` to the scope vBRIEF(s) the agent was working on.

- ! Singular — `continue.vbrief.json`, not `continue-{ULID}.json`
- ! Ephemeral — consumed on resume; must be deleted (or marked `completed`) afterwards
- ! When scope vBRIEFs exist, MUST include `planRef` to the scope vBRIEF(s) being worked on
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
- ⊗ Moving scope vBRIEFs between lifecycle folders without updating `plan.status`
- ⊗ Using scope vBRIEFs as session scratchpads — use plan.vbrief.json for tactical session work
- ⊗ Creating scope vBRIEFs without origin provenance (`references` linking to the origin)
- ⊗ Omitting `planRef` from plan.vbrief.json or continue.vbrief.json when scope vBRIEFs exist
