import { dirname, resolve } from "node:path";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import { syncRegistryArtifactAfterScopeMove } from "./registry-artifact-sync.js";

/** Best-effort sync of PROJECT-DEFINITION after a lifecycle move (#1527). */
export function syncProjectDefinitionAfterScopeMove(
  scopeData: Record<string, unknown>,
  oldPath: string,
  newPath: string,
  vbriefRoot: string,
  targetStatus: string,
): void {
  const projectRoot = dirname(resolve(vbriefRoot));
  const projectDefPath = resolveProjectDefinitionPath(projectRoot);
  syncRegistryArtifactAfterScopeMove(
    projectDefPath,
    scopeData,
    oldPath,
    newPath,
    vbriefRoot,
    targetStatus,
  );
}
