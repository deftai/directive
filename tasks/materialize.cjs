#!/usr/bin/env node
"use strict";

/**
 * Thin tip→pin materialize (#5805 Prefer-A Bound P3/P4).
 * Stages + packs via existing scripts, then replaces this checkout's
 * node_modules/@deftai/directive-runtime only. No package.json/lockfile
 * location-spec mutation. Serializes via a lockfile under .deft-scratch.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PIN_PKG = path.join("node_modules", "@deftai", "directive-runtime");
const LOCK_REL = path.join(".deft-scratch", "materialize-runtime.lock");
const OVERLAY_REL = path.join(".deft-scratch", "materialize-runtime-overlay.json");

function fail(msg, code = 2) {
  console.error(`materialize:runtime: ${msg}`);
  process.exit(code);
}

function runNode(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (r.status !== 0) {
    fail(
      `${path.basename(script)} failed (exit ${r.status}): ${r.stderr || r.stdout || ""}`.trim(),
      r.status || 2,
    );
  }
  return (r.stdout || "").trim();
}

function acquireLock(projectRoot) {
  const lockPath = path.join(projectRoot, LOCK_REL);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return lockPath;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      const locked = new Error(
        `another materialize is in progress (lock ${lockPath}); reject second writer`,
      );
      locked.code = "EEXIST";
      throw locked;
    }
    throw err;
  }
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

function isCheckoutOwnedDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return false;
    return st.isDirectory();
  } catch {
    return true; // missing is fine; we will create
  }
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function materialize(projectRoot, opts = {}) {
  const root = path.resolve(projectRoot);
  const stageScript = path.join(root, "packages", "runtime", "scripts", "stage-bundle.mjs");
  const packScript = path.join(root, "packages", "runtime", "scripts", "pack-staged-runtime.mjs");
  if (!fs.existsSync(stageScript) || !fs.existsSync(packScript)) {
    fail("stage-bundle/pack-staged-runtime scripts missing; run from framework-source checkout");
  }

  const pinDir = path.join(root, PIN_PKG);
  if (fs.existsSync(pinDir) && !isCheckoutOwnedDir(pinDir)) {
    fail(`refusing to mutate linked/shared pin at ${pinDir}`);
  }

  const lockPath = acquireLock(root);
  const priorPinUsable = fs.existsSync(path.join(pinDir, "dist", "bin.js"));
  let stageDir;
  let packDir;
  try {
    stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-materialize-stage-"));
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-materialize-pack-"));
    runNode(stageScript, [stageDir], { cwd: root });
    const tgz = runNode(packScript, [stageDir, packDir], { cwd: root });
    if (!tgz || !fs.existsSync(tgz)) fail(`pack did not emit tgz (got ${JSON.stringify(tgz)})`);

    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-materialize-extract-"));
    const tar = spawnSync(
      process.platform === "win32" ? "tar.exe" : "tar",
      ["-xzf", tgz, "-C", extractDir],
      { encoding: "utf8" },
    );
    if (tar.status !== 0) {
      fail(`tar extract failed: ${tar.stderr || tar.stdout || ""}`.trim(), tar.status || 2);
    }
    const entries = fs.readdirSync(extractDir);
    if (entries.length !== 1) fail(`expected one package folder in tgz, got ${entries.join(",")}`);
    const extracted = path.join(extractDir, entries[0]);

    const parent = path.dirname(pinDir);
    fs.mkdirSync(parent, { recursive: true });
    const stagingPin = path.join(parent, `.directive-runtime-next-${process.pid}`);
    rmrf(stagingPin);
    fs.renameSync(extracted, stagingPin);
    // Replace only after staged package is ready (P3: failed stage leaves prior pin).
    if (fs.existsSync(pinDir)) rmrf(pinDir);
    fs.renameSync(stagingPin, pinDir);

    let head = "unknown";
    try {
      const g = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
      if (g.status === 0) head = g.stdout.trim();
    } catch {
      /* ignore */
    }
    const overlay = {
      schema: "deft.materialize.runtime.overlay.v1",
      writtenAt: new Date().toISOString(),
      projectRoot: root,
      pinPath: pinDir,
      sourceRevision: head,
      tarball: path.basename(tgz),
      note: "Local tip overlay into checkout pin; package.json/lockfile pins unchanged. Normal PM install restores registry pin.",
    };
    fs.writeFileSync(path.join(root, OVERLAY_REL), `${JSON.stringify(overlay, null, 2)}\n`);
    if (!fs.existsSync(path.join(pinDir, "dist", "bin.js"))) {
      fail("materialize completed but pin bin missing");
    }
    process.stdout.write(`materialize:runtime: installed tip into ${pinDir}\n`);
    process.stdout.write(`materialize:runtime: overlay ${path.join(root, OVERLAY_REL)}\n`);
    return overlay;
  } catch (err) {
    if (priorPinUsable) {
      console.error("materialize:runtime: failed after stage/pack; prior pin left in place");
    }
    throw err;
  } finally {
    releaseLock(lockPath);
    if (stageDir) rmrf(stageDir);
    if (packDir) rmrf(packDir);
  }
}

if (require.main === module) {
  const root = process.argv[2] || process.cwd();
  try {
    materialize(root);
  } catch (err) {
    fail(err && err.message ? err.message : String(err), 2);
  }
}

module.exports = {
  materialize,
  acquireLock,
  releaseLock,
  isCheckoutOwnedDir,
  PIN_PKG,
  LOCK_REL,
  OVERLAY_REL,
};