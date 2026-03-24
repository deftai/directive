# Testing Standards

Universal testing requirements across all languages and interfaces.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Universal Requirements

- ! Achieve ≥85% coverage (overall + per-module/package/file)
- ! Include ≥50 fuzzing tests per input point
- ~ Have integration tests for critical paths/workflows
- ! Exclude entry points and main functions from coverage
- ! Test all code paths: normal, edge cases, error conditions
- ! Run `task check` (or equivalent) before commit
- ⊗ say a (todo-list|plan|phase|project) is done if relevant tests have not been written, run, and PASSED.
- ⊗ assume its ok for a test to fail in any situation

## Test-First Development

- ! Implementation is INCOMPLETE until tests written AND `task test:coverage` passes
- ! New functions/classes MUST have corresponding tests in same commit
- ! Modified functions MUST update existing tests to maintain coverage
- ! Run `task test:coverage` after ANY code change to verify ≥85% maintained
- ! If coverage drops below threshold, implementation is INCOMPLETE
- ~ Write tests for edge cases, not just happy paths
- ⊗ Skip test updates when modifying existing functions
- ⊗ Implement code without tests
- ⊗ Claim "done" before running test:coverage

## Coverage

**What to count:**

- ! All source code in src/, internal/, pkg/, lib/

**What to exclude:**

- ! Entry points: main(), **main**, index.ts (if trivial)
- ! Generated code
- ! Third-party code
- ! Test files themselves

**Thresholds:**

- ! ≥85% lines
- ! ≥85% functions/methods
- ! ≥85% branches
- ! ≥85% statements

## Test Types

### Unit Tests

- ! Individual functions/methods/components
- ! Normal cases + edge cases + error conditions
- ! Fast execution (milliseconds)
- ! No external dependencies (use mocks/stubs)

### Integration Tests

- ~ Full workflows with real dependencies
- ~ Realistic scenarios
- ~ Database, API, file system interactions
- ~ Slower execution acceptable

### Fuzzing Tests

- ! ≥50 fuzzing tests per input point
- ! Random/malformed inputs
- ! Catch unexpected crashes, hangs, exceptions

### Load/Performance Tests

- ~ For performance-critical code
- ~ Measure response times under load
- Tools: JMeter, Gatling, k6, Apache Bench

### Security Tests

- ! For code handling untrusted input
- ! SQL injection, XSS, auth bypass, path traversal
- Tools: OWASP ZAP, Burp Suite, SQLMap

### Snapshot Tests

- ~ For CLI output, rendered UI, generated files
- ~ Detect unintended output changes

### Build Output Tests

- ~ Build scripts that produce `dist/` artifacts have a smoke test verifying expected output files exist and contain expected content
- ! Non-compiled assets (manifests, configs, extension metadata) that bundlers don't track are explicitly verified post-build
- ~ Verify file presence, non-empty size, and structural validity (e.g. required JSON keys present)
- ! A build that exits 0 but produces stale or incomplete artifacts is a silent failure — treat it as a build failure (#105)

## Language-Specific Details

**Python**: [python.md](./python.md#testing) - pytest, pytest-cov, pytest-mock
**Go**: [go.md](./go.md#testing) - Testify, table-driven tests
**C++**: [cpp.md](./cpp.md#testing) - Catch2/GoogleTest, GoogleMock
**TypeScript**: [typescript.md](./typescript.md#testing) - Vitest/Jest, React Testing Library
**CLI**: [cli.md](./cli.md#testing) - CliRunner, format validation
**REST APIs**: [rest.md](./rest.md#testing) - endpoint testing, security testing

## Test Organization

**File naming:**

- Python: `test_*.py` or `*_test.py`
- Go: `*_test.go`
- C++: `test_*.cpp` or `*_test.cpp`
- TypeScript: `*.spec.ts` or `*.test.ts`

**Directory structure:**

```
project/
├── src/           # Source code
├── tests/         # Test files
│   ├── unit/      # Unit tests
│   └── integration/  # Integration tests (optional separation)
```

## Best Practices

- ! Write tests before or alongside code (TDD encouraged)
- ! One assertion per test (or logically grouped assertions)
- ~ Use descriptive test names: `test_user_login_with_invalid_password`
- ! Arrange-Act-Assert (AAA) pattern
- ! Test behavior, not implementation
- ≉ Rely on test execution order
- ! Clean up resources (files, DB, connections) in teardown

## Anti-patterns

- ⊗ Skip tests to meet deadlines
- ⊗ Test only happy paths (edge cases critical)
- ⊗ Mock everything (integration tests needed too)
- ⊗ Ignore flaky tests (fix or remove them)
- ⊗ Commit failing tests
- ⊗ Write tests that depend on external state
- ⊗ Hard-code dates, times, random values
- ⊗ Implementing code without tests
- ⊗ Claiming "done" before running test:coverage
- ⊗ Ignoring coverage drops

## CI/CD Integration

- ! Tests run automatically on every commit/PR
- ! Block merges if tests fail
- ! Block merges if coverage drops below threshold
- ~ Test in multiple environments (OS, versions)

---

**See also**: [main.md](../main.md) | Language-specific testing in python.md, go.md, cpp.md, typescript.md
