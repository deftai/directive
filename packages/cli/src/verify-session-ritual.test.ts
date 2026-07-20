import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-session-ritual.js";

describe("parseArgs", () => {
  it("defaults to quick tier with project root .", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      tier: "quick",
      posture: null,
      emitJson: false,
    });
    expect(parseArgs([]).error).toBeUndefined();
  });

  it("parses --tier=gated", () => {
    expect(parseArgs(["--tier=gated"])).toMatchObject({ tier: "gated" });
    expect(parseArgs(["--tier=gated"]).error).toBeUndefined();
  });

  it("accepts a lone -- separator before flags (#2680)", () => {
    expect(parseArgs(["--", "--tier=gated"])).toMatchObject({ tier: "gated" });
    expect(parseArgs(["--", "--tier=gated"]).error).toBeUndefined();
    expect(parseArgs(["--", "--tier=gated"])).toEqual(parseArgs(["--tier=gated"]));
  });

  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--tier"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
    expect(parseArgs(["--project-root"]).error).toMatch(/project-root/);
    expect(parseArgs(["--posture"]).error).toMatch(/posture/);
  });

  it("parses equals-form project root and posture aliases (#2666)", () => {
    expect(parseArgs(["--project-root=/tmp/work"]).projectRoot).toBe("/tmp/work");
    expect(parseArgs(["--posture=mutating"]).posture).toBe("mutation");
    expect(parseArgs(["--posture", "mutation"]).posture).toBe("mutation");
    expect(parseArgs(["--posture=read-only"]).posture).toBe("read-only");
    expect(parseArgs(["--json"]).emitJson).toBe(true);
  });

  it("rejects invalid tier and posture choices", () => {
    expect(parseArgs(["--tier=invalid"]).error).toMatch(/invalid choice/);
    expect(parseArgs(["--tier", "invalid"]).error).toMatch(/invalid choice/);
    expect(parseArgs(["--posture=nope"]).error).toMatch(/invalid choice/);
  });
});

describe("run (#2666)", () => {
  it("exits 2 and prints parse errors", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run(["--bogus"])).toBe(2);
    expect(err.mock.calls.join("")).toContain("unrecognized argument");
    err.mockRestore();
  });
});
