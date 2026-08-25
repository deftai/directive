import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  defaultGitRunner,
  detectBranch,
  gitHead,
  gitIsAncestor,
  parseGitCatFileBatch,
  showBlobsBatch,
  worktreePath,
} from "./git.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

describe("session git helpers", () => {
  it("gitHead returns error when git missing", () => {
    const result = gitHead("/tmp", () => ({ code: 127, stdout: "", stderr: "missing" }));
    expect(result.head).toBeNull();
    expect(result.error).toBe("missing");
  });

  it("worktreePath falls back to project root", () => {
    expect(worktreePath("/tmp/project", () => ({ code: 1, stdout: "", stderr: "" }))).toContain(
      "project",
    );
  });

  it("detectBranch uses detached sha fallback", () => {
    const branch = detectBranch("/tmp", (_r, args) => {
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--short") {
        return { code: 0, stdout: "abc1234", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    });
    expect(branch).toBe("detached:abc1234");
  });

  it("detectBranch returns null when git unavailable", () => {
    expect(detectBranch("/tmp", () => ({ code: 127, stdout: "", stderr: "" }))).toBeNull();
  });

  it("gitIsAncestor handles equal shas and git exit codes", () => {
    expect(gitIsAncestor("/tmp", "abc", "abc")).toBe(true);
    expect(gitIsAncestor("/tmp", "old", "new", () => ({ code: 0, stdout: "", stderr: "" }))).toBe(
      true,
    );
    expect(gitIsAncestor("/tmp", "old", "new", () => ({ code: 1, stdout: "", stderr: "" }))).toBe(
      false,
    );
    expect(
      gitIsAncestor("/tmp", "old", "new", () => ({ code: 128, stdout: "", stderr: "bad" })),
    ).toBeNull();
  });
});

describe("parseGitCatFileBatch (#3673)", () => {
  it("returns bodies in request order and null for missing objects", () => {
    const first = Buffer.from("hello", "utf8");
    const second = Buffer.from('{"ok":true}', "utf8");
    const stdout = Buffer.concat([
      Buffer.from(`aaaaaaaa blob ${first.length}\n`),
      first,
      Buffer.from("\n"),
      Buffer.from("HEAD:missing.json missing\n"),
      Buffer.from(`bbbbbbbb blob ${second.length}\n`),
      second,
      Buffer.from("\n"),
    ]);
    const parsed = parseGitCatFileBatch(stdout, ["a.json", "missing.json", "b.json"]);
    expect(parsed).not.toBeNull();
    expect(parsed?.get("a.json")).toBe("hello");
    expect(parsed?.get("missing.json")).toBeNull();
    expect(parsed?.get("b.json")).toBe('{"ok":true}');
  });

  it("returns null when the stream is truncated", () => {
    const stdout = Buffer.from("aaaaaaaa blob 12\nshort\n");
    expect(parseGitCatFileBatch(stdout, ["a.json"])).toBeNull();
  });

  it("treats ambiguous objects as missing and rejects a bad header", () => {
    const ambiguous = Buffer.from("HEAD:dup.json ambiguous\n");
    const parsed = parseGitCatFileBatch(ambiguous, ["dup.json"]);
    expect(parsed?.get("dup.json")).toBeNull();
    expect(parseGitCatFileBatch(Buffer.from("not-a-header\n"), ["a.json"])).toBeNull();
  });
});

describe("showBlobsBatch (#3673)", () => {
  it("reads multiple blobs in one cat-file process", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cat-file-batch-"));
    temps.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "one.json"), '{"n":1}\n', "utf8");
    writeFileSync(join(root, "two.json"), '{"n":2}\n', "utf8");
    execFileSync("git", ["add", "one.json", "two.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "blobs"], { cwd: root, stdio: "ignore" });

    const showCalls: string[][] = [];
    const runGit = (cwd: string, args: readonly string[]) => {
      if (args[0] === "show") {
        showCalls.push([...args]);
      }
      return defaultGitRunner(cwd, args);
    };
    const bodies = showBlobsBatch(root, "HEAD", ["one.json", "two.json", "absent.json"], runGit);
    expect(showCalls).toEqual([]);
    expect(bodies.get("one.json")).toContain('"n":1');
    expect(bodies.get("two.json")).toContain('"n":2');
    expect(bodies.get("absent.json")).toBeNull();
  });

  it("returns an empty map for an empty path list", () => {
    expect(showBlobsBatch("/tmp", "HEAD", [])).toEqual(new Map());
  });

  it("falls back to git show when cat-file batch cannot run", () => {
    const calls: string[][] = [];
    const bodies = showBlobsBatch(
      "/definitely-not-a-git-repo-3673",
      "HEAD",
      ["a.json"],
      (_cwd, args) => {
        calls.push([...args]);
        return { code: 1, stdout: "", stderr: "fail" };
      },
    );
    expect(calls).toEqual([["show", "HEAD:a.json"]]);
    expect(bodies.get("a.json")).toBeNull();
  });
});
