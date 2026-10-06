import { dirname, relative, resolve } from "node:path";
import { resolveSpecArtifactPath } from "../layout/resolve.js";
import { resolveSpecGuard } from "../policy/spec-guard.js";
import { recordScopeCompleteDrift } from "../verify-source/spec-drift.js";
import { syncRegistryArtifactAfterScopeMove } from "./registry-artifact-sync.js";

export interface SpecificationSyncResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Best-effort sync of specification.xbrief.json after a lifecycle move (#2566 / #5350). */
export function syncSpecificationAfterScopeMove(
  scopeData: Record<string, unknown>,
  oldPath: string,
  newPath: string,
  vbriefRoot: string,
  targetStatus: string,
): SpecificationSyncResult {
  const projectRoot = dirname(resolve(vbriefRoot));
  let specPath: string;
  try {
    specPath = resolveSpecArtifactPath(projectRoot);
  } catch {
    return { ok: true, message: "" };
  }
  syncRegistryArtifactAfterScopeMove(
    specPath,
    scopeData,
    oldPath,
    newPath,
    vbriefRoot,
    targetStatus,
  );

  // #1589 / #5350: extend this sync hook for drift — do not add a second
  // independent scope:complete writer. Registry sync alone never clears drift.
  // Under enforce, transition.ts already records BEFORE unlinking active; a
  // second pass here would double-record (spent override / unchanged fingerprint).
  if (targetStatus === "completed") {
    const scopeRel = relative(projectRoot, newPath).replace(/\\/g, "/");
    let hasSpec = false;
    try {
      hasSpec = true;
      void resolveSpecArtifactPath(projectRoot);
    } catch {
      hasSpec = false;
    }
    const guard = resolveSpecGuard(projectRoot, { hasSpecification: hasSpec });
    const enforcement = guard.driftGuard.enforcement;
    if (enforcement === "enforce") {
      return { ok: true, message: "" };
    }
    try {
      recordScopeCompleteDrift(projectRoot, scopeData, scopeRel);
    } catch (err) {
      // advise/shadow: must not refuse the lifecycle move solely for record errors
      void err;
    }
  }
  return { ok: true, message: "" };
}
