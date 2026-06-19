import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_SOURCES, REPO_RE, SOURCE_TTL_SECONDS } from "./constants.js";
import {
  CacheCapBreachedError,
  CacheError,
  CacheNotFoundError,
  CacheValidationError,
} from "./errors.js";
import { appendAudit, atomicWriteText, fileSize, removeEntryDir, touchMtime } from "./io.js";
import { pythonJsonDump } from "./json.js";
import { entryDir, validateKey } from "./paths.js";
import {
  type CacheCaps,
  type EntryUsage,
  enforceCaps,
  predictEvictionSet,
  resolveCaps,
} from "./quota.js";
import { flagsForMeta, SCANNER_VERSION, scan } from "./scanner.js";
import { addSeconds, type Clock, parseIso, systemClock, utcIso } from "./time.js";
import type { CacheGetOptions, CachePutOptions, GetResult, PutResult } from "./types.js";
import { validateMeta } from "./validate.js";

function renderContent(source: string, raw: Record<string, unknown>): string {
  if (source === "github-issue") {
    const number = raw.number;
    const title = (raw.title as string | undefined) ?? "";
    const body = (raw.body as string | undefined) ?? "";
    if (typeof number !== "number") {
      throw new CacheError(
        `invalid github-issue raw payload: 'number' must be int (got ${typeof number})`,
      );
    }
    return `# #${number}: ${title}\n\n${body}`;
  }
  throw new CacheError(
    `unknown source '${source}': v1 supports ${JSON.stringify([...ALLOWED_SOURCES].sort())}`,
  );
}

function buildMeta(options: {
  source: string;
  key: string;
  fetchedAt: Date;
  ttlSeconds: number;
  expiresAt: Date;
  scanResult: ReturnType<typeof scan>;
  sizeBytes: number;
  clock: Clock;
}): Record<string, unknown> {
  return {
    source: options.source,
    key: options.key,
    fetched_at: utcIso(options.clock, options.fetchedAt),
    ttl_seconds: options.ttlSeconds,
    expires_at: utcIso(options.clock, options.expiresAt),
    scan_result: {
      passed: options.scanResult.passed,
      scanned_at: options.scanResult.scanned_at,
      scanner_version: options.scanResult.scanner_version,
      flags: flagsForMeta(options.scanResult.flags),
    },
    size_bytes: options.sizeBytes,
    stale: false,
  };
}

function existingEntrySize(edir: string): number | null {
  const metaPath = join(edir, "meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    const size = meta.size_bytes;
    if (typeof size === "number" && size >= 0) return size;
    return 0;
  } catch {
    return 0;
  }
}

function makeEvictAuditCallback(cacheRoot: string, trigger: string, clock: Clock) {
  return (victim: EntryUsage, reason: string): void => {
    const lastAccessedIso =
      victim.lastAccessed > 0 ? utcIso(clock, new Date(victim.lastAccessed * 1000)) : "unknown";
    appendAudit(
      {
        event: "cache:evict",
        source: victim.source,
        key: victim.key,
        timestamp: utcIso(clock),
        reason,
        trigger,
        freed_bytes: victim.sizeBytes,
        last_accessed_at: lastAccessedIso,
      },
      cacheRoot,
    );
  };
}

