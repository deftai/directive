#!/usr/bin/env node
/**
 * Pack a stage-bundle directory into a publishable tarball (AC1.3 / PKG-AC13-NEST).
 *
 * Private vendors live under vendor/directive-* without package.json and are
 * included via the staged files allowlist (vendor/**). No temporary @deftai
 * (or unscoped private) dependency keys are required for npm pack.
 *
 * Usage:
 *   node packages/runtime/scripts/pack-staged-runtime.mjs <stageDir> <packDestDir>
 * Prints the absolute path of the written .tgz.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const PRIVATE_FOLDERS = ["directive-types", "directive-core", "directive-content"];

function fail(msg) {
  throw new Error(`pack-staged-runtime: ${msg}`);
}

function npmPack(args, opts) {
  return spawnSync("npm", args, {
    ...opts,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

function replaceFile(src, dest) {
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    try {
      unlinkSync(src);
    } catch {
      /* ignore */
    }
  }
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
  const stageDir = isAbsolute(stageDirArg) ? stageDirArg : resolve(process.cwd(), stageDirArg);
  const packDest = isAbsolute(packDestArg) ? packDestArg : resolve(process.cwd(), packDestArg);

  const pkgPath = join(stageDir, "package.json");
  if (!existsSync(pkgPath)) fail(`missing ${pkgPath}`);

  for (const name of PRIVATE_FOLDERS) {
    const vendorDir = join(stageDir, "vendor", name);
    if (!existsSync(vendorDir)) fail(`vendored folder missing: ${vendorDir}`);
    const badPkg = join(vendorDir, "package.json");
    if (existsSync(badPkg)) fail(`vendor must not include package.json: ${badPkg}`);
    const scoped = join(stageDir, "node_modules", "@deftai", name, "package.json");
    if (existsSync(scoped)) fail(`scoped nested vendor must be absent: ${scoped}`);
  }

  const cleanPkg = readJson(pkgPath);
  const deftaiKeys = Object.keys(cleanPkg.dependencies || {}).filter((k) =>
    k.startsWith("@deftai/"),
  );
  if (deftaiKeys.length > 0) {
    fail(`stage package.json still has @deftai deps: ${deftaiKeys.join(", ")}`);
  }
  if (cleanPkg.bundledDependencies) {
    fail("stage package.json must not declare bundledDependencies");
  }

  // COPYFILE_DISABLE avoids macOS AppleDouble ._* entries in the tarball.
  const packed = npmPack(["pack", "--pack-destination", packDest], {
    cwd: stageDir,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (packed.status !== 0) {
    fail(`npm pack failed: ${packed.stderr || packed.stdout}`);
  }
  const lines = (packed.stdout || "").trim().split("\n").filter(Boolean);
  const filename = lines[lines.length - 1];
  if (!filename || !filename.endsWith(".tgz")) {
    fail(`npm pack did not print tarball name; output=${packed.stdout}`);
  }
  const tgzPath = join(packDest, filename);
  if (!existsSync(tgzPath)) fail(`packed tarball missing: ${tgzPath}`);

  // Ensure published package.json inside tarball matches clean stage (idempotent rewrite).
  const work = mkdtempSync(join(tmpdir(), "pack-staged-runtime-"));
  try {
    const tarEnv = { ...process.env, COPYFILE_DISABLE: "1" };
    const extracted = spawnSync("tar", ["-xzf", tgzPath, "-C", work], {
      encoding: "utf8",
      env: tarEnv,
    });
    if (extracted.status !== 0) fail(`tar extract failed: ${extracted.stderr}`);
    writeJson(join(work, "package", "package.json"), cleanPkg);
    const tmpOut = join(packDest, `.pack-staged-runtime-${process.pid}.tgz`);
    const repacked = spawnSync("tar", ["-czf", tmpOut, "-C", work, "package"], {
      encoding: "utf8",
      env: tarEnv,
    });
    if (repacked.status !== 0) fail(`tar repack failed: ${repacked.stderr}`);
    replaceFile(tmpOut, tgzPath);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

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
  const names = listing.stdout.split("\n");
  const nameSet = new Set(names);
  for (const name of PRIVATE_FOLDERS) {
    // vendor tree present (dist or content files); no package.json
    const prefix = `package/vendor/${name}/`;
    if (![...nameSet].some((n) => n.startsWith(prefix))) {
      fail(`packed tarball missing vendored tree ${prefix}`);
    }
    if (nameSet.has(`package/vendor/${name}/package.json`)) {
      fail(`packed tarball must not include vendor package.json for ${name}`);
    }
  }
  const nestedScoped = names.filter(
    (n) => n.includes("node_modules/@deftai/") && n.endsWith("/package.json"),
  );
  if (nestedScoped.length > 0) {
    fail(`packed tarball has nested @deftai package.json: ${nestedScoped.join(", ")}`);
  }

  process.stdout.write(`${tgzPath}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err?.message || err}\n`);
  process.exit(1);
}
