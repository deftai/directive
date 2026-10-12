#!/usr/bin/env node
/**
 * Bundle the launcher into one self-contained dist/bin.js (D4.3 / AC3.2).
 * directive / deft / deft-hook all resolve to this file (AC3.5).
 * Keeps dependencies: {}. Uses workspace esbuild (devDependency).
 */
import * as esbuild from "esbuild";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const distDir = join(pkgRoot, "dist");

async function main() {
  // Drop legacy second entry so local dist cannot ship hook-bin.js by mistake.
  const legacyHook = join(distDir, "hook-bin.js");
  if (existsSync(legacyHook)) rmSync(legacyHook, { force: true });
  for (const extra of ["hook-bin.d.ts", "hook-bin.d.ts.map", "hook-bin.js.map"]) {
    const p = join(distDir, extra);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  await esbuild.build({
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external", // only node builtins; no npm deps on the launcher
    logLevel: "info",
    entryPoints: [join(pkgRoot, "src", "bin.ts")],
    outfile: join(distDir, "bin.js"),
  });
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