/** Write a cache entry (mirrors `cache.cache_put`). */
export function cachePut(
  source: string,
  key: string,
  raw: Record<string, unknown>,
  options: CachePutOptions = {},
): PutResult {
  const clock = options.clock ?? systemClock;
  validateKey(source, key);
  const fetched = options.fetchedAt ?? clock.now();
  const ttl =
    options.ttlSeconds !== undefined && options.ttlSeconds !== null
      ? options.ttlSeconds
      : SOURCE_TTL_SECONDS[source];
  if (typeof ttl !== "number" || ttl < 0 || !Number.isInteger(ttl)) {
    throw new CacheError(`ttl_seconds must be a non-negative int (got ${JSON.stringify(ttl)})`);
  }
  const expires = addSeconds(fetched, ttl);
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  const edir = entryDir(source, key, cacheRoot);

  const rawText = pythonJsonDump(raw);
  const rawSize = Buffer.byteLength(rawText, "utf8");

  const existingSize = existingEntrySize(edir);
  const isNewEntry = existingSize === null;
  const incomingDelta = isNewEntry ? rawSize : rawSize - existingSize;
  const incomingEntries = isNewEntry ? 1 : 0;

  const enforceResult = enforceCaps(cacheRoot, {
    caps: options.caps ?? null,
    incomingBytes: incomingDelta,
    incomingEntries,
    protectKeys: [[source, key]],
    onEvict: (victim, reason) => {
      makeEvictAuditCallback(cacheRoot, "cache:put", clock)(victim, reason);
    },
  });

  if (enforceResult.wouldBreach) {
    const resolved = options.caps ?? resolveCaps();
    const reasonParts: string[] = [];
    if (
      resolved.maxBytes > 0 &&
      enforceResult.finalUsage.totalBytes + incomingDelta > resolved.maxBytes
    ) {
      reasonParts.push("size_cap");
    }
    if (
      resolved.maxEntries > 0 &&
      enforceResult.finalUsage.totalEntries + incomingEntries > resolved.maxEntries
    ) {
      reasonParts.push("entry_cap");
    }
    throw new CacheCapBreachedError({
      reason: reasonParts.join("+") || "unknown",
      maxBytes: resolved.maxBytes,
      maxEntries: resolved.maxEntries,
      currentBytes: enforceResult.finalUsage.totalBytes,
      currentEntries: enforceResult.finalUsage.totalEntries,
      incomingBytes: incomingDelta,
    });
  }

  atomicWriteText(join(edir, "raw.json"), rawText);
  const authoritativeSize = fileSize(join(edir, "raw.json"));

  const rendered = renderContent(source, raw);
  const scanResult = scan(rendered, utcIso(clock, fetched));

  const contentPath = join(edir, "content.md");
  let contentWritten = false;
  if (scanResult.passed) {
    atomicWriteText(contentPath, scanResult.transformed_content);
    contentWritten = true;
  } else if (existsSync(contentPath)) {
    try {
      unlinkSync(contentPath);
    } catch {
      /* ignore */
    }
  }

  const meta = buildMeta({
    source,
    key,
    fetchedAt: fetched,
    ttlSeconds: ttl,
    expiresAt: expires,
    scanResult,
    sizeBytes: authoritativeSize,
    clock,
  });
  validateMeta(meta);
  atomicWriteText(join(edir, "meta.json"), pythonJsonDump(meta));

  appendAudit(
    {
      event: "cache:put",
      source,
      key,
      timestamp: utcIso(clock),
      scan_passed: scanResult.passed,
      scanner_version: scanResult.scanner_version,
      flags: scanResult.flags.map((f) => ({
        category: f.category,
        severity: f.severity,
        detail: f.detail,
        match_count: f.match_count,
      })),
      content_written: contentWritten,
    },
    cacheRoot,
  );

  return {
    source,
    key,
    entryDir: edir,
    meta,
    scanResult: {
      passed: scanResult.passed,
      scanner_version: scanResult.scanner_version,
      flags: scanResult.flags,
      transformed_content: scanResult.transformed_content,
      scanned_at: scanResult.scanned_at,
    },
    contentWritten,
  };
}

/** Read a cache entry (mirrors `cache.cache_get`). */
export function cacheGet(source: string, key: string, options: CacheGetOptions = {}): GetResult {
  const clock = options.clock ?? systemClock;
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  const allowStale = options.allowStale ?? true;
  const edir = entryDir(source, key, cacheRoot);
  const metaPath = join(edir, "meta.json");
  if (!existsSync(metaPath)) {
    throw new CacheNotFoundError(
      `cache miss for source='${source}' key='${key}' (expected meta.json at ${metaPath})`,
    );
  }
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    throw new CacheValidationError(`meta.json at ${metaPath} is not valid JSON: ${msg}`);
  }
  validateMeta(meta);

  const expires = parseIso(String(meta.expires_at));
  const isStale = clock.now() > expires;
  if (isStale && !allowStale) {
    throw new CacheNotFoundError(
      `cache entry stale for source='${source}' key='${key}'; expires_at=${meta.expires_at} (pass --allow-stale to override)`,
    );
  }
  meta.stale = isStale;
  touchMtime(metaPath);

  const contentPath = join(edir, "content.md");
  return {
    source,
    key,
    entryDir: edir,
    meta,
    contentPath: existsSync(contentPath) ? contentPath : null,
    stale: isStale,
  };
}

