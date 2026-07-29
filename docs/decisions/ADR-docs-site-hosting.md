# ADR: Public docs site hosting (GitHub Pages)

**Status**: accepted — deliverable of #2906.

**Date**: 2026-07-29

**Related**: #2906 (owns the public docs app), #2902 (license packaging, parallel), #2812 (1.0 readiness may list the site as a criterion), #112 (no invented traction / overclaim)

## TL;DR

Host the standalone public docs app as **static files under `docs-site/`**, published with **GitHub Pages** from this repository via GitHub Actions. The day-one public URL is:

`https://deftai.github.io/directive/`

Pointing the product domain **`deft.md`** at that site is an **operator DNS / Pages custom-domain step** outside the default merge path. Until that cutover, README and npm `homepage` cite the GitHub Pages URL.

## Context

- `deft.md` currently redirects to GitHub repo chrome rather than a polished product docs experience (marketing white-paper FLAG, evidence 2026-07-29).
- Install and concepts content (three commands, A/B/C concepts, gates, upgrade) is dense enough that GitHub-only docs raise adopter cost.
- In-repo `docs/` and `content/docs/` remain the **contributor / maintainer source of truth**. The public site is a thin, public-safe home that deep-links into the repo where detail lives.
- No unpublished internal app URL is assumed public or reusable for this surface.

## Decision

1. **Host**: GitHub Pages for `deftai/directive`.
2. **Source tree**: committed static HTML/CSS under `docs-site/` (no CMS, no build step required for v1).
3. **Publish path**: `.github/workflows/docs-site.yml` uploads `docs-site/` with the official Pages actions on pushes to `master` that touch the site (plus `workflow_dispatch`).
4. **Public URL shape (v1)**: project Pages URL `https://deftai.github.io/directive/` (base path `/directive/`). Relative links inside the site keep navigation portable.
5. **Package / README**: `packages/cli/package.json` `homepage` and README docs entry point at that Pages URL (surgical; license packaging stays #2902).
6. **Custom domain (`deft.md`)**: operator-owned follow-up — DNS + Pages custom-domain configuration — documented below; not required to merge #2906.
7. **Content bar**: evidence-bound copy only; version badge tracks the published npm release (`@deftai/directive`), not invented traction metrics.

## Consequences

### What this enables

- A public docs URL that is not “redirect to GitHub repo root” as the primary experience.
- Zero new hosting vendor; uses the same GitHub identity and Actions runners the project already trusts.
- Static files stay reviewable in PRs like any other docs change.
- Contributor SoT stays in-repo; the site can deep-link to README, UPGRADING, LICENSE, and architecture docs.

### Trade-offs

- Project Pages live under `github.io/<repo>/` until a custom domain is attached.
- Enabling Pages **Source: GitHub Actions** is a one-time repo admin setting if not already on (see operator path below).
- No server-side search or CMS on day one (explicit non-goal of #2906).

### Operator steps not controllable from a normal PR

If Pages is not yet enabled for this repo:

1. Open `https://github.com/deftai/directive/settings/pages`.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Merge the workflow on `master` (or run **Deploy docs site** via `workflow_dispatch`).
4. Confirm the deployment environment **github-pages** and the live URL `https://deftai.github.io/directive/`.

Optional **`deft.md` cutover** (after Pages is green):

1. In the same Pages settings, add custom domain `deft.md` (and `www` only if desired).
2. At the DNS host for `deft.md`, add the records GitHub shows (typically A/AAAA for apex and/or CNAME for www). Prefer GitHub’s current docs over hard-coding IPs here.
3. Wait for DNS + TLS; enforce HTTPS when the certificate is ready.
4. Update README / `homepage` only if the canonical public URL should switch from `github.io` to `https://deft.md` (follow-up PR is fine).

## Alternatives considered

- **External docs host / commercial docs product.** Rejected for v1: extra vendor, auth surface, and ops cost before a minimum IA exists.
- **Reuse an unpublished internal web app URL.** Rejected: not public-safe; #2906 forbids relying on unpublished internal URLs.
- **Publish from `/docs` Jekyll on the default branch.** Rejected: `/docs` already holds contributor architecture material; mixing marketing IA with maintainer SoT is confusing. A dedicated `docs-site/` tree keeps boundaries clear.
- **Full marketing microsite / blog CMS.** Explicit non-goal for #2906.

## References

- Issue #2906 — standalone public docs home
- Workflow: `.github/workflows/docs-site.yml`
- Site root: `docs-site/`
- npm package: `@deftai/directive` (`packages/cli/package.json` `homepage`)
