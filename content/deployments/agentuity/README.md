# Agentuity Deployment Module

Deft guidance for deploying AI agents to Agentuity, the full-stack platform built for autonomous agents.

## Status

- ! Optional module
- ~ Good for Deft usage

## Overview

<cite index="1-1,1-2,1-3">Agentuity is a full-stack platform for building sophisticated AI agents with intelligent routing, persistent state, and seamless handoffs, deploying with built-in APIs, React frontends, databases, and monitoring, and running on their cloud, your VPC, or on-premises.</cite> Launched in February 2026, <cite index="6-8,6-9">Agentuity enables streamlined creation of fully functional and easy-to-manage agents through purpose-built primitives for agentic software, including built-in storage services, secure code execution sandboxes, production evaluations, and the ability to deploy anywhere from public cloud to on-premises infrastructure.</cite>

## Deployment Methods

| File | Method | Best For |
|------|--------|----------|
| `via-cli.md` | Agentuity CLI | Primary deployment method, local dev to production |
| `via-cloud.md` | Agentuity Managed Cloud | Simplest path, global edge network |
| `via-vpc.md` | Private VPC / On-Prem | Enterprise security, data sovereignty |
| `via-github-actions.md` | GitHub Actions CI/CD | Automated deployments, push-to-deploy |
| `via-gravity-network.md` | Gravity Network | Multi-cloud, edge, hybrid deployments |

## Supported Frameworks

<cite index="1-10,1-11">Agentuity wraps your existing agent code with observability, evals, streaming, and auth without forcing a new runtime, supporting Mastra, AI SDK, or your own code.</cite>

- **Vercel AI SDK** — Full TypeScript support with type-safe schemas
- **Mastra** — Agent orchestration framework
- **LangChain** — Python and TypeScript agent frameworks
- **LlamaIndex** — RAG and data framework agents
- **Custom Agents** — Bring your own agent implementation

## Deployment Approaches

### CLI Deployments

```bash
# Install Agentuity CLI
curl -fsS https://agentuity.sh | sh

# Create new project
agentuity create

# Start local development
agentuity dev

# Deploy to cloud
agentuity deploy
```

### Git-Based Deployments

<cite index="1-16">Push to main and GitHub auto-deploys</cite> — connect your repository and Agentuity automatically deploys on every push to your main branch.

### Full-Stack Development

- **Type-safe APIs**: Hono routes that auto-generate React hooks
- **React Frontends**: Deploy React apps with end-to-end type safety
- **Built-in Services**: Redis, Postgres, vector storage, object storage
- **Sandboxes**: Isolated containers for secure code execution

### Multi-Environment Support

<cite index="1-3,1-18">Run on Agentuity cloud, your VPC, or on-prem, with deployment to public cloud, private cloud, on-premises, multi-cloud, or edge — one platform, one SDK, one consistent developer experience.</cite>

## Quick Decision Guide

- **Fastest start**: `via-cloud.md` — deploy to managed infrastructure with one command
- **Enterprise security**: `via-vpc.md` — private cloud or on-premises deployment
- **CI/CD pipelines**: `via-github-actions.md` — automated deployments
- **Local development**: Agentuity CLI — offline-ready, no account required
- **Multi-cloud**: `via-gravity-network.md` — deploy anywhere with Gravity Network
- **Full-stack apps**: CLI + React SDK — agents, APIs, and frontends together

## Key Features

### Agent-Native Infrastructure

- **Long-running runtimes**: Agents can run for minutes or hours
- **Stateful orchestration**: Persistent state and session management
- **Agent-to-agent communication**: Type-safe calls between agents
- **Production evaluations**: Evals run on live traffic

### Built-In Services

- **Storage**: Key-value, vector, Postgres, S3-compatible object storage
- **Sandboxes**: Secure code execution environments
- **AI Gateway**: Unified access to OpenAI, Anthropic, Google, Groq, Mistral
- **Observability**: OpenTelemetry tracing, logging, cost tracking

### Developer Experience

- **Offline-ready**: Start building without an account
- **Type safety**: End-to-end TypeScript support
- **Hot reload**: Instant feedback in development
- **One-command deploy**: From dev to production instantly

### Enterprise Features

- **VPC deployment**: Run in your private cloud
- **On-premises**: Deploy to your own infrastructure
- **SSO integration**: Enterprise authentication
- **Compliance**: SOC 2, GDPR, HIPAA ready

## Platform Comparison

<cite index="10-9">Agentuity aims to make AWS, Azure, and Google Cloud feel like legacy systems for the old app world, positioning Agentuity as synonymous with the next generation of cloud infrastructure: an AI-native platform that meets the unique demands of this technology.</cite>

**Traditional clouds** (AWS, Azure, GCP) are optimized for request-response workloads. <cite index="9-5">Agents don't exclusively fit execution models built around short-lived requests — they reason, iterate, pause, resume, run for seconds or minutes or hours at a time, manage context, spawn other agents, and adapt their behavior as they go.</cite>

## References

- [Agentuity Documentation](https://agentuity.dev/)
- [Agentuity CLI GitHub](https://github.com/agentuity/cli)
- [Getting Started Guide](https://agentuity.dev/Introduction/getting-started)
- [SDK Explorer](https://agentuity.dev/)
- [Examples Repository](https://github.com/agentuity/examples)
- [Agents Spotlight](https://agentuity.com/spotlight)

<citations>
  <document>
    <document_type>WEB_SEARCH_RESULT</document_type>
    <document_id>1</document_id>
  </document>
  <document>
    <document_type>WEB_SEARCH_RESULT</document_type>
    <document_id>6</document_id>
  </document>
  <document>
    <document_type>WEB_SEARCH_RESULT</document_type>
    <document_id>9</document_id>
  </document>
  <document>
    <document_type>WEB_SEARCH_RESULT</document_type>
    <document_id>10</document_id>
  </document>
</citations>
