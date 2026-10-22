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
    const err = new Error(
      `${path.basename(script)} failed (exit ${r.status}): ${r.stderr || r.stdout || ""}`.trim(),
    );
    err.code = r.status || 2;
    throw err;
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

/** True when dir is safe to replace: missing, or a real directory whose realpath is under checkoutRoot. */
function isCheckoutOwnedDir(dir, checkoutRoot) {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) {
      // pnpm pin is often a symlink into the checkout store — allow when realpath stays in-tree.
      if (!checkoutRoot) return false;
      let real;
      try {
        real = fs.realpathSync(dir);
      } catch {
        return false;
      }
      const rootReal = fs.realpathSync(checkoutRoot);
      const rel = path.relative(rootReal, real);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    }
    if (!st.isDirectory()) return false;
    if (!checkoutRoot) return true;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return false;
    }
    const rootReal = fs.realpathSync(checkoutRoot);
    const rel = path.relative(rootReal, real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return true; // missing is fine; we will create
  }
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function movePath(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      fs.cpSync(src, dest, { recursive: true, force: true });
      rmrf(src);
      return;
    }
    throw err;
  }
}

function materialize(projectRoot, opts = {}) {
  const root = path.resolve(projectRoot);
  const stageScript = path.join(root, "packages", "runtime", "scripts", "stage-bundle.mjs");
  const packScript = path.join(root, "packages", "runtime", "scripts", "pack-staged-runtime.mjs");
  if (!fs.existsSync(stageScript) || !fs.existsSync(packScript)) {
    throw new Error("stage-bundle/pack-staged-runtime scripts missing; run from framework-source checkout");
  }

  const pinDir = path.join(root, PIN_PKG);
  if (fs.existsSync(pinDir) && !isCheckoutOwnedDir(pinDir, root)) {
    throw new Error(`refusing to mutate linked/shared pin at ${pinDir}`);
  }

  const lockPath = acquireLock(root);
  const priorPinUsable = fs.existsSync(path.join(pinDir, "dist", "bin.js"));
  let priorBackup = null;
  let stageDir;
  let packDir;
  let extractDir;
  try {
    stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-materialize-stage-"));
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-materialize-pack-"));
    runNode(stageScript, [stageDir], { cwd: root });
    const tgz = runNode(packScript, [stageDir, packDir], { cwd: root });
    if (!tgz || !fs.existsSync(tgz)) fail(`pack did not emit tgz (got ${JSON.stringify(tgz)})`);

    extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-materialize-extract-"));
    const tar = spawnSync(
      process.platform === "win32" ? "tar.exe" : "tar",
      ["-xzf", tgz, "-C", extractDir],
      { encoding: "utf8" },
    );
    if (tar.status !== 0) {
      throw Object.assign(new Error(`tar extract failed: ${tar.stderr || tar.stdout || ""}`.trim()), { code: tar.status || 2 });
    }
    const entries = fs.readdirSync(extractDir);
    if (entries.length !== 1) throw new Error(`expected one package folder in tgz, got ${entries.join(",")}`);
    const extracted = path.join(extractDir, entries[0]);

    const parent = path.dirname(pinDir);
    fs.mkdirSync(parent, { recursive: true });
    const stagingPin = path.join(parent, `.directive-runtime-next-${process.pid}`);
    rmrf(stagingPin);
    movePath(extracted, stagingPin);
    if (!fs.existsSync(path.join(stagingPin, "dist", "bin.js"))) {
      throw new Error("staged pin bin missing before replacement");
    }
    // Keep recoverable backup until replacement succeeds.
    if (fs.existsSync(pinDir)) {
      priorBackup = path.join(parent, `.directive-runtime-prev-${process.pid}`);
      rmrf(priorBackup);
      movePath(pinDir, priorBackup);
    }
    try {
      movePath(stagingPin, pinDir);
    } catch (err) {
      if (priorBackup && fs.existsSync(priorBackup)) {
        try {
          movePath(priorBackup, pinDir);
          priorBackup = null;
        } catch {
          /* best-effort restore */
        }
      }
      throw err;
    }
    if (priorBackup) {
      rmrf(priorBackup);
      priorBackup = null;
    }

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
      throw new Error("materialize completed but pin bin missing");
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
    if (extractDir) rmrf(extractDir);
    if (priorBackup) rmrf(priorBackup);
  }
}

if (require.main === module) {
  const root = process.argv[2] || process.cwd();
  try {
    materialize(root);
  } catch (err) {
    fail(err && err.message ? err.message : String(err), err && err.code ? Number(err.code) || 2 : 2);
  }
}

module.exports = {
  materialize,
  acquireLock,
  releaseLock,
  isCheckoutOwnedDir,
  movePath,
  PIN_PKG,
  LOCK_REL,
  OVERLAY_REL,
};
