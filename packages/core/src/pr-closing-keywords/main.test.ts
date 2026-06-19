import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EXIT_CONFIG_ERROR, EXIT_HITS_FOUND, EXIT_OK } from "./constants.js";
import { cmdPrCheckClosingKeywords, parseAllowList, parseArgs, run } from "./main.js";
import type { RunGhFn } from "./types.js";

describe("parseAllowList", () => {
  it("parses comma-separated and hash-prefixed tokens", () => {
    expect(parseAllowList(["100,200", "#300"])).toEqual(new Set([100, 200, 300]));
  });

  it("throws on invalid token", () => {
    expect(() => parseAllowList(["abc"])).toThrow(/Invalid issue number/);
  });
});

describe("parseArgs", () => {
  it("parses offline flags", () => {
    expect(
      parseArgs([
        "--body-file",
        "body.md",
        "--commits-file",
        "commits.txt",
        "--allow-known-false-positives",
        "1,2",
        "--repo",
        "deftai/directive",
      ]),
    ).toMatchObject({
      bodyFile: "body.md",
      commitsFile: "commits.txt",
      repo: "deftai/directive",
      allowKnownFalsePositives: ["1,2"],
    });
  });

  it("errors on missing input source at run time", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([])).toBe(EXIT_CONFIG_ERROR);
    expect(stderr.mock.calls.join("")).toContain("must specify --pr OR");
    stderr.mockRestore();
  });
});

describe("run CLI offline", () => {
  it("exits zero for clean body", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: lint introduction.\n\nCloses #1234\n", "utf8");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--body-file", body])).toBe(EXIT_OK);
      stderr.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits one for negation hit", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: gate.\n\nDOES NOT CLOSE #734 (umbrella).\n", "utf8");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--body-file", body])).toBe(EXIT_HITS_FOUND);
      expect(stderr.mock.calls.join("")).toContain("FAIL:");
      stderr.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits two for invalid allow token", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "clean body", "utf8");
      expect(run(["--body-file", body, "--allow-known-false-positives", "abc"])).toBe(
        EXIT_CONFIG_ERROR,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits two for missing body file", () => {
    expect(run(["--body-file", join(tmpdir(), "does-not-exist.md")])).toBe(EXIT_CONFIG_ERROR);
  });

  it("allow list suppresses hits", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "Body. Intentionally not `Closes #999` (test fixture).\n", "utf8");
      expect(run(["--body-file", body])).toBe(EXIT_HITS_FOUND);
      expect(run(["--body-file", body, "--allow-known-false-positives", "999"])).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cmdPrCheckClosingKeywords delegates to run", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "Refs #642 only.", "utf8");
      expect(cmdPrCheckClosingKeywords(["--body-file", body])).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run CLI --pr mode", () => {
  it("calls gh for body and commits", () => {
    const calls: string[][] = [];
    const runGh: RunGhFn = (cmd) => {
      calls.push([...cmd]);
      if (cmd.includes("body")) {
        return { returncode: 0, stdout: JSON.stringify({ body: "Refs #642 only." }), stderr: "" };
      }
      if (cmd.includes("commits")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            commits: [{ messageHeadline: "feat: implement", messageBody: "Closes #1\n" }],
          }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    expect(run(["--pr", "735"], { runGh })).toBe(EXIT_OK);
    expect(calls.some((c) => c.includes("body"))).toBe(true);
    expect(calls.some((c) => c.includes("commits"))).toBe(true);
  });

  it("finds negation hit from pr body", () => {
    const runGh: RunGhFn = (cmd) => {
      if (cmd.includes("body")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            body: "Body header. Intentionally NOT using `Closes #642` because umbrella.",
          }),
          stderr: "",
        };
      }
      return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--pr", "735"], { runGh })).toBe(EXIT_HITS_FOUND);
    expect(stderr.mock.calls.join("")).toContain("642");
    stderr.mockRestore();
  });

  it("exits two when gh fails", () => {
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "permission denied" });
    expect(run(["--pr", "735"], { runGh })).toBe(EXIT_CONFIG_ERROR);
  });

  it("exits two when gh missing", () => {
    const runGh: RunGhFn = () => ({
      returncode: -1,
      stdout: "",
      stderr: "gh CLI not found. Install GitHub CLI.",
    });
    expect(run(["--pr", "735"], { runGh })).toBe(EXIT_CONFIG_ERROR);
  });
});
