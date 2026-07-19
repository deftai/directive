import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
});

async function fsPromisesWrite(path: string, data: string): Promise<void> {
  const { promises } = await import("node:fs");
  await promises.writeFile(path, data, "utf8");
}
