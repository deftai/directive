# Taskfile Guidelines

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../../main.md) | [taskfile-migration.md](./taskfile-migration.md)

**Scope:** Task-based build automation using [Task](https://taskfile.dev/) instead of Makefiles or shell scripts.

## Task-Centric Workflow

- ! Use `task` for repeatable operations
- ! Add tasks instead of standalone shell scripts
- ! Define default task: `task --list`
- ⊗ Manual shell scripts for repeatable workflows

## Core Principles

**Entrypoint:**
- ! Task as single entry for common flows: `task dev`, `task test`, `task build`, `task release`
- ~ Avoid documenting raw commands in README beyond "install Task, then run X"

**Composability:**
- ~ Keep tasks small and declarative
- ~ Move logic to scripts/binaries, Task orchestrates
- ⊗ Embed complex shell logic in `cmds`

**Structure:**
- ! Default task shows available tasks (`task --list`)
- ~ Split large setups: `Taskfile.dev.yml`, `Taskfile.ci.yml`, `Taskfile.tools.yml`
- ~ Include from root `Taskfile.yml` for readability

## Naming Conventions

**Single-language projects:**
- ! Use generic names: `fmt`, `lint`, `test`, `build`
- ! Use clear verbs: `generate`, `deploy`, `publish`, `clean`

**Multi-language projects:**
- ! Use namespaced names: `py:fmt`, `go:fmt`, `cpp:fmt`, `ts:fmt`
- ! Provide generic aliases delegating to all languages:
```yaml
fmt:
  deps: [py:fmt, go:fmt]
lint:
  deps: [py:lint, go:lint]
```

**Task namespaces:**
- ! Group related tasks: `docker:build`, `docker:push`, `db:migrate`, `db:seed`, `app:run`

## Dependencies, Caching, Performance

**Dependencies:**
- ~ Use `deps` for task ordering/reuse
- ⊗ Manually sequence tasks in `cmds`

**Caching:**
- ~ Configure `sources`/`generates` + `method: checksum`
- ~ Incremental builds like Make-style
- ~ Only re-run when inputs change

**Idempotency:**
- ~ Use `status` or `preconditions` for idempotent setup
- ~ Skip heavy steps if already completed (e.g. "tool installed", "DB running")

## Robustness & Safety

**Shell options:**
- ! Set `set: [errexit, nounset, pipefail]` on tasks
- Exits on errors, undefined vars, pipe failures

**Validation:**
- ~ Use `requires: vars: [VAR]` to fail early
- Example: `requires: vars: [AWS_PROFILE, VERSION]`
- ⊗ Let scripts misbehave with missing vars

**Cleanup:**
- ~ Use `defer` for cleanup (temp files, background processes)
- ~ Cleanup runs even on task failure

## UX for Teams & CI

**Documentation:**
- ! Add `desc` for every user-facing task
- ! `task --list` must be self-documenting CLI
- ~ Mark internal tasks as `internal: true`
- ⊗ Expose internal wiring tasks to users

**Variables & Templates:**
- ~ Use `vars`, `env`, `{{.CLI_ARGS}}`, `{{.USER_WORKING_DIR}}`
- ~ Support monorepos/multi-service setups cleanly
- ~ Avoid duplicating similar tasks

**Artifacts:**
- ~ Keep local/ephemeral artifacts in temp dir
- ~ Use `TASK_TEMP_DIR` for generated caches/checksums
- ~ Ignore in VCS or commit for reproducible codegen

## Common Task Commands

```bash
task fmt                # Format code
task lint               # Lint code
task test               # Run tests
task test:coverage      # Run tests with coverage (! ≥85%)
task quality            # All quality checks
task check              # Pre-commit (! run: fmt+lint+type+test)
task build              # Build project
```

## Example Taskfile Structure

```yaml
version: '3'

set: [errexit, nounset, pipefail]

tasks:
  default:
    desc: List all tasks
    cmds:
      - task --list
    silent: true

  fmt:
    desc: Format code
    sources:
      - '**/*.py'
    cmds:
      - ruff format .

  lint:
    desc: Lint code
    sources:
      - '**/*.py'
    cmds:
      - ruff check .

  test:
    desc: Run tests
    deps: [fmt, lint]
    cmds:
      - pytest

  build:
    desc: Build project
    deps: [test]
    sources:
      - 'src/**/*.py'
    generates:
      - 'dist/*'
    cmds:
      - python -m build

  clean:
    desc: Clean build artifacts
    cmds:
      - rm -rf dist/ build/ *.egg-info
```

## Best Practices

- ! Always include default task
- ! Use RFC 2119 keywords in task descriptions
- ~ Keep tasks <20 lines; extract scripts if larger
- ~ Use `dotenv` for environment files
- ~ Prefer `cmd` over `sh` for simple commands
- ⊗ Hardcode paths; use templates
- ⊗ Silent failures; add error handling

## Anti-Patterns

- ⊗ Shell scripts for repeatable tasks → use Task
- ⊗ Complex shell in `cmds` → extract to scripts
- ⊗ Undocumented tasks → add `desc`
- ⊗ Ignoring `deps` → use for ordering
- ⊗ No caching config → add `sources`/`generates`
- ⊗ Exposing internal tasks → mark `internal: true`

## References

- Docs: https://taskfile.dev/
- Styleguide: https://taskfile.dev/docs/styleguide
- Installation: https://taskfile.dev/installation/
- Migration: [taskfile-migration.md](./taskfile-migration.md)
