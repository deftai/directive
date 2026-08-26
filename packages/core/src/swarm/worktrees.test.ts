import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TextCaptureResult } from "./subprocess.js";
import {
  BaseBranchMismatchError,
  compareKey,
  defaultGitRunner,
  parseWorktreePorcelain,
  resolveWorktreeMap,
  WorktreeCollisionError,
  WorktreeMapConfigError,
  WorktreePathEscapeError,
  WorktreeRevisionMismatchError,
} from "./worktrees.js";

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q", "-b", "master", repo], { encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@test.local"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: repo, encoding: "utf8" });
  writeFileSync(join(repo, "f.txt"), "x\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, encoding: "utf8" });
}

function headOid(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function addDetachedWorktree(repo: string, wt: string, sha: string): void {
  execFileSync("git", ["worktree", "add", "--detach", wt, sha], { cwd: repo, encoding: "utf8" });
}

function removeWorktree(repo: string, wt: string): void {
  execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo, encoding: "utf8" });
}

describe("swarm worktrees", () => {
  it("parses porcelain output", () => {
    const text =
      "worktree /repo\nHEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\nbranch refs/heads/master\n\nworktree /wt\n";
    const parsed = parseWorktreePorcelain(text);
    expect(parsed.get(compareKey(resolve("/repo")))).toEqual({
      branch: "master",
      head: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    expect(parsed.get(compareKey(resolve("/wt")))).toEqual({ branch: null, head: null });
  });

  it("rejects same-path collision", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-"));
    gitInit(repo);
    const wt = join(repo, "wt-shared");
    expect(() =>
      resolveWorktreeMap(
        [
          { story_id: "a", worktree_path: wt },
          { story_id: "b", worktree_path: wt },
        ],
        "master",
        false,
        { repoRoot: repo },
      ),
    ).toThrow(WorktreeCollisionError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects base-branch mismatch", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt2-"));
    gitInit(repo);
    const wt = join(repo, "wt-a");
    expect(() =>
      resolveWorktreeMap(
        [{ story_id: "s1", worktree_path: wt, base_branch: "develop" }],
        "master",
        false,
        {
          repoRoot: repo,
        },
      ),
    ).toThrow(BaseBranchMismatchError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("creates missing worktree idempotently", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt3-"));
    gitInit(repo);
    const wt = join(repo, "wt-new");
    const git = (args: readonly string[], cwd: string): TextCaptureResult => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      return {
        returncode: r.status ?? 1,
        stdout: typeof r.stdout === "string" ? r.stdout : "",
        stderr: typeof r.stderr === "string" ? r.stderr : "",
      };
    };
    const first = resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", true, {
      repoRoot: repo,
      git,
    });
    const second = resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", true, {
      repoRoot: repo,
      git,
    });
    expect(first).toEqual(second);
    expect(existsSync(join(wt, ".deft-scratch", "subagent-status"))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects invalid map records", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt4-"));
    gitInit(repo);
    expect(() =>
      resolveWorktreeMap("not-array" as unknown as Record<string, unknown>[], "master"),
    ).toThrow(WorktreeMapConfigError);
    expect(() => resolveWorktreeMap([], "  ", false, { repoRoot: repo })).toThrow(
      WorktreeMapConfigError,
    );
    expect(() =>
      resolveWorktreeMap([null as unknown as Record<string, unknown>], "master", false, {
        repoRoot: repo,
      }),
    ).toThrow(WorktreeMapConfigError);
    expect(() =>
      resolveWorktreeMap([{ story_id: "", worktree_path: "/x" }], "master", false, {
        repoRoot: repo,
      }),
    ).toThrow(WorktreeMapConfigError);
    expect(() =>
      resolveWorktreeMap(
        [{ story_id: "s1", worktree_path: "/x", base_branch: "develop" }],
        "master",
        false,
        { repoRoot: repo },
      ),
    ).toThrow(BaseBranchMismatchError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("parses detached and bare worktrees", () => {
    const text =
      "worktree /repo/main\nHEAD aaaabbbbccccddddeeeeffff0000111122223333\nbranch refs/heads/master\n\n" +
      "worktree /repo/detached\nHEAD abc\n\n" +
      "worktree /repo/bare\nbare\n";
    const parsed = parseWorktreePorcelain(text);
    expect(parsed.get(compareKey(resolve("/repo/main")))).toEqual({
      branch: "master",
      head: "aaaabbbbccccddddeeeeffff0000111122223333",
    });
    expect(parsed.get(compareKey(resolve("/repo/detached")))).toEqual({
      branch: null,
      head: "abc",
    });
    expect(parsed.get(compareKey(resolve("/repo/bare")))).toEqual({ branch: null, head: null });
    expect(compareKey("/Repo/Main")).toBe("/repo/main");
  });

  it("rejects absolute worktree_path values outside the repository root", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-abs-"));
    gitInit(repo);
    const outside = join(tmpdir(), "evil-wt-outside");
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: outside }], "master", false, {
        repoRoot: repo,
      }),
    ).toThrow(WorktreePathEscapeError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("rejects ..-escaping worktree_path values", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-dotdot-"));
    gitInit(repo);
    expect(() =>
      resolveWorktreeMap(
        [{ story_id: "s1", worktree_path: "../../../tmp/evil-wt" }],
        "master",
        false,
        { repoRoot: repo },
      ),
    ).toThrow(WorktreePathEscapeError);
    rmSync(repo, { recursive: true, force: true });
  });

  it.each([
    true,
    false,
  ])("hard-fails a leftover worktree at the wrong OID (createMissing=%s)", (createMissing) => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-oid-"));
    gitInit(repo);
    const sha1 = headOid(repo);
    writeFileSync(join(repo, "f.txt"), "y\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: repo, encoding: "utf8" });
    const sha2 = headOid(repo);
    expect(sha1).not.toBe(sha2);

    const wt = join(repo, "wt-stale");
    addDetachedWorktree(repo, wt, sha1);
    const posix = wt.replace(/\\/g, "/");

    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", createMissing, {
        repoRoot: repo,
      }),
    ).toThrow(WorktreeRevisionMismatchError);

    try {
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", createMissing, {
        repoRoot: repo,
      });
      expect.fail("expected WorktreeRevisionMismatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeRevisionMismatchError);
      const message = (err as Error).message;
      expect(message).toContain(posix);
      expect(message).toContain(sha1);
      expect(message).toContain(sha2);
      expect(message).toContain("snapshot check at resolution time");
      expect(message).toContain("not a pin on the worker's start revision");
    }

    expect(headOid(wt)).toBe(sha1);
    removeWorktree(repo, wt);
    rmSync(repo, { recursive: true, force: true });
  });

  it.each([
    true,
    false,
  ])("reuses a registered worktree whose HEAD OID matches the base (createMissing=%s)", (createMissing) => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-match-"));
    gitInit(repo);
    const sha = headOid(repo);
    const wt = join(repo, "wt-ok");
    addDetachedWorktree(repo, wt, sha);
    const result = resolveWorktreeMap(
      [{ story_id: "s1", worktree_path: wt }],
      "master",
      createMissing,
      { repoRoot: repo },
    );
    expect(result).toHaveLength(1);
    expect(headOid(wt)).toBe(sha);
    removeWorktree(repo, wt);
    rmSync(repo, { recursive: true, force: true });
  });

  it("hard-fails a named leftover branch at the wrong OID rather than trusting the branch label", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-br-"));
    gitInit(repo);
    const sha1 = headOid(repo);
    writeFileSync(join(repo, "f.txt"), "y\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: repo, encoding: "utf8" });
    const sha2 = headOid(repo);
    const wt = join(repo, "wt-named");
    execFileSync("git", ["worktree", "add", "-b", "leftover", wt, sha1], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", true, {
        repoRoot: repo,
      }),
    ).toThrow(WorktreeRevisionMismatchError);
    expect(headOid(wt)).toBe(sha1);
    expect(sha2).not.toBe(sha1);
    removeWorktree(repo, wt);
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails closed when the requested base cannot be resolved to an OID", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-base-"));
    gitInit(repo);
    const wt = join(repo, "wt-a");
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "no-such-ref", true, {
        repoRoot: repo,
      }),
    ).toThrow(WorktreeMapConfigError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails closed when rev-parse does not return a commit OID", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-badoid-"));
    gitInit(repo);
    const wt = join(repo, "wt-a");
    const git = (args: readonly string[], cwd: string): TextCaptureResult => {
      if (args[0] === "rev-parse") {
        return { returncode: 0, stdout: "not-an-oid\n", stderr: "" };
      }
      return defaultGitRunner(args, cwd);
    };
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", false, {
        repoRoot: repo,
        git,
      }),
    ).toThrow(WorktreeMapConfigError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails closed when rev-parse throws", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-throw-"));
    gitInit(repo);
    const wt = join(repo, "wt-a");
    const git = (args: readonly string[], cwd: string): TextCaptureResult => {
      if (args[0] === "rev-parse") {
        throw new Error("boom");
      }
      return defaultGitRunner(args, cwd);
    };
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", false, {
        repoRoot: repo,
        git,
      }),
    ).toThrow(WorktreeMapConfigError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails closed when git worktree list throws", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-listthrow-"));
    const wt = join(repo, "wt-a");
    const git = (): TextCaptureResult => {
      throw new Error("list boom");
    };
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", false, {
        repoRoot: repo,
        git,
      }),
    ).toThrow(WorktreeMapConfigError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails closed when git worktree list returns nonzero", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-listrc-"));
    const wt = join(repo, "wt-a");
    const git = (): TextCaptureResult => ({
      returncode: 1,
      stdout: "",
      stderr: "",
    });
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", false, {
        repoRoot: repo,
        git,
      }),
    ).toThrow(WorktreeMapConfigError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails closed when git worktree add throws", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-addthrow-"));
    const wt = join(repo, "wt-a");
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const git = (args: readonly string[]): TextCaptureResult => {
      if (args[0] === "worktree" && args[1] === "list") {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        throw new Error("add boom");
      }
      return { returncode: 1, stdout: "", stderr: "unhandled" };
    };
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", true, {
        repoRoot: repo,
        git,
      }),
    ).toThrow(WorktreeMapConfigError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("fails closed when git worktree add returns nonzero", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-addrc-"));
    const wt = join(repo, "wt-a");
    const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const git = (args: readonly string[]): TextCaptureResult => {
      if (args[0] === "worktree" && args[1] === "list") {
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { returncode: 0, stdout: `${sha}\n`, stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        return { returncode: 1, stdout: "", stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "unhandled" };
    };
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", true, {
        repoRoot: repo,
        git,
      }),
    ).toThrow(WorktreeMapConfigError);
    rmSync(repo, { recursive: true, force: true });
  });

  it("hard-fails a registered path with no porcelain HEAD OID", () => {
    const repo = mkdtempSync(join(tmpdir(), "sw-wt-nohead-"));
    gitInit(repo);
    const sha = headOid(repo);
    const wt = join(repo, "wt-bareish");
    const posix = wt.replace(/\\/g, "/");
    const git = (args: readonly string[], cwd: string): TextCaptureResult => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          returncode: 0,
          stdout: `worktree ${repo}\nHEAD ${sha}\nbranch refs/heads/master\n\nworktree ${wt}\nbare\n`,
          stderr: "",
        };
      }
      return defaultGitRunner(args, cwd);
    };
    expect(() =>
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", true, {
        repoRoot: repo,
        git,
      }),
    ).toThrow(WorktreeRevisionMismatchError);
    try {
      resolveWorktreeMap([{ story_id: "s1", worktree_path: wt }], "master", false, {
        repoRoot: repo,
        git,
      });
      expect.fail("expected WorktreeRevisionMismatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeRevisionMismatchError);
      expect((err as Error).message).toContain(posix);
      expect((err as Error).message).toContain(sha);
      expect((err as Error).message).toContain("(missing)");
    }
    rmSync(repo, { recursive: true, force: true });
  });
});
