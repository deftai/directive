import { dirname, resolve } from "node:path";
import { PROJECT_REGISTRY_FOLDERS } from "../render/constants.js";
import { withProjectDefinitionMutation } from "../vbrief-build/project-definition-mutation.js";
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
    withProjectDefinitionMutation(projectRoot, (mutation) => {
      syncRegistryArtifactAfterScopeMove(
        // The artifact the lock captured, not an independent re-resolution (#3796).
        mutation.artifactPath,
        scopeData,
        oldPath,
        newPath,
        vbriefRoot,
        targetStatus,
        {
          // PROJECT-DEFINITION lists open scopes only (#6648): a terminal move
          // removes the row and an open move leaves rows alone (#6872). The
          // specification registry sync does not pass this policy and keeps patching.
          openRowsOnly: { openFolders: PROJECT_REGISTRY_FOLDERS },
          loadForMutation: () => [mutation.load(), mutation.artifactPath],
          persist: (path, data) => {
            // The registry sync echoes back the path it was handed, so a
            // mismatch means something re-resolved the artifact mid-section.
            if (resolve(path) !== resolve(mutation.artifactPath)) {
              throw new Error(
                "refusing to persist PROJECT-DEFINITION to a path other than the locked artifact",
              );
            }
            mutation.persist(data);
          },
        },
      );
    });
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}
