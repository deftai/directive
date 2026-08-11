/**
 * Parent-lineage gates for story-ready and pre-PR/preflight (#3241 / epic #3237).
 *
 * After #3238 coverage artifacts exist, a green child can still contradict parent
 * invariants unless build/review gates re-check structure. This module:
 *   - resolves parent via plan.planRef (or plan references)
 *   - when parent authors requirement IDs, requires child coverage artifacts
 *   - reuses validateCoverageMap (structure-only; no LLM judgment)
 *   - classifies defects: child_spec | parent_child_drift
 *
 * Backward compatible: no parent link, or parent with zero requirement IDs → N/A pass.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  type CoverageReport,
  extractParentRequirements,
  formatCoverageReportLine,
  validateCoverageMap,
} from "./coverage-map.js";

export const PARENT_LINEAGE_SCHEMA = "deft.scope.parent_lineage.v1" as const;

/** Lifecycle folders searched when a child's planRef points at a moved parent (#3241 P1). */
const LIFECYCLE_FOLDERS_FOR_PARENT_LOOKUP = [
  "pending",
  "active",
  "completed",
  "proposed",
  "cancelled",
] as const;

/** Defect classes for gate output (#3241 AC: distinguish child-spec vs parent/child drift). */
export const LINEAGE_DEFECT_CLASSES = ["child_spec", "parent_child_drift"] as const;
export type LineageDefectClass = (typeof LINEAGE_DEFECT_CLASSES)[number];

export interface ParentLineageResult {
  readonly ok: boolean;
  /** False when lineage does not apply (no parent / parent has no requirement IDs). */
  readonly applicable: boolean;
  readonly defect_class: LineageDefectClass | null;
  readonly message: string;
  readonly parent_path: string | null;
  readonly parent_requirement_ids: readonly string[];
  readonly negative_invariant_ids: readonly string[];
  readonly coverage_report: CoverageReport | null;
  readonly errors: readonly string[];
}

type JsonObj = Record<string, unknown>;

function asRecord(value: unknown): JsonObj | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObj;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Walk up from a child artifact path to find the lifecycle root (xbrief/ or vbrief/).
 */
