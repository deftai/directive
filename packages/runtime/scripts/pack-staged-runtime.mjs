#!/usr/bin/env node
/**
 * Pack a stage-bundle directory into a publishable tarball (AC1.3 / AC13.4).
 *
 * npm pack only embeds nested node_modules when the packages are listed in both
 * dependencies and bundledDependencies. The staged package.json deliberately
 * omits @deftai/* from dependencies (AC1.3), so this helper:
 *   1. temporarily lists vendored @deftai/* for npm pack
 *   2. packs
 *   3. rewrites the tarball package.json back to zero @deftai/* dependency keys
 *
 * Usage:
 *   node packages/runtime/scripts/pack-staged-runtime.mjs <stageDir> <packDestDir>
 * Prints the absolute path of the written .tgz.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_NAMES = ["directive-types", "directive-core", "directive-content"];

function fail(msg) {
  process.stderr.write(`pack-staged-runtime: ${msg}\n`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const stageDirArg = process.argv[2];
  const packDestArg = process.argv[3];
  if (!stageDirArg || !packDestArg) {
    fail("usage: pack-staged-runtime.mjs <stageDir> <packDestDir>");
  }
  const stageDir = stageDirArg.startsWith("/")
    ? stageDirArg
    : join(process.cwd(), stageDirArg);
  const packDest = packDestArg.startsWith("/")
    ? packDestArg
    : join(process.cwd(), packDestArg);

  const pkgPath = join(stageDir, "package.json");
  if (!existsSync(pkgPath)) fail(`missing ${pkgPath}`);
  for (const name of PRIVATE_NAMES) {
    const p = join(stageDir, "node_modules", "@deftai", name, "package.json");
    if (!existsSync(p)) fail(`vendored package missing: ${p}`);
  }

  const cleanPkg = readJson(pkgPath);
  const version = cleanPkg.version || "0.0.0";
  const deftaiKeys = Object.keys(cleanPkg.dependencies || {}).filter((k) =>
    k.startsWith("@deftai/"),
  );
  if (deftaiKeys.length > 0) {
    fail(`stage package.json still has @deftai deps: ${deftaiKeys.join(", ")}`);
  }

  // Temporary pack shape so npm embeds nested node_modules.
  const packPkg = structuredClone(cleanPkg);
  packPkg.dependencies = { ...(cleanPkg.dependencies || {}) };
  const bundled = PRIVATE_NAMES.map((n) => `@deftai/${n}`);
  for (const name of bundled) packPkg.dependencies[name] = version;
  packPkg.bundledDependencies = bundled;
  writeJson(pkgPath, packPkg);

  let tgzPath;
  try {
    const packed = spawnSync("npm", ["pack", "--pack-destination", packDest], {
      cwd: stageDir,
      encoding: "utf8",
    });
    if (packed.status !== 0) {
      fail(`npm pack failed: ${packed.stderr || packed.stdout}`);
    }
    const lines = (packed.stdout || "").trim().split("\n").filter(Boolean);
    const filename = lines[lines.length - 1];
    if (!filename || !filename.endsWith(".tgz")) {
      fail(`npm pack did not print tarball name; output=${packed.stdout}`);
    }
    tgzPath = join(packDest, filename);
    if (!existsSync(tgzPath)) fail(`packed tarball missing: ${tgzPath}`);
  } finally {
    writeJson(pkgPath, cleanPkg);
  }

  // Strip @deftai/* from the published package.json inside the tarball.
  const work = mkdtempSync(join(tmpdir(), "pack-staged-runtime-"));
  try {
    const extracted = spawnSync("tar", ["-xzf", tgzPath, "-C", work], { encoding: "utf8" });
    if (extracted.status !== 0) fail(`tar extract failed: ${extracted.stderr}`);
    writeJson(join(work, "package", "package.json"), cleanPkg);
    const tmpOut = join(work, "out.tgz");
    const repacked = spawnSync("tar", ["-czf", tmpOut, "-C", work, "package"], {
      encoding: "utf8",
    });
    if (repacked.status !== 0) fail(`tar repack failed: ${repacked.stderr}`);
    renameSync(tmpOut, tgzPath);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Gate: packed package.json has no @deftai deps; nested vendors present.
  const verify = spawnSync("tar", ["-xOf", tgzPath, "package/package.json"], {
    encoding: "utf8",
  });
  if (verify.status !== 0) fail("could not read packed package.json");
  const published = JSON.parse(verify.stdout);
  const bad = Object.keys(published.dependencies || {}).filter((k) =>
    k.startsWith("@deftai/"),
  );
  if (bad.length > 0) fail(`packed dependencies still have @deftai: ${bad.join(", ")}`);
  if (published.bundledDependencies) {
    fail("packed package.json must not declare bundledDependencies");
  }
  const listing = spawnSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
  if (listing.status !== 0) fail("tar -tzf failed");
  const names = new Set(listing.stdout.split("\n"));
  for (const name of PRIVATE_NAMES) {
    const need = `package/node_modules/@deftai/${name}/package.json`;
    if (!names.has(need)) fail(`packed tarball missing vendored ${need}`);
  }

  process.stdout.write(`${tgzPath}\n`);
}

main();
