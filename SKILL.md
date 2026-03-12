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

! When this skill activates, check for USER.md at the platform-appropriate path
(Windows: `%APPDATA%\deft\USER.md`, Unix: `~/.config/deft/USER.md`, or `$DEFT_USER_PATH`).

**If USER.md is missing**: Skip everything else in this file. Ask this question immediately
as your FIRST and ONLY response — no summary, no menu, no preamble:

> Deft has solid opinions on how code should be written and tested — I just need
> a few things about you and your project. First, how deep do you want to go?
>
> 1. **I'm technical — ask me everything**
> 2. **I have some opinions but keep it simple**
> 3. **Just pick good defaults — I care about the product, not the tools**

Then continue with `skills/deft-setup/SKILL.md` Phase 1 for remaining questions.

**If USER.md exists but PROJECT.md is missing**: Skip to `skills/deft-setup/SKILL.md` Phase 2.

- ⊗ Present a menu of options or summarize the framework when config is missing
- ⊗ Ask "what would you like to do" — the answer is always: start the setup interview

## Core Principle: Rule Precedence

Deft uses hierarchical rules where more specific overrides general.
USER.md has two sections with different precedence:

```
USER.md Personal  ← HIGHEST (name, custom rules — always wins)
  ↓
PROJECT.md        ← Project-specific (strategy, coverage, languages, tech stack)
  ↓
USER.md Defaults   ← Fallback defaults (used when PROJECT.md doesn't specify)
  ↓
{language}.md      ← Language standards (python.md, go.md, typescript.md, cpp.md)
  ↓
{tool}.md          ← Tool guidelines (taskfile.md, git.md)
  ↓
main.md            ← General AI behavior
  ↓
specification.md   ← LOWEST precedence (requirements)
```

**IMPORTANT**: USER.md `Personal` section always wins. For project-scoped settings
(strategy, coverage, languages), PROJECT.md overrides USER.md `Defaults`.

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
2. **User.md Personal is king** - Personal section always wins; Defaults are fallback
3. **Task-centric** - Use `task` for everything
4. **Test first** - Write tests before implementation
5. **Always check** - Run `task check` before commits
6. **Conventional commits** - Follow the standard
7. **Coverage matters** - ≥85% by default
8. **Never lie** - Don't claim checks passed without running them

---

For more details, read the specific files in `./deft/` as needed. Start with `main.md` and follow the precedence hierarchy.
