# CI/CD Layer

Provider-specific guidance for continuous integration runners and CI migration
(Blacksmith, and later GitHub-hosted, Buildjet, Depot, self-hosted, and similar).

## Purpose

- ! Provide **optional** CI/CD modules that a project can apply when it migrates runners
- ~ Keep runner and pipeline guidance separate from core Deft rules and from `deployments/`
- ~ Enable drop-in agent prompts so a migration is repeatable across repos
- ⊗ Expand always-on `AGENTS.md` with full CI provider bulk — load this layer only when you migrate CI

## Relation to deployments

| Layer | Focus |
|-------|--------|
| [`deployments/`](../deployments/README.md) | Where and how you **deploy** runtime apps (cloud platforms, CD paths) |
| **`ci-cd/`** (this layer) | How you **run CI jobs** (runner labels, sizing, workflow migration) |

Deploy docs may mention GitHub Actions for ship steps. They do not replace runner-tier guidance here.

## Module Structure

Create a directory per CI provider:

```
ci-cd/
  README.md                     # purpose + module structure (this file)
  <provider>/
    README.md
    overview.md
    runner-tiers.md             # when present: sizing decision rules
    migration-prompt.md         # when present: agent drop-in prompt
    examples/                   # before/after workflow snippets
```

Guidelines:

- ! Use hyphens in filenames
- ! Keep modules optional and isolated
- ~ Include a clear README with attribution when derived from a reference repo
- ~ Prefer short decision tables over long narrative for tier selection
- ⊗ Make any single provider the default for the Directive framework repo itself
  unless a separate product decision ships that change

## Current modules

| Module | Load when |
|--------|-----------|
| [blacksmith/](./blacksmith/README.md) | Migrating GitHub Actions jobs to [Blacksmith](https://blacksmith.sh) runners with tiered vCPU sizing |

## Lazy loading

1. Scan this README for the right provider.
2. Open that provider's `README.md`, then `overview.md` / `runner-tiers.md` as needed.
3. Paste or adapt `migration-prompt.md` into the agent session that edits `.github/workflows/`.
4. Do not pin full provider text into always-on agent context.
