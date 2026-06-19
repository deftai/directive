import { join } from "node:path";
import { ALLOWED_SOURCES, DEFAULT_CACHE_ROOT, GH_KEY_RE } from "./constants.js";
import { CacheError } from "./errors.js";

/** Validate a cache key for the given source. */
export function validateKey(source: string, key: string): void {
  if (source === "github-issue") {
    if (!GH_KEY_RE.test(key)) {
      throw new CacheError(
        `invalid github-issue key '${key}': expected '<owner>/<repo>/<N>' ` +
          "(alphanumerics, '.', '_', '-' only; N positive integer)",
      );
    }
    return;
  }
  throw new CacheError(
    `unknown source '${source}': v1 supports ${JSON.stringify([...ALLOWED_SOURCES].sort())}`,
  );
}

/** Return `<cacheRoot>/<source>/<key>/` with path segments from `/` in key. */
export function entryDir(source: string, key: string, cacheRoot = DEFAULT_CACHE_ROOT): string {
  if (!ALLOWED_SOURCES.includes(source)) {
    throw new CacheError(
      `unknown source '${source}': v1 supports ${JSON.stringify([...ALLOWED_SOURCES].sort())}`,
    );
  }
  validateKey(source, key);
  return join(cacheRoot, source, ...key.split("/"));
}

/** Return `<cacheRoot>/quarantine-audit.jsonl`. */
export function auditPath(cacheRoot = DEFAULT_CACHE_ROOT): string {
  return join(cacheRoot, "quarantine-audit.jsonl");
}
