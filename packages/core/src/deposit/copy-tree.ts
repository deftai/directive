/**
 * copy-tree.ts — recursively copy a directory tree with file-mode preservation.
 *
 * Mirrors cmd/deft-install/setup.go `copyDir` / `copyFile` (#1477): intermediate
 * directories are created mode 0o755; files keep their source permission bits
 * (including the executable bit for hooks and the `run` launcher).
 *
 * `replaceTree` is the npm-path counterpart of Go `swapInCore` (#2913): full
 * destination replace so dst-only agent content cannot survive a refresh.
 *
 * Refs #1942 S1, #1477, #2913.
 */

import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isCollectOnlyActive, recordActiveMutation } from "../fs/mutation-ledger.js";

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

async function assertDestinationIsNotSymlink(path: string, label = "copyTree"): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`${label}: refusing to write through destination symlink ${path}`);
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("refusing to write through destination symlink")
    ) {
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
 * This is **additive** — pre-existing destination entries not present in `src`
 * survive. Prefer {@link replaceTree} for deposit refresh integrity (#2913).
 */
export async function copyTree(src: string, dst: string): Promise<void> {
  const srcInfo = await stat(src);
  if (!srcInfo.isDirectory()) {
    throw new Error(`copyTree: source ${src} is not a directory`);
  }
  await copyDirContents(src, dst);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Posix-relative file and symlink paths under `root` (directories are walked). */
async function listRelativeFilePaths(
  root: string,
  options?: { readonly failClosed?: boolean },
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (options?.failClosed === true) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`replaceTree: cannot read ${dir}: ${msg}`);
      }
      return;
    }
    for (const entry of entries) {
      const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(join(dir, entry.name), childRel);
      } else {
        out.push(childRel.replace(/\\/g, "/"));
      }
    }
  }
  await walk(root, "");
  return out;
}

async function destOnlyRelativeFiles(
  src: string,
  dst: string,
  options?: { readonly failClosed?: boolean },
): Promise<string[]> {
  const srcSet = new Set(await listRelativeFilePaths(src, options));
  return (await listRelativeFilePaths(dst, options)).filter((rel) => !srcSet.has(rel));
}

async function readSourceFileOrThrow(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`replaceTree: cannot read ${path}: ${msg}`);
  }
}

async function destContentMatches(dstPath: string, srcBuf: Buffer): Promise<boolean> {
  try {
    const destInfo = await lstat(dstPath);
    if (destInfo.isSymbolicLink() || destInfo.isDirectory()) return false;
    return (await readFile(dstPath)).equals(srcBuf);
  } catch {
    return false;
  }
}

/**
 * Same comparison execute and collect-only use: dest-only deletes plus src
 * files whose dest bytes differ. Unreadable src fails closed (#3437).
 */
async function planReplaceTreeMutations(
  src: string,
  dst: string,
): Promise<{ deleted: string[]; wrote: string[] }> {
  const destOnly = (await pathExists(dst))
    ? await destOnlyRelativeFiles(src, dst, { failClosed: true })
    : [];
  const wrote: string[] = [];
  for (const rel of await listRelativeFilePaths(src, { failClosed: true })) {
    const srcPath = join(src, ...rel.split("/"));
    const dstPath = join(dst, ...rel.split("/"));
    let srcInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      srcInfo = await lstat(srcPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`replaceTree: cannot read ${srcPath}: ${msg}`);
    }
    if (srcInfo.isSymbolicLink()) continue;
    const srcBuf = await readSourceFileOrThrow(srcPath);
    if (await destContentMatches(dstPath, srcBuf)) continue;
    wrote.push(rel);
  }
  return { deleted: destOnly, wrote };
}

function recordReplaceTreePlan(
  dst: string,
  planned: { readonly deleted: readonly string[]; readonly wrote: readonly string[] },
): void {
  for (const rel of planned.deleted) {
    recordActiveMutation("deleted", join(dst, ...rel.split("/")));
  }
  for (const rel of planned.wrote) {
    recordActiveMutation("wrote", join(dst, ...rel.split("/")));
  }
}

/** Record dest-only deletes and content-changing src writes without swapping (#3437). */
async function collectReplaceTreeMutations(src: string, dst: string): Promise<void> {
  recordReplaceTreePlan(dst, await planReplaceTreeMutations(src, dst));
}

