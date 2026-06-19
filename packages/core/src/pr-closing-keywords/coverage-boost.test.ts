import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderHit } from "./detect.js";
import { readCommitsFile } from "./io.js";
import { parseArgs, run } from "./main.js";
import type { Hit, RunGhFn } from "./types.js";

describe("coverage boost branches", () => {
  it("renderHit formats diagnostic line", () => {
    const hit: Hit = {
      source: "pr-body",
      keyword: "Closes",
      issueNumber: 1,
      context: "sample",
      reason: "negation",
    };
    expect(renderHit(hit)).toContain("Closes #1");
  });

  it("parseArgs handles = forms and --pr", () => {
    expect(parseArgs(["--pr=42", "--body-file=body.md", "--repo=org/repo"])).toMatchObject({
      pr: 42,
      bodyFile: "body.md",
      repo: "org/repo",
    });
  });

  it("parseArgs errors on bad --pr value", () => {
    expect(parseArgs(["--pr", "abc"]).error).toContain("invalid int value");
  });

  it("parseArgs errors on unknown flag", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
  });

  it("parseArgs errors on missing --pr value", () => {
    expect(parseArgs(["--pr"]).error).toContain("--pr");
  });

  it("parseArgs errors on missing flag values", () => {
    expect(parseArgs(["--body-file"]).error).toContain("--body-file");
    expect(parseArgs(["--commits-file"]).error).toContain("--commits-file");
    expect(parseArgs(["--allow-known-false-positives"]).error).toContain(
      "--allow-known-false-positives",
    );
    expect(parseArgs(["--repo"]).error).toContain("--repo");
  });

  it("parseArgs accepts equals forms for all flags", () => {
    expect(
      parseArgs([
        "--commits-file=commits.txt",
        "--allow-known-false-positives=1,2",
        "--repo=org/repo",
      ]),
    ).toMatchObject({
      commitsFile: "commits.txt",
      allowKnownFalsePositives: ["1,2"],
      repo: "org/repo",
    });
  });

  it("parseArgs errors on positional argument", () => {
    expect(parseArgs(["leftover"]).error).toContain("unrecognized");
  });

  it("run exits two when commits file read fails", () => {
    expect(run(["--commits-file", join(tmpdir(), "missing.txt")])).toBe(2);
  });

  it("run exits two when commits fetch fails in pr mode", () => {
    const runGh: RunGhFn = (cmd) => {
      if (cmd.includes("body")) {
        return { returncode: 0, stdout: JSON.stringify({ body: "" }), stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "commits fail" };
    };
    expect(run(["--pr", "1"], { runGh })).toBe(2);
  });

  it("run exits two when body fetch fails in pr mode", () => {
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "body fail" });
    expect(run(["--pr", "1"], { runGh })).toBe(2);
  });

  it("run reports parseArgs error with Error prefix", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--nope"])).toBe(2);
    expect(stderr.mock.calls.join("")).toMatch(/^Error:/);
    stderr.mockRestore();
  });

  it("run scans commits file offline", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const commits = join(dir, "commits.txt");
      writeFileSync(
        commits,
        "feat: gate land.\n\nDOES NOT CLOSE #734 (umbrella).\n--END--\n",
        "utf8",
      );
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--commits-file", commits])).toBe(1);
      expect(stderr.mock.calls.join("")).toContain("734");
      stderr.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run emits suppressed OK message", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "Intentionally not Closes #100 and not Closes #200.\n", "utf8");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--body-file", body, "--allow-known-false-positives", "100,200"])).toBe(0);
      expect(stderr.mock.calls.join("")).toContain("suppressed");
      stderr.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readCommitsFile returns null when file missing", () => {
    expect(readCommitsFile(join(tmpdir(), "missing-commits.txt"))).toBeNull();
  });
});
