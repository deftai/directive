import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #5873 guard: `fs.globSync` exists only on Node 22+. A static named import
// of it fails at ESM link time on Node 20 and crashes the whole runtime.
// Production code must use `globSyncCompat` from `fs/glob-sync.ts`.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PACKAGES = join(REPO_ROOT, "packages");
const ALLOWED = new Set(["packages/core/src/fs/glob-sync.ts"]);

/** `import { …globSync… } from "node:fs"` or `"fs"`, aliased or not. */
const STATIC_GLOBSYNC_IMPORT =
  /import\s*\{[^}]*\bglobSync\b[^}]*\}\s*from\s*["'](?:node:)?fs["']/;

function productionSources(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) productionSources(abs, out);
    else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(abs);
    }
  }
}

describe("no static globSync import (#5873)", () => {
  it("the pattern catches the forms that crash Node 20", () => {
    expect(STATIC_GLOBSYNC_IMPORT.test('import { globSync } from "node:fs";')).toBe(true);
    expect(STATIC_GLOBSYNC_IMPORT.test("import { existsSync, globSync } from 'fs';")).toBe(true);
    expect(
      STATIC_GLOBSYNC_IMPORT.test('import {\n  chmodSync,\n  globSync as g,\n} from "node:fs";'),
    ).toBe(true);
    expect(STATIC_GLOBSYNC_IMPORT.test('import * as fs from "node:fs";')).toBe(false);
    expect(
      STATIC_GLOBSYNC_IMPORT.test('import { globSyncCompat } from "../fs/glob-sync.js";'),
    ).toBe(false);
  });

  it("no production source under packages/*/src imports globSync from node:fs", () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(PACKAGES, pkg.name, "src");
      const files: string[] = [];
      try {
        productionSources(src, files);
      } catch {
        continue;
      }
      for (const file of files) {
        const rel = relative(REPO_ROOT, file).split("\\").join("/");
        if (ALLOWED.has(rel)) continue;
        if (STATIC_GLOBSYNC_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
