/**
 * copy-tree.ts — recursively copy a directory tree with file-mode preservation.
 *
 * Mirrors cmd/deft-install/setup.go `copyDir` / `copyFile` (#1477): intermediate
 * directories are created mode 0o755; files keep their source permission bits
 * (including the executable bit for hooks and the `run` launcher).
 *
 * Refs #1942 S1, #1477.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

async function copyFilePreserveMode(src: string, dst: string): Promise<void> {
  let mode = DEFAULT_FILE_MODE;
  try {
    const info = await stat(src);
    mode = info.mode & 0o777;
  } catch {
    // Stat failure is non-fatal — fall back to 0o644 (mirrors Go copyFile).
  }

  await mkdir(dirname(dst), { recursive: true, mode: DEFAULT_DIR_MODE });
  await pipeline(createReadStream(src), createWriteStream(dst, { mode }));
  // createWriteStream mode applies on create; chmod ensures the final bits match
  // the source even when the destination file already existed.
  await chmod(dst, mode);
}

async function copyDirContents(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true, mode: DEFAULT_DIR_MODE });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    const srcStat = await stat(srcPath);
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
