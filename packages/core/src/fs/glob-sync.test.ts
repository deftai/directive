import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globSyncCompat, globSyncFallback } from "./glob-sync.js";

// #5873: the Node 20 fallback must return what Node 22+ `fs.globSync` returns.
type GlobFn = (pattern: string, options?: { cwd?: string }) => string[];
const nativeGlobSync = (fs as { globSync?: unknown }).globSync as GlobFn | undefined;
const hasNative = typeof nativeGlobSync === "function";
const native: GlobFn = (pattern, options) => nativeGlobSync?.(pattern, options) ?? [];
// The fallback follows Node 22/24 glob. Node 26 changed how `**` treats
// symlinked directories, so the symlink part of the fixture runs on <= 24 only.
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);

const FILES = [
  "a.ts",
  "b.md",
  "aa.txt",
  "ba.txt",
  "ca.txt",
  ".hidden.ts",
  "src/x.ts",
  "src/y.js",
  "src/.dot.ts",
  "src/deep/z.ts",
  "src/deep/deeper/w.ts",
  "src/deep/.secret/s.ts",
  ".hidden/h.ts",
  ".hidden/inner/i.ts",
  "lib/x.ts",
  "lib/sub/y.md",
  "empty/.keep",
];

const RELATIVE_PATTERNS = [
  "*",
  "**",
  "**/*",
  "**/*.ts",
  "*.ts",
  "?.ts",
  "??.txt",
  "[ab]*.txt",
  "[!a]a.txt",
  "{src,lib}/*",
  "{src,lib}/**/*.ts",
  "src/**",
  "src/**/*.{ts,js}",
  "src/*/z.ts",
  "src/deep/**/*.ts",
  "src/*/**",
  "src/*",
  "src",
  "./src/*.ts",
  "a.ts",
  "missing.ts",
  "missing/**",
  ".hidden/*",
  ".hidden/**",
  ".*",
  ".*/**/*.ts",
  "src/.*",
  "src/**/.*",
  "src/deep/.secret/*",
  "lib/sub",
  "empty/*",
  "linked/*",
  "linked/**",
  "**/sub/*",
  "SRC/*.ts",
];

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deft-glob-sync-"));
  for (const rel of FILES) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, rel);
  }
  if (NODE_MAJOR <= 24) {
    try {
      // Symlinked directory: Node does not follow it with `**` (default).
      symlinkSync(join(root, "lib"), join(root, "linked"), "junction");
    } catch {
      // No symlink rights (some Windows setups): the rest of the fixture still runs.
    }
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("globSyncCompat on Node 22+ (native present)", () => {
  it.skipIf(!hasNative).each(RELATIVE_PATTERNS)("returns exactly fs.globSync for %s", (pattern) => {
    expect(globSyncCompat(pattern, { cwd: root })).toEqual(native(pattern, { cwd: root }));
  });

  it.skipIf(!hasNative)("returns exactly fs.globSync for an absolute pattern with no cwd", () => {
    const pattern = join(root, "src", "**", "*.ts");
    expect(globSyncCompat(pattern)).toEqual(native(pattern));
  });
});

describe("globSyncFallback (native hidden, as on Node 20)", () => {
  it.skipIf(!hasNative).each(RELATIVE_PATTERNS)("matches fs.globSync for %s", (pattern) => {
    expect(globSyncFallback(pattern, { cwd: root })).toEqual(native(pattern, { cwd: root }));
  });

  it.skipIf(!hasNative)("matches fs.globSync for absolute patterns with no cwd", () => {
    for (const pattern of [
      join(root, "src", "**", "*.ts"),
      join(root, "*.txt"),
      join(root, "{src,lib}", "*"),
      join(root, "a.ts"),
    ]) {
      expect(globSyncFallback(pattern)).toEqual(native(pattern));
    }
  });

  it("returns paths relative to cwd with platform separators", () => {
    expect(globSyncFallback("src/deep/*.ts", { cwd: root })).toEqual([join("src", "deep", "z.ts")]);
  });

  it("skips dot entries unless the pattern names them", () => {
    const all = globSyncFallback("**/*.ts", { cwd: root });
    expect(all).not.toContain(".hidden.ts");
    expect(all).not.toContain(join(".hidden", "h.ts"));
    expect(globSyncFallback(".hidden/*.ts", { cwd: root })).toEqual([join(".hidden", "h.ts")]);
  });

  it("returns an empty list for a missing base directory", () => {
    expect(globSyncFallback("nope/**/*.ts", { cwd: root })).toEqual([]);
  });
});
