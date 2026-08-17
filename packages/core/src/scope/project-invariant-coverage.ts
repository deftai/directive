/**
 * Project-invariant coverage + applicability (#3425 Story A).
 *
 * Reuses the #3238 coverage_map parser and side-field rules. `split` is
 * excluded at project level. Optional `not_applicable` requires a reason.
 * Applicability is a pure intersection of contract surface × file_scope.
 */

import { matchAny, matchPath, normalizePath } from "../orchestration/pathspec.js";
import type { ProjectInvariant } from "../policy/project-invariants.js";
import { type CoverageMapEntry, parseBehavioralDeltas, parseCoverageMap } from "./coverage-map.js";

export const PROJECT_INVARIANT_DISPOSITIONS = [
  "covered",
  "deferred",
  "behavioral_delta",
  "not_applicable",
] as const;

export type ProjectInvariantDisposition = (typeof PROJECT_INVARIANT_DISPOSITIONS)[number];

export interface ApplicableInvariant {
  readonly id: string;
  readonly reason: "path" | "module" | "unresolved-module";
}

export interface ProjectInvariantCoverageResult {
  readonly ok: boolean;
  readonly applicableIds: readonly string[];
  readonly missingIds: readonly string[];
  readonly errors: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Strip glob tails so prefix comparison stays path-shaped. */
export function normalizeGlobAsPath(glob: string): string {
  return normalizePath(glob)
    .replace(/\/\*\*.*$/, "")
    .replace(/\/\*$/, "")
    .replace(/\/$/, "");
}

/**
 * True when two path/glob strings can name a shared tree.
 * Bidirectional glob match plus directory-prefix overlap.
 */
export function pathGlobsIntersect(left: string, right: string): boolean {
  const a = normalizePath(left).trim();
  const b = normalizePath(right).trim();
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  if (matchPath(a, b) || matchPath(b, a)) return true;

  const ap = normalizeGlobAsPath(a);
  const bp = normalizeGlobAsPath(b);
  if (ap.length === 0 || bp.length === 0) return false;
  if (ap === bp) return true;
  if (matchAny([a], bp) || matchAny([b], ap)) return true;
  if (ap.startsWith(`${bp}/`) || bp.startsWith(`${ap}/`)) return true;
  return false;
}

function surfacePaths(
  invariant: ProjectInvariant,
  modulePathGlobs: Readonly<Record<string, readonly string[]>>,
): { paths: string[]; unresolvedModuleIds: string[] } {
  const paths = [...invariant.contractSurface.paths];
  const unresolvedModuleIds: string[] = [];
  for (const moduleId of invariant.contractSurface.moduleIds) {
    const mapped = modulePathGlobs[moduleId];
    if (mapped === undefined || mapped.length === 0) {
      unresolvedModuleIds.push(moduleId);
      continue;
    }
    paths.push(...mapped);
  }
  return { paths, unresolvedModuleIds };
}

function anyPathOverlap(left: readonly string[], right: readonly string[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (pathGlobsIntersect(a, b)) return true;
    }
  }
  return false;
}

/**
 * Invariants whose contract surface intersects `fileScope`.
 * Empty file_scope → empty intersection (no disposition required).
 * Unresolved module ids (no pathGlobs mapping) are treated as applicable.
 */
export function applicableProjectInvariants(
  invariants: readonly ProjectInvariant[],
  fileScope: readonly string[],
  modulePathGlobs: Readonly<Record<string, readonly string[]>> = {},
): ApplicableInvariant[] {
  const scope = fileScope.map((s) => s.trim()).filter((s) => s.length > 0);
  if (scope.length === 0) return [];

  const out: ApplicableInvariant[] = [];
  for (const invariant of invariants) {
    const { paths, unresolvedModuleIds } = surfacePaths(invariant, modulePathGlobs);
    if (unresolvedModuleIds.length > 0) {
      out.push({ id: invariant.id, reason: "unresolved-module" });
      continue;
    }
    if (anyPathOverlap(paths, scope)) {
      const viaModule = invariant.contractSurface.moduleIds.length > 0 && paths.length > 0;
      out.push({
        id: invariant.id,
        reason: viaModule && invariant.contractSurface.paths.length === 0 ? "module" : "path",
      });
    }
  }
  return out;
}

interface PeeledNotApplicable {
  readonly id: string;
  readonly reason: string | null;
  readonly loc: string;
}

