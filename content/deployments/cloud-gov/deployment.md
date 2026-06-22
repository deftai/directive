---
applyTo: "**/manifest*.yml,**/Procfile,**/.cfignore,**/.profile"
---

# Cloud.gov Deployment Instructions (Deft)

Guidance for deploying applications to cloud.gov using Cloud Foundry.

## Prerequisites

- ! Cloud Foundry CLI installed (`cf`)
- ! Logged in to `api.fr.cloud.gov`
- ! Targeted correct org/space

## Basic Workflow

1. Prepare required files (`manifest.yml`, `.cfignore`, optional `.profile`, `Procfile`)
2. Run `cf push`
3. Verify health and logs

## Required Files

### `manifest.yml` (example)

```yaml
---
applications:
  - name: my-app
    memory: 512M
    instances: 2
    buildpacks:
      - python_buildpack
    env:
      ENVIRONMENT: production
    services:
      - my-database
    routes:
      - route: my-app.app.cloud.gov
```

### `.cfignore` (example)

```
.git/
.gitignore
node_modules/
__pycache__/
*.pyc
.env
.env.*
tests/
docs/
*.md
!README.md
```

### `.profile` (optional)

```bash
#!/bin/bash
export APP_STARTED_AT=$(date)
```

### `Procfile` (optional)

```
web: gunicorn app:app --bind 0.0.0.0:$PORT
worker: python worker.py
```

## Deployment Commands

```bash
cf push
cf push -f manifest.yml
cf push --no-start
cf app <APP_NAME>
cf logs <APP_NAME> --recent
```

## Strategies

### Blue/Green

- Deploy new version with temporary name
- Map routes to new version
- Unmap routes from old version
- Delete old version

### Rolling

```bash
cf push my-app --strategy rolling
```

### Canary

- Deploy canary instance
- Map route and monitor
- Promote or rollback

## Scaling

```bash
cf scale <APP_NAME> -i 3
cf scale <APP_NAME> -m 1G
cf scale <APP_NAME> -k 2G
```

## Health Checks

```yaml
applications:
  - name: my-app
    health-check-type: http
    health-check-http-endpoint: /health
    timeout: 180
```

## Buildpacks

Common buildpacks:

- `python_buildpack`
- `nodejs_buildpack`
- `ruby_buildpack`
- `java_buildpack`
- `go_buildpack`
- `php_buildpack`
- `dotnet_core_buildpack`
- `staticfile_buildpack`

List available buildpacks:

```bash
cf buildpacks
```

## Troubleshooting

```bash
cf logs <APP_NAME> --recent
cf events <APP_NAME>
cf ssh <APP_NAME>
```

## References

- https://docs.cloud.gov/platform/deployment/
- https://docs.cloudfoundry.org/devguide/deploy-apps/
