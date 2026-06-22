# Deploy via Dockerfile

Deploy any containerized application to Fly.io using custom Dockerfiles. Full control over build process, dependencies, and runtime environment.

## Overview

Fly.io runs Docker containers, giving you complete flexibility:
- **Custom Images**: Use any base image
- **Multi-Stage Builds**: Optimize image size
- **Build Arguments**: Dynamic build configuration
- **Layer Caching**: Fast rebuilds
- **Private Registries**: Pull from your own registry

## Prerequisites

- Application with a Dockerfile
- flyctl CLI installed
- Docker knowledge (optional for remote builds)

## Quick Start

### 1. Create a Dockerfile

```dockerfile
# Basic Node.js example
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --production

# Copy application code
COPY . .

# Expose port
EXPOSE 8080

# Start application
CMD ["node", "server.js"]
```

### 2. Deploy

```bash
# Deploy using Dockerfile
fly deploy

# Or specify Dockerfile explicitly
fly deploy --dockerfile Dockerfile
```

## Dockerfile Best Practices

### Multi-Stage Build

```dockerfile
# Build stage
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 8080

# Run as non-root user
USER node

CMD ["node", "dist/server.js"]
```

### Layer Caching Optimization

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code last (changes frequently)
COPY . .

CMD ["python", "app.py"]
```

### Minimal Base Images

```dockerfile
# Use distroless for security
FROM gcr.io/distroless/nodejs18-debian11

WORKDIR /app

COPY --chown=nonroot:nonroot package*.json ./
COPY --chown=nonroot:nonroot dist ./dist
COPY --chown=nonroot:nonroot node_modules ./node_modules

EXPOSE 8080

USER nonroot

CMD ["dist/server.js"]
```

## Language-Specific Examples

### Node.js / TypeScript

```dockerfile
FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production image
FROM node:18-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --production

COPY --from=builder /app/dist ./dist

EXPOSE 8080

USER node

CMD ["node", "dist/index.js"]
```

### Python / Django

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Collect static files
RUN python manage.py collectstatic --noinput

EXPOSE 8000

CMD ["gunicorn", "--bind", ":8000", "--workers", "2", "myproject.wsgi:application"]
```

### Go

```dockerfile
# Build stage
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main .

# Production stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

COPY --from=builder /app/main .

EXPOSE 8080

CMD ["./main"]
```

### Ruby / Rails

```dockerfile
FROM ruby:3.2-slim

WORKDIR /app

# Install dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    libpq-dev \
    nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install gems
COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test

# Copy application
COPY . .

# Precompile assets
RUN RAILS_ENV=production bundle exec rails assets:precompile

EXPOSE 3000

CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0"]
```

### PHP / Laravel

```dockerfile
FROM php:8.2-fpm-alpine

WORKDIR /var/www/html

# Install dependencies
RUN apk add --no-cache \
    nginx \
    postgresql-dev \
    && docker-php-ext-install pdo pdo_pgsql

# Install Composer
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

# Install PHP dependencies
COPY composer.json composer.lock ./
RUN composer install --no-dev --optimize-autoloader

# Copy application
COPY . .

# Set permissions
RUN chown -R www-data:www-data /var/www/html

EXPOSE 8080

CMD ["php-fpm"]
```

## Advanced Dockerfile Techniques

### Build Arguments

```dockerfile
ARG NODE_VERSION=18
FROM node:${NODE_VERSION}-alpine

ARG BUILD_ENV=production
ARG API_URL

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=${BUILD_ENV}

COPY . .

# Use build arg in build
RUN echo "API_URL=${API_URL}" > .env

EXPOSE 8080

CMD ["node", "server.js"]
```

Deploy with build args:
```bash
fly deploy --build-arg NODE_VERSION=20 --build-arg API_URL=https://api.example.com
```

### Health Check

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY . .

RUN npm ci --production

EXPOSE 8080

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js

CMD ["node", "server.js"]
```

### Multi-Platform Builds

```dockerfile
# Supports both amd64 and arm64
FROM --platform=$BUILDPLATFORM node:18-alpine AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:18-alpine

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 8080

CMD ["node", "dist/server.js"]
```

### Caching Node Modules

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files first
COPY package*.json ./

# This layer will be cached unless package.json changes
RUN npm ci --production

# Copy rest of application
COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
```

## fly.toml Configuration

### Specify Dockerfile

