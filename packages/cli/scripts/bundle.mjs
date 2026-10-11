#!/usr/bin/env node
/**
 * Bundle the launcher into self-contained dist entries (D4.3 / AC3.2).
 *
 * - dist/bin.js — primary launcher (directive / deft)
 * - dist/hook-bin.js — PATH deft-hook shim (may be a second bin; D4.3 is the launcher)
 *
 * Keeps dependencies: {}. Uses workspace esbuild (devDependency).
 */
import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external", // only node builtins; no npm deps on the launcher
  logLevel: "info",
  // Preserve shebang from entry (src/bin.ts / src/hook-bin.ts).
};

async function main() {
  await esbuild.build({
    ...shared,
    entryPoints: [join(pkgRoot, "src", "bin.ts")],
    outfile: join(pkgRoot, "dist", "bin.js"),
  });
  await esbuild.build({
    ...shared,
    entryPoints: [join(pkgRoot, "src", "hook-bin.ts")],
    outfile: join(pkgRoot, "dist", "hook-bin.js"),
  });
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
