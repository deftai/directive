# Netlify Deployment Module

Deft guidance for deploying applications to Netlify.

## Status

- ! Optional module
- ~ Good for Deft usage

## Overview

Netlify specializes in JAMstack deployments with built-in CI/CD and serverless functions.

## Deployment Methods

| File | Method | Best For |
|------|--------|----------|
| `via-git.md` | Git Integration | Automatic deploy-on-push workflows (default) |
| `via-cli.md` | Netlify CLI | Local testing, custom CI/CD pipelines |
| `via-functions.md` | Netlify Functions | Serverless APIs alongside static sites |

## Supported Frameworks

Netlify supports all major static site generators and frameworks:

- **Next.js** — Static and SSR support
- **Gatsby** — Optimized builds and plugins
- **Hugo** — Fast static site generation
- **Jekyll** — Ruby-based static sites
- **Eleventy** — Flexible static site generator
- **SvelteKit** — Full-stack Svelte framework
- **Astro** — Modern static site builder
- **Any static HTML/CSS/JS**

## Deployment Approaches

### Git-Based Deployments

- Connect repository for continuous deployment
- Deploy previews for every pull request
- Branch deploys for staging environments
- Automatic build detection and configuration

### CLI Deployments

```bash
# Install Netlify CLI
npm i -g netlify-cli

# Link to existing site or create new
netlify init

# Deploy draft for testing
netlify deploy

# Deploy to production
netlify deploy --prod
```

### Netlify Functions

- Deploy serverless functions alongside your site
- Background functions for async processing
- Edge functions for request manipulation at CDN edge

### Build Plugins

- Extend build process with Netlify plugins
- Image optimization, analytics, A/B testing
- Custom build workflows

## Quick Decision Guide

- **JAMstack sites**: Git integration — automatic builds on push
- **Static site generators**: Git integration — framework detection
- **Quick prototypes**: Drag & drop — instant deployment
- **Serverless APIs**: Netlify Functions — backend alongside frontend
- **Edge logic**: Edge Functions — request handling at CDN
- **CI/CD pipelines**: Netlify CLI — custom build workflows
- **A/B testing**: Split Testing — built-in feature

## Key Features

- **Instant Rollbacks**: One-click rollback to any deploy
- **Deploy Previews**: Unique URL for every PR
- **Form Handling**: Built-in form processing
- **Identity**: Built-in authentication
- **Large Media**: Git LFS alternative
- **Analytics**: Privacy-first analytics
- **Automatic HTTPS**: Free SSL certificates

## References

- [Netlify Documentation](https://docs.netlify.com/)
- [Netlify CLI](https://docs.netlify.com/cli/get-started/)
- [Deploy with Git](https://docs.netlify.com/site-deploys/create-deploys/)
- [Netlify Functions](https://docs.netlify.com/functions/overview/)
- [Edge Functions](https://docs.netlify.com/edge-functions/overview/)
- [Build Plugins](https://docs.netlify.com/configure-builds/build-plugins/)
