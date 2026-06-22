# Azure Deployment Module

Deft guidance for deploying applications to Microsoft Azure.

## Status

- ! Optional module
- ~ Good for Deft usage

## Overview

Azure provides enterprise-grade deployment options with strong Microsoft ecosystem integration.

## Deployment Methods

| File | Method | Best For |
|------|--------|----------|
| `via-app-service.md` | Azure App Service | Traditional web apps, APIs, multi-language PaaS (default for web apps) |
| `via-container-apps.md` | Azure Container Apps | Microservices, serverless containers, scale-to-zero (default for containers) |
| `via-functions.md` | Azure Functions | Serverless functions, event-driven workloads (default for serverless) |
| `via-aks.md` | Azure Kubernetes Service | Complex Kubernetes workloads, advanced orchestration |

## Quick Decision Guide

- **Default web apps**: `via-app-service.md` — `az webapp up` for Node.js, Python, .NET, Java, PHP, Ruby
- **Default containers**: `via-container-apps.md` — serverless containers with Dapr, KEDA, scale-to-zero
- **Default serverless**: `via-functions.md` — event-driven functions with consumption pricing
- **Complex orchestration**: `via-aks.md` — when you need full Kubernetes control

## References

- [Azure Compute Services](https://azure.microsoft.com/products/category/compute/)
- [Azure App Service Documentation](https://docs.microsoft.com/azure/app-service/)
- [Azure Container Apps Documentation](https://docs.microsoft.com/azure/container-apps/)
- [Azure Functions Documentation](https://docs.microsoft.com/azure/azure-functions/)
- [Azure Kubernetes Service Documentation](https://docs.microsoft.com/azure/aks/)
- [Azure Static Web Apps Documentation](https://docs.microsoft.com/azure/static-web-apps/)
