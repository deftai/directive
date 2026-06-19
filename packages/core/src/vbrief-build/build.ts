import {
  EMITTED_VBRIEF_VERSION,
  EXTERNAL_REFERENCE_TYPES,
  INTERNAL_REFERENCE_TYPES,
  MIGRATOR_METADATA_KEY,
} from "./constants.js";
import type { JsonObject } from "./types.js";

/** Canonical YYYY-MM-DD date used across ingestion / migration filenames. */
export let TODAY = new Date().toISOString().slice(0, 10);

/** Test hook: pin the module-level TODAY constant. */
export function setTodayForTests(value: string): void {
  TODAY = value;
}

/** Convert a title to a filename-safe slug. */
export function slugify(text: string): string {
  let slug = text.toLowerCase().trim();
  slug = slug.replace(/[^a-z0-9\s_-]/g, "");
  slug = slug.replace(/[\s_]+/g, "-");
  slug = slug.replace(/-+/g, "-");
  return slug.slice(0, 60).replace(/^-+|-+$/g, "");
}

/**
 * Strip trailing ``/`` characters, mirroring Python ``str.rstrip("/")``.
 *
 * A linear loop (no regex) so there is no backtracking — this replaces the
 * polynomial ``/\/+$/`` form CodeQL flagged as ``js/polynomial-redos`` while
 * preserving byte-identical behaviour with the frozen Python oracle.
 */
function stripTrailingSlashes(value: string): string {
  let result = value;
  while (result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

/** Return a copied reference with the default TrustLevel filled when known. */
export function referenceWithDefaultTrust(ref: JsonObject): JsonObject {
  const normalized = structuredClone(ref) as JsonObject;
  if ("TrustLevel" in normalized) {
    return normalized;
  }
  const refType = normalized.type;
  if (typeof refType === "string" && INTERNAL_REFERENCE_TYPES.has(refType)) {
    normalized.TrustLevel = "internal";
  } else if (typeof refType === "string" && EXTERNAL_REFERENCE_TYPES.has(refType)) {
    normalized.TrustLevel = "external";
  }
  return normalized;
}

function githubIssueReference(params: {
  readonly repoUrl: string;
  readonly number: unknown;
  readonly title: unknown;
}): JsonObject | null {
  const cleanedRepo = stripTrailingSlashes(String(params.repoUrl ?? "").trim());
  const cleanedNumber = String(params.number ?? "")
    .trim()
    .replace(/^#+/, "")
    .trim();
  if (!cleanedRepo || !cleanedNumber) {
    return null;
  }
  const cleanedTitle = String(params.title ?? "").trim();
  const refTitle =
    cleanedTitle && cleanedTitle !== "Untitled"
      ? `Issue #${cleanedNumber}: ${cleanedTitle}`
      : `Issue #${cleanedNumber}`;
  return {
    uri: `${cleanedRepo}/issues/${cleanedNumber}`,
    type: "x-vbrief/github-issue",
    title: refTitle,
  };
}

export function referenceHasRequiredFields(ref: JsonObject | null): boolean {
  if (ref === null) {
    return false;
  }
  for (const key of ["uri", "type"] as const) {
    const value = ref[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      return false;
    }
  }
  return true;
}

/** Build a scope vBRIEF dict for a roadmap or issue item. */
export function createScopeVbrief(
  item: JsonObject,
  repoUrl = "",
  status = "pending",
  phaseDescription = "",
): JsonObject {
  const number = String(item.number ?? "")
    .trim()
    .replace(/^#+/, "")
    .trim();
  const title = (String(item.title ?? "Untitled") || "Untitled").trim() || "Untitled";
  const phase = item.phase ?? "";
  const tier = item.tier ?? "";

  const descLabel = number ? `#${number}: ${title}` : title;

  const vbrief: JsonObject = {
    vBRIEFInfo: {
      version: EMITTED_VBRIEF_VERSION,
      description: `Scope vBRIEF for ${descLabel}`,
    },
    plan: {
      title,
      status,
      narratives: {},
      items: [],
    },
  };

  const migratorMeta: Record<string, string> = {};
  if (phase) {
    migratorMeta.Phase = String(phase);
  }
  if (tier) {
    migratorMeta.Tier = String(tier);
  }
  if (phaseDescription) {
    migratorMeta.PhaseDescription = phaseDescription;
  }
  if (Object.keys(migratorMeta).length > 0) {
    const plan = vbrief.plan as JsonObject;
    const metadata = (plan.metadata ?? {}) as JsonObject;
    metadata[MIGRATOR_METADATA_KEY] = migratorMeta;
    plan.metadata = metadata;
  }

  const canonicalRef = githubIssueReference({ repoUrl, number, title });
  const trustedRef =
    referenceHasRequiredFields(canonicalRef) && canonicalRef !== null
      ? referenceWithDefaultTrust(canonicalRef)
      : null;
  if (trustedRef !== null && referenceHasRequiredFields(trustedRef)) {
    (vbrief.plan as JsonObject).references = [trustedRef];
  }

  return vbrief;
}
