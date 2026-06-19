import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TextCaptureResult } from "./subprocess.js";
import {
  BaseBranchMismatchError,
  compareKey,
  parseWorktreePorcelain,
  resolveWorktreeMap,
  WorktreeCollisionError,
  WorktreeMapConfigError,
} from "./worktrees.js";

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q", "-b", "master", repo], { encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@test.local"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: repo, encoding: "utf8" });
  writeFileSync(join(repo, "f.txt"), "x\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, encoding: "utf8" });
}

describe("swarm worktrees", () => {
  it("parses porcelain output", () => {
    const text = "worktree /repo\nbranch refs/heads/master\n\nworktree /wt\n";
    const parsed = parseWorktreePorcelain(text);
    expect(parsed.get(compareKey("/repo"))).toBe("master");
    expect(parsed.get(compareKey("/wt"))).toBeNull();
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
      "worktree /repo/main\nbranch refs/heads/master\n\n" +
      "worktree /repo/detached\nHEAD abc\n\n" +
      "worktree /repo/bare\nbare\n";
    const parsed = parseWorktreePorcelain(text);
    expect(parsed.size).toBeGreaterThan(0);
    expect(compareKey("/Repo/Main")).toBe("/repo/main");
  });
});
