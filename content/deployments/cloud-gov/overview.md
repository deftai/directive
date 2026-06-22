# Cloud.gov Development Instructions (Deft)

These instructions define cloud.gov conventions and deployment expectations.
Use them when working with cloud.gov projects.

## Platform Overview

cloud.gov is a FedRAMP-authorized PaaS built on Cloud Foundry. It provides:

- FedRAMP Moderate authorization (shared responsibility)
- Self-service deployment via `cf` CLI
- Managed services (databases, object storage, cache)
- Isolated org/space environments (dev, staging, prod)

## Key Concepts

### Organizations and Spaces

- **Organization (org)**: top-level container
- **Space**: environment inside org (dev/staging/prod)
- **Target**: active org/space via `cf target -o <ORG> -s <SPACE>`

### Application Model

- Apps are built by buildpacks and run in containers
- ! Apps MUST be **stateless**
- ! Apps MUST read config from environment variables
- ! Apps MUST log to stdout/stderr

## Required Behaviors

- ! No secrets in code or manifests
- ! Use `VCAP_SERVICES` for bound service credentials
- ! Implement health endpoints and configure health checks
- ! Use HTTPS-only access
- ~ Use 2+ instances in production

## Expected Files

| File | Purpose |
|------|---------|
| `manifest.yml` | Deployment configuration |
| `.cfignore` | Deployment exclusions |
| `vars*.yml` | Manifest variables |
| `.profile` | Pre-start script |
| `Procfile` | Process definitions |

## Security & Compliance

- cloud.gov is FedRAMP Moderate authorized
- ! Include NIST SP 800-53 control references in security-relevant code
- ~ Document inherited vs customer controls

## References

- cloud.gov docs: https://docs.cloud.gov/
- Cloud Foundry docs: https://docs.cloudfoundry.org/
- Twelve-Factor App: https://12factor.net/
