import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandModuleGlobs, globFiles, SKIP_DIRS } from "./glob-files.js";

describe("expandModuleGlobs", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("matches live globs and reports unmatched stale globs", () => {
    root = mkdtempSync(join(tmpdir(), "glob-expand-"));
    writeFileSync(join(root, "live.md"), "ok\n", "utf8");
    const expansion = expandModuleGlobs(root, ["live.md", "stale.md"]);
    expect(expansion.files).toEqual(["live.md"]);
    expect(expansion.unmatched).toEqual(["stale.md"]);
    expect(expansion.filesByGlob.get("live.md")).toEqual(["live.md"]);
    expect(expansion.filesByGlob.get("stale.md")).toEqual([]);
  });

  it("skips SKIP_DIRS members even when the glob would hit them", () => {
    root = mkdtempSync(join(tmpdir(), "glob-skip-"));
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "keep.ts"), "export {}\n", "utf8");
    writeFileSync(join(root, "node_modules", "pkg", "index.ts"), "export {}\n", "utf8");
    expect(SKIP_DIRS.has("node_modules")).toBe(true);
    const expansion = expandModuleGlobs(root, ["**/*.ts"]);
    expect(expansion.files).toEqual(["keep.ts"]);
  });

  it("does not admit untracked files when git ls-files fails inside a git worktree", () => {
    root = mkdtempSync(join(tmpdir(), "glob-git-fail-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "untracked.md"), "scratch\n", "utf8");
    const expansion = expandModuleGlobs(root, ["*.md"]);
    expect(expansion.files).toEqual([]);
    expect(expansion.unmatched).toEqual(["*.md"]);
  });

  it("does not admit untracked files when git ls-files fails in a nested root under a git worktree", () => {
    root = mkdtempSync(join(tmpdir(), "glob-git-nested-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const nested = join(root, "nested", "project");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "untracked.md"), "scratch\n", "utf8");
    const expansion = expandModuleGlobs(nested, ["*.md"]);
    expect(expansion.files).toEqual([]);
    expect(expansion.unmatched).toEqual(["*.md"]);
  });

  it("prefers tracked truth over untracked working-tree hits", () => {
    root = mkdtempSync(join(tmpdir(), "glob-tracked-"));
    writeFileSync(join(root, "tracked.md"), "tracked\n", "utf8");
    writeFileSync(join(root, "untracked.md"), "scratch\n", "utf8");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "tracked.md"], { cwd: root, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "seed"],
      { cwd: root, stdio: "ignore" },
    );
    const expansion = expandModuleGlobs(root, ["*.md"]);
    expect(expansion.files).toEqual(["tracked.md"]);
    expect(expansion.unmatched).toEqual([]);
  });

  it("globFiles returns absolute paths in the same membership as expandModuleGlobs", () => {
    root = mkdtempSync(join(tmpdir(), "glob-abs-"));
    writeFileSync(join(root, "a.ts"), "export {}\n", "utf8");
    const abs = globFiles(root, ["*.ts"]);
    const rel = expandModuleGlobs(root, ["*.ts"]).files;
    expect(abs).toEqual(rel.map((path) => join(root as string, path)));
  });
});
