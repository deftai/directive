import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffParity,
  normaliseMessage,
  PARITY_SCENARIOS,
  renderReport,
  runParity,
} from "./cache-parity.js";

describe("cache-parity helpers", () => {
  it("normaliseMessage picks stderr on non-zero exit", () => {
    expect(normaliseMessage("", "cache: error: bad", 1)).toBe("cache: error: bad");
  });

  it("normaliseMessage picks stdout on zero exit and strips uv noise", () => {
    expect(
      normaliseMessage(
        "ok\n",
        "Using CPython 3.12\nCreating virtual environment\nInstalled 1 package\n",
        0,
      ),
    ).toBe("ok");
  });

  it("diffParity detects mismatch", () => {
    const diff = diffParity(
      { name: "a", exitCode: 0, stdout: "ok", stderr: "" },
      { name: "a", exitCode: 1, stdout: "", stderr: "fail" },
    );
    expect(diff.exitMismatch).toBe(true);
  });

  it("renderReport prints CLEAN and divergence details", () => {
    expect(
      renderReport({
        ok: true,
        scenarios: [
          {
            name: "x",
            exitMismatch: false,
            pythonExit: 0,
            tsExit: 0,
            messageMismatch: false,
            pythonMessage: "",
            tsMessage: "",
          },
        ],
      }),
    ).toContain("CLEAN");
    const diverged = renderReport({
      ok: false,
      scenarios: [
        {
          name: "usage-no-cmd",
          exitMismatch: true,
          pythonExit: 2,
          tsExit: 1,
          messageMismatch: true,
          pythonMessage: "usage",
          tsMessage: "other",
        },
      ],
    });
    expect(diverged).toContain("DIVERGENCE");
    expect(diverged).toContain("usage-no-cmd");
  });

  it("defines validation scenarios", () => {
    expect(PARITY_SCENARIOS.length).toBeGreaterThanOrEqual(10);
  });

  it("runParity returns structured result when dist cache exists", () => {
    const distCache = join(process.cwd(), "packages/cli/dist/cache.js");
    if (!existsSync(distCache)) {
      return;
    }
    const result = runParity();
    expect(result.scenarios.length).toBe(PARITY_SCENARIOS.length);
  }, 120_000);
});
