import { describe, expect, it } from "vitest";
import { runToolchainCheck } from "./toolchain-check.js";

describe("runToolchainCheck", () => {
  it("reports all tools available on success", () => {
    const result = runToolchainCheck((command) => ({
      returncode: 0,
      stdout: `${command[0]} version test\n`,
      stderr: "",
    }));
    expect(result.exitCode).toBe(0);
    expect(result.lines.at(-1)).toBe("All required tools available");
  });

  it("reports missing tools with exit 1", () => {
    const result = runToolchainCheck(() => ({ error: "not-found", message: "" }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.at(-1)).toContain("Missing tools:");
  });

  it("reports command failures", () => {
    const result = runToolchainCheck(() => ({
      returncode: 1,
      stdout: "",
      stderr: "failed",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((line) => line.includes("FAILED"))).toBe(true);
  });
});
