# Deploy via AWS Lambda

Deploy serverless functions and APIs using AWS Lambda with SAM (Serverless Application Model) or Serverless Framework. Event-driven compute without managing servers.

## Overview

AWS Lambda lets you run code in response to events:
- **Pay-per-use**: Only pay for compute time used
- **Auto-scaling**: Scales automatically with load
- **Event-driven**: Trigger from 200+ AWS services
- **Multiple Runtimes**: Python, Node.js, Java, Go, Ruby, .NET
- **Managed Infrastructure**: No servers to manage

## Prerequisites

- AWS account with appropriate IAM permissions
- AWS CLI installed and configured
- SAM CLI or Serverless Framework installed
- Application code

## Quick Start with SAM

### 1. Install SAM CLI

```bash
# macOS
brew install aws-sam-cli

# Or via pip
pip install aws-sam-cli

# Verify installation
sam --version
```

### 2. Initialize Project

```bash
# Create new SAM project
sam init

# Follow prompts:
# - Template: Hello World
# - Runtime: python3.11, nodejs18.x, etc.
# - Dependency manager: pip, npm, etc.
```

### 3. Project Structure

```
my-app/
├── template.yaml        # SAM/CloudFormation template
├── samconfig.toml       # SAM configuration
├── hello_world/
│   ├── app.py          # Lambda function code
│   └── requirements.txt
└── tests/
```

### 4. Deploy

```bash
# Build
sam build

# Deploy (guided first time)
sam deploy --guided

# Subsequent deploys
sam deploy
```

## SAM Template Example

### Simple HTTP API

```yaml
# template.yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: Simple HTTP API

Globals:
  Function:
    Timeout: 30
    MemorySize: 512
    Runtime: python3.11
    Environment:
      Variables:
        STAGE: prod

Resources:
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: app.lambda_handler
      Events:
        GetApi:
          Type: HttpApi
          Properties:
            Path: /hello
            Method: get
            
  # DynamoDB table
  DataTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: !Sub ${AWS::StackName}-data
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: id
          AttributeType: S
      KeySchema:
        - AttributeName: id
          KeyType: HASH

Outputs:
  ApiUrl:
    Description: API Gateway endpoint URL
    Value: !Sub "https://${ServerlessHttpApi}.execute-api.${AWS::Region}.amazonaws.com/"
```

### Lambda Function Code

```python
# src/app.py
import json
import boto3
import os

dynamodb = boto3.resource('dynamodb')
table_name = os.environ['TABLE_NAME']

def lambda_handler(event, context):
    """
    Lambda function handler for HTTP API
    """
    try:
        # Parse request
        body = json.loads(event.get('body', '{}'))
        
        # Business logic here
        result = process_data(body)
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps(result)
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }

def process_data(data):
    # Your business logic
    return {'message': 'Success', 'data': data}
```

## Advanced SAM Patterns

### Multi-Function API

```yaml
Resources:
  # GET /users
  GetUsersFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/users/
      Handler: get.handler
      Events:
        GetUsers:
          Type: HttpApi
          Properties:
            Path: /users
            Method: get
  
  # POST /users
  CreateUserFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/users/
      Handler: create.handler
      Events:
        CreateUser:
          Type: HttpApi
          Properties:
            Path: /users
            Method: post
```

### With VPC Access

```yaml
Resources:
  VpcFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: app.handler
      VpcConfig:
        SecurityGroupIds:
          - !Ref LambdaSecurityGroup
        SubnetIds:
          - !Ref PrivateSubnet1
          - !Ref PrivateSubnet2
```

### With Layers

```yaml
Resources:
  SharedLayer:
    Type: AWS::Serverless::LayerVersion
    Properties:
      LayerName: shared-dependencies
      ContentUri: layers/shared/
      CompatibleRuntimes:
        - python3.11
  
  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: app.handler
      Layers:
        - !Ref SharedLayer
```

