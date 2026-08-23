import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
        mkdirSync(String(args[3]), { recursive: true });
        return { returncode: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "remove") {
        rmSync(String(args[3]), { recursive: true, force: true });
        return { returncode: 0, stdout: "", stderr: "" };
      }
      return { returncode: 0, stdout: "", stderr: "" };
    };
    const path = addEvaluatorWorktree(root, 3, "inv", git);
    expect(existsSync(path)).toBe(true);
    removeEvaluatorWorktree(root, path, git);
    expect(existsSync(path)).toBe(false);
  });

  it("raises when git worktree add fails", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-"));
    temps.push(root);
    const git: GitRunner = () => ({ returncode: 1, stdout: "", stderr: "denied" });
    expect(() => addEvaluatorWorktree(root, 3, "inv", git)).toThrow(EvaluatorWorktreeError);
  });
});
