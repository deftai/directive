import { composeCacheKey, hashTaskInputs } from "./hash.js";
import { readCachedTaskRecord, writeCachedTaskRecord } from "./store.js";
import type { RunWithCacheOptions, TaskRunResult } from "./types.js";

/**
 * Run a task with content-hash caching (#1713).
 * - Only exit-0 results are stored.
 * - Failures always re-run.
 * - Non-cacheable / incomplete inputs fail open to running.
 */
export function runWithCache(options: RunWithCacheOptions): TaskRunResult {
  const { projectRoot, contract, codeVersion, noCache = false, cacheRoot, runner } = options;

  if (noCache || !contract.cacheable) {
    const live = runner();
    return { ...live, fromCache: false };
  }

  const effectiveVersion = contract.codeVersion ?? codeVersion;
  const enumeration = hashTaskInputs(projectRoot, contract, process.env);
  if (!enumeration.complete) {
    const live = runner();
    return { ...live, fromCache: false };
  }

  const cacheKey = composeCacheKey(contract.id, enumeration.digest, effectiveVersion);
  const cached = readCachedTaskRecord(projectRoot, cacheKey, cacheRoot);
  if (cached !== null && cached.codeVersion === effectiveVersion) {
    if (cached.stdout.length > 0) {
      process.stdout.write(cached.stdout);
    }
    if (cached.stderr.length > 0) {
      process.stderr.write(cached.stderr);
    }
    return {
      exitCode: cached.exitCode,
      stdout: cached.stdout,
      stderr: cached.stderr,
      fromCache: true,
    };
  }

  const live = runner();
  if (live.exitCode === 0) {
    writeCachedTaskRecord(
      projectRoot,
      cacheKey,
      {
        taskId: contract.id,
        inputsHash: enumeration.digest,
        codeVersion: effectiveVersion,
        exitCode: live.exitCode,
        stdout: live.stdout,
        stderr: live.stderr,
        storedAt: new Date().toISOString(),
      },
      cacheRoot,
    );
  }
  return { ...live, fromCache: false };
}
