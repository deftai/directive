import { describe, expect, it } from "vitest";
import { NODE_RUNTIME_REMEDIATION } from "./node-runtime.js";
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
    expect(result.lines.some((line) => line.includes("Missing tools:"))).toBe(true);
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

  it("emits node runtime remediation when node or pnpm is missing", () => {
    const result = runToolchainCheck((command) => {
      const name = command[0] ?? "";
      if (name === "node" || name === "pnpm") {
        return { error: "not-found", message: "" };
      }
      return { returncode: 0, stdout: `${name} version test\n`, stderr: "" };
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(NODE_RUNTIME_REMEDIATION);
  });

  it("does not emit node remediation when only unrelated tools are missing", () => {
    const result = runToolchainCheck((command) => {
      const name = command[0] ?? "";
      if (name === "go") {
        return { error: "not-found", message: "" };
      }
      return { returncode: 0, stdout: `${name} version test\n`, stderr: "" };
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).not.toContain(NODE_RUNTIME_REMEDIATION);
  });
});
