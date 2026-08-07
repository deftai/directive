import { describe, expect, it } from "vitest";
import {
  buildCoverageDebtIssueDraft,
  classifyCoverageMetrics,
  classifyStep5Failure,
  evaluateAutoHatch,
  extractCoverageDebtCitationsFromChangelog,
  filterOpenCoverageDebtIssues,
  formatAutoHatchBanner,
  issueHasCoverageDebtMarkers,
  mergeOpenDebtLedger,
  parseExitCodeFromReason,
  reasonLooksLikeTimeout,
} from "./auto-hatch.js";

const hairlineTotals = {
  branches: 84.95,
  lines: 86.1,
  functions: 87.0,
  statements: 86.0,
};

const multiMissTotals = {
  branches: 84.0,
  lines: 80.0,
  functions: 87.0,
  statements: 86.0,
};

const greenTotals = {
  branches: 90,
  lines: 90,
  functions: 90,
  statements: 90,
};

describe("classifyCoverageMetrics", () => {
  it("detects branch-only hairline", () => {
    expect(classifyCoverageMetrics(hairlineTotals)).toBe("branch_hairline");
  });

  it("detects multi-metric miss", () => {
    expect(classifyCoverageMetrics(multiMissTotals)).toBe("other_coverage");
  });

  it("detects all-green", () => {
    expect(classifyCoverageMetrics(greenTotals)).toBe("ok");
  });

  it("returns null without totals", () => {
    expect(classifyCoverageMetrics(null)).toBeNull();
  });
});

describe("classifyStep5Failure", () => {
  it("classifies BRANCH_HAIRLINE from totals", () => {
    expect(
      classifyStep5Failure({
        output: "task check failed (exit 1)",
        totals: hairlineTotals,
        exitCode: 1,
      }),
    ).toBe("BRANCH_HAIRLINE");
  });

  it("classifies OTHER_COVERAGE when lines also miss", () => {
    expect(
      classifyStep5Failure({
        output: "Coverage for lines (80%) does not meet global threshold (85%)",
        totals: multiMissTotals,
      }),
    ).toBe("OTHER_COVERAGE");
  });

  it("classifies REAL_FAILURE on timeout", () => {
    expect(
      classifyStep5Failure({
        output: "task check timed out after 20m",
        totals: hairlineTotals,
        timedOut: true,
      }),
    ).toBe("REAL_FAILURE");
    expect(classifyStep5Failure({ exitCode: 124, totals: hairlineTotals })).toBe("REAL_FAILURE");
  });

  it("classifies REAL_FAILURE on failed tests even with hairline totals", () => {
    expect(
      classifyStep5Failure({
        output: "Tests failed\n2 failed",
        totals: hairlineTotals,
        failedTests: 2,
      }),
    ).toBe("REAL_FAILURE");
  });

  it("classifies UNKNOWN when unparseable", () => {
    expect(classifyStep5Failure({ output: "task check failed (exit 1)" })).toBe("UNKNOWN");
    expect(classifyStep5Failure({})).toBe("UNKNOWN");
  });

  it("treats coverage-threshold-only output without totals as OTHER_COVERAGE", () => {
    expect(
      classifyStep5Failure({
        output: "ERROR: Coverage for branches (84.9%) does not meet global threshold (85%)",
      }),
    ).toBe("OTHER_COVERAGE");
  });

  it("treats green totals + non-empty non-real output as REAL_FAILURE", () => {
    expect(
      classifyStep5Failure({
        output: "some gate failed",
        totals: greenTotals,
      }),
    ).toBe("REAL_FAILURE");
  });
});

describe("ledger helpers", () => {
  it("detects markers", () => {
    expect(
      issueHasCoverageDebtMarkers({
        number: 1,
        title: "coverage-debt: restore",
        body: "use --allow-coverage-debt",
      }),
    ).toBe(true);
    expect(issueHasCoverageDebtMarkers({ number: 2, title: "fix tests", body: "n/a" })).toBe(false);
  });

  it("filters open debt issues", () => {
    expect(
      filterOpenCoverageDebtIssues([
        { number: 10, title: "coverage-debt: x", body: "--allow-coverage-debt", state: "OPEN" },
        { number: 11, title: "coverage-debt: y", body: "x", state: "CLOSED" },
        { number: 12 }, // citation-only open probe
        { number: 0, title: "coverage-debt", body: "x" },
      ]),
    ).toEqual([10, 12]);
  });

  it("extracts CHANGELOG citations", () => {
    const cl = [
      "## [Unreleased]",
      "",
      "allow-coverage-debt=#3185",
      "",
      "## [0.97.0]",
      "allow-coverage-debt=3103",
      "",
      "## [0.96.0]",
      "no debt",
    ].join("\n");
    expect(extractCoverageDebtCitationsFromChangelog(cl)).toEqual([3103, 3185]);
  });

  it("merges ledger sets", () => {
    expect(mergeOpenDebtLedger([3, 1], [2, 1])).toEqual([1, 2, 3]);
  });
});

