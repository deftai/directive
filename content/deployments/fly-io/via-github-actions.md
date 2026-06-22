# Deploy via GitHub Actions

Automate Fly.io deployments using GitHub Actions for continuous integration and delivery. Deploy on every push with automated testing, secrets management, and multi-environment support.

## Overview

Fly.io provides official GitHub Actions for seamless CI/CD:
- **Automatic Deployments**: Deploy on push to main
- **PR Preview Apps**: Deploy preview environments for pull requests  
- **Multi-Environment**: Separate staging and production
- **Secrets Management**: Secure FLY_API_TOKEN handling
- **Matrix Deployments**: Deploy multiple apps in parallel

## Prerequisites

- GitHub repository with your application code
- Fly.io account
- Fly.io API token

## Quick Setup

### 1. Generate Fly.io API Token

```bash
# Generate deploy token
fly auth token

# Copy the token for GitHub secrets
```

### 2. Add GitHub Secrets

Go to repository → Settings → Secrets and variables → Actions

Add:
- `FLY_API_TOKEN` - Your Fly.io API token

### 3. Create Workflow File

Create `.github/workflows/fly.yml`:

```yaml
name: Deploy to Fly.io

on:
  push:
    branches:
      - main

jobs:
  deploy:
    name: Deploy app
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

## Official Fly.io Actions

### Setup flyctl Action

```yaml
- uses: superfly/flyctl-actions/setup-flyctl@master
  with:
    version: latest  # or specific version like 0.0.500
```

### Deploy Action

```yaml
- uses: superfly/flyctl-actions@master
  with:
    args: "deploy --remote-only"
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

## Workflow Examples

### Basic Production Deployment

```yaml
name: Fly Deploy

on:
  push:
    branches:
      - main

jobs:
  deploy:
    name: Deploy to production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup flyctl
        uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Deploy to Fly
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Deploy with Tests

```yaml
name: Test and Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
      
      - run: npm ci
      - run: npm test
      - run: npm run lint

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Multi-Environment Deployment

```yaml
name: Deploy Pipeline

on:
  push:
    branches:
      - main
      - staging

jobs:
  deploy-staging:
    if: github.ref == 'refs/heads/staging'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - run: flyctl deploy --app my-app-staging --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}

  deploy-production:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - run: flyctl deploy --app my-app-production --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### PR Preview Deployments

```yaml
name: PR Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  preview:
    runs-on: ubuntu-latest
    
    # Don't run on closed PRs unless we're cleaning up
    if: github.event.action != 'closed' || github.event.pull_request.merged == true
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Deploy PR Preview
        if: github.event.action != 'closed'
        run: |
          PR_NUMBER=${{ github.event.pull_request.number }}
          flyctl deploy \
            --app my-app-pr-$PR_NUMBER \
            --remote-only \
            --auto-confirm
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
      
      - name: Comment PR with URL
        if: github.event.action != 'closed'
        uses: actions/github-script@v7
        with:
          script: |
            const pr = ${{ github.event.pull_request.number }};
            github.rest.issues.createComment({
              issue_number: pr,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `🚀 Preview deployed: https://my-app-pr-${pr}.fly.dev`
            });
      
      - name: Destroy PR Preview
        if: github.event.action == 'closed'
        run: |
          PR_NUMBER=${{ github.event.pull_request.number }}
          flyctl apps destroy my-app-pr-$PR_NUMBER --yes || true
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Matrix Deploy (Multiple Apps)

```yaml
name: Deploy All Apps

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        app:
          - name: api
            path: ./apps/api
          - name: web
            path: ./apps/web
          - name: worker
            path: ./apps/worker
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Deploy ${{ matrix.app.name }}
        run: flyctl deploy --config ${{ matrix.app.path }}/fly.toml --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Deploy with Docker Build

```yaml
name: Docker Build and Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      
      - name: Build and push to Fly registry
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: registry.fly.io/my-app:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Deploy to Fly
        run: flyctl deploy --image registry.fly.io/my-app:${{ github.sha }}
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

## Advanced Configurations

### Database Migrations

```yaml
name: Deploy with Migrations

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Run database migrations
        run: |
          flyctl ssh console -C "npm run migrate"
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
      
      - name: Deploy application
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Canary Deployment

```yaml
name: Canary Deploy

on:
  push:
    branches: [main]

jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Deploy canary
        run: flyctl deploy --strategy canary --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
      
      - name: Wait and monitor
        run: sleep 300  # Wait 5 minutes
      
      - name: Check health metrics
        run: |
          STATUS=$(flyctl status --json | jq -r '.health_checks[0].status')
          if [ "$STATUS" != "passing" ]; then
            echo "Health checks failing, rolling back"
            flyctl releases rollback
            exit 1
          fi
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Multi-Region Deployment

```yaml
name: Multi-Region Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Deploy to multiple regions
        run: |
          flyctl deploy --remote-only
          flyctl regions add iad lhr syd
          flyctl scale count 3
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Deploy with Secrets

```yaml
name: Deploy with Runtime Secrets

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Set secrets
        run: |
          echo "${{ secrets.ENV_FILE }}" | flyctl secrets import
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
      
      - name: Deploy
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

## Deployment Strategies

### Blue-Green Deployment

```yaml
- name: Blue-Green Deploy
  run: flyctl deploy --strategy bluegreen --remote-only
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Rolling Deployment

```yaml
# Configure in fly.toml
[deploy]
  strategy = "rolling"
  max_unavailable = 1

# Then deploy normally
- run: flyctl deploy --remote-only
```

### Immediate Deployment

```yaml
# Deploy without waiting for health checks
- run: flyctl deploy --remote-only --now
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

## Monitoring & Notifications

### Slack Notifications

```yaml
name: Deploy with Notifications

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Deploy
        id: deploy
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
      
      - name: Notify Slack on success
        if: success()
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "✅ Deployed to Fly.io successfully",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "✅ *Deployment Successful*\nCommit: ${{ github.sha }}\nAuthor: ${{ github.actor }}"
                  }
                }
              ]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
      
      - name: Notify Slack on failure
        if: failure()
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "❌ Fly.io deployment failed"
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

### Post-Deployment Health Check

```yaml
- name: Health Check
  run: |
    sleep 30
    STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" https://my-app.fly.dev/health)
    if [ $STATUS_CODE -ne 200 ]; then
      echo "Health check failed with status $STATUS_CODE"
      flyctl releases rollback
      exit 1
    fi
```

## Best Practices

### 1. Use GitHub Environments

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production  # Requires manual approval
```

### 2. Pin flyctl Version

```yaml
- uses: superfly/flyctl-actions/setup-flyctl@master
  with:
    version: 0.0.500  # Pin to specific version
```

### 3. Secure Secrets

```bash
# Use GitHub environment secrets for sensitive data
# Never commit FLY_API_TOKEN to repository
```

### 4. Deploy on Merge Only

```yaml
on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  deploy:
    if: github.event.pull_request.merged == true
```

### 5. Use Build Cache

```yaml
- uses: docker/build-push-action@v5
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

## Troubleshooting

### Deployment Timeout

```yaml
- name: Deploy with longer timeout
  run: flyctl deploy --remote-only --wait-timeout 900
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Debug Mode

```yaml
- name: Deploy with verbose logging
  run: flyctl deploy --remote-only --verbose
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
    FLY_LOG_LEVEL: debug
```

### Authentication Issues

```yaml
- name: Verify authentication
  run: flyctl auth whoami
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

## Complete Example

```yaml
name: Complete CI/CD Pipeline

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize]

env:
  FLY_APP_NAME: my-app

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
      
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build

  deploy-preview:
    if: github.event_name == 'pull_request'
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Deploy PR preview
        run: |
          PR_NUMBER=${{ github.event.pull_request.number }}
          flyctl deploy \
            --app ${{ env.FLY_APP_NAME }}-pr-$PR_NUMBER \
            --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}

  deploy-production:
    if: github.ref == 'refs/heads/main'
    needs: test
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      
      - uses: superfly/flyctl-actions/setup-flyctl@master
      
      - name: Deploy to production
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
      
      - name: Health check
        run: |
          sleep 30
          curl -f https://${{ env.FLY_APP_NAME }}.fly.dev/health || (
            flyctl releases rollback && exit 1
          )
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
      
      - name: Notify team
        if: success()
        run: echo "Deployed successfully to production"
```

## References

- [Fly.io GitHub Actions](https://fly.io/docs/app-guides/continuous-deployment-with-github-actions/)
- [flyctl-actions Repository](https://github.com/superfly/flyctl-actions)
- [GitHub Actions Documentation](https://docs.github.com/actions)
- [Deployment Strategies](https://fly.io/docs/reference/deployment/)
