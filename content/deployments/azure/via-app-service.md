# Deploy via Azure App Service

Deploy web applications using Azure App Service, a fully managed Platform-as-a-Service (PaaS) for building, deploying, and scaling web apps.

## Overview

Azure App Service provides managed hosting:
- **Multi-Language Support**: .NET, Node.js, Python, Java, PHP, Ruby
- **Built-in CI/CD**: GitHub, Azure DevOps, Bitbucket integration
- **Auto-scaling**: Scale up/out automatically
- **Custom Domains & SSL**: Free SSL certificates
- **Deployment Slots**: Blue-green deployments built-in

## Prerequisites

- Azure account with subscription
- Azure CLI installed
- Application code
- Resource group created

## Quick Start

### 1. Install Azure CLI

```bash
# macOS
brew install azure-cli

# Or via installer
curl -L https://aka.ms/InstallAzureCli | bash

# Verify
az --version
```

### 2. Login and Create Resource Group

```bash
# Login
az login

# Create resource group
az group create --name myapp-rg --location eastus
```

### 3. Deploy Application

```bash
# Deploy from local directory (auto-detects runtime)
az webapp up \
  --name myapp \
  --resource-group myapp-rg \
  --runtime "NODE:18-lts"

# Or create and deploy separately
az appservice plan create \
  --name myapp-plan \
  --resource-group myapp-rg \
  --sku B1 \
  --is-linux

az webapp create \
  --name myapp \
  --resource-group myapp-rg \
  --plan myapp-plan \
  --runtime "NODE|18-lts"

# Deploy code
az webapp deploy \
  --name myapp \
  --resource-group myapp-rg \
  --src-path app.zip
```

## Runtime-Specific Deployments

### Node.js Application

```bash
# Create App Service
az webapp create \
  --name myapp \
  --resource-group myapp-rg \
  --plan myapp-plan \
  --runtime "NODE|18-lts"

# Configure startup command
az webapp config set \
  --name myapp \
  --resource-group myapp-rg \
  --startup-file "npm start"

# Deploy via ZIP
zip -r app.zip .
az webapp deploy \
  --name myapp \
  --resource-group myapp-rg \
  --src-path app.zip
```

### Python Application

```bash
# Create App Service
az webapp create \
  --name myapp \
  --resource-group myapp-rg \
  --plan myapp-plan \
  --runtime "PYTHON|3.11"

# Configure startup command
az webapp config set \
  --name myapp \
  --resource-group myapp-rg \
  --startup-file "gunicorn --bind=0.0.0.0 --timeout 600 app:app"

# Deploy
az webapp deploy \
  --name myapp \
  --resource-group myapp-rg \
  --src-path app.zip
```

### .NET Application

```bash
# Create App Service (Windows)
az webapp create \
  --name myapp \
  --resource-group myapp-rg \
  --plan myapp-plan \
  --runtime "DOTNET|7.0"

# Deploy
dotnet publish -c Release
cd bin/Release/net7.0/publish
zip -r ../../../app.zip .
cd ../../..

az webapp deploy \
  --name myapp \
  --resource-group myapp-rg \
  --src-path app.zip
```

### Java Application

```bash
# Create App Service
az webapp create \
  --name myapp \
  --resource-group myapp-rg \
  --plan myapp-plan \
  --runtime "JAVA|17-java17"

# Deploy JAR
mvn clean package
az webapp deploy \
  --name myapp \
  --resource-group myapp-rg \
  --src-path target/app.jar \
  --type jar
```

### Docker Container

```bash
# Create App Service for containers
az webapp create \
  --name myapp \
  --resource-group myapp-rg \
  --plan myapp-plan \
  --deployment-container-image-name myregistry.azurecr.io/myapp:latest

# Enable continuous deployment
az webapp deployment container config \
  --name myapp \
  --resource-group myapp-rg \
  --enable-cd true
```

## Configuration

### Environment Variables

```bash
# Set app settings (environment variables)
az webapp config appsettings set \
  --name myapp \
  --resource-group myapp-rg \
  --settings \
    APP_ENV=production \
    DATABASE_URL="@Microsoft.KeyVault(SecretUri=https://myvault.vault.azure.net/secrets/db-url/)"
```

