#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  lstatSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const { describe, it, after } = require("node:test");
const {
  acquireLock,
  releaseLock,
  isCheckoutOwnedDir,
  movePath,
  materialize,
  extractTarball,
  tarCommand,
  resolveSwapTarget,
  writeReleaseCutContext,
  clearReleaseCutContext,
  isCutContextActive,
  retireMaterializeOverlay,
  LOCK_REL,
  OVERLAY_REL,
  CUT_CONTEXT_REL,
  PIN_PKG,
} = require("./materialize.cjs");

const roots = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "mat-test-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("materialize isolation (#5805 P4)", () => {
  it("acquireLock rejects a second writer", () => {
    const root = tempRoot();
    const lock = acquireLock(root);
    assert.ok(existsSync(join(root, LOCK_REL)));
    assert.throws(() => acquireLock(root), /another materialize|second writer|EEXIST|in progress/i);
    releaseLock(lock);
  });

  it("isCheckoutOwnedDir is false for a symlink outside the checkout", () => {
    const root = tempRoot();
    const outside = tempRoot();
    const real = join(outside, "real-pkg");
    const link = join(root, "linked-pkg");
    mkdirSync(real, { recursive: true });
    try {
      symlinkSync(real, link, "junction");
    } catch {
      return;
    }
    assert.equal(isCheckoutOwnedDir(link, root), false);
    assert.equal(isCheckoutOwnedDir(real, outside), true);
  });

  it("isCheckoutOwnedDir allows in-tree symlink (pnpm-style)", () => {
    const root = tempRoot();
    const store = join(root, ".pnpm", "pkg");
    const link = join(root, "node_modules", "@deftai", "directive-runtime");
    mkdirSync(store, { recursive: true });
    mkdirSync(join(root, "node_modules", "@deftai"), { recursive: true });
    try {
      symlinkSync(store, link, "junction");
    } catch {
      return;
    }
    assert.equal(isCheckoutOwnedDir(link, root), true);
  });

  it("missing destination is treated as checkout-owned (creatable)", () => {
    const root = tempRoot();
    assert.equal(isCheckoutOwnedDir(join(root, "missing"), root), true);
  });

  it("movePath falls back when rename would need copy semantics", () => {
    const root = tempRoot();
    const src = join(root, "src-dir");
    const dest = join(root, "dest-dir");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "f.txt"), "ok");
    movePath(src, dest);
    assert.equal(readFileSync(join(dest, "f.txt"), "utf8"), "ok");
    assert.equal(existsSync(src), false);
  });

  it("failed materialize releases the lock so retries can proceed", () => {
    const root = tempRoot();
    assert.throws(() => materialize(root), /stage-bundle|pack-staged|missing/i);
    assert.equal(existsSync(join(root, LOCK_REL)), false);
    const lock = acquireLock(root);
    releaseLock(lock);
  });
});

