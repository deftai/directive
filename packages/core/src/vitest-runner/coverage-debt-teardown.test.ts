import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import coverageDebtTeardown from "./coverage-debt-teardown.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const coverageDir = join(repoRoot, "coverage");
const coverageFinal = join(coverageDir, "coverage-final.json");
const changelogPath = join(repoRoot, "CHANGELOG.md");

describe("coverageDebtTeardown (#2573 / #2836)", () => {
  let savedCoverage: string | null = null;
  let savedChangelog: string | null = null;
  const stderrChunks: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    stderrChunks.length = 0;

    if (savedCoverage === null) {
      if (existsSync(coverageFinal)) {
        rmSync(coverageFinal, { force: true });
      }
    } else {
      mkdirSync(coverageDir, { recursive: true });
      writeFileSync(coverageFinal, savedCoverage, "utf8");
    }

    if (savedChangelog !== null) {
      writeFileSync(changelogPath, savedChangelog, "utf8");
    }
  });

  function backupCoverage(): void {
    savedCoverage = existsSync(coverageFinal) ? readFileSync(coverageFinal, "utf8") : null;
    mkdirSync(coverageDir, { recursive: true });
  }

  function writeCoverage(payload: unknown): void {
    backupCoverage();
    writeFileSync(coverageFinal, JSON.stringify(payload), "utf8");
  }

  function withDebtArgv(issue: number, run: () => Promise<void>): Promise<void> {
    const argv = process.argv.slice();
    process.argv = [...argv, `--allow-coverage-debt=${issue}`];
    return run().finally(() => {
      process.argv = argv;
    });
  }

  it("returns immediately when no coverage-debt flag is set", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await coverageDebtTeardown();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("throws on invalid coverage-debt resolution", async () => {
    const argv = process.argv.slice();
    process.argv = [...argv, "--allow-coverage-debt=#"];
    await expect(coverageDebtTeardown()).rejects.toThrow(/coverage-debt:/);
    process.argv = argv;
  });

  it("throws when coverage-final.json is missing", async () => {
    backupCoverage();
    if (existsSync(coverageFinal)) {
      rmSync(coverageFinal, { force: true });
    }
    await withDebtArgv(2836, async () => {
      await expect(coverageDebtTeardown()).rejects.toThrow(
        "coverage-debt: could not read coverage/coverage-final.json",
      );
    });
  });

  it("notes when debt is set but all metrics meet the goal", async () => {
    writeCoverage({
      "a.ts": { s: { "0": 1 }, f: { "0": 1 }, b: { "0": [1, 1] } },
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
    writeCoverage({
      "a.ts": { s: { "0": 1, "1": 0 }, f: { "0": 1 }, b: { "0": [1, 0] } },
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
    writeCoverage({
      "a.ts": { s: { "0": 1, "1": 0 }, f: { "0": 1 }, b: { "0": [1, 0] } },
    });
    savedChangelog = readFileSync(changelogPath, "utf8");
    writeFileSync(
      changelogPath,
      "## [Unreleased]\n\n## [0.2.0]\ncoverage-debt soft-pass\n\n## [0.1.0]\nallow-coverage-debt=#1234\n",
      "utf8",
    );
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
