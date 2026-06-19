import { describe, expect, it } from "vitest";
import { diffParity, normaliseStdout, renderReport } from "./doctor-parity.js";

describe("doctor-parity helpers", () => {
  it("normaliseStdout strips uv bootstrap lines", () => {
    expect(normaliseStdout("Using CPython 3.14\nok\n")).toBe("ok\n");
  });

  it("diffParity detects stdout mismatch", () => {
    const diff = diffParity(
      { name: "a", exitCode: 0, stdout: "x", stderr: "" },
      { name: "a", exitCode: 0, stdout: "y", stderr: "" },
    );
    expect(diff.stdoutMismatch).toBe(true);
  });

  it("renderReport clean", () => {
    expect(renderReport({ ok: true, scenarios: [] })).toContain("CLEAN");
  });
});
