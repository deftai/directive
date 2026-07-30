import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../../fs/contained-write.js";
import { DEFAULT_TASK_CACHE_ROOT, TASK_CACHE_MANIFEST } from "./constants.js";
import type { CachedTaskRecord } from "./types.js";

function entryDir(
  projectRoot: string,
  cacheKey: string,
  cacheRoot = DEFAULT_TASK_CACHE_ROOT,
): string {
  return join(resolve(projectRoot), cacheRoot, cacheKey.slice(0, 2), cacheKey);
}

export function readCachedTaskRecord(
  projectRoot: string,
  cacheKey: string,
  cacheRoot = DEFAULT_TASK_CACHE_ROOT,
): CachedTaskRecord | null {
  const manifest = join(entryDir(projectRoot, cacheKey, cacheRoot), TASK_CACHE_MANIFEST);
  try {
    const raw = JSON.parse(readFileSync(manifest, "utf8")) as CachedTaskRecord;
    if (raw.exitCode !== 0) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function writeCachedTaskRecord(
  projectRoot: string,
  cacheKey: string,
  record: CachedTaskRecord,
  cacheRoot = DEFAULT_TASK_CACHE_ROOT,
): void {
  if (record.exitCode !== 0) {
    return;
  }
  const root = resolve(projectRoot);
  const dir = entryDir(projectRoot, cacheKey, cacheRoot);
  const manifest = join(dir, TASK_CACHE_MANIFEST);
  // #2951 Phase 2: product write sink routes through containedWrite (mkdir + replace).
  containedWrite({
    root,
    target: manifest,
    data: `${JSON.stringify(record, null, 2)}\n`,
    mode: "replace",
  });
}

export interface ClearTaskCacheResult {
  readonly code: number;
  readonly removed: boolean;
}

export function clearTaskCache(
  projectRoot: string,
  cacheRoot = DEFAULT_TASK_CACHE_ROOT,
): ClearTaskCacheResult {
  const root = join(resolve(projectRoot), cacheRoot);
  if (!existsSync(root)) {
    return { code: 0, removed: false };
  }
  try {
    rmSync(root, { recursive: true, force: true });
    return { code: 0, removed: true };
  } catch {
    return { code: 1, removed: false };
  }
}

export function taskCacheRoot(projectRoot: string, cacheRoot = DEFAULT_TASK_CACHE_ROOT): string {
  return join(resolve(projectRoot), cacheRoot);
}
