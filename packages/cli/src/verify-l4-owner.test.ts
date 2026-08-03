import { describe, expect, it, vi } from "vitest";
import { parseVerifyL4OwnerArgs, run } from "./verify-l4-owner.js";

describe("verify-l4-owner CLI (#3090)", () => {
  it("parses --pr and --review-cycle", () => {
    const args = parseVerifyL4OwnerArgs(["--pr", "42", "--review-cycle", "done", "--json"]);
    expect(args.pr).toBe(42);
    expect(args.reviewCycle).toBe("done");
    expect(args.emitJson).toBe(true);
    expect(args.error).toBeUndefined();
  });

  it("help exits 0", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toContain("verify:l4-owner");
    out.mockRestore();
  });

  it("missing --pr exits 2", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([])).toBe(2);
    expect(err.mock.calls.join("")).toContain("--pr is required");
    err.mockRestore();
  });
});