export function findLifecycleRootFromArtifact(artifactPath: string): string | null {
  let current = resolve(dirname(artifactPath));
  for (let i = 0; i < 8; i += 1) {
    const base = current.split(/[/\\]/).pop()?.toLowerCase() ?? "";
    if (base === "xbrief" || base === "vbrief") {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolve plan.planRef (or similar relative ref) against a lifecycle root.
 * Rejects absolute paths and `..` traversal.
 */
export function resolveParentPathFromRef(
  planRef: string,
  lifecycleRoot: string,
): { path: string | null; error: string | null } {
  const trimmed = planRef.trim();
  if (!trimmed) {
    return { path: null, error: "empty planRef" };
  }
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { path: null, error: `planRef must be relative to lifecycle root (got absolute)` };
  }
  const segments = trimmed.split(/[/\\]+/).filter((s) => s.length > 0);
  if (segments.includes("..")) {
    return { path: null, error: `planRef must not contain parent traversal (..)` };
  }
  // Strip leading xbrief/ or vbrief/ if present (planRef is often relative to lifecycle root).
  const first = segments[0]?.toLowerCase();
  const relSegments = first === "xbrief" || first === "vbrief" ? segments.slice(1) : segments;
  const resolved = resolve(lifecycleRoot, ...relSegments);
  const rootResolved = resolve(lifecycleRoot);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    return { path: null, error: `planRef escapes lifecycle root` };
  }
  return { path: resolved, error: null };
}

/**
 * Extract coverage draft surface from a child xBRIEF for validateCoverageMap.
 * Prefer plan.metadata.parent_lineage, then plan.metadata, then plan/root.
 */
export function extractChildCoverageDraft(child: unknown): {
  draft: JsonObj | null;
  source: string | null;
  hasCoverageMapKey: boolean;
} {
  const root = asRecord(child);
  if (root === null) {
    return { draft: null, source: null, hasCoverageMapKey: false };
  }
  const plan = asRecord(root.plan) ?? root;
  const metadata = asRecord(plan.metadata);

  const candidates: Array<{ source: string; obj: JsonObj }> = [];

  if (metadata !== null) {
    const lineage = asRecord(metadata.parent_lineage ?? metadata.parentLineage);
    if (lineage !== null) {
      candidates.push({ source: "plan.metadata.parent_lineage", obj: lineage });
    }
    candidates.push({ source: "plan.metadata", obj: metadata });
  }
  candidates.push({ source: "plan", obj: plan });
  candidates.push({ source: "root", obj: root });

  for (const c of candidates) {
    const hasMap =
      "coverage_map" in c.obj ||
      "coverageMap" in c.obj ||
      asRecord(c.obj.coverage)?.coverage_map !== undefined;
    if (!hasMap) continue;
    const coverageNested = asRecord(c.obj.coverage);
    const coverage_map =
      c.obj.coverage_map ??
      c.obj.coverageMap ??
      coverageNested?.coverage_map ??
      coverageNested?.coverageMap;
    const behavioral_deltas =
      c.obj.behavioral_deltas ??
      c.obj.behavioralDeltas ??
      coverageNested?.behavioral_deltas ??
      coverageNested?.behavioralDeltas;
    return {
      draft: {
        coverage_map,
        behavioral_deltas,
      },
      source: c.source,
      hasCoverageMapKey: true,
    };
  }

  return { draft: null, source: null, hasCoverageMapKey: false };
}

/**
 * Build the parent_lineage metadata block stamped onto decomposed children (#3241).
 */
export function buildParentLineageArtifact(opts: {
  coverage_map?: unknown;
  behavioral_deltas?: unknown;
  parent_requirement_ids?: readonly string[];
  negative_invariant_ids?: readonly string[];
}): JsonObj {
  const out: JsonObj = {
    schema: PARENT_LINEAGE_SCHEMA,
  };
  if (opts.coverage_map !== undefined) {
    out.coverage_map = opts.coverage_map;
  }
  if (opts.behavioral_deltas !== undefined) {
    out.behavioral_deltas = opts.behavioral_deltas;
  }
  if (opts.parent_requirement_ids !== undefined) {
    out.parent_requirement_ids = [...opts.parent_requirement_ids];
  }
  if (opts.negative_invariant_ids !== undefined) {
    out.negative_invariant_ids = [...opts.negative_invariant_ids];
  }
  return out;
}

function resolveParentRefFromChild(child: JsonObj): string | null {
  const plan = asRecord(child.plan) ?? child;
  if (isNonEmptyString(plan.planRef)) return plan.planRef.trim();
  if (isNonEmptyString(plan.plan_ref)) return plan.plan_ref.trim();

  const refs = plan.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      const r = asRecord(ref);
      if (r === null) continue;
      const type = String(r.type ?? "").toLowerCase();
      // Parent plan provenance: x-xbrief/plan or x-vbrief/plan (or plain plan).
      if (
        type === "plan" ||
        type.endsWith("/plan") ||
        type.includes("xbrief/plan") ||
        type.includes("vbrief/plan")
      ) {
        if (isNonEmptyString(r.uri)) {
          const uri = r.uri.trim();
          // Skip issue/github URIs.
          if (uri.startsWith("http://") || uri.startsWith("https://") || uri.startsWith("#")) {
            continue;
          }
          return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
        }
      }
    }
  }
  return null;
}

function loadJsonFile(path: string): { ok: true; data: JsonObj } | { ok: false; error: string } {
  try {
    if (!existsSync(path)) {
      return { ok: false, error: `parent not found at ${path}` };
    }
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as unknown;
    const rec = asRecord(data);
    if (rec === null) {
      return { ok: false, error: `parent at ${path} is not a JSON object` };
    }
    return { ok: true, data: rec };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `could not load parent at ${path}: ${String((err as Error).message ?? err)}`,
    };
  }
}

