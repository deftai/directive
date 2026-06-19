import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_SOURCES } from "./constants.js";
import { removeEntryDir } from "./io.js";

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 10_000;
export const ENV_MAX_BYTES = "DEFT_CACHE_MAX_BYTES";
export const ENV_MAX_ENTRIES = "DEFT_CACHE_MAX_ENTRIES";
export const CAP_DISABLED = 0;

export interface CacheCaps {
  maxBytes: number;
  maxEntries: number;
}

export function bytesEnforced(caps: CacheCaps): boolean {
  return caps.maxBytes > 0;
}

export function entriesEnforced(caps: CacheCaps): boolean {
  return caps.maxEntries > 0;
}

export function anyEnforced(caps: CacheCaps): boolean {
  return bytesEnforced(caps) || entriesEnforced(caps);
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) return CAP_DISABLED;
  return value;
}

export function resolveCaps(options?: {
  maxBytes?: number | null;
  maxEntries?: number | null;
}): CacheCaps {
  let maxBytes = options?.maxBytes ?? parseIntEnv(ENV_MAX_BYTES, DEFAULT_MAX_BYTES);
  let maxEntries = options?.maxEntries ?? parseIntEnv(ENV_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
  if (maxBytes < 0) maxBytes = CAP_DISABLED;
  if (maxEntries < 0) maxEntries = CAP_DISABLED;
  return { maxBytes, maxEntries };
}

export interface EntryUsage {
  entryDir: string;
  source: string;
  key: string;
  sizeBytes: number;
  lastAccessed: number;
  metaPresent: boolean;
}

export interface UsageReport {
  totalBytes: number;
  totalEntries: number;
  entries: EntryUsage[];
}

function readMetaSize(metaPath: string): [number, string, string, boolean] {
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    if (typeof meta !== "object" || meta === null) return [0, "", "", false];
    const size = meta.size_bytes;
    const src = meta.source;
    const key = meta.key;
    const sizeBytes = typeof size === "number" && size >= 0 ? size : 0;
    return [
      sizeBytes,
      typeof src === "string" ? src : "",
      typeof key === "string" ? key : "",
      true,
    ];
  } catch {
    return [0, "", "", false];
  }
}

function collectMetaPaths(srcRoot: string): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) {
        walk(full);
      } else if (name.name === "meta.json") {
        found.push(full);
      }
    }
  }
  walk(srcRoot);
  return found;
}

export function scanUsage(
  cacheRoot: string,
  sources: readonly string[] = ALLOWED_SOURCES,
): UsageReport {
  if (!existsSync(cacheRoot)) {
    return { totalBytes: 0, totalEntries: 0, entries: [] };
  }
  const entries: EntryUsage[] = [];
  let totalBytes = 0;
  for (const src of sources) {
    const srcRoot = join(cacheRoot, src);
    if (!existsSync(srcRoot)) continue;
    for (const metaPath of collectMetaPaths(srcRoot)) {
      const [size, metaSrc, metaKey, present] = readMetaSize(metaPath);
      let mtime = 0;
      try {
        mtime = statSync(metaPath).mtimeMs / 1000;
      } catch {
        mtime = 0;
      }
      const relKey =
        metaKey ||
        metaPath
          .slice(srcRoot.length + 1, metaPath.length - "/meta.json".length)
          .split(/[/\\]/)
          .join("/");
      entries.push({
        entryDir: join(metaPath, ".."),
        source: metaSrc || src,
        key: relKey,
        sizeBytes: size,
        lastAccessed: mtime,
        metaPresent: present,
      });
      totalBytes += size;
    }
  }
  return { totalBytes, totalEntries: entries.length, entries };
}

export function lruOrder(usage: UsageReport): EntryUsage[] {
  return [...usage.entries].sort(
    (a, b) => a.lastAccessed - b.lastAccessed || a.entryDir.localeCompare(b.entryDir),
  );
}

export function capBreached(
  usage: UsageReport,
  caps: CacheCaps,
  incomingBytes = 0,
  incomingEntries = 0,
): boolean {
  if (bytesEnforced(caps) && usage.totalBytes + incomingBytes > caps.maxBytes) return true;
  return entriesEnforced(caps) && usage.totalEntries + incomingEntries > caps.maxEntries;
}

