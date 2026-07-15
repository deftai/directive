#!/usr/bin/env node
"use strict";

/**
 * Decide whether engine:_ts-build can skip `pnpm run build` (#2563).
 *
 * Exit codes:
 *   0 — dist is fresh enough (or DEFT_SKIP_TS_BUILD=1); skip rebuild
 *   1 — rebuild required (missing dist, newer sources, or DEFT_FORCE_TS_BUILD=1)
 *   2 — usage / config error
 *
 * Warm-dist skip avoids a full `tsc -b` (and its nested shell:true spawns) on
 * every `task <verb>` when packages/cli/dist/bin.js is already up to date.
 */

const fs = require("node:fs");
const path = require("node:path");

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

function walkSourceFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walkSourceFiles(full, out);
      continue;
    }
    if (ent.isFile() && /\.(?:ts|tsx|json)$/.test(ent.name) && !ent.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

function main() {
  const root = process.argv[2];
  if (!root) {
    console.error("deft: ts-build-fresh usage: ts-build-fresh.cjs <DEFT_ROOT>");
    process.exit(2);
  }
  if (process.env.DEFT_FORCE_TS_BUILD === "1") {
    process.exit(1);
  }
  if (process.env.DEFT_SKIP_TS_BUILD === "1") {
    process.exit(0);
  }

  const distDir = path.join(root, "packages", "cli", "dist");
  const bin = path.join(distDir, "bin.js");
  const stamp = path.join(distDir, ".deft-ts-build-stamp");
  if (!fs.existsSync(bin)) {
    process.exit(1);
  }
  // Prefer the post-build stamp (#2563): `tsc -b` incremental often leaves
  // bin.js mtime unchanged even after a successful build when sources are
  // newer than a previous emit. The stamp is written only after a completed
  // engine:_ts-build, so it is the authoritative "warm dist" marker.
  const marker = fs.existsSync(stamp) ? stamp : bin;
  const markerMtime = fs.statSync(marker).mtimeMs;
  const candidates = [];

  for (const pkg of ["cli", "core", "types"]) {
    const pkgRoot = path.join(root, "packages", pkg);
    if (!fs.existsSync(pkgRoot)) continue;
    walkSourceFiles(path.join(pkgRoot, "src"), candidates);
    for (const name of ["package.json", "tsconfig.json", "tsconfig.build.json"]) {
      const fp = path.join(pkgRoot, name);
      if (fs.existsSync(fp)) candidates.push(fp);
    }
  }
  for (const name of ["package.json", "tsconfig.json", "tsconfig.base.json", "pnpm-workspace.yaml"]) {
    const fp = path.join(root, name);
    if (fs.existsSync(fp)) candidates.push(fp);
  }

  for (const file of candidates) {
    try {
      if (fs.statSync(file).mtimeMs > markerMtime) {
        process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { walkSourceFiles };
