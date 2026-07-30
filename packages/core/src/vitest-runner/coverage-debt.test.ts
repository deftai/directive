import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COVERAGE_GOAL,
  countRecentCoverageDebtMentions,
  formatCoverageAttribution,
  formatOveruseWarning,
  metricsBelowGoal,
  parseCoverageDebtArgv,
  parseCoverageDebtIssueNumber,
  readCoverageTotalsFromReport,
  resolveCoverageDebtIssue,
  summarizeCoverageFinal,
} from "./coverage-debt.js";

describe("parseCoverageDebtIssueNumber", () => {
  it("accepts #N and bare N", () => {
    expect(parseCoverageDebtIssueNumber("#2573")).toBe(2573);
    expect(parseCoverageDebtIssueNumber("2573")).toBe(2573);
  });

  it("rejects malformed values", () => {
    expect(parseCoverageDebtIssueNumber("")).toBeNull();
    expect(parseCoverageDebtIssueNumber("#")).toBeNull();
    expect(parseCoverageDebtIssueNumber("abc")).toBeNull();
    expect(parseCoverageDebtIssueNumber("0")).toBeNull();
  });
});

describe("parseCoverageDebtArgv", () => {
  it("returns none when flag absent", () => {
    expect(parseCoverageDebtArgv(["vitest", "run"])).toEqual({ kind: "none" });
  });

  it("ignores sparse argv holes while scanning for the debt flag", () => {
    const sparse: string[] = [];
    sparse[2] = "--allow-coverage-debt";
    sparse[3] = "2865";
    expect(parseCoverageDebtArgv(sparse)).toEqual({ kind: "valid", issue: 2865 });
  });

  it("parses equals and spaced forms", () => {
    expect(parseCoverageDebtArgv(["vitest", "--allow-coverage-debt=#2573"])).toEqual({
      kind: "valid",
      issue: 2573,
    });
    expect(parseCoverageDebtArgv(["vitest", "--allow-coverage-debt", "2573"])).toEqual({
      kind: "valid",
      issue: 2573,
    });
  });

  it("fails closed on missing or malformed flag values", () => {
    expect(parseCoverageDebtArgv(["vitest", "--allow-coverage-debt"])).toEqual({
      kind: "invalid",
      reason: "--allow-coverage-debt requires an issue number (#N)",
    });
    expect(parseCoverageDebtArgv(["vitest", "--allow-coverage-debt=#"])).toEqual({
      kind: "invalid",
      reason: "--allow-coverage-debt= value must be #N or N",
    });
    expect(parseCoverageDebtArgv(["vitest", "--allow-coverage-debt", "abc"])).toEqual({
      kind: "invalid",
      reason: "--allow-coverage-debt value must be #N or N",
    });
    expect(parseCoverageDebtArgv(["vitest", "--allow-coverage-debt", "--coverage"])).toEqual({
      kind: "invalid",
      reason: "--allow-coverage-debt requires an issue number (#N)",
    });
  });
});

describe("resolveCoverageDebtIssue env scoping (#1553)", () => {
  it("ignores raw env without release preflight", () => {
    expect(resolveCoverageDebtIssue(["vitest"], { DEFT_ALLOW_COVERAGE_DEBT: "2573" })).toEqual({
      kind: "none",
    });
  });

  it("accepts env only during release preflight", () => {
    expect(
      resolveCoverageDebtIssue(["vitest"], {
        DEFT_ALLOW_COVERAGE_DEBT: "2573",
        DEFT_RELEASE_PREFLIGHT: "1",
      }),
    ).toEqual({ kind: "valid", issue: 2573 });
  });

  it("rejects invalid env during release preflight", () => {
    expect(
      resolveCoverageDebtIssue(["vitest"], {
        DEFT_ALLOW_COVERAGE_DEBT: "abc",
        DEFT_RELEASE_PREFLIGHT: "1",
      }),
    ).toEqual({ kind: "invalid", reason: "DEFT_ALLOW_COVERAGE_DEBT must be a positive integer" });
  });

  it("prefers argv over release-scoped env", () => {
    expect(
      resolveCoverageDebtIssue(["vitest", "--allow-coverage-debt=1936"], {
        DEFT_ALLOW_COVERAGE_DEBT: "2573",
        DEFT_RELEASE_PREFLIGHT: "1",
      }),
    ).toEqual({ kind: "valid", issue: 1936 });
  });
});

