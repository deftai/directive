import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  defaultGitRunner,
  detectBranch,
  existingAncestorDir,
  type GitRunner,
  gitCommonDir,
  gitHead,
  gitIsAncestor,
  memoizeGitRunner,
  parseGitCatFileBatch,
  showBlobsBatch,
  worktreePath,
  worktreePathOrNull,
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

  it("worktreePathOrNull returns null instead of falling back (#3794)", () => {
    expect(
      worktreePathOrNull("/tmp/project", () => ({ code: 1, stdout: "", stderr: "" })),
    ).toBeNull();
    expect(
      worktreePathOrNull("/tmp/project", () => ({ code: 0, stdout: "   ", stderr: "" })),
    ).toBeNull();
    expect(
      worktreePathOrNull("/tmp/project", () => ({ code: 0, stdout: "/tmp/wt", stderr: "" })),
    ).toBe(resolve("/tmp/wt"));
  });

  it("existingAncestorDir walks up to a real directory", () => {
    const root = mkdtempSync(join(tmpdir(), "git-ancestor-"));
    temps.push(root);
    const missing = join(root, "nested", "dir", "file.ts");
    expect(existingAncestorDir(missing)).toBe(resolve(root));
    expect(existingAncestorDir(root)).toBe(resolve(root));
    const filePath = join(root, "leaf.txt");
    writeFileSync(filePath, "x", "utf8");
    expect(existingAncestorDir(filePath)).toBe(resolve(root));
  });

  it("gitCommonDir resolves a relative .git against the worktree", () => {
    expect(gitCommonDir("/tmp/project", () => ({ code: 0, stdout: ".git", stderr: "" }))).toBe(
      resolve("/tmp/project", ".git"),
    );
    expect(
      gitCommonDir("/tmp/project", () => ({ code: 0, stdout: "/tmp/project/.git", stderr: "" })),
    ).toBe(resolve("/tmp/project/.git"));
    expect(gitCommonDir("/tmp/project", () => ({ code: 1, stdout: "", stderr: "" }))).toBeNull();
  });

  it("fuzzes existingAncestorDir over nested missing paths (#3794)", () => {
    const root = mkdtempSync(join(tmpdir(), "git-ancestor-fuzz-"));
    temps.push(root);
    for (let i = 0; i < 50; i += 1) {
      const rel = Array.from({ length: (i % 5) + 1 }, (_, j) => `d${i}-${j}`).join("/");
      const target = join(root, rel, "file.ts");
      expect(existingAncestorDir(target)).toBe(resolve(root));
    }
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

describe("memoizeGitRunner (#3736)", () => {
  const HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01";

  function recordingRunner(branch = "fix/3736-hook-latency"): {
    calls: string[][];
    runGit: GitRunner;
  } {
    const calls: string[][] = [];
    return {
      calls,
      runGit: (_root, args) => {
        calls.push([...args]);
        if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
          return { code: 0, stdout: `${HEAD_SHA}\n/tmp/project\n${branch}`, stderr: "" };
        }
        return { code: 0, stdout: "spawned", stderr: "" };
      },
    };
  }

  it("answers the three context reads from one child", () => {
    const { calls, runGit } = recordingRunner();
    const memo = memoizeGitRunner(runGit);

    expect(memo("/tmp/project", ["rev-parse", "--verify", "HEAD"]).stdout).toBe(HEAD_SHA);
    expect(memo("/tmp/project", ["rev-parse", "--show-toplevel"]).stdout).toBe("/tmp/project");
    expect(memo("/tmp/project", ["symbolic-ref", "--short", "HEAD"]).stdout).toBe(
      "fix/3736-hook-latency",
    );

    expect(calls).toEqual([["rev-parse", "HEAD", "--show-toplevel", "--abbrev-ref", "HEAD"]]);
  });

  it("does not probe context for a read the probe cannot answer", () => {
    const { calls, runGit } = recordingRunner();
    const memo = memoizeGitRunner(runGit);

    memo("/tmp/project", ["merge-base", "--is-ancestor", "old", "new"]);

    expect(calls).toEqual([["merge-base", "--is-ancestor", "old", "new"]]);
  });

  it("reports a detached head as a symbolic-ref failure without inventing a short sha", () => {
    const { calls, runGit } = recordingRunner("HEAD");
    const memo = memoizeGitRunner(runGit);

    expect(memo("/tmp/project", ["symbolic-ref", "--short", "HEAD"]).code).toBe(1);
    // Abbreviation length is repo-dependent, so the short sha stays git's answer.
    expect(memo("/tmp/project", ["rev-parse", "--short", "HEAD"]).stdout).toBe("spawned");
    expect(calls).toEqual([
      ["rev-parse", "HEAD", "--show-toplevel", "--abbrev-ref", "HEAD"],
      ["rev-parse", "--short", "HEAD"],
    ]);
  });

  it("caches per resolved project root", () => {
    const { calls, runGit } = recordingRunner();
    const memo = memoizeGitRunner(runGit);

    memo("/tmp/project", ["rev-parse", "--verify", "HEAD"]);
    memo("/tmp/other", ["rev-parse", "--verify", "HEAD"]);

    expect(calls).toHaveLength(2);
  });

  it("never caches a command that is not a ref read", () => {
    const { calls, runGit } = recordingRunner();
    const memo = memoizeGitRunner(runGit);

    memo("/tmp/project", ["fetch", "--quiet", "origin", "master"]);
    memo("/tmp/project", ["fetch", "--quiet", "origin", "master"]);

    expect(calls).toHaveLength(2);
  });

  it("falls back to individual reads when the probe fails", () => {
    const calls: string[][] = [];
    const memo = memoizeGitRunner((_root, args) => {
      calls.push([...args]);
      if (args.includes("--show-toplevel")) return { code: 128, stdout: "", stderr: "not a repo" };
      return { code: 0, stdout: "fallback", stderr: "" };
    });

    expect(memo("/tmp/project", ["rev-parse", "--verify", "HEAD"]).stdout).toBe("fallback");
    expect(memo("/tmp/project", ["symbolic-ref", "--short", "HEAD"]).stdout).toBe("fallback");
    expect(calls).toEqual([
      ["rev-parse", "HEAD", "--show-toplevel", "--abbrev-ref", "HEAD"],
      ["rev-parse", "--verify", "HEAD"],
      ["symbolic-ref", "--short", "HEAD"],
    ]);
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

describe("linked worktree git-common-dir (#3794)", () => {
  it("matches across linked worktrees and differs for a foreign repo", () => {
    const base = mkdtempSync(join(tmpdir(), "git-common-wt-"));
    temps.push(base);
    const primary = join(base, "primary");
    const wtA = join(base, "wt-a");
    const foreign = join(base, "foreign");
    mkdirSync(primary);
    execFileSync("git", ["init", "-q"], { cwd: primary });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "t"], { cwd: primary });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "base"], { cwd: primary });
    execFileSync("git", ["worktree", "add", "--detach", "-q", wtA], { cwd: primary });
    mkdirSync(foreign);
    execFileSync("git", ["init", "-q"], { cwd: foreign });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: foreign });
    execFileSync("git", ["config", "user.name", "t"], { cwd: foreign });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "base"], { cwd: foreign });

    const missing = join(wtA, "missing", "file.ts");
    const ancestor = existingAncestorDir(missing);
    expect(ancestor).toBe(resolve(wtA));
    const primaryTop = worktreePathOrNull(primary);
    const wtTop = worktreePathOrNull(ancestor ?? "");
    expect(primaryTop).not.toBeNull();
    expect(wtTop).toBe(resolve(wtA));

    const primaryCommon = gitCommonDir(primary);
    const wtCommon = gitCommonDir(wtA);
    const foreignCommon = gitCommonDir(foreign);
    expect(primaryCommon).not.toBeNull();
    expect(wtCommon).not.toBeNull();
    expect(resolve(primaryCommon ?? "")).toBe(resolve(wtCommon ?? ""));
    expect(resolve(foreignCommon ?? "")).not.toBe(resolve(primaryCommon ?? ""));
  });
});
