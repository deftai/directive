# Deploy via Azure Functions

Deploy serverless functions using Azure Functions. Event-driven compute that scales automatically with consumption-based pricing.

## Overview

Azure Functions provides:
- **Serverless Compute**: No infrastructure management
- **Event-Driven**: Trigger from HTTP, timers, queues, and more
- **Multiple Languages**: C#, JavaScript, Python, Java, PowerShell
- **Durable Functions**: Stateful workflows
- **Flexible Hosting**: Consumption, Premium, and Dedicated plans

## Prerequisites

- Azure account with subscription
- Azure Functions Core Tools installed
- Azure CLI installed
- Runtime installed (Node.js, Python, etc.)

## Quick Start

### 1. Install Azure Functions Core Tools

```bash
# macOS
brew tap azure/functions
brew install azure-functions-core-tools@4

# Or via npm
npm install -g azure-functions-core-tools@4

# Verify
func --version
```

### 2. Create Function App

```bash
# Create local project
func init myapp --python

cd myapp

# Create HTTP trigger function
func new --name HttpTrigger --template "HTTP trigger"
```

### 3. Test Locally

```bash
# Start local runtime
func start

# Test function
curl http://localhost:7071/api/HttpTrigger
```

### 4. Deploy to Azure

```bash
# Login
az login

# Create resource group
az group create --name myapp-rg --location eastus

# Create storage account (required)
az storage account create \
  --name myappstorage \
  --resource-group myapp-rg \
  --location eastus \
  --sku Standard_LRS

# Create Function App
az functionapp create \
  --name myapp \
  --resource-group myapp-rg \
  --consumption-plan-location eastus \
  --runtime python \
  --runtime-version 3.11 \
  --functions-version 4 \
  --storage-account myappstorage

# Deploy
func azure functionapp publish myapp
```

## Language-Specific Examples

### Python Function

```python
# function_app.py
import azure.functions as func
import logging

app = func.FunctionApp()

@app.function_name(name="HttpTrigger")
@app.route(route="hello", auth_level=func.AuthLevel.ANONYMOUS)
def http_trigger(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request.')
    
    name = req.params.get('name')
    if not name:
        try:
            req_body = req.get_json()
            name = req_body.get('name')
        except ValueError:
            pass
    
    if name:
        return func.HttpResponse(f"Hello, {name}!")
    else:
        return func.HttpResponse(
            "Please pass a name on the query string or in the request body",
            status_code=400
        )

@app.function_name(name="TimerTrigger")
@app.schedule(schedule="0 */5 * * * *", arg_name="timer")
def timer_trigger(timer: func.TimerRequest) -> None:
    logging.info('Timer trigger function ran')
```

### Node.js Function

```javascript
// src/functions/httpTrigger.js
const { app } = require('@azure/functions');

app.http('httpTrigger', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log('HTTP trigger function processed a request');
        
        const name = request.query.get('name') || await request.text() || 'World';
        
        return {
            status: 200,
            body: `Hello, ${name}!`
        };
    }
});

// Timer trigger
app.timer('timerTrigger', {
    schedule: '0 */5 * * * *',
    handler: (myTimer, context) => {
        context.log('Timer trigger function ran');
    }
});
```

### C# Function

```csharp
// HttpTrigger.cs
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;

namespace MyApp
{
    public class HttpTrigger
    {
        private readonly ILogger<HttpTrigger> _logger;

        public HttpTrigger(ILogger<HttpTrigger> logger)
        {
            _logger = logger;
        }

        [Function("HttpTrigger")]
        public IActionResult Run(
            [HttpTrigger(AuthorizationLevel.Anonymous, "get", "post")] HttpRequest req)
        {
            _logger.LogInformation("C# HTTP trigger function processed a request");
            
            string name = req.Query["name"];
            
            return new OkObjectResult($"Hello, {name ?? "World"}!");
        }
    }
}
```

## Triggers and Bindings

### HTTP Trigger

