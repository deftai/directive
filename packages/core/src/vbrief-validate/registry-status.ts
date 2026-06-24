import { scopeIdsForRefUri } from "./paths.js";
import type { JsonObject } from "./schema.js";

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
    (ref as JsonObject).type === REGISTRY_SCOPE_LINK_TYPE
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

function pushPlanScopeLink(uris: string[], ref: unknown): void {
  if (!isScopeLinkRef(ref)) {
    return;
  }
  const uri = ref.uri;
  if (typeof uri === "string" && uri.length > 0) {
    uris.push(uri);
  }
}

/**
 * Local scope URIs whose ``plan.status`` must agree with the registry item
 * status (D3). Shared by render output expectations and the validator.
 */
export function registryStatusScopeUris(item: JsonObject, plan: JsonObject): string[] {
  const uris: string[] = [];

  const metadata = item.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const meta = metadata as JsonObject;
    const sourcePath = meta.source_path;
    if (typeof sourcePath === "string" && sourcePath.length > 0) {
      uris.push(sourcePath);
    }
  }

  const itemRefs = item.references;
  if (Array.isArray(itemRefs)) {
    for (const ref of itemRefs) {
      pushPlanScopeLink(uris, ref);
    }
  }

  const itemId = item.id;
  const itemTitle = item.title;
  const planRefs = plan.references;
  if (Array.isArray(planRefs)) {
    for (const ref of planRefs) {
      if (!isScopeLinkRef(ref)) {
        continue;
      }
      const uri = ref.uri;
      if (typeof uri !== "string" || uri.length === 0) {
        continue;
      }
      const titleMatches = typeof itemTitle === "string" && ref.title === itemTitle;
      const idMatches = typeof itemId === "string" && scopeIdsForRefUri(uri).has(itemId);
      if (titleMatches || idMatches) {
        uris.push(uri);
      }
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
