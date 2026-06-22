# cloud.gov Deployment Module

Deft-native guidance for cloud.gov deployments, translated from the upstream
`adhocteam/cloud-gov-instructions` project (MIT License).

## Status

- ! Optional module
- ~ Good for Deft usage
- ~ Exportable for Copilot instructions

## Source & Attribution

This module is derived from `adhocteam/cloud-gov-instructions` **v1.1.0**.
See `deployments/cloud-gov/upstream/` for the pinned upstream snapshot.

License: MIT (see `deployments/cloud-gov/LICENSE.md`).

## Files

| File | Purpose |
|------|---------|
| `overview.md` | Repository-level cloud.gov overview |
| `deployment.md` | Deployment workflow & blue/green guidance |
| `manifest.md` | Manifest structure and best practices |
| `services.md` | Managed services and `VCAP_SERVICES` usage |
| `cicd.md` | CI/CD setup, service accounts, workflows |
| `security.md` | FedRAMP guidance, NIST control references |
| `logging.md` | Structured logging & log drains |
| `agents.md` | Agent behaviors & safety guardrails |
| `agents/compliance-docs.md` | Compliance documentation agent |
| `skills/cf-troubleshoot.md` | Troubleshooting skill |

## Tasks

Run these tasks from repo root:

```
task cloudgov:sync
task cloudgov:export
```

### Export Output

Default export target: `.deft/cloud.gov/`

This generates Copilot-compatible files in:

```
.deft/cloud.gov/
  .github/
    copilot-instructions.md
    instructions/
    agents/
    skills/
  AGENTS.md
  LICENSE.md
```

## Notes

- ! Treat `.deft/cloud.gov/` as generated output (do not edit by hand)
- ~ Update `CLOUDGOV_VERSION` and `CLOUDGOV_EXTRACT_DIR` in `taskfiles/deployments.yml` to bump the pinned version