```python
@app.route(route="api/users/{id}", methods=["GET"])
def get_user(req: func.HttpRequest) -> func.HttpResponse:
    user_id = req.route_params.get('id')
    return func.HttpResponse(f"User ID: {user_id}")
```

### Timer Trigger

```python
# Runs every day at 2 AM
@app.schedule(schedule="0 0 2 * * *", arg_name="timer")
def daily_job(timer: func.TimerRequest) -> None:
    logging.info('Daily job executed')
```

### Queue Trigger

```python
@app.queue_trigger(
    arg_name="msg",
    queue_name="myqueue",
    connection="AzureWebJobsStorage"
)
def queue_processor(msg: func.QueueMessage) -> None:
    logging.info(f'Processing queue message: {msg.get_body().decode()}')
```

### Blob Trigger

```python
@app.blob_trigger(
    arg_name="blob",
    path="container/{name}",
    connection="AzureWebJobsStorage"
)
def blob_processor(blob: func.InputStream) -> None:
    logging.info(f'Processing blob: {blob.name}, size: {blob.length} bytes')
```

### Event Hub Trigger

```python
@app.event_hub_message_trigger(
    arg_name="events",
    event_hub_name="myhub",
    connection="EventHubConnection"
)
def event_hub_processor(events: List[func.EventHubEvent]) -> None:
    for event in events:
        logging.info(f'Event: {event.get_body().decode()}')
```

### Cosmos DB Trigger

```python
@app.cosmos_db_trigger(
    arg_name="documents",
    database_name="mydb",
    collection_name="mycollection",
    connection_string_setting="CosmosDBConnection",
    lease_collection_name="leases",
    create_lease_collection_if_not_exists=True
)
def cosmos_processor(documents: func.DocumentList) -> None:
    for doc in documents:
        logging.info(f'Document modified: {doc["id"]}')
```

## Configuration

### Application Settings

```bash
# Set environment variables
az functionapp config appsettings set \
  --name myapp \
  --resource-group myapp-rg \
  --settings \
    APP_ENV=production \
    DATABASE_URL="@Microsoft.KeyVault(SecretUri=...)"
```

### Connection Strings

```bash
az functionapp config connection-string set \
  --name myapp \
  --resource-group myapp-rg \
  --connection-string-type SQLAzure \
  --settings \
    DefaultConnection="Server=..."
```

## Durable Functions

### Orchestrator Function

```python
import azure.durable_functions as df

@app.orchestration_trigger(context_name="context")
def orchestrator(context: df.DurableOrchestrationContext):
    # Chain activities
    result1 = yield context.call_activity("Activity1", "input1")
    result2 = yield context.call_activity("Activity2", result1)
    result3 = yield context.call_activity("Activity3", result2)
    
    return result3

@app.activity_trigger(input_name="input")
def activity1(input: str) -> str:
    return f"Activity1: {input}"
```

### Fan-out/Fan-in Pattern

```python
@app.orchestration_trigger(context_name="context")
def fan_out_fan_in(context: df.DurableOrchestrationContext):
    tasks = []
    
    # Fan-out: start parallel activities
    for i in range(10):
        tasks.append(context.call_activity("ProcessItem", i))
    
    # Fan-in: wait for all to complete
    results = yield context.task_all(tasks)
    
    total = sum(results)
    return total
```

## Hosting Plans

### Consumption Plan (Default)

```bash
az functionapp create \
  --name myapp \
  --resource-group myapp-rg \
  --consumption-plan-location eastus \
  --runtime python \
  --storage-account myappstorage
```

### Premium Plan

```bash
# Create Premium plan
az functionapp plan create \
  --name myapp-plan \
  --resource-group myapp-rg \
  --location eastus \
  --sku EP1

# Create function app on Premium plan
az functionapp create \
  --name myapp \
  --resource-group myapp-rg \
  --plan myapp-plan \
  --runtime python \
  --storage-account myappstorage
```

### Dedicated (App Service) Plan

