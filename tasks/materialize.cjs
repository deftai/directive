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
/** Release cut-context marker (#5910). Active from release entry through bump/tag. */
const CUT_CONTEXT_REL = path.join(".deft-scratch", "release-cut-context.json");
const CUT_CONTEXT_SCHEMA = "deft.release.cut-context.v1";

function fail(msg, code = 2) {
  console.error(`materialize:runtime: ${msg}`);
  process.exit(code);
}

function isCutContextActive(projectRoot) {
  return fs.existsSync(path.join(projectRoot, CUT_CONTEXT_REL));
}

/**
 * Named cut-context producer for the release cut worktree (#5910 P1).
 * Write at release entry; clear after version bump/tag. While active,
 * materialize:runtime refuses before it moves or replaces the pin.
 * Shares the materialize lock so cut entry cannot race an in-flight replace.
 */
function writeReleaseCutContext(projectRoot, meta = {}) {
  const root = path.resolve(projectRoot);
  const dest = path.join(root, CUT_CONTEXT_REL);
  const lockPath = acquireLock(root);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = {
      schema: CUT_CONTEXT_SCHEMA,
      writtenAt: new Date().toISOString(),
      projectRoot: root,
      phase: meta.phase || "release-entry",
      note:
        meta.note ||
        "Release cut-context active through version bump/tag; task materialize:runtime refuses pin replace (#5910).",
    };
    fs.writeFileSync(dest, `${JSON.stringify(body, null, 2)}\n`);
    return body;
  } finally {
    releaseLock(lockPath);
  }
}

