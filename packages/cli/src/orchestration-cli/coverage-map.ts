/**
 * Wave 8.5 s4 coverage map (#1838): Python CLI tests → TS vitest / existing core coverage.
 * Used in the PR body table and audited by coverage-map.test.ts.
 */
export type CoverageKind = "existing-coverage" | "orchestration-cli-spec";

export interface CoverageEntry {
  readonly pythonTest: string;
  readonly kind: CoverageKind;
  readonly tsTarget: string;
  readonly notes?: string;
}

export const ORCHESTRATION_CLI_PYTHON_TESTS = [
  "test_pr_check_closing_keywords.py",
  "test_pr_check_protected_issues.py",
  "test_pr_merge_readiness.py",
  "test_pr_merge_readiness_fallbacks.py",
  "test_pr_wait_mergeable.py",
  "test_release.py",
  "test_release_branch_gate.py",
  "test_release_e2e.py",
  "test_release_prerelease.py",
  "test_release_publish.py",
  "test_release_pyproject_sync.py",
  "test_release_rollback.py",
  "test_release_rollback_725.py",
  "test_release_skip_flags.py",
  "test_release_subprocess_path.py",
  "test_release_summary.py",
  "test_release_tag_availability.py",
  "test_release_upgrade_banner.py",
  "test_release_vbrief_lifecycle.py",
  "test_swarm_complete_cohort.py",
  "test_swarm_launch.py",
  "test_swarm_readiness.py",
  "test_swarm_verify_review_clean.py",
  "test_swarm_worktrees.py",
  "test_subagent_monitor.py",
  "test_probe_session.py",
  "test_resolve_changelog_unreleased.py",
  "test_resolve_version.py",
] as const;

export const ORCHESTRATION_CLI_COVERAGE_MAP: readonly CoverageEntry[] = [
  {
    pythonTest: "test_pr_check_closing_keywords.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/pr-closing-keywords/main.test.ts",
    notes: "Offline + gh argv parsing; parity in pr-closing-keywords-parity.test.ts",
  },
  {
    pythonTest: "test_pr_check_protected_issues.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/pr-protected-issues/main.test.ts",
  },
  {
    pythonTest: "test_pr_merge_readiness.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/pr-merge-readiness/main.test.ts",
    notes: "Greptile parse + gate evaluation",
  },
  {
    pythonTest: "test_pr_merge_readiness_fallbacks.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/pr-merge-readiness/gh.test.ts",
    notes: "Layered gh fallbacks",
  },
  {
    pythonTest: "test_pr_wait_mergeable.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/pr-wait-mergeable/main.test.ts",
  },
  {
    pythonTest: "test_pr_check_closing_keywords.py",
    kind: "orchestration-cli-spec",
    tsTarget: "packages/cli/src/orchestration-cli/pr-cli.test.ts",
    notes: "deft-ts pr-closing-keywords argv / exit 2 for missing input",
  },
  {
    pythonTest: "test_pr_merge_readiness.py",
    kind: "orchestration-cli-spec",
    tsTarget: "packages/cli/src/orchestration-cli/pr-cli.test.ts",
    notes: "deft-ts pr-merge-readiness / pr-protected-issues / pr-wait-mergeable dispatcher",
  },
  {
    pythonTest: "test_release.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/main.test.ts",
    notes: "Pipeline + changelog promotion",
  },
  {
    pythonTest: "test_release_branch_gate.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/pipeline-branches.test.ts",
  },
  {
    pythonTest: "test_release_e2e.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release-e2e/main.test.ts",
  },
  {
    pythonTest: "test_release_prerelease.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/version.test.ts",
  },
  {
    pythonTest: "test_release_publish.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release-publish/main.test.ts",
  },
  {
    pythonTest: "test_release_pyproject_sync.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/pyproject.test.ts",
  },
  {
    pythonTest: "test_release_rollback.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release-rollback/rollback.test.ts",
  },
  {
    pythonTest: "test_release_rollback_725.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release-rollback/rollback-coverage.test.ts",
  },
  {
    pythonTest: "test_release_skip_flags.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/flags.test.ts",
  },
  {
    pythonTest: "test_release_subprocess_path.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/python-bridge.test.ts",
  },
  {
    pythonTest: "test_release_summary.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/pipeline.test.ts",
  },
  {
    pythonTest: "test_release_tag_availability.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/gh.test.ts",
  },
  {
    pythonTest: "test_release_upgrade_banner.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/pipeline-branches.test.ts",
  },
  {
    pythonTest: "test_release_vbrief_lifecycle.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/release/pipeline.test.ts",
  },
  {
    pythonTest: "test_release.py",
    kind: "orchestration-cli-spec",
    tsTarget: "packages/cli/src/orchestration-cli/release-cli.test.ts",
    notes: "deft-ts release / release-publish / release-rollback / release-e2e argv surface",
  },
  {
    pythonTest: "test_swarm_complete_cohort.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/swarm/complete-cohort-sweep.test.ts",
  },
  {
    pythonTest: "test_swarm_launch.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/swarm/swarm.test.ts",
  },
  {
    pythonTest: "test_swarm_readiness.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/swarm/readiness-branches.test.ts",
  },
  {
    pythonTest: "test_swarm_verify_review_clean.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/swarm/swarm-branches.test.ts",
  },
  {
    pythonTest: "test_swarm_worktrees.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/swarm/worktrees.test.ts",
  },
  {
    pythonTest: "test_swarm_launch.py",
    kind: "orchestration-cli-spec",
    tsTarget: "packages/cli/src/orchestration-cli/swarm-cli.test.ts",
    notes: "deft-ts swarm-* dispatcher argv + exit codes",
  },
  {
    pythonTest: "test_subagent_monitor.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/orchestration/orchestration.test.ts",
  },
  {
    pythonTest: "test_probe_session.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/orchestration/orchestration.test.ts",
  },
  {
    pythonTest: "test_subagent_monitor.py",
    kind: "orchestration-cli-spec",
    tsTarget: "packages/cli/src/orchestration-cli/probe-orchestration-cli.test.ts",
    notes: "deft-ts subagent-monitor / probe-session dispatcher",
  },
  {
    pythonTest: "test_probe_session.py",
    kind: "orchestration-cli-spec",
    tsTarget: "packages/cli/src/orchestration-cli/probe-orchestration-cli.test.ts",
  },
  {
    pythonTest: "test_resolve_changelog_unreleased.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/platform/platform.test.ts",
    notes: "No deft-ts verb; resolve-changelog is platform module",
  },
  {
    pythonTest: "test_resolve_version.py",
    kind: "existing-coverage",
    tsTarget: "packages/core/src/platform/branch-coverage.test.ts",
    notes: "No deft-ts verb; resolve-version is platform module",
  },
];

/** Every in-scope Python file must appear at least once in the map. */
export function coverageMapCompleteness(): {
  ok: boolean;
  missing: string[];
} {
  const mapped = new Set(ORCHESTRATION_CLI_COVERAGE_MAP.map((e) => e.pythonTest));
  const missing = ORCHESTRATION_CLI_PYTHON_TESTS.filter((f) => !mapped.has(f));
  return { ok: missing.length === 0, missing: [...missing] };
}

/** Markdown table for PR body (#1838 Wave 8.5 s4). */
export function renderCoverageMapMarkdown(): string {
  const rows = ORCHESTRATION_CLI_COVERAGE_MAP.map(
    (e) => `| \`${e.pythonTest}\` | ${e.kind} | \`${e.tsTarget}\` | ${e.notes ?? ""} |`,
  );
  return ["| Python test | Kind | TS target | Notes |", "| --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
}
