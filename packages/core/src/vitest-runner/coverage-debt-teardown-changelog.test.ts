import { afterEach, describe, expect, it, vi } from "vitest";

const { mockReadCoverage } = vi.hoisted(() => ({
  mockReadCoverage: vi.fn(),
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
      if (String(path).endsWith("CHANGELOG.md")) {
        throw new Error("ENOENT");
      }
      return actual.readFileSync(path, ...(args as []));
    },
  };
});

import coverageDebtTeardown from "./coverage-debt-teardown.js";

describe("coverageDebtTeardown CHANGELOG read failure (#2836)", () => {
  const stderrChunks: string[] = [];

  afterEach(() => {
    stderrChunks.length = 0;
    mockReadCoverage.mockReset();
  });

  it("still attributes debt when CHANGELOG cannot be read", async () => {
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

    const argv = process.argv.slice();
    process.argv = [...argv, "--allow-coverage-debt=2836"];
    try {
      await coverageDebtTeardown();
    } finally {
      process.argv = argv;
    }

    expect(stderrChunks.join("")).toContain("#2836");
    expect(mockReadCoverage).toHaveBeenCalledOnce();
  });
});