function clearReleaseCutContext(projectRoot) {
  const dest = path.join(path.resolve(projectRoot), CUT_CONTEXT_REL);
  try {
    fs.unlinkSync(dest);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

/** Retire the materialize overlay after exact restore (#5910 P2/P4). */
function retireMaterializeOverlay(projectRoot) {
  const dest = path.join(path.resolve(projectRoot), OVERLAY_REL);
  try {
    fs.unlinkSync(dest);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
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

/**
 * Pick the tar binary. On Windows prefer System32's bsdtar: under Git Bash the first
 * `tar.exe` on PATH is GNU tar, which reads `C:` in an archive path as a remote host (#6220).
 */
function tarCommand(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (platform !== "win32") return "tar";
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const system32Tar = path.win32.join(systemRoot, "System32", "tar.exe");
  return exists(system32Tar) ? system32Tar : "tar.exe";
}

/**
 * Extract `tgz` into `extractDir`. tar runs in the tarball's folder and gets the archive
 * by file name only, so no `C:` reaches it and GNU tar and bsdtar both read a local file (#6220).
 */
function extractTarball(tgz, extractDir, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const cmd = tarCommand(deps.platform, deps.env, deps.existsSync);
  const r = spawn(cmd, ["-xzf", path.basename(tgz), "-C", extractDir], {
    cwd: path.dirname(tgz),
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw Object.assign(
      new Error(`tar extract failed: ${(r.stderr || r.stdout || (r.error && r.error.message) || "").trim()}`),
      { code: r.status || 2 },
    );
  }
}

/**
 * Folder to swap. On pnpm the pin is a link into `node_modules/.pnpm/…`; swapping at the
 * link's real path keeps the new runtime next to the dependencies pnpm installed for it.
 * On npm (a real folder) it is the pin folder itself.
 */
function resolveSwapTarget(pinDir) {
  let st;
  try {
    st = fs.lstatSync(pinDir);
  } catch {
    return pinDir; // missing: swap at the pin path
  }
  if (!st.isSymbolicLink()) return pinDir;
  try {
    return fs.realpathSync(pinDir);
  } catch (err) {
    // Never fall back to replacing the link itself: that would cut the runtime off
    // from the dependencies pnpm installed next to it.
    throw new Error(`cannot follow the runtime link at ${pinDir}: ${err.message}`);
  }
}

/** True when something (folder, file or link, even a dangling one) sits at `p`. */
function pathPresent(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Find `<ancestor>/node_modules/<name>` the way Node's resolver walks up from `fromDir`. */
function findInstalledDependency(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", ...name.split("/"));
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Can the swapped-in runtime start? Every declared dependency must resolve from the
 * runtime's real folder, and `dist/bin.js --version` must exit 0. Returns null or a reason.
 */
function smokeCheckRuntime(pinDir, projectRoot, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  let realPin;
  try {
    realPin = fs.realpathSync(pinDir);
  } catch {
    return "runtime folder missing after swap";
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(realPin, "package.json"), "utf8"));
  } catch {
    return "runtime package.json missing or unreadable";
  }
  const missing = Object.keys(pkg.dependencies || {}).filter(
    (name) => findInstalledDependency(name, realPin) === null,
  );
  if (missing.length > 0) {
    return (
      `tip needs dependency ${missing.join(", ")}, which is not installed next to the runtime. ` +
      "Run a release, or bump the pin and run `pnpm install`, then retry"
    );
  }
  const bin = path.join(realPin, "dist", "bin.js");
  if (!fs.existsSync(bin)) return "dist/bin.js missing";
  const r = spawn(process.execPath, [bin, "--version"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || (r.error && r.error.message) || "").trim();
    return `\`dist/bin.js --version\` exited ${r.status}${detail ? `: ${detail.split("\n")[0]}` : ""}`;
  }
  return null;
}

/** Default tip build: stage + pack via the runtime package scripts; returns the tgz path. */
function buildTipTarball(root) {
  const stageScript = path.join(root, "packages", "runtime", "scripts", "stage-bundle.mjs");
  const packScript = path.join(root, "packages", "runtime", "scripts", "pack-staged-runtime.mjs");
  if (!fs.existsSync(stageScript) || !fs.existsSync(packScript)) {
    throw new Error("stage-bundle/pack-staged-runtime scripts missing; run from framework-source checkout");
  }
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-materialize-stage-"));
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-materialize-pack-"));
  runNode(stageScript, [stageDir], { cwd: root });
  const tgz = runNode(packScript, [stageDir, packDir], { cwd: root });
  return { tgz, cleanup: [stageDir, packDir] };
}

/**
 * Replace this checkout's runtime with tip (#5805). Fails closed (#6220): the new runtime
 * must pass {@link smokeCheckRuntime} before the old one is deleted; otherwise the old
 * one is put back and no overlay record is written.
 *
 * opts (tests): buildTarball(root) → { tgz, cleanup[] }, spawnSync, platform, env, existsSync.
 */
function materialize(projectRoot, opts = {}) {
  const root = path.resolve(projectRoot);
  const pinDir = path.join(root, PIN_PKG);
  // lstat-based: existsSync follows the link and reports a link it cannot follow as absent.
  if (pathPresent(pinDir) && !isCheckoutOwnedDir(pinDir, root)) {
    throw new Error(
      `refusing to mutate linked/shared pin at ${pinDir}: the runtime lives outside this checkout ` +
        "(for example a pnpm global store); materialize only replaces a runtime inside the checkout",
    );
  }

  // Hold the same lock as cut entry; check cut-context under the lock so a
  // mid-flight cut cannot outlive an unlocked pre-check (#5910 Greptile P1).
  const lockPath = acquireLock(root);
  const cleanup = [];
  let priorBackup = null;
  let swapTarget = null;
  try {
    if (isCutContextActive(root)) {
      throw new Error(
        `refusing materialize:runtime while release cut-context is active (${CUT_CONTEXT_REL}); keep the published pin through version bump/tag (#5910)`,
      );
    }
    const built = (opts.buildTarball || buildTipTarball)(root);
    cleanup.push(...(built.cleanup || []));
    const tgz = built.tgz;
    if (!tgz || !fs.existsSync(tgz)) {
      throw new Error(`pack did not emit tgz (got ${JSON.stringify(tgz)})`);
    }

    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "deft-materialize-extract-"));
    cleanup.push(extractDir);
    extractTarball(tgz, extractDir, opts);
    const entries = fs.readdirSync(extractDir);
    if (entries.length !== 1) throw new Error(`expected one package folder in tgz, got ${entries.join(",")}`);
    const extracted = path.join(extractDir, entries[0]);

    // Final cut-context check under lock immediately before pin move/replace.
    if (isCutContextActive(root)) {
      throw new Error(
        `refusing materialize:runtime while release cut-context is active (${CUT_CONTEXT_REL}); keep the published pin through version bump/tag (#5910)`,
      );
    }

    // pnpm: swap the real store folder, keep the link (#6220). Whole-folder renames only:
    // files in pnpm's store can be hard links into its global store.
    swapTarget = resolveSwapTarget(pinDir);
    const parent = path.dirname(swapTarget);
    fs.mkdirSync(parent, { recursive: true });
    const stagingPin = path.join(parent, `.directive-runtime-next-${process.pid}`);
    rmrf(stagingPin);
    cleanup.push(stagingPin);
    movePath(extracted, stagingPin);
    if (!fs.existsSync(path.join(stagingPin, "dist", "bin.js"))) {
      throw new Error("staged pin bin missing before replacement");
    }
    // Keep a recoverable backup until the new runtime passes the smoke check.
    if (pathPresent(swapTarget)) {
      priorBackup = path.join(parent, `.directive-runtime-prev-${process.pid}`);
      rmrf(priorBackup);
      movePath(swapTarget, priorBackup);
    }
    let swapped = false;
    try {
      movePath(stagingPin, swapTarget);
      swapped = true;
      const problem = smokeCheckRuntime(pinDir, root, opts);
      if (problem) {
        const err = new Error(problem);
        err.smoke = true;
        throw err;
      }
    } catch (err) {
      if (swapped) rmrf(swapTarget);
      let restored = false;
      if (priorBackup && fs.existsSync(priorBackup)) {
        try {
          movePath(priorBackup, swapTarget);
          priorBackup = null;
          restored = true;
        } catch {
          /* best-effort restore; reported below */
        }
      }
      const outcome = restored
        ? "the published pin was restored"
        : priorBackup
          ? `could not restore the published pin; it is at ${priorBackup}`
          : "there was no earlier pin to restore";
      throw Object.assign(new Error(`materialize failed; ${outcome}: ${err.message}`), {
        code: err.code || 2,
      });
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
    // Written only after the smoke check passed, so a failed run leaves no overlay.
    const overlay = {
      schema: "deft.materialize.runtime.overlay.v1",
      writtenAt: new Date().toISOString(),
      projectRoot: root,
      pinPath: pinDir,
      sourceRevision: head,
      tarball: path.basename(tgz),
      note: "Local tip overlay into checkout pin; package.json/lockfile pins unchanged. Normal PM install restores registry pin.",
    };
    fs.mkdirSync(path.dirname(path.join(root, OVERLAY_REL)), { recursive: true });
    fs.writeFileSync(path.join(root, OVERLAY_REL), `${JSON.stringify(overlay, null, 2)}\n`);
    process.stdout.write(`materialize:runtime: installed tip into ${swapTarget}\n`);
    process.stdout.write(`materialize:runtime: overlay ${path.join(root, OVERLAY_REL)}\n`);
    return overlay;
  } finally {
    releaseLock(lockPath);
    for (const dir of cleanup) rmrf(dir);
    // Only reached with a backup left when the restore itself failed; keep it for recovery.
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = argv[0];
  try {
    if (flag === "--write-cut-context") {
      const target = argv[1] || process.cwd();
      const body = writeReleaseCutContext(target);
      process.stdout.write(
        `materialize:runtime: cut-context written ${path.join(path.resolve(target), CUT_CONTEXT_REL)}\n`,
      );
      process.stdout.write(`${JSON.stringify(body)}\n`);
    } else if (flag === "--clear-cut-context") {
      const cleared = clearReleaseCutContext(argv[1] || process.cwd());
      process.stdout.write(
        cleared
          ? `materialize:runtime: cut-context cleared\n`
          : `materialize:runtime: cut-context absent\n`,
      );
    } else if (flag === "--retire-overlay") {
      const retired = retireMaterializeOverlay(argv[1] || process.cwd());
      process.stdout.write(
        retired
          ? `materialize:runtime: overlay retired\n`
          : `materialize:runtime: overlay absent\n`,
      );
    } else {
      materialize(flag || process.cwd());
    }
  } catch (err) {
    fail(err && err.message ? err.message : String(err), err && err.code ? Number(err.code) || 2 : 2);
  }
}

module.exports = {
  materialize,
  extractTarball,
  tarCommand,
  resolveSwapTarget,
  smokeCheckRuntime,
  acquireLock,
  releaseLock,
  isCheckoutOwnedDir,
  movePath,
  isCutContextActive,
  writeReleaseCutContext,
  clearReleaseCutContext,
  retireMaterializeOverlay,
  PIN_PKG,
  LOCK_REL,
  OVERLAY_REL,
  CUT_CONTEXT_REL,
};