describe("summarizeCoverageFinal + metricsBelowGoal", () => {
  it("detects metrics below the 85% goal", () => {
    const totals = summarizeCoverageFinal({
      "a.ts": {
        s: { "0": 1, "1": 0 },
        f: { "0": 1 },
        b: { "0": [1, 0] },
      },
    });
    expect(metricsBelowGoal(totals)).toContain("statements");
    expect(metricsBelowGoal(totals)).toContain("branches");
  });

  it("passes when all metrics meet goal", () => {
    const totals = {
      lines: 90,
      functions: 90,
      branches: 90,
      statements: 90,
    };
    expect(metricsBelowGoal(totals)).toEqual([]);
  });

  it("handles empty coverage-final payloads", () => {
    const totals = summarizeCoverageFinal({});
    expect(totals.branches).toBe(100);
    expect(metricsBelowGoal(totals)).toEqual([]);
  });
});

describe("attribution + overuse warning", () => {
  it("formats measured vs goal with issue number", () => {
    const text = formatCoverageAttribution(2573, {
      lines: 84.5,
      branches: 84.9,
      functions: 86,
      statements: 84.5,
    });
    expect(text).toContain("#2573");
    expect(text).toContain("84.90%");
    expect(text).toContain(`${COVERAGE_GOAL.branches}%`);
  });

  it("sanitizes embedded newlines in attribution metrics (#2952)", () => {
    const text = formatCoverageAttribution(2952, {
      lines: Number.NaN,
      branches: 84.9,
      functions: 90,
      statements: 84.5,
    });
    expect(text).toContain("#2952");
    expect(text).not.toMatch(/\n\n/);
  });

  it("warns when multiple recent releases cite coverage debt", () => {
    const changelog =
      "## [Unreleased]\n\n## [0.2.0]\ncoverage-debt soft-pass\n\n## [0.1.0]\nallow-coverage-debt=#1234\n";
    expect(countRecentCoverageDebtMentions(changelog)).toBe(2);
    expect(formatOveruseWarning(2)).toMatch(/WARN/);
  });

  it("does not count feature documentation without a debt acknowledgment", () => {
    const changelog = "## [0.1.0]\nAdded allow-coverage-debt flag for release pipeline\n";
    expect(countRecentCoverageDebtMentions(changelog)).toBe(0);
  });

  it("returns null overuse warning below threshold", () => {
    expect(formatOveruseWarning(1)).toBeNull();
  });
});

describe("readCoverageTotalsFromReport", () => {
  it("returns null when coverage-final.json is missing", () => {
    expect(readCoverageTotalsFromReport(join(tmpdir(), "missing-coverage-dir"))).toBeNull();
  });

  it("reads totals from a valid coverage-final.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cov-debt-"));
    writeFileSync(
      join(dir, "coverage-final.json"),
      JSON.stringify({
        "a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1] } },
      }),
      "utf8",
    );
    const totals = readCoverageTotalsFromReport(dir);
    expect(totals?.branches).toBe(100);
  });

  it("returns null when coverage-final.json is malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "cov-debt-bad-"));
    writeFileSync(join(dir, "coverage-final.json"), "{not-json", "utf8");
    expect(readCoverageTotalsFromReport(dir)).toBeNull();
  });
});

describe("summarizeCoverageFinal partial maps + metricsBelowGoal edges (#2952)", () => {
  it("aggregates files that only expose some of s/f/b", () => {
    const totals = summarizeCoverageFinal({
      "only-s.ts": { s: { "0": 1, "1": 1 } },
      "only-f.ts": { f: { "0": 0 } },
      "only-b.ts": { b: { "0": [1, 0, 1] } },
      "empty.ts": {},
    });
    expect(totals.statements).toBe(100);
    expect(totals.functions).toBe(0);
    expect(totals.branches).toBeCloseTo((2 / 3) * 100, 5);
    expect(totals.lines).toBe(totals.statements);
  });

  it("treats exact goal as met (epsilon path)", () => {
    const totals = {
      lines: 85,
      functions: 85,
      branches: 85,
      statements: 85,
    };
    expect(metricsBelowGoal(totals)).toEqual([]);
  });

  it("rejects #0 and negative-looking issue strings", () => {
    expect(parseCoverageDebtIssueNumber("#0")).toBeNull();
    expect(parseCoverageDebtIssueNumber("-1")).toBeNull();
    expect(parseCoverageDebtIssueNumber("  ")).toBeNull();
  });

  it("ignores empty DEFT_ALLOW_COVERAGE_DEBT even under release preflight", () => {
    expect(
      resolveCoverageDebtIssue(["vitest"], {
        DEFT_ALLOW_COVERAGE_DEBT: "",
        DEFT_RELEASE_PREFLIGHT: "1",
      }),
    ).toEqual({ kind: "none" });
  });
});
