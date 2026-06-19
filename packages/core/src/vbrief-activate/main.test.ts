import { describe, expect, it, vi } from "vitest";
import { cmdVbriefActivate, parseArgs, run } from "./main.js";

describe("parseArgs", () => {
  it("parses a single vbrief path", () => {
    expect(parseArgs(["/tmp/foo.vbrief.json"])).toEqual({ vbriefPath: "/tmp/foo.vbrief.json" });
  });

  it("errors when path missing", () => {
    expect(parseArgs([]).error).toContain("required");
  });

  it("errors on extra arguments", () => {
    expect(parseArgs(["a", "b"]).error).toContain("unrecognized");
  });
});

describe("run CLI", () => {
  it("returns 2 on parse error", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([])).toBe(2);
    stderr.mockRestore();
  });

  it("cmdVbriefActivate delegates to run", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cmdVbriefActivate([])).toBe(2);
    stderr.mockRestore();
  });
});
