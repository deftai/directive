import { describe, expect, it, vi } from "vitest";
import {
  defaultRunGh,
  fetchPrBody,
  fetchPrCommitMessages,
  fetchPrMergeBaseSha,
  fetchRepoFileAtRef,
} from "./gh.js";
import type { RunGhFn } from "./types.js";

describe("fetchPrBody", () => {
  it("returns empty string for null body", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ body: null }),
      stderr: "",
    });
    expect(fetchPrBody(1, "deftai/directive", runGh)).toBe("");
  });

  it("logs gh failure", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "nope" });
    expect(fetchPrBody(9, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("failed fetching PR #9");
    stderr.mockRestore();
  });

  it("logs parse failure", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "not-json", stderr: "" });
    expect(fetchPrBody(1, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("failed to parse gh CLI output");
    stderr.mockRestore();
  });

  it("logs unexpected body shape", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ body: 123 }),
      stderr: "",
    });
    expect(fetchPrBody(1, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("unexpected body shape");
    stderr.mockRestore();
  });

  it("logs timeout", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({ returncode: -1, stdout: "", stderr: "gh CLI timed out" });
    expect(fetchPrBody(5, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("timed out fetching PR #5");
    stderr.mockRestore();
  });

  it("logs gh not found", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({
      returncode: -1,
      stdout: "",
      stderr: "gh CLI not found. Install GitHub CLI.",
    });
    expect(fetchPrBody(1, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("gh CLI not found");
    stderr.mockRestore();
  });
});

describe("fetchPrCommitMessages", () => {
  it("skips non-dict commit entries", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({
        commits: ["bad", { messageHeadline: "x", messageBody: "y" }, null],
      }),
      stderr: "",
    });
    expect(fetchPrCommitMessages(1, null, runGh)).toEqual(["x\ny"]);
  });

  it("logs unexpected commits shape", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ commits: "nope" }),
      stderr: "",
    });
    expect(fetchPrCommitMessages(1, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("unexpected commits shape");
    stderr.mockRestore();
  });

  it("logs commits fetch failure", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "denied" });
    expect(fetchPrCommitMessages(3, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("failed fetching commits");
    stderr.mockRestore();
  });

  it("logs commits timeout", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({ returncode: -1, stdout: "", stderr: "timed out" });
    expect(fetchPrCommitMessages(7, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("timed out fetching commits for PR #7");
    stderr.mockRestore();
  });

  it("logs unexpected JSON root for body fetch", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "[]", stderr: "" });
    expect(fetchPrBody(1, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("unexpected shape");
    stderr.mockRestore();
  });

  it("passes repo flag to gh pr view body", () => {
    const calls: string[][] = [];
    const runGh: RunGhFn = (cmd) => {
      calls.push([...cmd]);
      return { returncode: 0, stdout: JSON.stringify({ body: "" }), stderr: "" };
    };
    expect(fetchPrBody(5, "deftai/directive", runGh)).toBe("");
    expect(calls[0]).toContain("--repo");
    expect(calls[0]).toContain("deftai/directive");
  });

  it("logs gh not found for commits fetch", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({
      returncode: -1,
      stdout: "",
      stderr: "gh CLI not found. Install GitHub CLI.",
    });
    expect(fetchPrCommitMessages(1, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("gh CLI not found");
    stderr.mockRestore();
  });

  it("logs unexpected JSON root for commits fetch", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: "null", stderr: "" });
    expect(fetchPrCommitMessages(1, null, runGh)).toBeNull();
    expect(stderr.mock.calls.join("")).toContain("unexpected shape");
    stderr.mockRestore();
  });

  it("passes repo flag to gh pr view commits", () => {
    const calls: string[][] = [];
    const runGh: RunGhFn = (cmd) => {
      calls.push([...cmd]);
      return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
    };
    expect(fetchPrCommitMessages(5, "deftai/directive", runGh)).toEqual([]);
    expect(calls[0]).toContain("--repo");
  });
});

