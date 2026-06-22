# Deploy via Azure Container Apps

Deploy microservices and containerized applications using Azure Container Apps. Serverless containers with auto-scaling, KEDA integration, and Dapr support.

## Overview

Azure Container Apps provides:
- **Serverless Containers**: Run containers without managing infrastructure
- **Auto-scaling**: Scale to zero, KEDA-based event-driven scaling
- **Dapr Integration**: Built-in microservices patterns
- **Revisions**: Blue-green and canary deployments
- **Ingress**: Automatic HTTPS and load balancing

## Prerequisites

- Azure account with subscription
- Azure CLI with containerapp extension
- Container image in registry (ACR, Docker Hub, etc.)
- Resource group created

## Quick Start

### 1. Install Container Apps Extension

```bash
# Install extension
az extension add --name containerapp --upgrade

# Verify
az containerapp --help
```

### 2. Create Environment

```bash
# Create Log Analytics workspace
az monitor log-analytics workspace create \
  --resource-group myapp-rg \
  --workspace-name myapp-logs \
  --location eastus

# Get workspace ID and key
WORKSPACE_ID=$(az monitor log-analytics workspace show \
  --resource-group myapp-rg \
  --workspace-name myapp-logs \
  --query customerId -o tsv)

WORKSPACE_KEY=$(az monitor log-analytics workspace get-shared-keys \
  --resource-group myapp-rg \
  --workspace-name myapp-logs \
  --query primarySharedKey -o tsv)

# Create Container Apps environment
az containerapp env create \
  --name myapp-env \
  --resource-group myapp-rg \
  --location eastus \
  --logs-workspace-id $WORKSPACE_ID \
  --logs-workspace-key $WORKSPACE_KEY
```

### 3. Deploy Container App

```bash
# Deploy from container image
az containerapp create \
  --name myapp \
  --resource-group myapp-rg \
  --environment myapp-env \
  --image myregistry.azurecr.io/myapp:latest \
  --target-port 8080 \
  --ingress external \
  --min-replicas 0 \
  --max-replicas 10
```

## Deployment from Different Sources

### From Azure Container Registry (ACR)

```bash
# Create ACR
az acr create \
  --name myregistry \
  --resource-group myapp-rg \
  --sku Basic

# Build and push image
az acr build \
  --registry myregistry \
  --image myapp:latest \
  --file Dockerfile .

# Deploy with managed identity
az containerapp create \
  --name myapp \
  --resource-group myapp-rg \
  --environment myapp-env \
  --image myregistry.azurecr.io/myapp:latest \
  --registry-server myregistry.azurecr.io \
  --registry-identity system \
  --target-port 8080 \
  --ingress external
```

### From Docker Hub

```bash
az containerapp create \
  --name myapp \
  --resource-group myapp-rg \
  --environment myapp-env \
  --image docker.io/library/nginx:latest \
  --target-port 80 \
  --ingress external
```

### From Private Registry

```bash
# Store credentials in secret
az containerapp create \
  --name myapp \
  --resource-group myapp-rg \
  --environment myapp-env \
  --image myregistry.io/myapp:latest \
  --registry-server myregistry.io \
  --registry-username myuser \
  --registry-password mypassword \
  --target-port 8080 \
  --ingress external
```

## Configuration

### Environment Variables

```bash
# Set environment variables
az containerapp update \
  --name myapp \
  --resource-group myapp-rg \
  --set-env-vars \
    APP_ENV=production \
    LOG_LEVEL=info \
    API_KEY=secretref:api-key
```

### Secrets

```bash
# Create secrets
az containerapp secret set \
  --name myapp \
  --resource-group myapp-rg \
  --secrets \
    api-key=my-secret-value \
    db-password=my-db-password

# Use secrets in environment variables
az containerapp update \
  --name myapp \
  --resource-group myapp-rg \
  --set-env-vars \
    API_KEY=secretref:api-key \
    DB_PASSWORD=secretref:db-password
```

### Resource Limits

```bash
az containerapp update \
  --name myapp \
  --resource-group myapp-rg \
  --cpu 1.0 \
  --memory 2.0Gi
```

## Ingress Configuration

### External Ingress (Public)

```bash
az containerapp ingress enable \
  --name myapp \
  --resource-group myapp-rg \
  --type external \
  --target-port 8080 \
  --transport auto
```

### Internal Ingress (VNet)

```bash
az containerapp ingress enable \
  --name myapp \
  --resource-group myapp-rg \
  --type internal \
  --target-port 8080
```

