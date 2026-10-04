import { describe, expect, it, vi } from "vitest";
import {
  parseCohortReviewMonitorsArgv,
  verifyCohortReviewMonitorsMain,
} from "./cohort-review-monitors-cli.js";

describe("cohort-review-monitors-cli", () => {
  it("parses --prs= and --json", () => {
    const parsed = parseCohortReviewMonitorsArgv(["--prs=3,4", "--json", "--project-root", "."]);
    expect(parsed.prsCsv).toBe("3,4");
    expect(parsed.emitJson).toBe(true);
    expect(parsed.error).toBeUndefined();
  });

  it("help exits 0", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(verifyCohortReviewMonitorsMain(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toMatch(/cohort babysit inventory/);
    out.mockRestore();
  });

  it("malformed open-tracking-prs exits 2", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(verifyCohortReviewMonitorsMain(["--prs=1", "--open-tracking-prs", "nope"])).toBe(2);
    expect(err.mock.calls.join("")).toMatch(/open-tracking-prs|malformed/);
    err.mockRestore();
  });
});
