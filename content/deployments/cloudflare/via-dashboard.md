# Deploy to Cloudflare via Dashboard Direct Upload

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [README.md](./README.md) | [via-git.md](./via-git.md) | [via-wrangler.md](./via-wrangler.md)

## Overview

Upload pre-built static assets directly to Cloudflare Pages through the web
dashboard using drag-and-drop. No CLI, Git, or build pipeline required.

**Best for**: Quick one-off deploys, non-developers, prototypes, or teams without CI/CD.

## Prerequisites

- Cloudflare account
- Pre-built static site files (HTML, CSS, JS, images) ready on local disk

## Setup

### First Deployment

1. Go to the Cloudflare dashboard → **Workers & Pages**
2. Select **Create application** → **Pages** tab → **Upload assets**
3. Enter a **Project name** (becomes `<name>.pages.dev`)
4. Drag and drop your build output directory into the upload frame
5. Select **Save and Deploy**

### Subsequent Deployments

1. Go to your Pages project in the dashboard
2. Select **Create a new deployment**
3. Choose **Production** or **Preview** environment
4. If preview, specify a branch name (for the preview URL alias)
5. Drag and drop the updated build directory
6. Select **Save and Deploy**

## Standards

### Project Structure
- ! Include a top-level `index.html` in the uploaded directory
- ! Ensure all asset paths are relative (not absolute filesystem paths)
- ~ Include `_redirects` and/or `_headers` files for routing and header configuration
- ~ Verify the build output locally before uploading

### Deployment
- ! Understand that each deployment replaces the entire site — there is no partial/incremental upload
- ! Verify the deployment at `<project>.pages.dev` after upload
- ~ Use preview deployments for testing before deploying to production
- ? Use the Wrangler CLI for repeated deployments (more efficient than dashboard)

### Custom Domains
- ! Configure custom domains via project **Custom Domains** settings after the first deploy
- ~ Use Cloudflare DNS for automatic CNAME configuration

### Limits
- ! Be aware that individual file upload size is limited (25 MB per file on free plan)
- ! Stay within the 500 deploys/month limit on the free plan
- ~ Check for red warning icons next to files that failed to upload due to size limits

## 🔧 Patterns

**Simple static site**:
- Build locally → drag the `dist/` or `build/` folder → deploy

**Preview before production**:
- Create new deployment → select **Preview** → upload → verify at preview URL → redeploy to Production

## Anti-Patterns

- ⊗ Upload source code (e.g. `node_modules/`, `.git/`) — upload only the build output directory
- ⊗ Expect to switch a Direct Upload project to Git integration later (not supported — must create a new project)
- ⊗ Use dashboard uploads as a primary production workflow for active projects
- ≉ Rely on drag-and-drop for team workflows — use Git integration or Wrangler for repeatability
- ≉ Upload without building first — the dashboard does not run build commands
- ≉ Re-upload individual files to "patch" a deployment — each deployment is a complete replacement

## Compliance Checklist

- ! Build output verified locally before upload
- ! `index.html` present at top level
- ! No secrets, source code, or `node_modules` in the uploaded directory
- ~ Custom domain configured after first successful deploy
