# Test / source boundary (`verify:test-boundary`)

Refs: #3145 · Related: #1310 / #4009 forward-coverage, testing layout guidance

`verify:forward-coverage` reuses this policy for source-to-test correspondence. It does not add a second testRoots config.

## Problem

Directive accepted test harnesses, fixtures, and smoke orchestration under production-owned roots (`src/**`, `infra/**`, `Tools/**`, …) while gates stayed green. Placement guidance was prose-only.

## Contract

`task verify:test-boundary` / `deft verify:test-boundary` enforces a typed policy:

| Field | Meaning |
| --- | --- |
| `sourceRoots` | Production-owned path globs |
| `testRoots` | Allowed test roots |
| `fixtureRoots` | Fixture roots |
| `testFilePatterns` | Conventional test basenames (`test_*.py`, `*Tests.cs`, `*.test.ts`, `*.spec.ts`, …) |
| `productionMayReferenceTestRoots` | Default `false` — production must not reference test/fixture roots |
| `allow` | Narrow exceptions (`kind: exception` or `production-liveness`) |
| `enforcementMode` | `warn` (migration/discovery) or `enforce` |

## Policy sources (first wins)

1. `--policy <path>`
2. `.deft/test-boundary.policy.json`
3. `plan.policy.testBoundary` in `xbrief/PROJECT-DEFINITION.xbrief.json`
4. **Defaults** (conventional roots + patterns, `enforcementMode: warn`)

## Migration path

1. Run with defaults (warn-only): `task verify:test-boundary`
2. Review findings; move test artifacts under declared test roots or classify production liveness/canaries in `allow`
3. Persist reviewed policy under `.deft/test-boundary.policy.json` or `plan.policy.testBoundary` with `enforcementMode: "enforce"`
4. Wire stays green via `task check` / consumer deposit

## Production liveness carve-out

Health probes, canaries, and operational evidence collectors may live under production roots when listed in `allow` with `kind: "production-liveness"` and a recorded reason. Do not use the word “smoke” alone as classification.

## Co-located tests and `verify:class-checks` (#6668)

`verify:class-checks` is a fail-closed gate that reads this policy from the base ref. Two rules apply to tests that sit next to their source:

- **Class 1 exception.** A file whose name ends in `.test.<ext>` or `.spec.<ext>` (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `mts`, `cts`; any case), or in `_test.go`, is never a `test-under-source-root` finding. The file does not become a test root. Classes 2 to 4, the scope and write fences, and forward-coverage see the path as before. Class 2 skips the file as a test.
- **Class 2 import rule.** On an added line of a production file, a module specifier whose last segment is `<name>.test` or `<name>.spec` (with or without one of those extensions) is a `production-references-test-root` finding. This covers `import … from`, `export … from`, bare `import`, `import()` and `require()`.

Helpers, setup files and mocks whose names do not say test still fail class 1. Python and C# test names under a source root also still fail. To keep such a file in place, add a narrow `allow` entry with a reason to the base-ref policy: `.deft/test-boundary.policy.json` when that file exists, else `plan.policy.testBoundary`. An authored `testRoots` list replaces every default root, so repeat the defaults you still need. The policy is read from the base ref, so land the policy change in an earlier PR.

`verify:test-boundary` (warn by default) still reports co-located tests under source roots. This rule does not change its contract.

## Remediation

Failures name the path, violated boundary, and next step (move under test root, allow entry, or reclassify). See `content/contracts/test-boundary.md`.
