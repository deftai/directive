# Deploy via Cloud Run

Deploy containerized applications using Google Cloud Run. Fully managed serverless platform that automatically scales containers.

## Overview

Cloud Run provides:
- **Serverless Containers**: Run any containerized application
- **Auto-scaling**: Scale to zero, pay only for usage
- **Request-based Billing**: Pay per request and compute time
- **HTTPS Endpoints**: Automatic SSL certificates
- **Simple Deployment**: From source code or container images

## Prerequisites

- Google Cloud account with project
- gcloud CLI installed
- Docker (optional, can build remotely)
- Application code or container image

## Quick Start

### 1. Install gcloud CLI

```bash
# macOS
brew install google-cloud-sdk

# Initialize
gcloud init

# Authenticate
gcloud auth login
```

### 2. Deploy from Source

```bash
# Deploy directly from source (buildpacks)
gcloud run deploy myapp \
  --source . \
  --region us-central1 \
  --allow-unauthenticated

# Follow prompts, Cloud Run builds and deploys automatically
```

### 3. Deploy from Container Image

```bash
# Build with Cloud Build
gcloud builds submit --tag gcr.io/PROJECT_ID/myapp

# Deploy
gcloud run deploy myapp \
  --image gcr.io/PROJECT_ID/myapp \
  --region us-central1 \
  --allow-unauthenticated
```

## Deploy from Dockerfile

```bash
# Submit build
gcloud builds submit --tag gcr.io/PROJECT_ID/myapp

# Deploy with options
gcloud run deploy myapp \
  --image gcr.io/PROJECT_ID/myapp \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 10 \
  --set-env-vars "APP_ENV=production"
```

## Configuration

### Environment Variables

```bash
# Set environment variables
gcloud run services update myapp \
  --region us-central1 \
  --set-env-vars "APP_ENV=production,LOG_LEVEL=info"

# From file
gcloud run services update myapp \
  --region us-central1 \
  --env-vars-file .env.yaml
```

### Secrets

```bash
# Create secret in Secret Manager
echo -n "my-secret-value" | gcloud secrets create db-password --data-file=-

# Grant access to Cloud Run service account
gcloud secrets add-iam-policy-binding db-password \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Use secret in Cloud Run
gcloud run services update myapp \
  --region us-central1 \
  --set-secrets "DB_PASSWORD=db-password:latest"
```

### Resource Limits

```bash
gcloud run services update myapp \
  --region us-central1 \
  --memory 1Gi \
  --cpu 2 \
  --timeout 300 \
  --max-instances 100 \
  --min-instances 0
```

## Custom Domains

```bash
# Map custom domain
gcloud run services update myapp \
  --region us-central1 \
  --allow-unauthenticated

# Add domain mapping
gcloud run domain-mappings create \
  --service myapp \
  --domain www.example.com \
  --region us-central1

# Update DNS records as instructed
```

## Traffic Splitting

```bash
# Deploy new revision
gcloud run deploy myapp \
  --image gcr.io/PROJECT_ID/myapp:v2 \
  --region us-central1 \
  --no-traffic

# Split traffic
gcloud run services update-traffic myapp \
  --region us-central1 \
  --to-revisions REVISION1=80,REVISION2=20
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/cloud-run.yml
name: Deploy to Cloud Run

on:
  push:
    branches: [main]

env:
  PROJECT_ID: my-project
  SERVICE: myapp
  REGION: us-central1

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - uses: google-github-actions/auth@v1
        with:
          credentials_json: ${{ secrets.GCP_CREDENTIALS }}
      
      - uses: google-github-actions/setup-gcloud@v1
      
      - name: Build and push
        run: |
          gcloud builds submit --tag gcr.io/$PROJECT_ID/$SERVICE
      
      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy $SERVICE \
            --image gcr.io/$PROJECT_ID/$SERVICE \
            --region $REGION \
            --platform managed \
            --allow-unauthenticated
```

### Cloud Build

```yaml
# cloudbuild.yaml
steps:
  # Build container image
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/myapp', '.']
  
  # Push to Container Registry
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/$PROJECT_ID/myapp']
  
  # Deploy to Cloud Run
  - name: 'gcr.io/cloud-builders/gcloud'
    args:
      - 'run'
      - 'deploy'
      - 'myapp'
      - '--image=gcr.io/$PROJECT_ID/myapp'
      - '--region=us-central1'
      - '--platform=managed'
      - '--allow-unauthenticated'

images:
  - 'gcr.io/$PROJECT_ID/myapp'
```

## VPC Access

```bash
# Create VPC connector
gcloud compute networks vpc-access connectors create myconnector \
  --network default \
  --region us-central1 \
  --range 10.8.0.0/28

# Use connector
gcloud run services update myapp \
  --region us-central1 \
  --vpc-connector myconnector \
  --vpc-egress all-traffic
```

## Database Integration

### Cloud SQL

```bash
# Connect to Cloud SQL
gcloud run services update myapp \
  --region us-central1 \
  --add-cloudsql-instances PROJECT_ID:REGION:INSTANCE_NAME \
  --set-env-vars "DB_HOST=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME"
```

### Firestore

```bash
# Set environment variable
gcloud run services update myapp \
  --region us-central1 \
  --set-env-vars "FIRESTORE_PROJECT_ID=PROJECT_ID"
```

## Monitoring

### View Logs

```bash
# Stream logs
gcloud run services logs tail myapp --region us-central1

# View recent logs
gcloud run services logs read myapp --region us-central1 --limit 100
```

### Metrics

Access Cloud Monitoring for:
- Request count
- Request latency
- Container CPU/memory usage
- Billable instance time

## Best Practices

1. **Use Cloud Build**: Build images remotely
2. **Scale to Zero**: Save costs for low-traffic services
3. **Set Max Instances**: Prevent runaway costs
4. **Use Secrets Manager**: Never hardcode secrets
5. **Health Checks**: Ensure container responds on /
6. **Minimum Instances**: Use for latency-sensitive apps
7. **VPC Connector**: For private resource access
8. **Traffic Splitting**: Test changes gradually
9. **Optimize Container**: Reduce cold start times
10. **Monitor Costs**: Set budget alerts

## Troubleshooting

```bash
# Check service status
gcloud run services describe myapp --region us-central1

# View revisions
gcloud run revisions list --service myapp --region us-central1

# Check IAM permissions
gcloud run services get-iam-policy myapp --region us-central1
```

## Cost Optimization

```bash
# Scale to zero when idle
--min-instances 0

# Right-size resources
--memory 512Mi --cpu 1

# Use request timeout
--timeout 60

# Monitor and optimize per-request costs
```

## References

- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Cloud Run Pricing](https://cloud.google.com/run/pricing)
- [Best Practices](https://cloud.google.com/run/docs/tips)
