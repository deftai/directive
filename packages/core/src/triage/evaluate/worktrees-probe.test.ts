import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGitRunner as swarmGitRunner } from "../../swarm/worktrees.js";
import type { GitRunner } from "./types.js";

vi.mock("../../fs/contained-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../fs/contained-write.js")>();
  return {
    ...actual,
    containedWrite: () => {
      throw new Error("probe denied");
    },
  };
});

const { removeEvaluatorWorktree } = await import("./worktrees.js");

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function hostsCaseDistinctNames(dir: string): boolean {
  if (process.platform === "win32") {
    try {
      execFileSync("fsutil.exe", ["file", "setCaseSensitiveInfo", dir, "enable"], {
        stdio: "pipe",
      });
    } catch {
      // Probe below.
    }
  }
  const a = join(dir, "CaseProbeA");
  const b = join(dir, "caseprobea");
  mkdirSync(a);
  try {
    mkdirSync(b);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    return true;
  } catch {
    rmSync(a, { recursive: true, force: true });
    return false;
  }
}

describe("evaluator worktree probe failure", () => {
  it("does not fold case when the sensitivity probe cannot write", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-probe-"));
    temps.push(root);
    if (!hostsCaseDistinctNames(root)) {
      return;
    }
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
    const wtTarget = join(root, "Wt-Eval");
    const wtSibling = join(root, "wt-eval");
    mkdirSync(wtTarget);
    mkdirSync(wtSibling);
    const worktreesDir = join(root, ".git", "worktrees");
    mkdirSync(join(worktreesDir, "aaa"), { recursive: true });
    mkdirSync(join(worktreesDir, "zzz"), { recursive: true });
    writeFileSync(join(worktreesDir, "aaa", "gitdir"), `${wtSibling.replace(/\\/g, "/")}/.git\n`);
    writeFileSync(join(worktreesDir, "zzz", "gitdir"), `${wtTarget.replace(/\\/g, "/")}/.git\n`);
    const git: GitRunner = (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "prune") {
        throw new Error("unscoped git worktree prune must not run");
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return { returncode: 1, stdout: "", stderr: "locked" };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { returncode: 0, stdout: `worktree ${wtSibling}\n`, stderr: "" };
      }
      return swarmGitRunner(args, cwd);
    };
    removeEvaluatorWorktree(root, wtTarget, git);
    expect(existsSync(join(worktreesDir, "aaa"))).toBe(true);
    expect(existsSync(join(worktreesDir, "zzz"))).toBe(false);
  });
});
