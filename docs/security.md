# Security

Security posture, audit cadence, and vulnerability-reporting flow for the Deft framework (`deftai/directive`).

## 2026-05-12 audit baseline

This is the inaugural baseline recorded by the 2026-05-12 supply-chain hygiene cohort (parent #1069). Future scans start from this anchor and any regression against it is immediately visible.

- **Audit date:** 2026-05-12
- **Scanners run:**
  - `osv-scanner scan source --recursive .` (resolves OSV advisories across `pyproject.toml`, `uv.lock`, `go.mod`)
  - `gitleaks detect --redact` (scans the working tree + git history for credential-shaped secrets)
  - Both live in the v0.29.0 / v0.29.1 cohort. Future cadence adds `trivy fs --severity CRITICAL,HIGH --ignore-unfixed` for filesystem-level CVE coverage on container-style consumers.
- **Findings resolved (from #1069):**
  1. **gitleaks `private-key` hit in `tests/test_cache_scanner.py`** (PEM fixture at lines 340-344) remediated via **PR #1077** (#1070) -- fixtures now use synthetic split-literal markers carrying a `# gitleaks:allow` annotation; the runtime-concatenated string still exercises the scanner regex at `scripts/cache_scanner.py::_CREDENTIAL_PATTERNS` so detection coverage is unchanged.
  2. **`curl | bash` and `irm | iex` live-pipe install patterns in `.github/workflows/ci.yml`** removed via **PR #1077** (#1070) -- replaced with download-to-temp-file + SHA256-verify + execute-on-match flows; new `GHX_INSTALL_SH_SHA256` / `GHX_INSTALL_PS1_SHA256` env vars pin the installer checksums for `ghx v1.5.1` so an immutable-tag force-move fails the step rather than executing tampered code.
  3. **22 live OSV advisories against the Go stdlib** (range `GO-2025-3503` through `GO-2026-4971`) resolved via **PR #1076** (#1071) -- `go.mod` bumped from `go 1.22` to `go 1.25` plus a new `toolchain go1.25.10` directive that pins the minimum patch covering the highest-patch advisory. Live count diverged from the 40 cited in #1069 (the original count was against pre-merge state; intervening dependabot bumps auto-cleared the rest before the slice landed). `uv.lock`'s 20 Python packages all scanned clean.
  4. **No `.github/dependabot.yml`** -- deposited via **PR #1077** (#1070); configures weekly version + security update PRs for `pip` (root `pyproject.toml`), `gomod` (root `go.mod` covering `cmd/deft-install/`), and `github-actions` (the workflows at `.github/workflows/**`) with `open-pull-requests-limit: 5` per ecosystem and dependency-class labels for PR triage.
  5. **Actions floating-ref `uses:` pinning gaps + permissive default `GITHUB_TOKEN` scopes** in `.github/workflows/**` resolved via the **#1072 PR landing alongside this slice** -- migrates all Actions references to commit-SHA pins (immutable refs) and adds least-privilege `permissions:` blocks per workflow so a compromised Action cannot escalate beyond its declared scope.
- **Residual risk:** no unfixable advisories remain after PR #1076. `osv-scanner scan source --recursive .` on master at tag `v0.29.1` reports `No issues found`. The gitleaks scanner reports zero `private-key` hits after PR #1077. No outstanding CRITICAL/HIGH advisories were carried over from the audit.

## Audit cadence

- **Quarterly** -- a full scanner run (`osv-scanner` + `gitleaks` + `trivy fs` once added) is executed at the start of each quarter and the result recorded as a new `## YYYY-MM-DD audit baseline` section in this document.
- **Event-driven** -- any of the following triggers an unscheduled re-audit:
  - A dependabot security PR fails CI or is dismissed for a non-trivial reason.
  - The scanner-CI job (or any future scanner-CI surface) escalates a CRITICAL or HIGH finding on master.
  - A newly-disclosed advisory affects the active toolchain (Go / Python / Node) at the pinned version, regardless of whether OSV has indexed it yet.

Event-driven runs append a new section dated the day of the trigger; they do not replace the most recent quarterly baseline.

## Reporting a vulnerability

If you discover a vulnerability in Deft, please report it through GitHub Security Advisories on the `deftai/directive` repository: <https://github.com/deftai/directive/security/advisories/new>. GitHub-issued advisories are private by default and let maintainers coordinate a fix + CVE assignment + coordinated-disclosure window with the reporter before any public disclosure. Please include a minimal reproduction, the affected version (e.g. `v0.29.1`), the impact you observed, and any suggested remediation. A private maintainer email address may be published in a future revision of this document; until then GitHub Security Advisories is the canonical reporting flow.

## Out of scope / follow-ups

- **#1084 -- PyPI OIDC trusted-publishing workflow** (deferred, blocked-by **#11**) -- migrating release publishing to PyPI's OIDC trusted-publisher flow eliminates the need for a long-lived `PYPI_API_TOKEN` secret in CI and is the canonical 2026-era best practice. The follow-up is intentionally deferred: trusted-publishing is meaningless until Deft is published to PyPI, and the upstream PyPI proposal (#11) -- which decides whether and how Deft publishes to PyPI -- is still OPEN. #1084 will activate once #11 lands.

Out-of-scope items are tracked in their own scope vBRIEFs and do not count against the audit baseline.
