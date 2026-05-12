# Security Standards

Baseline security requirements that apply to every project Deft creates or maintains. This is a baseline standards file, not a comprehensive security audit guide — see project-specific threat models for deeper coverage.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Universal Requirements

- ! Validate all inputs at trust boundaries; reject malformed input, do not silently sanitize
- ! Treat all data from outside the trust boundary (users, network, files, agents, tools) as adversarial until validated
- ! Run dependency vulnerability scans on introduction AND on a recurring cadence (weekly minimum)
- ! Keep secrets out of source, logs, error messages, and build artifacts (see [coding.md `Secrets`](coding.md#code-organization))
- ⊗ Roll custom cryptography, authentication, or session handling — use vetted libraries
- ⊗ Disable security checks "temporarily" without an issue tracking re-enablement

## Input Validation & Injection Prevention

- ! Validate type, length, range, and format at every API boundary
- ! Use parameterized queries / prepared statements for ALL database access
- ! Apply context-appropriate output encoding (HTML, URL, JSON, shell, SQL) at the point of use, not at storage
- ! Reject untrusted input outright when it fails validation; do not coerce or "fix" it
- ! Use safe deserialization (JSON over pickle/yaml-load; allow-lists for polymorphic types)
- ⊗ String interpolation in SQL, shell, or command construction
- ⊗ `eval`, `exec`, `subprocess(shell=True)`, or equivalent on untrusted input
- ⊗ Trust client-side validation as the sole defence — re-validate server-side

## Authentication & Authorization

- ! Use established auth libraries / identity providers (OAuth2/OIDC, Passport, Authlib, etc.)
- ! Enforce authorization at the API / service layer, never only in the UI
- ! Use short-lived access tokens; rotate refresh tokens; revoke server-side on logout / compromise
- ! Hash passwords with a memory-hard algorithm (argon2id, bcrypt, scrypt) — never plain SHA / MD5
- ! Enforce MFA for administrative / production access paths
- ⊗ Roll custom session, password, or token handling
- ⊗ Hard-code credentials, API keys, or tokens in source — see Secrets Management below
- ⊗ Log credentials, full tokens, or session cookies

## Secrets Management

Extends and reinforces [coding.md Secrets rule](coding.md#code-organization).

- ! Store ALL secrets in `secrets/` as `.env` files (or a dedicated secret manager), gitignored
- ! Read secrets via environment variables / vault clients at runtime
- ! Rotate secrets on a documented cadence and on any suspected compromise
- ! Redact tokens, passwords, and PII before logging or surfacing in error messages
- ⊗ Secrets in code, config committed to VCS, CI logs, or chat transcripts
- ⊗ Print, `echo`, or interpolate secrets into shell strings; pass via env or `--*-file` flags instead
- ⊗ Log full credentials, refresh tokens, or PII

## Dependency Security

- ! Pin direct dependency versions in lock files (`uv.lock`, `package-lock.json`, `go.sum`, `Cargo.lock`)
- ! Audit dependencies on introduction with the language-native scanner:
  - Python: `pip-audit` (or `uv pip audit`)
  - Node: `npm audit` / `pnpm audit`
  - Go: `govulncheck`
  - Rust: `cargo audit`
- ! Enable Dependabot (or equivalent) for weekly version + security PRs
- ! Resolve CRITICAL / HIGH advisories before merge; document deferral with a tracked issue
- ~ Run `osv-scanner scan source --recursive .` periodically across mixed-language repos
- ⊗ Disable lockfile checks to "speed up" CI
- ⊗ Pin to floating refs (`main`, `latest`, `@v1`) for third-party GitHub Actions — pin to a full SHA

## Agent-Specific Threats

Directive builds AI agent frameworks; agents introduce a distinct threat surface beyond classic web security.

- ! Treat ALL user-provided content (chat, files, tool outputs, web fetches) as potentially adversarial — assume prompt injection
- ! Isolate tool outputs from the trust boundary: never expose raw internal file contents, environment variables, or system prompts to untrusted input channels
- ! Gate destructive tool calls (file deletion, repo deletion, force-push, admin merge, billing changes) behind explicit user consent OR a deterministic preflight check
- ! Bound agent autonomy: declare per-tool allow / deny lists; do not grant blanket shell or network access by default
- ! Log every tool invocation with arguments redacted for secrets so post-incident review is possible
- ⊗ Reflect retrieved web content, repo issue bodies, or third-party comments directly back into a privileged tool-call argument without sanitization
- ⊗ Expose internal system prompts, hidden tool definitions, or other agents' messages to an untrusted input surface
- ⊗ Run model-suggested shell commands without a deterministic safety classifier (see `scripts/preflight_gh.py` for the canonical pattern)

## Tooling

- ~ Static analysis: language-native linter with security rules enabled (ruff S-rules, golangci-lint gosec, eslint security plugin)
- ~ Secret scanners: `gitleaks` on pre-commit and CI
- ~ SAST: CodeQL default setup for hosted repos
- ~ Container scanning: `trivy fs` or `trivy image` for any Dockerfile / OCI artifact
- ~ Dependency review: GitHub Dependency Review action on PRs

## Reporting Vulnerabilities

- ! Every project MUST document a vulnerability reporting path (GitHub Security Advisories, `SECURITY.md`, or equivalent)
- ! Acknowledge reports within a documented SLA; never silently close
- ⊗ Discuss unfixed vulnerabilities in public issues / PRs

## Anti-Patterns

- ⊗ "We'll add security later" — baseline standards apply from day one
- ⊗ Silent sanitization that masks malformed input rather than rejecting it
- ⊗ Disabling lockfile / signature / scanner checks to ship faster
- ⊗ Trusting agent / model output as if it were validated user input
- ⊗ Logging entire request bodies or environment dumps in production
- ⊗ Granting agents blanket network or shell access without per-tool allow-lists
- ⊗ Reflecting third-party content (issue bodies, web pages, tool outputs) into privileged tool calls unsanitized

---

**See also**: [coding.md](coding.md) (general coding standards, Secrets rule) | [testing.md](testing.md) (Security Tests section) | [hygiene.md](hygiene.md) (error-hiding anti-patterns) | [../scm/github.md](../scm/github.md) (destructive `gh` verbs preflight gate #1019)
