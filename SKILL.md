---
name: deft
description: Apply deft framework standards for AI-assisted development. Use when starting projects, writing code, running tests, making commits, or when the user references deft, project standards, or coding guidelines.
user-invocable: false
metadata:
  clawdbot:
    requires:
      bins: ["task"]
    homepage: "https://github.com/visionik/deft"
os: ["darwin", "linux"]
---

# Deft Framework

A layered framework for AI-assisted development with consistent standards and workflows.

## When This Skill Activates

This skill automatically loads when you:
- Start work in a deft-enabled project (has `./deft/` directory)
- Reference deft, project standards, or coding conventions
- Run tests, make commits, or perform quality checks
- Ask about project structure, workflows, or best practices

## Missing Config Auto-Setup

- ! If USER.md or PROJECT.md is missing when this skill activates: read and invoke the `deft-setup` skill (`skills/deft-setup/SKILL.md`) and begin Phase 1 immediately
- ⊗ Present a menu of options, summarize the framework, or ask what the user wants to do — start the setup interview directly
- ~ If only PROJECT.md is missing (USER.md exists), skip to Phase 2

## Core Principle: Rule Precedence

Deft uses hierarchical rules where more specific overrides general:

```
user.md          ← HIGHEST precedence (personal preferences)
  ↓
project.md       ← Project-specific rules
  ↓
{language}.md    ← Language standards (python.md, go.md, typescript.md, cpp.md)
  ↓
{tool}.md        ← Tool guidelines (taskfile.md, git.md)
  ↓
main.md          ← General AI behavior
  ↓
specification.md ← LOWEST precedence (requirements)
```

**IMPORTANT**: If `user.md` says one thing and `python.md` says another, `user.md` ALWAYS wins.

## File Reading Strategy (Lazy Loading)

**DO NOT** read all deft files at once. Read only what you need:

1. **Always start with**: `./deft/main.md` (general guidelines)
2. **Check for**: `./deft/core/user.md` (personal overrides - highest precedence)
3. **Check for**: `./deft/core/project.md` (project-specific rules)
4. **Then read language-specific** only if working with that language:
   - `./deft/languages/python.md`
   - `./deft/languages/go.md`
   - `./deft/languages/typescript.md`
   - `./deft/languages/cpp.md`
5. **Read tool files** only when using that tool:
   - `./deft/tools/taskfile.md` (when running tasks)
   - `./deft/scm/git.md` (when using git)
   - `./deft/scm/github.md` (when using GitHub)

## Task-Centric Workflow

Deft projects use **Taskfile** as the universal task runner.

```bash
task --list        # See all available tasks
task check         # CRITICAL: Run before EVERY commit
```

See `./deft/tools/taskfile.md` for complete task standards and common commands.

## Development Methodology

**Test-Driven Development (TDD)**:
1. Write test first → Watch it fail → Implement → Refactor → Repeat
2. Default: ≥85% coverage (check `project.md` for overrides)
3. Implementation is INCOMPLETE until tests pass

**Spec-Driven Development (SDD)** for new features/projects:
1. Run `deft/run spec` to generate PRD.md via AI interview
2. Review PRD.md → Generate SPECIFICATION.md → Review → Implement

See `./deft/coding/testing.md` for complete testing standards.

## Quality Standards

**Before Every Commit**:
```bash
task check  # MUST run: fmt, lint, type check, test, coverage
```

**Conventional Commits**: Use https://www.conventionalcommits.org/en/v1.0.0/ format
**File Naming**: Use hyphens (e.g., `user-service.py`), not underscores
**Secrets**: Store in `secrets/` directory with `.example` templates

See `./deft/coding/coding.md` and `./deft/scm/git.md` for complete standards.

## Language-Specific Standards

All languages require ≥85% test coverage. See language-specific files:
- `./deft/languages/python.md`
- `./deft/languages/go.md`
- `./deft/languages/typescript.md`
- `./deft/languages/cpp.md`

## New Project Setup

**Initialize new project**:
```bash
deft/run init       # Create deft structure
deft/run bootstrap  # User config (first time only)
deft/run project    # Project config
deft/run spec       # Generate PRD + SPECIFICATION (optional)
```

**Work with existing deft project**:
1. **First time?** If `./deft/core/user.md` doesn't exist, run `deft/run bootstrap`
2. Read `./deft/main.md` (general guidelines)
3. Read `./deft/core/user.md` (personal preferences - highest precedence)
4. Read `./deft/core/project.md` (project rules)
5. Run `task --list` to see available tasks

See `./deft/main.md` for complete workflow details.

## Self-Improvement

Deft learns and evolves via `meta/` directory:
- `lessons.md` - Patterns learned (AI can update)
- `ideas.md` - Future improvements
- `suggestions.md` - Project-specific suggestions

## Platform Integration

This SKILL.md follows the **AgentSkills specification**, compatible with:
- **Claude Code**: `~/.claude/skills/deft/` or `.claude/skills/deft/`
- **clawd.bot**: `~/.clawdbot/skills/deft/` or install via `clawdhub sync deft`
- **Warp AI**: Upload to Warp Drive, reference in `WARP.md`/`AGENTS.md`

See `./deft/docs/claude-code-integration.md` for integration details.

## Quick Reference

| Task | Command |
|------|---------|
| List tasks | `task` or `task --list` |
| Pre-commit checks | `task check` |
| Run tests | `task test` |
| Check coverage | `task test:coverage` |
| Format code | `task fmt` |
| Lint code | `task lint` |
| Initialize deft | `deft/run init` |
| Configure user | `deft/run bootstrap` |
| Configure project | `deft/run project` |
| Generate spec | `deft/run spec` |

## Remember

1. **Lazy load files** - Only read what you need
2. **User.md is king** - Highest precedence always
3. **Task-centric** - Use `task` for everything
4. **Test first** - Write tests before implementation
5. **Always check** - Run `task check` before commits
6. **Conventional commits** - Follow the standard
7. **Coverage matters** - ≥85% by default
8. **Never lie** - Don't claim checks passed without running them

---

For more details, read the specific files in `./deft/` as needed. Start with `main.md` and follow the precedence hierarchy.