describe("evaluateAutoHatch", () => {
  it("PASS_WITH_DEBT on empty ledger hairline", () => {
    const decision = evaluateAutoHatch({
      classification: "BRANCH_HAIRLINE",
      totals: hairlineTotals,
      openDebtIssues: [],
      createIssue: () => 4242,
    });
    expect(decision).toEqual({
      kind: "pass_with_debt",
      issue: 4242,
      created: true,
      class: "BRANCH_HAIRLINE",
      totals: hairlineTotals,
    });
  });

  it("fails closed when prior debt is open", () => {
    const decision = evaluateAutoHatch({
      classification: "BRANCH_HAIRLINE",
      totals: hairlineTotals,
      openDebtIssues: [3185],
      createIssue: () => 999,
    });
    expect(decision.kind).toBe("fail_closed");
    if (decision.kind === "fail_closed") {
      expect(decision.reason).toMatch(/3185/);
      expect(decision.openDebtIssues).toEqual([3185]);
    }
  });

  it("fails closed on non-hairline classes without creating", () => {
    let created = false;
    for (const classification of ["REAL_FAILURE", "OTHER_COVERAGE", "UNKNOWN"] as const) {
      const decision = evaluateAutoHatch({
        classification,
        totals: hairlineTotals,
        openDebtIssues: [],
        createIssue: () => {
          created = true;
          return 1;
        },
      });
      expect(decision.kind).toBe("fail_closed");
    }
    expect(created).toBe(false);
  });

  it("refuses continue without createIssue when ledger empty", () => {
    const decision = evaluateAutoHatch({
      classification: "BRANCH_HAIRLINE",
      totals: hairlineTotals,
      openDebtIssues: [],
    });
    expect(decision.kind).toBe("fail_closed");
  });

  it("refuses invalid createIssue return", () => {
    const decision = evaluateAutoHatch({
      classification: "BRANCH_HAIRLINE",
      totals: hairlineTotals,
      openDebtIssues: [],
      createIssue: () => 0,
    });
    expect(decision.kind).toBe("fail_closed");
  });
});

describe("draft + banner + reason helpers", () => {
  it("builds marker-compliant issue draft", () => {
    const draft = buildCoverageDebtIssueDraft({ version: "0.98.0", totals: hairlineTotals });
    expect(draft.title).toMatch(/^coverage-debt:/);
    expect(draft.body).toContain("coverage-debt");
    expect(draft.body).toContain("--allow-coverage-debt");
    expect(draft.body).toContain("84.95");
    expect(draft.body).toContain("v0.98.0");
  });

  it("formats auto-hatch banner", () => {
    const text = formatAutoHatchBanner(3185, hairlineTotals);
    expect(text).toMatch(/AUTO-HATCH/);
    expect(text).toContain("#3185");
    expect(text).toContain("PASS_WITH_DEBT");
  });

  it("parses exit codes and timeouts from reason", () => {
    expect(parseExitCodeFromReason("task check failed (exit 1)")).toBe(1);
    expect(parseExitCodeFromReason("task check timed out after 20m")).toBeNull();
    expect(reasonLooksLikeTimeout("task check timed out after 20m")).toBe(true);
  });
});

describe("coverage report freshness (#3187 Greptile P1)", () => {
  it("rejects stale mtimes and accepts fresh", async () => {
    const { isCoverageReportFresh, classifyStep5FailureWithFreshness } = await import(
      "./auto-hatch.js"
    );
    const now = 1_000_000;
    expect(isCoverageReportFresh(now - 60_000, now)).toBe(true);
    expect(isCoverageReportFresh(now - 40 * 60 * 1000, now)).toBe(false);
    expect(isCoverageReportFresh(null, now)).toBe(false);

    expect(
      classifyStep5FailureWithFreshness({
        totals: hairlineTotals,
        output: "task check failed (exit 1)",
        coverageReportMtimeMs: now - 60_000,
        nowMs: now,
      }),
    ).toBe("BRANCH_HAIRLINE");

    expect(
      classifyStep5FailureWithFreshness({
        totals: hairlineTotals,
        output: "task check failed (exit 1)",
        coverageReportMtimeMs: now - 40 * 60 * 1000,
        nowMs: now,
      }),
    ).toBe("UNKNOWN");

    // Seam/tests without mtime still classify from totals.
    expect(
      classifyStep5FailureWithFreshness({
        totals: hairlineTotals,
        output: "task check failed (exit 1)",
      }),
    ).toBe("BRANCH_HAIRLINE");
  });
});
