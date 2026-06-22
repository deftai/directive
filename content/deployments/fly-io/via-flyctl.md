# Deploy via flyctl CLI

The primary and recommended method for deploying applications to Fly.io. The `flyctl` CLI provides complete control over your applications from creation through scaling and monitoring.

## Overview

`flyctl` (or `fly`) is Fly.io's command-line tool that enables:
- **App Deployment**: Deploy containers from source or Dockerfile
- **Configuration Management**: Manage fly.toml and secrets
- **Multi-Region Deployment**: Deploy globally with one command
- **Real-Time Monitoring**: View logs, metrics, and status
- **Database Management**: Create and manage Fly Postgres

## Installation

### macOS

```bash
# Using Homebrew
brew install flyctl

# Or using install script
curl -L https://fly.io/install.sh | sh
```

### Linux

```bash
# Install script
curl -L https://fly.io/install.sh | sh

# Add to PATH
export FLYCTL_INSTALL="/home/user/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"
```

### Windows (PowerShell)

```powershell
# Run in PowerShell
iwr https://fly.io/install.ps1 -useb | iex
```

### Verify Installation

```bash
flyctl version
fly version  # 'fly' is an alias for 'flyctl'
```

## Quick Start

### 1. Sign Up / Login

```bash
# Create account and login
fly auth signup

# Or login to existing account
fly auth login

# Verify authentication
fly auth whoami
```

### 2. Launch Your First App

```bash
# Navigate to your project directory
cd my-app

# Launch app (interactive setup)
fly launch

# This will:
# - Detect your app type
# - Generate fly.toml configuration
# - Create a Dockerfile if needed
# - Deploy your app
```

### 3. Deploy Updates

```bash
# Deploy changes
fly deploy

# Deploy with specific Dockerfile
fly deploy --dockerfile Dockerfile.production

# Deploy with remote builder (no local Docker needed)
fly deploy --remote-only
```

## Core Commands

### Application Management

```bash
# Create new app
fly apps create my-app

# List your apps
fly apps list

# Show app status
fly status

# Open app in browser
fly open

# Destroy app
fly apps destroy my-app
```

### Deployment

```bash
# Standard deployment
fly deploy

# Deploy from specific directory
fly deploy --config /path/to/fly.toml

# Deploy with build arguments
fly deploy --build-arg API_VERSION=v2

# Deploy specific image
fly deploy --image registry.example.com/my-app:latest

# No cache build
fly deploy --no-cache
```

### Configuration

```bash
# View current configuration
fly config show

# Edit configuration
fly config edit

# Validate fly.toml
fly config validate

# Save current config
fly config save
```

### Secrets Management

```bash
# Set secret
fly secrets set DATABASE_URL=postgres://...

# Set multiple secrets
fly secrets set API_KEY=abc123 SECRET_TOKEN=xyz789

# Import secrets from file
fly secrets import < .env.production

# List secrets (values hidden)
fly secrets list

# Remove secret
fly secrets unset API_KEY
```

### Scaling

```bash
# Show current scale
fly scale show

# Scale machine count
fly scale count 3

# Scale to specific regions
fly scale count 2 --region iad,lhr

# Scale machine size
fly scale vm shared-cpu-2x

# Scale memory
fly scale memory 512

# Autoscaling
fly autoscale set min=1 max=10
```

### Regions & Multi-Region

```bash
# List available regions
fly platform regions

# Add region
fly regions add lhr  # London

# Remove region
fly regions remove lhr

# Set backup region
fly regions backup iad

# Deploy to multiple regions
fly scale count 3 --region iad,lhr,syd
```

## fly.toml Configuration

### Basic Configuration

```toml
# Application name
app = "my-app"

# Primary region
primary_region = "iad"

# Build configuration
[build]
  dockerfile = "Dockerfile"
  # Or use buildpacks
  # builder = "paketobuildpacks/builder:base"

# Environment variables
[env]
  NODE_ENV = "production"
  PORT = "8080"

# HTTP service
[[services]]
  protocol = "tcp"
  internal_port = 8080

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["http", "tls"]

  # Health checks
  [services.http_checks]
    interval = "10s"
    timeout = "2s"
    grace_period = "5s"
    method = "GET"
    path = "/health"
```

### Advanced Configuration

```toml
app = "advanced-app"
primary_region = "iad"

# Autoscaling
[autoscaling]
  min_machines = 1
  max_machines = 10

# Processes (multiple process types)
[processes]
  web = "npm run start"
  worker = "npm run worker"

# Metrics
[metrics]
  port = 9091
  path = "/metrics"

# Volumes
[mounts]
  source = "data"
  destination = "/data"

# Private network
[private_network]
  name = "my-app-net"

# Deploy configuration
[deploy]
  release_command = "npm run migrate"
  strategy = "rolling"
  
  [deploy.max_unavailable]
    count = 1

# HTTP service with caching
[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    handlers = ["http"]
    port = 80
    force_https = true

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443

  # Concurrency limits
  [services.concurrency]
    type = "connections"
    hard_limit = 200
    soft_limit = 100

  # TCP checks
  [[services.tcp_checks]]
    interval = "15s"
    timeout = "2s"
    grace_period = "5s"
```

