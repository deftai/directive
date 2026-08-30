import { describe, expect, it } from "vitest";
import { classifyScmArgv, resolveBinaryForArgv, resolveBinaryForRole } from "./call-shape.js";
import { ScmStubError } from "./errors.js";

const bothPresent = (name: string) => `/usr/bin/${name}`;
const ghOnly = (name: string) => (name === "gh" ? "/usr/local/bin/gh" : null);
const ghxOnly = (name: string) => (name === "ghx" ? "/usr/bin/ghx" : null);

describe("classifyScmArgv", () => {
  it("treats a single positional api path as cached-get", () => {
    expect(classifyScmArgv("api", ["repos/deftai/directive/issues/3737"])).toBe("cached-get");
  });

  it("treats a mutation method as live-gh", () => {
    expect(
      classifyScmArgv("api", ["repos/o/r/issues/1/comments", "--method", "POST", "--input", "-"]),
    ).toBe("live-gh");
  });

  it("treats a flag-rich GET as live-gh", () => {
    expect(
      classifyScmArgv("api", ["repos/o/r/issues", "--method", "GET", "--raw-field", "state=open"]),
    ).toBe("live-gh");
  });

  it("treats paginate/slurp as live-gh", () => {
    expect(classifyScmArgv("api", ["--paginate", "--slurp", "repos/o/r/issues"])).toBe("live-gh");
  });

  it("treats extra positionals as live-gh", () => {
    expect(classifyScmArgv("api", ["repos/o/r/issues/1", "nope"])).toBe("live-gh");
  });

  it("treats jq and -X as live-gh", () => {
    expect(classifyScmArgv("api", ["repos/o/r/pulls/1", "--jq", ".head.sha"])).toBe("live-gh");
    expect(classifyScmArgv("api", ["-X", "POST", "repos/o/r/issues"])).toBe("live-gh");
  });

  it("treats non-api verbs as live-gh", () => {
    expect(classifyScmArgv("pr", ["view", "1", "--json", "body"])).toBe("live-gh");
    expect(classifyScmArgv("issue", ["list"])).toBe("live-gh");
    expect(classifyScmArgv("auth", ["status"])).toBe("live-gh");
  });
});

describe("resolveBinaryForRole", () => {
  it("prefers ghx for cached-get when both are on PATH", () => {
    expect(resolveBinaryForRole("cached-get", bothPresent)).toBe("ghx");
  });

  it("pins gh for live-gh even when ghx is on PATH", () => {
    expect(resolveBinaryForRole("live-gh", bothPresent)).toBe("gh");
  });

  it("falls back to gh for cached-get when ghx is absent", () => {
    expect(resolveBinaryForRole("cached-get", ghOnly)).toBe("gh");
  });

  it("refuses live-gh when gh is absent even if ghx is present", () => {
    expect(() => resolveBinaryForRole("live-gh", ghxOnly)).toThrow(ScmStubError);
    expect(() => resolveBinaryForRole("live-gh", ghxOnly)).toThrow(/requires live gh/);
  });

  it("raises when neither binary is present", () => {
    expect(() => resolveBinaryForRole("cached-get", () => null)).toThrow(ScmStubError);
  });
});

describe("resolveBinaryForArgv", () => {
  it("routes a mutation off ghx when both binaries exist", () => {
    expect(
      resolveBinaryForArgv(
        "api",
        ["repos/o/r/issues", "--method", "POST", "--input", "payload.json"],
        bothPresent,
      ),
    ).toBe("gh");
  });

  it("routes a flag-rich GET off ghx when both binaries exist", () => {
    expect(
      resolveBinaryForArgv(
        "api",
        ["repos/o/r/issues", "--method", "GET", "--raw-field", "state=open"],
        bothPresent,
      ),
    ).toBe("gh");
  });

  it("keeps ghx for a single-path GET when both binaries exist", () => {
    expect(resolveBinaryForArgv("api", ["repos/o/r/issues/1"], bothPresent)).toBe("ghx");
  });
});
