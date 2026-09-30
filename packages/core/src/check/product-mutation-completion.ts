/**
 * Durable first-ship product-mutation signal (#4544 Prefer-A).
 *
 * Occupancy last_write_at is erased by occupancy:release and is too coarse for
 * the header gate (stale stamp / missing lease). Persist a cache marker at
 * intentional markWrite so post-release check still sees product-mutation
 * completion while the scaffold header placeholder remains.
 *
 * Marker lookup is fail-closed: absent → Process-only; present → product;
 * unreadable/malformed file → product-write intent that cannot be verified
 * (never silent Process-only pass).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";

/** Project-relative durable marker written beside occupancy markWrite. */
export const PRODUCT_MUTATION_COMPLETION_MARKER_REL = [
  ".deft",
  "cache",
  "product-mutation-completion.json",
] as const;

export interface ProductMutationCompletionMarker {
  readonly recordedAt: string;
}

export type RecordProductMutationCompletionResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/** Prefer-A marker lookup: absent vs present vs corrupt/unreadable. */
export type ProductMutationCompletionLookup =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly recordedAt: string }
  | { readonly kind: "unreadable"; readonly detail: string };

export function productMutationCompletionMarkerPath(projectRoot: string): string {
  return join(resolve(projectRoot), ...PRODUCT_MUTATION_COMPLETION_MARKER_REL);
}

/** Persist that a gated product write completed (survives occupancy:release). */
export function recordProductMutationCompletion(
  projectRoot: string,
  recordedAt: Date = new Date(),
): RecordProductMutationCompletionResult {
  const root = resolve(projectRoot);
  const target = productMutationCompletionMarkerPath(root);
  const marker: ProductMutationCompletionMarker = {
    recordedAt: recordedAt.toISOString(),
  };
  try {
    containedWrite({
      root,
      target,
      data: `${JSON.stringify(marker, null, 2)}\n`,
      mode: "replace",
      mkdir: true,
    });
    return { ok: true, path: target };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: detail };
  }
}

/**
 * Read the Prefer-A durable marker. A present-but-corrupt/unreadable file is
 * product-write intent — callers must fail closed, not treat as Process-only.
 */
export function lookupProductMutationCompletion(
  projectRoot: string,
): ProductMutationCompletionLookup {
  const path = productMutationCompletionMarkerPath(projectRoot);
  if (!existsSync(path)) return { kind: "absent" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "unreadable", detail: "marker JSON is not an object" };
    }
    const recordedAt = (parsed as { recordedAt?: unknown }).recordedAt;
    if (typeof recordedAt !== "string" || recordedAt.trim().length === 0) {
      return { kind: "unreadable", detail: "marker recordedAt missing or empty" };
    }
    return { kind: "present", recordedAt };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "unreadable", detail };
  }
}

/**
 * True only for a valid Prefer-A marker. Occupancy last_write_at alone is not
 * sufficient; unreadable markers are not "absent" — use lookup (#4544).
 */
export function productMutationCompletionAtRoot(projectRoot: string): boolean {
  return lookupProductMutationCompletion(projectRoot).kind === "present";
}
