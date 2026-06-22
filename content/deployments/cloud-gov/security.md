---
applyTo: "**/*.py,**/*.js,**/*.ts,**/*.rb,**/*.java,**/*.go,**/manifest*.yml,**/.github/workflows/*.yml"
---

# Cloud.gov Security Instructions (Deft)

Guidance for application security and FedRAMP compliance on cloud.gov.

## Shared Responsibility

- cloud.gov manages platform controls
- you manage application-level controls

## Core Rules

- ! No secrets in code
- ! Use environment variables or `VCAP_SERVICES`
- ! Include NIST SP 800-53 control references in security-relevant code
- ~ Document inherited vs customer controls

## NIST Control References

Use this format in comments and docs:

```
NIST 800-53: <CONTROL-ID> - <CONTROL-NAME>
```

Common families:

- AC (Access Control)
- AU (Audit & Accountability)
- IA (Identification & Authentication)
- SC (System & Communications Protection)
- SI (System & Information Integrity)
- CM (Configuration Management)

## Egress Rules

- ~ Verify egress configuration for external APIs
- ~ Use trusted-local egress for platform services

## References

- https://docs.cloud.gov/platform/overview/compliance-overview/
- https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final
