import { describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./ts-check-lane.js";

describe("ts-check-lane parseArgs", () => {
  it("defaults projectRoot to undefined with no args", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("parses --project-root <value>", () => {
    expect(parseArgs(["--project-root", "/repo"])).toEqual({ projectRoot: "/repo" });
  });

  it("parses --project-root=<value>", () => {
    expect(parseArgs(["--project-root=/repo"])).toEqual({ projectRoot: "/repo" });
  });

  it("errors when --project-root is missing its value", () => {
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
  });

  it("errors when --project-root= has an empty value", () => {
    expect(parseArgs(["--project-root="]).error).toContain("expected one argument");
  });

  it("errors on an unrecognized argument", () => {
    expect(parseArgs(["--bogus"]).error).toContain("unrecognized argument");
  });
});

describe("ts-check-lane run", () => {
  it("returns 2 and writes to stderr on a parse error", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = run(["--bogus"]);
    expect(code).toBe(2);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns 0 in a Node-less environment (pnpm absent -> skip notice)", () => {
    // Force the pnpm probe to miss by pointing PATH at an empty dir set.
    const original = process.env.PATH;
    const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.env.PATH = "/nonexistent-deft-test-dir";
    try {
      const code = run(["--project-root", "/repo"]);
      expect(code).toBe(0);
    } finally {
      process.env.PATH = original;
      outSpy.mockRestore();
    }
  });
});
