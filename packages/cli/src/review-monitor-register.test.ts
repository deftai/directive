import { describe, expect, it, vi } from "vitest";
import { parseRegisterArgs, run } from "./review-monitor-register.js";

describe("review-monitor-register CLI", () => {
  it("parseRegisterArgs rejects missing platform primitive", () => {
    const parsed = parseRegisterArgs(["--pr", "1", "--monitor-agent-id", "m1"]);
    expect(parsed.platformPrimitive).toBeNull();
  });

  it("run exits 2 when required fields missing", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run(["--pr", "1"])).toBe(2);
    err.mockRestore();
  });
});