/**
 * Move `src` to `dst`, falling back to copy+remove across devices (EXDEV),
 * mirroring Go `movePayload` used by `swapInCore`.
 */
async function moveTree(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true, mode: DEFAULT_DIR_MODE });
  try {
    await rename(src, dst);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM") {
      // On some platforms rename across volumes raises EXDEV; fall through only
      // for cross-device / permission cases that still allow a copy fallback.
      if (code !== "EINVAL") throw err;
    }
  }
  await copyDirContents(src, dst);
  await rm(src, { recursive: true, force: true });
}

/**
 * Full-tree replace of `dst` with the contents of `src` (Go `swapInCore` parity).
 *
 * Stages the new tree out-of-line, moves any existing `dst` aside, then moves
 * the staged tree into place. On failure after the old tree was moved, restores
 * the previous payload. Destination-only files (stale or malicious) do **not**
 * survive — unlike additive {@link copyTree}.
 *
 * Refuses to operate when `dst` itself is a symlink (#2305 / #2912).
 *
 * Refs #2913, #2904 (install-deposit-06).
 */
export async function replaceTree(src: string, dst: string): Promise<void> {
  const srcInfo = await stat(src);
  if (!srcInfo.isDirectory()) {
    throw new Error(`replaceTree: source ${src} is not a directory`);
  }

  await assertDestinationIsNotSymlink(dst, "replaceTree");

  if (isCollectOnlyActive()) {
    await collectReplaceTreeMutations(src, dst);
    return;
  }
  const planned = await planReplaceTreeMutations(src, dst);

  const parent = dirname(dst);
  await mkdir(parent, { recursive: true, mode: DEFAULT_DIR_MODE });

  const staging = await mkdtemp(join(tmpdir(), "deft-core-stage-"));
  let backup: string | null = null;
  /** When true, leave `backup` on disk so an operator can recover after dual failure. */
  let preserveBackupOnExit = false;
  try {
    await copyDirContents(src, staging);

    if (await pathExists(dst)) {
      backup = await mkdtemp(join(tmpdir(), "deft-core-bak-"));
      // mkdtemp created an empty dir; remove it so moveTree can rename onto the path.
      await rm(backup, { recursive: true, force: true });
      try {
        await moveTree(dst, backup);
      } catch (asideErr) {
        // Greptile P1: moveTree may fall back to copy+remove. If removal fails after a
        // successful copy (or after a partial delete of dst), `backup` is the only full
        // recovery copy while dst may already be damaged. Do NOT let `finally` delete it.
        if (await pathExists(backup)) {
          preserveBackupOnExit = true;
        } else {
          backup = null;
        }
        const asideMsg = asideErr instanceof Error ? asideErr.message : String(asideErr);
        throw new Error(
          `replaceTree: failed to move existing destination aside (${asideMsg})` +
            (backup ? ` — recovery copy at ${backup}` : ""),
        );
      }
    }

    try {
      await moveTree(staging, dst);
    } catch (err) {
      if (backup !== null) {
        try {
          if (await pathExists(dst)) {
            await rm(dst, { recursive: true, force: true });
          }
          await moveTree(backup, dst);
          backup = null;
        } catch (restoreErr) {
          preserveBackupOnExit = true;
          const installMsg = err instanceof Error ? err.message : String(err);
          const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          throw new Error(
            `replaceTree: install new payload failed (${installMsg}); ROLLBACK ALSO FAILED (${restoreMsg})` +
              (backup ? ` — previous payload preserved at ${backup}` : ""),
          );
        }
      }
      throw err instanceof Error
        ? err
        : new Error(`replaceTree: install new payload failed: ${String(err)}`);
    }
    // Successful install — best-effort drop the backup (Go keeps it for operator
    // rollback; the npm path does not surface a backup path today and must not
    // litter TEMP). Cleanup MUST NOT fail the replace: the new payload is already
    // live at `dst`. A thrown rm here would reject replaceTree and skip the
    // VERSION stamp in runRefreshDeposit → version drift (Greptile P1).
    if (backup !== null) {
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      backup = null;
    }
    recordReplaceTreePlan(dst, planned);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (backup !== null && !preserveBackupOnExit) {
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
