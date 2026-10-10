/**
 * Wave 8.5 Bucket B coverage map: pytest CLI tests → TS vitest / existing-coverage (#1838 s3).
 * Python tests remain in-tree until Wave 9 (#1731); entries tagged wave9-delete are dedup candidates.
 */

export type CoverageDisposition = "existing-coverage" | "lifecycle-cli-dispatch" | "python-oracle";

export interface CoverageMapEntry {
  readonly pythonTest: string;
  readonly tsTarget: string;
  readonly disposition: CoverageDisposition;
  readonly wave9Delete: boolean;
  readonly notes: string;
}

/** Canonical mapping for lifecycle CLI pytest files in scope of story 1838-s3. */
export const LIFECYCLE_CLI_COVERAGE_MAP: readonly CoverageMapEntry[] = [
  {
    pythonTest: "tests/cli/test_vbrief_activate.py",
    tsTarget:
      "packages/core/src/vbrief-activate/{activate,main,coverage-boost}.test.ts + lifecycle-cli/dispatch-vbrief.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "Module matrix in core; deft-ts vbrief-activate argv/exit in lifecycle-cli.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_fidelity_legacy.py",
    tsTarget: "packages/core/src/vbrief-validation/fidelity.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Legacy fidelity normalization covered in TS vbrief-validation module.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_migrate_conformance.py",
    tsTarget: "packages/core/src/vbrief-validate/main.test.ts (scanVbrief/conformance)",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Conformance scan parity in vbrief-validate TS port.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_preflight_resolver.py",
    tsTarget:
      "packages/cli/src/vbrief-preflight.test.ts + lifecycle-cli/dispatch-preflight.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: false,
    notes:
      "Install-layout resolver still Python-only; TS preflight gate + dispatcher alias covered.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_reconcile_graph.py",
    tsTarget: "packages/core/src/vbrief-reconcile/graph.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Dependency-graph promotion logic in TS vbrief-reconcile.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_reconcile_labels.py",
    tsTarget: "packages/core/src/vbrief-reconcile/labels.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Label/status derivation covered in TS reconcile engine.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_reconcile_umbrellas.py",
    tsTarget: "packages/core/src/vbrief-reconcile/umbrellas.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Umbrella current-shape render/parse in TS.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_reconciliation.py",
    tsTarget: "packages/core/src/vbrief-reconcile/reconciliation.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Override reconciliation table covered in TS.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_routing.py",
    tsTarget: "packages/core/src/vbrief-build/routing.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Status↔folder routing map in TS vbrief-build.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_validate.py",
    tsTarget: "packages/core/src/vbrief-validate/main.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "validateAll matrix in core; deft-ts vbrief-validate argv in lifecycle-cli.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_validate_direct.py",
    tsTarget: "packages/core/src/vbrief-validate/branches.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Direct validate orchestration branches in TS.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_validate_direct_orchestration.py",
    tsTarget: "packages/core/src/vbrief-validate/branches.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Reference/orchestration warnings in TS validate-all.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_validate_issue_536.py",
    tsTarget: "packages/core/src/vbrief-validate/branches.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "x-vbrief/github-issue reference counting in TS.",
  },
  {
    pythonTest: "tests/cli/test_vbrief_validation.py",
    tsTarget: "packages/core/src/vbrief-validation/validation.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "Slug/title normalization in core; deft-ts vbrief-validation argv in lifecycle-cli.",
  },
  {
    pythonTest: "tests/cli/test_scope_decompose.py",
    tsTarget: "packages/core/src/scope/decomposed-refs.test.ts",
    disposition: "python-oracle",
    wave9Delete: false,
    notes:
      "scope:decompose CLI still Python; unit helpers partially covered in decomposed-refs TS.",
  },
  {
    pythonTest: "tests/cli/test_scope_decompose_unit.py",
    tsTarget: "packages/core/src/scope/decomposed-refs.test.ts",
    disposition: "existing-coverage",
    wave9Delete: false,
    notes: "Pure decomposition helpers; CLI entry remains Python until Wave 9.",
  },
  {
    pythonTest: "tests/cli/test_scope_demote.py",
    tsTarget: "packages/core/src/scope/demote.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "Demote transitions in core; deft-ts scope-lifecycle argv in lifecycle-cli.",
  },
  {
    pythonTest: "tests/cli/test_scope_lifecycle.py",
    tsTarget: "packages/core/src/scope/{main,transition,scope-exhaustive}.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "Promote/activate/complete matrix in core; scope-lifecycle dispatcher in lifecycle-cli.",
  },
  {
    pythonTest: "tests/cli/test_scope_undo.py",
    tsTarget: "packages/core/src/scope/undo.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Undo round-trip covered in TS scope module.",
  },
  {
    pythonTest: "tests/cli/test_issue_emit.py",
    tsTarget: "packages/core/src/intake/issue-emit.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "Emit body/render in core; deft-ts issue-emit argv in lifecycle-cli.",
  },
  {
    pythonTest: "tests/cli/test_issue_ingest.py",
    tsTarget:
      "packages/core/src/intake/{issue-ingest,intake-cli-and-branches}.test.ts + lifecycle-cli/dispatch-intake.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "Ingest happy-path/duplicate in core; dispatcher routing in lifecycle-cli.",
  },
  {
    pythonTest: "tests/cli/test_issue_ingest_body_parsing.py",
    tsTarget: "packages/core/src/intake/markdown-scanners.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Checkbox/AC body scanners in TS intake module.",
  },
  {
    pythonTest: "tests/cli/test_issue_ingest_canonical_refs.py",
    tsTarget: "packages/core/src/intake/issue-ingest.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "v0.6 canonical reference shape in TS ingest.",
  },
  {
    pythonTest: "tests/cli/test_issue_ingest_direct.py",
    tsTarget: "packages/core/src/intake/intake-coverage-boost.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Repo URL / gh helper branches in TS intake.",
  },
  {
    pythonTest: "tests/cli/test_issue_ingest_escape_corruption.py",
    tsTarget: "packages/core/src/intake/intake-cli-and-branches.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Literal escape preservation in TS ingest path.",
  },
  {
    pythonTest: "tests/cli/test_reconcile_issues.py",
    tsTarget: "packages/core/src/intake/reconcile-issues.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "Reconcile classification in core; deft-ts reconcile-issues argv in lifecycle-cli.",
  },
  {
    pythonTest: "tests/cli/test_reconcile_issues_754.py",
    tsTarget: "packages/core/src/intake/reconcile-issues.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Batch gh state fetch (>500) in TS reconcile module.",
  },
  {
    pythonTest: "tests/cli/test_reconcile_issues_apply.py",
    tsTarget: "packages/core/src/intake/reconcile-issues.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "Apply/move section-C entries in TS reconcile.",
  },
  {
    pythonTest: "tests/cli/test_reconcile_issues_direct.py",
    tsTarget: "packages/core/src/intake/intake-coverage-boost.test.ts",
    disposition: "existing-coverage",
    wave9Delete: true,
    notes: "gh subprocess error branches in TS reconcile helpers.",
  },
  {
    pythonTest: "tests/cli/test_preflight_architecture_sor.py",
    tsTarget: "python-oracle (scripts/preflight_architecture_sor.py)",
    disposition: "python-oracle",
    wave9Delete: false,
    notes: "Architecture SOR preflight not yet on deft-ts; stays Python until TS port.",
  },
  {
    pythonTest: "tests/cli/test_preflight_branch.py",
    tsTarget:
      "packages/core/src/branch/evaluate.test.ts + packages/cli/src/verify-branch.test.ts + lifecycle-cli/dispatch-preflight.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "Branch gate in core/cli; verify-branch + vbrief:preflight alias via dispatcher.",
  },
  {
    pythonTest: "tests/cli/test_preflight_cache.py",
    tsTarget: "python-oracle (scripts/preflight_cache.py)",
    disposition: "python-oracle",
    wave9Delete: false,
    notes:
      "verify:cache-fresh still Python-only per Wave 8 notes; TS cache module covers fetch not preflight gate.",
  },
  {
    pythonTest: "tests/cli/test_preflight_gh.py",
    tsTarget: "python-oracle (scripts/preflight_gh.py)",
    disposition: "python-oracle",
    wave9Delete: false,
    notes:
      "Destructive gh preflight still Python-only; intake github-auth-modes partially overlaps read paths.",
  },
  {
    pythonTest: "tests/cli/test_preflight_implementation.py",
    tsTarget:
      "packages/core/src/preflight/evaluate.test.ts + packages/cli/src/vbrief-preflight.test.ts + lifecycle-cli/dispatch-preflight.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes:
      "#810 state matrix in core; vbrief:preflight / vbrief-preflight dispatcher in lifecycle-cli.",
  },
  {
    pythonTest: "tests/cli/test_preflight_story_start.py",
    tsTarget:
      "packages/core/src/story-ready/evaluate.test.ts + packages/cli/src/verify-story-ready.test.ts + lifecycle-cli/dispatch-preflight.test.ts",
    disposition: "lifecycle-cli-dispatch",
    wave9Delete: true,
    notes: "Gate 0 matrix in core; verify:story-ready alias via deft-ts dispatcher.",
  },
] as const;

export const LIFECYCLE_PYTHON_TEST_FILES = LIFECYCLE_CLI_COVERAGE_MAP.map((e) => e.pythonTest);