## Advanced Features

### Fly Machines API

```bash
# List machines
fly machines list

# Create machine
fly machines run nginx

# Stop machine
fly machines stop MACHINE_ID

# Start machine
fly machines start MACHINE_ID

# Clone machine
fly machines clone MACHINE_ID

# Remove machine
fly machines remove MACHINE_ID
```

### Volumes (Persistent Storage)

```bash
# Create volume
fly volumes create data --region iad --size 10

# List volumes
fly volumes list

# Extend volume
fly volumes extend VOLUME_ID --size 20

# Snapshot volume
fly volumes snapshots create VOLUME_ID

# Restore from snapshot
fly volumes create data --snapshot-id SNAPSHOT_ID
```

### Postgres Database

```bash
# Create Postgres cluster
fly postgres create

# Attach to app
fly postgres attach MY_POSTGRES_APP

# Connect to database
fly postgres connect

# List databases
fly postgres db list

# Create database
fly postgres db create mydb

# Show connection string
fly postgres config show
```

### Private Networking

```bash
# Create private network
fly wireguard create

# Add peer
fly wireguard peer add

# List peers
fly wireguard list

# Connect via WireGuard
fly proxy 5432:5432 -a my-postgres-app
```

### SSH & Console Access

```bash
# SSH into running instance
fly ssh console

# SSH with specific command
fly ssh console -C "ls -la"

# Open Rails console
fly ssh console --pty -C "rails console"

# Run one-off command
fly ssh console -C "bin/rails db:migrate"
```

## Monitoring & Debugging

### Logs

```bash
# Stream logs
fly logs

# Filter by region
fly logs --region iad

# Show specific number of lines
fly logs -n 100

# Search logs
fly logs | grep ERROR
```

### Metrics & Monitoring

```bash
# Open Grafana dashboard
fly dashboard

# Show metrics
fly dashboard metrics

# VM status
fly status --all

# Check health
fly checks list
```

### Debugging

```bash
# View deployment history
fly releases

# Rollback to previous version
fly releases rollback

# Show app info
fly info

# Check app health
fly status

# Test connectivity
fly ping
```

## Deployment Strategies

### Blue-Green Deployment

```bash
# Deploy new version
fly deploy --strategy bluegreen

# Or configure in fly.toml
[deploy]
  strategy = "bluegreen"
```

### Canary Deployment

```bash
# Deploy to limited machines first
fly deploy --strategy canary

# Manual canary
fly scale count 1 --region iad  # Deploy to one region
# Verify, then scale up
fly scale count 3 --region iad,lhr,syd
```

### Rolling Deployment

```toml
# fly.toml
[deploy]
  strategy = "rolling"
  max_unavailable = 1  # One at a time
```

## Best Practices

### 1. Use fly.toml in Version Control

```bash
# Generate fly.toml
fly launch --no-deploy

# Commit to git
git add fly.toml
git commit -m "Add Fly.io configuration"
```

### 2. Manage Secrets Properly

```bash
# Never commit secrets to git
echo ".env" >> .gitignore

# Use fly secrets for production
fly secrets set $(cat .env.production | xargs)
```

### 3. Health Checks

```toml
[[services]]
  # Always configure health checks
  [[services.http_checks]]
    interval = "10s"
    timeout = "2s"
    method = "GET"
    path = "/health"
    protocol = "http"
```

### 4. Multi-Region for High Availability

```bash
# Deploy to multiple regions
fly regions add iad lhr syd

# Verify distribution
fly status --all
```

### 5. Use Volumes for Persistent Data

```bash
# Create volume before first deploy
fly volumes create data --region iad

# Mount in fly.toml
[mounts]
  source = "data"
  destination = "/data"
```

## Troubleshooting

### Deployment Fails

```bash
# Check build logs
fly logs --timestamps

# Deploy with verbose output
fly deploy --verbose

# Check app status
fly status

# View recent events
fly events
```

### App Not Responding

```bash
# Check if instances are running
fly status --all

# Restart all instances
fly restart

# Scale up
fly scale count 2
```

### Connection Issues

```bash
# Test DNS
dig my-app.fly.dev

# Check certificates
fly certs show

# Verify routing
fly ips list
```

### High Memory Usage

```bash
# Check current usage
fly status

# Scale memory
fly scale memory 1024

# Or upgrade VM
fly scale vm dedicated-cpu-2x
```

## Common Workflows

### Deploy from CI/CD

```bash
# Non-interactive deploy
fly deploy --remote-only --now
```

### Database Migration

```bash
# Run migration before deployment
[deploy]
  release_command = "rails db:migrate"

# Or manually
fly ssh console -C "npm run migrate"
```

### Environment-Specific Deployments

```bash
# Use different fly.toml files
fly deploy --config fly.staging.toml
fly deploy --config fly.production.toml
```

## References

- [flyctl CLI Reference](https://fly.io/docs/flyctl/)
- [fly.toml Configuration](https://fly.io/docs/reference/configuration/)
- [Deployment Guide](https://fly.io/docs/reference/deployment/)
- [Fly Machines](https://fly.io/docs/machines/)
- [Troubleshooting](https://fly.io/docs/getting-started/troubleshooting/)
