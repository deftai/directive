import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBinPath, resolveRepoRoot, runDeftTs, runDeftTsArgv } from "./deft-ts-runner.js";

describe("deft-ts runner", () => {
  it("resolves repo root and built bin", () => {
    const root = resolveRepoRoot();
    expect(existsSync(resolve(root, "package.json"))).toBe(true);
    expect(existsSync(resolve(root, "packages/cli"))).toBe(true);
    expect(existsSync(resolveBinPath())).toBe(true);
  });

  it("runs --help with exit 0", () => {
    const result = runDeftTsArgv(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: directive");
    expect(result.stdout).toContain("pack-render");
  });

  it("reports unknown verb on stderr", () => {
    const result = runDeftTs("not-a-real-render-verb-xyz");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown verb");
  });
});
