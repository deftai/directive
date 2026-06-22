# Deploy via Agentuity Managed Cloud

The simplest deployment path — let Agentuity handle all infrastructure while you focus on building agents. Global edge network with automatic scaling and zero configuration.

## Overview

Agentuity Managed Cloud provides:
- **Global Edge Network**: Deploy to 30+ regions worldwide
- **Sub-100ms Cold Starts**: Fast agent initialization
- **Automatic Scaling**: Scale from zero to demand
- **Managed Infrastructure**: SSL, DNS, load balancing handled automatically
- **Built-in Services**: Storage, databases, queues without setup

## Prerequisites

- Agentuity CLI installed
- Agentuity account (free tier available)
- Agent project ready to deploy

## Quick Deploy

### 1. Login to Agentuity

```bash
# Authenticate with Agentuity Cloud
agentuity auth login

# This opens browser for OAuth
# Or use API key: agentuity auth login --api-key YOUR_KEY
```

### 2. Deploy Your Agent

```bash
# From your project directory
agentuity deploy

# That's it! Your agent is now live.
```

### 3. Get Your URLs

After deployment, you'll receive:
- **Agent Endpoint**: `https://your-agent.agentuity.run`
- **API Documentation**: `https://your-agent.agentuity.run/docs`
- **Console Dashboard**: `https://console.agentuity.com/projects/your-agent`

## Features

### Automatic SSL & DNS

```bash
# SSL certificates provisioned automatically
# Custom domains supported:
agentuity domain add myagent.com

# DNS automatically configured
```

### Global Distribution

Your agent is automatically deployed to the edge locations closest to your users:
- North America (6 locations)
- Europe (8 locations)
- Asia Pacific (12 locations)
- South America (2 locations)
- Middle East (2 locations)

### Auto-Scaling

- **Scale to Zero**: No cost when idle
- **Instant Scale Up**: Handle traffic spikes automatically
- **Horizontal Scaling**: Multiple instances deployed automatically
- **Vertical Scaling**: Resources adjusted based on demand

## Built-In Services

### Storage Services

All available without configuration:

```typescript
// Key-Value Storage
import { kv } from '@agentuity/runtime';

await kv.set('user:123', { name: 'Alice' });
const user = await kv.get('user:123');

// Vector Storage
import { vector } from '@agentuity/runtime';

await vector.index('documents').add({
  id: '1',
  content: 'AI agents on Agentuity',
  embedding: embeddings
});

// Object Storage (S3-compatible)
import { storage } from '@agentuity/runtime';

await storage.put('avatars/user123.png', imageBuffer);
const url = await storage.getPublicUrl('avatars/user123.png');

// Postgres Database
import { db } from '@agentuity/runtime';

const users = await db.query('SELECT * FROM users WHERE active = true');
```

### AI Gateway

Unified access to all major LLM providers:

```typescript
import { ai } from '@agentuity/runtime';

// Single API key for all providers
const response = await ai.chat({
  model: 'openai:gpt-4',  // or 'anthropic:claude-3', etc.
  messages: [{ role: 'user', content: 'Hello!' }]
});

// Automatic failover between providers
// Consolidated billing
// Usage tracking per agent
```

### Sandboxes

Secure code execution environments:

```typescript
import { sandbox } from '@agentuity/runtime';

// Create, execute, destroy - fully managed
const result = await sandbox.execute({
  code: userCode,
  language: 'python',
  timeout: 30000
});
```

## Monitoring & Observability

### Console Dashboard

Access at `console.agentuity.com`:
- Real-time agent status
- Request/response logs
- Performance metrics
- Cost per request
- Error tracking

### OpenTelemetry Integration

Automatic tracing built-in:

```bash
# View traces
agentuity traces --agent chat --tail 20

# Export to your observability platform
# Supports: Datadog, New Relic, Honeycomb, etc.
```

### Logs

```bash
# Stream live logs
agentuity logs --follow

# Filter by severity
agentuity logs --level error

# Search logs
agentuity logs --search "API timeout"
```

## Cost Management

### Free Tier

- 1M requests/month
- 100GB storage
- 10GB transfer
- All features included

### Pricing

- **Requests**: $0.10 per 1M requests
- **Compute**: $0.00002 per second
- **Storage**: $0.15 per GB/month
- **Transfer**: $0.10 per GB

### Cost Tracking

