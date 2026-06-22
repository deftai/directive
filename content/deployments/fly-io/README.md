# Fly.io Deployment Module

Deft guidance for deploying applications to Fly.io.

## Status

- ! Optional module
- ~ Good for Deft usage

## Overview

Fly.io runs Docker containers on physical servers close to your users worldwide. Edge deployment platform with 30+ regions and automatic global routing.

## Deployment Methods

| File | Method | Best For |
|------|--------|----------|
| `via-flyctl.md` | flyctl CLI | Primary deployment method, full control (default) |
| `via-github-actions.md` | GitHub Actions CI/CD | Automated pipelines with testing and deployments |
| `via-dockerfile.md` | Custom Dockerfile | Advanced Docker builds, multi-stage optimization |
| `via-multi-region.md` | Multi-Region Deployment | Global apps with low latency and high availability |

## Quick Decision Guide

- **Default path**: `via-flyctl.md` — `fly launch` and `fly deploy` for most apps
- **CI/CD pipelines**: `via-github-actions.md` — automated deployments with tests
- **Custom containers**: `via-dockerfile.md` — full Docker control and optimization
- **Global deployment**: `via-multi-region.md` — deploy to multiple regions worldwide

## References

- [Fly.io Documentation](https://fly.io/docs/)
- [flyctl CLI Reference](https://fly.io/docs/flyctl/)
- [Fly Launch](https://fly.io/docs/reference/fly-launch/)
- [Multi-region Deployment](https://fly.io/docs/reference/regions/)
- [Fly Postgres](https://fly.io/docs/postgres/)
- [Fly Machines](https://fly.io/docs/machines/)
