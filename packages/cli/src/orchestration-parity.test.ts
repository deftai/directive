import { describe, expect, it } from "vitest";
import { diffParity, normaliseHarnessNoise } from "./orchestration-parity.js";

describe("orchestration-parity helpers", () => {
  it("normalises monitor JSON volatile fields", () => {
    const raw = JSON.stringify(
      { now: "2026-01-01T00:00:00Z", records: [{ age_seconds: 1 }] },
      null,
      2,
    );
    const norm = normaliseHarnessNoise(raw);
    expect(norm).not.toContain('"now"');
    expect(norm).not.toContain("age_seconds");
  });

  it("diffParity detects mismatches", () => {
    expect(
      diffParity(
        { name: "a", exitCode: 0, stdout: "x", stderr: "" },
        { name: "a", exitCode: 0, stdout: "x", stderr: "" },
      ).exitMismatch,
    ).toBe(false);
    const diff = diffParity(
      { name: "a", exitCode: 0, stdout: "x", stderr: "" },
      { name: "a", exitCode: 1, stdout: "y", stderr: "z" },
    );
    expect(diff.exitMismatch).toBe(true);
    expect(diff.stdoutMismatch).toBe(true);
    expect(diff.stderrMismatch).toBe(true);
  });
});
