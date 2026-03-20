# Deft — Development Framework (deft repo)

You are working inside the deft framework repository itself.
Full guidelines: main.md

## First Session (deft development)

Check what exists before doing anything else:

**USER.md missing** (~/.config/deft/USER.md or %APPDATA%\deft\USER.md):
→ Read skills/deft-setup/SKILL.md and start Phase 1 (user preferences)

**USER.md exists, PROJECT.md missing** (repo root):
→ Read skills/deft-setup/SKILL.md and start Phase 2 (project configuration)

**USER.md and PROJECT.md exist, SPECIFICATION.md missing** (repo root):
→ Read skills/deft-setup/SKILL.md and start Phase 3 (specification interview)

## Returning Sessions

When all config exists: read the guidelines, your USER.md preferences, and PROJECT.md, then continue with your task.

## Commands

- /deft:change <name>        — Propose a scoped change
- /deft:run:interview        — Structured spec interview
- /deft:run:speckit          — Five-phase spec workflow (large projects)
- /deft:run:discuss <topic>  — Feynman-style alignment
- /deft:run:research <topic> — Research before planning
- /deft:run:map              — Map an existing codebase
- run bootstrap              — CLI setup (terminal users)
- run spec                   — CLI spec generation

Note: paths here are root-relative — this repo IS the deft directory.
Install-generated AGENTS.md uses deft/-prefixed paths.

Skills: SKILL.md, skills/deft-setup/SKILL.md, skills/deft-build/SKILL.md