### Custom Domain

```bash
# Add custom domain
az containerapp hostname add \
  --name myapp \
  --resource-group myapp-rg \
  --hostname www.example.com

# Bind certificate
az containerapp hostname bind \
  --name myapp \
  --resource-group myapp-rg \
  --hostname www.example.com \
  --certificate cert-name \
  --environment myapp-env
```

## Scaling

### Scale Rules

```bash
# HTTP-based scaling
az containerapp update \
  --name myapp \
  --resource-group myapp-rg \
  --min-replicas 1 \
  --max-replicas 10 \
  --scale-rule-name http-rule \
  --scale-rule-type http \
  --scale-rule-http-concurrency 100
```

### KEDA Scaling

```bash
# Azure Queue scaling
az containerapp update \
  --name myapp \
  --resource-group myapp-rg \
  --scale-rule-name queue-rule \
  --scale-rule-type azure-queue \
  --scale-rule-metadata \
    queueName=myqueue \
    queueLength=10 \
    accountName=mystorageaccount \
  --scale-rule-auth secretRef=queue-connection-string
```

### CPU/Memory Scaling

```bash
az containerapp update \
  --name myapp \
  --resource-group myapp-rg \
  --scale-rule-name cpu-rule \
  --scale-rule-type cpu \
  --scale-rule-metadata \
    type=Utilization \
    value=75
```

## Revisions and Traffic Splitting

### Create New Revision

```bash
# Update with new image (creates new revision)
az containerapp update \
  --name myapp \
  --resource-group myapp-rg \
  --image myregistry.azurecr.io/myapp:v2
```

### Traffic Splitting (Blue-Green)

```bash
# Split traffic between revisions
az containerapp ingress traffic set \
  --name myapp \
  --resource-group myapp-rg \
  --revision-weight \
    myapp--rev1=80 \
    myapp--rev2=20
```

### Single Revision Mode

```bash
# Ensure only one revision is active
az containerapp revision set-mode \
  --name myapp \
  --resource-group myapp-rg \
  --mode single
```

### Multiple Revisions Mode

```bash
# Allow multiple active revisions
az containerapp revision set-mode \
  --name myapp \
  --resource-group myapp-rg \
  --mode multiple
```

## Dapr Integration

### Enable Dapr

```bash
az containerapp dapr enable \
  --name myapp \
  --resource-group myapp-rg \
  --dapr-app-id myapp \
  --dapr-app-port 8080 \
  --dapr-app-protocol http
```

### Dapr Components

```yaml
# dapr-state-store.yaml
componentType: state.redis
version: v1
metadata:
  - name: redisHost
    value: myredis.redis.cache.windows.net:6380
  - name: redisPassword
    secretRef: redis-password
  - name: enableTLS
    value: true
```

```bash
# Create Dapr component
az containerapp env dapr-component set \
  --name myapp-env \
  --resource-group myapp-rg \
  --dapr-component-name statestore \
  --yaml dapr-state-store.yaml
```

## Jobs (Scheduled/Event-Driven)

### Create Scheduled Job

```bash
az containerapp job create \
  --name myjob \
  --resource-group myapp-rg \
  --environment myapp-env \
  --trigger-type Schedule \
  --cron-expression "0 */6 * * *" \
  --image myregistry.azurecr.io/myjob:latest \
  --cpu 0.5 \
  --memory 1.0Gi \
  --replica-timeout 600
```

### Manual Job Execution

```bash
az containerapp job start \
  --name myjob \
  --resource-group myapp-rg
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/azure-container-apps.yml
name: Deploy to Azure Container Apps

on:
  push:
    branches: [main]

env:
  AZURE_CONTAINER_APP: myapp
  AZURE_RESOURCE_GROUP: myapp-rg
  AZURE_CONTAINER_REGISTRY: myregistry

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}
      
      - name: Build and push image
        run: |
          az acr build \
            --registry ${{ env.AZURE_CONTAINER_REGISTRY }} \
            --image ${{ env.AZURE_CONTAINER_APP }}:${{ github.sha }} \
            --file Dockerfile .
      
      - name: Deploy to Container Apps
        uses: azure/container-apps-deploy-action@v1
        with:
          containerAppName: ${{ env.AZURE_CONTAINER_APP }}
          resourceGroup: ${{ env.AZURE_RESOURCE_GROUP }}
          imageToDeploy: ${{ env.AZURE_CONTAINER_REGISTRY }}.azurecr.io/${{ env.AZURE_CONTAINER_APP }}:${{ github.sha }}
```

