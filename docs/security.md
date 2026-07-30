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

## 2026-07-29 event-driven remediation -- AppSec install-authenticity (tracker #2904)

AppSec scan tracker **#2904** flagged `deft-install` bootstrap authenticity risks. This section records the hardened trust boundaries for Windows Git-for-Windows (`install-deposit-01` / #2908) and Linux `--yes` uv/task/gh (`install-deposit-02` / #2909). Sibling installer-authenticity findings from the same tracker are remediated under their own issues and PRs.

### Git-for-Windows silent install (`install-deposit-01` / #2908)

- **Finding `install-deposit-01` (High).** On Windows, when `winget` was unavailable or failed, `cmd/deft-install/git.go` downloaded the **latest** Git-for-Windows 64-bit `.exe` via the GitHub Releases API and executed it `/SILENT /NORESTART` with **no SHA-256 or Authenticode pin** -- TLS + "GitHub latest" were the only trust signals. A compromised release/asset or a MitM on the download therefore yielded arbitrary code execution as the installing user during an automated install.
- **Remediation (#2908).** The Windows install path now establishes an explicit trust boundary:
  1. **Pinned release, not `latest`.** The download resolves a hard-coded Git-for-Windows tag (`v2.55.0.windows.3`) and matches its **exact** 64-bit asset name (`Git-2.55.0.3-64-bit.exe`), so the installer cannot silently drift to an untrusted release or an ambiguously-named asset.
  2. **Fail-closed SHA-256 verification.** The downloaded bytes are hashed and compared against a hard-coded, out-of-band-verified SHA-256 (`af12577d…f1dca`) **before any execution**. On any mismatch (or hashing/read error) the installer is **not** run and the rejected temp file is removed. There is no non-verified silent-exec path.
  3. **Pinned winget.** The preferred `winget install --id Git.Git` is pinned with `--version 2.55.0.3`; if that version is unavailable winget fails through to the SHA-256-verified download, which is itself fail-closed -- so no fallback is less safe than the primary path.
- **Pin provenance.** The pinned digest was captured out-of-band at pin time and cross-checked against **both** the GitHub release asset `digest` field **and** the Git-for-Windows-published SHA-256 in the release body for `v2.55.0.windows.3`. Bumping the pinned git version requires updating the tag, winget version, asset name, and digest together (guarded by `TestPinnedGitConstants_Consistent` / `TestPinnedGitForWindowsSHA256_WellFormed`).
- **Residual risk / follow-ups.** Verification is SHA-256 pin only; **Authenticode signature validation is not yet enforced** (deferred -- the digest pin already defeats release/asset tampering and MitM for the pinned artifact). Because the digest is pinned to a single release, security patches to Git-for-Windows require a deliberate pin bump rather than auto-tracking `latest`; this is an intentional trade of freshness for authenticity, mitigated by the pinned-winget preferred path. Fail-closed behaviour is covered by `TestDownloadGitInstaller_FailClosedOnDigestMismatch` and `TestVerifyFileSHA256_Mismatch` in `cmd/deft-install/git_test.go`.

### Linux `--yes` uv / task / gh bootstrap (`install-deposit-02` / #2909)

- **Finding `install-deposit-02` (High).** On Linux non-interactive installs, `EnsureCoreTools` in `cmd/deft-install/setup.go` bootstrapped missing doctor-required tools by downloading **unpinned** install scripts from `astral.sh` / `taskfile.dev` and the **latest** `cli/cli` release tarball into `~/.local/bin` with **no checksum**. Compromise of those CDNs/releases or a MitM yielded arbitrary code under the installing user on `deft-install --yes`.
- **Remediation (#2909).** The Linux bootstrap path now mirrors the CI ghx / #2908 pattern:
  1. **Pinned release assets, not install scripts / `latest`.** uv `0.12.0`, task `v3.52.0`, and gh `v2.96.0` download exact GitHub release tarball URLs for `amd64` / `arm64` / `arm` (gh arm uses the upstream `armv6` asset name). No `curl | sh` install script is executed.
  2. **Fail-closed SHA-256 verification.** Each tarball is downloaded to a temp file and hashed against a hard-coded, out-of-band-verified digest **before any extract/install**. On mismatch or hashing error the archive is refused and deleted; extract never runs. There is no non-verified install path.
  3. **Pure-Go extract into `~/.local/bin`.** After verify, only the required basename (`uv` / `task` / `gh`) is written atomically mode `0755`. Archive path layout is not recreated under the destination (basename-only), removing path-traversal as an install sink.
- **Pin provenance.** Digests were captured from each GitHub release asset `digest` field at pin time and cross-checked by hashing the downloaded bytes locally before commit. Bumping a tool pin requires updating version/tag/URL and the per-arch digest map together (guarded by `TestPinnedLinuxBootstrapDigests_WellFormed` / `TestPinnedLinuxBootstrapAssets_URLAndVersionConsistent`).
- **Residual risk / follow-ups.** Verification is SHA-256 pin only (no cosign/sigstore attestation consumed yet). Pinned releases do not auto-track upstream security patches -- freshness requires a deliberate pin bump (intentional authenticity-over-latest trade, same class as #2908). Architectures outside the pin maps fail closed with a structured bootstrap error rather than falling back to an unpinned script. Fail-closed behaviour is covered by `TestInstallPinnedLinuxTool_FailClosedOnDigestMismatch` and related tests in `cmd/deft-install/setup_test.go`.

## Contained write API (#2951 Phase 1)

Recurring AppSec mediums (symlink / path-escape write sinks) are addressed by a
**mandatory contained-write primitive** rather than unbounded per-sink patches.

- **Contract (agents + maintainers):** [`docs/reference/contained-write.md`](reference/contained-write.md)
- **TS API:** `containedWrite({ root, target, data, mode })` in
  `packages/core/src/fs/contained-write.ts` — modes `create` | `replace` |
  `append`; stable codes such as `CONTAINED_WRITE_ESCAPE` /
  `CONTAINED_WRITE_SYMLINK`.
- **Rule:** new product write sinks MUST use the API; prefer migrating call
  sites onto it over bespoke checks when equivalent.
- **Inventory gate:** `task verify:contained-writes` (Phase 1 **fail-open** /
  advisory; `--enforce` available; not in `task check` yet).
- **Phase 1 residual:** mass migration and Go installer API are later phases;
  TOCTOU residual risk is documented in the contract page.

Epic: https://github.com/deftai/directive/issues/2951

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
