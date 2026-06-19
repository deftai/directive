import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import * as ghModule from "./gh.js";
import { defaultRunGh, fetchClosingIssuesReferences } from "./gh.js";
import { run } from "./main.js";
import * as parseModule from "./parse.js";
import { parseProtected } from "./parse.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

vi.mock("../scm/binary.js", () => ({
  resolveBinary: () => "gh",
}));

describe("coverage boost branches", () => {
  it("defaultRunGh handles ENOENT", () => {
    const err = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    const result = defaultRunGh(["gh", "pr", "view", "1", "--json", "closingIssuesReferences"]);
    expect(result.stderr).toContain("gh CLI not found");
    expect(result.returncode).toBe(-1);
  });

  it("defaultRunGh handles ETIMEDOUT", () => {
    const err = new Error("timeout") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    const result = defaultRunGh(["gh", "pr", "view", "1", "--json", "closingIssuesReferences"]);
    expect(result.returncode).toBe(-2);
  });

  it("defaultRunGh maps non-zero exit with stderr", () => {
    const err = Object.assign(new Error("failed"), {
      status: 4,
      stdout: "",
      stderr: "auth required",
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    const result = defaultRunGh(["gh", "pr", "view", "1"]);
    expect(result.returncode).toBe(4);
    expect(result.stderr).toContain("auth required");
  });

  it("fetchClosingIssuesReferences handles thrown runGh", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh = () => {
      throw new Error("boom");
    };
    expect(fetchClosingIssuesReferences(1, null, runGh)).toBeNull();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("gh CLI not found");
    stderr.mockRestore();
  });

  it("fetchClosingIssuesReferences handles null closingIssuesReferences", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const payload = JSON.stringify({ closingIssuesReferences: null });
    const result = fetchClosingIssuesReferences(1, null, () => ({
      returncode: 0,
      stdout: payload,
      stderr: "",
    }));
    expect(result).toBeNull();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("got null");
    stderr.mockRestore();
  });

  it("fetchClosingIssuesReferences skips non-integer number values", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const payload = JSON.stringify({
      closingIssuesReferences: [{ number: 1.5 }, { number: "abc" }],
    });
    expect(
      fetchClosingIssuesReferences(1, null, () => ({
        returncode: 0,
        stdout: payload,
        stderr: "",
      })),
    ).toEqual([]);
    stderr.mockRestore();
  });

  it("parseProtected skips empty comma tokens", () => {
    expect(parseProtected([",167", "642,"])).toEqual([167, 642]);
  });

  it("run uses defaultRunGh when runGh option omitted", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchSpy = vi
      .spyOn(ghModule, "fetchClosingIssuesReferences")
      .mockImplementation((_pr, _repo, runGh) => {
        expect(runGh).toBe(ghModule.defaultRunGh);
        return [701];
      });
    expect(run(["701", "--protected", "167,698,642"])).toBe(0);
    fetchSpy.mockRestore();
    stderr.mockRestore();
  });

  it("run handles non-Error from parseProtected", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(parseModule, "parseProtected").mockImplementation(() => {
      throw "bad-token";
    });
    expect(run(["701", "--protected", "1"])).toBe(2);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("bad-token");
    stderr.mockRestore();
    vi.restoreAllMocks();
  });

  it("run parseArgs error uses Error prefix", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--protected", "1"])).toBe(2);
    stderr.mockRestore();
  });

  it("fetchClosingIssuesReferences parse error with non-Error throw", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalParse = JSON.parse;
    JSON.parse = () => {
      throw "not-json";
    };
    try {
      expect(
        fetchClosingIssuesReferences(5, null, () => ({
          returncode: 0,
          stdout: "{",
          stderr: "",
        })),
      ).toBeNull();
      expect(String(stderr.mock.calls[0]?.[0])).toContain("not-json");
    } finally {
      JSON.parse = originalParse;
      stderr.mockRestore();
    }
  });
});
