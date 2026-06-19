import { describe, expect, it } from "vitest";
import { diffParity, normaliseMessage, renderReport } from "./scm-parity.js";

describe("scm-parity helpers", () => {
  it("normaliseMessage prefers stderr on non-zero exit", () => {
    expect(normaliseMessage("", "error: boom\n", 2)).toBe("error: boom");
  });

  it("diffParity detects exit and message mismatch", () => {
    const clean = diffParity(
      { name: "a", exitCode: 2, stdout: "", stderr: "error: x\n" },
      { name: "a", exitCode: 2, stdout: "", stderr: "error: x\n" },
    );
    expect(clean.exitMismatch).toBe(false);
    expect(clean.messageMismatch).toBe(false);

    const diverged = diffParity(
      { name: "a", exitCode: 2, stdout: "", stderr: "error: x\n" },
      { name: "a", exitCode: 1, stdout: "", stderr: "error: y\n" },
    );
    expect(diverged.exitMismatch).toBe(true);
    expect(diverged.messageMismatch).toBe(true);
  });

  it("renderReport prints CLEAN summary", () => {
    expect(
      renderReport({
        ok: true,
        scenarios: [],
      }),
    ).toContain("CLEAN");
  });

  it("renderReport prints divergence details", () => {
    const report = renderReport({
      ok: false,
      scenarios: [
        {
          name: "usage-too-short",
          exitMismatch: true,
          pythonExit: 2,
          tsExit: 1,
          messageMismatch: true,
          pythonMessage: "usage",
          tsMessage: "other",
        },
      ],
    });
    expect(report).toContain("DIVERGENCE");
    expect(report).toContain("usage-too-short");
  });
});
