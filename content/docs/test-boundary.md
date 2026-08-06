# Test / source boundary (`verify:test-boundary`)

Refs: #3145 · Related: #1310 forward-coverage, testing layout guidance

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

## Remediation

Failures name the path, violated boundary, and next step (move under test root, allow entry, or reclassify). See `content/contracts/test-boundary.md`.
