/**
 * Failure-path coverage for replaceTree recovery semantics (Greptile P1s on #2933).
 *
 * Kept separate from copy-tree.test.ts so node:fs/promises mocks stay isolated.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});

import { replaceTree } from "./copy-tree.js";

const actualFsp = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

describe("replaceTree recovery (Greptile P1 #2933)", () => {
  const created: string[] = [];
  /** Backups preserved on purpose by the SUT — cleaned in afterEach. */
  const preservedBackups: string[] = [];

  beforeEach(() => {
    vi.mocked(fsp.rename).mockImplementation(actualFsp.rename);
    vi.mocked(fsp.rm).mockImplementation(actualFsp.rm);
  });

  afterEach(() => {
    vi.mocked(fsp.rename).mockReset();
    vi.mocked(fsp.rm).mockReset();
    for (const dir of [...created.splice(0), ...preservedBackups.splice(0)]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  function extractBackupPath(message: string): string | null {
    const match = message.match(/recovery copy at (.+)$/);
    return match?.[1]?.trim() || null;
  }

  it("preserves backup when aside-move copy+remove fails after partial dst delete", async () => {
    const workspace = freshRoot("replace-aside-fail-");
    const src = join(workspace, "src");
    const dst = join(workspace, "dst");
    mkdirSync(src, { recursive: true });
    mkdirSync(join(dst, "nested"), { recursive: true });
    writeFileSync(join(src, "new.md"), "new\n", "utf-8");
    writeFileSync(join(dst, "old.md"), "old-payload\n", "utf-8");
    writeFileSync(join(dst, "nested", "keep-me.md"), "precious\n", "utf-8");

    // Force moveTree(dst → backup) onto the copy+remove fallback.
    vi.mocked(fsp.rename).mockImplementation(async (from, to, options) => {
      if (String(from) === dst) {
        const err = new Error("simulated cross-device rename") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      return actualFsp.rename(from, to, options);
    });

    // After copyDirContents(dst, backup) succeeds, moveTree rm's src (dst).
    // Simulate partial delete then failure — dst is damaged, backup is complete.
    vi.mocked(fsp.rm).mockImplementation(async (target, options) => {
      if (String(target) === dst) {
        const nested = join(dst, "nested", "keep-me.md");
        if (existsSync(nested)) {
          await actualFsp.rm(nested, { force: true });
        }
        const err = new Error("simulated partial remove failure") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actualFsp.rm(target, options);
    });

    let thrown: unknown;
    try {
      await replaceTree(src, dst);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(/failed to move existing destination aside/);
    expect(message).toMatch(/recovery copy at /);

    const backupPath = extractBackupPath(message);
    expect(backupPath).toBeTruthy();
    if (!backupPath) return;
    preservedBackups.push(backupPath);

    // Recovery copy must survive the outer finally (the P1 failure mode deleted it).
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(join(backupPath, "old.md"), "utf-8")).toBe("old-payload\n");
    expect(readFileSync(join(backupPath, "nested", "keep-me.md"), "utf-8")).toBe("precious\n");

    // New payload must not have been installed over the damaged dst.
    expect(existsSync(join(dst, "new.md"))).toBe(false);
  });

  it("does not reject when post-install backup cleanup fails (avoids VERSION drift)", async () => {
    const workspace = freshRoot("replace-cleanup-fail-");
    const src = join(workspace, "src");
    const dst = join(workspace, "dst");
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(src, "fresh.md"), "fresh\n", "utf-8");
    writeFileSync(join(dst, "stale.md"), "stale\n", "utf-8");

    // Force aside-move onto copy+remove so a backup directory exists to clean up.
    // (Same-FS rename leaves no backup path under our control for the cleanup rm.)
    vi.mocked(fsp.rename).mockImplementation(async (from, to, options) => {
      if (String(from) === dst) {
        const err = new Error("simulated cross-device rename") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      return actualFsp.rename(from, to, options);
    });

    const seenBackupRmTargets: string[] = [];
    vi.mocked(fsp.rm).mockImplementation(async (target, options) => {
      const path = String(target);
      // After successful install, replaceTree rm's the backup. Fail that cleanup only.
      // Heuristic: backup temps are deft-core-bak-* and at cleanup time dst already has fresh.md.
      if (
        path.includes("deft-core-bak-") &&
        existsSync(join(dst, "fresh.md")) &&
        !existsSync(join(dst, "stale.md"))
      ) {
        seenBackupRmTargets.push(path);
        const err = new Error("simulated backup cleanup failure") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return actualFsp.rm(target, options);
    });

    await expect(replaceTree(src, dst)).resolves.toBeUndefined();

    // New payload is live — callers (runRefreshDeposit) may stamp VERSION.
    expect(readFileSync(join(dst, "fresh.md"), "utf-8")).toBe("fresh\n");
    expect(existsSync(join(dst, "stale.md"))).toBe(false);
    expect(seenBackupRmTargets.length).toBeGreaterThan(0);

    // Orphaned backup temp is acceptable; track for afterEach if it survived both rms.
    for (const bak of seenBackupRmTargets) {
      if (existsSync(bak)) preservedBackups.push(bak);
    }
  });

  it("still fully replaces on the happy path with EXDEV copy+remove fallback", async () => {
    // Guard: mocks must not break the cross-device success path.
    const workspace = freshRoot("replace-exdev-ok-");
    const src = join(workspace, "src");
    const dst = join(workspace, "dst");
    mkdirSync(src, { recursive: true });
    mkdirSync(join(dst, "nested"), { recursive: true });
    writeFileSync(join(src, "ok.md"), "ok\n", "utf-8");
    writeFileSync(join(dst, "nested", "gone.md"), "gone\n", "utf-8");

    vi.mocked(fsp.rename).mockImplementation(async (_from, _to, _options) => {
      const err = new Error("simulated cross-device rename") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    });

    await replaceTree(src, dst);

    expect(readFileSync(join(dst, "ok.md"), "utf-8")).toBe("ok\n");
    expect(existsSync(join(dst, "nested", "gone.md"))).toBe(false);
    // No leftover nested dir from the old tree.
    expect(readdirSync(dst).sort()).toEqual(["ok.md"]);
  });
});
