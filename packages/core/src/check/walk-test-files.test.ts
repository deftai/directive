import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkTestFiles } from "./walk-test-files.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "walk-test-files-"));
  tempDirs.push(root);
  return root;
}

function touch(root: string, rel: string, body = "export {};\n"): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function relList(root: string): string[] {
  return walkTestFiles(root)
    .map((abs) => relative(root, abs).replaceAll("\\", "/"))
    .sort();
}

describe("walkTestFiles (#6226)", () => {
  it("returns test and spec files in every supported extension", () => {
    const root = makeRoot();
    for (const rel of [
      "a.test.ts",
      "b.spec.tsx",
      "src/c.test.js",
      "src/deep/d.spec.mjs",
      "src/deep/e.test.cjs",
      "src/not-a-test.ts",
      "src/f.test.md",
    ]) {
      touch(root, rel);
    }
    expect(relList(root)).toEqual([
      "a.test.ts",
      "b.spec.tsx",
      "src/c.test.js",
      "src/deep/d.spec.mjs",
      "src/deep/e.test.cjs",
    ]);
  });

  it("skips node_modules, dist, .git and .deft-scratch by literal basename", () => {
    const root = makeRoot();
    touch(root, "keep.test.ts");
    touch(root, "node_modules/pkg/x.test.ts");
    touch(root, "dist/x.test.js");
    touch(root, ".git/hooks/x.test.ts");
    touch(root, ".deft-scratch/notes/x.test.ts");
    touch(root, "packages/core/.deft-scratch/x.test.ts");
    expect(relList(root)).toEqual(["keep.test.ts"]);
  });

  it("does not descend into a subdirectory whose .git entry is a file (linked worktree)", () => {
    const root = makeRoot();
    touch(root, "keep.test.ts");
    touch(root, "worktrees/story-x/.git", "gitdir: ../../.git/worktrees/story-x\n");
    touch(root, "worktrees/story-x/inner.test.ts");
    touch(root, "worktrees/plain/kept.test.ts");
    expect(relList(root)).toEqual(["keep.test.ts", "worktrees/plain/kept.test.ts"]);
  });

  it("still descends into a subdirectory whose .git entry is a directory", () => {
    const root = makeRoot();
    mkdirSync(join(root, "vendored", ".git"), { recursive: true });
    touch(root, "vendored/kept.test.ts");
    expect(relList(root)).toEqual(["vendored/kept.test.ts"]);
  });

  it("walks the root even when the root itself is a linked worktree", () => {
    const root = makeRoot();
    touch(root, ".git", "gitdir: /elsewhere/.git/worktrees/root\n");
    touch(root, "src/kept.test.ts");
    expect(relList(root)).toEqual(["src/kept.test.ts"]);
  });

  it("returns an empty list for a missing root", () => {
    expect(walkTestFiles(join(tmpdir(), "walk-test-files-missing-6226"))).toEqual([]);
  });
});
