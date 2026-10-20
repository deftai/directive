import { describe, expect, it, vi } from "vitest";
import { parseCohortReviewMonitorsArgv, run } from "./verify-cohort-review-monitors.js";

describe("verify-cohort-review-monitors CLI wrapper", () => {
  it("re-exports argv parser", () => {
    expect(parseCohortReviewMonitorsArgv(["--prs=5"]).prsCsv).toBe("5");
  });

  it("run --help exits 0", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toMatch(/#5318/);
    out.mockRestore();
  });

  it("run without --prs exits 2", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run([])).toBe(2);
    expect(err.mock.calls.join("")).toMatch(/Error|empty|--prs/i);
    err.mockRestore();
  });
});
