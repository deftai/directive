import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as projectionContainment from "../fs/projection-containment.js";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { assertMigrationSourceSafe } from "./migration-containment.js";

const itSymlink = it.skipIf(process.platform === "win32");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("migration-containment (#2601)", () => {
  it("passes for an in-tree legacy directory", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-contain-ok-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "story.vbrief.json"), "{}\n");
    expect(() => assertMigrationSourceSafe(root, join(root, "vbrief"))).not.toThrow();
  });

  itSymlink("rejects a vbrief root symlink escaping the project tree", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-contain-root-"));
    const escapeDir = mkdtempSync(join(tmpdir(), "migrate-contain-escape-"));
    roots.push(root, escapeDir);
    writeFileSync(join(escapeDir, "secret.txt"), "top-secret\n");
    symlinkSync(escapeDir, join(root, "vbrief"), "dir");
    expect(() => assertMigrationSourceSafe(root, join(root, "vbrief"))).toThrow(
      /symlink escaping|symlink on migration path/,
    );
  });

  itSymlink("rejects nested symlinks under the legacy tree", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-contain-nested-"));
    const escapeDir = mkdtempSync(join(tmpdir(), "migrate-contain-nested-escape-"));
    roots.push(root, escapeDir);
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(escapeDir, "secret.txt"), "top-secret\n");
    symlinkSync(join(escapeDir, "secret.txt"), join(root, "vbrief", "active", "link.txt"));
    expect(() => assertMigrationSourceSafe(root, join(root, "vbrief"))).toThrow(
      /symlink on migration path/,
    );
  });

  it("rewrites nested traversal symlink errors for migrate operators", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-contain-nested-msg-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    const spy = vi
      .spyOn(projectionContainment, "walkDirectoryRejectSymlinks")
      .mockImplementation(() => {
        throw new ProjectionContainmentError("symlink on traversal path: /escape/link", {
          projectDir: root,
          targetPath: join(root, "vbrief"),
          offendingPath: "/escape/link",
        });
      });
    try {
      expect(() => assertMigrationSourceSafe(root, join(root, "vbrief"))).toThrow(
        /symlink on migration path: \/escape\/link/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows non-containment walk errors unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-contain-walk-err-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    const spy = vi
      .spyOn(projectionContainment, "walkDirectoryRejectSymlinks")
      .mockImplementation(() => {
        throw new Error("disk full");
      });
    try {
      expect(() => assertMigrationSourceSafe(root, join(root, "vbrief"))).toThrow(/disk full/);
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows containment errors without the nested traversal prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-contain-plain-err-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    const spy = vi
      .spyOn(projectionContainment, "walkDirectoryRejectSymlinks")
      .mockImplementation(() => {
        throw new ProjectionContainmentError("projection write refused: root escape", {
          projectDir: root,
          targetPath: join(root, "vbrief"),
          offendingPath: "/escape",
        });
      });
    try {
      expect(() => assertMigrationSourceSafe(root, join(root, "vbrief"))).toThrow(
        /projection write refused: root escape/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
