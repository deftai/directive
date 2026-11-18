import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { globSyncCompat, globSyncFallback } from "./glob-sync.js";

// #5873: the Node 20 fallback must return what Node 22+ `fs.globSync` returns.
type GlobFn = (pattern: string, options?: { cwd?: string }) => string[];
const nativeGlobSync = (fs as { globSync?: unknown }).globSync as GlobFn | undefined;
const hasNative = typeof nativeGlobSync === "function";
const native: GlobFn = (pattern, options) => nativeGlobSync?.(pattern, options) ?? [];

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
  const linked = join(root, "linked");
  try {
    // Symlinked directory: Node does not follow it with `**` (default).
    symlinkSync(join(root, "lib"), linked, "junction");
  } catch {
    // No symlink rights (some Windows setups): the rest of the fixture still runs.
  }
  // The fallback ports Node 24.22+ / 26, where `**` never steps into a
  // symlinked directory. Older 22/24 releases step in one level; on those,
  // drop the link so the rest of the fixture still compares exactly.
  if (hasNative && native("**/*", { cwd: root }).includes(join("linked", "x.ts"))) {
    rmSync(linked, { recursive: false, force: true });
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

describe("globSyncFallback called directly (the Node 20 path)", () => {
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

describe("globSyncCompat with fs.globSync missing (Node 20)", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it.skipIf(!hasNative)("selects the fallback and honours cwd", async () => {
    let walkedDirs = 0;
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const real = await importOriginal<typeof import("node:fs")>();
      // Node 20 has no fs.globSync; the fallback walks with readdirSync.
      const readdirSync = ((...args: Parameters<typeof real.readdirSync>) => {
        walkedDirs += 1;
        return real.readdirSync(...args);
      }) as typeof real.readdirSync;
      const node20 = { ...real, globSync: undefined, readdirSync };
      return { ...node20, default: node20 };
    });
    const hidden = await import("./glob-sync.js");
    for (const pattern of ["**/*.ts", "{src,lib}/*", "src/deep/**"]) {
      expect(hidden.globSyncCompat(pattern, { cwd: root })).toEqual(native(pattern, { cwd: root }));
    }
    expect(hidden.globSyncCompat("*.ts", { cwd: join(root, "src") })).toEqual(
      native("*.ts", { cwd: join(root, "src") }),
    );
    expect(walkedDirs).toBeGreaterThan(0);
  });
});
