# Deploy via Elastic Beanstalk

Deploy applications using AWS Elastic Beanstalk, a Platform-as-a-Service (PaaS) that handles infrastructure provisioning, load balancing, auto-scaling, and monitoring.

## Overview

Elastic Beanstalk simplifies application deployment:
- **Managed Platform**: Infrastructure automatically provisioned
- **Multi-Language Support**: Python, Node.js, Java, .NET, PHP, Ruby, Go, Docker
- **Auto-scaling**: Built-in scaling based on metrics
- **Load Balancing**: Automatic load balancer setup
- **Monitoring**: CloudWatch integration included

## Prerequisites

- AWS account with IAM permissions
- EB CLI installed
- Application code
- AWS CLI (optional)

## Quick Start

### 1. Install EB CLI

```bash
# Via pip
pip install awsebcli --upgrade --user

# Verify installation
eb --version
```

### 2. Initialize Application

```bash
# Navigate to project directory
cd my-app

# Initialize Elastic Beanstalk
eb init

# Follow prompts:
# - Select region
# - Choose or create application
# - Select platform (Python, Node.js, etc.)
# - Set up CodeCommit (optional)
# - Set up SSH (optional)
```

### 3. Create Environment and Deploy

```bash
# Create environment and deploy
eb create production

# Or specify options
eb create production \
  --instance-type t3.small \
  --envvars KEY1=value1,KEY2=value2
```

### 4. Manage Application

```bash
# Check status
eb status

# View logs
eb logs

# Open in browser
eb open

# Deploy updates
eb deploy
```

## Platform-Specific Configurations

### Node.js Application

```json
// package.json
{
  "name": "my-app",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  },
  "engines": {
    "node": "18.x"
  }
}
```

```yaml
# .ebextensions/nodecommand.config
option_settings:
  aws:elasticbeanstalk:container:nodejs:
    NodeCommand: "npm start"
    ProxyServer: nginx
```

### Python Application

```txt
# requirements.txt
Flask==2.3.0
gunicorn==20.1.0
```

```yaml
# .ebextensions/python.config
option_settings:
  aws:elasticbeanstalk:container:python:
    WSGIPath: application:application
    NumProcesses: 4
    NumThreads: 2
```

### Java Application

```xml
<!-- pom.xml -->
<build>
  <plugins>
    <plugin>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-maven-plugin</artifactId>
    </plugin>
  </plugins>
  <finalName>application</finalName>
</build>
```

### Docker Single Container

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
```

```json
// Dockerrun.aws.json
{
  "AWSEBDockerrunVersion": "1",
  "Image": {
    "Name": "my-app:latest",
    "Update": "true"
  },
  "Ports": [
    {
      "ContainerPort": 3000
    }
  ],
  "Volumes": [],
  "Logging": "/var/log/nginx"
}
```

### Docker Multi-Container

```json
// Dockerrun.aws.json (v2)
{
  "AWSEBDockerrunVersion": 2,
  "containerDefinitions": [
    {
      "name": "nginx",
      "image": "nginx:latest",
      "essential": true,
      "memory": 128,
      "portMappings": [
        {
          "hostPort": 80,
          "containerPort": 80
        }
      ],
      "links": ["app"]
    },
    {
      "name": "app",
      "image": "my-app:latest",
      "essential": true,
      "memory": 512,
      "portMappings": [
        {
          "hostPort": 8080,
          "containerPort": 8080
        }
      ]
    }
  ]
}
```

## Configuration with .ebextensions

### Environment Variables

```yaml
# .ebextensions/env-vars.config
option_settings:
  aws:elasticbeanstalk:application:environment:
    APP_ENV: production
    LOG_LEVEL: info
    DATABASE_URL: "{{resolve:secretsmanager:db-url}}"
```

### Instance Configuration

```yaml
# .ebextensions/instances.config
option_settings:
  aws:autoscaling:launchconfiguration:
    InstanceType: t3.medium
    RootVolumeSize: 20
    EC2KeyName: my-keypair
  
  aws:autoscaling:asg:
    MinSize: 2
    MaxSize: 10
  
  aws:elasticbeanstalk:environment:
    LoadBalancerType: application
    EnvironmentType: LoadBalanced
