# Deploy to Cloudflare via Wrangler CLI

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [README.md](./README.md) | [via-git.md](./via-git.md) | [via-github-actions.md](./via-github-actions.md)

## Overview

Wrangler is Cloudflare's official CLI for deploying to both Pages (static assets)
and Workers (serverless functions). It provides full control over the deployment
process and is the foundation for all CLI-based and CI/CD workflows.

**Best for**: Developers wanting full local control, custom CI pipelines, or Workers deployments.

## Prerequisites

- Cloudflare account
- Node.js ≥ 16.17.0
- `wrangler` installed (project dev dependency preferred)

## Installation

```bash
# Project dev dependency (recommended)
npm install -D wrangler

# Or globally
npm install -g wrangler
```

## Authentication

```bash
# Interactive (opens browser)
npx wrangler login

# Non-interactive (CI/CD) — use API token
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_ACCOUNT_ID=<account-id>
```

## Deploy Workflows

### Pages (Static Assets / Direct Upload)

```bash
# Build your project first
npm run build

# Deploy to Pages
npx wrangler pages deploy <BUILD_OUTPUT_DIR>

# Deploy to a specific branch (preview)
npx wrangler pages deploy <BUILD_OUTPUT_DIR> --branch=staging
```

### Workers

```bash
# Scaffold a new Worker (uses C3 / create-cloudflare)
npm create cloudflare@latest my-worker

# Local development
npx wrangler dev

# Deploy to production
npx wrangler deploy
```

### Configuration (`wrangler.toml` / `wrangler.jsonc`)

Minimum for Workers:
```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"
```

Minimum for Pages with static assets:
```toml
name = "my-site"
compatibility_date = "2025-01-01"
pages_build_output_dir = "dist"
```

## Standards

### Installation & Versioning
- ! Install Wrangler as a project dev dependency (`npm install -D wrangler`)
- ! Pin the Wrangler version in `package.json` for reproducible deploys
- ≉ Install Wrangler globally as the sole installation — team members will drift on versions

### Authentication
- ! Use API tokens (not legacy API keys) for all non-interactive environments
- ! Store `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as environment variables in CI
- ⊗ Commit API tokens or credentials to the repository
- ~ Scope API tokens to the minimum required permissions

### Configuration
- ! Include a `wrangler.toml` or `wrangler.jsonc` in the project root
- ! Set `compatibility_date` to a recent date and update periodically
- ~ Use Wrangler environments (`[env.staging]`, `[env.production]`) for multi-stage deploys
- ~ Treat `wrangler.toml` as the source of truth — dashboard changes are overwritten on deploy
- ? Use `--dry-run --outdir=dist` to inspect the build output before deploying

### Deployment
- ! Run `npx wrangler pages deploy <dir>` for Pages projects
- ! Run `npx wrangler deploy` for Workers projects
- ! Build the project before deploying (`npm run build` or equivalent)
- ~ Use `--branch=<name>` for preview deployments on Pages
- ~ Verify deployment URL after deploy (`<project>.pages.dev` or `<worker>.workers.dev`)

### Local Development
- ~ Use `npx wrangler dev` for local development with hot reload
- ~ Use `.dev.vars` for local secrets (gitignored)
- ⊗ Use `wrangler dev` with production bindings unless explicitly intended

### Secrets
- ! Use `npx wrangler secret put <NAME>` to set secrets (never in config files)
- ! Use `.dev.vars` for local development secrets
- ⊗ Store secrets in `wrangler.toml` — use `wrangler secret` commands instead

## 🔧 Patterns

**Deploy Pages with custom project name**:
```bash
npx wrangler pages project create my-site
npx wrangler pages deploy dist --project-name=my-site
```

**Multi-environment Workers**:
```toml
[env.staging]
name = "my-worker-staging"
route = "staging.example.com/*"

[env.production]
name = "my-worker-production"
route = "example.com/*"
```
```bash
npx wrangler deploy --env=staging
npx wrangler deploy --env=production
```

**Strict mode deploy (CI safety)**:
```bash
npx wrangler deploy --strict
```

## Anti-Patterns

- ⊗ Modify Workers settings in the dashboard when using Wrangler (Wrangler overwrites on deploy)
- ⊗ Deploy without building first — Wrangler deploys the directory as-is
- ⊗ Hardcode `account_id` with secrets in the same file
- ≉ Use `wrangler publish` (deprecated — use `wrangler deploy`)
- ≉ Skip `compatibility_date` — this controls runtime behavior and breaking changes

## Compliance Checklist

- ! Wrangler installed as dev dependency with pinned version
- ! `wrangler.toml` present with `name`, `main` (Workers) or `pages_build_output_dir` (Pages)
- ! `compatibility_date` set
- ! Secrets managed via `wrangler secret`, not config files
- ! API token scoped to minimum permissions
