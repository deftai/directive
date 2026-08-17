/**
 * intent-extract-v1 digest (#3376 R2 / #3385).
 *
 * sortKeysDeep, items[] by id (done at extract), NFC, compact stringify, sha256.
 */

import { createHash } from "node:crypto";

export const INTENT_DIGEST_ALGO = "intent-extract-v1" as const;

export function nfcString(value: string): string {
  return value.normalize("NFC");
}

/** Deep-sort object keys and NFC-normalize strings. Arrays keep order. */
export function sortKeysDeep(value: unknown): unknown {
  if (typeof value === "string") return nfcString(value);
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort((a, b) => a.localeCompare(b))) {
      out[key] = sortKeysDeep(rec[key]);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical preimage. */
export function computeIntentDigest(preimage: unknown): string {
  const canonical = sortKeysDeep(preimage);
  const payload = JSON.stringify(canonical);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
