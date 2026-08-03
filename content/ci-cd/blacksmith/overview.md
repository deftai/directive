# Blacksmith overview

[Blacksmith](https://blacksmith.sh) provides drop-in GitHub Actions runners.
You keep workflow YAML; you change `runs-on` labels (and often split heavy jobs).

## Why use this module

GitHub-hosted `ubuntu-latest` is one size for every job. Blacksmith exposes
explicit vCPU tags so you can:

- Give full test/coverage and monorepo builds a **large** runner
- Keep format, lint, typecheck, and coordination jobs on a **small** runner
- Put CPU-heavy container scanners on a **medium** runner

That split cuts wall-clock time on the critical path and avoids overpaying for
idle cores on single-threaded work.

## Drop-in shape

Minimal change (labels only):

```yaml
jobs:
  build:
    # Full monorepo test suite with coverage — large tier.
    runs-on: blacksmith-32vcpu-ubuntu-2404
```

Common Ubuntu x64 tags used in this guide:

| Tag | Tier in this guide |
|-----|--------------------|
| `blacksmith-4vcpu-ubuntu-2404` | Small (default) |
| `blacksmith-8vcpu-ubuntu-2404` | Medium |
| `blacksmith-32vcpu-ubuntu-2404` | Large |

Blacksmith also publishes other sizes (for example 2 vCPU). This module standardizes
on **4 / 8 / 32** as the Deft consumer decision set. See
[runner-tiers.md](./runner-tiers.md).

## Prerequisites

- Blacksmith GitHub App installed on **each** repository that uses `runs-on: blacksmith-*`
- Jobs that must stay on macOS, Windows, or custom self-hosted labels stay on those runners

## Non-goals (this module)

- ⊗ Changing the Directive monorepo's own workflows as a prerequisite for shipping these docs
- ⊗ Declaring Blacksmith the default CI for every Deft consumer
- ⊗ A multi-provider CI product surface before provider guides land under `ci-cd/`

## Related

- [runner-tiers.md](./runner-tiers.md) — when to pick 4, 8, or 32 vCPU
- [migration-prompt.md](./migration-prompt.md) — agent-ready migration steps
- [examples/lint-vs-test-split.md](./examples/lint-vs-test-split.md) — split lint vs test
- Parent layer: [ci-cd/README.md](../README.md)
- Deploy platforms (different concern): [deployments/README.md](../../deployments/README.md)
