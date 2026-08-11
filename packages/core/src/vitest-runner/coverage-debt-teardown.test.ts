import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadCoverage, mockReadFileSync } = vi.hoisted(() => ({
  mockReadCoverage: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock("./coverage-debt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./coverage-debt.js")>();
  return {
    ...actual,
    readCoverageTotalsFromReport: mockReadCoverage,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      const mocked = mockReadFileSync(path, ...args);
      if (mocked !== undefined) {
        return mocked;
      }
      return actual.readFileSync(path, ...(args as []));
    },
  };
});

import coverageDebtTeardown from "./coverage-debt-teardown.js";

describe("coverageDebtTeardown (#2573 / #2836)", () => {
  const stderrChunks: string[] = [];

  beforeEach(() => {
    mockReadFileSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stderrChunks.length = 0;
    mockReadCoverage.mockReset();
    mockReadFileSync.mockReset();
  });

  function withDebtArgv(issue: number, run: () => Promise<void>): Promise<void> {
    const argv = process.argv.slice();
    process.argv = [...argv, `--allow-coverage-debt=${issue}`];
    return run().finally(() => {
      process.argv = argv;
    });
  }

  it("returns immediately when no coverage-debt flag is set", async () => {
    const priorLane = process.env.DEFT_TS_LANE_COVERAGE_DEBT;
    delete process.env.DEFT_TS_LANE_COVERAGE_DEBT;
    try {
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await coverageDebtTeardown();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(mockReadCoverage).not.toHaveBeenCalled();
    } finally {
      if (priorLane === undefined) {
        delete process.env.DEFT_TS_LANE_COVERAGE_DEBT;
      } else {
        process.env.DEFT_TS_LANE_COVERAGE_DEBT = priorLane;
      }
    }
  });

  it("throws on invalid coverage-debt resolution", async () => {
    const argv = process.argv.slice();
    process.argv = [...argv, "--allow-coverage-debt=#"];
    await expect(coverageDebtTeardown()).rejects.toThrow(/coverage-debt:/);
    process.argv = argv;
  });

  it("throws when coverage-final.json is missing", async () => {
    mockReadCoverage.mockReturnValue(null);
    await withDebtArgv(2836, async () => {
      await expect(coverageDebtTeardown()).rejects.toThrow(
        "coverage-debt: could not read coverage/coverage-final.json",
      );
    });
  });

  it("notes when debt is set but all metrics meet the goal", async () => {
    mockReadCoverage.mockReturnValue({
      lines: 90,
      functions: 90,
      branches: 90,
      statements: 90,
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await withDebtArgv(2836, async () => {
      await coverageDebtTeardown();
    });

    expect(stderrChunks.join("")).toContain("all metrics meet the 85% goal");
  });

  it("emits attribution when metrics sit below the goal", async () => {
    mockReadCoverage.mockReturnValue({
      lines: 84.5,
      functions: 86,
      branches: 84.9,
      statements: 84.5,
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await withDebtArgv(2836, async () => {
      await coverageDebtTeardown();
    });

    const text = stderrChunks.join("");
    expect(text).toContain("#2836");
    expect(text).toContain("branches");
  });

  it("warns on repeated coverage-debt mentions in CHANGELOG", async () => {
    mockReadCoverage.mockReturnValue({
      lines: 84.5,
      functions: 86,
      branches: 84.9,
      statements: 84.5,
    });
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("CHANGELOG.md")) {
        return "## [Unreleased]\n\n## [0.2.0]\ncoverage-debt soft-pass\n\n## [0.1.0]\nallow-coverage-debt=#1234\n";
      }
      return undefined;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await withDebtArgv(2836, async () => {
      await coverageDebtTeardown();
    });

    expect(stderrChunks.join("")).toMatch(/WARN.*coverage debt/i);
  });
});