/**
 * Load parent at the resolved planRef path; if missing, search other lifecycle
 * folders for the same basename (tolerates best-effort planRef rewrite lag after
 * parent moves — Greptile #3241 P1).
 */
export function loadParentWithLifecycleFallback(
  parentPath: string,
  lifecycleRoot: string | null,
): { ok: true; data: JsonObj; path: string } | { ok: false; error: string; path: string } {
  const primary = loadJsonFile(parentPath);
  if (primary.ok) {
    return { ok: true, data: primary.data, path: parentPath };
  }
  if (lifecycleRoot === null) {
    return { ok: false, error: primary.error, path: parentPath };
  }
  const name = basename(parentPath);
  if (!name || name === "." || name === "..") {
    return { ok: false, error: primary.error, path: parentPath };
  }
  for (const folder of LIFECYCLE_FOLDERS_FOR_PARENT_LOOKUP) {
    const candidate = join(lifecycleRoot, folder, name);
    if (resolve(candidate) === resolve(parentPath)) continue;
    if (!existsSync(candidate)) continue;
    const loaded = loadJsonFile(candidate);
    if (loaded.ok) {
      return { ok: true, data: loaded.data, path: candidate };
    }
  }
  return {
    ok: false,
    error:
      `${primary.error}; also searched lifecycle folders for basename '${name}' ` +
      `(planRef may lag a parent move — rewrite child planRef or restore parent)`,
    path: parentPath,
  };
}

function classifyCoverageFailure(errors: readonly string[]): LineageDefectClass {
  // Missing map / parse shape issues are child-spec; uncovered/conflict vs parent is drift.
  const childSpecHints = [
    "coverage_map is required",
    "coverage_map must be",
    "disposition must be",
    "missing/invalid fields",
    "parent_requirement_id is required",
    "missing delta_id",
    "requires delta_id",
    "requires provenance",
    "requires split_group",
    "requires part",
    "behavioral_deltas must be",
  ];
  for (const e of errors) {
    const lower = e.toLowerCase();
    if (childSpecHints.some((h) => lower.includes(h.toLowerCase()))) {
      return "child_spec";
    }
  }
  return "parent_child_drift";
}

function okResult(
  partial: Omit<ParentLineageResult, "ok" | "message" | "errors" | "defect_class"> & {
    message: string;
  },
): ParentLineageResult {
  return {
    ok: true,
    defect_class: null,
    errors: [],
    coverage_report: partial.coverage_report,
    applicable: partial.applicable,
    parent_path: partial.parent_path,
    parent_requirement_ids: partial.parent_requirement_ids,
    negative_invariant_ids: partial.negative_invariant_ids,
    message: partial.message,
  };
}

function failResult(opts: {
  defect_class: LineageDefectClass;
  message: string;
  errors: readonly string[];
  applicable?: boolean;
  parent_path?: string | null;
  parent_requirement_ids?: readonly string[];
  negative_invariant_ids?: readonly string[];
  coverage_report?: CoverageReport | null;
}): ParentLineageResult {
  return {
    ok: false,
    applicable: opts.applicable ?? true,
    defect_class: opts.defect_class,
    message: opts.message,
    parent_path: opts.parent_path ?? null,
    parent_requirement_ids: opts.parent_requirement_ids ?? [],
    negative_invariant_ids: opts.negative_invariant_ids ?? [],
    coverage_report: opts.coverage_report ?? null,
    errors: opts.errors,
  };
}

/**
 * Pure parent-lineage evaluation for an in-memory child + optional parent.
 * When parent is omitted, uses parentPath / project layout from options.
 */
