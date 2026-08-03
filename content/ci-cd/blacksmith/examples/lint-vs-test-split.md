# Example: split lint vs test (before / after)

Monolithic `test-and-lint` jobs force a large machine for single-threaded lint,
or starve tests on a small machine. Split them.

## Before (GitHub-hosted, combined)

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [master]

jobs:
  test-and-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec biome check .
      - run: pnpm exec tsc -b --pretty false
      - run: pnpm exec vitest run --coverage
```

Problems:

- Lint and typecheck barely use 32 cores
- Tests with coverage want many cores
- One failure mode mixes style and correctness

## After (Blacksmith tiers + split)

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [master]

jobs:
  lint:
    # Formatters, linters, typecheckers only — small tier.
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec biome check .
      - run: pnpm exec tsc -b --pretty false

  test:
    # Full unit suite with coverage — large tier.
    runs-on: blacksmith-32vcpu-ubuntu-2404
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec vitest run --coverage
```

## Medium tier snippet (scanner)

```yaml
  semgrep:
    # Container scanner with real CPU work — medium tier.
    runs-on: blacksmith-8vcpu-ubuntu-2404
    container:
      image: semgrep/semgrep:latest
    steps:
      - uses: actions/checkout@v4
      - run: semgrep scan --config=auto
```

## Mapping checklist

| Job kind | Tier | Tag |
|----------|------|-----|
| biome / eslint / ruff / tsc only | Small | `blacksmith-4vcpu-ubuntu-2404` |
| matrix emit / label / dispatch | Small | `blacksmith-4vcpu-ubuntu-2404` |
| gosec / trivy fs / npm audit | Small | `blacksmith-4vcpu-ubuntu-2404` |
| semgrep / heavy image scan | Medium | `blacksmith-8vcpu-ubuntu-2404` |
| vitest/jest/go test + coverage | Large | `blacksmith-32vcpu-ubuntu-2404` |
| full `task check` | Large | `blacksmith-32vcpu-ubuntu-2404` |

Full rules: [../runner-tiers.md](../runner-tiers.md).
