import { describe, expect, it, vi } from "vitest";
import { parseVerifyReviewMonitorArgs, run } from "./verify-review-monitor.js";

describe("verify-review-monitor CLI", () => {
  it("parseVerifyReviewMonitorArgs requires --pr", () => {
    const parsed = parseVerifyReviewMonitorArgs([]);
    expect(parsed.pr).toBeNull();
  });

  it("run exits 2 without --pr", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run([])).toBe(2);
    err.mockRestore();
  });

  it("run exits 0 on Tier 3 with no monitor required", () => {
    vi.stubEnv("CURSOR_COMPOSER", "");
    vi.stubEnv("CURSOR_AGENT", "");
    vi.stubEnv("GROK_BUILD", "");
    vi.stubEnv("DEFT_MONITOR_TIER", "3");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = run(["--pr", "9", "--project-root", "."]);
    expect(code).toBe(0);
    out.mockRestore();
    err.mockRestore();
    vi.unstubAllEnvs();
  });
});
