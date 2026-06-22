# Vercel Deployment Module

Deft guidance for deploying applications to Vercel.

## Status

- ! Optional module
- ~ Good for Deft usage

## Overview

Vercel optimizes for frontend frameworks and full-stack JavaScript/TypeScript with exceptional Next.js support.

## Deployment Methods

| File | Method | Best For |
|------|--------|----------|
| `via-git.md` | Git Integration | Automatic deployments with preview URLs (default) |
| `via-cli.md` | Vercel CLI | Local testing, custom CI/CD pipelines |
| `via-api.md` | Vercel API | Programmatic deployments, custom automation |

## Supported Frameworks

Vercel has zero-config support for:

- **Next.js** — First-class support, optimal performance
- **React** — Create React App, Vite, custom setups
- **Vue.js** — Nuxt, Vite, Vue CLI
- **Svelte** — SvelteKit, Vite
- **Angular** — Full support
- **Static Sites** — Any static site generator

## Deployment Approaches

### Git-Based Deployments

- Connect repository for automatic deployments on every push
- Preview deployments for every pull request
- Production deployments from main/master branch
- Environment variables per branch/environment

### CLI Deployments

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy to preview
vercel

# Deploy to production
vercel --prod
```

### Edge Functions & Middleware

- Deploy serverless Edge Functions alongside your frontend
- Middleware for request modification at the edge
- Global distribution with low latency

### CI/CD Integration

- **GitHub Actions**: Use `vercel-action` for custom workflows
- **GitLab CI/CD**: Deploy via Vercel CLI
- **Other CI**: Integrate using Vercel CLI or API

## Quick Decision Guide

- **Next.js apps**: Git integration — deploy on push, automatic optimization
- **Preview workflows**: Git integration — preview URLs for every PR
- **Local testing**: Vercel CLI — deploy from local machine
- **Custom pipelines**: GitHub Actions + Vercel CLI — advanced automation
- **API-driven**: Vercel API — programmatic deployments

## Key Features

- **Automatic HTTPS**: Free SSL certificates
- **Global CDN**: Edge network for optimal performance
- **Serverless Functions**: Backend APIs alongside frontend
- **Edge Functions**: Code running at the edge
- **Image Optimization**: Automatic image handling
- **Analytics**: Built-in web analytics

## References

- [Vercel Documentation](https://vercel.com/docs)
- [Vercel CLI Documentation](https://vercel.com/docs/cli)
- [Deploy with Git](https://vercel.com/docs/deployments/git)
- [Edge Functions](https://vercel.com/docs/functions/edge-functions)
- [Next.js on Vercel](https://vercel.com/docs/frameworks/nextjs)
