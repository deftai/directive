import { ALLOWED_SOURCES } from "./constants.js";
import { CacheValidationError } from "./errors.js";

const VALID_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const VALID_SEMVER_RE = /^\d+\.\d+\.\d+$/;

const META_REQUIRED = [
  "source",
  "key",
  "fetched_at",
  "ttl_seconds",
  "expires_at",
  "scan_result",
  "size_bytes",
  "stale",
] as const;

const META_ALLOWED = new Set([...META_REQUIRED, "etag"]);
const SCAN_RESULT_REQUIRED = ["passed", "scanned_at", "scanner_version", "flags"] as const;
const SCAN_RESULT_ALLOWED = new Set(SCAN_RESULT_REQUIRED);
const SCAN_FLAG_REQUIRED = ["category", "severity", "detail"] as const;
const SCAN_FLAG_ALLOWED = new Set([...SCAN_FLAG_REQUIRED, "match_count"]);
const SCAN_FLAG_CATEGORIES = new Set(["injection-heading", "credentials", "invisible-unicode"]);
const SCAN_FLAG_SEVERITIES = new Set(["fence-and-pass", "hard-fail", "strip-and-pass"]);

function requireKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  path: string,
): void {
  const missing = required.filter((k) => !(k in obj));
  if (missing.length > 0) {
    throw new CacheValidationError(
      `meta.json validation failure at ${path}: missing required keys ${JSON.stringify(missing)}`,
    );
  }
}

function disallowExtras(obj: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    throw new CacheValidationError(
      `meta.json validation failure at ${path}: unknown keys ${JSON.stringify(extra.sort())}`,
    );
  }
}

function isNonNegativeInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateDatetime(value: unknown, path: string): void {
  if (typeof value !== "string" || !VALID_DATETIME_RE.test(value)) {
    throw new CacheValidationError(
      `meta.json validation failure at ${path}: not a UTC-suffixed ISO-8601 timestamp (${JSON.stringify(value)})`,
    );
  }
}

function validateScanFlag(flag: unknown, index: number): void {
  const path = `.scan_result.flags[${index}]`;
  if (flag === null || typeof flag !== "object" || Array.isArray(flag)) {
    throw new CacheValidationError(`meta.json validation failure at ${path}: expected object`);
  }
  const obj = flag as Record<string, unknown>;
  requireKeys(obj, SCAN_FLAG_REQUIRED, path);
  disallowExtras(obj, SCAN_FLAG_ALLOWED, path);
  if (!SCAN_FLAG_CATEGORIES.has(String(obj.category))) {
    throw new CacheValidationError(
      `meta.json validation failure at ${path}.category: ${JSON.stringify(obj.category)} not in ${JSON.stringify([...SCAN_FLAG_CATEGORIES].sort())}`,
    );
  }
  if (!SCAN_FLAG_SEVERITIES.has(String(obj.severity))) {
    throw new CacheValidationError(
      `meta.json validation failure at ${path}.severity: ${JSON.stringify(obj.severity)} not in ${JSON.stringify([...SCAN_FLAG_SEVERITIES].sort())}`,
    );
  }
  if (typeof obj.detail !== "string") {
    throw new CacheValidationError(
      `meta.json validation failure at ${path}.detail: expected string`,
    );
  }
  if ("match_count" in obj && !isNonNegativeInt(obj.match_count)) {
    throw new CacheValidationError(
      `meta.json validation failure at ${path}.match_count: expected non-negative int (got ${JSON.stringify(obj.match_count)})`,
    );
  }
}

function validateScanResult(scanResult: unknown): void {
  if (scanResult === null || typeof scanResult !== "object" || Array.isArray(scanResult)) {
    throw new CacheValidationError("meta.json validation failure at .scan_result: expected object");
  }
  const obj = scanResult as Record<string, unknown>;
  requireKeys(obj, SCAN_RESULT_REQUIRED, ".scan_result");
  disallowExtras(obj, SCAN_RESULT_ALLOWED, ".scan_result");
  if (typeof obj.passed !== "boolean") {
    throw new CacheValidationError(
      "meta.json validation failure at .scan_result.passed: expected bool",
    );
  }
  validateDatetime(obj.scanned_at, ".scan_result.scanned_at");
  const sv = obj.scanner_version;
  if (typeof sv !== "string" || !VALID_SEMVER_RE.test(sv)) {
    throw new CacheValidationError(
      `meta.json validation failure at .scan_result.scanner_version: not a SemVer string (${JSON.stringify(sv)})`,
    );
  }
  if (!Array.isArray(obj.flags)) {
    throw new CacheValidationError(
      "meta.json validation failure at .scan_result.flags: expected array",
    );
  }
  for (let i = 0; i < obj.flags.length; i += 1) {
    validateScanFlag(obj.flags[i], i);
  }
}

function validateMetaEnvelope(
  meta: Record<string, unknown>,
  allowedSources: readonly string[],
): void {
  if (!allowedSources.includes(String(meta.source))) {
    throw new CacheValidationError(
      `meta.json validation failure at .source: ${JSON.stringify(meta.source)} not in ${JSON.stringify([...allowedSources].sort())}`,
    );
  }
  if (typeof meta.key !== "string" || meta.key.length === 0) {
    throw new CacheValidationError(
      "meta.json validation failure at .key: expected non-empty string",
    );
  }
  validateDatetime(meta.fetched_at, ".fetched_at");
  validateDatetime(meta.expires_at, ".expires_at");
  if (!isNonNegativeInt(meta.ttl_seconds)) {
    throw new CacheValidationError(
      `meta.json validation failure at .ttl_seconds: expected non-negative int (got ${JSON.stringify(meta.ttl_seconds)})`,
    );
  }
  if (!isNonNegativeInt(meta.size_bytes)) {
    throw new CacheValidationError(
      `meta.json validation failure at .size_bytes: expected non-negative int (got ${JSON.stringify(meta.size_bytes)})`,
    );
  }
  if (typeof meta.stale !== "boolean") {
    throw new CacheValidationError(
      `meta.json validation failure at .stale: expected bool (got ${JSON.stringify(meta.stale)})`,
    );
  }
  if ("etag" in meta && typeof meta.etag !== "string") {
    throw new CacheValidationError(
      `meta.json validation failure at .etag: expected string when present (got ${JSON.stringify(meta.etag)})`,
    );
  }
}

/** Validate meta against cache-meta.schema.json (mirrors `_cache_validate.validate_meta`). */
export function validateMeta(
  meta: unknown,
  allowedSources: readonly string[] = ALLOWED_SOURCES,
): void {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new CacheValidationError(
      `meta.json validation failure at <root>: expected object, got ${Array.isArray(meta) ? "array" : typeof meta}`,
    );
  }
  const obj = meta as Record<string, unknown>;
  requireKeys(obj, META_REQUIRED, "<root>");
  disallowExtras(obj, META_ALLOWED, "<root>");
  validateMetaEnvelope(obj, allowedSources);
  validateScanResult(obj.scan_result);
}
