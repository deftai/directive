/**
 * D4.3 / AC3.2: launcher ships as exactly one self-contained JS file.
 * AC3.5: directive / deft / deft-hook all point at that file.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, "..");
const DIST = join(CLI_ROOT, "dist");
const BUNDLE_SCRIPT = join(CLI_ROOT, "scripts", "bundle.mjs");

function npmSpawn(
  args: string[],
  opts: { cwd: string; encoding?: "utf8" },
): ReturnType<typeof spawnSync> {
  // Native Windows: npm is a .cmd shim — needs shell (#5383).
  return spawnSync("npm", args, {
    ...opts,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

beforeAll(() => {
  // Vitest runs without a prior build; produce the D4.3 bundle in-setup.
  const tsc = spawnSync("pnpm", ["exec", "tsc", "-b"], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const bundled = spawnSync(process.execPath, [BUNDLE_SCRIPT], {
    cwd: CLI_ROOT,
    encoding: "utf8",
  });
  if (bundled.status !== 0) {
    throw new Error(
      `launcher bundle failed (tsc=${tsc.status}): ${bundled.stderr || bundled.stdout}`,
    );
  }
  if (!existsSync(join(DIST, "bin.js"))) {
    throw new Error("bundle.mjs did not produce dist/bin.js");
  }
});

describe("launcher single-file bundle (D4.3 / AC3.2)", () => {
  it("dist/bin.js is self-contained (no relative local imports) and runs --help", () => {
    expect(existsSync(join(DIST, "bin.js"))).toBe(true);
    const src = readFileSync(join(DIST, "bin.js"), "utf8");
    expect(src.startsWith("#!/usr/bin/env node")).toBe(true);
    // Bundled entry must not lazy-load sibling dist modules.
    expect(src).not.toMatch(/from\s+["']\.\//);
    expect(src).not.toMatch(/import\s*\(/);

    const help = spawnSync(process.execPath, [join(DIST, "bin.js"), "--help"], {
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/install/);
    expect(help.stdout).toMatch(/launcher/i);
  });

  it("npm pack of packages/cli ships exactly one .js file (no hook-bin.js)", () => {
    const art = mkdtempSync(join(tmpdir(), "launcher-pack-d43-"));
    try {
      const packed = npmSpawn(["pack", "--pack-destination", art], { cwd: CLI_ROOT });
      expect(packed.status, packed.stderr || packed.stdout).toBe(0);
      const tgzName = packed.stdout.trim().split("\n").filter(Boolean).at(-1);
      expect(tgzName?.endsWith(".tgz")).toBe(true);
      const tgz = join(art, tgzName!);

      const listing = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" });
      expect(listing.status).toBe(0);
      const entries = listing.stdout.split("\n").filter(Boolean);
      const jsEntries = entries.filter((n) => n.endsWith(".js") && !n.endsWith(".js.map"));
      expect(jsEntries).toEqual(["package/dist/bin.js"]);
      expect(entries.some((n) => n.includes("hook-bin"))).toBe(false);

      const pkgJson = JSON.parse(
        spawnSync("tar", ["-xOf", tgz, "package/package.json"], { encoding: "utf8" }).stdout,
      ) as {
        dependencies?: Record<string, string>;
        bin?: Record<string, string>;
        files?: string[];
      };
      expect(pkgJson.dependencies ?? {}).toEqual({});
      expect(pkgJson.files).toEqual(["dist/bin.js"]);
      expect(pkgJson.bin).toEqual({
        directive: "./dist/bin.js",
        deft: "./dist/bin.js",
        "deft-hook": "./dist/bin.js",
      });
    } finally {
      rmSync(art, { recursive: true, force: true });
    }
  });

  it("packages/cli package.json files allowlist is dist/bin.js only", () => {
    const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as {
      files?: string[];
      dependencies?: Record<string, string>;
      bin?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({});
    expect(pkg.files).toEqual(["dist/bin.js"]);
    expect(pkg.bin).toEqual({
      directive: "./dist/bin.js",
      deft: "./dist/bin.js",
      "deft-hook": "./dist/bin.js",
    });
    // Sanity: dist may still have tsc intermediates locally; pack allowlist is what matters.
    expect(readdirSync(DIST).includes("bin.js")).toBe(true);
  });

  it("deft-hook invocation name dispatches to hook launcher (AC3.5)", () => {
    const art = mkdtempSync(join(tmpdir(), "launcher-hook-dispatch-"));
    try {
      const bin = join(DIST, "bin.js");
      const hookLink = join(art, "deft-hook");
      spawnSync("ln", ["-s", bin, hookLink], { encoding: "utf8" });
      // Invoke via node so argv[1] is the symlink basename (no +x required).
      const hook = spawnSync(process.execPath, [hookLink], {
        encoding: "utf8",
        cwd: art,
      });
      expect(hook.error).toBeUndefined();
      expect(hook.status).not.toBe(0);
      const out = `${hook.stderr ?? ""}${hook.stdout ?? ""}`;
      expect(out).toMatch(/deft-hook:/);
      expect(out).not.toMatch(/Usage: directive/i);
    } finally {
      rmSync(art, { recursive: true, force: true });
    }
  });
});
