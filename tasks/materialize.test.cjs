#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it, after } = require("node:test");
const {
  acquireLock,
  releaseLock,
  isCheckoutOwnedDir,
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

  it("isCheckoutOwnedDir is false for a symlink destination", () => {
    const root = tempRoot();
    const real = join(root, "real-pkg");
    const link = join(root, "linked-pkg");
    mkdirSync(real, { recursive: true });
    try {
      symlinkSync(real, link, "junction");
    } catch {
      // Some Windows CI images disallow symlinks; skip assert then.
      return;
    }
    assert.equal(isCheckoutOwnedDir(link), false);
    assert.equal(isCheckoutOwnedDir(real), true);
  });

  it("missing destination is treated as checkout-owned (creatable)", () => {
    const root = tempRoot();
    assert.equal(isCheckoutOwnedDir(join(root, "missing")), true);
  });
});