export function evaluateParentLineage(opts: {
  child: unknown;
  /** Absolute path to the child artifact (used to locate lifecycle root). */
  childPath?: string;
  /** Pre-loaded parent document (skips disk load). */
  parent?: unknown;
  /** Explicit absolute parent path (also used for messaging). */
  parentPath?: string;
  /** Project root for resolving planRef when childPath is absent. */
  projectRoot?: string;
  /** When true, skip lineage (tests / opt-out). Default false. */
  skip?: boolean;
}): ParentLineageResult {
  if (opts.skip === true) {
    return okResult({
      applicable: false,
      parent_path: null,
      parent_requirement_ids: [],
      negative_invariant_ids: [],
      coverage_report: null,
      message: "parent lineage: skipped",
    });
  }

  const child = asRecord(opts.child);
  if (child === null) {
    return failResult({
      defect_class: "child_spec",
      message: "parent lineage: child is not a JSON object",
      errors: ["child is not a JSON object"],
    });
  }

  const planRef = resolveParentRefFromChild(child);
  if (planRef === null && opts.parent === undefined && opts.parentPath === undefined) {
    return okResult({
      applicable: false,
      parent_path: null,
      parent_requirement_ids: [],
      negative_invariant_ids: [],
      coverage_report: null,
      message: "parent lineage: N/A (no planRef / parent link)",
    });
  }

  let parentDoc: JsonObj | null = asRecord(opts.parent);
  let parentPath: string | null = opts.parentPath ?? null;

  if (parentDoc === null) {
    let lifecycleRoot: string | null = null;
    if (opts.childPath !== undefined) {
      lifecycleRoot = findLifecycleRootFromArtifact(opts.childPath);
    }
    if (lifecycleRoot === null && opts.projectRoot !== undefined) {
      const xbrief = join(opts.projectRoot, "xbrief");
      const vbrief = join(opts.projectRoot, "vbrief");
      if (existsSync(xbrief)) lifecycleRoot = xbrief;
      else if (existsSync(vbrief)) lifecycleRoot = vbrief;
    }

    if (parentPath === null && planRef !== null) {
      if (lifecycleRoot === null) {
        return failResult({
          defect_class: "child_spec",
          message:
            "parent lineage: cannot resolve planRef (no lifecycle root from child path or project root)",
          errors: ["cannot resolve planRef: missing lifecycle root"],
        });
      }
      const resolved = resolveParentPathFromRef(planRef, lifecycleRoot);
      if (resolved.error !== null || resolved.path === null) {
        return failResult({
          defect_class: "child_spec",
          message: `parent lineage: invalid planRef '${planRef}': ${resolved.error}`,
          errors: [resolved.error ?? "invalid planRef"],
        });
      }
      parentPath = resolved.path;
    }

    if (parentPath === null) {
      return failResult({
        defect_class: "child_spec",
        message: "parent lineage: parent path unresolved",
        errors: ["parent path unresolved"],
      });
    }

    // Prefer exact planRef; fall back across lifecycle folders when parent moved
    // but child planRef rewrite lagged (#3241 Greptile P1).
    const loaded = loadParentWithLifecycleFallback(parentPath, lifecycleRoot);
    if (!loaded.ok) {
      return failResult({
        defect_class: "child_spec",
        message: `parent lineage: ${loaded.error}`,
        errors: [loaded.error],
        parent_path: loaded.path,
      });
    }
    parentDoc = loaded.data;
    parentPath = loaded.path;
  }

  const requirements = extractParentRequirements(parentDoc);
  const parentIds = requirements.map((r) => r.id);
  const negativeIds = requirements.filter((r) => r.negativeInvariant).map((r) => r.id);

  if (parentIds.length === 0) {
    return okResult({
      applicable: false,
      parent_path: parentPath,
      parent_requirement_ids: [],
      negative_invariant_ids: [],
      coverage_report: null,
      message: "parent lineage: N/A (parent authors no requirement IDs)",
    });
  }

  const { draft, source, hasCoverageMapKey } = extractChildCoverageDraft(child);
  if (!hasCoverageMapKey || draft === null) {
    return failResult({
      defect_class: "child_spec",
      message:
        "parent lineage: child missing parent coverage artifacts " +
        `(parent authors ${parentIds.length} requirement ID(s): ${parentIds.join(", ")}). ` +
        "Stamp plan.metadata.parent_lineage.coverage_map (from #3238 decompose) or declare coverage_map.",
      errors: [
        "missing parent coverage artifacts on child",
        `uncovered parent requirement IDs: ${parentIds.join(", ")}`,
      ],
      parent_path: parentPath,
      parent_requirement_ids: parentIds,
      negative_invariant_ids: negativeIds,
    });
  }

  const validation = validateCoverageMap({
    parent: parentDoc,
    draft,
  });

  if (!validation.ok) {
    const defect = classifyCoverageFailure(validation.errors);
    const negHits = validation.errors.filter(
      (e) => e.includes("negative invariant") || e.includes("silent removal"),
    );
    const summary = validation.errors.slice(0, 4).join("; ");
    const kindLabel = defect === "child_spec" ? "child-spec defect" : "parent/child drift";
    let message =
      `parent lineage: ${kindLabel} — ${summary}` +
      (validation.errors.length > 4 ? ` (+${validation.errors.length - 4} more)` : "");
    if (negHits.length > 0) {
      message +=
        " (negative invariant requires coverage or approved behavioral_delta; silent drop forbidden)";
    }
    message += ` [${source ?? "coverage"}] ${formatCoverageReportLine(validation.report)}`;
    return failResult({
      defect_class: defect,
      message,
      errors: validation.errors,
      parent_path: parentPath,
      parent_requirement_ids: parentIds,
      negative_invariant_ids: negativeIds,
      coverage_report: validation.report,
    });
  }

  return okResult({
    applicable: true,
    parent_path: parentPath,
    parent_requirement_ids: parentIds,
    negative_invariant_ids: negativeIds,
    coverage_report: validation.report,
    message:
      `parent lineage: OK (${parentIds.length} parent requirement ID(s); ` +
      `${negativeIds.length} negative invariant(s); source=${source ?? "coverage"})`,
  });
}

