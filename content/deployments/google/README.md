# Google Cloud Deployment Module

Deft guidance for deploying applications to Google Cloud Platform.

## Status

- ! Optional module
- ~ Good for Deft usage

## Overview

Google Cloud offers serverless to full infrastructure control deployment options.

## Deployment Methods

| File | Method | Best For |
|------|--------|----------|
| `via-cloud-run.md` | Cloud Run | Containerized web apps, serverless containers (default) |
| `via-app-engine.md` | App Engine | Traditional PaaS, opinionated runtimes |
| `via-cloud-functions.md` | Cloud Functions | Serverless functions, event-driven code |
| `via-gke.md` | Google Kubernetes Engine | Complex Kubernetes workloads |

## Quick Decision Guide

- **Default path**: `via-cloud-run.md` — `gcloud run deploy` for most containerized apps
- **Traditional PaaS**: `via-app-engine.md` — `gcloud app deploy` for managed runtimes
- **Serverless functions**: `via-cloud-functions.md` — event-driven compute
- **Kubernetes needs**: `via-gke.md` — full K8s control for complex architectures

## References

- [Google Cloud Hosting Options](https://cloud.google.com/hosting-options)
- [Cloud Run Documentation](https://cloud.google.com/run)
- [App Engine Documentation](https://cloud.google.com/appengine)
