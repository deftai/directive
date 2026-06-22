# Deploy to Cloudflare via Git Integration

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [README.md](./README.md) | [via-wrangler.md](./via-wrangler.md) | [via-github-actions.md](./via-github-actions.md)

## Overview

Connect a GitHub or GitLab repository to Cloudflare Pages. Every push to the
configured branch triggers an automatic build and deploy on Cloudflare's edge
network. Preview deployments are created for pull requests.

**Best for**: Teams that want zero-config continuous deployment with preview URLs on every PR.

## Prerequisites

- Cloudflare account
- GitHub or GitLab repository with your project
- Build command and output directory known (e.g. `npm run build` → `dist/`)

## Setup

1. In the Cloudflare dashboard, go to **Workers & Pages**
2. Select **Create application** → **Pages** tab → **Import an existing Git repository**
3. Authorize GitHub/GitLab and select the repository
4. Configure the build settings:
   - **Project name**: defaults to repo name (becomes `<name>.pages.dev`)
   - **Production branch**: typically `main`
   - **Build command**: e.g. `npm run build` (use `exit 0` for pre-built static HTML)
   - **Build output directory**: e.g. `dist/`, `build/`, `public/`
5. Select **Save and Deploy**

## Standards

### Configuration
- ! Set the production branch to match your team's trunk branch (`main`, `master`, etc.)
- ! Configure the correct build output directory for your framework
- ~ Use `exit 0` as the build command if deploying pre-built static assets
- ~ Pin the Node.js version via environment variable `NODE_VERSION` if builds require it

### Preview Deployments
- ! Understand that preview URLs (`<hash>.<project>.pages.dev`) are public by default
- ~ Enable Cloudflare Access on preview deployments for private projects
- ~ Use branch deployment controls to exclude noisy branches (e.g. `dependabot/*`)
- ? Limit preview branches to specific patterns (e.g. `feature/*`, `staging`)

### Custom Domains
- ! Add custom domains via the Pages project **Custom Domains** settings
- ! Use a CNAME record pointing to `<project>.pages.dev` for external DNS
- ~ Let Cloudflare auto-configure DNS if the domain is already on Cloudflare

### Environment Variables & Secrets
- ! Set sensitive values (API keys, tokens) as encrypted environment variables in the dashboard
- ! Configure separate values for Production and Preview environments
- ⊗ Commit secrets to the repository

### Build Settings
- ~ Use framework presets when available (React, Vue, Hugo, Next.js, etc.)
- ~ Set `NODE_VERSION` and `NPM_VERSION` environment variables for reproducible builds
- ? Add a `_redirects` or `_headers` file in the output directory for routing/header rules

## 🔧 Patterns

**Static HTML (no build)**:
- Build command: `exit 0`
- Output directory: `/` (or whichever folder contains `index.html`)

**Monorepo with subdirectory**:
- Set **Root directory** in build settings to the subdirectory path
- Build command and output are relative to that root

**Branch-based environments**:
- Production branch → `<project>.pages.dev` + custom domains
- All other branches → `<branch>.<project>.pages.dev` preview URLs

## Anti-Patterns

- ⊗ Switch a Direct Upload project to Git integration (not supported — must create a new project)
- ⊗ Leave preview deployments public for projects containing sensitive content
- ⊗ Use different build tooling locally vs. in Cloudflare's build environment without pinning versions
- ≉ Store environment-specific config in the repo — use Cloudflare's environment variable settings
- ≉ Rely on Cloudflare's build cache for reproducibility — pin all dependency versions explicitly

## Compliance Checklist

- ! Build output directory correctly configured
- ! Production branch matches team convention
- ! Secrets stored as encrypted environment variables (not in repo)
- ! Preview access controls reviewed
- ~ `_redirects` / `_headers` files present for SPA routing
