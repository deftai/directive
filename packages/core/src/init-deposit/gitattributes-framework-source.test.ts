/**
 * #6337: the consumer `.gitattributes` block is never written in a checkout of
 * the framework source repository (linked worktrees and dogfood deposits
 * included); consumer projects get the block as before.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFT_REPO_POSITIVE_MARKERS } from "../doctor/constants.js";
import { isFrameworkSourceCheckoutAt } from "../doctor/paths.js";
import {
  DESIRED_GITATTRIBUTES_LINES,
  depositNeutralization,
  ensureGitattributes,
} from "./scaffold.js";

const TRACKED_ATTRS = "* text=auto\n*.png binary\n";

describe("ensureGitattributes in a framework source checkout (#6337)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  function write(root: string, rel: string, body: string): void {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }

  function captureIo(): { lines: string[]; io: { printf: (text: string) => void } } {
    const lines: string[] = [];
    return { lines, io: { printf: (text) => void lines.push(text) } };
  }

  function git(cwd: string, args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd, encoding: "utf8" });
  }

  /** A framework-source fixture: main.md, every positive marker, a tracked .gitattributes. */
  function frameworkSource(root: string): void {
    write(root, "main.md", "# main\n");
    for (const marker of DEFT_REPO_POSITIVE_MARKERS) {
      write(root, marker, "marker\n");
    }
    write(root, ".gitattributes", TRACKED_ATTRS);
  }

  /** Primary checkout committed, plus a linked worktree of it. Returns the worktree path. */
  function linkedWorktree(): string {
    const primary = freshRoot("deft-6337-primary-");
    frameworkSource(primary);
    git(primary, ["init", "-q"]);
    git(primary, ["config", "user.email", "t@t.dev"]);
    git(primary, ["config", "user.name", "t"]);
    git(primary, ["add", "-A"]);
    git(primary, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
    const worktree = join(freshRoot("deft-6337-wt-"), "linked");
    git(primary, ["worktree", "add", "--detach", "-q", worktree]);
    return worktree;
  }

  it("exports the marker test: true in a linked worktree of a framework source checkout", () => {
    const worktree = linkedWorktree();
    expect(isFrameworkSourceCheckoutAt(worktree)).toBe(true);
  });

  it("marker test is false when a marker is missing or main.md is not a file", () => {
    const partial = freshRoot("deft-6337-partial-");
    write(partial, "main.md", "# main\n");
    expect(isFrameworkSourceCheckoutAt(partial)).toBe(false);

    const dirMain = freshRoot("deft-6337-dirmain-");
    mkdirSync(join(dirMain, "main.md"));
    for (const marker of DEFT_REPO_POSITIVE_MARKERS) {
      write(dirMain, marker, "marker\n");
    }
    expect(isFrameworkSourceCheckoutAt(dirMain)).toBe(false);
  });

  it("linked worktree: the neutralization deposit leaves .gitattributes unchanged", async () => {
    const worktree = linkedWorktree();
    const { io, lines } = captureIo();
    // Compare with the checked-out bytes (core.autocrlf may rewrite line ends).
    const before = readFileSync(join(worktree, ".gitattributes"), "utf8");

    await depositNeutralization(worktree, io, { skipGuardWorkflow: true });

    expect(readFileSync(join(worktree, ".gitattributes"), "utf8")).toBe(before);
    expect(git(worktree, ["status", "--porcelain", "--", ".gitattributes"])).toBe("");
    expect(lines.join("")).toContain("framework source checkout");
  });

  it("checkout with a dogfood .deft/core directory: .gitattributes unchanged", () => {
    const root = freshRoot("deft-6337-dogfood-");
    frameworkSource(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    const { io } = captureIo();

    expect(ensureGitattributes(root, io)).toBe(false);
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(TRACKED_ATTRS);
  });

  it("checkout with a legacy deft/ directory: .gitattributes unchanged", () => {
    const root = freshRoot("deft-6337-legacy-");
    frameworkSource(root);
    mkdirSync(join(root, "deft"), { recursive: true });

    expect(ensureGitattributes(root, captureIo().io)).toBe(false);
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(TRACKED_ATTRS);
  });

  it("consumer project: the block is written as today", () => {
    const root = freshRoot("deft-6337-consumer-");
    write(root, ".gitattributes", TRACKED_ATTRS);

    expect(ensureGitattributes(root, captureIo().io)).toBe(true);
    const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
    expect(attrs.startsWith(TRACKED_ATTRS)).toBe(true);
    for (const line of DESIRED_GITATTRIBUTES_LINES) {
      expect(attrs).toContain(line);
    }
  });

  it("consumer project with main.md but no framework markers: the block is written", () => {
    const root = freshRoot("deft-6337-consumer-main-");
    write(root, "main.md", "# consumer readme\n");

    expect(ensureGitattributes(root, captureIo().io)).toBe(true);
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toContain(
      DESIRED_GITATTRIBUTES_LINES[0],
    );
  });
});
