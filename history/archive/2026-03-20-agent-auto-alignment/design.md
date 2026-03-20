# Technical Design: agent-auto-alignment

## Approach

### Thin pointer file content

Each `.agents/skills/<name>/SKILL.md` has:
1. YAML frontmatter with `name` and `description` matching the real skill (required for Warp discovery)
2. A single redirect instruction in the body

**Deft repo versions (root-relative paths):**

`.agents/skills/deft/SKILL.md`:
```markdown
---
name: deft
description: Apply deft framework standards for AI-assisted development. Use when starting projects, writing code, running tests, making commits, or when the user references deft, project standards, or coding guidelines.
---

Read and follow: SKILL.md
```

`.agents/skills/deft-setup/SKILL.md`:
```markdown
---
name: deft-setup
description: >-
  Set up a new project with Deft framework standards. Use when the user wants
  to bootstrap user preferences, configure a project, or generate a project
  specification. Walks through setup conversationally — no separate CLI needed.
---

Read and follow: skills/deft-setup/SKILL.md
```

`.agents/skills/deft-build/SKILL.md`:
```markdown
---
name: deft-build
description: >-
  Build a project from a SPECIFICATION.md following Deft framework standards.
  Use after deft-setup has generated the spec, or when the user has a
  SPECIFICATION.md ready to implement. Handles scaffolding, implementation,
  testing, and quality checks phase by phase.
---

Read and follow: skills/deft-build/SKILL.md
```

**Installer-generated versions (deft/-prefixed paths, for user projects):**
Same structure but paths become `deft/SKILL.md`, `deft/skills/deft-setup/SKILL.md`, `deft/skills/deft-build/SKILL.md`.

### `WriteAgentsSkills` function in `setup.go`

```go
func WriteAgentsSkills(w *Wizard, projectDir string) error
```

- Creates `.agents/skills/deft/`, `deft-setup/`, `deft-build/` under projectDir
- Writes thin pointer SKILL.md to each with `deft/`-prefixed paths
- Idempotent: if `.agents/skills/deft/SKILL.md` already exists, skips with a log message
- Returns error only on filesystem failures

### `agentsMDEntry` update

Remove the Skills line and its Go comment. Verify "deft/main.md" still appears in content (sentinel check).

New content ends with:
```
...
- deft/run bootstrap         — CLI setup (terminal users)
- deft/run spec              — CLI spec generation
```
(No Skills line.)

### `PrintNextSteps` update

Replace step 2 from "Tell your agent: read AGENTS.md and follow it" with something like:
"Open your AI coding assistant — deft skills are auto-discovered and will guide setup automatically"

And remove the note about agents not reading AGENTS.md automatically — that's no longer true once `.agents/skills/` is in place.

### `main.md` rule placement

Add to the Decision Making block in Agent Behavior:
```
! Before implementing any planned change that touches 3+ files or has an accepted plan artifact, propose /deft:change <name> and wait for confirmation
```

## Alternatives Considered

**Symlinks instead of thin pointers** — rejected. Requires Developer Mode or elevation on Windows. Thin pointers achieve the same result with zero platform dependencies.

**File copies instead of thin pointers** — rejected. Copies rot on deft updates. Thin pointers always redirect to current content.

**Single `.agents/skills/deft/SKILL.md` pointing to all three skills** — rejected. Warp skill discovery is per-subdirectory; each skill needs its own subdirectory to be independently invokable.

## Dependencies

- SKILL.md frontmatter `description` values must be sourced from the actual skill files
- `agentsMDSentinel = "deft/main.md"` must still appear in `agentsMDEntry` after removing Skills line (it does — it appears in "Full guidelines: deft/main.md")
