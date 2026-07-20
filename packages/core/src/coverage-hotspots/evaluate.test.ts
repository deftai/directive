import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_HEADROOM_PP,
  evaluateCoverageHotspots,
  formatJsonReport,
  formatTextReport,
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

function gitRepo(files: Record<string, string>): string {
  const root = makeProject({ "README.md": "# base\n", ...files });
  childProcess.execFileSync("git", ["init", "-q"], { cwd: root });
  childProcess.execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root });
  childProcess.execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
  childProcess.execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
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

  it("reads coverageThresholds const blocks", () => {
    const root = makeProject({
      "vitest.config.ts": `
        const coverageThresholds = { branches: 92, lines: 91, functions: 90, statements: 89 };
        export default { test: { coverage: { thresholds: coverageThresholds } } };
      `,
    });
    expect(readProjectCoverageThresholds(root).branches).toBe(92);
  });

  it("fills missing metrics from defaults when only branches is configured", () => {
    const root = makeProject({
      "vitest.config.ts":
        "export default { test: { coverage: { thresholds: { branches: 91 } } } };",
    });
    expect(readProjectCoverageThresholds(root)).toMatchObject({
      branches: 91,
      lines: 85,
      functions: 85,
    });
  });

  it("reads vitest.config.mts thresholds", () => {
    const mtsRoot = makeProject({
      "vitest.config.mts":
        "export default { test: { coverage: { thresholds: { branches: 97 } } } };",
    });
    expect(readProjectCoverageThresholds(mtsRoot).branches).toBe(97);
  });

  it("reads alternate vitest config filenames", () => {
    const mjsRoot = makeProject({
      "vitest.config.mjs":
        "export default { test: { coverage: { thresholds: { branches: 93 } } } };",
    });
    const jsRoot = makeProject({
      "vitest.config.js":
        "module.exports = { test: { coverage: { thresholds: { branches: 94 } } } };",
    });
    const cjsRoot = makeProject({
      "vitest.config.cjs":
        "module.exports = { test: { coverage: { thresholds: { branches: 95 } } } };",
    });
    expect(readProjectCoverageThresholds(mjsRoot).branches).toBe(93);
    expect(readProjectCoverageThresholds(jsRoot).branches).toBe(94);
    expect(readProjectCoverageThresholds(cjsRoot).branches).toBe(95);
  });

  it("skips vitest configs without thresholds and keeps scanning", () => {
    const root = makeProject({
      "vitest.config.ts": "export default { test: {} };",
      "vitest.config.mjs":
        "export default { test: { coverage: { thresholds: { branches: 96 } } } };",
    });
    expect(readProjectCoverageThresholds(root).branches).toBe(96);
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

  it("returns config error for unreadable coverage JSON", () => {
    const root = makeProject({ "coverage/coverage-final.json": "{not-json" });
    const result = evaluateCoverageHotspots({ projectRoot: root, useDiffPaths: false });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("unreadable coverage report");
  });

  it("fails when branches are below the project floor", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "src/low.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
      }),
    });
    const result = evaluateCoverageHotspots({ projectRoot: root, useDiffPaths: false });
    expect(result.exitCode).toBe(1);
    expect(result.report?.failReasons.some((r) => r.includes("below project floor"))).toBe(true);
  });

  it("uses git diff paths by default inside a repository", () => {
    const root = gitRepo({});
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/changed.ts"), "export const x = 1;\n");
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage/coverage-final.json"),
      JSON.stringify({
        "src/changed.ts": {
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 0] },
          branchMap: { "0": { line: 1, type: "stmt" } },
        },
        "src/other.ts": {
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 0] },
        },
      }),
    );
    childProcess.execFileSync("git", ["add", "-A"], { cwd: root });
    childProcess.execFileSync("git", ["commit", "-q", "-m", "add changed"], { cwd: root });
    const result = evaluateCoverageHotspots({ projectRoot: root, baseRef: "HEAD~1" });
    expect(result.exitCode).toBe(1);
    expect(result.report?.pathFilter).toContain("src/changed.ts");
    expect(
      result.report?.uncoveredBranches.every((sample) => sample.path === "src/changed.ts"),
    ).toBe(true);
  });

  it("returns config error when git diff filter cannot run outside a repo", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "src/a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 1] } },
      }),
    });
    const result = evaluateCoverageHotspots({ projectRoot: root });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("git");
  });

  it("normalizes absolute file paths from istanbul payloads", () => {
    const root = makeProject({});
    const abs = join(root, "packages/core/src/abs.ts");
    mkdirSync(join(abs, ".."), { recursive: true });
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(abs, "export const abs = 1;\n");
    writeFileSync(
      join(root, "coverage/coverage-final.json"),
      JSON.stringify({
        [abs]: {
          path: abs,
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 1] },
        },
      }),
    );
    const result = evaluateCoverageHotspots({
      projectRoot: root,
      useDiffPaths: false,
      pathFilter: ["packages/core/src/abs.ts"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.report?.lowestModules[0]?.path).toBe("packages/core/src/abs.ts");
  });

  it("collects uncovered branches across all files when diff filter is disabled", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "src/a.ts": {
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 0] },
          branchMap: { "0": { line: 3, type: "if" } },
        },
        "src/b.ts": {
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 0] },
          branchMap: { "0": { loc: { start: { line: 8 } }, type: "binary-expr" } },
        },
      }),
    });
    const result = evaluateCoverageHotspots({ projectRoot: root, useDiffPaths: false });
    expect(result.report?.uncoveredBranches).toHaveLength(2);
  });

  it("keeps external istanbul paths when outside project root", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "external.ts": {
          path: "/var/other/external.ts",
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 1] },
        },
      }),
    });
    const result = evaluateCoverageHotspots({
      projectRoot: root,
      useDiffPaths: false,
      pathFilter: ["/var/other/external.ts"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.report?.lowestModules[0]?.path).toBe("/var/other/external.ts");
  });

  it("defaults uncovered branch metadata when branchMap is absent", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "src/a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 0] } },
      }),
    });
    const result = evaluateCoverageHotspots({ projectRoot: root, useDiffPaths: false });
    expect(result.report?.uncoveredBranches[0]).toMatchObject({
      path: "src/a.ts",
      line: 0,
      type: "branch",
    });
  });

  it("summarizes empty istanbul entries as fully covered", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "src/empty.ts": {},
        "src/good.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 1] } },
      }),
    });
    const result = evaluateCoverageHotspots({ projectRoot: root, useDiffPaths: false });
    expect(result.exitCode).toBe(0);
    expect(result.report?.lowestModules.some((mod) => mod.path === "src/empty.ts")).toBe(true);
  });

  it("matches path filters by substring only (no regex/glob from CLI)", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "src/feature/a.ts": {
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 0] },
          branchMap: { "0": { line: 1, type: "if" } },
        },
        "lib/other.ts": {
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 0] },
        },
      }),
    });
    const result = evaluateCoverageHotspots({
      projectRoot: root,
      useDiffPaths: false,
      pathFilter: ["src/feature/"],
    });
    expect(result.report?.uncoveredBranches).toHaveLength(1);
    expect(result.report?.uncoveredBranches[0]?.path).toBe("src/feature/a.ts");
  });

  it("treats glob metacharacters in path filters as literal substrings", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "src/feature/a.ts": {
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 0] },
        },
        "lib/other.ts": {
          s: { "0": 1 },
          f: { "0": 1 },
          b: { "0": [1, 0] },
        },
      }),
    });
    const result = evaluateCoverageHotspots({
      projectRoot: root,
      useDiffPaths: false,
      pathFilter: ["src/feature/*.ts"],
    });
    // Literal substring — no RegExp from argv (CodeQL js/regex-injection).
    expect(result.report?.uncoveredBranches).toHaveLength(0);
  });

  it("reports both floor and headroom failures together", () => {
    const root = makeProject({
      "coverage/coverage-final.json": JSON.stringify({
        "src/a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
      }),
    });
    const result = evaluateCoverageHotspots({
      projectRoot: root,
      useDiffPaths: false,
      minHeadroomPp: 5,
    });
    expect(result.report?.failReasons.length).toBeGreaterThanOrEqual(2);
  });

  it("formats success reports without truncation markers", () => {
    const report = {
      ok: true,
      global: { lines: 90, functions: 90, branches: 90, statements: 90 },
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
      headroomPp: { lines: 5, functions: 5, branches: 5, statements: 5 },
      minHeadroomPp: 0.3,
      failReasons: [],
      lowestModules: [{ path: "src/a.ts", lines: 90, functions: 90, branches: 90, statements: 90 }],
      uncoveredBranches: [],
      pathFilter: ["src/a.ts"],
      coverageReportPath: "coverage/coverage-final.json",
    };
    const text = formatTextReport(report, false);
    expect(text).toContain("coverage-hotspots: OK");
    expect(text).not.toContain("...");
  });

  it("formats sparse success reports without optional sections", () => {
    const text = formatTextReport(
      {
        ok: true,
        global: { lines: 90, functions: 90, branches: 90, statements: 90 },
        thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
        headroomPp: { lines: 5, functions: 5, branches: 5, statements: 5 },
        minHeadroomPp: 0.3,
        failReasons: [],
        lowestModules: [],
        uncoveredBranches: [],
        pathFilter: [],
        coverageReportPath: "coverage/coverage-final.json",
      },
      false,
    );
    expect(text).not.toContain("lowest modules");
    expect(text).not.toContain("uncovered branch");
  });

  it("formats short path filters without ellipsis", () => {
    const text = formatTextReport(
      {
        ok: true,
        global: { lines: 90, functions: 90, branches: 90, statements: 90 },
        thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
        headroomPp: { lines: 5, functions: 5, branches: 5, statements: 5 },
        minHeadroomPp: 0.3,
        failReasons: [],
        lowestModules: [],
        uncoveredBranches: [],
        pathFilter: ["src/a.ts", "src/b.ts"],
        coverageReportPath: "coverage/coverage-final.json",
      },
      false,
    );
    expect(text).toContain("path filter (2): src/a.ts, src/b.ts");
    expect(text).not.toContain("...");
  });

  it("formats failing reports with explicit fail reasons", () => {
    const text = formatTextReport(
      {
        ok: false,
        global: { lines: 80, functions: 80, branches: 80, statements: 80 },
        thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
        headroomPp: { lines: -5, functions: -5, branches: -5, statements: -5 },
        minHeadroomPp: 0.3,
        failReasons: ["branches 80.00% below project floor 85%"],
        lowestModules: [],
        uncoveredBranches: [],
        pathFilter: [],
        coverageReportPath: "coverage/coverage-final.json",
      },
      true,
    );
    expect(text).toContain("fail reasons:");
  });

  it("defaults git diff base ref inside a repository on master", () => {
    const root = gitRepo({
      "coverage/coverage-final.json": JSON.stringify({
        "src/base.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 1] } },
      }),
    });
    const result = evaluateCoverageHotspots({ projectRoot: root });
    expect(result.exitCode).toBe(0);
    expect(result.report?.pathFilter).toEqual([]);
  });

  it("honors custom coverage directories and module limits", () => {
    const root = makeProject({
      "alt/coverage-final.json": JSON.stringify({
        "src/a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 1] } },
        "src/b.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 1] } },
      }),
    });
    const result = evaluateCoverageHotspots({
      projectRoot: root,
      coverageDir: join(root, "alt"),
      useDiffPaths: false,
      lowestModuleLimit: 1,
    });
    expect(result.exitCode).toBe(0);
    expect(result.report?.lowestModules).toHaveLength(1);
    expect(result.report?.coverageReportPath).toContain("alt");
  });

  it("formats long reports with truncated path filters and branch samples", () => {
    const pathFilter = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`);
    const uncoveredBranches = Array.from({ length: 15 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      line: i + 1,
      branchId: String(i),
      type: "if",
    }));
    const report = {
      ok: false,
      global: { lines: 80, functions: 80, branches: 80, statements: 80 },
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
      headroomPp: { lines: -5, functions: -5, branches: -5, statements: -5 },
      minHeadroomPp: 0.3,
      failReasons: ["branches 80.00% below project floor 85%"],
      lowestModules: [{ path: "src/a.ts", lines: 50, functions: 50, branches: 50, statements: 50 }],
      uncoveredBranches,
      pathFilter,
      coverageReportPath: "coverage/coverage-final.json",
    };
    const text = formatTextReport(report, true);
    expect(text).toContain("...");
    expect(text).toContain("more");
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
