import { isPlanReferenceType } from "./constants.js";
import type { JsonObject } from "./schema.js";

/** @deprecated Use {@link isPlanReferenceType}; kept for back-compat re-exports. */
export const REGISTRY_SCOPE_LINK_TYPE = "x-vbrief/plan";

/** Derive the registry item status from a scope vBRIEF (render side). */
export function deriveRegistryItemStatus(planStatus: unknown, lifecycleFolder: string): string {
  if (typeof planStatus === "string" && planStatus.length > 0) {
    return planStatus;
  }
  return lifecycleFolder;
}

function isScopeLinkRef(ref: unknown): ref is JsonObject {
  return (
    typeof ref === "object" &&
    ref !== null &&
    !Array.isArray(ref) &&
    isPlanReferenceType((ref as JsonObject).type)
  );
}

/**
 * References copied onto a registry item from a scope vBRIEF.
 *
 * Scope-local ``x-vbrief/plan`` links (decompose children, epic forward refs)
 * stay on the scope file only; copying them into PROJECT-DEFINITION item
 * metadata makes D3 registry-status falsely compare the item row against
 * mixed-status siblings (#1696).
 */
export function registryMetadataReferencesFromScope(references: unknown): unknown[] {
  if (!Array.isArray(references)) {
    return [];
  }
  return references.filter((ref) => !isScopeLinkRef(ref));
}

/**
 * Local source URI whose ``plan.status`` must agree with the registry item
 * status (D3). Child plan links can move through the lifecycle independently.
 */
export function registryStatusScopeUris(item: JsonObject): string[] {
  const uris: string[] = [];

  const metadata = item.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const meta = metadata as JsonObject;
    const sourcePath = meta.source_path;
    if (typeof sourcePath === "string" && sourcePath.length > 0) {
      uris.push(sourcePath);
    }
  }

  return [...new Set(uris)];
}

export function formatRegistryStatusMismatch(
  filepath: string,
  itemIndex: number,
  itemStatus: string,
  uri: string,
  scopeStatus: string,
): string {
  return (
    `${filepath}: items[${itemIndex}] status is '${itemStatus}' ` +
    `but referenced scope '${uri}' has plan.status '${scopeStatus}' ` +
    "(D3 registry-status)"
  );
}
