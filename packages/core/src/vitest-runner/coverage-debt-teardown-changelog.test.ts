import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const coverageDir = join(repoRoot, "coverage");
const coverageFinal = join(coverageDir, "coverage-final.json");

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
  let hadCoverage = false;

  afterEach(() => {
    stderrChunks.length = 0;
    if (hadCoverage) {
      return;
    }
    if (existsSync(coverageFinal)) {
      rmSync(coverageFinal, { force: true });
    }
  });

  it("still attributes debt when CHANGELOG cannot be read", async () => {
    hadCoverage = existsSync(coverageFinal);
    mkdirSync(coverageDir, { recursive: true });
    writeFileSync(
      coverageFinal,
      JSON.stringify({
        "a.ts": { s: { "0": 1, "1": 0 }, f: { "0": 1 }, b: { "0": [1, 0] } },
      }),
      "utf8",
    );
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
  });
});