### Connection Strings

```bash
# Add connection string
az webapp config connection-string set \
  --name myapp \
  --resource-group myapp-rg \
  --connection-string-type SQLAzure \
  --settings \
    DefaultConnection="Server=tcp:myserver.database.windows.net..."
```

### Custom Domain & SSL

```bash
# Add custom domain
az webapp config hostname add \
  --webapp-name myapp \
  --resource-group myapp-rg \
  --hostname www.example.com

# Bind SSL certificate
az webapp config ssl bind \
  --name myapp \
  --resource-group myapp-rg \
  --certificate-thumbprint THUMBPRINT \
  --ssl-type SNI
```

## Deployment Methods

### Git Deployment

```bash
# Enable local Git deployment
az webapp deployment source config-local-git \
  --name myapp \
  --resource-group myapp-rg

# Get Git URL
az webapp deployment list-publishing-credentials \
  --name myapp \
  --resource-group myapp-rg

# Deploy via Git
git remote add azure <git-url>
git push azure main
```

### GitHub Actions Deployment

```bash
# Configure GitHub deployment
az webapp deployment github-actions add \
  --name myapp \
  --resource-group myapp-rg \
  --repo "username/repo" \
  --branch main \
  --runtime-stack node \
  --runtime-version 18.x
```

```yaml
# .github/workflows/azure-webapps-node.yml
name: Deploy to Azure App Service

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: npm run build --if-present
      
      - uses: azure/webapps-deploy@v2
        with:
          app-name: myapp
          publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
          package: .
```

### Azure DevOps Pipeline

```yaml
# azure-pipelines.yml
trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

variables:
  azureSubscription: 'My-Azure-Subscription'
  webAppName: 'myapp'

stages:
  - stage: Build
    jobs:
      - job: Build
        steps:
          - task: NodeTool@0
            inputs:
              versionSpec: '18.x'
          
          - script: npm ci
            displayName: 'Install dependencies'
          
          - script: npm run build
            displayName: 'Build application'
          
          - task: ArchiveFiles@2
            inputs:
              rootFolderOrFile: '$(System.DefaultWorkingDirectory)'
              includeRootFolder: false
              archiveType: 'zip'
              archiveFile: '$(Build.ArtifactStagingDirectory)/$(Build.BuildId).zip'
          
          - publish: '$(Build.ArtifactStagingDirectory)/$(Build.BuildId).zip'
            artifact: drop

  - stage: Deploy
    dependsOn: Build
    jobs:
      - deployment: Deploy
        environment: 'production'
        strategy:
          runOnce:
            deploy:
              steps:
                - task: AzureWebApp@1
                  inputs:
                    azureSubscription: '$(azureSubscription)'
                    appName: '$(webAppName)'
                    package: '$(Pipeline.Workspace)/drop/$(Build.BuildId).zip'
```

## Deployment Slots

### Create Staging Slot

```bash
# Create deployment slot
az webapp deployment slot create \
  --name myapp \
  --resource-group myapp-rg \
  --slot staging

# Deploy to staging
az webapp deployment source config \
  --name myapp \
  --resource-group myapp-rg \
  --slot staging \
  --repo-url https://github.com/user/repo \
  --branch develop

# Swap slots (blue-green deployment)
az webapp deployment slot swap \
  --name myapp \
  --resource-group myapp-rg \
  --slot staging \
  --target-slot production
```

## Auto-scaling

### Scale Up (Vertical)

```bash
# Change pricing tier
az appservice plan update \
  --name myapp-plan \
  --resource-group myapp-rg \
  --sku P1V2
```

### Scale Out (Horizontal)