describe("release cut-context refuse (#5910 P1/P4)", () => {
  function seedPublishedPin(root, version = "0.129.0") {
    const pinDir = join(root, PIN_PKG);
    mkdirSync(join(pinDir, "dist"), { recursive: true });
    writeFileSync(
      join(pinDir, "package.json"),
      `${JSON.stringify({ name: "@deftai/directive-runtime", version }, null, 2)}\n`,
    );
    writeFileSync(join(pinDir, "dist", "bin.js"), "console.log('pin');\n");
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        { private: true, devDependencies: { "@deftai/directive-runtime": version } },
        null,
        2,
      )}\n`,
    );
    return pinDir;
  }

  it("cut-context producer writes marker; materialize refuses before replace with prior pin intact", () => {
    const root = tempRoot();
    const pinDir = seedPublishedPin(root);
    const priorPkg = readFileSync(join(pinDir, "package.json"), "utf8");
    const body = writeReleaseCutContext(root, { phase: "release-entry" });
    assert.equal(body.schema, "deft.release.cut-context.v1");
    assert.equal(isCutContextActive(root), true);
    assert.ok(existsSync(join(root, CUT_CONTEXT_REL)));

    assert.throws(
      () => materialize(root),
      /refusing materialize:runtime while release cut-context is active|cut-context/i,
    );
    // Prior pin untouched — refuse happened before move/replace.
    assert.equal(readFileSync(join(pinDir, "package.json"), "utf8"), priorPkg);
    assert.equal(JSON.parse(priorPkg).version, "0.129.0");
    assert.equal(existsSync(join(root, LOCK_REL)), false);
    assert.equal(existsSync(join(root, OVERLAY_REL)), false);
  });

  it("cut entry shares the materialize lock (refuses while materialize holds it)", () => {
    const root = tempRoot();
    seedPublishedPin(root);
    const lock = acquireLock(root);
    assert.throws(
      () => writeReleaseCutContext(root, { phase: "release-entry" }),
      /another materialize|second writer|EEXIST|in progress/i,
    );
    assert.equal(isCutContextActive(root), false);
    releaseLock(lock);
    const body = writeReleaseCutContext(root, { phase: "release-entry" });
    assert.equal(body.schema, "deft.release.cut-context.v1");
    assert.equal(existsSync(join(root, LOCK_REL)), false);
  });

  it("without cut-context, missing stage scripts still fail after the cut guard", () => {
    const root = tempRoot();
    seedPublishedPin(root);
    assert.equal(isCutContextActive(root), false);
    assert.throws(() => materialize(root), /stage-bundle|pack-staged|missing/i);
  });

  it("clearReleaseCutContext retires the marker so materialize can proceed past the cut guard", () => {
    const root = tempRoot();
    seedPublishedPin(root);
    writeReleaseCutContext(root);
    assert.equal(clearReleaseCutContext(root), true);
    assert.equal(isCutContextActive(root), false);
    assert.throws(() => materialize(root), /stage-bundle|pack-staged|missing/i);
  });

  it("retireMaterializeOverlay removes the overlay marker after restore", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft-scratch"), { recursive: true });
    writeFileSync(join(root, OVERLAY_REL), `${JSON.stringify({ schema: "overlay" })}\n`);
    assert.equal(retireMaterializeOverlay(root), true);
    assert.equal(existsSync(join(root, OVERLAY_REL)), false);
    assert.equal(retireMaterializeOverlay(root), false);
  });

  it("cut-context keeps published pin intact (bump-gate preconditions; not a full release run)", () => {
    // Narrow pin-preservation proof (#5910 P4 / Greptile P2): cut-context at entry,
    // materialize refuses, published pin + pin declaration stay aligned, no overlay.
    // Full release-to-bump coverage stays on task release:e2e / release skill path.
    const root = tempRoot();
    const pinDir = seedPublishedPin(root, "0.129.0");
    writeReleaseCutContext(root, { phase: "release-entry" });

    assert.throws(() => materialize(root), /cut-context/i);
    const installed = JSON.parse(readFileSync(join(pinDir, "package.json"), "utf8"));
    assert.equal(installed.version, "0.129.0");
    assert.equal(existsSync(join(root, OVERLAY_REL)), false);

    // Version-bump gate preconditions only (not an executed bump).
    const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(rootPkg.devDependencies["@deftai/directive-runtime"], "0.129.0");
    assert.equal(installed.version, rootPkg.devDependencies["@deftai/directive-runtime"]);
    assert.equal(isCutContextActive(root), true);
  });
});

describe("extraction under Git Bash / PowerShell / cmd (#6220)", () => {
  it("runs tar in the tarball's folder with a bare archive name (no drive letter)", () => {
    const calls = [];
    const fake = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0, stdout: "", stderr: "" };
    };
    const tgz = join("C:\\", "Users", "me", "AppData", "Local", "Temp", "pack-1", "rt-1.0.0.tgz");
    extractTarball(tgz, "C:\\x\\extract", {
      spawnSync: fake,
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      existsSync: () => true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "C:\\Windows\\System32\\tar.exe");
    assert.deepEqual(calls[0].args, ["-xzf", "rt-1.0.0.tgz", "-C", "C:\\x\\extract"]);
    assert.equal(calls[0].options.cwd, dirname(tgz));
    assert.ok(!calls[0].args[1].includes(":"), "archive argument must not carry a drive letter");
  });

  it("tarCommand falls back to tar.exe on PATH when System32 tar is absent; plain tar elsewhere", () => {
    assert.equal(tarCommand("win32", { SystemRoot: "C:\\Windows" }, () => false), "tar.exe");
    assert.equal(tarCommand("linux", {}, () => true), "tar");
    assert.equal(tarCommand("darwin", {}, () => true), "tar");
  });

  it("a tar failure is reported, not swallowed", () => {
    const fake = () => ({ status: 2, stdout: "", stderr: "tar (child): Cannot connect to C: resolve failed" });
    assert.throws(
      () => extractTarball("/tmp/x/a.tgz", "/tmp/y", { spawnSync: fake, platform: "linux" }),
      /tar extract failed: tar \(child\): Cannot connect/,
    );
  });
});

describe("pin swap and fail-closed smoke check (#6220)", () => {
  /** A runtime package folder: dist/bin.js prints the version (or exits 1 when broken). */
  function writeRuntimePkg(dir, version, { deps = {}, binExit = 0 } = {}) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "@deftai/directive-runtime", version, dependencies: deps }, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, "dist", "bin.js"),
      binExit === 0
        ? `process.stdout.write(${JSON.stringify(version)} + "\\n");\n`
        : `process.stderr.write("boom\\n"); process.exit(${binExit});\n`,
    );
  }

  function writeDepPkg(nodeModules, name) {
    mkdirSync(join(nodeModules, name), { recursive: true });
    writeFileSync(join(nodeModules, name, "package.json"), `${JSON.stringify({ name, version: "1.0.0" })}\n`);
  }

  /** Builds a real tgz with a top-level `package/` folder, as `npm pack` does. */
  function tipTarballBuilder(version, opts) {
    return () => {
      const work = mkdtempSync(join(tmpdir(), "mat-tip-"));
      roots.push(work);
      writeRuntimePkg(join(work, "package"), version, opts);
      const out = mkdtempSync(join(tmpdir(), "mat-tgz-"));
      roots.push(out);
      const tgz = join(out, `deftai-directive-runtime-${version}.tgz`);
      const r = spawnSync(tarCommand(), ["-czf", basename(tgz), "-C", work, "package"], {
        cwd: out,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      return { tgz, cleanup: [] };
    };
  }

  /** pnpm layout: the pin is a link into node_modules/.pnpm/…; deps sit beside it there. */
  function pnpmCheckout(version = "1.0.0") {
    const root = tempRoot();
    const storeNm = join(root, "node_modules", ".pnpm", `@deftai+directive-runtime@${version}`, "node_modules");
    const store = join(storeNm, "@deftai", "directive-runtime");
    writeRuntimePkg(store, version, { deps: { parse5: "^7.0.0" } });
    writeDepPkg(storeNm, "parse5");
    mkdirSync(join(root, "node_modules", "@deftai"), { recursive: true });
    try {
      symlinkSync(store, join(root, PIN_PKG), "junction");
    } catch {
      return null;
    }
    return { root, store };
  }

  it("pnpm: swaps at the link's real path, keeps the link, and the new runtime resolves its deps", () => {
    const fx = pnpmCheckout();
    if (!fx) return;
    const pin = join(fx.root, PIN_PKG);
    assert.equal(resolveSwapTarget(pin), realpathSync(fx.store));
    const overlay = materialize(fx.root, {
      buildTarball: tipTarballBuilder("2.0.0-tip", { deps: { parse5: "^7.0.0" } }),
    });
    assert.ok(lstatSync(pin).isSymbolicLink(), "the node_modules link is left in place");
    assert.equal(realpathSync(pin), realpathSync(fx.store));
    assert.equal(JSON.parse(readFileSync(join(fx.store, "package.json"), "utf8")).version, "2.0.0-tip");
    assert.ok(existsSync(join(fx.root, OVERLAY_REL)));
    assert.equal(overlay.pinPath, pin);
    assert.equal(existsSync(join(fx.root, LOCK_REL)), false);
  });

  it("tip needing a dependency the pin lacks: restores the published pin, writes no overlay", () => {
    const fx = pnpmCheckout();
    if (!fx) return;
    assert.throws(
      () =>
        materialize(fx.root, {
          buildTarball: tipTarballBuilder("2.0.0-tip", { deps: { parse5: "^7.0.0", "new-dep": "1.0.0" } }),
        }),
      /materialize failed; the published pin was restored: tip needs dependency new-dep/,
    );
    const pin = join(fx.root, PIN_PKG);
    assert.ok(lstatSync(pin).isSymbolicLink());
    assert.equal(JSON.parse(readFileSync(join(pin, "package.json"), "utf8")).version, "1.0.0");
    const run = spawnSync(process.execPath, [join(pin, "dist", "bin.js")], { encoding: "utf8" });
    assert.equal(run.status, 0);
    assert.equal(existsSync(join(fx.root, OVERLAY_REL)), false);
    assert.equal(existsSync(join(fx.root, LOCK_REL)), false);
  });

  it("a runtime that cannot start: restores the published pin, writes no overlay", () => {
    const fx = pnpmCheckout();
    if (!fx) return;
    assert.throws(
      () => materialize(fx.root, { buildTarball: tipTarballBuilder("2.0.0-tip", { binExit: 1 }) }),
      /materialize failed; the published pin was restored: `dist\/bin\.js --version` exited 1: boom/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(fx.root, PIN_PKG, "package.json"), "utf8")).version,
      "1.0.0",
    );
    assert.equal(existsSync(join(fx.root, OVERLAY_REL)), false);
  });

  it("a runtime link that cannot be followed is refused, not replaced", () => {
    const root = tempRoot();
    mkdirSync(join(root, "node_modules", "@deftai"), { recursive: true });
    const pin = join(root, PIN_PKG);
    try {
      symlinkSync(join(root, "node_modules", ".pnpm", "gone"), pin, "junction");
    } catch {
      return;
    }
    assert.throws(
      () => materialize(root, { buildTarball: tipTarballBuilder("2.0.0-tip") }),
      /refusing to mutate linked\/shared pin/,
    );
    assert.ok(lstatSync(pin).isSymbolicLink(), "the link is left alone");
    assert.equal(existsSync(join(root, OVERLAY_REL)), false);
  });

  it("npm: real pin folder with hoisted deps is replaced in place, as before", () => {
    const root = tempRoot();
    const pin = join(root, PIN_PKG);
    writeRuntimePkg(pin, "1.0.0", { deps: { parse5: "^7.0.0" } });
    writeDepPkg(join(root, "node_modules"), "parse5");
    assert.equal(resolveSwapTarget(pin), pin);
    materialize(root, { buildTarball: tipTarballBuilder("2.0.0-tip", { deps: { parse5: "^7.0.0" } }) });
    assert.ok(lstatSync(pin).isDirectory() && !lstatSync(pin).isSymbolicLink());
    assert.equal(JSON.parse(readFileSync(join(pin, "package.json"), "utf8")).version, "2.0.0-tip");
    assert.ok(existsSync(join(root, OVERLAY_REL)));
    const leftovers = require("node:fs")
      .readdirSync(join(root, "node_modules", "@deftai"))
      .filter((n) => n.startsWith(".directive-runtime-"));
    assert.deepEqual(leftovers, []);
  });
});
