import { describe, expect, it } from "vitest";
import {
  diffParity,
  PARITY_SCENARIOS,
  pickOutput,
  renderReport,
} from "./release-publish-parity.js";

describe("release-publish-parity helpers", () => {
  it("exports expected scenarios including safety paths", () => {
    const names = PARITY_SCENARIOS.map((s) => s.name);
    expect(names).toContain("invalid-version");
    expect(names).toContain("dry-run");
    expect(names).toContain("help");
    expect(names).toContain("missing-version");
  });

  it("diffParity detects exit mismatch", () => {
    const diff = diffParity(
      { name: "x", exitCode: 1, stdout: "", stderr: "a" },
      { name: "x", exitCode: 0, stdout: "", stderr: "a" },
      "stderr",
    );
    expect(diff.exitMismatch).toBe(true);
    expect(diff.outputMismatch).toBe(false);
  });

  it("pickOutput selects stream", () => {
    const result = { name: "x", exitCode: 0, stdout: "out", stderr: "err" };
    expect(pickOutput(result, "stdout")).toBe("out");
    expect(pickOutput(result, "stderr")).toBe("err");
  });

  it("renderReport clean", () => {
    expect(
      renderReport({
        ok: true,
        scenarios: [],
      }),
    ).toContain("CLEAN");
  });
});