## Serverless Framework Alternative

### Installation

```bash
npm install -g serverless

# Create new project
serverless create --template aws-nodejs --path my-service

cd my-service
```

### serverless.yml Configuration

```yaml
service: my-api

provider:
  name: aws
  runtime: nodejs18.x
  region: us-east-1
  stage: ${opt:stage, 'dev'}
  environment:
    STAGE: ${self:provider.stage}
    TABLE_NAME: ${self:service}-${self:provider.stage}-data
  
  iam:
    role:
      statements:
        - Effect: Allow
          Action:
            - dynamodb:Query
            - dynamodb:Scan
            - dynamodb:GetItem
            - dynamodb:PutItem
          Resource: !GetAtt DataTable.Arn

functions:
  hello:
    handler: handler.hello
    events:
      - httpApi:
          path: /hello
          method: get
  
  create:
    handler: handler.create
    events:
      - httpApi:
          path: /items
          method: post

resources:
  Resources:
    DataTable:
      Type: AWS::DynamoDB::Table
      Properties:
        TableName: ${self:provider.environment.TABLE_NAME}
        BillingMode: PAY_PER_REQUEST
        AttributeDefinitions:
          - AttributeName: id
            AttributeType: S
        KeySchema:
          - AttributeName: id
            KeyType: HASH
```

### Deploy with Serverless Framework

```bash
# Deploy all
serverless deploy

# Deploy single function
serverless deploy function -f hello

# Remove stack
serverless remove
```

## Event Sources

### API Gateway HTTP API

```yaml
Events:
  HttpApi:
    Type: HttpApi
    Properties:
      Path: /users/{id}
      Method: get
      Auth:
        Authorizer: NONE
```

### API Gateway REST API

```yaml
Events:
  RestApi:
    Type: Api
    Properties:
      Path: /users/{id}
      Method: get
      RestApiId: !Ref MyRestApi
```

### S3 Events

```yaml
Events:
  S3Upload:
    Type: S3
    Properties:
      Bucket: !Ref UploadBucket
      Events: s3:ObjectCreated:*
      Filter:
        S3Key:
          Rules:
            - Name: suffix
              Value: .jpg
```

### DynamoDB Streams

```yaml
Events:
  DynamoStream:
    Type: DynamoDB
    Properties:
      Stream: !GetAtt DataTable.StreamArn
      StartingPosition: TRIM_HORIZON
      BatchSize: 10
```

### EventBridge (CloudWatch Events)

```yaml
Events:
  Schedule:
    Type: Schedule
    Properties:
      Schedule: rate(5 minutes)
      Input: '{"key": "value"}'
```

### SQS Queue

```yaml
Events:
  QueueProcessor:
    Type: SQS
    Properties:
      Queue: !GetAtt MyQueue.Arn
      BatchSize: 10
```

## Configuration Management

### Environment Variables

```yaml
# template.yaml
Resources:
  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      Environment:
        Variables:
          DATABASE_URL: !Sub "{{resolve:secretsmanager:${DatabaseSecret}:SecretString:url}}"
          API_KEY: !Sub "{{resolve:ssm:/${AWS::StackName}/api-key}}"
          STAGE: !Ref Stage
```

### Parameter Store

```bash
# Store secrets
aws ssm put-parameter \
  --name "/my-app/api-key" \
  --value "secret-value" \
  --type SecureString

# Reference in template
DATABASE_URL: !Sub "{{resolve:ssm:/my-app/db-url}}"
```

### Secrets Manager

```bash
# Store secret
aws secretsmanager create-secret \
  --name my-app/db-credentials \
  --secret-string '{"username":"admin","password":"secret"}'

# Reference in template
DB_SECRET: !Sub "{{resolve:secretsmanager:my-app/db-credentials}}"
```

## Local Development

### SAM Local

```bash
# Start local API
sam local start-api

# Invoke function locally
sam local invoke MyFunction -e events/event.json

# Generate sample event
sam local generate-event apigateway aws-proxy > event.json
```

