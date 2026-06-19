import { describe, expect, it } from "vitest";
import { diffCase, renderReport } from "./verify-env-parity.js";

describe("verify-env-parity", () => {
  it("detects stdout mismatch", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "a\n", stderr: "" },
      { exitCode: 0, stdout: "b\n", stderr: "" },
      "x",
    );
    expect(diff.stdoutMismatch).toBe(true);
  });

  it("renders clean report", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
  });
});