```bash
# View current month costs
agentuity billing current

# Cost per agent
agentuity billing by-agent

# Set budget alerts
agentuity billing alert --threshold 100
```

## Deployment Configuration

### Environment Variables

```bash
# Set via CLI
agentuity env set OPENAI_API_KEY=sk-...
agentuity env set DATABASE_URL=postgresql://...

# Or via agentuity.yaml
env:
  - OPENAI_API_KEY
  - DATABASE_URL
secrets:
  - name: API_KEY
    value: ${API_KEY}  # References external secret
```

### Scaling Configuration

```yaml
# agentuity.yaml
scaling:
  min_instances: 0
  max_instances: 10
  target_cpu: 70
  target_memory: 80
```

### Regions

```yaml
# Deploy to specific regions
regions:
  - us-east-1
  - eu-west-1
  - ap-southeast-1
```

## Advanced Features

### Preview Deployments

```bash
# Deploy preview from branch
agentuity deploy --preview

# Automatic preview URL
# https://pr-123-your-agent.agentuity.run
```

### Canary Deployments

```bash
# Deploy with traffic splitting
agentuity deploy --canary 10

# 10% traffic to new version
# Automatic rollback if errors spike
```

### Production Evaluations

```typescript
// Evals run on live traffic automatically
import { eval } from '@agentuity/runtime';

agent.registerEval({
  name: 'response_quality',
  fn: async (input, output) => {
    return output.response.length > 10 ? 1.0 : 0.0;
  }
});
```

## GitHub Integration

### Auto-Deploy on Push

```bash
# Connect GitHub repository
agentuity github connect owner/repo

# Auto-deploy on push to main
# Preview deployments for PRs
```

### Manual GitHub Actions

See `via-github-actions.md` for full CI/CD setup.

## Rollbacks & Version Management

```bash
# List deployments
agentuity deployments list

# Rollback to previous
agentuity rollback

# Rollback to specific version
agentuity rollback v1.2.3

# Instant rollback (< 1 second)
```

## Security

### Authentication

- **API Keys**: Automatic generation and rotation
- **OAuth 2.0**: Built-in OAuth provider
- **CORS**: Configured per environment
- **Rate Limiting**: Automatic DDoS protection

### Secrets Management

```bash
# Store secrets securely
agentuity secret create API_KEY

# Reference in code
const key = process.env.API_KEY;

# Automatic encryption at rest
# Rotation without downtime
```

### Compliance

- SOC 2 Type II certified
- GDPR compliant
- HIPAA eligible
- ISO 27001

## Best Practices

1. **Use Environment Variables**: Never hardcode secrets
2. **Enable Auto-Scaling**: Set `min_instances: 0` for cost savings
3. **Monitor Costs**: Set up billing alerts early
4. **Test with Previews**: Use preview deployments before production
5. **Tag Deployments**: Use Git tags for version tracking

## Troubleshooting

### Deployment Fails

```bash
# Check deployment status
agentuity deploy status

# View deployment logs
agentuity logs --deployment latest

# Validate before deploy
agentuity deploy --dry-run
```

### Agent Not Responding

```bash
# Check agent health
agentuity agent health chat

# Restart agent
agentuity agent restart chat

# Scale up manually
agentuity scale chat --instances 3
```

### High Costs

```bash
# Analyze usage
agentuity billing breakdown

# Optimize:
# - Reduce min_instances to 0
# - Add caching
# - Implement rate limiting
# - Use cheaper AI models
```

## Migration from Other Platforms

### From AWS Lambda

- Replace Lambda handler with Agentuity agent
- Environment variables migrate 1:1
- Triggers map to Agentuity integrations

### From Vercel/Netlify

- Keep React frontend deployment
- Move API routes to Agentuity agents
- Better for long-running agent workloads

### From Heroku

- `Procfile` → `agentuity.yaml`
- Add-ons → Agentuity built-in services
- Dyno sizing → auto-scaling config

## Next Steps

- **Add Integrations**: Email, SMS, webhooks, cron jobs
- **Multi-Agent**: Coordinate multiple agents
- **Custom Domain**: Point your domain to Agentuity
- **VPC Deployment**: See `via-vpc.md` for private cloud
- **CI/CD**: Automate with `via-github-actions.md`

## References

- [Cloud Console](https://console.agentuity.com)
- [Cloud Documentation](https://agentuity.dev/Cloud)
- [Pricing](https://agentuity.com/pricing)
- [Status Page](https://status.agentuity.com)
