/**
 * xBRIEF intended-placement field + preflight check (#3424).
 *
 * Preflight keys on declared files vs FILE_SIZE_REVIEW_TRIGGER_LINES.
 * Missing declaration/exemption is the reject; size alone is not.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { FILE_SIZE_REVIEW_TRIGGER_LINES } from "../policy/file-size-thresholds.js";
import { findLifecycleRootFromArtifact } from "../scope/parent-lineage.js";

export const INTENDED_PLACEMENT_SCHEMA = "deft.scope.intended_placement.v1" as const;

export const INTENDED_PLACEMENT_MISSING_HINT =
  "Record plan.metadata.intended_placement with files[] and module_boundary before implementation.";

export const INTENDED_PLACEMENT_OVER_TRIGGER_HINT =
  "Record plan.metadata.intended_placement.split_plan or cohesion_exemption. Size alone is not a fail-closed cap (#1488 / #3424).";

export interface IntendedPlacement {
  readonly schema?: string;
  readonly files: readonly string[];
  readonly module_boundary?: string;
  readonly split_plan?: string;
  readonly cohesion_exemption?: string;
}

export interface IntendedPlacementResult {
  readonly ok: boolean;
  readonly message: string;
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

export function emptyIntendedPlacement(): IntendedPlacement {
  return {
    schema: INTENDED_PLACEMENT_SCHEMA,
    files: [],
    module_boundary: "",
  };
}

/** Stamp a skeleton intended_placement onto plan.metadata when absent (#3424). */
export function stampIntendedPlacement(plan: Record<string, unknown>): void {
  const existing = asRecord(plan.metadata) ?? {};
  if (asRecord(existing.intended_placement) !== null) {
    plan.metadata = existing;
    return;
  }
  plan.metadata = {
    ...existing,
    intended_placement: emptyIntendedPlacement(),
  };
}

export function readIntendedPlacement(plan: Record<string, unknown>): IntendedPlacement | null {
  const metadata = asRecord(plan.metadata);
  if (metadata === null) return null;
  const raw = asRecord(metadata.intended_placement);
  if (raw === null) return null;
  if (!Array.isArray(raw.files)) return null;
  if (raw.files.some((f) => typeof f !== "string" || f.trim().length === 0)) {
    return null;
  }
  const files = raw.files.map((f) => (f as string).trim());
  return {
    schema: typeof raw.schema === "string" ? raw.schema : undefined,
    files,
    module_boundary: isNonEmptyString(raw.module_boundary) ? raw.module_boundary.trim() : undefined,
    split_plan: isNonEmptyString(raw.split_plan) ? raw.split_plan.trim() : undefined,
    cohesion_exemption: isNonEmptyString(raw.cohesion_exemption)
      ? raw.cohesion_exemption.trim()
      : undefined,
  };
}

export function countFileLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split(/\r\n|\n|\r/);
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

export function resolveProjectRootFromBrief(briefPath: string, explicitRoot?: string): string {
  if (explicitRoot !== undefined && explicitRoot.length > 0) {
    return resolve(explicitRoot);
  }
  const lifecycle = findLifecycleRootFromArtifact(briefPath);
  if (lifecycle !== null) {
    return resolve(lifecycle, "..");
  }
  return resolve(briefPath, "..", "..");
}

function resolveDeclaredFile(projectRoot: string, declared: string): string | null {
  const trimmed = declared.trim();
  if (trimmed.length === 0) return null;
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
  const rel = relative(projectRoot, abs);
  if (rel.startsWith("..") || rel === "" || rel.split(sep).includes("..")) {
    return null;
  }
  return abs;
}

function hasRemediation(placement: IntendedPlacement): boolean {
  return (
    (placement.split_plan !== undefined && placement.split_plan.length > 0) ||
    (placement.cohesion_exemption !== undefined && placement.cohesion_exemption.length > 0)
  );
}

export function evaluateIntendedPlacement(
  plan: Record<string, unknown>,
  options: { projectRoot: string },
): IntendedPlacementResult {
  const placement = readIntendedPlacement(plan);
  if (placement === null) {
    return {
      ok: false,
      message: `xBRIEF lacks plan.metadata.intended_placement. ${INTENDED_PLACEMENT_MISSING_HINT}`,
    };
  }
  if (placement.files.length === 0) {
    return {
      ok: false,
      message: `xBRIEF intended_placement.files is empty — preflight has no declared files to key on. ${INTENDED_PLACEMENT_MISSING_HINT}`,
    };
  }
  if (!isNonEmptyString(placement.module_boundary)) {
    return {
      ok: false,
      message: `xBRIEF intended_placement lacks module_boundary. ${INTENDED_PLACEMENT_MISSING_HINT}`,
    };
  }

  const root = resolve(options.projectRoot);
  const over: string[] = [];
  for (const declared of placement.files) {
    const abs = resolveDeclaredFile(root, declared);
    if (abs === null) {
      return {
        ok: false,
        message: `Intended file '${declared}' escapes the project root. ${INTENDED_PLACEMENT_MISSING_HINT}`,
      };
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Could not inspect intended file '${declared}': ${reason}. ${INTENDED_PLACEMENT_MISSING_HINT}`,
      };
    }
    if (!st.isFile()) {
      return {
        ok: false,
        message: `Intended path '${declared}' is not a regular file. ${INTENDED_PLACEMENT_MISSING_HINT}`,
      };
    }
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Could not read intended file '${declared}': ${reason}. ${INTENDED_PLACEMENT_MISSING_HINT}`,
      };
    }
    const lines = countFileLines(text);
    if (lines >= FILE_SIZE_REVIEW_TRIGGER_LINES) {
      over.push(`${declared} (${lines} lines >= ${FILE_SIZE_REVIEW_TRIGGER_LINES})`);
    }
  }

  if (over.length > 0 && !hasRemediation(placement)) {
    return {
      ok: false,
      message: `Declared file already over the review-trigger threshold: ${over.join("; ")}. ${INTENDED_PLACEMENT_OVER_TRIGGER_HINT}`,
    };
  }

  return { ok: true, message: "intended placement OK" };
}
