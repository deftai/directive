# Taskfile Migration Guide

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [taskfile.md](./taskfile.md) | [main.md](../main.md)

## When to Migrate

- ~ Migrate from Makefiles or shell scripts when the project adopts Deft
- ~ Migrate when build automation becomes complex enough to benefit from Task's dependency resolution and caching
- ? Skip migration for trivial scripts that are rarely changed

## Migration Steps

1. **Audit** -- List all existing build/test/deploy commands (Makefile targets, npm scripts, shell scripts)
2. **Map** -- Map each command to a Task equivalent using [taskfile.md](./taskfile.md) naming conventions
3. **Create** -- Write `Taskfile.yml` with mapped tasks; use `deps` for ordering, `sources`/`generates` for caching
4. **Verify** -- Run each task and compare output to the original command
5. **Remove** -- Delete or archive the old Makefile/scripts once all tasks are verified

## Common Migrations

- `make build` -> `task build`
- `npm run test` -> `task test`
- `./scripts/deploy.sh` -> `task deploy`
- `make lint && make test` -> `task check` (with deps: [lint, test])

## Anti-Patterns

- ⊗ Migrating and keeping the old system active (causes confusion about which to use)
- ⊗ Translating complex shell logic directly into Task `cmds` -- extract to scripts instead
- ≉ Migrating all scripts at once without verifying each individually
