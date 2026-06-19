import { describe, expect, it, vi } from "vitest";
import { EXIT_EXTERNAL_ERROR, EXIT_OK, EXIT_PROTECTED_LINKED } from "./constants.js";
import { defaultRunGh, fetchClosingIssuesReferences } from "./gh.js";
import { cmdPrProtectedIssues, parseArgs, run } from "./main.js";
import { parseProtected } from "./parse.js";
import type { RunGhFn } from "./types.js";

function ghPayload(...issueNumbers: number[]): string {
  return JSON.stringify({
    closingIssuesReferences: issueNumbers.map((n) => ({
      number: n,
      title: `Issue #${n}`,
      url: `https://example/issues/${n}`,
    })),
  });
}

function makeRunGh(stdout: string, returncode = 0, stderr = ""): RunGhFn {
  return () => ({ returncode, stdout, stderr });
}

describe("parseProtected", () => {
  it("parses single value", () => {
    expect(parseProtected(["167"])).toEqual([167]);
  });

  it("parses comma-separated values", () => {
    expect(parseProtected(["167,698,642"])).toEqual([167, 642, 698]);
  });

  it("aggregates repeated flags", () => {
    expect(parseProtected(["167", "698,642"])).toEqual([167, 642, 698]);
  });

  it("strips hash prefix", () => {
    expect(parseProtected(["#167,#642"])).toEqual([167, 642]);
  });

  it("deduplicates and sorts", () => {
    expect(parseProtected(["642,167,167"])).toEqual([167, 642]);
  });

  it("returns empty for empty input", () => {
    expect(parseProtected([])).toEqual([]);
  });

  it("rejects non-decimal tokens", () => {
    expect(() => parseProtected(["abc"])).toThrow("Invalid protected issue token");
  });

  it("rejects unicode superscript digit", () => {
    expect(() => parseProtected(["\u00b2"])).toThrow("Invalid protected issue token");
  });
});

describe("fetchClosingIssuesReferences", () => {
  it("returns issue numbers from well-formed payload", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = fetchClosingIssuesReferences(701, null, makeRunGh(ghPayload(701, 642)));
    expect(result).toEqual([701, 642]);
    stderr.mockRestore();
  });

  it("returns empty list when no links", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(fetchClosingIssuesReferences(123, null, makeRunGh(ghPayload()))).toEqual([]);
    stderr.mockRestore();
  });

  it("accepts string issue numbers", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const payload = JSON.stringify({ closingIssuesReferences: [{ number: "99" }] });
    expect(fetchClosingIssuesReferences(1, null, makeRunGh(payload))).toEqual([99]);
    stderr.mockRestore();
  });

  it("skips non-dict entries", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const payload = JSON.stringify({
      closingIssuesReferences: [null, "bad", { number: 5 }],
    });
    expect(fetchClosingIssuesReferences(1, null, makeRunGh(payload))).toEqual([5]);
    stderr.mockRestore();
  });

  it("returns null when gh not found", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({
      returncode: -1,
      stdout: "",
      stderr: "gh CLI not found. Install GitHub CLI.",
    });
    expect(fetchClosingIssuesReferences(1, null, runGh)).toBeNull();
    expect(stderr.mock.calls[0]?.[0]).toContain("gh CLI not found");
    stderr.mockRestore();
  });

  it("returns null when gh fails", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(fetchClosingIssuesReferences(1, null, makeRunGh("", 1, "boom"))).toBeNull();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("gh CLI failed");
    stderr.mockRestore();
  });

  it("returns null on timeout", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({ returncode: -2, stdout: "", stderr: "" });
    expect(fetchClosingIssuesReferences(42, null, runGh)).toBeNull();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("timed out fetching PR #42");
    stderr.mockRestore();
  });

  it("returns null on malformed json", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(fetchClosingIssuesReferences(1, null, makeRunGh("not-json"))).toBeNull();
    stderr.mockRestore();
  });

  it("returns null on unexpected shape", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const payload = JSON.stringify({ closingIssuesReferences: "oops" });
    expect(fetchClosingIssuesReferences(1, null, makeRunGh(payload))).toBeNull();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("unexpected closingIssuesReferences");
    stderr.mockRestore();
  });

  it("forwards --repo when supplied", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let captured: readonly string[] = [];
    const runGh: RunGhFn = (cmd) => {
      captured = cmd;
      return { returncode: 0, stdout: ghPayload(99), stderr: "" };
    };
    fetchClosingIssuesReferences(1, "o/r", runGh);
    expect(captured).toContain("--repo");
    expect(captured).toContain("o/r");
    stderr.mockRestore();
  });

  it("omits --repo when not supplied", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let captured: readonly string[] = [];
    const runGh: RunGhFn = (cmd) => {
      captured = cmd;
      return { returncode: 0, stdout: ghPayload(99), stderr: "" };
    };
    fetchClosingIssuesReferences(1, null, runGh);
    expect(captured).not.toContain("--repo");
    stderr.mockRestore();
  });
});

