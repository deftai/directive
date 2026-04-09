---
name: deft
description: Apply deft framework standards for AI-assisted development. Use when starting projects, writing code, running tests, making commits, or when the user references deft, project standards, or coding guidelines.
user-invocable: false
metadata:
  clawdbot:
    requires:
      bins: ["task"]
    homepage: "https://github.com/deftai/directive"
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

**If USER.md exists but PROJECT.md is missing at the project root**: Skip to
`skills/deft-setup/SKILL.md` Phase 2.

**If USER.md and PROJECT.md both exist but no SPECIFICATION.md at the project root**:
Skip to `skills/deft-setup/SKILL.md` Phase 3. Start the specification interview
immediately — ask what to build and features as the first question.

### ⊗ Project Root vs Framework Internals

! When checking for project-level files (`PROJECT.md`, `SPECIFICATION.md`, `PRD.md`,
`specs/`), ONLY look at the **project root** and its direct subdirectories.

- ! `./PROJECT.md` — the user's project config (project root)
- ! `./SPECIFICATION.md` or `./specs/*/SPECIFICATION.md` — the user's project spec
- ⊗ Count ANY file inside `./deft/` as a project-level artifact — those are
  framework-internal (e.g. `deft/PROJECT.md`, `deft/specs/`, `deft/templates/`
  are all part of the framework, NOT the user's project)

- ⊗ Present a summary of the config and ask what the user wants to do
- ⊗ Ask "what would you like to do" or "what are we building" — start the interview directly
- ⊗ Show menus, recaps, or workflow overviews before starting the next missing phase

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
2. **Check for**: `~/.config/deft/USER.md` (personal overrides - highest precedence)
3. **Check for**: `./PROJECT.md` (project-specific rules)
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
1. Run `deft/run spec` — sizing gate selects Light or Full path
2. Light: Interview → SPECIFICATION.md (embedded requirements) → Implement
3. Full: Interview → PRD.md (approval gate) → SPECIFICATION.md → Implement

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
deft/run spec       # Sizing gate → Light (INTERVIEW.md) or Full (PRD.md) → SPECIFICATION
```

**Work with existing deft project**:
1. **First time?** If `~/.config/deft/USER.md` doesn't exist, run `deft/run bootstrap`
2. Read `./deft/main.md` (general guidelines)
3. Read `~/.config/deft/USER.md` (personal preferences - highest precedence)
4. Read `./PROJECT.md` (project rules)
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
