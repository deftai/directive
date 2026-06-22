# Deploy to Cloudflare via GitHub Actions

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [README.md](./README.md) | [via-wrangler.md](./via-wrangler.md) | [via-git.md](./via-git.md)

## Overview

Use the official `cloudflare/wrangler-action` GitHub Action to deploy Workers
and Pages projects as part of a GitHub Actions CI/CD pipeline. This gives you
full control over the build process while automating deployments on push/merge.

**Best for**: Teams that need custom build steps, test gates, or multi-step pipelines before deploying.

## Prerequisites

- Cloudflare account with API token
- GitHub repository
- `wrangler.toml` or `wrangler.jsonc` in the project (for Workers)

## Secrets Setup

In GitHub: **Settings → Secrets and variables → Actions**, add:

- `CLOUDFLARE_API_TOKEN` — API token with Workers/Pages edit permissions
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID

## Workflow Examples

### Workers Deploy on Push to Main

```yaml
name: Deploy Worker
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

### Pages Deploy with Build Step

```yaml
name: Deploy Pages
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - name: Deploy to Pages
        id: deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy dist --project-name=my-site
      - name: Print URL
        run: echo "${{ steps.deploy.outputs.deployment-url }}"
```

### Preview Deploy on PR

```yaml
name: Preview Deploy
on: pull_request

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - name: Deploy Preview
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy dist --project-name=my-site --branch=${{ github.head_ref }}
```

## Standards

### Action Configuration
- ! Use `cloudflare/wrangler-action@v3` (v3 or later with the `v` prefix)
- ! Pass `apiToken` and `accountId` via GitHub Secrets — never hardcode
- ~ Pin the action to a specific version tag (e.g. `@v3.14.0`) for reproducibility
- ~ Specify `packageManager` if not using npm (e.g. `packageManager: pnpm`)

### Secrets Management
- ! Store `CLOUDFLARE_API_TOKEN` in GitHub Secrets (encrypted, not printed in logs)
- ! Store `CLOUDFLARE_ACCOUNT_ID` in GitHub Secrets (or as a repository variable)
- ! Scope the API token to the minimum required permissions
- ⊗ Use legacy API keys — use API tokens
- ⊗ Echo or log the API token value in workflow steps

### Workflow Design
- ! Run build and test steps before the deploy step
- ! Use `actions/checkout@v4` to check out the repository
- ~ Use `actions/setup-node@v4` with a pinned Node.js version
- ~ Use `npm ci` (not `npm install`) for deterministic dependency installation
- ~ Output the deployment URL for PR comments or downstream steps
- ? Add a test/lint gate job that must pass before the deploy job runs

### Workers-Specific
- ! Ensure `wrangler.toml` includes `account_id` or pass `accountId` in the action
- ~ Use `--strict` flag in CI to prevent accidental overrides of remote settings
- ~ Use Wrangler environments for staging vs. production deploys

### Pages-Specific
- ! Use the `command:` input with `pages deploy <dir> --project-name=<name>`
- ~ Use `--branch=${{ github.head_ref }}` for PR preview deployments
- ~ Access `deployment-url` and `pages-deployment-alias-url` outputs for downstream use

## 🔧 Patterns

**Deploy only when tests pass**:
```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

**Comment preview URL on PR**:
- Use the `deployment-url` output from the action with a PR comment action

**Multi-environment deploy**:
```yaml
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    environment: staging
```

## Anti-Patterns

- ⊗ Hardcode API tokens or account IDs in workflow files
- ⊗ Use `wrangler-action@1` or `wrangler-action@2` (Wrangler v1/v2 are EOL)
- ⊗ Deploy without running tests first in production pipelines
- ≉ Use `npm install` in CI — use `npm ci` for deterministic installs
- ≉ Skip the `accountId` input — Wrangler may prompt interactively and hang in CI
- ≉ Use `uses: cloudflare/wrangler-action@3.x.x` (must use `@v3.x.x` with the `v` prefix)

## Compliance Checklist

- ! `CLOUDFLARE_API_TOKEN` stored in GitHub Secrets
- ! `CLOUDFLARE_ACCOUNT_ID` stored in GitHub Secrets or Variables
- ! `cloudflare/wrangler-action@v3` used with `v` prefix
- ! Build/test steps precede deploy step
- ! Node.js version pinned in workflow
- ~ Deployment URL captured in outputs