```

### Load Balancer

```yaml
# .ebextensions/alb.config
option_settings:
  aws:elbv2:listener:default:
    Protocol: HTTP
    Rules: forward
  
  aws:elbv2:listener:443:
    Protocol: HTTPS
    SSLCertificateArns: arn:aws:acm:region:account:certificate/id
    Rules: forward
  
  aws:elasticbeanstalk:environment:process:default:
    HealthCheckPath: /health
    HealthCheckTimeout: 5
    HealthCheckInterval: 30
    HealthyThresholdCount: 2
    UnhealthyThresholdCount: 5
```

### Custom Commands

```yaml
# .ebextensions/commands.config
commands:
  01_install_dependencies:
    command: "yum install -y postgresql-devel"
  
  02_migrate_database:
    command: "python manage.py migrate"
    leader_only: true

container_commands:
  01_collectstatic:
    command: "python manage.py collectstatic --noinput"
  
  02_create_superuser:
    command: "python scripts/create_admin.py"
    leader_only: true
```

### Files

```yaml
# .ebextensions/files.config
files:
  "/etc/nginx/conf.d/proxy.conf":
    mode: "000644"
    owner: root
    group: root
    content: |
      client_max_body_size 50M;
  
  "/opt/elasticbeanstalk/tasks/taillogs.d/app.conf":
    mode: "000644"
    owner: root
    group: root
    content: |
      /var/log/app/*.log
```

## Deployment Strategies

### Rolling Deployments

```yaml
# .ebextensions/rolling.config
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Rolling
    BatchSizeType: Percentage
    BatchSize: 50
  
  aws:autoscaling:updatepolicy:rollingupdate:
    RollingUpdateEnabled: true
    MaxBatchSize: 2
    MinInstancesInService: 2
```

### Immutable Deployments

```yaml
# .ebextensions/immutable.config
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Immutable
    HealthCheckSuccessThreshold: OK
    IgnoreHealthCheck: false
    Timeout: "600"
```

### Blue/Green Deployments

```bash
# Create new environment (green)
eb create production-v2 --cname production-temp

# Test green environment
eb open production-v2

# Swap URLs (zero downtime)
eb swap production production-v2

# Terminate old environment
eb terminate production-v2
```

## Environment Management

### Multiple Environments

```bash
# Create staging environment
eb create staging --branch-default

# Create production environment
eb create production

# Switch between environments
eb use staging
eb deploy

eb use production
eb deploy
```

### Saved Configurations

```bash
# Save current configuration
eb config save production --cfg production-config

# Apply saved configuration to new environment
eb create new-prod --cfg production-config
```

## Database Integration

### RDS Integration

```bash
# Create environment with RDS
eb create production \
  --database \
  --database.engine postgres \
  --database.username admin \
  --database.instance db.t3.micro
```

```python
# Access RDS credentials in application
import os

DB_HOST = os.environ['RDS_HOSTNAME']
DB_PORT = os.environ['RDS_PORT']
DB_NAME = os.environ['RDS_DB_NAME']
DB_USER = os.environ['RDS_USERNAME']
DB_PASSWORD = os.environ['RDS_PASSWORD']

DATABASE_URL = f"postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
```

### External Database

```yaml
# .ebextensions/database.config
option_settings:
  aws:elasticbeanstalk:application:environment:
    DATABASE_URL: "{{resolve:secretsmanager:prod/db/url}}"
```

## Auto-scaling

### Metric-Based Scaling

```yaml
# .ebextensions/autoscaling.config
option_settings:
  aws:autoscaling:asg:
    MinSize: 2
    MaxSize: 10
  
  aws:autoscaling:trigger:
    MeasureName: CPUUtilization
    Unit: Percent
    UpperThreshold: 75
    LowerThreshold: 25
    UpperBreachScaleIncrement: 2
    LowerBreachScaleIncrement: -1
```

### Time-Based Scaling

```yaml
# .ebextensions/scheduled-scaling.config
Resources:
  ScaleUpRule:
    Type: AWS::AutoScaling::ScheduledAction
    Properties:
      AutoScalingGroupName: !Ref AWSEBAutoScalingGroup
      MinSize: 5
      MaxSize: 10
      Recurrence: "0 8 * * MON-FRI"
  
  ScaleDownRule:
    Type: AWS::AutoScaling::ScheduledAction
    Properties:
      AutoScalingGroupName: !Ref AWSEBAutoScalingGroup
      MinSize: 2
      MaxSize: 5
      Recurrence: "0 18 * * MON-FRI"
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy to Elastic Beanstalk

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-python@v4
        with:
          python-version: '3.11'
      
      - name: Install EB CLI
        run: pip install awsebcli
      
      - uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      
      - name: Deploy to EB
        run: |
          eb init my-app --region us-east-1 --platform python-3.11
          eb use production
          eb deploy --staged --label ${{ github.sha }}
```

### AWS CodePipeline

```yaml
# buildspec.yml
version: 0.2

phases:
  install:
    runtime-versions:
      python: 3.11
    commands:
      - pip install -r requirements.txt
  
  build:
    commands:
      - python -m pytest tests/
      - echo "Build completed"

artifacts:
  files:
    - '**/*'