```bash
# Create App Service plan
az appservice plan create \
  --name myapp-plan \
  --resource-group myapp-rg \
  --sku B1

# Create function app
az functionapp create \
  --name myapp \
  --resource-group myapp-rg \
  --plan myapp-plan \
  --runtime python \
  --storage-account myappstorage
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/azure-functions.yml
name: Deploy to Azure Functions

on:
  push:
    branches: [main]

env:
  AZURE_FUNCTIONAPP_NAME: myapp
  PYTHON_VERSION: '3.11'

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-python@v4
        with:
          python-version: ${{ env.PYTHON_VERSION }}
      
      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt
      
      - uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}
      
      - name: Deploy to Azure Functions
        uses: Azure/functions-action@v1
        with:
          app-name: ${{ env.AZURE_FUNCTIONAPP_NAME }}
          package: .
          scm-do-build-during-deployment: true
```

### Azure DevOps Pipeline

```yaml
# azure-pipelines.yml
trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

variables:
  functionAppName: 'myapp'
  pythonVersion: '3.11'

steps:
  - task: UsePythonVersion@0
    inputs:
      versionSpec: '$(pythonVersion)'
  
  - script: |
      pip install -r requirements.txt
    displayName: 'Install dependencies'
  
  - task: ArchiveFiles@2
    inputs:
      rootFolderOrFile: '$(System.DefaultWorkingDirectory)'
      includeRootFolder: false
      archiveType: 'zip'
      archiveFile: '$(Build.ArtifactStagingDirectory)/$(Build.BuildId).zip'
  
  - task: AzureFunctionApp@1
    inputs:
      azureSubscription: 'Azure-Subscription'
      appType: 'functionAppLinux'
      appName: '$(functionAppName)'
      package: '$(Build.ArtifactStagingDirectory)/$(Build.BuildId).zip'
```

## Monitoring

### Application Insights

```bash
# Enable Application Insights
az monitor app-insights component create \
  --app myapp-insights \
  --location eastus \
  --resource-group myapp-rg

# Link to Function App
APPINSIGHTS_KEY=$(az monitor app-insights component show \
  --app myapp-insights \
  --resource-group myapp-rg \
  --query instrumentationKey -o tsv)

az functionapp config appsettings set \
  --name myapp \
  --resource-group myapp-rg \
  --settings \
    APPINSIGHTS_INSTRUMENTATIONKEY=$APPINSIGHTS_KEY
```

### View Logs

```bash
# Stream logs
func azure functionapp logstream myapp

# Via Azure CLI
az webapp log tail \
  --name myapp \
  --resource-group myapp-rg
```

## Best Practices

1. **Use Consumption Plan**: For variable workloads
2. **Enable Application Insights**: Track all invocations
3. **Async/Await**: Use async functions for I/O operations
4. **Keep Functions Small**: Single responsibility
5. **Use Bindings**: Reduce boilerplate code
6. **Connection Pooling**: Reuse connections across invocations
7. **Error Handling**: Implement proper retry logic
8. **Cold Start Optimization**: Use Premium plan if needed
9. **Security**: Use managed identity for Azure resources
10. **Testing**: Write unit tests, use local runtime

## Troubleshooting

### Function Not Triggering

```bash
# Check function status
az functionapp function show \
  --name myapp \
  --resource-group myapp-rg \
  --function-name HttpTrigger

# View logs
func azure functionapp logstream myapp
```

### Performance Issues

```bash
# Check execution times in Application Insights
# Consider Premium plan for:
# - VNet integration
# - Unlimited execution duration
# - Pre-warmed instances
```

## Cost Optimization

```bash
# Consumption plan: Pay per execution
# - First 1M executions free
# - Optimize function duration
# - Use efficient triggers

# Premium plan: For predictable costs
# - Pre-warmed instances
# - No cold starts
```

## References

- [Azure Functions Documentation](https://docs.microsoft.com/azure/azure-functions/)
- [Functions Core Tools](https://docs.microsoft.com/azure/azure-functions/functions-run-local)
- [Durable Functions](https://docs.microsoft.com/azure/azure-functions/durable/)
- [Functions Pricing](https://azure.microsoft.com/pricing/details/functions/)
