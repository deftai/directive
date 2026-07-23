# In-engine content-hash task cache (#1713)

Legend (from RFC2119): !=MUST, ~=SHOULD, ⊗=MUST NOT.

**See also**: [Issue #1713](https://github.com/deftai/directive/issues/1713) | [Issue #1704](https://github.com/deftai/directive/issues/1704) (process face) | [Issue #2784](https://github.com/deftai/directive/issues/2784) (public types follow-up)

## Overview

`deft check` can skip unchanged cacheable gates by replaying prior exit-0 results from a local content-hash cache. The cache ships inside the CLI — zero extra install for consumers — and directive dogfoods the same layer for its own gate stack.

Cache entries live under `.deft/cache/task/` (gitignored, local-only).

## Correctness guards

- ! Cache only passes (exit `0`). Failures always re-run.
- ! `codeVersion` (installed directive version) is part of every cache key.
- ! Volatile gates opt out via `cacheable: false` on the internal registry.
- ! Fail open to running when inputs cannot be enumerated — never fail open to passing.
- Escape hatches: `deft check --no-cache`, `deft cache:clear`.

## Runner affected-test delegation

Affected-test **selection** stays with the consumer test runner. Directive detects the runner and documents the fast-lane convention; the merge gate still runs the full suite (#1704).

| Runner | Detection | Fast-lane convention |
| --- | --- | --- |
| vitest | `package.json` lists `vitest`, or `plan.policy.testRunner = vitest` | `vitest --changed` |
| jest | `package.json` lists `jest` / `@jest/core`, or policy override | `jest --onlyChanged` |
| go | `go.mod` present, or policy override | `go test` (native package cache) |
| pytest | `pytest.ini` / `pyproject.toml` / `requirements.txt`, or policy override | `pytest --testmon` |
| none | No match after config + heuristics | Full suite at merge gate |

Override: set `plan.policy.testRunner` in `PROJECT-DEFINITION.xbrief.json` to `vitest`, `jest`, `go`, `pytest`, or `none`.

## Internal registry (v1)

Gate contracts (`inputs`, `outputs`, `cacheable`, `codeVersion`) are **internal** to `@deftai/directive-core` until #2784 promotes a public `@deft/types` shape. Under-declaration lint runs over known read sets; incomplete enumeration disables caching for that task.
