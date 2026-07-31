import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./session-ready.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session-ready parseArgs", () => {
  it("defaults project root to cwd", () => {
    expect(parseArgs([])).toEqual({
      projectRoot: ".",
      emitJson: false,
      withNetwork: false,
      repo: null,
    });
  });

  it("parses flags", () => {
    expect(
      parseArgs(["--project-root", "/tmp/p", "--repo", "o/r", "--json", "--with-network"]),
    ).toEqual({
      projectRoot: "/tmp/p",
      emitJson: true,
      withNetwork: true,
      repo: "o/r",
    });
  });

  it("accepts equals-form flags", () => {
    expect(parseArgs(["--project-root=/x", "--repo=a/b"])).toEqual({
      projectRoot: "/x",
      emitJson: false,
      withNetwork: false,
      repo: "a/b",
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized argument");
  });

  it("requires values for --project-root and --repo", () => {
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
    expect(parseArgs(["--repo"]).error).toContain("expected one argument");
  });
});

describe("session-ready run", () => {
  it("returns 2 for parse errors", () => {
    const prevStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(run(["--repo"])).toBe(2);
    } finally {
      process.stderr.write = prevStderr;
    }
  });
});
