import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consultImplementSpawnOccupancy } from "../session/spawn-occupancy.js";
import { destPlaceImplementSpawn, suggestImplementSpawnDestPath } from "./dest-place.js";
import type { TextCaptureResult } from "./subprocess.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: dir, encoding: "utf8" });
    } catch {
      /* best-effort */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q", "-b", "master", repo], { encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@test.local"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: repo, encoding: "utf8" });
  writeFileSync(join(repo, "f.txt"), "x\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, encoding: "utf8" });
}

function headOid(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function liveGit(args: readonly string[], cwd: string): TextCaptureResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    returncode: r.status ?? 1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

function freshRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  created.push(repo);
  gitInit(repo);
  return repo;
}

describe("destPlaceImplementSpawn (#4575 Prefer-A)", () => {
  it("refuses bare --detach without path", () => {
    const repo = freshRepo("dest-place-bare-path-");
    const result = destPlaceImplementSpawn({
      repoRoot: repo,
      worktreePath: "   ",
      commitIsh: headOid(repo),
      git: liveGit,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("path-required");
    expect(result.message).toMatch(/Bare `git worktree add --detach`/);
  });

  it("refuses bare --detach without commit-ish", () => {
    const repo = freshRepo("dest-place-bare-commit-");
    const result = destPlaceImplementSpawn({
      repoRoot: repo,
      worktreePath: join(repo, "wt-a"),
      commitIsh: "",
      git: liveGit,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("commit-ish-required");
  });

  it("dest-places then exposes cwd for Grok implement consult (no reservation mint)", () => {
    const repo = freshRepo("dest-place-then-cwd-");
    const sha = headOid(repo);
    const wt = join(repo, ".deft-scratch", "worktrees", "child-a");
    const argv: string[][] = [];
    const git = (args: readonly string[], cwd: string): TextCaptureResult => {
      argv.push([...args]);
      return liveGit(args, cwd);
    };

    const placed = destPlaceImplementSpawn({
      repoRoot: repo,
      worktreePath: wt,
      commitIsh: sha,
      git,
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.created).toBe(true);
    expect(placed.cwd).toBe(resolve(wt));
    expect(existsSync(join(placed.cwd, ".deft-scratch", "subagent-status"))).toBe(true);
    expect(argv.some((a) => a[0] === "worktree" && a[1] === "add" && a[2] === "--detach")).toBe(
      true,
    );
    const add = argv.find((a) => a[0] === "worktree" && a[1] === "add");
    expect(add).toEqual(["worktree", "add", "--detach", resolve(wt), sha]);

    const childOcc = join(repo, ".deft", "child-occupancy");
    expect(existsSync(childOcc) ? readdirSync(childOcc).length : 0).toBe(0);

    const consult = consultImplementSpawnOccupancy({
      payloadRoot: repo,
      host: "grok",
      parentId: "parent-1",
      payload: {
        tool_name: "spawn_subagent",
        tool_input: { cwd: placed.cwd, prompt: "implement", subagent_type: "general-purpose" },
      },
    });
    expect(consult.allow).toBe(true);
    if (!consult.allow) return;
    expect(consult.destPath).toBe(resolve(wt));
    expect(existsSync(childOcc) ? readdirSync(childOcc).length : 0).toBe(0);
  });

  it("reuses an existing linked worktree without reminting reservation", () => {
    const repo = freshRepo("dest-place-reuse-");
    const sha = headOid(repo);
    const wt = join(repo, "wt-reuse");
    const first = destPlaceImplementSpawn({
      repoRoot: repo,
      worktreePath: wt,
      commitIsh: sha,
      git: liveGit,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = destPlaceImplementSpawn({
      repoRoot: repo,
      worktreePath: wt,
      commitIsh: sha,
      git: liveGit,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.cwd).toBe(first.cwd);
  });

  it("refuses a non-worktree existing path", () => {
    const repo = freshRepo("dest-place-not-wt-");
    const path = join(repo, "plain-dir");
    mkdirSync(path, { recursive: true });
    const result = destPlaceImplementSpawn({
      repoRoot: repo,
      worktreePath: path,
      commitIsh: headOid(repo),
      git: liveGit,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("path-not-worktree");
  });

  it("refuses reuse when existing worktree HEAD mismatches commit-ish", () => {
    const repo = freshRepo("dest-place-stale-");
    const firstSha = headOid(repo);
    const wt = join(repo, "wt-stale");
    const first = destPlaceImplementSpawn({
      repoRoot: repo,
      worktreePath: wt,
      commitIsh: firstSha,
      git: liveGit,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeFileSync(join(repo, "f2.txt"), "y\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: repo, encoding: "utf8" });
    const secondSha = headOid(repo);
    expect(secondSha).not.toBe(firstSha);
    const reused = destPlaceImplementSpawn({
      repoRoot: repo,
      worktreePath: wt,
      commitIsh: secondSha,
      git: liveGit,
    });
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.code).toBe("revision-mismatch");
    expect(reused.message).toMatch(/Reuse requires a matching HEAD/);
  });

  it("suggestImplementSpawnDestPath stays under .deft-scratch/worktrees", () => {
    const repo = freshRepo("dest-place-suggest-");
    const suggested = suggestImplementSpawnDestPath(repo, "issue-4575/child");
    expect(suggested.replace(/\\/g, "/")).toContain(".deft-scratch/worktrees/issue-4575-child");
  });
});