describe("defaultRunGh", () => {
  it("rejects empty cmd", () => {
    expect(defaultRunGh([]).stderr).toContain("expected gh");
  });

  it("rejects non-gh cmd", () => {
    expect(defaultRunGh(["git", "status"]).stderr).toContain("expected gh");
  });

  it("invokes gh when available", () => {
    const result = defaultRunGh(["gh", "version"]);
    if (result.returncode === -1 && result.stderr.includes("not found")) {
      return;
    }
    expect(result.returncode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

describe("fetchPrMergeBaseSha (#6316)", () => {
  const BASE = "a".repeat(40);
  const HEAD = "b".repeat(40);
  const MB = "c".repeat(40);

  function ghWith(responses: Record<string, { returncode: number; stdout: string }>): RunGhFn {
    return (cmd) => {
      const path = cmd[2] ?? "";
      const hit = Object.entries(responses).find(([key]) => path.includes(key));
      return hit === undefined
        ? { returncode: 1, stdout: "", stderr: "unexpected" }
        : { ...hit[1], stderr: "" };
    };
  }

  it("reads base/head from pulls then merge_base_commit from compare", () => {
    const calls: string[] = [];
    const inner = ghWith({
      "/pulls/7": {
        returncode: 0,
        stdout: JSON.stringify({ base: { sha: BASE }, head: { sha: HEAD } }),
      },
      "/compare/": { returncode: 0, stdout: JSON.stringify({ merge_base_commit: { sha: MB } }) },
    });
    const runGh: RunGhFn = (cmd) => {
      calls.push(cmd.join(" "));
      return inner(cmd);
    };
    expect(fetchPrMergeBaseSha(7, "deftai/directive", runGh)).toBe(MB);
    expect(calls[1]).toContain(`repos/deftai/directive/compare/${BASE}...${HEAD}`);
  });

  it("returns null on a failed or malformed read", () => {
    expect(fetchPrMergeBaseSha(7, "o/r", ghWith({}))).toBeNull();
    expect(
      fetchPrMergeBaseSha(7, "o/r", ghWith({ "/pulls/7": { returncode: 0, stdout: "nope" } })),
    ).toBeNull();
    expect(
      fetchPrMergeBaseSha(
        7,
        "o/r",
        ghWith({ "/pulls/7": { returncode: 0, stdout: JSON.stringify({ base: { sha: BASE } }) } }),
      ),
    ).toBeNull();
    expect(
      fetchPrMergeBaseSha(
        7,
        "o/r",
        ghWith({
          "/pulls/7": {
            returncode: 0,
            stdout: JSON.stringify({ base: { sha: BASE }, head: { sha: HEAD } }),
          },
        }),
      ),
    ).toBeNull();
    expect(
      fetchPrMergeBaseSha(
        7,
        "o/r",
        ghWith({
          "/pulls/7": {
            returncode: 0,
            stdout: JSON.stringify({ base: { sha: BASE }, head: { sha: HEAD } }),
          },
          "/compare/": { returncode: 0, stdout: JSON.stringify({ merge_base_commit: null }) },
        }),
      ),
    ).toBeNull();
  });
});

describe("fetchRepoFileAtRef (#6316)", () => {
  it("decodes a base64 file at the ref", () => {
    let seen = "";
    const runGh: RunGhFn = (cmd) => {
      seen = cmd[2] ?? "";
      return {
        returncode: 0,
        stdout: JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from('{"plan":{}}', "utf8").toString("base64"),
        }),
        stderr: "",
      };
    };
    expect(fetchRepoFileAtRef("o/r", "xbrief\\active\\a b.json", "abc", runGh)).toEqual({
      kind: "ok",
      text: '{"plan":{}}',
    });
    expect(seen).toBe("repos/o/r/contents/xbrief/active/a%20b.json?ref=abc");
  });

  it("maps HTTP 404 to absent and other failures to error", () => {
    expect(
      fetchRepoFileAtRef("o/r", "x.json", "abc", () => ({
        returncode: 1,
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)",
      })),
    ).toEqual({ kind: "absent" });
    expect(
      fetchRepoFileAtRef("o/r", "x.json", "abc", () => ({
        returncode: 1,
        stdout: "",
        stderr: "HTTP 502",
      })).kind,
    ).toBe("error");
    expect(
      fetchRepoFileAtRef("o/r", "x.json", "abc", () => ({
        returncode: 0,
        stdout: "[]",
        stderr: "",
      })).kind,
    ).toBe("error");
    expect(
      fetchRepoFileAtRef("o/r", "x.json", "abc", () => ({
        returncode: 0,
        stdout: JSON.stringify({ type: "dir" }),
        stderr: "",
      })).kind,
    ).toBe("error");
  });
});
