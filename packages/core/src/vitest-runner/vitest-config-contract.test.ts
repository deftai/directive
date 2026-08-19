import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const configPath = join(repoRoot, "vitest.config.ts");

describe("vitest.config.ts Windows runner contract (#2546)", () => {
  const source = readFileSync(configPath, "utf8");

  it("documents onTaskUpdate RPC timeout mitigation for native Windows", () => {
    expect(source).toContain("#2546");
    expect(source).toMatch(/onTaskUpdate/);
  });

  it("caps fork parallelism on win32 for coordinator headroom", () => {
    expect(source).toMatch(/maxWorkers:\s*winMaxWorkers/);
    expect(source).toMatch(/cpus\(\)\.length\s*\*\s*0\.25/);
    expect(source).toMatch(/Math\.min\(12/);
    expect(source).not.toMatch(/winActiveMaxWorkers/);
    expect(source).not.toMatch(/poolOptions/);
    expect(source).not.toMatch(/maxForks/);
  });

  it("keeps forks default on win32 and ignores unhandled worker RPC flakes when tests are green", () => {
    expect(source).not.toMatch(/pool:\s*"threads"/);
    expect(source).toMatch(/dangerouslyIgnoreUnhandledErrors:\s*true/);
  });

  it("widens teardownTimeout on win32 for heavy coverage runs", () => {
    expect(source).toMatch(/teardownTimeout:\s*60_000/);
  });
});

describe("vitest.config.ts Windows coverage tmp contract (#2580)", () => {
  const source = readFileSync(configPath, "utf8");

  it("documents coverage/.tmp ENOENT mitigation for native Windows", () => {
    expect(source).toContain("#2580");
    expect(source).toMatch(/coverage\/\.tmp/);
  });

  it("does not serialize file parallelism or coverage processing on win32 (#3480)", () => {
    expect(source).not.toMatch(/processingConcurrency:\s*1/);
    expect(source).not.toMatch(/fileParallelism:\s*false/);
    expect(source).not.toMatch(/winActiveMaxWorkers/);
    expect(source).toMatch(/coverageEnabled/);
    expect(source).toMatch(/win32CoverageTmpSetup/);
  });

  it("globalSetup module keeps coverage/.tmp present on win32", () => {
    const setupPath = join(repoRoot, "packages/core/src/vitest-runner/win32-coverage-tmp-setup.ts");
    const setupSource = readFileSync(setupPath, "utf8");
    expect(setupSource).toContain("#2580");
    expect(setupSource).toMatch(/coverage.*\.tmp/);
    expect(setupSource).toMatch(/ensureCoverageTmpDir/);
  });
});

describe("vitest.config.ts Windows coverage tmp regression (#2634)", () => {
  const source = readFileSync(configPath, "utf8");

  it("documents vitest 4 upgrade path for upstream mkdir fix", () => {
    expect(source).toContain("#2634");
    expect(source).toMatch(/vitest-dev\/vitest#10117/);
  });

  it("win32-coverage-tmp-setup guards chunk writes before mkdir", () => {
    const setupPath = join(repoRoot, "packages/core/src/vitest-runner/win32-coverage-tmp-setup.ts");
    const setupSource = readFileSync(setupPath, "utf8");
    expect(setupSource).toContain("#2634");
    expect(setupSource).toMatch(/installCoverageTmpWriteGuard/);
    expect(setupSource).toMatch(/isCoverageTmpChunkPath/);
  });

  it("has focused regression tests for coverage tmp hardening", () => {
    const testPath = join(
      repoRoot,
      "packages/core/src/vitest-runner/win32-coverage-tmp-setup.test.ts",
    );
    expect(readFileSync(testPath, "utf8")).toContain("#2634");
  });
});

describe("vitest.config.ts coverage threshold contract (#2573)", () => {
  const source = readFileSync(configPath, "utf8");

  it("sets branches threshold to 85 on all platforms (no win32 carve)", () => {
    expect(source).toContain("#2573");
    expect(source).toMatch(/branches:\s*85/);
    expect(source).not.toMatch(/isWin32\s*\?\s*84\.85/);
  });

  it("documents coverage-debt soft-pass gate", () => {
    expect(source).toMatch(/coverage-debt-teardown/);
    expect(source).toMatch(/resolveCoverageDebtIssue/);
  });
});

describe("vitest.config.ts Windows vs CI branch parity (#2630)", () => {
  const source = readFileSync(configPath, "utf8");

  it("uses the same 85% branch threshold on win32 and Linux CI", () => {
    expect(source).toContain("#2630");
    expect(source).toMatch(/branches:\s*85/);
    expect(source).not.toMatch(/isWin32\s*\?\s*84\.85/);
  });

  it("documents that win32 runner caps affect timing only, not the coverage floor", () => {
    expect(source).toMatch(/Native Windows full-suite \+ coverage/);
    expect(source).toMatch(/coverageEnabled/);
    expect(source).toMatch(/coverageThresholds/);
  });
});
