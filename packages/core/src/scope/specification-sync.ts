import { dirname, relative, resolve } from "node:path";
import { resolveSpecArtifactPath } from "../layout/resolve.js";
import { recordScopeCompleteDriftAdvise } from "../verify-source/spec-drift.js";
import { syncRegistryArtifactAfterScopeMove } from "./registry-artifact-sync.js";

/** Best-effort sync of specification.xbrief.json after a lifecycle move (#2566). */
export function syncSpecificationAfterScopeMove(
  scopeData: Record<string, unknown>,
  oldPath: string,
  newPath: string,
  vbriefRoot: string,
  targetStatus: string,
): void {
  const projectRoot = dirname(resolve(vbriefRoot));
  let specPath: string;
  try {
    specPath = resolveSpecArtifactPath(projectRoot);
  } catch {
    return;
  }
  syncRegistryArtifactAfterScopeMove(
    specPath,
    scopeData,
    oldPath,
    newPath,
    vbriefRoot,
    targetStatus,
  );

  // #1589 C2: extend this sync hook for advise drift — do not add a second
  // independent scope:complete writer. Registry sync alone never clears drift.
  if (targetStatus === "completed") {
    const scopeRel = relative(projectRoot, newPath).replace(/\\/g, "/");
    try {
      recordScopeCompleteDriftAdvise(projectRoot, scopeData, scopeRel);
    } catch {
      // advise path must not fail closed the lifecycle move
    }
  }
}
