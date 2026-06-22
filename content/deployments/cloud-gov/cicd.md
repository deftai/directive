---
applyTo: "**/.github/workflows/*.yml,**/.github/workflows/*.yaml,**/Jenkinsfile,**/.circleci/config.yml,**/.travis.yml"
---

# Cloud.gov CI/CD Instructions (Deft)

Guidance for deploying to cloud.gov from CI/CD.

## Core Rules

- ! Use service accounts for automation
- ! Store credentials in CI secrets (never in code)
- ~ Rotate credentials every 90 days
- ~ Require manual approval for production

## Service Account

```bash
cf create-service cloud-gov-service-account space-deployer my-deployer
cf create-service-key my-deployer deploy-key
cf service-key my-deployer deploy-key
```

## GitHub Actions (skeleton)

```yaml
name: Deploy to Cloud.gov

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: task test

  deploy:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        uses: cloud-gov/cg-cli-tools@main
        with:
          cf_api: https://api.fr.cloud.gov
          cf_username: ${{ secrets.CG_USERNAME }}
          cf_password: ${{ secrets.CG_PASSWORD }}
          cf_org: your-org
          cf_space: prod
```

## Best Practices

- ~ Deploy from main branch only
- ~ Gate on tests and security checks
- ~ Use rolling or blue/green for production

## References

- https://docs.cloud.gov/platform/management/continuous-deployment/
- https://docs.cloud.gov/platform/services/cloud-gov-service-account/
