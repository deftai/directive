import { describe, expect, it } from "vitest";
import { diffGate, renderReport } from "./verify-source-parity.js";

describe("verify-source-parity helpers", () => {
  it("diffGate reports matching captures as clean", () => {
    const cap = { name: "verify-stubs", exitCode: 0, stdout: "ok\n", stderr: "" };
    const diff = diffGate(cap, cap);
    expect(diff.exitMismatch).toBe(false);
    expect(diff.stdoutMismatch).toBe(false);
    expect(diff.stderrMismatch).toBe(false);
  });

  it("renderReport shows CLEAN on ok result", () => {
    const report = renderReport({
      ok: true,
      gates: [
        {
          name: "verify-stubs",
          exitMismatch: false,
          stdoutMismatch: false,
          stderrMismatch: false,
          pythonExit: 0,
          tsExit: 0,
        },
      ],
    });
    expect(report).toContain("CLEAN");
  });
});
