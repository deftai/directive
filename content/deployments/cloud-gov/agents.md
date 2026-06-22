# Cloud.gov Agent Instructions (Deft)

Agent behaviors and safety guardrails for cloud.gov projects.

## Core Behaviors

- ! Ask for explicit confirmation before **any** destructive `cf` command
- ! Confirm org/space before modifying resources
- ! Warn clearly when targeting production
- ~ Explain impact before running modifying commands

## Destructive Commands (ALWAYS confirm)

- `cf delete`
- `cf delete-service`
- `cf delete-service-key`
- `cf delete-route`

## Modifying Commands (confirm in prod)

- `cf push`
- `cf restage`
- `cf restart`
- `cf scale`
- `cf set-env`
- `cf update-service`

## Safe Commands (no confirmation)

- `cf apps`, `cf app <name>`
- `cf services`, `cf service <name>`
- `cf logs <name> --recent`
- `cf env <name>`
- `cf routes`, `cf target`, `cf marketplace`

## Security Guidance

- ! Include NIST SP 800-53 control references in security-relevant code
- ~ Reference inherited controls from cloud.gov in documentation
