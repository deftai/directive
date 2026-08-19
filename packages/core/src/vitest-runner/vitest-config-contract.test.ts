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
    expect(source).toMatch(/maxWorkers:\s*winActiveMaxWorkers/);
    expect(source).toMatch(/maxForks:\s*winActiveMaxWorkers/);
    expect(source).toMatch(/cpus\(\)\.length\s*\*\s*0\.25/);
    expect(source).toMatch(/Math\.min\(12/);
  });

  it("keeps forks on win32 and ignores unhandled worker RPC flakes when tests are green", () => {
    expect(source).not.toMatch(/pool:\s*"threads"/);
    expect(source).toMatch(/dangerouslyIgnoreUnhandledErrors:\s*true/);
    expect(source).toMatch(/forks:/);
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

  it("serializes coverage processing and tightens workers when --coverage is on", () => {
    expect(source).toMatch(/processingConcurrency:\s*1/);
    expect(source).toMatch(/coverageEnabled/);
    expect(source).toMatch(/fileParallelism:\s*false/);
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

  // #3512: asserts the INVARIANT (one floor, no platform carve), not a literal
  // number. The previous form pinned `branches: 85`, so every recalibration had
  // to edit the test that exists to protect the rule — and a literal tells you
  // nothing about whether the rule still holds.
  it("applies one uniform threshold on all platforms (no win32 carve)", () => {
    expect(source).toContain("#2573");
    // No platform-conditional value anywhere in the threshold block.
    expect(source).not.toMatch(/(?:branches|lines|functions|statements):\s*isWin32/);
    expect(source).not.toMatch(/isWin32\s*\?\s*\d+(?:\.\d+)?\s*:/);

    const block = /const coverageThresholds\s*=\s*\{([\s\S]*?)\}\s*as const;/.exec(source)?.[1];
    expect(block).toBeDefined();
    const values = [...(block ?? "").matchAll(/(\w+):\s*(\d+(?:\.\d+)?)/g)].map(([, k, v]) => [
      k,
      Number(v),
    ]);
    expect(values.map(([k]) => k).sort()).toEqual(["branches", "functions", "lines", "statements"]);
    expect(new Set(values.map(([, v]) => v)).size).toBe(1);
  });

  // #3512 (Greptile review): the const above is not what Vitest receives — the
  // effective value comes from the `thresholds:` ternary, whose other arm is the
  // #2573 coverage-debt zero soft-pass. A carve introduced THERE
  // (`isWin32 ? { ...coverageThresholds, branches: 70 } : coverageThresholds`)
  // leaves the const uniform and would slip past the assertion above.
  it("passes the uniform const through to Vitest with no platform carve", () => {
    const effective = /thresholds:[\s\S]*?coverageThresholds,/.exec(source)?.[0] ?? "";
    // Empty means the assignment no longer resolves to the uniform const at all.
    expect(effective).not.toBe("");
    expect(effective).not.toMatch(/isWin32/);
    // The only permitted alternate arm is the coverage-debt zero soft-pass.
    expect(effective).toMatch(/coverageDebtIssue/);
  });

  // #3512: a coverage percentage is meaningless without the instrument that
  // produced it — vitest 3 and vitest 4 read the same suite as 85.35% and
  // 81.23% branches. The floor must carry that provenance in-file.
  it("stamps the instrument the floor was measured under", () => {
    expect(source).toMatch(/INSTRUMENT:/);
    expect(source).toMatch(/vitest 4/i);
    expect(source).toMatch(/remapping/i);
  });

  it("documents coverage-debt soft-pass gate", () => {
    expect(source).toMatch(/coverage-debt-teardown/);
    expect(source).toMatch(/resolveCoverageDebtIssue/);
  });
});

describe("vitest.config.ts Windows vs CI branch parity (#2630)", () => {
  const source = readFileSync(configPath, "utf8");

  // #3512: same reasoning as the #2573 contract above — assert parity, not a
  // literal. #2630's finding was that a local-vs-CI gap was uncovered branches,
  // NOT threshold asymmetry; the invariant worth protecting is that no
  // platform-conditional floor is ever reintroduced.
  it("uses the same branch threshold on win32 and Linux CI", () => {
    expect(source).toContain("#2630");
    expect(source).not.toMatch(/(?:branches|lines|functions|statements):\s*isWin32/);
    expect(source).not.toMatch(/isWin32\s*\?\s*\d+(?:\.\d+)?\s*:/);
  });

  it("documents that win32 runner caps affect timing only, not the coverage floor", () => {
    expect(source).toMatch(/Native Windows full-suite \+ coverage/);
    expect(source).toMatch(/coverageEnabled/);
    expect(source).toMatch(/coverageThresholds/);
  });
});