```bash
# Set instance count
az appservice plan update \
  --name myapp-plan \
  --resource-group myapp-rg \
  --number-of-workers 3

# Configure auto-scale rules
az monitor autoscale create \
  --resource-group myapp-rg \
  --resource myapp-plan \
  --resource-type Microsoft.Web/serverfarms \
  --name myapp-autoscale \
  --min-count 1 \
  --max-count 10 \
  --count 2

# CPU-based scaling
az monitor autoscale rule create \
  --resource-group myapp-rg \
  --autoscale-name myapp-autoscale \
  --condition "Percentage CPU > 75 avg 5m" \
  --scale out 2

az monitor autoscale rule create \
  --resource-group myapp-rg \
  --autoscale-name myapp-autoscale \
  --condition "Percentage CPU < 25 avg 5m" \
  --scale in 1
```

## Monitoring & Logging

### Enable Application Insights

```bash
# Create Application Insights
az monitor app-insights component create \
  --app myapp-insights \
  --location eastus \
  --resource-group myapp-rg

# Link to App Service
az webapp config appsettings set \
  --name myapp \
  --resource-group myapp-rg \
  --settings \
    APPINSIGHTS_INSTRUMENTATIONKEY="<key>"
```

### View Logs

```bash
# Stream logs
az webapp log tail \
  --name myapp \
  --resource-group myapp-rg

# Download logs
az webapp log download \
  --name myapp \
  --resource-group myapp-rg \
  --log-file logs.zip
```

## Database Integration

### Azure SQL Database

```bash
# Create SQL Server and database
az sql server create \
  --name myserver \
  --resource-group myapp-rg \
  --location eastus \
  --admin-user sqladmin \
  --admin-password <password>

az sql db create \
  --name mydb \
  --server myserver \
  --resource-group myapp-rg \
  --service-objective S0

# Add connection string to app
az webapp config connection-string set \
  --name myapp \
  --resource-group myapp-rg \
  --connection-string-type SQLAzure \
  --settings \
    DefaultConnection="Server=tcp:myserver.database.windows.net..."
```

### Azure Cosmos DB

```bash
# Create Cosmos DB account
az cosmosdb create \
  --name mycosmosdb \
  --resource-group myapp-rg

# Get connection string
az cosmosdb keys list \
  --name mycosmosdb \
  --resource-group myapp-rg \
  --type connection-strings

# Add to app settings
az webapp config appsettings set \
  --name myapp \
  --resource-group myapp-rg \
  --settings \
    COSMOS_DB_CONNECTION="<connection-string>"
```

## Best Practices

1. **Use Deployment Slots**: Test changes in staging before production
2. **Enable Application Insights**: Monitor performance and errors
3. **Use Managed Identity**: Avoid storing credentials
4. **Configure Auto-scaling**: Handle traffic spikes automatically
5. **Use Key Vault**: Store secrets securely
6. **Enable Always On**: Keep app warm (paid tiers only)
7. **Configure Health Checks**: Ensure automatic recovery
8. **Use CDN**: Serve static assets from edge locations
9. **Enable Diagnostic Logs**: Troubleshoot issues efficiently
10. **Tag Resources**: Organize and track costs

## Troubleshooting

### Application Won't Start

```bash
# Check logs
az webapp log tail \
  --name myapp \
  --resource-group myapp-rg

# Check configuration
az webapp config show \
  --name myapp \
  --resource-group myapp-rg
```

### Performance Issues

```bash
# Check metrics
az monitor metrics list \
  --resource /subscriptions/.../providers/Microsoft.Web/sites/myapp \
  --metric-names "CpuPercentage,MemoryPercentage,HttpResponseTime"

# Scale up if needed
az appservice plan update \
  --name myapp-plan \
  --resource-group myapp-rg \
  --sku P2V2
```

## Cost Optimization

```bash
# Use Free/Shared tier for development
az appservice plan create --sku F1

# Use Basic tier for small production apps
az appservice plan create --sku B1

# Enable auto-scaling to scale down during low traffic
# Stop app when not in use (dev/test)
az webapp stop --name myapp --resource-group myapp-rg
```

## References

- [Azure App Service Documentation](https://docs.microsoft.com/azure/app-service/)
- [Azure CLI Reference](https://docs.microsoft.com/cli/azure/webapp)
- [Deployment Best Practices](https://docs.microsoft.com/azure/app-service/deploy-best-practices)
- [App Service Pricing](https://azure.microsoft.com/pricing/details/app-service/)
