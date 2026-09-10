import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitRunner } from "../session/git.js";
import { isLinkedWorktreePath } from "../session/main-worktree.js";
import { ArcDestError, ensureArcDest, resolveOriginDefaultTip } from "./arc-dest.js";
import { prepareGithubOnlyDest } from "./run-posture.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function initRepo(root: string): string {
  git(root, ["init", "-q", "-b", "master"]);
  git(root, ["config", "user.email", "t@t.local"]);
  git(root, ["config", "user.name", "T"]);
  writeFileSync(join(root, "README"), "origin\n", "utf8");
  git(root, ["add", "README"]);
  git(root, ["commit", "-q", "-m", "origin tip"]);
  return git(root, ["rev-parse", "HEAD"]);
}

function repoWithOrigin(): { root: string; originSha: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), "arc-dest-root-"));
  const bare = mkdtempSync(join(tmpdir(), "arc-dest-bare-"));
  temps.push(root, bare);
  const originSha = initRepo(root);
  git(root, ["clone", "--bare", "-q", root, bare]);
  git(root, ["remote", "add", "origin", bare]);
  git(root, ["fetch", "-q", "origin"]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"]);
  return { root, originSha, dest: join(root, ".deft-scratch", "worktrees", "parent-arc-4296") };
}

describe("ensureArcDest (#4296)", () => {
  it("creates dest at origin/<default> tip, not local HEAD", () => {
    const { root, originSha, dest } = repoWithOrigin();
    writeFileSync(join(root, "LOCAL"), "stale\n", "utf8");
    git(root, ["add", "LOCAL"]);
    git(root, ["commit", "-q", "-m", "local ahead"]);
    const localHead = git(root, ["rev-parse", "HEAD"]);
    expect(localHead).not.toBe(originSha);

    const result = ensureArcDest({ repoRoot: root, destPath: dest });
    expect(result.reused).toBe(false);
    expect(result.pinKind).toBe("origin-default");
    expect(result.dispatchSha).toBe(originSha);
    expect(result.originRef).toMatch(/^origin\//);
    expect(isLinkedWorktreePath(dest)).toBe(true);
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(originSha);
    expect(git(dest, ["rev-parse", "HEAD"])).not.toBe(localHead);
  });

  it("reuses dest when HEAD already matches the fetched origin tip", () => {
    const { root, originSha, dest } = repoWithOrigin();
    const first = ensureArcDest({ repoRoot: root, destPath: dest });
    const second = ensureArcDest({ repoRoot: root, destPath: dest });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.dispatchSha).toBe(originSha);
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(originSha);
  });

  it("fast-forwards a stale dest onto the fetched pin", () => {
    const { root, originSha, dest } = repoWithOrigin();
    ensureArcDest({ repoRoot: root, destPath: dest });
    writeFileSync(join(root, "NEXT"), "next\n", "utf8");
    git(root, ["add", "NEXT"]);
    git(root, ["commit", "-q", "-m", "origin moved"]);
    git(root, ["push", "-q", "origin", "HEAD:master"]);
    const newTip = git(root, ["rev-parse", "HEAD"]);
    expect(newTip).not.toBe(originSha);

    const result = ensureArcDest({ repoRoot: root, destPath: dest });
    expect(result.reused).toBe(true);
    expect(result.dispatchSha).toBe(newTip);
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(newTip);
  });

  it("pins against-implementation dest to the fetched PR head SHA", () => {
    const { root, originSha, dest } = repoWithOrigin();
    writeFileSync(join(root, "PR"), "pr\n", "utf8");
    git(root, ["add", "PR"]);
    git(root, ["commit", "-q", "-m", "pr head"]);
    const prHead = git(root, ["rev-parse", "HEAD"]);
    git(root, ["push", "-q", "origin", "HEAD:pr-head"]);
    git(root, ["reset", "-q", "--hard", originSha]);

    const result = ensureArcDest({
      repoRoot: root,
      destPath: dest,
      againstImplementationSha: prHead,
    });
    expect(result.pinKind).toBe("against-implementation");
    expect(result.dispatchSha).toBe(prHead);
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(prHead);
    expect(git(dest, ["rev-parse", "HEAD"])).not.toBe(originSha);
  });

  it("prefers origin/main over origin/master when origin/HEAD is missing", () => {
    const { root } = repoWithOrigin();
    const mainSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const masterSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const gitFake: typeof defaultGitRunner = (_cwd, args) => {
      const joined = args.join(" ");
      if (joined === "fetch origin") return { code: 0, stdout: "", stderr: "" };
      if (joined.includes("origin/HEAD^{commit}")) {
        return { code: 128, stdout: "", stderr: "missing" };
      }
      if (joined.includes("origin/main^{commit}")) {
        return { code: 0, stdout: `${mainSha}\n`, stderr: "" };
      }
      if (joined.includes("origin/master^{commit}")) {
        return { code: 0, stdout: `${masterSha}\n`, stderr: "" };
      }
      return { code: 128, stdout: "", stderr: joined };
    };
    const tip = resolveOriginDefaultTip(root, gitFake);
    expect(tip.originRef).toBe("origin/main");
    expect(tip.sha).toBe(mainSha);
  });

  it("prepareGithubOnlyDest is the Stop 1 dest caller and records the pin", () => {
    const { root, originSha, dest } = repoWithOrigin();
    const prepared = prepareGithubOnlyDest({ repoRoot: root, destPath: dest });
    expect(prepared.dest.dispatchSha).toBe(originSha);
    expect(prepared.record).toContain("arc-mode: no-ingest");
    expect(prepared.record).toContain(`dest: ${prepared.dest.destPath}`);
    expect(prepared.record).toContain(`dispatch-sha: ${originSha}`);
  });

  it("refuses a moving ref as against-implementation dest", () => {
    const { root, dest } = repoWithOrigin();
    expect(() =>
      ensureArcDest({
        repoRoot: root,
        destPath: dest,
        againstImplementationSha: "origin/master",
      }),
    ).toThrow(ArcDestError);
  });

  it("resolveOriginDefaultTip never returns local HEAD when origin is behind", () => {
    const { root, originSha } = repoWithOrigin();
    writeFileSync(join(root, "LOCAL"), "stale\n", "utf8");
    git(root, ["add", "LOCAL"]);
    git(root, ["commit", "-q", "-m", "local ahead"]);
    const tip = resolveOriginDefaultTip(root, defaultGitRunner);
    expect(tip.sha).toBe(originSha);
    expect(tip.sha).not.toBe(git(root, ["rev-parse", "HEAD"]));
  });
});
