import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_HEADROOM_PP,
  evaluateCoverageHotspots,
  formatJsonReport,
  summarizeCoverageFinal,
} from "./evaluate.js";
import { readProjectCoverageThresholds } from "./thresholds.js";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cov-hotspots-"));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

describe("readProjectCoverageThresholds", () => {
  it("reads branches threshold from vitest.config.ts", () => {
    const root = makeProject({
      "vitest.config.ts": `
        export default {
          test: {
            coverage: {
              thresholds: { branches: 90, lines: 88, functions: 87, statements: 86 },
            },
          },
        };
      `,
    });
    expect(readProjectCoverageThresholds(root)).toEqual({
      branches: 90,
      lines: 88,
      functions: 87,
      statements: 86,
    });
  });

  it("falls back to framework defaults when no vitest config exists", () => {
    const root = makeProject({});
    expect(readProjectCoverageThresholds(root).branches).toBe(85);
  });
});

describe("evaluateCoverageHotspots", () => {
  it("returns config error when coverage report is missing", () => {
    const root = makeProject({});
    const result = evaluateCoverageHotspots({ projectRoot: root, useDiffPaths: false });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("coverage report missing");
  });

  it("fails closed when branch headroom is below the default minimum", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "packages/core/src/a.ts": {
          s: { "0": 1, "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "7": 1, "8": 1, "9": 1 },
          f: { "0": 1 },
          b: { "0": [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        },
      }),
    });
    const result = evaluateCoverageHotspots({
      projectRoot: root,
      useDiffPaths: false,
      pathFilter: ["packages/core/src/a.ts"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.report?.failReasons.some((r) => r.includes("headroom"))).toBe(true);
    expect(result.report?.minHeadroomPp).toBe(DEFAULT_MIN_HEADROOM_PP);
  });

  it("passes with sufficient branch headroom and emits JSON contract fields", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "packages/core/src/good.ts": {
          s: { "0": 1, "1": 1 },
          f: { "0": 1 },
          b: { "0": [1, 1] },
          branchMap: { "0": { line: 12, type: "if" } },
        },
      }),
    });
    const result = evaluateCoverageHotspots({
      projectRoot: root,
      useDiffPaths: false,
      pathFilter: ["packages/core/src/good.ts"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.report?.ok).toBe(true);
    expect(result.report?.global.branches).toBe(100);
    if (result.report === null) throw new Error("expected report");
    const json = JSON.parse(formatJsonReport(result.report));
    expect(json.ok).toBe(true);
    expect(json.lowestModules).toHaveLength(1);
    expect(json.uncoveredBranches).toEqual([]);
  });

  it("respects project-specific branch floor from vitest config", () => {
    const root = makeProject({
      "vitest.config.ts":
        "export default { test: { coverage: { thresholds: { branches: 90 } } } };",
      "coverage/coverage-final.json": JSON.stringify({
        "src/a.ts": {
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 1, 1, 1, 1, 1, 1, 1, 1, 0] },
        },
      }),
    });
    const result = evaluateCoverageHotspots({ projectRoot: root, useDiffPaths: false });
    expect(result.exitCode).toBe(1);
    expect(result.report?.thresholds.branches).toBe(90);
    expect(result.report?.failReasons.some((r) => r.includes("headroom"))).toBe(true);
  });
});

describe("summarizeCoverageFinal export", () => {
  it("aggregates branch totals for fixtures", () => {
    const totals = summarizeCoverageFinal({
      "a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 0] } },
    });
    expect(totals.branches).toBe(50);
  });
});
