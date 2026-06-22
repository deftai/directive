# Deploy via AWS App Runner

Deploy containerized web applications with minimal configuration using AWS App Runner. The simplest way to run containers on AWS without managing infrastructure.

## Overview

AWS App Runner makes container deployment simple:
- **Zero Configuration**: Deploy from source code or container registry
- **Automatic Scaling**: Scale based on traffic automatically
- **Built-in Load Balancing**: HTTPS endpoint included
- **Health Monitoring**: Automatic health checks and restarts
- **Pay-per-use**: Only pay for resources used

## Prerequisites

- AWS account with IAM permissions
- Application source code (GitHub) or container image (ECR)
- AWS CLI installed (optional)

## Quick Start from Source Code

### 1. Connect GitHub Repository

```bash
# Via AWS Console:
# 1. Go to App Runner console
# 2. Click "Create service"
# 3. Choose "Source code repository"
# 4. Connect to GitHub
# 5. Select repository and branch
```

### 2. Configure Build

App Runner auto-detects runtime or use `apprunner.yaml`:

```yaml
# apprunner.yaml
version: 1.0
runtime: python311
build:
  commands:
    pre-build:
      - pip install --upgrade pip
    build:
      - pip install -r requirements.txt
run:
  command: gunicorn --bind :8080 app:app
  network:
    port: 8080
  env:
    - name: APP_ENV
      value: production
```

### 3. Deploy

Once configured, App Runner automatically:
- Builds your application
- Creates container image
- Deploys to HTTPS endpoint
- Provides `.awsapprunner.com` URL

## Quick Start from Container Image

### 1. Push Image to ECR

```bash
# Authenticate to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com

# Create repository
aws ecr create-repository --repository-name my-app

# Build and tag image
docker build -t my-app .
docker tag my-app:latest \
  ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/my-app:latest

# Push image
docker push ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/my-app:latest
```

### 2. Create App Runner Service

```bash
# Create service from ECR image
aws apprunner create-service \
  --service-name my-app \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/my-app:latest",
      "ImageRepositoryType": "ECR",
      "ImageConfiguration": {
        "Port": "8080",
        "RuntimeEnvironmentVariables": {
          "APP_ENV": "production"
        }
      }
    },
    "AutoDeploymentsEnabled": true
  }' \
  --instance-configuration '{
    "Cpu": "1 vCPU",
    "Memory": "2 GB"
  }'
```

## Configuration File (apprunner.yaml)

### Node.js Application

```yaml
version: 1.0
runtime: nodejs18

build:
  commands:
    pre-build:
      - npm install
    build:
      - npm run build

run:
  command: npm start
  network:
    port: 3000
    env-vars:
      - PORT
  env:
    - name: NODE_ENV
      value: production
```

### Python Application

```yaml
version: 1.0
runtime: python311

build:
  commands:
    pre-build:
      - pip install -r requirements.txt
    build:
      - python -m compileall .

run:
  command: gunicorn --bind :8000 --workers 4 wsgi:app
  network:
    port: 8000
  env:
    - name: FLASK_ENV
      value: production
    - name: DATABASE_URL
      value: "{{resolve:secretsmanager:db-url}}"
```

### Go Application

```yaml
version: 1.0
runtime: go118

build:
  commands:
    build:
      - go build -o app main.go

run:
  command: ./app
  network:
    port: 8080
  env:
    - name: GIN_MODE
      value: release
```

### Ruby Application

```yaml
version: 1.0
runtime: ruby31

build:
  commands:
    pre-build:
      - bundle install
    build:
      - bundle exec rails assets:precompile

run:
  command: bundle exec rails server -b 0.0.0.0 -p 3000
  network:
    port: 3000
  env:
    - name: RAILS_ENV
      value: production
```

## Environment Variables & Secrets

### Configure via Console

```
1. Go to App Runner service
2. Configuration → Environment variables
3. Add plaintext or secret variables
```

### Configure via CLI

```bash
# Update service with environment variables
aws apprunner update-service \
  --service-arn arn:aws:apprunner:... \
  --source-configuration '{
    "ImageRepository": {
      "ImageConfiguration": {
        "RuntimeEnvironmentVariables": {
          "API_KEY": "value",
          "DATABASE_URL": "{{resolve:secretsmanager:db-credentials:SecretString:url}}"
        }
      }
    }
  }'
```

### Use AWS Secrets Manager

```yaml
# apprunner.yaml
env:
  - name: DB_PASSWORD
    value: "{{resolve:secretsmanager:my-secret:SecretString:password}}"
  - name: API_KEY
    value: "{{resolve:ssm:/my-app/api-key}}"
```

## Custom Domain & HTTPS