export type EvictCallback = (victim: EntryUsage, reason: string, caps: CacheCaps) => void;

export function evictLru(
  cacheRoot: string,
  options: {
    sources?: readonly string[];
    caps: CacheCaps;
    incomingBytes?: number;
    incomingEntries?: number;
    protectKeys?: ReadonlyArray<[string, string]>;
    onEvict?: EvictCallback;
  },
): EntryUsage[] {
  const caps = options.caps;
  if (!anyEnforced(caps)) return [];
  const sources = options.sources ?? ALLOWED_SOURCES;
  const protect = new Set((options.protectKeys ?? []).map(([s, k]) => `${s}\0${k}`));
  const usage = scanUsage(cacheRoot, sources);
  const incomingBytes = options.incomingBytes ?? 0;
  const incomingEntries = options.incomingEntries ?? 0;
  if (!capBreached(usage, caps, incomingBytes, incomingEntries)) return [];

  const ordered = lruOrder(usage).filter((e) => !protect.has(`${e.source}\0${e.key}`));
  if (ordered.length === 0) return [];

  const evicted: EntryUsage[] = [];
  let runningBytes = usage.totalBytes;
  let runningEntries = usage.totalEntries;

  for (const victim of ordered) {
    const bytesBreach = bytesEnforced(caps) && runningBytes + incomingBytes > caps.maxBytes;
    const entriesBreach =
      entriesEnforced(caps) && runningEntries + incomingEntries > caps.maxEntries;
    if (!bytesBreach && !entriesBreach) break;

    const reasons: string[] = [];
    if (bytesBreach) reasons.push("size_cap");
    if (entriesBreach) reasons.push("entry_cap");
    const reason = reasons.join("+") || "unknown";
    options.onEvict?.(victim, reason, caps);
    removeEntryDir(victim.entryDir);
    evicted.push(victim);
    runningBytes -= victim.sizeBytes;
    runningEntries -= 1;
  }
  return evicted;
}

export interface EnforceResult {
  evicted: EntryUsage[];
  finalUsage: UsageReport;
  wouldBreach: boolean;
}

export function predictEvictionSet(
  cacheRoot: string,
  caps: CacheCaps,
  sources: readonly string[] = ALLOWED_SOURCES,
): EntryUsage[] {
  if (!anyEnforced(caps)) return [];
  const usage = scanUsage(cacheRoot, sources);
  if (!capBreached(usage, caps)) return [];
  const ordered = lruOrder(usage);
  const evicted: EntryUsage[] = [];
  let runningBytes = usage.totalBytes;
  let runningEntries = usage.totalEntries;
  for (const entry of ordered) {
    if (
      !(bytesEnforced(caps) && runningBytes > caps.maxBytes) &&
      !(entriesEnforced(caps) && runningEntries > caps.maxEntries)
    ) {
      break;
    }
    evicted.push(entry);
    runningBytes -= entry.sizeBytes;
    runningEntries -= 1;
  }
  return evicted;
}

export function enforceCaps(
  cacheRoot: string,
  options: {
    sources?: readonly string[];
    caps?: CacheCaps | null;
    incomingBytes?: number;
    incomingEntries?: number;
    protectKeys?: ReadonlyArray<[string, string]>;
    onEvict?: EvictCallback;
  } = {},
): EnforceResult {
  const resolved = options.caps ?? resolveCaps();
  const evicted = evictLru(cacheRoot, {
    sources: options.sources,
    caps: resolved,
    incomingBytes: options.incomingBytes,
    incomingEntries: options.incomingEntries,
    protectKeys: options.protectKeys,
    onEvict: options.onEvict,
  });
  const finalUsage = scanUsage(cacheRoot, options.sources);
  const wouldBreach = capBreached(
    finalUsage,
    resolved,
    options.incomingBytes ?? 0,
    options.incomingEntries ?? 0,
  );
  return { evicted, finalUsage, wouldBreach };
}
