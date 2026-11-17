/**
 * #6337: the setup repair path (self-complete → runSetup → ensureSlashCommands →
 * ensureManagedPathGitattributes) leaves `.gitattributes` alone in a linked
 * worktree of the framework source repository; a consumer still gets the pins.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFT_REPO_POSITIVE_MARKERS } from "@deftai/directive-core/doctor";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.js";
import { ensureManagedPathGitattributes } from "./setup-wiring.js";

const TEMPS: string[] = [];

afterEach(() => {
  for (const dir of TEMPS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMPS.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

/** Committed repository with a tracked .gitattributes; framework markers when asked. */
function committedRepo(prefix: string, framework: boolean): string {
  const root = temp(prefix);
  write(root, ".gitattributes", "* text=auto\n");
  if (framework) {
    write(root, "main.md", "# main\n");
    for (const marker of DEFT_REPO_POSITIVE_MARKERS) {
      write(root, marker, "marker\n");
    }
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  return root;
}

function linkedFrameworkWorktree(): string {
  const primary = committedRepo("deft-6337-setup-primary-", true);
  const worktree = join(temp("deft-6337-setup-wt-"), "linked");
  git(primary, ["worktree", "add", "--detach", "-q", worktree]);
  return worktree;
}

describe("setup repair path in a framework source worktree (#6337)", () => {
  it("ensureManagedPathGitattributes writes nothing in a linked worktree", () => {
    const worktree = linkedFrameworkWorktree();
    const before = readFileSync(join(worktree, ".gitattributes"), "utf8");

    expect(ensureManagedPathGitattributes(worktree)).toEqual({
      created: false,
      modified: false,
      wrote: false,
    });
    expect(readFileSync(join(worktree, ".gitattributes"), "utf8")).toBe(before);
  });

  it("runSetup repair leaves .gitattributes unchanged in a linked worktree", () => {
    const worktree = linkedFrameworkWorktree();
    const before = readFileSync(join(worktree, ".gitattributes"), "utf8");

    const result = runSetup({ operation: "repair", from: "0.0.0", root: worktree });

    expect(readFileSync(join(worktree, ".gitattributes"), "utf8")).toBe(before);
    expect(git(worktree, ["status", "--porcelain", "--", ".gitattributes"])).toBe("");
    expect(JSON.stringify(result)).not.toContain(".gitattributes");
  });

  it("a consumer repository still gets the managed-path pins", () => {
    const consumer = committedRepo("deft-6337-setup-consumer-", false);

    const out = ensureManagedPathGitattributes(consumer);

    expect(out.wrote).toBe(true);
    expect(readFileSync(join(consumer, ".gitattributes"), "utf8")).toContain(
      ".claude/commands/** text=auto eol=lf",
    );
  });
});
