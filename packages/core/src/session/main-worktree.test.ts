import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLinkedWorktreePath, isMainWorktreePath, mainWorktreeRoot } from "./main-worktree.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root, encoding: "utf8" });
  writeFileSync(join(root, "README"), "x\n", "utf8");
  execFileSync("git", ["add", "README"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" },
  });
}

describe("main worktree discriminator (#4066)", () => {
  it("treats a non-git directory as not-main so occupancy tests keep working", () => {
    const root = mkdtempSync(join(tmpdir(), "main-wt-none-"));
    temps.push(root);
    expect(isMainWorktreePath(root)).toBe(false);
    expect(isLinkedWorktreePath(root)).toBe(false);
    expect(mainWorktreeRoot(root)).toBeNull();
  });

  it("names the clone root as main and a git-worktree-add tree as linked", () => {
    const root = mkdtempSync(join(tmpdir(), "main-wt-"));
    temps.push(root);
    gitInit(root);
    expect(isMainWorktreePath(root)).toBe(true);
    expect(isLinkedWorktreePath(root)).toBe(false);
    expect(mainWorktreeRoot(root)).toBe(root);

    const linked = join(root, "linked");
    execFileSync("git", ["worktree", "add", "-q", linked, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(isMainWorktreePath(linked)).toBe(false);
    expect(isLinkedWorktreePath(linked)).toBe(true);
    expect(isMainWorktreePath(root)).toBe(true);
  });

  it("does not treat a .git file outside a real worktree as main", () => {
    const root = mkdtempSync(join(tmpdir(), "main-wt-fake-"));
    temps.push(root);
    mkdirSync(join(root, "wt"), { recursive: true });
    writeFileSync(join(root, "wt", ".git"), "gitdir: /no-such/.git/worktrees/x\n", "utf8");
    expect(isLinkedWorktreePath(join(root, "wt"))).toBe(true);
    expect(isMainWorktreePath(join(root, "wt"))).toBe(false);
  });
});