```toml
app = "my-app"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"
  ignorefile = ".dockerignore"
  
  # Build arguments
  [build.args]
    NODE_ENV = "production"
    API_VERSION = "v2"

[[services]]
  internal_port = 8080
  protocol = "tcp"
  
  [[services.ports]]
    handlers = ["http"]
    port = 80
  
  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443
```

### Use Different Dockerfiles

```toml
# fly.production.toml
[build]
  dockerfile = "Dockerfile.production"

# fly.staging.toml  
[build]
  dockerfile = "Dockerfile.staging"
```

Deploy:
```bash
fly deploy --config fly.production.toml
fly deploy --config fly.staging.toml
```

## .dockerignore

Create `.dockerignore` to exclude unnecessary files:

```dockerignore
# Version control
.git
.gitignore

# Dependencies
node_modules
vendor

# Build artifacts
dist
build
*.log

# Environment files
.env
.env.local
.env.*.local

# IDE
.vscode
.idea
*.swp

# OS
.DS_Store
Thumbs.db

# Documentation
*.md
docs/

# Tests
tests/
*.test.js
coverage/

# CI/CD
.github
.gitlab-ci.yml
```

## Build Optimization

### Remote Builds (Recommended)

```bash
# Build on Fly's infrastructure (no local Docker needed)
fly deploy --remote-only

# Faster, uses Fly's build cache
```

### Local Builds

```bash
# Build locally with Docker
fly deploy --local-only

# Useful for testing Dockerfile changes
```

### Build with Cache

```bash
# Use build cache
fly deploy --remote-only

# Clear cache and rebuild
fly deploy --remote-only --no-cache
```

## Deploying Pre-Built Images

### From Docker Hub

```bash
fly deploy --image nginx:latest
```

### From Private Registry

```toml
# fly.toml
[build]
  image = "registry.example.com/my-app:v1.2.3"
```

```bash
# Deploy
fly deploy
```

### With Registry Authentication

```bash
# Set registry credentials
fly secrets set DOCKER_REGISTRY_TOKEN=your-token

# Deploy from private registry
fly deploy --image registry.example.com/my-app:latest
```

## Debugging Docker Builds

### Build Locally for Testing

```bash
# Build Docker image locally
docker build -t my-app .

# Test locally
docker run -p 8080:8080 my-app

# Then deploy to Fly
fly deploy --local-only
```

### View Build Logs

```bash
# Deploy with verbose output
fly deploy --verbose

# View build logs
fly logs --timestamps
```

### SSH into Running Container

```bash
# Access running container
fly ssh console

# Check environment
fly ssh console -C "env"

# Inspect filesystem
fly ssh console -C "ls -la"
```

## Common Issues & Solutions

### Large Image Size

```dockerfile
# Before: 1GB+
FROM node:18
COPY . .
RUN npm install

# After: ~100MB
FROM node:18-alpine AS builder
COPY package*.json ./
RUN npm ci --production
COPY . .

FROM node:18-alpine
COPY --from=builder /app ./
CMD ["node", "index.js"]
```

### Slow Builds

```dockerfile
# Order matters! Put stable layers first

# ❌ Bad: Code changes rebuild dependencies
FROM node:18-alpine
COPY . .
RUN npm install

# ✅ Good: Dependencies cached
FROM node:18-alpine
COPY package*.json ./
RUN npm ci
COPY . .
```

### Permission Errors

```dockerfile
# Run as non-root user
FROM node:18-alpine

WORKDIR /app

# Change ownership
COPY --chown=node:node . .

# Switch to node user
USER node

CMD ["node", "server.js"]
```

## Best Practices Summary

1. **Use Multi-Stage Builds**: Reduce final image size
2. **Order Layers Wisely**: Put changing content last
3. **Use Alpine Images**: Smaller, faster deployments
4. **Run as Non-Root**: Better security
5. **Include .dockerignore**: Faster builds, smaller context
6. **Use Build Cache**: Leverage layer caching
7. **Health Checks**: Add HEALTHCHECK instruction
8. **Environment Variables**: Use fly secrets, not hardcoded in Dockerfile
9. **Remote Builds**: Use `--remote-only` for Fly's build cache
10. **Pin Versions**: Specify exact versions for reproducibility

## References

- [Fly.io Docker Deployment](https://fly.io/docs/languages-and-frameworks/dockerfile/)
- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [Multi-Stage Builds](https://docs.docker.com/build/building/multi-stage/)
- [Dockerfile Reference](https://docs.docker.com/engine/reference/builder/)