/** Delete entry + audit (mirrors `cache.cache_invalidate`). */
export function cacheInvalidate(
  source: string,
  key: string,
  options: { reason?: string | null; cacheRoot?: string; clock?: Clock } = {},
): boolean {
  const clock = options.clock ?? systemClock;
  validateKey(source, key);
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  const edir = entryDir(source, key, cacheRoot);
  const existed = existsSync(edir);
  if (existed) removeEntryDir(edir);
  appendAudit(
    {
      event: "cache:invalidate",
      source,
      key,
      timestamp: utcIso(clock),
      reason: options.reason ?? "",
      existed,
    },
    cacheRoot,
  );
  return existed;
}

function metaKeyOrRelpath(metaPath: string, srcRoot: string): string {
  const parent = join(metaPath, "..");
  if (parent.startsWith(srcRoot)) {
    return parent
      .slice(srcRoot.length + 1)
      .split(/[/\\]/)
      .join("/");
  }
  return parent;
}

/** Remove entries past TTL threshold (mirrors `cache.cache_prune`). */
export function cachePrune(
  options: {
    olderThanDays?: number;
    source?: string | null;
    dryRun?: boolean;
    cacheRoot?: string;
    clock?: Clock;
  } = {},
): string[] {
  const clock = options.clock ?? systemClock;
  const olderThanDays = options.olderThanDays ?? 30;
  if (olderThanDays < 0) {
    throw new CacheError(`--older-than-days must be >= 0 (got ${JSON.stringify(olderThanDays)})`);
  }
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  if (!existsSync(cacheRoot)) return [];

  const cutoff = addSeconds(clock.now(), -olderThanDays * 24 * 60 * 60);
  const removed: string[] = [];
  const sources = options.source ? [options.source] : [...ALLOWED_SOURCES];

  for (const src of sources) {
    const srcRoot = join(cacheRoot, src);
    if (!existsSync(srcRoot)) continue;
    const metaPaths = collectMetaPathsUnder(srcRoot);
    for (const metaPath of metaPaths) {
      const edir = join(metaPath, "..");
      let expires: Date;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        expires = parseIso(String(meta.expires_at));
      } catch {
        expires = addSeconds(cutoff, -86400);
        meta = {};
      }
      if (expires >= cutoff) continue;
      if (!options.dryRun) {
        removeEntryDir(edir);
        appendAudit(
          {
            event: "cache:prune-entry",
            source: src,
            key: metaKeyOrRelpath(metaPath, srcRoot),
            timestamp: utcIso(clock),
            expires_at:
              typeof meta === "object" && meta !== null && "expires_at" in meta
                ? meta.expires_at
                : "unknown",
          },
          cacheRoot,
        );
      }
      removed.push(edir);
    }
  }
  return removed;
}

function collectMetaPathsUnder(srcRoot: string): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name === "meta.json") found.push(full);
    }
  }
  walk(srcRoot);
  return found;
}

/** LRU-evict until under caps (mirrors `cache.cache_prune_to_cap`). */
export function cachePruneToCap(
  options: { cacheRoot?: string; caps?: CacheCaps | null; dryRun?: boolean; clock?: Clock } = {},
): EntryUsage[] {
  const clock = options.clock ?? systemClock;
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  const resolved = options.caps ?? resolveCaps();
  if (!resolved.maxBytes && !resolved.maxEntries) return [];
  if (options.dryRun) {
    return predictEvictionSet(cacheRoot, resolved);
  }
  const enforceResult = enforceCaps(cacheRoot, {
    caps: resolved,
    onEvict: (victim, reason) => {
      makeEvictAuditCallback(cacheRoot, "cache:prune-to-cap", clock)(victim, reason);
    },
  });
  return enforceResult.evicted;
}

export function isFresh(metaPath: string, clock: Clock = systemClock): boolean {
  if (!existsSync(metaPath)) return false;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    validateMeta(meta);
    const expires = parseIso(String(meta.expires_at));
    return clock.now() <= expires;
  } catch {
    return false;
  }
}

/** Validate repo slug for fetch-all. */
export function validateRepo(repo: string): void {
  if (!REPO_RE.test(repo)) {
    throw new CacheError(
      `invalid --repo '${repo}': expected 'owner/repo' (alphanumerics, '.', '_', '-' only)`,
    );
  }
}

export { SCANNER_VERSION };
