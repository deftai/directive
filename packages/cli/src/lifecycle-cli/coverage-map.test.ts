import { describe, expect, it } from "vitest";
import { LIFECYCLE_CLI_COVERAGE_MAP, LIFECYCLE_PYTHON_TEST_FILES } from "./coverage-map.js";

const EXPECTED_PYTHON_FILES = [
  "tests/cli/test_issue_emit.py",
  "tests/cli/test_issue_ingest.py",
  "tests/cli/test_issue_ingest_body_parsing.py",
  "tests/cli/test_issue_ingest_canonical_refs.py",
  "tests/cli/test_issue_ingest_direct.py",
  "tests/cli/test_issue_ingest_escape_corruption.py",
  "tests/cli/test_preflight_architecture_sor.py",
  "tests/cli/test_preflight_branch.py",
  "tests/cli/test_preflight_cache.py",
  "tests/cli/test_preflight_gh.py",
  "tests/cli/test_preflight_implementation.py",
  "tests/cli/test_preflight_story_start.py",
  "tests/cli/test_reconcile_issues.py",
  "tests/cli/test_reconcile_issues_754.py",
  "tests/cli/test_reconcile_issues_apply.py",
  "tests/cli/test_reconcile_issues_direct.py",
  "tests/cli/test_scope_decompose.py",
  "tests/cli/test_scope_decompose_unit.py",
  "tests/cli/test_scope_demote.py",
  "tests/cli/test_scope_lifecycle.py",
  "tests/cli/test_scope_undo.py",
  "tests/cli/test_vbrief_activate.py",
  "tests/cli/test_vbrief_fidelity_legacy.py",
  "tests/cli/test_vbrief_migrate_conformance.py",
  "tests/cli/test_vbrief_preflight_resolver.py",
  "tests/cli/test_vbrief_reconcile_graph.py",
  "tests/cli/test_vbrief_reconcile_labels.py",
  "tests/cli/test_vbrief_reconcile_umbrellas.py",
  "tests/cli/test_vbrief_reconciliation.py",
  "tests/cli/test_vbrief_routing.py",
  "tests/cli/test_vbrief_validate.py",
  "tests/cli/test_vbrief_validate_direct.py",
  "tests/cli/test_vbrief_validate_direct_orchestration.py",
  "tests/cli/test_vbrief_validate_issue_536.py",
  "tests/cli/test_vbrief_validation.py",
];

describe("lifecycle CLI coverage map (#1838 s3)", () => {
  it("lists every in-scope pytest file exactly once", () => {
    expect(LIFECYCLE_CLI_COVERAGE_MAP).toHaveLength(EXPECTED_PYTHON_FILES.length);
    expect([...LIFECYCLE_PYTHON_TEST_FILES].sort()).toEqual([...EXPECTED_PYTHON_FILES].sort());
  });

  it("assigns a non-empty TS target to every entry", () => {
    for (const entry of LIFECYCLE_CLI_COVERAGE_MAP) {
      expect(entry.tsTarget.length).toBeGreaterThan(0);
      expect(entry.notes.length).toBeGreaterThan(0);
    }
  });

  it("flags Wave-9 dedup candidates for fully ported surfaces", () => {
    const wave9 = LIFECYCLE_CLI_COVERAGE_MAP.filter((e) => e.wave9Delete);
    expect(wave9.length).toBeGreaterThan(20);
    const pythonOracles = LIFECYCLE_CLI_COVERAGE_MAP.filter(
      (e) => e.disposition === "python-oracle",
    );
    expect(pythonOracles.map((e) => e.pythonTest)).toEqual([
      "tests/cli/test_scope_decompose.py",
      "tests/cli/test_preflight_architecture_sor.py",
      "tests/cli/test_preflight_cache.py",
      "tests/cli/test_preflight_gh.py",
    ]);
  });
});
