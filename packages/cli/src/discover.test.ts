/**
 * #6005: `--root` root comparison. Windows paths are case-insensitive, so a different
 * drive-letter case must not be refused; other platforms stay exact.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject, sameRootPath } from "./discover.js";

const TEMPS: string[] = [];

afterEach(() => {
  while (TEMPS.length > 0) {
    const root = TEMPS.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

/** A real git repo at a fully resolved path (long names, real drive-letter case). */
function gitRepo(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "discover-6005-")));
  TEMPS.push(base);
  const root = join(base, "repo");
  mkdirSync(root);
  const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  expect(init.status, init.stderr).toBe(0);
  return root;
}

function gitToplevel(dir: string): string {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return realpathSync(r.stdout.trim());
}

describe("sameRootPath (#6005)", () => {
  it("win32: drive-letter case and separators do not matter", () => {
    expect(sameRootPath("e:\\x", "E:\\x", "win32")).toBe(true);
    expect(sameRootPath("e:\\installer-lab\\g9", "E:/installer-lab/g9", "win32")).toBe(true);
    expect(sameRootPath("E:\\Repo\\", "e:\\repo", "win32")).toBe(true);
    expect(sameRootPath("E:\\", "e:/", "win32")).toBe(true);
  });

  it("win32: different folders are still different", () => {
    expect(sameRootPath("E:\\repo", "E:\\repo2", "win32")).toBe(false);
    expect(sameRootPath("E:\\repo", "D:\\repo", "win32")).toBe(false);
  });

  it("linux and darwin: comparison stays exact", () => {
    expect(sameRootPath("/a/X", "/a/x", "linux")).toBe(false);
    expect(sameRootPath("/a/X", "/a/x", "darwin")).toBe(false);
    expect(sameRootPath("/a/x", "/a/x", "linux")).toBe(true);
  });
});

describe("discoverProject --root (#6005)", () => {
  it("accepts the git toplevel and returns git's own spelling of it", () => {
    const root = gitRepo();
    const result = discoverProject({ cwd: root, rootFlag: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root).toBe(gitToplevel(root));
    expect(result.viaGit).toBe(true);
    expect(result.movedUp).toBe(false);
  });

  it("still refuses a --root below the git toplevel", () => {
    const root = gitRepo();
    const sub = join(root, "sub");
    mkdirSync(sub);
    const result = discoverProject({ cwd: root, rootFlag: sub });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("root_not_git_toplevel");
  });

  it.runIf(process.platform === "win32")(
    "win32: a lowercase drive letter is accepted and resolves to git's toplevel",
    () => {
      const root = gitRepo();
      const lower = root.charAt(0).toLowerCase() + root.slice(1);
      expect(lower).not.toBe(root);
      const result = discoverProject({ cwd: root, rootFlag: lower });
      expect(result.ok, result.ok ? "" : result.message).toBe(true);
      if (!result.ok) return;
      expect(result.root).toBe(gitToplevel(root));
      expect(result.movedUp).toBe(false);
    },
  );
});