describe("defaultRunGh", () => {
  it("rejects non-gh commands", () => {
    expect(defaultRunGh(["git", "status"]).returncode).toBe(-1);
  });
});

describe("parseArgs", () => {
  it("parses pr number protected and repo", () => {
    expect(parseArgs(["701", "--protected", "167", "--repo", "deftai/directive"])).toEqual({
      prNumber: 701,
      protectedValues: ["167"],
      repo: "deftai/directive",
    });
  });

  it("parses --protected= and --repo= forms", () => {
    expect(parseArgs(["1", "--protected=642", "--repo=org/repo"])).toEqual({
      prNumber: 1,
      protectedValues: ["642"],
      repo: "org/repo",
    });
  });

  it("errors on missing pr number", () => {
    expect(parseArgs(["--protected", "1"]).error).toContain("required");
  });

  it("errors on invalid pr number", () => {
    expect(parseArgs(["abc"]).error).toContain("invalid");
  });

  it("errors on unknown flag", () => {
    expect(parseArgs(["1", "--nope"]).error).toContain("unrecognized");
  });

  it("errors on missing --protected value", () => {
    expect(parseArgs(["1", "--protected"]).error).toContain("--protected");
  });

  it("errors on missing --repo value", () => {
    expect(parseArgs(["1", "--repo"]).error).toContain("--repo");
  });

  it("errors on extra positional", () => {
    expect(parseArgs(["1", "2"]).error).toContain("unrecognized");
  });
});

describe("run CLI", () => {
  it("skips check when no protected issues supplied", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh = vi.fn<RunGhFn>(() => ({ returncode: 0, stdout: "", stderr: "" }));
    expect(run(["701"], { runGh })).toBe(EXIT_OK);
    expect(runGh).not.toHaveBeenCalled();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("skipping check");
    stderr.mockRestore();
  });

  it("returns OK when no overlap", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["701", "--protected", "167,698,642"], {
      runGh: makeRunGh(ghPayload(701)),
    });
    expect(code).toBe(EXIT_OK);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("OK:");
    stderr.mockRestore();
  });

  it("returns protected linked when overlap detected", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["401", "--protected", "642"], {
      runGh: makeRunGh(ghPayload(642)),
    });
    expect(code).toBe(EXIT_PROTECTED_LINKED);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("FAIL:");
    stderr.mockRestore();
  });

  it("aggregates multiple protected flags", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["701", "--protected", "642", "--protected", "167,698"], {
      runGh: makeRunGh(ghPayload(167)),
    });
    expect(code).toBe(EXIT_PROTECTED_LINKED);
    stderr.mockRestore();
  });

  it("returns external error when gh missing", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({
      returncode: -1,
      stdout: "",
      stderr: "gh CLI not found. Install GitHub CLI.",
    });
    expect(run(["701", "--protected", "167"], { runGh })).toBe(EXIT_EXTERNAL_ERROR);
    stderr.mockRestore();
  });

  it("returns external error on gh failure", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["701", "--protected", "167"], { runGh: makeRunGh("", 4, "auth") })).toBe(
      EXIT_EXTERNAL_ERROR,
    );
    stderr.mockRestore();
  });

  it("returns external error on malformed json", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["701", "--protected", "167"], { runGh: makeRunGh("not-json") })).toBe(
      EXIT_EXTERNAL_ERROR,
    );
    stderr.mockRestore();
  });

  it("returns external error on invalid protected token", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh = vi.fn<RunGhFn>(() => ({ returncode: 0, stdout: "", stderr: "" }));
    expect(run(["701", "--protected", "abc"], { runGh })).toBe(EXIT_EXTERNAL_ERROR);
    expect(runGh).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("returns external error on parse failure", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([], { runGh: makeRunGh("") })).toBe(EXIT_EXTERNAL_ERROR);
    stderr.mockRestore();
  });

  it("cmdPrProtectedIssues delegates to run", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(cmdPrProtectedIssues(["701"], { runGh: makeRunGh(ghPayload()) })).toBe(EXIT_OK);
    stderr.mockRestore();
  });
});