```

## Monitoring

### Enhanced Health Reporting

```yaml
# .ebextensions/health.config
option_settings:
  aws:elasticbeanstalk:healthreporting:system:
    SystemType: enhanced
    EnhancedHealthAuthEnabled: true
  
  aws:elasticbeanstalk:cloudwatch:logs:
    StreamLogs: true
    DeleteOnTerminate: false
    RetentionInDays: 7
```

### Custom CloudWatch Metrics

```yaml
# .ebextensions/cloudwatch.config
files:
  "/opt/aws/amazon-cloudwatch-agent/etc/config.json":
    mode: "000644"
    owner: root
    group: root
    content: |
      {
        "metrics": {
          "namespace": "MyApp",
          "metrics_collected": {
            "cpu": {
              "measurement": ["cpu_usage_idle"],
              "metrics_collection_interval": 60
            },
            "mem": {
              "measurement": ["mem_used_percent"],
              "metrics_collection_interval": 60
            }
          }
        }
      }
```

## Best Practices

1. **Use .ebextensions**: Version control all configuration
2. **Immutable Deployments**: Use for production zero-downtime
3. **Health Checks**: Configure meaningful health check endpoints
4. **Secrets Management**: Use Secrets Manager for sensitive data
5. **Environment Tiers**: Separate dev/staging/production
6. **Auto-scaling**: Configure based on actual load patterns
7. **Monitoring**: Enable enhanced health reporting
8. **Logging**: Stream logs to CloudWatch
9. **Database Separation**: Don't use coupled RDS (use external)
10. **Cost Management**: Right-size instances, use auto-scaling

## Troubleshooting

### View Logs

```bash
# Recent logs
eb logs

# Tail logs
eb logs --stream

# Download all logs
eb logs --all --zip
```

### SSH into Instances

```bash
# Enable SSH in .ebextensions or console
eb ssh

# SSH to specific instance
eb ssh --instance i-xxxxx
```

### Common Issues

**Deployment Fails**
```bash
# Check events
eb events --follow

# View health
eb health --refresh
```

**502/503 Errors**
- Check application is listening on correct port
- Verify health check endpoint returns 200
- Check security group allows ALB → instance traffic

## Cost Optimization

```yaml
# Use t3/t4g instances
# Enable auto-scaling to scale to zero during off-hours
# Use spot instances for dev/test
# Right-size based on CloudWatch metrics
```

## References

- [Elastic Beanstalk Documentation](https://docs.aws.amazon.com/elasticbeanstalk/)
- [EB CLI Reference](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/eb-cli3.html)
- [.ebextensions](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/ebextensions.html)
- [Platform Hooks](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/platforms-linux-extend.html)
