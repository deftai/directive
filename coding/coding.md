# Coding Guidelines

Software development specific guidelines for AI agents.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also** (load only when needed):
- [../main.md](../main.md) - General AI behavior and agent persona
- [PROJECT.md](../PROJECT.md) - For project-specific overrides
- [../tools/telemetry.md](../tools/telemetry.md) - When implementing logging/tracing/metrics

## Code Organization

**Documentation:**
- ! All *.md in `docs/` directory (except README.md, AGENTS.md, WARP.md)
- ! Prior tasks/plans in `history/`

**Filenames:**
- ~ Use hyphens not underscores (unless language idiom)

**Secrets:**
- ! ALL secrets in `secrets/` dir as .env files
- ⊗ Secrets in code

## Code Search

- ! use `rg`, or `ast-grep` (when available) instead of grep
- ! Use Warp's built-in grep (which is rg) when running on warp
- ~ Install if missing
- ? Fall back to `grep` command only if tools cannot be installed

## Version Control

See [../scm/git.md](../scm/git.md) for:
- Commit conventions (Conventional Commits)
- Safety rules (no force-push without permission)
- Branch workflows

## Code Design

**Modularity:**
- ! One responsibility per file/module
- ~ Files <300 lines ideal; files <500 lines recommended; ! files <1000 lines maximum
- ! Explicit scope in task descriptions

**Contract-First:**
- ! Define interfaces/types/protocols before implementation
- ! Changes to public interfaces require explicit versioning or deprecation path
- ! Document all public API contracts clearly

**Immutability:**
- ~ Prefer immutable data + pure functions
- ~ When mutation needed, use narrow owned scopes (context managers, RAII)
- ⊗ Global or singleton mutable state (almost always)

**Error Handling:**
- ~ Prefer Result/Option types or explicit exceptions over None/null/undefined
- ! Document possible exceptions/error codes for all public functions
- ! Validate all inputs at API boundaries
- ⊗ Trust caller without validation

**Readability:**
- ! Follow language idioms strictly
- ! Meaningful names over short names
- ! Comments explain **why**, code shows **what**
- ⊗ Clever code over clear code

## Quality Standards

**General:**
- ! Run all relevant checks (lint, fmt, quality, build, test) before submitting changes
- ⊗ Claim checks passed without running them
- ! If checks cannot run, explicitly state why and what would have been executed
- ~ Prioritize code quality and readability over backwards compatibility

**Testing:**
- ! Implementation is INCOMPLETE until tests written AND `task test:coverage` passes
- See [../coding/testing.md](../coding/testing.md) for universal requirements

**Telemetry:**
- See [../tools/telemetry.md](../tools/telemetry.md) for recommendations
- ~ Structured logging for production
- ~ Error tracking (Sentry.io or equivalent)
- ? Distributed tracing for complex systems

## Build Automation

**Taskfile:**
- ! Use Task ([go-task](https://taskfile.dev)) for all repeatable operations
- ! If `task` not found, attempt to install go-task
- ! If installation fails, stop and ask user for help
- See [../tools/taskfile.md](../tools/taskfile.md) for standards and common commands

**Toolchain Validation:**
- See [../coding/toolchain.md](../coding/toolchain.md) for rules on verifying required tools are installed before implementation begins

**Build Output Validation:**
- See [../coding/build-output.md](../coding/build-output.md) for rules on verifying `dist/` artifacts and non-compiled assets after custom build scripts run

## Change Management

**Impact Awareness:**
- ! Before changing shared code, identify affected downstream modules/files
- ~ Prefer additive changes (new functions, fields with defaults) over breaking renames
- ! Make small, reversible changes
- ! Explain impact and migration path for breaking changes

**Production Safety:**
- ! Assume production impact unless stated otherwise
- ! Call out risk when touching: auth, billing, data, APIs, build systems
- ⊗ Silent breaking behavior
- ~ Test changes in staging/dev environment when possible

## Language-Specific Guidelines

**Languages:**
- C++: [../languages/cpp.md](../languages/cpp.md)
- Go: [../languages/go.md](../languages/go.md)
- Python: [../languages/python.md](../languages/python.md)
- TypeScript: [../languages/typescript.md](../languages/typescript.md)

**Interface Types:**
- CLI: [../interfaces/cli.md](../interfaces/cli.md)
- TUI: [../interfaces/tui.md](../interfaces/tui.md)
- Web: [../interfaces/web.md](../interfaces/web.md)
- REST API: [../interfaces/rest.md](../interfaces/rest.md)

## Development Workflow

**Localhost:**
- No permission needed for curl localhost

**Plans:**
- ~ Create both:
  1. Warp plan (using `create_plan` tool)
  2. Archive copy in `history/plan-YYYY-MM-DD-description.md`

## Project Context

- ! Check [PROJECT.md](../PROJECT.md) for project-specific overrides
- ~ Inspect project config (package.json, pyproject.toml, etc.) for available scripts
- ! Follow project-specific testing, coverage, and quality requirements

## Anti-Patterns

- ⊗ Secrets in code or version control
- ⊗ Claiming checks passed without running them
- ⊗ Files over 1000 lines
- ⊗ Skipping quality checks
- ⊗ Breaking changes without explicit approval
- ⊗ Using `grep` command when `rg` or Warp grep available
- ⊗ Implementing code without tests
- ⊗ Claiming "done" before running test:coverage
- ⊗ Ignoring coverage drops
