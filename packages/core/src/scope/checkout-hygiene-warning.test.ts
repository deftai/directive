import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner, GitRunResult } from "../session/git.js";
import {
  CHECKOUT_HYGIENE_MAX_LINKED_WORKTREES,
  CHECKOUT_HYGIENE_MAX_LOCAL_BRANCHES,
  checkoutHygieneWarningLines,
  linkedWorktreeHygieneLine,
  localBranchHygieneLine,
} from "./checkout-hygiene-warning.js";

const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: "" });
const fail: GitRunResult = { code: 128, stdout: "", stderr: "fatal: not a git repository" };

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** A fake common dir with `live` linked checkouts and `gone` admin dirs whose checkout was removed. */
function makeClone(live: number, gone = 0): { project: string; common: string } {
  const root = mkdtempSync(join(tmpdir(), "checkout-hygiene-"));
  roots.push(root);
  const project = join(root, "main");
  const common = join(project, ".git");
  mkdirSync(join(common, "worktrees"), { recursive: true });
  for (let i = 0; i < live + gone; i += 1) {
    const admin = join(common, "worktrees", `wt-${i}`);
    mkdirSync(admin, { recursive: true });
    const checkout = join(root, "wt", `wt-${i}`);
    if (i < live) mkdirSync(checkout, { recursive: true });
    writeFileSync(join(admin, "gitdir"), `${join(checkout, ".git")}\n`, "utf8");
  }
  return { project, common };
}

function branchList(count: number): string {
  return Array.from({ length: count }, (_, i) => `refs/heads/b-${i}`).join("\n");
}

function fakeGit(common: string, branches: GitRunResult | "throw"): GitRunner {
  return (_root, args) => {
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(common);
    if (args[0] === "for-each-ref") {
      if (branches === "throw") throw new Error("spawn failed");
      return branches;
    }
    return fail;
  };
}

describe("checkoutHygieneWarningLines (#5988)", () => {
  it("names the count, the threshold and the worktree cleanup over 25 live linked worktrees", () => {
    const { project, common } = makeClone(26);
    const lines = checkoutHygieneWarningLines(project, fakeGit(common, ok(branchList(3))));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("26 linked worktrees");
    expect(lines[0]).toContain("more than 25");
    expect(lines[0]).toContain("git worktree remove <path>");
    expect(lines[0]).toContain("git worktree prune");
    expect(lines[0]).toContain("#5920");
  });

  it("returns no lines at 25 linked worktrees and 100 local branches", () => {
    const { project, common } = makeClone(25);
    expect(checkoutHygieneWarningLines(project, fakeGit(common, ok(branchList(100))))).toEqual([]);
  });

  it("names 101 and 100 and git branch -d over 100 local branches, without the hook timeout", () => {
    const { project, common } = makeClone(0);
    const lines = checkoutHygieneWarningLines(project, fakeGit(common, ok(branchList(101))));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("101 local branches");
    expect(lines[0]).toContain("more than 100");
    expect(lines[0]).toContain("git branch -d <name>");
    expect(lines[0]).not.toContain("#5920");
    expect(lines[0]).not.toMatch(/hook|timeout|slow/i);
  });

  it("keeps the worktree line when the branch read exits non-zero", () => {
    const { project, common } = makeClone(26);
    const lines = checkoutHygieneWarningLines(project, fakeGit(common, fail));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("26 linked worktrees");
  });

  it("keeps the worktree line when the branch read throws", () => {
    const { project, common } = makeClone(26);
    const lines = checkoutHygieneWarningLines(project, fakeGit(common, "throw"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("linked worktrees");
  });

  it("keeps the branch line when the worktree read fails", () => {
    const runGit: GitRunner = (_root, args) =>
      args[0] === "for-each-ref" ? ok(branchList(150)) : fail;
    const lines = checkoutHygieneWarningLines("C:/no/such/clone", runGit);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("150 local branches");
  });

  it("returns no lines and does not throw when every git call fails or throws", () => {
    expect(checkoutHygieneWarningLines("C:/no/such/clone", () => fail)).toEqual([]);
    const throwing: GitRunner = () => {
      throw new Error("git missing");
    };
    expect(() => checkoutHygieneWarningLines("C:/no/such/clone", throwing)).not.toThrow();
    expect(checkoutHygieneWarningLines("C:/no/such/clone", throwing)).toEqual([]);
  });

  it("does not count an admin entry whose checkout folder is gone", () => {
    const { project, common } = makeClone(25, 5);
    expect(checkoutHygieneWarningLines(project, fakeGit(common, ok("")))).toEqual([]);
    const over = makeClone(26, 5);
    const lines = checkoutHygieneWarningLines(over.project, fakeGit(over.common, ok("")));
    expect(lines[0]).toContain("26 linked worktrees");
  });

  it("returns fixed text plus counts and thresholds, with no path from the clone", () => {
    const { project, common } = makeClone(30);
    const lines = checkoutHygieneWarningLines(project, fakeGit(common, ok(branchList(120))));
    expect(lines).toEqual([linkedWorktreeHygieneLine(30), localBranchHygieneLine(120)]);
    for (const line of lines) expect(line).not.toContain(dirname(project));
    expect(linkedWorktreeHygieneLine(CHECKOUT_HYGIENE_MAX_LINKED_WORKTREES)).toBeNull();
    expect(localBranchHygieneLine(CHECKOUT_HYGIENE_MAX_LOCAL_BRANCHES)).toBeNull();
  });
});

describe("checkout-hygiene-warning import fence (#5988)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const coreSrc = resolve(here, "..");
  const runtimeSrc = resolve(coreSrc, "..", "..", "runtime", "src");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(path));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
    }
    return out;
  }

  it("is imported by scope/main.ts and by no hook, session, check or doctor source", () => {
    expect(readFileSync(join(here, "main.ts"), "utf8")).toContain("./checkout-hygiene-warning.js");
    const fenced = [
      ...["hooks", "session", "check", "doctor"].flatMap((d) => sourceFiles(join(coreSrc, d))),
      ...sourceFiles(runtimeSrc).filter((p) =>
        /[\\/](hook|session|check|doctor)[^\\/]*\.ts$/.test(p),
      ),
    ];
    expect(fenced.length).toBeGreaterThan(0);
    const importers = fenced.filter((p) =>
      readFileSync(p, "utf8").includes("checkout-hygiene-warning"),
    );
    expect(importers).toEqual([]);
  });
});
