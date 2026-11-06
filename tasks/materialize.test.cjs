#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it, after } = require("node:test");
const {
  acquireLock,
  releaseLock,
  isCheckoutOwnedDir,
  movePath,
  materialize,
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
