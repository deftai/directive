# Contract: test-boundary (#3145)

## Normative requirements

- ! `verify:test-boundary` MUST reject recognized test files under declared `sourceRoots` when they are not under `testRoots` and not allowlisted.
- ! Recognized patterns MUST include at least: Python `test_*.py` / `*_test.py`, C# `*Tests.cs` / `*Test.cs`, TypeScript/JavaScript `*.test.*` / `*.spec.*`, Go `*_test.go`.
- ! When `productionMayReferenceTestRoots` is false, production source and deployment/infra scripts MUST NOT reference `testRoots` or `fixtureRoots` path prefixes.
- ! Allow entries MUST support `kind: exception` and `kind: production-liveness` with recorded reason.
- ! Failures MUST identify path, violated boundary, and remediation.
- ! Defaults without authored policy MUST use warn-only discovery (`enforcementMode: warn`) for migration.
- ⊗ Infer safety solely because a path was listed in an active xBRIEF.

## Surfaces

- Core: `packages/core/src/test-boundary/`
- CLI: `deft verify:test-boundary` / `task verify:test-boundary`
- Policy: `.deft/test-boundary.policy.json` or `plan.policy.testBoundary`
- Docs: `content/docs/test-boundary.md`