### Azure DevOps Pipeline

```yaml
# azure-pipelines.yml
trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

variables:
  containerRegistry: 'myregistry.azurecr.io'
  containerApp: 'myapp'
  resourceGroup: 'myapp-rg'

stages:
  - stage: Build
    jobs:
      - job: Build
        steps:
          - task: Docker@2
            inputs:
              containerRegistry: 'ACR-Connection'
              repository: $(containerApp)
              command: 'buildAndPush'
              Dockerfile: '**/Dockerfile'
              tags: |
                $(Build.BuildId)
                latest

  - stage: Deploy
    jobs:
      - job: Deploy
        steps:
          - task: AzureCLI@2
            inputs:
              azureSubscription: 'Azure-Subscription'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                az containerapp update \
                  --name $(containerApp) \
                  --resource-group $(resourceGroup) \
                  --image $(containerRegistry)/$(containerApp):$(Build.BuildId)
```

## Monitoring & Logging

### View Logs

```bash
# Stream logs
az containerapp logs show \
  --name myapp \
  --resource-group myapp-rg \
  --follow

# Get logs from specific revision
az containerapp logs show \
  --name myapp \
  --resource-group myapp-rg \
  --revision myapp--rev1
```

### Metrics

```bash
# View metrics
az monitor metrics list \
  --resource /subscriptions/.../containerApps/myapp \
  --metric-names "Requests,CpuUsage,MemoryUsage"
```

### Application Insights

```bash
# Enable Application Insights
az containerapp update \
  --name myapp \
  --resource-group myapp-rg \
  --set-env-vars \
    APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=..."
```

## Networking

### VNet Integration

```bash
# Create VNet-integrated environment
az containerapp env create \
  --name myapp-env \
  --resource-group myapp-rg \
  --location eastus \
  --infrastructure-subnet-resource-id /subscriptions/.../subnets/containerapp-subnet \
  --internal-only
```

### Service-to-Service Communication

```bash
# Access another container app internally
# Use format: http://myapp.internal.{environment-domain}

# Get internal FQDN
az containerapp show \
  --name myapp \
  --resource-group myapp-rg \
  --query properties.configuration.ingress.fqdn -o tsv
```

## Best Practices

1. **Use Managed Identity**: Avoid storing credentials for ACR
2. **Enable Dapr**: For microservices patterns (state, pub/sub, bindings)
3. **Scale to Zero**: Save costs for non-critical workloads
4. **Use Revisions**: Test changes with traffic splitting
5. **Monitor with App Insights**: Track performance and errors
6. **VNet Integration**: For private workloads
7. **KEDA Scaling**: Use event-driven scaling for efficient resource usage
8. **Secrets Management**: Store secrets in Container Apps, not environment variables
9. **Health Probes**: Configure liveness and readiness probes
10. **Resource Limits**: Set appropriate CPU/memory limits

## Comparison with Other Services

| Feature | Container Apps | App Service | AKS |
|---------|---------------|-------------|-----|
| Complexity | Low | Low | High |
| Kubernetes | Managed | No | Full control |
| Scale to Zero | Yes | No | Manual |
| Dapr | Built-in | No | Manual |
| Price | Pay per use | Always on | Node-based |

## Troubleshooting

### Container Won't Start

```bash
# Check revision status
az containerapp revision list \
  --name myapp \
  --resource-group myapp-rg

# View system logs
az containerapp logs show \
  --name myapp \
  --resource-group myapp-rg \
  --type system
```

### Scaling Issues

```bash
# Check replica count
az containerapp replica list \
  --name myapp \
  --resource-group myapp-rg \
  --revision myapp--rev1

# Review scale rules
az containerapp show \
  --name myapp \
  --resource-group myapp-rg \
  --query properties.template.scale
```

## Cost Optimization

```bash
# Scale to zero for dev/test
--min-replicas 0 --max-replicas 10

# Right-size resources
--cpu 0.5 --memory 1.0Gi

# Use consumption plan (default)
# Monitor and optimize scale rules
```

## References

- [Azure Container Apps Documentation](https://docs.microsoft.com/azure/container-apps/)
- [KEDA Scalers](https://keda.sh/docs/scalers/)
- [Dapr Documentation](https://docs.dapr.io/)
- [Container Apps Pricing](https://azure.microsoft.com/pricing/details/container-apps/)
