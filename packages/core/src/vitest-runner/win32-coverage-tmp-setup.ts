import { promises as fsPromises, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Matches Vitest v8 chunk paths such as coverage/.tmp/coverage-0.json (#2580 / #2634). */
export const COVERAGE_TMP_CHUNK_RE = /[/\\]coverage[/\\]\.tmp[/\\]coverage-\d+\.json$/;

const defaultCoverageTmp = resolve(process.cwd(), "coverage", ".tmp");

export function isCoverageTmpChunkPath(filePath: string): boolean {
  return COVERAGE_TMP_CHUNK_RE.test(filePath.replace(/\\/g, "/"));
}

export function ensureCoverageTmpDir(coverageTmpDir: string = defaultCoverageTmp): void {
  mkdirSync(coverageTmpDir, { recursive: true });
}

/**
 * Vitest 4.x includes the upstream mkdir (vitest-dev/vitest#10117). On Windows the
 * directory can still disappear between clean() and writeFile under release-scale
 * load; mkdir immediately before chunk writes closes that race without
 * soft-failing real threshold failures (#2634 / #3480).
 */
export function installCoverageTmpWriteGuard(): () => void {
  const originalWriteFile = fsPromises.writeFile.bind(fsPromises);

  const patchedWriteFile: typeof fsPromises.writeFile = async (path, ...args) => {
    const target = typeof path === "string" ? path : String(path);
    if (isCoverageTmpChunkPath(target)) {
      mkdirSync(dirname(target), { recursive: true });
    }
    return originalWriteFile(path, ...args);
  };
  fsPromises.writeFile = patchedWriteFile;

  return () => {
    fsPromises.writeFile = originalWriteFile;
  };
}

/**
 * Win32 globalSetup for coverage runs (#2580, hardened #2634).
 *
 * Keepalive mkdir plus a writeFile guard remain until a full win32 coverage
 * run proves vitest 4's #10117 mkdir is enough on its own (#3480).
 */
export default function setup(): () => void {
  if (process.platform !== "win32") return () => {};

  ensureCoverageTmpDir();
  const uninstallWriteGuard = installCoverageTmpWriteGuard();

  const keepalive = setInterval(() => ensureCoverageTmpDir(), 50);
  keepalive.unref?.();

  return () => {
    clearInterval(keepalive);
    uninstallWriteGuard();
  };
}
