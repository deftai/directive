<!-- deft:template -->
<!-- Produced by skills/deft-directive-cost/SKILL.md from the approved spec. -->

# Cost & Budget Estimate

> All figures are in **US dollars (USD)**. These are loose ranges, not exact
> numbers. If the specification or release infrastructure changes, redo this
> estimate before building.

## TL;DR

This issue should add no new recurring service cost: it reuses the project's
existing GitHub, npm, Node.js, and CI setup. A typical month is expected to
remain at **$0-$10**; costs would rise only if unusually heavy CI use exceeds
the allowances on the project's current accounts.

## What you will need to sign up for

- GitHub account and repository access (existing account; free tier is enough
  for this change)
- npm account with access to the existing `@deftai/directive` package (existing
  account; no new paid plan required)
- Local Node.js and pnpm toolchain (already used by the project)

## Hosting & infrastructure

- **Application hosting**: $0 / month; this change adds no hosted application.
- **Release registry**: expected $0 / month beyond the project's existing npm
  arrangement.
- **Continuous integration**: expected $0-$10 / month within the project's
  existing GitHub setup; unusually heavy reruns could increase usage.

## API & third-party fees

The feature checks the existing git remote and npm registry only when the user
explicitly runs the network-enabled doctor. It adds no paid API or new vendor.

> Assumption used for this estimate: normal open-source release traffic, up to
> about 1,000 network-enabled doctor runs per day, with npm and GitHub continuing
> to serve ordinary registry and git requests under their existing terms.

- **Git remote lookup**: expected $0 / month.
- **npm release lookup**: expected $0 / month.

## Monthly band

- **Low** _(local development and normal release traffic)_: $0 / month
- **Typical** _(normal use under the assumption above)_: $0-$10 / month
- **High** _(many repeated CI runs or account allowances exceeded)_: $20-$100
  / month

## Scale considerations

The runtime check itself is small. The main cost risk is repeated CI or review
runs, not end-user traffic. If release checks are invoked at far higher volume
than assumed, caching or registry-rate-limit handling should be reviewed before
buying additional service capacity.

## Build & maintenance time

- **Build**: about 8-16 hours of focused implementation, tests, documentation,
  PR review, and CI follow-through
- **Maintenance**: about 0-2 hours in a typical month, mainly when release-tag or
  package-version behavior changes

## Decision point

Pick **one**. The build phase will refuse to start until this is recorded.

1. **Build** -- proceed to build with this cost expectation.
2. **Rescope** -- keep building but reduce cost first. List the specification
   changes, then redo this estimate.
3. **No-build** -- stop here. Record the reason below.
4. **Skip** -- skip the cost phase. Record a short reason.

### Decision recorded

- **Decision**: build
- **Date**: 2026-07-14
- **Recorded by**: Flynn
- **Reason** (required for skip / no-build / rescope): Not required for build.

---

_This estimate is a snapshot. Vendor pricing changes over time. Redo this file
before any major scope change. Methodology lives in
[content/references/cost-models.md](content/references/cost-models.md)._
