# Privacy NFR — Triage Cache Local Storage (#845)

Non-functional requirement for the local issue-body cache at
`.deft-cache/issues/<owner>-<repo>/<N>.{json,md}`. Authored under #845 Story 6.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Summary

Triage v1 mirrors GitHub issue body content into a local sidecar cache so the
refinement skill can evaluate candidates without re-fetching from the API on
every pass. Issue bodies from **private** repositories are user data and MUST
NOT leak into shared distribution channels (commits to a public branch,
release artefacts, telemetry) without explicit opt-in.

This NFR codifies the privacy contract:

1. The cache directory is **gitignored by default**.
2. The consumer MAY opt in to committing the cache for shared-cache scenarios.
3. Private-repo body content cached locally is treated as user data: it is
   stored in plain text on the local filesystem, is never transmitted by any
   deft surface, and the framework provides no automated path to publish it.

## Scope

This NFR governs `.deft-cache/` and any data the triage cache writes to it.
It does NOT govern:

- The GitHub API responses themselves (those live on GitHub under the
  account's existing permissions).
- The audit log at `vbrief/.eval/candidates.jsonl` (Story 2). The audit log
  records DECISIONS (accept / reject / defer) plus minimal metadata; it does
  NOT mirror issue body content. Audit-log retention and visibility are
  governed by the audit-log schema, not by this NFR.
- The local Git worktree as a whole. Operators who fork a private repo into
  a public mirror, copy files, or screen-share their working tree are out
  of the framework's protection envelope.

## Requirements

### NFR-1 — Gitignore default-on

! `task triage:bootstrap` (Story 6) MUST add the literal line `.deft-cache/`
to the project's `.gitignore` if it is not already present.

! Story 1's `tasks/triage-cache.yml` MAY also add the line on first run as
defence-in-depth — the bootstrap target makes the action idempotent so a
second add is a no-op.

! The default-on stance is **fail-safe**: a consumer who runs
`task triage:cache` without first running bootstrap, OR who removes the
gitignore line manually, MUST NOT have their cache silently committed by
deft tooling. Tooling that writes to `.deft-cache/` SHOULD print a one-line
warning when the gitignore line is absent (e.g.
`WARN: .deft-cache/ is not in .gitignore — see docs/privacy-nfr.md`).

⊗ Tooling MUST NOT auto-add commits that include `.deft-cache/` content
without an explicit opt-in flag (see NFR-2).

### NFR-2 — Opt-in commit-cache path

? A consumer MAY choose to commit the cache for shared-cache scenarios, e.g.
when a small team wants to share a baseline triage state under version
control to avoid every member re-running `task triage:cache` from scratch.

The opt-in is performed manually by editing `.gitignore`:

```diff
-.deft-cache/
+# .deft-cache/  (commented out -- this project commits the cache)
```

! If a consumer opts in, they accept responsibility for the contents of the
cache. The framework does NOT inspect cache contents for sensitive data
prior to commit; it is the consumer's responsibility to verify that the
upstream issues sourced into the cache are safe to commit (e.g. all-public
repos, or a private fork that the team controls end-to-end).

! The opt-in MUST be a deliberate edit to the project's `.gitignore`. Deft
tooling MUST NOT provide a one-liner `task triage:commit-cache` shortcut
that performs the gitignore edit automatically — the manual step is the
deliberate-action gate.

~ Consumers who opt in SHOULD additionally configure pre-commit hooks (e.g.
`pre-commit-hooks/forbidden-strings`) to scan cached bodies for credentials
or other accidentally-quoted secrets before they reach the remote. This is
out of scope for the triage v1 framework but is mentioned for completeness.

### NFR-3 — Local-only at rest

! The cache lives ONLY on the local filesystem under `.deft-cache/`. Deft
tooling MUST NOT transmit cache contents to any external endpoint
(telemetry, error reporting, crash logs, release builds, CI artefacts).

! The cache is not encrypted at rest — it relies on the local filesystem's
existing access controls. Operators who require encryption MUST place the
project root on an encrypted filesystem (BitLocker, FileVault, LUKS, dm-crypt)
themselves; deft does not provide a per-cache encryption layer in v1.

! The cache MAY be removed at any time via `rm -rf .deft-cache/` (or
`Remove-Item -Recurse -Force .deft-cache/` on Windows). The next
`task triage:cache` run repopulates from upstream. Cache removal is
non-destructive — only the local mirror is affected, the upstream issues
are untouched.

### NFR-4 — Private-repo body content treatment

! Private-repo issue body content cached locally inherits the privacy class
of the source repo. A user with `read` access to a private repo can mirror
the bodies into `.deft-cache/`; sharing the working directory (e.g. tarball,
shared filesystem) effectively shares the cache.

! Authors of triage workflows that consume the cache MUST treat the cache
contents as confidential by default and MUST NOT export, log, or otherwise
exfiltrate cached bodies in agent prose, debug output, or PR/issue
comments.

⊗ The framework MUST NOT auto-paste cached body content into PR
descriptions, comments, or any other GitHub surface that is visible to
parties beyond the original repo's audience.

### NFR-5 — Cache contents are user data

! For the purposes of GDPR / CCPA / equivalent regulations, cached body
content is **user data** (the original issue authors are the data subjects).
Operators in regulated environments are responsible for their own data-flow
audits; deft surfaces the storage location (`.deft-cache/`) so the audit is
straightforward.

? The cache structure is documented (one JSON file per issue, one rendered
quarantined Markdown file per issue, both under
`.deft-cache/issues/<owner>-<repo>/<N>.{json,md}`) so a deletion request
maps to a single `rm` invocation per issue number.

## Verification

The privacy NFR is verified at three layers:

1. **Bootstrap test**: `tests/test_triage_bootstrap.py` asserts that
   `task triage:bootstrap` adds `.deft-cache/` to `.gitignore` when absent
   AND that re-running the bootstrap is a no-op when present (NFR-1).
2. **Documentation test** (this file): the markdown link checker
   (`task verify:links`) ensures cross-references between
   `UPGRADING.md`, `docs/privacy-nfr.md`, and
   `docs/quarantine-spec.md` resolve.
3. **Manual review**: NFR-2 / NFR-3 / NFR-4 / NFR-5 are policy claims about
   tooling behaviour. They are verified by code review on every PR that
   touches the triage cache surface (`scripts/triage_cache.py`,
   `scripts/triage_bootstrap.py`, `scripts/triage_actions.py`,
   `scripts/triage_bulk.py`).

## References

- [Issue #845](https://github.com/deftai/directive/issues/845) — pre-ingest
  triage workflow umbrella.
- [docs/quarantine-spec.md](./quarantine-spec.md) — companion spec for the
  injection-quarantine that wraps cached body content (#583).
- `scripts/triage_cache.py` — the writer that mirrors upstream issues into
  `.deft-cache/`.
- `scripts/triage_bootstrap.py` — the idempotent installer that adds
  `.deft-cache/` to `.gitignore` on first run.
- [UPGRADING.md](../UPGRADING.md) — Migration to triage v1 section that
  cross-links to this NFR.
