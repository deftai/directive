# Deploy via Agentuity CLI

The primary and recommended method for deploying agents to Agentuity. The CLI provides the complete development lifecycle from project creation through production deployment.

## Prerequisites

- macOS, Linux, or WSL on Windows
- Node.js 18+ or Bun (for TypeScript/JavaScript agents)
- Python 3.9+ (for Python agents)
- Git (optional, for version control)

## Installation

### macOS / Linux

```bash
# Install via install script (recommended)
curl -fsS https://agentuity.sh | sh

# Or via Homebrew (macOS)
brew install agentuity
```

### Windows (WSL Required)

```bash
# Run from WSL terminal
curl -fsS https://agentuity.sh | sh
```

### Verify Installation

```bash
agentuity version
agentuity --help
```

## Quick Start

### 1. Create a New Project

```bash
# Interactive creation with templates
agentuity create

# You'll be prompted to choose:
# - Project name
# - Runtime (TypeScript, Python, Bun)
# - Template (basic, chat, research, etc.)
```

### 2. Start Local Development

```bash
cd my-agent-project
agentuity dev

# Your agent will be available at http://localhost:3500
# Hot reload enabled - changes apply instantly
```

### 3. Deploy to Production

```bash
# Deploy to Agentuity Cloud
agentuity deploy

# Or specify target
agentuity cloud deploy --dir ./my-project
```

## Project Structure

After running `agentuity create`, your project will have:

```
my-agent/
├── agentuity.yaml          # Project configuration
├── src/
│   └── agents/            # Agent definitions
│       └── index.ts       # Main agent
├── api/                   # API routes (optional)
├── web/                   # React frontend (optional)
└── package.json           # Dependencies
```

## Core CLI Commands

### Project Management

```bash
# Create new agent in existing project
agentuity agent create [name]

# List all agents
agentuity agent list

# Delete an agent
agentuity agent delete [name]
```

### Development

```bash
# Start dev server
agentuity dev

# Run with specific port
agentuity dev --port 4000

# Enable debug logging
agentuity dev --log-level debug
```

### Deployment

```bash
# Deploy to production
agentuity deploy

# Deploy with dry-run (validate only)
agentuity deploy --dry-run

# Deploy specific directory
agentuity deploy --dir ./my-project

# Deploy with explanation
agentuity deploy --explain
```

### Environment Management

```bash
# List environment variables
agentuity env

# Set environment variable
agentuity env set KEY=value

# Delete environment variable
agentuity env delete KEY
```

### Authentication

```bash
# Login to Agentuity Cloud
agentuity auth login

# Logout
agentuity auth logout

# Check auth status
agentuity auth status
```

### API Key Management

```bash
# Create API key
agentuity apikey create

# List API keys
agentuity apikey list

# Revoke API key
agentuity apikey revoke [key-id]
```

## Agent Configuration

### Basic Agent (TypeScript)

```typescript
// src/agents/chat.ts
import { createAgent } from '@agentuity/runtime';
import { s } from '@agentuity/schema';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const agent = createAgent('chat', {
  description: 'A simple chat agent',
  schema: {
    input: s.object({
      message: s.string()
    }),
    output: s.object({
      response: s.string()
    })
  },
  handler: async (ctx, { message }) => {
    const { text } = await generateText({
      model: openai('gpt-4'),
      prompt: message
    });
    return { response: text };
  }
});

export default agent;
```

### agentuity.yaml Configuration

```yaml
name: my-agent
description: My AI agent project
version: 1.0.0

runtime:
  type: nodejs
  version: "18"

agents:
  - name: chat
    path: src/agents/chat.ts
    auth: api-key

env:
  - OPENAI_API_KEY
  - DATABASE_URL
```

## Advanced Features

### Offline Development

Agentuity CLI works offline by default:

```bash
# No account required to start building
agentuity create --offline

# Deploy when ready
agentuity deploy
```

### JSON Output for Automation

```bash
# Get agent info as JSON
agentuity agent list --json

# Deploy with JSON output
agentuity deploy --json
```

### Schema Discovery

```bash
# Discover available schemas
agentuity schema list

# Validate agent schemas
agentuity schema validate
```

## Deployment Options

### Standard Cloud Deployment

```bash
# Deploy to Agentuity managed infrastructure
agentuity deploy

# Features:
# - Global edge network
# - Sub-100ms cold starts
# - Automatic scaling
# - Built-in SSL/DNS
```

### Custom Domain

```bash
# Configure custom domain
agentuity domain add example.com

# SSL certificates managed automatically
```

### Rollback

```bash
# List deployments
agentuity deployments list

# Rollback to previous version
agentuity rollback [deployment-id]
```

## Monitoring and Debugging

### View Logs

```bash
# Stream live logs
agentuity logs --follow

# Filter by agent
agentuity logs --agent chat

# View last 100 lines
agentuity logs --tail 100
```

### Inspect Agent

```bash
# Get agent details
agentuity agent inspect [name]

# View agent configuration
agentuity agent config [name]
```

## Best Practices

1. **Use Templates**: Start with `agentuity create` templates for best practices
2. **Environment Variables**: Never commit secrets; use `agentuity env` commands
3. **Test Locally**: Always test with `agentuity dev` before deploying
4. **Version Control**: Commit `agentuity.yaml` and agent code to Git
5. **Dry Run**: Use `--dry-run` to validate before actual deployment

## Troubleshooting

### CLI Not Found After Installation

```bash
# Add to PATH (macOS/Linux)
export PATH="$HOME/.agentuity/bin:$PATH"

# Reload shell
source ~/.zshrc  # or ~/.bashrc
```

### Deployment Fails

```bash
# Check auth status
agentuity auth status

# Validate configuration
agentuity deploy --dry-run --explain

# Check logs
agentuity logs --tail 50
```

### Port Already in Use

```bash
# Use different port
agentuity dev --port 4000
```

## Upgrading the CLI

```bash
# Upgrade to latest version
agentuity upgrade

# Or reinstall
curl -fsS https://agentuity.sh | sh
```

## Next Steps

- **Add Frontend**: Deploy React frontend with `@agentuity/react`
- **Multi-Agent**: Coordinate multiple agents with type-safe calls
- **Production Evals**: Enable evaluations on live traffic
- **VPC Deployment**: See `via-vpc.md` for private cloud deployment
- **CI/CD**: Automate with `via-github-actions.md`

## References

- [CLI Documentation](https://agentuity.dev/CLI)
- [CLI GitHub Repository](https://github.com/agentuity/cli)
- [Getting Started Guide](https://agentuity.dev/Introduction/getting-started)
- [Agent Commands Reference](https://agentuity.dev/CLI/agent)
