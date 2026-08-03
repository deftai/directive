# Blacksmith migration prompt (agent drop-in)

Copy the prompt below into an agent session that may edit `.github/workflows/`.
Point the agent at this file (or paste the body). Pair with
[runner-tiers.md](./runner-tiers.md).

---

## Prompt

```text
Migrate this repository's GitHub Actions workflows to Blacksmith runners using
tiered vCPU sizing. Follow these rules exactly.

## Goal
Replace GitHub-hosted Ubuntu runners with Blacksmith tags so heavy parallel jobs
get large machines and single-threaded / coordination jobs stay small.

## Runner tags (Ubuntu x64)
- blacksmith-4vcpu-ubuntu-2404  — SMALL (default)
- blacksmith-8vcpu-ubuntu-2404  — MEDIUM
- blacksmith-32vcpu-ubuntu-2404 — LARGE

## Decision rules

### LARGE (32 vCPU) if the job does any of:
- Test suite with coverage across many files/packages
- go test ./..., jest, vitest, pytest -n auto, cargo test (or equivalent)
- Multi-package monorepo builds (turbo run build, nx run-many, etc.)
- LLM/agent actions that spawn heavy subprocesses
- Full task check / make ci chaining many of the above

### MEDIUM (8 vCPU) if the job:
- Runs inside a container: for a security/analysis scanner doing real CPU work
  (semgrep, codeql-community, trivy image scans, sonar-scanner)
- Does moderate parallel compression/packaging but is not a full test matrix

### SMALL (4 vCPU) if the job:
- Only runs formatters / linters / typecheckers
- Is a coordination job (mostly gh calls, $GITHUB_OUTPUT, matrix JSON, labels,
  dispatching workflows)
- Runs a fast single-binary scanner (gosec, trivy fs, npm audit)
- Uploads artifacts, publishes releases, or does IO-bound deploy steps

If a job is one monolithic test-and-lint step, SPLIT it into a small-tier lint
job and a large-tier test job.

## Migration steps
1. Find every workflow under .github/workflows/.
2. Replace ubuntu-latest / ubuntu-22.04 / ubuntu-24.04 with the appropriate
   blacksmith-{N}vcpu-ubuntu-2404 tier per the rules above.
3. Leave macos-*, windows-*, and self-hosted / custom-labeled runners alone.
4. Add a one-line comment above each runs-on: explaining why that tier was
   chosen. Example:

   # Coordination-only: emits a JSON task list. Keep on the small runner.
   runs-on: blacksmith-4vcpu-ubuntu-2404

5. Do not change job logic except for lint/test splits required by the rules.
6. Summarize: list each job, old runs-on, new runs-on, and the tier reason.

## Non-goals
- Do not make Blacksmith the org-wide default outside this repo's workflows.
- Do not invent multi-provider CI abstractions.
- Do not rewrite deploy platform docs; only workflows and related CI config.
```

---

## After the agent finishes

- Confirm the Blacksmith GitHub App is installed on this repository
- Open a PR that only touches workflow sizing (plus any intentional lint/test splits)
- Watch a green run on the new tags before relying on the migration

## See also

- [overview.md](./overview.md)
- [runner-tiers.md](./runner-tiers.md)
- [examples/lint-vs-test-split.md](./examples/lint-vs-test-split.md)
