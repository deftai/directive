import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireVitestCliDistBuildLock,
  isStaleVitestCliDistLock,
  releaseVitestCliDistBuildLock,
} from "./cli-dist-global-setup.js";

const LOCK_STALE_MS = 120_000;
const lockFileName = "vitest-cli-dist-build.lock.json";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    releaseVitestCliDistBuildLock(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-dist-lock-"));
  temps.push(root);
  mkdirSync(join(root, ".deft-scratch"), { recursive: true });
  return root;
}

function lockMetaPath(root: string): string {
  return join(root, ".deft-scratch", lockFileName);
}

function writeLockMeta(root: string, meta: { pid: number; startedAt: number }): void {
  writeFileSync(lockMetaPath(root), JSON.stringify(meta));
}

describe("cli-dist-global-setup lock", () => {
  it("treats missing lock metadata as stale", () => {
    const root = fakeRepoRoot();
    expect(isStaleVitestCliDistLock(root)).toBe(true);
  });

  it("treats invalid lock metadata as stale", () => {
    const root = fakeRepoRoot();
    writeFileSync(lockMetaPath(root), "{not-json");
    expect(isStaleVitestCliDistLock(root)).toBe(true);
  });

  it("keeps a fresh lock owned by a live pid", () => {
    const root = fakeRepoRoot();
    writeLockMeta(root, { pid: process.pid, startedAt: Date.now() });
    expect(isStaleVitestCliDistLock(root)).toBe(false);
  });

  it("does not expire locks while the owner pid is still alive", () => {
    const root = fakeRepoRoot();
    writeLockMeta(root, { pid: process.pid, startedAt: Date.now() - LOCK_STALE_MS - 1 });
    expect(isStaleVitestCliDistLock(root)).toBe(false);
  });

  it("expires dead-owner locks older than the stale window", () => {
    const root = fakeRepoRoot();
    writeLockMeta(root, { pid: 999_999, startedAt: Date.now() - LOCK_STALE_MS - 1 });
    expect(isStaleVitestCliDistLock(root)).toBe(true);
  });

  it("acquires, releases, and re-acquires the repo-scoped lock", () => {
    const root = fakeRepoRoot();
    acquireVitestCliDistBuildLock(root);
    expect(existsSync(lockMetaPath(root))).toBe(true);
    releaseVitestCliDistBuildLock(root);
    expect(isStaleVitestCliDistLock(root)).toBe(true);
    acquireVitestCliDistBuildLock(root);
    releaseVitestCliDistBuildLock(root);
  });

  it("reclaims stale locks instead of waiting forever", () => {
    const root = fakeRepoRoot();
    writeLockMeta(root, { pid: 999_999, startedAt: Date.now() - LOCK_STALE_MS - 1 });
    acquireVitestCliDistBuildLock(root, 1_000);
    expect(existsSync(lockMetaPath(root))).toBe(true);
    releaseVitestCliDistBuildLock(root);
  });

  it("times out when an active lock is held", () => {
    const root = fakeRepoRoot();
    acquireVitestCliDistBuildLock(root);
    expect(() => acquireVitestCliDistBuildLock(root, 75)).toThrow(
      "timed out acquiring vitest CLI dist build lock",
    );
    releaseVitestCliDistBuildLock(root);
  });
});
