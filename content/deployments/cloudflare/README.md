# Cloudflare Deployment Module

Deft guidance for deploying to Cloudflare Pages and Workers.

## Status

- ! Optional module
- ~ Good for Deft usage

## Deployment Methods

| File | Method | Best For |
|------|--------|----------|
| `via-git.md` | Git Integration (GitHub/GitLab) | Teams wanting automated deploy-on-push |
| `via-wrangler.md` | Wrangler CLI | Local deploys, CI pipelines, Workers |
| `via-dashboard.md` | Dashboard Direct Upload | Quick one-off deploys, non-developers |
| `via-github-actions.md` | GitHub Actions CI/CD | Automated pipelines with custom build steps |
| `via-terraform.md` | Terraform IaC | Infrastructure-as-code, multi-resource management |

## Important Note

Cloudflare deprecated Pages as a standalone product in April 2025, pushing toward
a unified Workers platform. The `wrangler deploy` and Workers-based workflows are
the recommended path forward. Git integration and direct upload still work but
now operate under the Workers & Pages umbrella in the dashboard.

## Quick Decision Guide

- **Simplest path**: `via-git.md` — connect repo, push, done
- **Most control**: `via-wrangler.md` — CLI deploys with full config
- **CI/CD pipelines**: `via-github-actions.md` — automated with `wrangler-action`
- **IaC teams**: `via-terraform.md` — manage Cloudflare alongside other infra
- **One-off / non-dev**: `via-dashboard.md` — drag and drop in browser
