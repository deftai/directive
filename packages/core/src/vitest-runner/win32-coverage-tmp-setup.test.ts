import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import win32CoverageTmpSetup, {
  ensureCoverageTmpDir,
  installCoverageTmpWriteGuard,
  isCoverageTmpChunkPath,
} from "./win32-coverage-tmp-setup.ts";

describe("win32-coverage-tmp-setup (#2634)", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes Vitest coverage chunk paths on posix and win32 spellings", () => {
    expect(isCoverageTmpChunkPath("/repo/coverage/.tmp/coverage-0.json")).toBe(true);
    expect(isCoverageTmpChunkPath("C:\\repo\\coverage\\.tmp\\coverage-12.json")).toBe(true);
    expect(isCoverageTmpChunkPath("/repo/coverage/coverage-final.json")).toBe(false);
    expect(isCoverageTmpChunkPath("/repo/coverage/.tmp/other.json")).toBe(false);
  });

  it("ensureCoverageTmpDir creates coverage/.tmp", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cov-tmp-"));
    tempRoots.push(root);
    const coverageTmp = join(root, "coverage", ".tmp");

    ensureCoverageTmpDir(coverageTmp);
    expect(existsSync(coverageTmp)).toBe(true);
  });

  it("installCoverageTmpWriteGuard mkdirs parent before chunk write", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cov-write-"));
    tempRoots.push(root);
    const chunkPath = join(root, "coverage", ".tmp", "coverage-0.json");
    const uninstall = installCoverageTmpWriteGuard();

    try {
      await fsPromisesWrite(chunkPath, '{"ok":true}\n');
      expect(readFileSync(chunkPath, "utf8")).toBe('{"ok":true}\n');
    } finally {
      uninstall();
    }
  });

  it("installCoverageTmpWriteGuard leaves non-chunk paths untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cov-plain-"));
    tempRoots.push(root);
    const plainPath = join(root, "plain.txt");
    const uninstall = installCoverageTmpWriteGuard();

    try {
      await fsPromisesWrite(plainPath, "hello\n");
      expect(readFileSync(plainPath, "utf8")).toBe("hello\n");
    } finally {
      uninstall();
    }
  });

  it("default setup is a no-op teardown on non-win32 platforms", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const teardown = win32CoverageTmpSetup();
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
    platformSpy.mockRestore();
  });

  it("installCoverageTmpWriteGuard mkdirs parent when path is a Buffer", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cov-buffer-"));
    tempRoots.push(root);
    const chunkPath = join(root, "coverage", ".tmp", "coverage-0.json");
    const uninstall = installCoverageTmpWriteGuard();

    try {
      const { promises } = await import("node:fs");
      await promises.writeFile(Buffer.from(chunkPath, "utf8"), '{"buffer":true}\n', "utf8");
      expect(readFileSync(chunkPath, "utf8")).toBe('{"buffer":true}\n');
    } finally {
      uninstall();
    }
  });

  it("default setup installs the write guard on win32", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const teardown = win32CoverageTmpSetup();
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
    platformSpy.mockRestore();
  });

  it("isCoverageTmpChunkPath rejects non-coverage tmp spellings (#2952)", () => {
    // Regex requires a path separator before `coverage` (posix or win32).
    expect(isCoverageTmpChunkPath("/repo/coverage/.tmp/coverage-0.json")).toBe(true);
    expect(isCoverageTmpChunkPath("C:\\repo\\coverage\\.tmp\\coverage-999.json")).toBe(true);
    expect(isCoverageTmpChunkPath("coverage/.tmp/coverage-0.json")).toBe(false);
    expect(isCoverageTmpChunkPath("/repo/coverage/.tmp/coverage-0.txt")).toBe(false);
    expect(isCoverageTmpChunkPath("/repo/coverage/tmp/coverage-0.json")).toBe(false);
    expect(isCoverageTmpChunkPath("")).toBe(false);
  });

  it("installCoverageTmpWriteGuard is idempotent across uninstall (#2952)", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cov-idem-"));
    tempRoots.push(root);
    const chunkPath = join(root, "coverage", ".tmp", "coverage-1.json");
    const uninstallA = installCoverageTmpWriteGuard();
    const uninstallB = installCoverageTmpWriteGuard();
    try {
      await fsPromisesWrite(chunkPath, '{"idem":true}\n');
      expect(readFileSync(chunkPath, "utf8")).toBe('{"idem":true}\n');
    } finally {
      uninstallB();
      uninstallA();
    }
  });
});

async function fsPromisesWrite(path: string, data: string): Promise<void> {
  const { promises } = await import("node:fs");
  await promises.writeFile(path, data, "utf8");
}
