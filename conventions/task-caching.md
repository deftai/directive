# Task Caching Convention

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [main.md](../main.md) | [tasks/prd.yml](../tasks/prd.yml) | [tasks/scope.yml](../tasks/scope.yml) | [tests/content/test_taskfile_caching.py](../tests/content/test_taskfile_caching.py)

## Invariant

! Tasks in `deft/tasks/*.yml` that accept `{{.CLI_ARGS}}` containing user-facing recovery flags (any `--force`-like flag, or anything the script's error messages tell operators to pass) **MUST NOT** declare `sources:` or `generates:` keys.

⊗ Declaring `sources:` / `generates:` on a task that forwards `{{.CLI_ARGS}}` to a Python script.

## Why

When both `sources:` and `generates:` are declared and every `generates` file exists with an unchanged `sources` hash, go-task short-circuits and skips `cmds:` entirely. `CLI_ARGS` are never relayed because the command is never invoked. The script-level recovery flag therefore never reaches the script, and the operator hits a silent `"task: Task \"<name>\" is up to date"` exit 0 while following deft's own documented recovery instruction.

This is what broke `task prd:render -- --force` for every migrating consumer with a pre-existing `PRD.md` on `phase2/vbrief-cutover`: the `#539` refuse-to-overwrite safety check instructs operators to "Re-run with --force to overwrite", but the `prd:render` task short-circuited at the go-task cache layer before `cmds:` ran, so `prd_render.py` never saw `--force` (#574).

## Scope

The invariant applies specifically to tasks whose **command line forwards `{{.CLI_ARGS}}` to a dispatched Python script** (`uv run python ... {{.CLI_ARGS}}`). These tasks are the recovery-flag carriers and are the ones whose semantics break when go-task short-circuits.

Tasks that do not forward `{{.CLI_ARGS}}` (e.g. pure file-copy / archive-extraction pipelines like `deployments:cloudgov:export`) are **not** subject to this invariant -- their caching behavior is correct because they do not carry user-recovery semantics.

## Exception discipline

~ When a task is genuinely cache-worthy (e.g. an expensive compile, a large archive extraction) AND does NOT accept `CLI_ARGS` recovery flags, `sources:` / `generates:` MAY be declared. In that case:

1. ! Document the justification in an inline comment at the task declaration explaining why caching is safe for this task.
2. ! Append an entry to this file (under an "Exceptions" subsection) documenting the task and the justification so future contributors can audit cache-declarations centrally.

The pattern for the current single exception in `tasks/deployments.yml` (`cloudgov:sync`, `cloudgov:export`) is: neither task forwards `CLI_ARGS`; both operate over a fixed upstream pin and a fixed set of instruction files, so the cache correctly represents the task's output.

## Guard-rail

The invariant is enforced by `tests/content/test_taskfile_caching.py`, parametrized over every `deft/tasks/*.yml`. For each task that (a) invokes a Python script via `uv run python` AND (b) forwards `{{.CLI_ARGS}}` to that script, the test asserts the task declaration does NOT contain `sources:` or `generates:` keys. The failure message points contributors back at this file.

## Cross-references

- #539 -- refuse-to-overwrite safety feature whose `--force` recovery instruction lives in PRD/spec render scripts
- #573 -- broader ergonomics discussion about double-`--force` layering (deferred post-GA)
- #574 -- this rule's immediate motivating fix (drop caching from `tasks/prd.yml`)
- #566 / #568 -- sibling Windows-dispatch guard-rail pattern (`tests/content/test_taskfile_paths.py`) this rule's test module mirrors
