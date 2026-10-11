/**
 * D4.3 / AC3.2: launcher ships as one self-contained primary JS file
 * (plus optional separate hook-bin), with empty dependencies.
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
  // Vitest runs without a prior build; produce the D4.3 bundles in-setup.
  const tsc = spawnSync("pnpm", ["exec", "tsc", "-b"], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  // tsc may already be green from workspace; still run bundle.
  const bundled = spawnSync(process.execPath, [BUNDLE_SCRIPT], {
    cwd: CLI_ROOT,
    encoding: "utf8",
  });
  if (bundled.status !== 0) {
    throw new Error(
      `launcher bundle failed (tsc=${tsc.status}): ${bundled.stderr || bundled.stdout}`,
    );
  }
  if (!existsSync(join(DIST, "bin.js")) || !existsSync(join(DIST, "hook-bin.js"))) {
    throw new Error("bundle.mjs did not produce dist/bin.js + dist/hook-bin.js");
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

  it("dist/hook-bin.js is a separate self-contained bin entry", () => {
    expect(existsSync(join(DIST, "hook-bin.js"))).toBe(true);
    const src = readFileSync(join(DIST, "hook-bin.js"), "utf8");
    expect(src.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(src).not.toMatch(/from\s+["']\.\//);
  });

  it("npm pack of packages/cli ships only bin.js + hook-bin.js as JS entries", () => {
    const art = mkdtempSync(join(tmpdir(), "launcher-pack-d43-"));
    try {
      const packed = npmSpawn(["pack", "--pack-destination", art], { cwd: CLI_ROOT });
      expect(packed.status, packed.stderr || packed.stdout).toBe(0);
      const tgzName = packed.stdout.trim().split("\n").filter(Boolean).at(-1);
      expect(tgzName?.endsWith(".tgz")).toBe(true);
      const tgz = join(art, tgzName!);

      const listing = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" });
      expect(listing.status).toBe(0);
      const jsEntries = listing.stdout
        .split("\n")
        .filter((n) => n.endsWith(".js") && !n.endsWith(".js.map"));
      expect(jsEntries.sort()).toEqual(["package/dist/bin.js", "package/dist/hook-bin.js"].sort());

      const pkgJson = JSON.parse(
        spawnSync("tar", ["-xOf", tgz, "package/package.json"], { encoding: "utf8" }).stdout,
      ) as { dependencies?: Record<string, string> };
      expect(pkgJson.dependencies ?? {}).toEqual({});
    } finally {
      rmSync(art, { recursive: true, force: true });
    }
  });

  it("packages/cli package.json files allowlist is the two bin entries only", () => {
    const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as {
      files?: string[];
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({});
    expect(pkg.files).toEqual(["dist/bin.js", "dist/hook-bin.js"]);
    // Sanity: dist may still have tsc intermediates locally; pack allowlist is what matters.
    expect(readdirSync(DIST).includes("bin.js")).toBe(true);
  });
});
