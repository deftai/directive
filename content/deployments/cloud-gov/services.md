---
applyTo: "**/*.py,**/*.js,**/*.ts,**/*.rb,**/*.java,**/*.go,**/manifest*.yml"
---

# Cloud.gov Services Instructions (Deft)

Guidance for provisioning and using cloud.gov managed services.

## Core Rules

- ! Never hardcode credentials
- ! Read credentials from `VCAP_SERVICES`
- ~ Prefer bound services over service keys
- ~ Document services in `manifest.yml`

## Service Lifecycle

```bash
cf marketplace
cf create-service <SERVICE> <PLAN> <INSTANCE_NAME>
cf bind-service <APP_NAME> <INSTANCE_NAME>
cf restage <APP_NAME>
```

## VCAP_SERVICES (Python example)

```python
import json, os

vcap_services = json.loads(os.environ.get("VCAP_SERVICES", "{}"))
db_credentials = vcap_services.get("aws-rds", [{}])[0].get("credentials", {})

DATABASE_URL = db_credentials.get("uri")
```

## Relational Databases (RDS)

- ~ Use redundant plans for production
- ~ Rotate credentials regularly

```bash
cf create-service aws-rds micro-psql my-database
cf create-service aws-rds small-psql-redundant my-database
cf update-service my-database -c '{"rotate_credentials": true}'
```

## S3 Storage

```bash
cf create-service s3 basic my-s3-bucket
```

## Redis

```bash
cf create-service aws-elasticache-redis redis-dev my-redis
```

## Service Keys

- ~ Use only when necessary (CI/CD, external access)

```bash
cf create-service-key my-s3-bucket external-access
cf service-key my-s3-bucket external-access
```

## References

- https://docs.cloud.gov/platform/deployment/managed-services/
- https://docs.cloud.gov/platform/services/relational-database/
- https://docs.cloud.gov/platform/services/s3/
