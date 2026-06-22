# Deploy to Cloudflare via Terraform

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [README.md](./README.md) | [via-wrangler.md](./via-wrangler.md) | [via-github-actions.md](./via-github-actions.md)

## Overview

Use HashiCorp Terraform with the [Cloudflare provider](https://registry.terraform.io/providers/cloudflare/cloudflare/latest)
to manage Pages projects, Workers, DNS records, and other Cloudflare resources as
infrastructure-as-code. Terraform handles project creation and configuration but
actual content deployments still require Wrangler or Git integration.

**Best for**: Teams managing Cloudflare alongside other infrastructure (DNS, tunnels, WAF rules),
or organizations requiring versioned, reviewable infrastructure changes.

## Prerequisites

- Cloudflare account with API token
- Terraform CLI installed
- Cloudflare provider `~> 5`

## Authentication

```bash
# Set via environment variable (recommended)
export CLOUDFLARE_API_TOKEN=<token>

# Or in provider block (less secure)
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
```

## Example: Pages Project with Git Integration

```hcl
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

variable "cloudflare_account_id" {}
variable "cloudflare_api_token" {}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

resource "cloudflare_pages_project" "my_site" {
  account_id        = var.cloudflare_account_id
  name              = "my-site"
  production_branch = "main"

  source {
    type = "github"
    config {
      owner             = "my-org"
      repo_name         = "my-repo"
      production_branch = "main"
    }
  }

  build_config {
    build_command   = "npm run build"
    destination_dir = "dist"
  }
}

resource "cloudflare_pages_domain" "custom_domain" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.my_site.name
  domain       = "www.example.com"
}
```

## Standards

### Provider Configuration
- ! Use the Cloudflare provider version `~> 5` (latest major)
- ! Authenticate via `CLOUDFLARE_API_TOKEN` environment variable
- ! Use API tokens (not legacy API keys)
- ⊗ Hardcode API tokens in `.tf` files

### State Management
- ! Store Terraform state remotely (Terraform Cloud, S3, GCS, etc.)
- ! Never commit `terraform.tfstate` to version control
- ! Add `terraform.tfvars`, `.terraform/`, and `*.tfstate*` to `.gitignore`
- ~ Use state locking to prevent concurrent modifications

### Variables & Secrets
- ! Define `cloudflare_account_id` and `cloudflare_api_token` as variables
- ! Pass sensitive values via environment variables or a secrets manager
- ⊗ Commit `terraform.tfvars` containing secrets to version control
- ~ Mark sensitive variables with `sensitive = true`

### Resource Management
- ! Use `cloudflare_pages_project` to create and configure Pages projects
- ! Use `cloudflare_pages_domain` to attach custom domains
- ~ Use `cloudflare_dns_record` to manage DNS records alongside the Pages project
- ~ Use `terraform plan` before every `terraform apply`
- ? Use `cloudflare_worker_script` for Workers deployments (content must be provided inline or from file)

### Limitations
- ! Understand that Terraform creates the Pages project but does **not trigger the first deployment**
  - After `terraform apply`, you must push to the Git repo or manually trigger a deploy
- ~ Use Wrangler or GitHub Actions for the actual content deployment
- ~ Use Terraform for the infrastructure layer (project, DNS, domains, WAF rules)

## 🔧 Patterns

**Pages project + DNS in one config**:
```hcl
resource "cloudflare_pages_project" "site" {
  account_id        = var.cloudflare_account_id
  name              = "my-site"
  production_branch = "main"
  # ... source and build_config
}

resource "cloudflare_dns_record" "site_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  content = "my-site.pages.dev"
  type    = "CNAME"
  proxied = true
}
```

**Separate environments with workspaces**:
```bash
terraform workspace new staging
terraform workspace new production
terraform apply -var-file=staging.tfvars
```

## Anti-Patterns

- ⊗ Store API tokens in `.tf` files or commit `terraform.tfvars` with secrets
- ⊗ Expect Terraform to deploy site content — it manages infrastructure only
- ⊗ Run `terraform apply` without `terraform plan` first
- ⊗ Manage Terraform state locally for team projects
- ≉ Mix Terraform-managed and dashboard-managed settings for the same resource — pick one source of truth
- ≉ Use the Terraform provider alone for the full deployment lifecycle — pair with Wrangler or Git for content

## Compliance Checklist

- ! Cloudflare provider `~> 5` specified in `required_providers`
- ! API token passed via environment variable, not hardcoded
- ! State stored remotely with locking
- ! `terraform plan` reviewed before every `terraform apply`
- ! `terraform.tfvars` and `*.tfstate*` in `.gitignore`
- ~ DNS records managed alongside Pages project in the same config
