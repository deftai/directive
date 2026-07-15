import { dirname, resolve } from "node:path";
import { resolveSpecArtifactPath } from "../layout/resolve.js";
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
}
