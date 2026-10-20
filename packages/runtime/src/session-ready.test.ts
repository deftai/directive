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
      sessionId: null,
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
      sessionId: null,
    });
  });

  it("accepts equals-form flags", () => {
    expect(parseArgs(["--project-root=/x", "--repo=a/b"])).toEqual({
      projectRoot: "/x",
      emitJson: false,
      withNetwork: false,
      repo: "a/b",
      sessionId: null,
    });
  });

  it("parses an explicit lifecycle session identity (#3611)", () => {
    expect(parseArgs(["--session-id", "host:codex:v1:c2Vzc2lvbg"])).toMatchObject({
      sessionId: "host:codex:v1:c2Vzc2lvbg",
    });
    expect(parseArgs(["--session-id=host:cursor:v1:Y29udmVyc2F0aW9u"])).toMatchObject({
      sessionId: "host:cursor:v1:Y29udmVyc2F0aW9u",
    });
  });

  it("rejects a missing or blank lifecycle session identity (#3611)", () => {
    expect(parseArgs(["--session-id"]).error).toContain("expected one argument");
    expect(parseArgs(["--session-id", "--with-network"]).error).toContain("expected one argument");
    expect(parseArgs(["--session-id="]).error).toContain("non-empty");
    expect(parseArgs(["--session-id=--with-network"]).error).toContain("non-empty");
    expect(parseArgs(["--session-id", "   "]).error).toContain("non-empty");
  });

  it("does not let repo or project-root swallow the explicit session ID", () => {
    const sessionId = "--session-id=host:codex:v1:c2Vzc2lvbi1h";
    expect(parseArgs(["--repo", sessionId]).error).toContain("--repo: expected one argument");
    expect(parseArgs(["--project-root", sessionId]).error).toContain(
      "--project-root: expected one argument",
    );
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
