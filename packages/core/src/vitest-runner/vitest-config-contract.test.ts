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
    expect(source).toMatch(/maxForks:\s*winMaxWorkers/);
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
