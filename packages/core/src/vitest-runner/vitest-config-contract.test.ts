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