/**
 * Convenience: load child from path and evaluate lineage.
 */
export function evaluateParentLineageAtPath(
  childPath: string,
  options: { projectRoot?: string; skip?: boolean } = {},
): ParentLineageResult {
  let raw: string;
  try {
    raw = readFileSync(childPath, "utf8");
  } catch (err: unknown) {
    return failResult({
      defect_class: "child_spec",
      message: `parent lineage: could not read child at ${childPath}: ${String((err as Error).message ?? err)}`,
      errors: [`could not read child: ${String((err as Error).message ?? err)}`],
    });
  }
  let child: unknown;
  try {
    child = JSON.parse(raw);
  } catch (err: unknown) {
    return failResult({
      defect_class: "child_spec",
      message: `parent lineage: child at ${childPath} is not valid JSON: ${String((err as Error).message ?? err)}`,
      errors: [`invalid child JSON: ${String((err as Error).message ?? err)}`],
    });
  }
  return evaluateParentLineage({
    child,
    childPath,
    projectRoot: options.projectRoot,
    skip: options.skip,
  });
}

/** One-line machine-readable lineage summary for gate stdout. */
export function formatParentLineageLine(result: ParentLineageResult): string {
  const payload = {
    schema: "deft.scope.parent_lineage_report.v1",
    ok: result.ok,
    applicable: result.applicable,
    defect_class: result.defect_class,
    parent_path: result.parent_path,
    parent_requirement_ids: result.parent_requirement_ids,
    negative_invariant_ids: result.negative_invariant_ids,
    errors: result.errors,
  };
  return `PARENT_LINEAGE ${JSON.stringify(payload)}`;
}
