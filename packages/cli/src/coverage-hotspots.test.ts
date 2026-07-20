import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./coverage-hotspots.js";

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("coverage-hotspots parseArgs", () => {
  it("defaults project root and diff filter", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      useDiffPaths: true,
      json: false,
      quiet: false,
      pathFilter: [],
    });
  });

  it("parses json, quiet, coverage dir, and min headroom", () => {
    expect(
      parseArgs(["--json", "--quiet", "--coverage-dir=coverage-report", "--min-headroom-pp=0.5"]),
    ).toMatchObject({
      json: true,
      quiet: true,
      coverageDir: "coverage-report",
      minHeadroomPp: 0.5,
    });
  });

  it("parses explicit path filters and disables diff filter", () => {
    expect(parseArgs(["--path", "src/a.ts,src/b.ts"]).pathFilter).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parseArgs(["--path", "src/a.ts"]).useDiffPaths).toBe(false);
  });

  it("errors on unknown flags and missing values", () => {
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toBeDefined();
    expect(parseArgs(["--min-headroom-pp", "nope"]).error).toBeDefined();
  });
});

describe("coverage-hotspots run", () => {
  it("returns 2 when coverage report is missing", () => {
    expect(silentRun(["--project-root", ".", "--no-diff-filter"])).toBe(2);
  });
});
