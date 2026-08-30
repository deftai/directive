import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitRunner as swarmGitRunner } from "../../swarm/worktrees.js";
import type { GitRunner } from "./types.js";
import {
  addEvaluatorWorktree,
  EvaluatorWorktreeError,
  removeEvaluatorWorktree,
} from "./worktrees.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("evaluator worktrees", () => {
  it("adds then force-removes a detached worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-"));
    temps.push(root);
    const git: GitRunner = (args) => {
      if (args[1] === "add") {
        expect(args[4]).toBe("abc123def456aaaaaaaa");
        expect(args).not.toContain("origin/master");
        mkdirSync(String(args[3]), { recursive: true });
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "remove") {
        rmSync(String(args[3]), { recursive: true, force: true });
        return { returncode: 0, stdout: "", stderr: "" };
      }
      return { returncode: 0, stdout: "", stderr: "" };
    };
    const path = addEvaluatorWorktree(root, 3, "inv", "abc123def456aaaaaaaa", git);
    expect(existsSync(path)).toBe(true);
    removeEvaluatorWorktree(root, path, git);
    expect(existsSync(path)).toBe(false);
  });

  it("falls back to directory delete without unscoped prune when force-remove fails", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-"));
    temps.push(root);
    let removes = 0;
    const git: GitRunner = (args) => {
      if (args[1] === "add") {
        mkdirSync(String(args[3]), { recursive: true });
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "remove") {
        removes += 1;
        if (removes === 1) {
          return { returncode: 1, stdout: "", stderr: "locked" };
        }
        rmSync(String(args[3]), { recursive: true, force: true });
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "prune") {
        throw new Error("unscoped git worktree prune must not run");
      }
      return { returncode: 0, stdout: "", stderr: "" };
    };
    const path = addEvaluatorWorktree(root, 3, "inv", "abc123def456aaaaaaaa", git);
    expect(existsSync(path)).toBe(true);
    removeEvaluatorWorktree(root, path, git);
    expect(existsSync(path)).toBe(false);
    expect(removes).toBe(2);
  });

  it("does not unregister a second worktree when removing the first fails", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-live-"));
    temps.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@t.local",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t.local",
      },
    });
    const wtA = join(root, "wt-a");
    const wtB = join(root, "wt-b");
    execFileSync("git", ["worktree", "add", "--detach", wtA], { cwd: root });
    execFileSync("git", ["worktree", "add", "--detach", wtB], { cwd: root });
    rmSync(wtB, { recursive: true, force: true });
    let removes = 0;
    const git: GitRunner = (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "prune") {
        throw new Error("unscoped git worktree prune must not run");
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removes += 1;
        if (removes === 1) {
          return { returncode: 1, stdout: "", stderr: "locked" };
        }
      }
      return swarmGitRunner(args, cwd);
    };
    removeEvaluatorWorktree(root, wtA, git);
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    });
    const needle = resolve(wtB).replace(/\\/g, "/").toLowerCase();
    const listedNorm = listed.replace(/\\/g, "/").toLowerCase();
    expect(listedNorm).toContain(needle);
    expect(existsSync(wtA)).toBe(false);
  });

  it("cleans a failed removal from a linked worktree without unregistering a sibling", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-link-"));
    temps.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@t.local",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t.local",
      },
    });
    const linked = join(root, "linked");
    execFileSync("git", ["worktree", "add", "--detach", linked], { cwd: root });
    const wtA = join(root, "wt-a");
    const wtB = join(root, "wt-b");
    execFileSync("git", ["worktree", "add", "--detach", wtA], { cwd: linked });
    execFileSync("git", ["worktree", "add", "--detach", wtB], { cwd: linked });
    rmSync(wtB, { recursive: true, force: true });
    let removes = 0;
    const git: GitRunner = (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "prune") {
        throw new Error("unscoped git worktree prune must not run");
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removes += 1;
        if (removes === 1) {
          return { returncode: 1, stdout: "", stderr: "locked" };
        }
      }
      return swarmGitRunner(args, cwd);
    };
    removeEvaluatorWorktree(linked, wtA, git);
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: linked,
      encoding: "utf8",
    });
    const listedNeedle = resolve(wtB).replace(/\\/g, "/").toLowerCase();
    const listedNorm = listed.replace(/\\/g, "/").toLowerCase();
    expect(listedNorm).toContain(listedNeedle);
    expect(existsSync(wtA)).toBe(false);
  });

  it("raises when fallback prune still leaves a registered worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-"));
    temps.push(root);
    const git: GitRunner = (args) => {
      if (args[1] === "add") {
        mkdirSync(String(args[3]), { recursive: true });
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "remove") {
        return { returncode: 1, stdout: "", stderr: "locked" };
      }
      if (args[1] === "list") {
        const listed = join(root, ".deft-scratch", "worktrees", "issue-eval-3-inv");
        return { returncode: 0, stdout: `worktree ${listed}\n`, stderr: "" };
      }
      return { returncode: 0, stdout: "", stderr: "" };
    };
    const path = addEvaluatorWorktree(root, 3, "inv", "abc123def456aaaaaaaa", git);
    expect(() => removeEvaluatorWorktree(root, path, git)).toThrow(EvaluatorWorktreeError);
  });

  it("raises when git worktree add fails", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-"));
    temps.push(root);
    const git: GitRunner = () => ({ returncode: 1, stdout: "", stderr: "denied" });
    expect(() => addEvaluatorWorktree(root, 3, "inv", "abc123", git)).toThrow(
      EvaluatorWorktreeError,
    );
  });
});
