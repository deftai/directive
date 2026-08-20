import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_DIFF_COVERAGE_THRESHOLD,
  evaluateDiffCoverage,
  hasDiffCoverageFindings,
} from "./diff-coverage.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function reportRoot(payload: unknown): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-diffcov-"));
  temps.push(root);
  const dir = join(root, "coverage");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "coverage-final.json");
  writeFileSync(path, JSON.stringify(payload), "utf8");
  return { root, path };
}

const fooCoverage = {
  "src/foo.ts": {
    path: "src/foo.ts",
    b: { "0": [1, 0] },
    branchMap: {
      "0": {
        type: "cond-expr",
        line: 2,
        loc: { start: { line: 2 } },
        locations: [{ start: { line: 2 } }, { start: { line: 2 } }],
      },
    },
  },
};

describe("evaluateDiffCoverage", () => {
  it("skips when the coverage report is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-diffcov-missing-"));
    temps.push(root);
    const result = evaluateDiffCoverage({
      projectRoot: root,
      coverageReportPath: join(root, "coverage", "coverage-final.json"),
      changedLinesByFile: new Map([["src/foo.ts", new Set([2])]]),
    });
    expect(result.reportPresent).toBe(false);
    expect(result.skippedReason).toContain("missing");
    expect(hasDiffCoverageFindings(result)).toBe(false);
  });

  it("reports uncovered branch paths on changed lines", () => {
    const { root, path } = reportRoot(fooCoverage);
    const result = evaluateDiffCoverage({
      projectRoot: root,
      coverageReportPath: path,
      changedLinesByFile: new Map([["src/foo.ts", new Set([2])]]),
    });
    expect(result.reportPresent).toBe(true);
    expect(result.changedBranchTotal).toBe(2);
    expect(result.changedBranchCovered).toBe(1);
    expect(result.uncovered).toEqual([
      {
        path: "src/foo.ts",
        line: 2,
        branchId: "0",
        pathIndex: 1,
        type: "cond-expr",
      },
    ]);
    expect(result.belowThreshold).toBe(true);
    expect(hasDiffCoverageFindings(result)).toBe(true);
  });

  it("ignores uncovered branches on unchanged lines", () => {
    const { root, path } = reportRoot(fooCoverage);
    const result = evaluateDiffCoverage({
      projectRoot: root,
      coverageReportPath: path,
      changedLinesByFile: new Map([["src/foo.ts", new Set([1])]]),
    });
    expect(result.uncovered).toEqual([]);
    expect(result.changedBranchTotal).toBe(0);
    expect(hasDiffCoverageFindings(result)).toBe(false);
  });

  it("treats fully covered changed branches as clean", () => {
    const { root, path } = reportRoot({
      "src/foo.ts": {
        path: "src/foo.ts",
        b: { "0": [1, 3] },
        branchMap: {
          "0": {
            type: "if",
            line: 2,
            loc: { start: { line: 2 } },
            locations: [{ start: { line: 2 } }, { start: { line: 2 } }],
          },
        },
      },
    });
    const result = evaluateDiffCoverage({
      projectRoot: root,
      coverageReportPath: path,
      changedLinesByFile: new Map([["src/foo.ts", new Set([2])]]),
    });
    expect(result.percent).toBe(100);
    expect(result.uncovered).toEqual([]);
    expect(hasDiffCoverageFindings(result)).toBe(false);
  });

  it("defaults the per-diff threshold to 90, distinct from the 75 floor", () => {
    expect(DEFAULT_DIFF_COVERAGE_THRESHOLD).toBe(90);
    expect(DEFAULT_DIFF_COVERAGE_THRESHOLD).toBeGreaterThan(75);
  });

  it("skips an unreadable coverage report instead of failing closed", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-diffcov-badjson-"));
    temps.push(root);
    const dir = join(root, "coverage");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "coverage-final.json");
    writeFileSync(path, "{not-json", "utf8");
    const result = evaluateDiffCoverage({
      projectRoot: root,
      coverageReportPath: path,
      changedLinesByFile: new Map([["src/foo.ts", new Set([1])]]),
    });
    expect(result.reportPresent).toBe(false);
    expect(result.skippedReason).toContain("unreadable");
  });

  it("ignores coverage files that have no branch map", () => {
    const { root, path } = reportRoot({
      "src/foo.ts": { path: "src/foo.ts", s: { "0": 1 } },
    });
    const result = evaluateDiffCoverage({
      projectRoot: root,
      coverageReportPath: path,
      changedLinesByFile: new Map([["src/foo.ts", new Set([1])]]),
    });
    expect(result.changedBranchTotal).toBe(0);
    expect(hasDiffCoverageFindings(result)).toBe(false);
  });
});
