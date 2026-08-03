# Blacksmith runner tiers (4 / 8 / 32 vCPU)

Opinionated sizing for GitHub Actions jobs on Blacksmith Ubuntu x64 runners.
Use one tag per job. Put a one-line comment above each `runs-on:` that states why.

## Tier table

| Tier | `runs-on` | Use for |
|------|-----------|---------|
| **Large (32 vCPU)** | `blacksmith-32vcpu-ubuntu-2404` | Full test/coverage, monorepo builds, full `task check`, heavy agent jobs |
| **Medium (8 vCPU)** | `blacksmith-8vcpu-ubuntu-2404` | Container scanners with real CPU (semgrep and similar) |
| **Small (4 vCPU)** | `blacksmith-4vcpu-ubuntu-2404` | Lint/format/typecheck, coordination, fast single-binary scanners, IO-bound work |

Default when unsure: **4 vCPU**. Move up only when the job spends real CPU on parallel work.

## 32 vCPU — large

Choose large if the job does any of:

- Test suite with coverage across many files or packages
- Language suite runners such as `go test ./...`, `jest`, `vitest`, `pytest -n auto`, `cargo test`
- Multi-package monorepo builds (`turbo run build`, `nx run-many`, and similar)
- LLM/agent actions that spawn heavy subprocesses (for example Oz, Claude Code in CI)
- Full `task check` / `make ci` that chains many of the above

```yaml
# Full test suite with coverage across packages — large tier.
runs-on: blacksmith-32vcpu-ubuntu-2404
```

## 8 vCPU — medium

Choose medium if the job:

- Runs inside a `container:` for a security or analysis scanner that does real CPU work
  (semgrep, CodeQL community runners, Trivy **image** scans, sonar-scanner)
- Does moderate parallel compression or packaging but is not a full test matrix

```yaml
# Semgrep in container with real CPU scan work — medium tier.
runs-on: blacksmith-8vcpu-ubuntu-2404
```

## 4 vCPU — small (default)

Choose small if the job:

- Only runs formatters, linters, or typecheckers
- Is a coordination job (mostly `gh` calls, `$GITHUB_OUTPUT`, matrix JSON, labels, dispatch)
- Runs a fast single-binary scanner (gosec, Trivy **fs**, npm audit)
- Uploads artifacts, publishes releases, or runs IO-bound deploy steps

```yaml
# Coordination-only: emits a JSON task list. Keep on the small runner.
runs-on: blacksmith-4vcpu-ubuntu-2404
```

## Split monolithic lint + test

If a job today is one `test-and-lint` (or similar) step:

1. ! Split into a **small-tier** `*-lint` job and a **large-tier** `*-test` job
2. ! Share checkout/setup steps only as needed; prefer independent jobs so lint
   fails fast on a cheap runner
3. ~ Wire `needs:` only when order truly matters

See [examples/lint-vs-test-split.md](./examples/lint-vs-test-split.md).

## Leave alone

Do **not** rewrite these `runs-on` values to Blacksmith Ubuntu tags:

- `macos-*`
- `windows-*`
- Self-hosted or custom-labeled runners the repo already owns

## Comment style

! Add a one-line comment above each Blacksmith `runs-on:` that states the tier reason.
Mirror the style in the examples and migration prompt.
