# Deploy via GitHub Actions

Automate agent deployments using GitHub Actions for continuous integration and delivery. Push code to trigger automatic deployments with built-in testing, validation, and rollback capabilities.

## Overview

Agentuity integrates seamlessly with GitHub Actions to provide:
- **Automatic Deployments**: Deploy on push to main
- **Preview Deployments**: Unique URLs for every pull request
- **Environment Isolation**: Separate staging and production
- **Rollback Protection**: Automatic rollback on errors
- **Secrets Management**: Secure credential handling

## Prerequisites

- GitHub repository with your agent code
- Agentuity account
- Agentuity API key or GitHub App integration

## Quick Setup

### 1. Get Agentuity API Key

```bash
# Generate deployment API key
agentuity apikey create --name github-actions --scope deploy

# Copy the key for GitHub secrets
```

### 2. Add GitHub Secrets

Go to your repository → Settings → Secrets and variables → Actions

Add these secrets:
- `AGENTUITY_API_KEY` - Your Agentuity API key
- `AGENTUITY_PROJECT_ID` - Your project ID (optional)

### 3. Create Workflow File

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Agentuity

on:
  push:
    branches:
      - main
  pull_request:
    types: [opened, synchronize]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests
        run: npm test
      
      - name: Install Agentuity CLI
        run: |
          curl -fsS https://agentuity.sh | sh
          echo "$HOME/.agentuity/bin" >> $GITHUB_PATH
      
      - name: Deploy to Agentuity
        env:
          AGENTUITY_API_KEY: ${{ secrets.AGENTUITY_API_KEY }}
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            agentuity deploy --preview
          else
            agentuity deploy --production
          fi
```

## Workflow Examples

### Production Deployment

```yaml
name: Production Deploy

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: npm run build
      
      - name: Run tests
        run: npm test
      
      - name: Deploy to Agentuity
        uses: agentuity/deploy-action@v1
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          environment: production
```

### Multi-Environment with Manual Approval

```yaml
name: Deploy Pipeline

on:
  push:
    branches:
      - main

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test
      - run: npm run lint

  deploy-staging:
    needs: test
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: agentuity/deploy-action@v1
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          environment: staging

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: agentuity/deploy-action@v1
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          environment: production
          wait-for-completion: true
```

### Preview Deployments for PRs

```yaml
name: PR Preview

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy Preview
        uses: agentuity/deploy-action@v1
        id: deploy
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          preview: true
      
      - name: Comment PR
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `🚀 Preview deployed to: ${{ steps.deploy.outputs.url }}`
            })
```

### Canary Deployment

```yaml
name: Canary Deploy

on:
  workflow_dispatch:
    inputs:
      traffic_percentage:
        description: 'Percentage of traffic for canary'
        required: true
        default: '10'

jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy Canary
        uses: agentuity/deploy-action@v1
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          canary: true
          traffic-percentage: ${{ inputs.traffic_percentage }}
      
      - name: Monitor Canary
        run: |
          # Wait and check error rates
          sleep 300
          agentuity metrics error-rate --last 5m
      
      - name: Promote or Rollback
        run: |
          ERROR_RATE=$(agentuity metrics error-rate --last 5m --json | jq -r '.rate')
          if (( $(echo "$ERROR_RATE < 0.01" | bc -l) )); then
            agentuity canary promote
          else
            agentuity canary rollback
          fi
```

## Agentuity Deploy Action

### Basic Usage

```yaml
- uses: agentuity/deploy-action@v1
  with:
    api-key: ${{ secrets.AGENTUITY_API_KEY }}
```

### All Options

```yaml
- uses: agentuity/deploy-action@v1
  id: deploy
  with:
    # Required
    api-key: ${{ secrets.AGENTUITY_API_KEY }}
    
    # Optional
    project-id: my-agent
    environment: production  # or staging, preview
    preview: false  # Set true for PR previews
    wait-for-completion: true
    timeout: 600  # seconds
    
    # Canary options
    canary: false
    traffic-percentage: 10
    
    # Build options
    working-directory: ./
    build-command: npm run build
    
    # Validation
    run-tests: true
    test-command: npm test
    
    # Deployment options
    regions: us-east-1,eu-west-1
    min-instances: 0
    max-instances: 10

outputs:
  url: ${{ steps.deploy.outputs.url }}
  deployment-id: ${{ steps.deploy.outputs.deployment-id }}
  version: ${{ steps.deploy.outputs.version }}
```

## Advanced Workflows

### Matrix Deployment (Multiple Agents)

```yaml
name: Deploy All Agents

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        agent: [chat, search, analytics]
    steps:
      - uses: actions/checkout@v4
      
      - uses: agentuity/deploy-action@v1
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          project-id: ${{ matrix.agent }}
          working-directory: ./agents/${{ matrix.agent }}
```

### Scheduled Deployments

```yaml
name: Nightly Deploy

