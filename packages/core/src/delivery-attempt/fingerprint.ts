/**
 * Failure fingerprinting for delivery-attempt circuit breaker (#3143).
 *
 * Free-form model judgment alone is not sufficient. Prefer structured
 * stage/code fields; normalize volatile identifiers out of messages.
 */

import { createHash } from "node:crypto";
import type { FailureInfo, Retryability } from "./types.js";

/** Strip volatile tokens that must not affect fingerprint stability. */
const VOLATILE_PATTERNS: readonly RegExp[] = [
  // ISO timestamps first
  /\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/gi,
  // UUIDs before long digit runs (UUID tail is 12 hex digits)
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Hex digests (git SHAs etc.)
  /\b[0-9a-f]{40}\b/gi,
  /\b[0-9a-f]{64}\b/gi,
  // Epoch-ish numbers (after UUID so 12-digit UUID tails are not partially eaten)
  /\b\d{10,13}\b/g,
  // Absolute / home paths
  /(?:[A-Za-z]:)?(?:\\|\/)(?:Users|home|tmp|var|private)[^\s'"]+/gi,
  /(?:[A-Za-z]:\\|[\\/])[^\s'"]+/g,
  // Secret-like assignments
  /\b(?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi,
  /Bearer\s+\S+/gi,
  // Run / attempt ids
  /\b(?:run|attempt|job)[-_]?id[=:]\s*\S+/gi,
  // Line numbers that churn
  /:\d+(?::\d+)?/g,
];

/**
 * Normalize a free-form failure message for fingerprinting.
 * Removes volatile identifiers, timestamps, paths, and secret-like values.
 */
export function normalizeFailureMessage(message: string | null | undefined): string {
  if (message === null || message === undefined) return "";
  let out = message.normalize("NFKC");
  for (const re of VOLATILE_PATTERNS) {
    out = out.replace(re, "<redacted>");
  }
  return out
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s.<>=/_-]/g, "")
    .trim()
    .slice(0, 512);
}

export interface FingerprintInput {
  readonly stage: string;
  readonly code?: string | null;
  readonly message?: string | null;
  readonly resourceClass?: string | null;
  readonly retryability?: Retryability | null;
}

/**
 * Derive a stable redacted fingerprint from structured failure fields.
 * SHA-256 hex truncated to 32 chars for compact ledger storage.
 */
export function computeFailureFingerprint(input: FingerprintInput): string {
  const stage = (input.stage ?? "unknown").trim().toLowerCase() || "unknown";
  const code = (input.code ?? "").trim().toLowerCase();
  const resource = (input.resourceClass ?? "").trim().toLowerCase();
  const msg = normalizeFailureMessage(input.message);
  const material = [stage, code, resource, msg].join("|");
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}

/**
 * Build a FailureInfo from structured fields.
 * Defaults retryability to `unknown` when not provided.
 */
export function buildFailureInfo(input: FingerprintInput): FailureInfo {
  const stage = (input.stage ?? "unknown").trim() || "unknown";
  const code =
    input.code === null || input.code === undefined || String(input.code).trim() === ""
      ? null
      : String(input.code).trim();
  const resourceClass =
    input.resourceClass === null ||
    input.resourceClass === undefined ||
    String(input.resourceClass).trim() === ""
      ? null
      : String(input.resourceClass).trim();
  return {
    stage,
    code,
    fingerprint: computeFailureFingerprint({
      stage,
      code,
      message: input.message,
      resourceClass,
    }),
    retryability: input.retryability ?? "unknown",
    resourceClass,
  };
}

/** Infer retryability from structured code when adapter does not set it. */
export function inferRetryability(code: string | null | undefined): Retryability {
  if (code === null || code === undefined || code.trim() === "") return "unknown";
  const c = code.trim().toUpperCase();
  if (
    /TIMEOUT|THROTTLE|RATE_LIMIT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|503|429|UNAVAILABLE|TEMPORARY/.test(
      c,
    )
  ) {
    return "transient";
  }
  if (
    /SCHEMA|CONFIG|PERMISSION|AUTHZ|FORBIDDEN|INVALID|VALIDATION|NOT_FOUND|404|401|403|PRECONDITION|INVARIANT/.test(
      c,
    )
  ) {
    return "deterministic";
  }
  return "unknown";
}
