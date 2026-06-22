---
applyTo: "**/manifest*.yml,**/vars*.yml"
---

# Cloud.gov Manifest Instructions (Deft)

Guidance for writing `manifest.yml` files.

## Required

- ! `name` must be unique in the target space
- ! `memory` should be explicitly set
- ~ `instances: 2+` for production workloads

## Example Manifest

```yaml
---
applications:
  - name: my-app
    memory: 512M
    disk_quota: 1G
    instances: 2
    buildpacks:
      - python_buildpack
    command: gunicorn app:app
    env:
      ENVIRONMENT: production
    services:
      - my-database
      - my-s3-bucket
    routes:
      - route: my-app.app.cloud.gov
```

## Properties

### Resources

- `memory` (e.g., `512M`, `1G`)
- `disk_quota` (e.g., `1G`, `2G`)
- `instances` (integer)

### Buildpacks

```yaml
buildpacks:
  - python_buildpack
```

### Command / Procfile

```yaml
command: gunicorn app:app --bind 0.0.0.0:$PORT
```

Or use a `Procfile`:

```
web: gunicorn app:app --bind 0.0.0.0:$PORT
```

### Environment Variables

- ! Never store secrets in `manifest.yml`
- ~ Use bound services or `cf set-env`

### Services

```yaml
services:
  - my-postgres
  - my-redis
```

### Routes

```yaml
routes:
  - route: my-app.app.cloud.gov
```

### Health Checks

```yaml
health-check-type: http
health-check-http-endpoint: /health
timeout: 180
```

## Variables and Environments

### Base Manifest + Vars

```yaml
---
applications:
  - name: ((app_name))
    memory: ((memory))
    instances: ((instances))
    env:
      DATABASE_URL: ((database_url))
```

```yaml
app_name: my-app
memory: 1G
instances: 3
database_url: postgres://...
```

Deploy:

```bash
cf push -f manifest.yml --vars-file vars-prod.yml
```

## References

- https://docs.cloudfoundry.org/devguide/deploy-apps/manifest.html
- https://docs.cloudfoundry.org/devguide/deploy-apps/manifest-attributes.html
