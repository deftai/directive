# Security Policy

## Reporting a vulnerability

**Do not open public GitHub issues for security vulnerabilities.** Public issues disclose the flaw before a fix can ship and make coordinated remediation harder.

Report vulnerabilities through a **private** channel instead:

1. **GitHub Private Vulnerability Reporting (preferred)** — on the repository **Security** tab, choose **Report a vulnerability**. Reports stay private until maintainers publish an advisory.
2. **Email** — if Private Vulnerability Reporting is unavailable, email [security@deftai.dev](mailto:security@deftai.dev) with a description, impact, reproduction steps, and any proof-of-concept you can share safely.

Please do not discuss unfixed vulnerabilities in public issues, pull requests, or social channels.

## Supported versions

Security fixes are provided for the **latest published minor release line** of the Directive npm packages and their bundled framework payload:

| Package | Supported |
| --- | --- |
| `@deftai/directive` | Latest minor only |
| `@deftai/directive-core` | Latest minor only |
| `@deftai/directive-content` | Latest minor only |
| `@deftai/directive-types` | Latest minor only |

Older release lines may receive fixes at maintainer discretion when backporting is practical. Upgrade to the latest release before reporting issues that may already be fixed.

## Scope

**In scope**

- The `@deftai/directive`, `@deftai/directive-core`, `@deftai/directive-content`, and `@deftai/directive-types` npm packages
- The vendored framework payload installed under `.deft/core/` by Directive
- Official install, update, and CLI surfaces shipped from this repository

**Out of scope**

- Vulnerabilities in consumer application code, custom agent prompts, or third-party tools Directive integrates with but does not ship
- Social-engineering attacks against individual maintainers or users
- Denial-of-service against public infrastructure without a demonstrated exploit path in Directive itself

## Response expectations

- **Acknowledgment:** We aim to acknowledge receipt within **2 business days**.
- **Triage:** We will assess severity and scope, and may ask for clarification.
- **Coordinated disclosure:** We work toward a fix and advisory on a reasonable timeline (typically within **90 days** for confirmed issues). We will agree on a publication date with you when possible.
- **Credit:** With your permission, we credit reporters in the advisory.

## Safe harbor

We support good-faith security research on in-scope systems. If you:

- Make a reasonable effort to avoid privacy violations, data destruction, and service disruption;
- Report only the minimum information needed to demonstrate the issue;
- Give us reasonable time to investigate and remediate before public disclosure; and
- Do not exploit the issue beyond what is necessary to demonstrate impact,

we will not pursue legal action or ask law enforcement to investigate you for that research. This safe harbor does not apply if you violate applicable law or access data belonging to others without authorization.

## Questions

For non-security questions, use [GitHub Issues](https://github.com/deftai/directive/issues). For security matters, use the private channels above.