### Serverless Offline

```bash
# Install plugin
npm install --save-dev serverless-offline

# Add to serverless.yml
plugins:
  - serverless-offline

# Run locally
serverless offline start
```

## Testing

### Unit Tests

```python
# tests/test_app.py
import pytest
from src import app

def test_lambda_handler():
    event = {
        'httpMethod': 'GET',
        'path': '/hello',
        'body': None
    }
    
    response = app.lambda_handler(event, None)
    
    assert response['statusCode'] == 200
    assert 'message' in response['body']
```

### Integration Tests

```bash
# Deploy to test environment
sam deploy --config-env test

# Run tests against deployed API
pytest tests/integration/

# Clean up
sam delete --stack-name my-app-test
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy Lambda

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: aws-actions/setup-sam@v2
      
      - uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      
      - name: Build and deploy
        run: |
          sam build
          sam deploy --no-confirm-changeset --no-fail-on-empty-changeset
```

## Monitoring and Logging

### CloudWatch Logs

```bash
# View logs
sam logs -n MyFunction --tail

# Filter logs
aws logs filter-log-events \
  --log-group-name /aws/lambda/MyFunction \
  --filter-pattern "ERROR"
```

### X-Ray Tracing

```yaml
# template.yaml
Globals:
  Function:
    Tracing: Active

# In code (Python)
from aws_xray_sdk.core import xray_recorder

@xray_recorder.capture('process_request')
def process_request(data):
    # Your code
    pass
```

### CloudWatch Metrics

```python
import boto3

cloudwatch = boto3.client('cloudwatch')

cloudwatch.put_metric_data(
    Namespace='MyApp',
    MetricData=[
        {
            'MetricName': 'ProcessedItems',
            'Value': 1,
            'Unit': 'Count'
        }
    ]
)
```

## Best Practices

1. **Keep Functions Small**: Single responsibility, < 50 MB package
2. **Use Layers**: Share dependencies across functions
3. **Optimize Cold Starts**: Minimize dependencies, use provisioned concurrency for critical paths
4. **Environment Variables**: Use for configuration, not secrets
5. **Secrets Management**: Always use Secrets Manager or Parameter Store
6. **Error Handling**: Implement proper error handling and retries
7. **Monitoring**: Enable X-Ray, CloudWatch Logs Insights
8. **IAM Least Privilege**: Grant minimum necessary permissions
9. **VPC Only When Needed**: VPC adds cold start latency
10. **Timeout Configuration**: Set appropriate timeout for workload

## Cost Optimization

```yaml
# Right-size memory (CPU scales with memory)
MemorySize: 512  # Test 128, 256, 512, 1024, etc.

# Set appropriate timeout
Timeout: 30  # Don't use max unless needed

# Use ARM architecture (Graviton2)
Architectures:
  - arm64

# Reserved concurrency for cost control
ReservedConcurrentExecutions: 100
```

## Troubleshooting

### Common Issues

**Cold Start Latency**
```yaml
# Use provisioned concurrency
ProvisionedConcurrencyConfig:
  ProvisionedConcurrentExecutions: 5
```

**Timeout Errors**
```yaml
# Increase timeout
Timeout: 60  # Up to 900 seconds (15 min)
```

**Memory Errors**
```yaml
# Increase memory
MemorySize: 1024  # Up to 10,240 MB
```

**Permission Errors**
```yaml
# Add IAM policies
Policies:
  - DynamoDBCrudPolicy:
      TableName: !Ref DataTable
```

## References

- [AWS SAM Documentation](https://docs.aws.amazon.com/serverless-application-model/)
- [AWS Lambda Documentation](https://docs.aws.amazon.com/lambda/)
- [Serverless Framework Docs](https://www.serverless.com/framework/docs)
- [Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)
- [SAM CLI Reference](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-command-reference.html)
