/**
 * D-029 / #6256: the framework source repository gets the same managed
 * `.gitattributes` block as any project (no framework-source skip). Once the
 * block is committed, later setup runs leave the file unchanged. The marker
 * test stays: the pack-migrate verbs use it (#6337).
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

describe("ensureGitattributes in a framework source checkout (#6256 / D-029)", () => {
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

  it("linked worktree: the managed block is written once; once committed, a rerun changes nothing (D-029)", async () => {
    const worktree = linkedWorktree();
    const { io } = captureIo();

    // No framework-source skip: this repository is set up like any project.
    await depositNeutralization(worktree, io, { skipGuardWorkflow: true });
    const attrs = readFileSync(join(worktree, ".gitattributes"), "utf8");
    expect(attrs.startsWith(TRACKED_ATTRS)).toBe(true);
    expect(attrs).not.toContain(".deft/core");
    for (const line of DESIRED_GITATTRIBUTES_LINES) expect(attrs).toContain(line);

    // The one-time commit of the managed block: later runs leave the file clean.
    git(worktree, ["add", ".gitattributes"]);
    git(worktree, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "managed block"]);
    expect(ensureGitattributes(worktree, io)).toBe(false);
    expect(git(worktree, ["status", "--porcelain", "--", ".gitattributes"])).toBe("");
  });

  it("checkout with a dogfood .deft/core directory: retired lines are removed like anywhere else", () => {
    const root = freshRoot("deft-6337-dogfood-");
    frameworkSource(root);
    write(
      root,
      ".gitattributes",
      `${TRACKED_ATTRS}.deft/core/** text=auto eol=lf\n.deft/core/** linguist-vendored=true\n`,
    );
    mkdirSync(join(root, ".deft", "core"), { recursive: true });

    expect(ensureGitattributes(root, captureIo().io)).toBe(true);
    const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
    expect(attrs.startsWith(TRACKED_ATTRS)).toBe(true);
    expect(attrs).not.toContain(".deft/core");
  });

  it("consumer project: the managed block is written without .deft/core lines", () => {
    const root = freshRoot("deft-6337-consumer-");
    write(root, ".gitattributes", TRACKED_ATTRS);

    expect(ensureGitattributes(root, captureIo().io)).toBe(true);
    const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
    expect(attrs.startsWith(TRACKED_ATTRS)).toBe(true);
    expect(attrs).not.toContain(".deft/core");
    for (const line of DESIRED_GITATTRIBUTES_LINES) {
      expect(attrs).toContain(line);
    }
  });
});
