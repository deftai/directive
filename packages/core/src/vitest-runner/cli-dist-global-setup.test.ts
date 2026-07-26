import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import setup, {
  acquireVitestCliDistBuildLock,
  isStaleVitestCliDistLock,
  releaseVitestCliDistBuildLock,
} from "./cli-dist-global-setup.js";

const LOCK_STALE_MS = 120_000;

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

function writeLockMeta(root: string, meta: { pid: number; startedAt: number }): void {
  const lockPath = join(root, ".deft-scratch/vitest-cli-dist-build.lock");
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "meta.json"), JSON.stringify(meta));
}

describe("cli-dist-global-setup lock", () => {
  it("treats missing lock metadata as stale", () => {
    const root = fakeRepoRoot();
    mkdirSync(join(root, ".deft-scratch/vitest-cli-dist-build.lock"), { recursive: true });
    expect(isStaleVitestCliDistLock(root)).toBe(true);
  });

  it("treats invalid lock metadata as stale", () => {
    const root = fakeRepoRoot();
    const metaPath = join(root, ".deft-scratch/vitest-cli-dist-build.lock/meta.json");
    mkdirSync(join(root, ".deft-scratch/vitest-cli-dist-build.lock"), { recursive: true });
    writeFileSync(metaPath, "{not-json");
    expect(isStaleVitestCliDistLock(root)).toBe(true);
  });

  it("keeps a fresh lock owned by a live pid", () => {
    const root = fakeRepoRoot();
    writeLockMeta(root, { pid: process.pid, startedAt: Date.now() });
    expect(isStaleVitestCliDistLock(root)).toBe(false);
  });

  it("expires locks older than the stale window", () => {
    const root = fakeRepoRoot();
    writeLockMeta(root, { pid: process.pid, startedAt: Date.now() - LOCK_STALE_MS - 1 });
    expect(isStaleVitestCliDistLock(root)).toBe(true);
  });

  it("treats locks owned by dead pids as stale", () => {
    const root = fakeRepoRoot();
    writeLockMeta(root, { pid: 999_999, startedAt: Date.now() });
    expect(isStaleVitestCliDistLock(root)).toBe(true);
  });

  it("acquires, releases, and re-acquires the repo-scoped lock", () => {
    const root = fakeRepoRoot();
    acquireVitestCliDistBuildLock(root);
    expect(existsSync(join(root, ".deft-scratch/vitest-cli-dist-build.lock/meta.json"))).toBe(true);
    releaseVitestCliDistBuildLock(root);
    expect(isStaleVitestCliDistLock(root)).toBe(true);
    acquireVitestCliDistBuildLock(root);
    releaseVitestCliDistBuildLock(root);
  });

  it("reclaims stale locks instead of waiting forever", () => {
    const root = fakeRepoRoot();
    writeLockMeta(root, { pid: 999_999, startedAt: Date.now() - LOCK_STALE_MS - 1 });
    acquireVitestCliDistBuildLock(root, 1_000);
    expect(existsSync(join(root, ".deft-scratch/vitest-cli-dist-build.lock/meta.json"))).toBe(true);
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

describe("cli-dist-global-setup", () => {
  it("builds packages/cli dist under the repo lock", () => {
    expect(() => setup()).not.toThrow();
  });
});
