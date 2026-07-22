import { dirname, resolve } from "node:path";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import {
  atomicWriteProjectDefinition,
  loadProjectDefinitionForMutation,
  projectDefinitionMutationLock,
} from "../vbrief-build/project-definition-io.js";
import type { JsonObject } from "../vbrief-build/types.js";
import { syncRegistryArtifactAfterScopeMove } from "./registry-artifact-sync.js";

/** Fail-closed sync of PROJECT-DEFINITION after a lifecycle move (#1527 / #2131). */
export function syncProjectDefinitionAfterScopeMove(
  scopeData: Record<string, unknown>,
  oldPath: string,
  newPath: string,
  vbriefRoot: string,
  targetStatus: string,
): string | null {
  const projectRoot = dirname(resolve(vbriefRoot));
  try {
    projectDefinitionMutationLock(projectRoot, () => {
      const projectDefPath = resolveProjectDefinitionPath(projectRoot);
      syncRegistryArtifactAfterScopeMove(
        projectDefPath,
        scopeData,
        oldPath,
        newPath,
        vbriefRoot,
        targetStatus,
        {
          loadForMutation: () => loadProjectDefinitionForMutation(projectRoot),
          persist: (path, data) => atomicWriteProjectDefinition(path, data as JsonObject),
        },
      );
    });
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}
