---
applyTo: "**/*.py,**/*.js,**/*.ts,**/*.rb,**/*.java,**/*.go,**/manifest*.yml"
---

# Cloud.gov Logging Instructions (Deft)

Guidance for logging and monitoring in cloud.gov applications.

## Core Rules

- ! Log to stdout/stderr (no files)
- ! Never log secrets or PII
- ~ Use structured JSON logs
- ~ Include request IDs and timestamps

## Viewing Logs

```bash
cf logs <APP_NAME> --recent
cf logs <APP_NAME>
```

## Structured Log Fields (suggested)

- `timestamp`
- `level`
- `event`
- `request_id`
- `user_id` (anonymized)
- `duration_ms`

## Log Drains

```bash
cf cups my-log-drain -l syslog-tls://logs.example.com:6514
cf bind-service my-app my-log-drain
cf restage my-app
```

## References

- https://docs.cloudfoundry.org/devguide/deploy-apps/streaming-logs.html
- https://12factor.net/logs
