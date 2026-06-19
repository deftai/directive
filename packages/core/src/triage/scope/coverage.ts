import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CACHE_DIR_NAME,
  COVERAGE_FILENAME,
  DEFAULT_COVERAGE_TTL_HOURS,
  ENV_COVERAGE_TTL_HOURS,
} from "./constants.js";
import { parseIso, utcIso, utcNow } from "./time.js";

export interface CoverageRecord {
  readonly count: number;
  readonly fetchedAt: string;
  readonly subscriptionHash: string;
  readonly stale: boolean;
  readonly ageHours: number | null;
}

export function coveragePath(
  source: string,
  repo: string,
  options: { projectRoot?: string; cacheRoot?: string } = {},
): string {
  if (!repo.includes("/")) {
    throw new Error(`repo must be 'owner/name'; got ${JSON.stringify(repo)}`);
  }
  const root =
    options.cacheRoot !== undefined
      ? resolve(options.cacheRoot)
      : join(resolve(options.projectRoot ?? "."), CACHE_DIR_NAME);
  const owner = repo.split("/", 2)[0] ?? "";
  const name = repo.split("/", 2)[1] ?? "";
  return join(root, source, owner, name, COVERAGE_FILENAME);
}

export function coverageTtlHours(): number {
  const raw = process.env[ENV_COVERAGE_TTL_HOURS] ?? "";
  if (!raw) return DEFAULT_COVERAGE_TTL_HOURS;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) return DEFAULT_COVERAGE_TTL_HOURS;
  return value;
}

export function writeCoverageDenominator(
  path: string,
  options: { count: number; subscriptionHashValue: string; fetchedAt?: Date },
): CoverageRecord {
  if (options.count < 0) {
    throw new Error(`count must be >= 0; got ${options.count}`);
  }
  if (!options.subscriptionHashValue) {
    throw new Error("subscription_hash_value must be a non-empty string");
  }
  const stamp = utcIso(options.fetchedAt ?? null);
  mkdirSync(join(path, ".."), { recursive: true });
  const payload = {
    count: options.count,
    fetched_at: stamp,
    subscription_hash: options.subscriptionHashValue,
  };
  writeFileSync(path, `${JSON.stringify(payload, Object.keys(payload).sort())}\n`, "utf8");
  return {
    count: options.count,
    fetchedAt: stamp,
    subscriptionHash: options.subscriptionHashValue,
    stale: false,
    ageHours: 0,
  };
}

export function readCoverageDenominator(
  path: string,
  options: { currentHash: string; ttlHours?: number; now?: Date },
): CoverageRecord | null {
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const count = rec.count;
  const fetchedAt = rec.fetched_at;
  const storedHash = rec.subscription_hash;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  if (typeof fetchedAt !== "string" || !fetchedAt) return null;
  if (typeof storedHash !== "string" || !storedHash) return null;

  const effectiveTtl =
    options.ttlHours !== undefined ? Math.max(0, options.ttlHours) : coverageTtlHours();
  const nowDt = options.now ?? utcNow();
  let fetchedDt: Date;
  try {
    fetchedDt = parseIso(fetchedAt);
  } catch {
    return null;
  }
  const ageSeconds = Math.max(0, (nowDt.getTime() - fetchedDt.getTime()) / 1000);
  const ageHours = ageSeconds / 3600;
  const ttlStale = effectiveTtl > 0 && ageHours > effectiveTtl;
  const hashStale = storedHash !== options.currentHash;

  return {
    count,
    fetchedAt,
    subscriptionHash: storedHash,
    stale: Boolean(ttlStale || hashStale),
    ageHours,
  };
}

export function formatCoverageDisplay(numerator: number, record: CoverageRecord | null): string {
  if (record === null || record.stale) return `${numerator}/?`;
  return `${numerator}/${record.count}`;
}