on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM daily
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: agentuity/deploy-action@v1
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          environment: staging
```

### Deployment with Notifications

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
      
      - name: Deploy
        id: deploy
        uses: agentuity/deploy-action@v1
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
      
      - name: Slack Notification
        if: success()
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "✅ Agent deployed: ${{ steps.deploy.outputs.url }}"
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
      
      - name: Slack Failure
        if: failure()
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "❌ Deployment failed: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

## Security Best Practices

### Using OIDC Instead of API Keys

```yaml
name: Deploy with OIDC

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Configure Agentuity credentials
        uses: agentuity/configure-credentials@v1
        with:
          role-to-assume: arn:agentuity:iam::deploy-role
          role-session-name: github-actions-deploy
      
      - name: Deploy
        run: agentuity deploy
```

### Secrets Scanning

```yaml
name: Security Scan

on: [push, pull_request]

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Run Trivy security scanner
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          scan-ref: '.'
      
      - name: Check for secrets
        uses: trufflesecurity/trufflehog@main
        with:
          path: ./
```

## Environment Configuration

### GitHub Environments

Configure in repository settings for manual approvals:

1. Go to Settings → Environments
2. Create `production` environment
3. Enable "Required reviewers"
4. Add reviewer list

```yaml
jobs:
  deploy:
    environment: production  # Requires approval
```

### Environment Variables

```yaml
env:
  AGENTUITY_PROJECT: my-agent
  NODE_ENV: production

jobs:
  deploy:
    steps:
      - name: Deploy
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: agentuity deploy
```

## Monitoring & Rollback

### Post-Deployment Verification

```yaml
- name: Verify Deployment
  run: |
    # Wait for deployment to stabilize
    sleep 30
    
    # Health check
    curl -f ${{ steps.deploy.outputs.url }}/health || exit 1
    
    # Check metrics
    ERROR_RATE=$(agentuity metrics error-rate --last 5m --json | jq -r '.rate')
    if (( $(echo "$ERROR_RATE > 0.05" | bc -l) )); then
      echo "High error rate detected"
      exit 1
    fi

- name: Rollback on Failure
  if: failure()
  run: agentuity rollback
```

### Automated Rollback

```yaml
name: Auto Rollback

on:
  workflow_dispatch:
    inputs:
      deployment-id:
        required: true

jobs:
  rollback:
    runs-on: ubuntu-latest
    steps:
      - name: Rollback Deployment
        uses: agentuity/rollback-action@v1
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          deployment-id: ${{ inputs.deployment-id }}
```

## Troubleshooting

### Deployment Fails

```yaml
- name: Debug on Failure
  if: failure()
  run: |
    echo "::group::Agentuity Logs"
    agentuity logs --tail 100
    echo "::endgroup::"
    
    echo "::group::Deployment Status"
    agentuity deploy status
    echo "::endgroup::"
```

### Timeout Issues

```yaml
- name: Deploy with Extended Timeout
  uses: agentuity/deploy-action@v1
  with:
    api-key: ${{ secrets.AGENTUITY_API_KEY }}
    timeout: 1200  # 20 minutes
    wait-for-completion: true
```

## Best Practices

1. **Use Environments**: Separate staging and production
2. **Enable Branch Protection**: Require PR reviews before deploying
3. **Test Before Deploy**: Always run tests in CI
4. **Use OIDC**: More secure than long-lived API keys
5. **Monitor Deployments**: Add health checks and metrics
6. **Automate Rollbacks**: Implement automatic rollback on errors
7. **Document Workflows**: Add comments and README

## Complete Example

```yaml
name: Complete CI/CD Pipeline

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize]

env:
  NODE_VERSION: '18'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build
      
      - name: Upload build artifacts
        uses: actions/upload-artifact@v3
        with:
          name: dist
          path: dist/

  deploy-preview:
    if: github.event_name == 'pull_request'
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/download-artifact@v3
        with:
          name: dist
          path: dist/
      
      - uses: agentuity/deploy-action@v1
        id: deploy
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          preview: true
      
      - uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `🚀 Preview: ${{ steps.deploy.outputs.url }}\n📊 [Logs](https://console.agentuity.com/deployments/${{ steps.deploy.outputs.deployment-id }})`
            })

  deploy-production:
    if: github.ref == 'refs/heads/main'
    needs: test
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/download-artifact@v3
        with:
          name: dist
          path: dist/
      
      - uses: agentuity/deploy-action@v1
        id: deploy
        with:
          api-key: ${{ secrets.AGENTUITY_API_KEY }}
          environment: production
          wait-for-completion: true
      
      - name: Verify Deployment
        run: |
          curl -f ${{ steps.deploy.outputs.url }}/health
          agentuity metrics error-rate --deployment ${{ steps.deploy.outputs.deployment-id }}
      
      - name: Notify Team
        if: success()
        run: |
          echo "✅ Deployed to production: ${{ steps.deploy.outputs.url }}"
```

## References

- [GitHub Actions Documentation](https://docs.github.com/actions)
- [Agentuity Deploy Action](https://github.com/agentuity/deploy-action)
- [OIDC with Agentuity](https://agentuity.dev/deployment/oidc)
- [Deployment Best Practices](https://agentuity.dev/deployment/best-practices)
