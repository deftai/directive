# Blacksmith CI Module

Optional Deft guidance for migrating GitHub Actions workflows to
[Blacksmith](https://blacksmith.sh) runners using **tiered vCPU sizing**.

## Status

- ! Optional module — not required for Directive install or `task check`
- ! Lazy-load only when a repo migrates (or plans to migrate) to Blacksmith
- ⊗ Treat Blacksmith as the default Directive framework CI runner from these docs alone

## Files

| File | Role |
|------|------|
| [overview.md](./overview.md) | What Blacksmith is, drop-in `runs-on` swap, scope and non-goals |
| [runner-tiers.md](./runner-tiers.md) | Decision rules for 4 / 8 / 32 vCPU tags |
| [migration-prompt.md](./migration-prompt.md) | Drop-in agent prompt for workflow migration |
| [examples/lint-vs-test-split.md](./examples/lint-vs-test-split.md) | Before/after: split monolithic lint+test onto small vs large runners |

## Quick start

1. Install the Blacksmith GitHub App on every repo that will use `runs-on: blacksmith-*`.
2. Read [runner-tiers.md](./runner-tiers.md) and map each job to a tier.
3. Run [migration-prompt.md](./migration-prompt.md) (or apply the rules by hand).
4. Prefer splitting `test-and-lint` jobs into small lint and large test jobs.

## Attribution

Tier practice and the migration prompt shape come from `deftai/evolution`
Blacksmith usage (Slack capture for issue [#448](https://github.com/deftai/directive/issues/448)).
Runner tag names follow [Blacksmith runner docs](https://docs.blacksmith.sh/blacksmith-runners/overview).
