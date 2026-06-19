import { describe, expect, it } from "vitest";
import { diffGate } from "./vbrief-validate-parity.js";

describe("vbrief-validate-parity helpers", () => {
  it("detects stdout divergence", () => {
    const result = diffGate(
      { name: "t", exitCode: 0, stdout: "a\n", stderr: "" },
      { name: "t", exitCode: 0, stdout: "b\n", stderr: "" },
    );
    expect(result.stdoutMismatch).toBe(true);
    expect(result.exitMismatch).toBe(false);
  });
});