### Add Custom Domain

```bash
# Associate custom domain
aws apprunner associate-custom-domain \
  --service-arn arn:aws:apprunner:... \
  --domain-name api.example.com

# Get DNS validation records
aws apprunner describe-custom-domains \
  --service-arn arn:aws:apprunner:...

# Add CNAME records to your DNS provider
# App Runner provides validation records
```

### Automatic HTTPS

- App Runner automatically provisions SSL certificates
- Both `.awsapprunner.com` and custom domains get HTTPS
- Certificate renewal is automatic

## Auto Scaling

### Configure Scaling

```bash
# Set auto scaling configuration
aws apprunner create-auto-scaling-configuration \
  --auto-scaling-configuration-name my-config \
  --min-size 1 \
  --max-size 10 \
  --max-concurrency 100

# Apply to service
aws apprunner update-service \
  --service-arn arn:aws:apprunner:... \
  --auto-scaling-configuration-arn arn:aws:apprunner:...
```

### Scaling Parameters

```json
{
  "MinSize": 1,           // Minimum instances
  "MaxSize": 25,          // Maximum instances (default: 25)
  "MaxConcurrency": 100   // Requests per instance before scaling
}
```

## Instance Configuration

### CPU and Memory Options

```bash
# Configure instance size
aws apprunner update-service \
  --service-arn arn:aws:apprunner:... \
  --instance-configuration '{
    "Cpu": "2 vCPU",
    "Memory": "4 GB"
  }'
```

**Available sizes:**
- `0.25 vCPU` / `0.5 GB` - Minimum
- `0.5 vCPU` / `1 GB`
- `1 vCPU` / `2 GB` - Default
- `2 vCPU` / `4 GB`
- `4 vCPU` / `12 GB` - Maximum

## VPC Connector (Private Resources)

### Connect to VPC Resources

```bash
# Create VPC connector
aws apprunner create-vpc-connector \
  --vpc-connector-name my-connector \
  --subnets subnet-xxx subnet-yyy \
  --security-groups sg-xxx

# Associate with service
aws apprunner update-service \
  --service-arn arn:aws:apprunner:... \
  --network-configuration '{
    "EgressConfiguration": {
      "EgressType": "VPC",
      "VpcConnectorArn": "arn:aws:apprunner:..."
    }
  }'
```

### Access RDS Database

```yaml
# apprunner.yaml with VPC access
run:
  network:
    port: 8080
  env:
    - name: DATABASE_URL
      value: "postgresql://user:pass@rds-instance.region.rds.amazonaws.com:5432/db"
```

## Health Checks

### Configure Health Check

```bash
aws apprunner update-service \
  --service-arn arn:aws:apprunner:... \
  --health-check-configuration '{
    "Protocol": "HTTP",
    "Path": "/health",
    "Interval": 10,
    "Timeout": 5,
    "HealthyThreshold": 1,
    "UnhealthyThreshold": 5
  }'
```

### Health Check Options

```json
{
  "Protocol": "HTTP",          // HTTP or TCP
  "Path": "/health",           // Health check endpoint
  "Interval": 10,              // Seconds between checks
  "Timeout": 5,                // Seconds to wait for response
  "HealthyThreshold": 1,       // Successes to mark healthy
  "UnhealthyThreshold": 5      // Failures to mark unhealthy
}
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy to App Runner

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      
      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v1
      
      - name: Build and push image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          ECR_REPOSITORY: my-app
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
      
      - name: Deploy to App Runner
        run: |
          aws apprunner update-service \
            --service-arn ${{ secrets.APPRUNNER_SERVICE_ARN }} \
            --source-configuration '{
              "ImageRepository": {
                "ImageIdentifier": "${{ steps.login-ecr.outputs.registry }}/my-app:${{ github.sha }}",
                "ImageRepositoryType": "ECR"
              }
            }'
```

### Automatic Deployments from ECR

```bash
# Enable automatic deployments
aws apprunner update-service \
  --service-arn arn:aws:apprunner:... \
  --source-configuration '{
    "AutoDeploymentsEnabled": true,
    "ImageRepository": {
      "ImageIdentifier": "ACCOUNT_ID.dkr.ecr.region.amazonaws.com/my-app:latest",
      "ImageRepositoryType": "ECR"
    }
  }'
```

## Monitoring & Logging

### CloudWatch Logs

```bash
# View application logs
aws logs tail /aws/apprunner/my-app/application --follow

# View service logs
aws logs tail /aws/apprunner/my-app/service --follow
```

### CloudWatch Metrics

Available metrics:
- `2xxStatusResponses` - Successful requests
- `4xxStatusResponses` - Client errors
- `5xxStatusResponses` - Server errors
- `RequestCount` - Total requests
- `ActiveInstances` - Running instances
- `RequestLatency` - Response time

