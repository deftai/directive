/**
 * xBRIEF intended-placement field + preflight check (#3424).
 *
 * Preflight keys on declared files vs FILE_SIZE_REVIEW_TRIGGER_LINES.
 * Size alone is not a hard cap (#1488).
 *
 * ## Error policy
 * Every anomaly on a declared file fails closed (exit 1 + remediation hint).
 * Never throw. Never silent-skip. The only skip is first-touch `lstat` ENOENT
 * (planned-new file — nothing to measure). If `lstat` succeeded and a later
 * operation fails, that is an inconsistency → exit 1.
 *
 * ## Threat model
 * Preflight is a quality gate the agent runs against its own declared plan
 * in its own worktree. A concurrent local process that can swap symlinks
 * mid-check can trivially edit the vBRIEF itself. Adversarial-local-attacker
 * TOCTOU is a **non-goal** beyond the fd discipline below. Windows symlink
 * creation requires elevation.
 *
 * ## fd discipline
 * `lstat` rejects symlink entries outright. Resolve + containment-check once.
 * `openSync(abs, O_RDONLY | O_NOFOLLOW)` (plain `O_RDONLY` where `O_NOFOLLOW`
 * is undefined, i.e. Windows). `fstatSync(fd)` confirms a regular file; read
 * from that same fd.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { FILE_SIZE_REVIEW_TRIGGER_LINES } from "../policy/file-size-thresholds.js";
import { findLifecycleRootFromArtifact } from "../scope/parent-lineage.js";

export const INTENDED_PLACEMENT_SCHEMA = "deft.scope.intended_placement.v1" as const;

export const INTENDED_PLACEMENT_MISSING_HINT =
  "Record plan.metadata.intended_placement with files[] and module_boundary before implementation.";

export const INTENDED_PLACEMENT_OVER_TRIGGER_HINT =
  "Record plan.metadata.intended_placement.split_plan or cohesion_exemption. Size alone is not a fail-closed cap (#1488 / #3424).";

export const INTENDED_PLACEMENT_GRANDFATHER_HINT =
  "Pre-#3424 brief: intended_placement is missing (warning). Ingest now stamps the field; record files[] before new work.";

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
  /** Grandfathered missing field — evaluate stays exit 0 and surfaces this. */
  readonly warning?: boolean;
}

export type ParsedIntendedPlacement =
  | { kind: "missing" }
  | { kind: "malformed"; message: string }
  | { kind: "ok"; placement: IntendedPlacement };

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

export function parseIntendedPlacement(plan: Record<string, unknown>): ParsedIntendedPlacement {
  const metadata = asRecord(plan.metadata);
  if (metadata === null) return { kind: "missing" };
  if (!("intended_placement" in metadata) || metadata.intended_placement === undefined) {
    return { kind: "missing" };
  }
  const raw = asRecord(metadata.intended_placement);
  if (raw === null) {
    return {
      kind: "malformed",
      message: `intended_placement is not an object. ${INTENDED_PLACEMENT_MISSING_HINT}`,
    };
  }
  if (!Array.isArray(raw.files)) {
    return {
      kind: "malformed",
      message: `intended_placement.files is not an array. ${INTENDED_PLACEMENT_MISSING_HINT}`,
    };
  }
  const files: string[] = [];
  for (let i = 0; i < raw.files.length; i++) {
    const entry = raw.files[i];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return {
        kind: "malformed",
        message: `intended_placement.files[${i}] is not a non-empty string. ${INTENDED_PLACEMENT_MISSING_HINT}`,
      };
    }
    files.push(entry.trim());
  }
  return {
    kind: "ok",
    placement: {
      schema: typeof raw.schema === "string" ? raw.schema : undefined,
      files,
      module_boundary: isNonEmptyString(raw.module_boundary)
        ? raw.module_boundary.trim()
        : undefined,
      split_plan: isNonEmptyString(raw.split_plan) ? raw.split_plan.trim() : undefined,
      cohesion_exemption: isNonEmptyString(raw.cohesion_exemption)
        ? raw.cohesion_exemption.trim()
        : undefined,
    },
  };
}

export function readIntendedPlacement(plan: Record<string, unknown>): IntendedPlacement | null {
  const parsed = parseIntendedPlacement(plan);
  return parsed.kind === "ok" ? parsed.placement : null;
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

type ContainedInspect =
  | { kind: "missing" }
  | { kind: "file"; text: string }
  | { kind: "reject"; message: string };

function rejectInspect(declared: string, reason: string): ContainedInspect {
  return {
    kind: "reject",
    message: `Could not inspect intended file '${declared}': ${reason}. ${INTENDED_PLACEMENT_MISSING_HINT}`,
  };
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function errReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * lstat (first-touch ENOENT = planned-new skip) → reject symlink →
 * open+fstat+read the same fd. Later ENOENT is inconsistency, not skip.
 */
function inspectDeclaredFile(declared: string, abs: string): ContainedInspect {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(abs);
  } catch (err: unknown) {
    if (errnoCode(err) === "ENOENT") {
      return { kind: "missing" };
    }
    return rejectInspect(declared, errReason(err));
  }
  if (info.isSymbolicLink()) {
    return {
      kind: "reject",
      message: `Intended path '${declared}' is a symlink. ${INTENDED_PLACEMENT_MISSING_HINT}`,
    };
  }
  if (!info.isFile()) {
    return {
      kind: "reject",
      message: `Intended path '${declared}' is not a regular file. ${INTENDED_PLACEMENT_MISSING_HINT}`,
    };
  }

  const nofollow = constants.O_NOFOLLOW;
  const flags = constants.O_RDONLY | (typeof nofollow === "number" ? nofollow : 0);
  let fd: number;
  try {
    fd = openSync(abs, flags);
  } catch (err: unknown) {
    const code = errnoCode(err);
    if (code === "ELOOP" || code === "EMLINK") {
      return {
        kind: "reject",
        message: `Intended path '${declared}' is a symlink. ${INTENDED_PLACEMENT_MISSING_HINT}`,
      };
    }
    return rejectInspect(declared, errReason(err));
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      return {
        kind: "reject",
        message: `Intended path '${declared}' is not a regular file. ${INTENDED_PLACEMENT_MISSING_HINT}`,
      };
    }
    return { kind: "file", text: readFileSync(fd, "utf8") };
  } catch (err: unknown) {
    return rejectInspect(declared, errReason(err));
  } finally {
    try {
      closeSync(fd);
    } catch {
      // already closed or invalid
    }
  }
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
  const parsed = parseIntendedPlacement(plan);
  if (parsed.kind === "missing") {
    return {
      ok: true,
      warning: true,
      message: INTENDED_PLACEMENT_GRANDFATHER_HINT,
    };
  }
  if (parsed.kind === "malformed") {
    return { ok: false, message: parsed.message };
  }
  const placement = parsed.placement;
  if (placement.files.length === 0) {
    return {
      ok: true,
      message: "intended placement pending (ingest scaffold; no declared files)",
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
    const inspected = inspectDeclaredFile(declared, abs);
    if (inspected.kind === "missing") {
      continue;
    }
    if (inspected.kind === "reject") {
      return { ok: false, message: inspected.message };
    }
    const lines = countFileLines(inspected.text);
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