function peelNotApplicable(raw: unknown): {
  remainder: unknown;
  notApplicable: PeeledNotApplicable[];
  errors: string[];
} {
  const notApplicable: PeeledNotApplicable[] = [];
  const errors: string[] = [];

  if (raw === null || raw === undefined) {
    return { remainder: raw, notApplicable, errors };
  }

  const takeReason = (body: Record<string, unknown>): string | null => {
    const nested = asRecord(body.provenance);
    const reason = nested?.reason ?? body.reason;
    return isNonEmptyString(reason) ? reason.trim() : null;
  };

  if (Array.isArray(raw)) {
    const remainder: unknown[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const item = raw[i];
      const loc = `coverage_map[${i}]`;
      const rec = asRecord(item);
      if (rec === null) {
        remainder.push(item);
        continue;
      }
      const disposition = rec.disposition;
      if (
        typeof disposition === "string" &&
        disposition.trim().toLowerCase() === "not_applicable"
      ) {
        const id = rec.parent_requirement_id ?? rec.parentRequirementId ?? rec.id;
        if (!isNonEmptyString(id)) {
          errors.push(`${loc}: parent_requirement_id is required`);
          continue;
        }
        const reason = takeReason(rec);
        if (reason === null) {
          errors.push(`${loc}: disposition not_applicable requires reason`);
        }
        notApplicable.push({ id: id.trim(), reason, loc });
        continue;
      }
      remainder.push(item);
    }
    return { remainder, notApplicable, errors };
  }

  const map = asRecord(raw);
  if (map === null) {
    return { remainder: raw, notApplicable, errors };
  }

  const remainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    const loc = `coverage_map[${key}]`;
    const rec = asRecord(value);
    if (rec === null) {
      remainder[key] = value;
      continue;
    }
    const disposition = rec.disposition;
    if (typeof disposition === "string" && disposition.trim().toLowerCase() === "not_applicable") {
      const id = rec.parent_requirement_id ?? rec.parentRequirementId ?? key;
      if (!isNonEmptyString(id)) {
        errors.push(`${loc}: parent_requirement_id is required`);
        continue;
      }
      const reason = takeReason(rec);
      if (reason === null) {
        errors.push(`${loc}: disposition not_applicable requires reason`);
      }
      notApplicable.push({ id: String(id).trim(), reason, loc });
      continue;
    }
    remainder[key] = value;
  }
  return { remainder, notApplicable, errors };
}

function extractCoverageRaw(draft: unknown): unknown {
  const rec = asRecord(draft);
  if (rec === null) return undefined;
  if (rec.coverage_map !== undefined || rec.coverageMap !== undefined) {
    return rec.coverage_map ?? rec.coverageMap;
  }
  const plan = asRecord(rec.plan);
  if (plan === null) return undefined;
  if (plan.coverage_map !== undefined || plan.coverageMap !== undefined) {
    return plan.coverage_map ?? plan.coverageMap;
  }
  const metadata = asRecord(plan.metadata);
  if (metadata === null) return undefined;
  return metadata.coverage_map ?? metadata.coverageMap;
}

function extractDeltasRaw(draft: unknown): unknown {
  const rec = asRecord(draft);
  if (rec === null) return undefined;
  if (rec.behavioral_deltas !== undefined || rec.behavioralDeltas !== undefined) {
    return rec.behavioral_deltas ?? rec.behavioralDeltas;
  }
  const plan = asRecord(rec.plan);
  if (plan === null) return undefined;
  return plan.behavioral_deltas ?? plan.behavioralDeltas;
}

/**
 * Completeness of coverage_map dispositions for applicable project invariant IDs.
 * Extra coverage_map keys (e.g. parent requirement IDs) are ignored.
 * Empty applicable set is a no-op success.
 */
export function validateProjectInvariantCoverage(opts: {
  applicableIds: readonly string[];
  draft: unknown;
}): ProjectInvariantCoverageResult {
  const applicableIds = [...new Set(opts.applicableIds.map((id) => id.trim()).filter(Boolean))];
  const errors: string[] = [];

  const coverageRaw = extractCoverageRaw(opts.draft);
  const peeled = peelNotApplicable(coverageRaw);
  errors.push(...peeled.errors);

  const { entries, errors: mapErrors } = parseCoverageMap(peeled.remainder);
  errors.push(...mapErrors);

  const { byId: deltasById, errors: deltaErrors } = parseBehavioralDeltas(
    extractDeltasRaw(opts.draft),
  );
  errors.push(...deltaErrors);

  const byId = new Map<string, CoverageMapEntry>();
  for (const entry of entries) {
    if (entry.disposition === "split") {
      errors.push(
        `coverage_map[${entry.parent_requirement_id}]: disposition split is excluded at project level`,
      );
      continue;
    }
    if (byId.has(entry.parent_requirement_id)) {
      errors.push(
        `coverage_map[${entry.parent_requirement_id}]: duplicate coverage entries ` +
          `(one disposition per project invariant ID)`,
      );
      continue;
    }
    byId.set(entry.parent_requirement_id, entry);

    if (entry.disposition === "behavioral_delta") {
      const deltaId = entry.delta_id;
      if (isNonEmptyString(deltaId) && !deltasById.has(deltaId)) {
        errors.push(
          `coverage_map[${entry.parent_requirement_id}]: behavioral_delta delta_id '${deltaId}' ` +
            `has no linked record in behavioral_deltas`,
        );
      }
    }
  }

  const addressed = new Set<string>();
  for (const na of peeled.notApplicable) {
    addressed.add(na.id);
  }
  for (const id of byId.keys()) {
    addressed.add(id);
  }

  const missingIds = applicableIds.filter((id) => !addressed.has(id));
  if (missingIds.length > 0) {
    errors.push(
      `uncovered applicable project invariant IDs: ${missingIds.join(", ")} ` +
        `(declare coverage_map[<id>].disposition as ${PROJECT_INVARIANT_DISPOSITIONS.join("|")})`,
    );
  }

  return {
    ok: errors.length === 0,
    applicableIds,
    missingIds,
    errors,
  };
}
