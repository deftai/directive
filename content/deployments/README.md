# Deployments Layer

Platform-specific guidance for deployment environments (cloud.gov, Cloudflare, AWS, agentuity, etc.).

## Purpose

- ! Provide **optional** platform modules that can be applied per project
- ~ Keep platform guidance separate from core Deft rules
- ~ Enable export of platform instructions for external tools (e.g., Copilot)

## Module Structure

Create a directory per platform:

```
deployments/
  <platform>/
    README.md
    overview.md
    deployment.md
    manifest.md
    services.md
    cicd.md
    security.md
    logging.md
    agents.md
    agents/
    skills/
    upstream/
```

Guidelines:

- ! Use hyphens in filenames
- ! Keep modules optional and isolated
- ~ Include a clear README with attribution (if derived)
- ~ Provide export tasks that generate tool-specific outputs