### X-Ray Tracing

```yaml
# apprunner.yaml with X-Ray
env:
  - name: AWS_XRAY_DAEMON_ADDRESS
    value: xray-daemon:2000
  - name: AWS_XRAY_TRACING_NAME
    value: my-app
```

## Database Integration

### Amazon RDS

```bash
# Create VPC connector for RDS access
aws apprunner create-vpc-connector \
  --vpc-connector-name rds-connector \
  --subnets subnet-private-1 subnet-private-2 \
  --security-groups sg-rds-access

# Store credentials in Secrets Manager
aws secretsmanager create-secret \
  --name my-app/db \
  --secret-string '{"host":"db.region.rds.amazonaws.com","user":"admin","password":"secret"}'
```

```yaml
# apprunner.yaml
env:
  - name: DB_HOST
    value: "{{resolve:secretsmanager:my-app/db:SecretString:host}}"
  - name: DB_USER
    value: "{{resolve:secretsmanager:my-app/db:SecretString:user}}"
  - name: DB_PASSWORD
    value: "{{resolve:secretsmanager:my-app/db:SecretString:password}}"
```

### DynamoDB

```yaml
# apprunner.yaml
env:
  - name: DYNAMODB_TABLE
    value: my-table
  - name: AWS_REGION
    value: us-east-1

# Grant IAM permissions via instance role
```

## Best Practices

1. **Use ECR for Production**: More control than source-based deploys
2. **Enable Auto Deployments**: Automatic updates when pushing new images
3. **Configure Health Checks**: Ensure proper endpoint monitoring
4. **Use Secrets Manager**: Never hardcode sensitive values
5. **Set Appropriate Scaling**: Match `MaxConcurrency` to application capacity
6. **Use VPC Connector**: For private database access
7. **Monitor Metrics**: Watch 4xx/5xx errors and latency
8. **Custom Domain**: Use custom domain for production
9. **Right-size Instances**: Start with 1 vCPU/2 GB, adjust based on metrics
10. **Tag Resources**: Use tags for cost tracking and organization

## Cost Optimization

```bash
# Set minimum instances to 1 (or 0 for very low traffic)
MinSize: 1

# Use smallest instance size that meets requirements
Cpu: "1 vCPU"
Memory: "2 GB"

# Set MaxConcurrency high to maximize instance utilization
MaxConcurrency: 100

# Use provisioned instances for predictable workloads
# Use autoscaling for variable traffic
```

## Troubleshooting

### Service Won't Start

```bash
# Check service status
aws apprunner describe-service --service-arn arn:aws:apprunner:...

# View logs
aws logs tail /aws/apprunner/my-app/service --follow

# Common issues:
# - Wrong port in configuration
# - Missing required environment variables
# - Application not listening on 0.0.0.0
```

### Health Check Failures

```bash
# Verify health endpoint returns 200
curl https://my-app.awsapprunner.com/health

# Check health check configuration
aws apprunner describe-service --service-arn ... \
  | jq '.Service.HealthCheckConfiguration'
```

### Can't Access VPC Resources

```bash
# Verify VPC connector configuration
aws apprunner describe-vpc-connector \
  --vpc-connector-arn arn:aws:apprunner:...

# Check security group rules allow traffic
# Check network ACLs
# Verify subnets have route to NAT gateway
```

## Limitations

- **Request Timeout**: 120 seconds maximum
- **Max Instances**: 25 per service (can request increase)
- **Port**: Single port per service (HTTP/HTTPS only)
- **Container Size**: 10 GB maximum image size
- **No Persistent Storage**: Use S3, EFS, or databases for persistence

## Comparison with Other Services

| Feature | App Runner | ECS Fargate | Elastic Beanstalk |
|---------|------------|-------------|-------------------|
| Setup Complexity | Minimal | Moderate | Moderate |
| Configuration | Auto-detected | Full control | Opinionated |
| Scaling | Automatic | Manual/Auto | Automatic |
| Load Balancer | Included | Separate | Included |
| Use Case | Simple web apps | Complex apps | Traditional PaaS |

## References

- [AWS App Runner Documentation](https://docs.aws.amazon.com/apprunner/)
- [App Runner Configuration File](https://docs.aws.amazon.com/apprunner/latest/dg/config-file.html)
- [App Runner Pricing](https://aws.amazon.com/apprunner/pricing/)
- [VPC Connector Guide](https://docs.aws.amazon.com/apprunner/latest/dg/network-vpc.html)
- [GitHub Actions Integration](https://docs.aws.amazon.com/apprunner/latest/dg/deploy-github.html)
