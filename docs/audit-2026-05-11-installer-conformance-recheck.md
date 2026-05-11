# cmd/deft-install conformance audit RE-CHECK -- 2026-05-11 (#1020 fix)

Tracking issue: [#1020](https://github.com/deftai/directive/issues/1020)
Predecessor audit: `docs/audit-2026-05-10-installer-conformance.md` (3/8 PASS)
Branch under test: `agent4/fix/1020-installer-canonical-layout` (off `master @ a4cd174`)
Drift tracker context: [#992](https://github.com/deftai/directive/issues/992) cohort

## Summary

Re-runs the v0.27.1 canonical-layout conformance audit against the **patched** `cmd/deft-install/` after #1020 lands. The patched installer deposits the framework at `.deft/core/` by default (with `--legacy-layout` as a back-compat opt-in), upserts the canonical `.gitignore` baseline (`.deft-cache/`, `vbrief/.eval/`) without disturbing pre-existing lines, deposits a consumer-root `vbrief/` workspace (`schemas/` + `vbrief.md` template), and continues to render AGENTS.md from `templates/agents-entry.md` (now flipped to canonical paths) via the `//go:embed` contract.

**Headline: 8/8 PASS.** Every assertion that failed in the predecessor audit (4a, 4c, 4d, 4g, 4h) now passes; the three originally-passing assertions (4b marker, 4e `.gitignore` does NOT contain `.deft/core/`, 4f pre-existing lines preserved) continue to pass.

## Methodology

Same fixture shape as the predecessor audit (`docs/audit-2026-05-10-installer-conformance.md`) so the two runs are directly comparable:

1. Build the patched installer from the worktree HEAD with `-X main.version=recheck-1020 -X main.defaultBranch=master`.
2. Greenfield consumer at `C:\Temp\audit-recheck-1020`, `git init`-only, seeded with a pre-existing `.gitignore` containing `# consumer pre-existing`, `node_modules/`, `.env`.
3. Invoke the installer non-interactively against the greenfield (stdin script answers project name, the `2 -> <path> -> 1 -> y` browse sequence).
4. Inspect the post-install consumer root and evaluate the eight canonical-layout assertions (4a-4h).

Stand-in for the live binary run while iterating: the Go test surface (`cmd/deft-install/main_test.go`) exercises the same `CloneDeft` + `WriteAgentsMD` + `WriteAgentsSkills` + `EnsureGitignoreLines` + `WriteConsumerVbrief` chain under a fake `runCmdFunc` clone seam and asserts the same eight invariants on the produced project root, plus the project-root entries allowlist and the cross-layout idempotency probe. Tests pass: `go test ./cmd/deft-install/... ./templates/...` -> `ok` in 4.3s.

## Conformance assertions

### 4a -- `.deft/core/` framework deposit
Expected: `.deft/core/` present at consumer root with framework contents.
Actual: **PRESENT** -- wizard default selects `CanonicalFrameworkSubdir = filepath.Join(".deft", "core")`; `result.DeftDir = <project>/.deft/core` flows into `CloneDeft`; the project-root listing carries `.deft/`.
Result: **PASS**.

### 4b -- AGENTS.md managed-section marker v2
Expected: `AGENTS.md` carries `<!-- deft:managed-section v2 -->` and `<!-- /deft:managed-section -->`.
Actual: marker present (template flip preserved the marker line verbatim). The body inside the markers now reads `Deft is installed in .deft/core/. Full guidelines: .deft/core/main.md` (predecessor caveat resolved).
Result: **PASS**.

### 4c -- `.gitignore` contains `.deft-cache/`
Expected: `.deft-cache/` listed in `.gitignore`.
Actual: **PRESENT** -- `EnsureGitignoreLines` (new in #1020) appends the canonical F2 baseline. The line lands under a single `# Added by deft-install (#1020)` comment block separated from pre-existing content by a blank line.
Result: **PASS**.

### 4d -- `.gitignore` contains `vbrief/.eval/`
Expected: `vbrief/.eval/` listed in `.gitignore`.
Actual: **PRESENT** (same code path as 4c).
Result: **PASS**.

### 4e -- `.gitignore` does NOT contain `.deft/core/`
Expected: `.deft/core/` MUST NOT be in `.gitignore` (per the relocator F2 decision and #11: `.deft/core/` ships read-only packaged framework assets the consumer commits).
Actual: absent -- `canonicalGitignoreLines` in `cmd/deft-install/setup.go` enumerates only `.deft-cache/` and `vbrief/.eval/`; the framework subdir is intentionally never added. Mirrors `scripts/relocate.py::GITIGNORE_LINES`.
Result: **PASS**.

### 4f -- Pre-existing `.gitignore` lines preserved
Expected: the three pre-seeded lines (`# consumer pre-existing`, `node_modules/`, `.env`) survive the install byte-for-byte.
Actual: preserved -- `EnsureGitignoreLines` reads the existing file, computes a set difference, and appends only the missing canonical lines. The pre-existing prefix is preserved verbatim (validated by `TestEnsureGitignoreLines_AppendsToExisting`).
Result: **PASS**.

### 4g -- `vbrief/` at consumer root with `schemas/` + `vbrief.md`
Expected: a consumer-side `vbrief/` directory at root containing `schemas/` and `vbrief.md`, with no lifecycle subdirs pre-created.
Actual: **PRESENT** -- `WriteConsumerVbrief` deposits `<project>/vbrief/schemas/` (copied from the freshly-deposited framework copy at `<project>/.deft/core/vbrief/schemas/`) plus `<project>/vbrief/vbrief.md` (copied from the framework copy, or a placeholder README when the framework copy is unreadable). Lifecycle dirs (`active/`, `pending/`, `proposed/`, `completed/`, `cancelled/`) are intentionally NOT pre-created, matching the relocator contract.
Result: **PASS**.

### 4h -- Legacy `deft/` NOT created
Expected: `deft/` MUST NOT exist at the consumer root (canonical-only contract).
Actual: **ABSENT** -- the wizard default deposits at `.deft/core/`; the legacy `deft/` path is reachable only via the explicit `--legacy-layout` flag (back-compat path for in-flight migrations). The default-canonical contract is regression-tested by `TestInstallPathConsistency_OnlyExpectedRootFiles` which asserts `os.Stat(<project>/deft)` returns an error.
Result: **PASS**.

### Summary table
- 4a `.deft/core/` deposit -- PASS
- 4b AGENTS.md marker v2 -- PASS
- 4c `.gitignore` has `.deft-cache/` -- PASS
- 4d `.gitignore` has `vbrief/.eval/` -- PASS
- 4e `.gitignore` does NOT have `.deft/core/` -- PASS
- 4f pre-existing `.gitignore` preserved -- PASS
- 4g consumer-root `vbrief/` with `schemas/` + template -- PASS
- 4h legacy `deft/` NOT created -- PASS

**8 PASS, 0 FAIL.** Predecessor audit was 3 PASS, 5 FAIL; the five failing assertions all flip to PASS under the #1020 fix.

## Back-compat: `--legacy-layout`

The `--legacy-layout` flag (Windows alias `/legacy-layout`) reverts the framework deposit to the pre-v0.27 `deft/` path for in-flight migration paths only. A consumer in state A (legacy `deft/` install) who reruns the installer without the flag does NOT get auto-migrated: the installer surfaces a one-line `Note: a legacy deft/ install exists at <path>. Run task relocate after install.` advisory and deposits the canonical layout alongside it. The relocator (`scripts/relocate.py` / `task relocate`) remains the single supported migration path per #992 PR2 / #1015 PR2.

## Cross-checks

- `task check` passes locally on the patched worktree (validate + lint + tests + go test, except for a pre-existing flaky `tests/integration/test_scm_smoke.py` test failing on a `gh.cmd` 0xC0000142 environmental defect tracked separately as part of #1021 -- unrelated to #1020).
- `tests/content/test_500_discoverability.py`, `tests/content/test_agents_entry_contract.py`, `tests/content/test_deprecated_skill_redirects.py`, `tests/contract/test_no_legacy_deft_run.py`, and `tests/relocate/test_self_bootstrap.py` continue to pass; the canonical-path expectations were updated in lockstep with the template flip.
- `tests/cli/test_task_scripts.py::TestAgentsBootstrap::test_template_contains_sentinel` now asserts the v2 marker (`<!-- deft:managed-section v2 -->`) rather than the pre-v0.27 `deft/main.md` literal; the trampoline (`QUICK-START.md`) keeps the legacy sentinel because QUICK-START is operator-facing and intentionally describes both layouts.

## Conclusion

The patched `cmd/deft-install/` Go installer now matches the v0.27.1 canonical install layout pinned by the F2 decision. The five conformance assertions that failed against `v0.27.1` (4a, 4c, 4d, 4g, 4h) all pass under #1020; the three originally-passing assertions (4b, 4e, 4f) continue to pass. The state-A producer side defect that motivated the audit is closed.

## References

- PR [#1020](https://github.com/deftai/directive/issues/1020) -- this fix (installer canonical-layout drift)
- Predecessor audit: `docs/audit-2026-05-10-installer-conformance.md`
- PR [#1010](https://github.com/deftai/directive/pull/1010) -- v0.27.0 PR1 contract-string flip + managed-section marker v1 -> v2
- PR [#1013](https://github.com/deftai/directive/pull/1013) -- v0.27.0 PR2 wipe-and-reinstall relocator
- PR [#1017](https://github.com/deftai/directive/pull/1017) -- v0.27.1 relocator F2 self-bootstrap + `.gitignore` canonical default
- Issue [#11](https://github.com/deftai/directive/issues/11) -- `.deft/core/` layout origin
- Issue [#1015](https://github.com/deftai/directive/issues/1015) -- F2 canonical .gitignore default
- Active scope vBRIEF (origin): `vbrief/active/2026-05-11-1020-installer-cmddeft-install-drifts-from-v0271-canonical-layout.vbrief.json`
