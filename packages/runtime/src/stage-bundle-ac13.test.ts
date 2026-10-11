/**
 * AC1.3 / PKG-AC13: staged + packed runtime has zero @deftai/* dependency keys
 * while still shipping vendored core/content/types under node_modules.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const STAGE_SCRIPT = join(REPO_ROOT, "packages", "runtime", "scripts", "stage-bundle.mjs");
const PACK_SCRIPT = join(REPO_ROOT, "packages", "runtime", "scripts", "pack-staged-runtime.mjs");
const PRIVATE = ["directive-types", "directive-core", "directive-content"] as const;
const RUNTIME_DIST_BIN = join(REPO_ROOT, "packages", "runtime", "dist", "bin.js");

function deftaiDepKeys(pkg: { dependencies?: Record<string, string> }): string[] {
  return Object.keys(pkg.dependencies ?? {}).filter((k) => k.startsWith("@deftai/"));
}

beforeAll(() => {
  if (existsSync(RUNTIME_DIST_BIN)) return;
  const built = spawnSync("pnpm", ["-w", "run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (built.status !== 0 || !existsSync(RUNTIME_DIST_BIN)) {
    throw new Error(
      `workspace build required for stage-bundle tests: ${built.stderr || built.stdout}`,
    );
  }
}, 300_000);

describe("stage-bundle AC1.3 packaging purity", () => {
  it("staged package.json has no @deftai/* dependencies and vendors private packages", () => {
    const outDir = mkdtempSync(join(tmpdir(), "stage-ac13-"));
    try {
      const staged = spawnSync(process.execPath, [STAGE_SCRIPT, outDir], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(staged.status, staged.stderr || staged.stdout).toBe(0);

      const pkg = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        bundledDependencies?: string[];
      };
      expect(pkg.name).toBe("@deftai/directive-runtime");
      expect(deftaiDepKeys(pkg)).toEqual([]);
      expect(pkg.bundledDependencies).toBeUndefined();

      for (const name of PRIVATE) {
        expect(
          existsSync(join(outDir, "node_modules", "@deftai", name, "package.json")),
          `missing vendored ${name}`,
        ).toBe(true);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it(
    "packed tarball package.json has no @deftai/* deps but keeps nested vendors",
    () => {
      const outDir = mkdtempSync(join(tmpdir(), "stage-ac13-pack-"));
      const artDir = mkdtempSync(join(tmpdir(), "art-ac13-"));
      try {
        const staged = spawnSync(process.execPath, [STAGE_SCRIPT, outDir], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        });
        expect(staged.status, staged.stderr || staged.stdout).toBe(0);

        const packed = spawnSync(process.execPath, [PACK_SCRIPT, outDir, artDir], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        });
        expect(packed.status, packed.stderr || packed.stdout).toBe(0);
        const tgz = packed.stdout.trim().split("\n").filter(Boolean).at(-1);
        expect(tgz && existsSync(tgz)).toBe(true);

        const pkgJson = spawnSync("tar", ["-xOf", tgz!, "package/package.json"], {
          encoding: "utf8",
        });
        expect(pkgJson.status).toBe(0);
        const pkg = JSON.parse(pkgJson.stdout) as {
          dependencies?: Record<string, string>;
          bundledDependencies?: string[];
          directive?: { contract?: number };
        };
        expect(deftaiDepKeys(pkg)).toEqual([]);
        expect(pkg.bundledDependencies).toBeUndefined();
        expect(pkg.directive?.contract).toBe(1);

        const listing = spawnSync("tar", ["-tzf", tgz!], { encoding: "utf8" });
        expect(listing.status).toBe(0);
        const names = new Set(listing.stdout.split("\n"));
        for (const name of PRIVATE) {
          expect(names.has(`package/node_modules/@deftai/${name}/package.json`)).toBe(true);
        }
      } finally {
        rmSync(outDir, { recursive: true, force: true });
        rmSync(artDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
