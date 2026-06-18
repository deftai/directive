import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_BYPASS } from "../policy/resolve.js";
import { DEFAULT_BRANCHES, ENV_SETUP_EXEMPTION, evaluate } from "./evaluate.js";
import { currentBranch } from "./git.js";

function writeProjectDef(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "T", status: "running", items: [], ...plan },
    }),
    { encoding: "utf8" },
  );
}

describe("evaluate", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) {
      rmSync(r, { recursive: true, force: true });
    }
    delete process.env[ENV_SETUP_EXEMPTION];
    delete process.env[ENV_BYPASS];
  });

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "deft-branch-eval-"));
    roots.push(r);
    mkdirSync(join(r, "vbrief"), { recursive: true });
    return r;
  }

  it("passes on a feature branch", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    const result = evaluate(r, { branchOverride: { branch: "feat/my-work", detached: false } });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("feature branch");
  });

  it("passes on master when typed opt-out is true", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: true } });
    const result = evaluate(r, { branchOverride: { branch: "master", detached: false } });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("policy allows it");
  });

  it("blocks on master when policy says no", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    const result = evaluate(r, { branchOverride: { branch: "master", detached: false } });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("refusing to commit/push");
    expect(result.message).toContain("feature branch");
  });

  it("blocks on main as a default branch", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    expect(evaluate(r, { branchOverride: { branch: "main", detached: false } }).exitCode).toBe(1);
  });

  it("passes on detached HEAD", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    const result = evaluate(r, { branchOverride: { branch: "", detached: true } });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("detached HEAD");
  });

  it("passes with env bypass on master", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    process.env[ENV_BYPASS] = "1";
    const result = evaluate(r, { branchOverride: { branch: "master", detached: false } });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("policy allows it");
  });

  it("passes with setup-interview exemption without policy lookup", () => {
    const r = root();
    process.env[ENV_SETUP_EXEMPTION] = "1";
    const result = evaluate(r, { branchOverride: { branch: "master", detached: false } });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("setup-interview exemption");
  });

  it("returns config error when PROJECT-DEFINITION is missing on master", () => {
    const r = root();
    const result = evaluate(r, { branchOverride: { branch: "master", detached: false } });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("cannot be resolved");
    expect(result.message).toContain("not found");
    expect(result.message).toContain("task setup");
  });

  it("passes missing PROJECT-DEFINITION with bootstrap flag", () => {
    const r = root();
    const result = evaluate(r, {
      branchOverride: { branch: "master", detached: false },
      allowMissingProjectDefinition: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("bootstrap state");
  });

  it("honors legacy narrative opt-out on master", () => {
    const r = root();
    writeProjectDef(r, { narratives: { "Allow direct commits to master": "true" } });
    const result = evaluate(r, { branchOverride: { branch: "master", detached: false } });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/legacy-narrative|policy allows it/);
  });

  it("blocks custom default branch names", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: false } });
    const result = evaluate(r, {
      branchOverride: { branch: "trunk", detached: false },
      defaultBranches: new Set(["trunk"]),
    });
    expect(result.exitCode).toBe(1);
  });

  it("returns config error for malformed typed field", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: "yes" } });
    const result = evaluate(r, { branchOverride: { branch: "master", detached: false } });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("PROJECT-DEFINITION cannot be resolved");
    expect(result.message).toContain("must be a boolean");
    expect(result.message).toContain("malformed PROJECT-DEFINITION");
  });

  it("still exits 2 for malformed config with bootstrap flag", () => {
    const r = root();
    writeProjectDef(r, { policy: { allowDirectCommitsToMaster: 42 } });
    const result = evaluate(r, {
      branchOverride: { branch: "master", detached: false },
      allowMissingProjectDefinition: true,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("must be a boolean");
  });

  it("returns config error when git is not found", () => {
    const r = root();
    const result = evaluate(r, { gitNotFound: true });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("cannot determine current branch");
    expect(result.message).toContain("install git");
  });
});

describe("currentBranch", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("reads branch from a real git repo", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-branch-git-"));
    roots.push(r);
    execFileSync("git", ["init", "-q"], { cwd: r });
    execFileSync("git", ["checkout", "-q", "-b", "feat/parity"], { cwd: r });
    const state = currentBranch(r);
    expect(state.detached).toBe(false);
    expect(state.branch).toBe("feat/parity");
  });
});

describe("DEFAULT_BRANCHES", () => {
  it("includes master and main", () => {
    expect(DEFAULT_BRANCHES.has("master")).toBe(true);
    expect(DEFAULT_BRANCHES.has("main")).toBe(true);
  });
});
