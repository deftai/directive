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
  LOCK_REL,
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
