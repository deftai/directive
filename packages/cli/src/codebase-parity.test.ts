import { describe, expect, it } from "vitest";
import { diffCase, PARITY_CASES } from "./codebase-parity.js";

describe("codebase-parity helpers", () => {
  it("detects stdout mismatch", () => {
    const diff = diffCase(
      { exitCode: 0, stdout: "a", stderr: "" },
      { exitCode: 0, stdout: "b", stderr: "" },
      "x",
    );
    expect(diff.stdoutMismatch).toBe(true);
  });

  it("defines parity cases", () => {
    expect(PARITY_CASES.length).toBeGreaterThan(0);
  });
});
