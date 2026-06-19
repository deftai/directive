import { describe, expect, it } from "vitest";
import { diffParity, PARITY_SCENARIOS, pickOutput } from "./pr-merge-readiness-parity.js";

describe("pr-merge-readiness parity helpers", () => {
  it("pickOutput selects stream", () => {
    const result = { name: "x", exitCode: 0, stdout: "out", stderr: "err" };
    expect(pickOutput(result, "stdout")).toBe("out");
    expect(pickOutput(result, "stderr")).toBe("err");
  });

  it("diffParity detects exit and output mismatch", () => {
    const py = { name: "a", exitCode: 0, stdout: "same", stderr: "" };
    const ts = { name: "a", exitCode: 1, stdout: "diff", stderr: "" };
    const same = diffParity(py, py, "stdout");
    expect(same.exitMismatch).toBe(false);
    expect(same.outputMismatch).toBe(false);
    const diff = diffParity(py, ts, "stdout");
    expect(diff.exitMismatch).toBe(true);
    expect(diff.outputMismatch).toBe(true);
  });

  it("parity scenarios are non-empty", () => {
    expect(PARITY_SCENARIOS.length).toBeGreaterThanOrEqual(6);
  });
});
