/**
 * copy-tree.ts — recursively copy a directory tree with file-mode preservation.
 *
 * Mirrors cmd/deft-install/setup.go `copyDir` / `copyFile` (#1477): intermediate
 * directories are created mode 0o755; files keep their source permission bits
 * (including the executable bit for hooks and the `run` launcher).
 *
 * Refs #1942 S1, #1477.
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

async function assertDestinationIsNotSymlink(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`copyTree: refusing to write through destination symlink ${path}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("copyTree: refusing")) {
      throw err;
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Missing paths are created by the caller; only pre-existing symlinks matter.
      return;
    }
    throw err;
  }
}

async function copyFilePreserveMode(src: string, dst: string): Promise<void> {
  let mode = DEFAULT_FILE_MODE;
  try {
    const info = await stat(src);
    mode = info.mode & 0o777;
  } catch {
    // Stat failure is non-fatal — fall back to 0o644 (mirrors Go copyFile).
  }

  await mkdir(dirname(dst), { recursive: true, mode: DEFAULT_DIR_MODE });
  await assertDestinationIsNotSymlink(dst);
  const handle = await open(
    dst,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(await readFile(src));
    // Use the opened handle, not the path, so chmod cannot follow a swapped symlink.
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function copyDirContents(src: string, dst: string): Promise<void> {
  await assertDestinationIsNotSymlink(dst);
  await mkdir(dst, { recursive: true, mode: DEFAULT_DIR_MODE });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    // #2305: lstat (not stat) so a symlinked entry is NOT followed silently.
    // The deposit copies regular files/dirs only; a symlink in the (trusted)
    // payload is skipped rather than dereferenced.
    const srcStat = await lstat(srcPath);
    if (srcStat.isSymbolicLink()) {
      continue;
    }
    if (srcStat.isDirectory()) {
      await copyDirContents(srcPath, dstPath);
    } else {
      await copyFilePreserveMode(srcPath, dstPath);
    }
  }
}

/**
 * Recursively copy `src` into `dst`, preserving nested structure and file modes.
 *
 * The contents of `src` are placed under `dst` (equivalent to Go `copyDir`).
 */
export async function copyTree(src: string, dst: string): Promise<void> {
  const srcInfo = await stat(src);
  if (!srcInfo.isDirectory()) {
    throw new Error(`copyTree: source ${src} is not a directory`);
  }
  await copyDirContents(src, dst);
}
