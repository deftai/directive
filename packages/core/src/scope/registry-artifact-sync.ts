import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import { formatVbriefJson } from "./vbrief-json.js";
import { relativeToVbrief, resolveVbriefRef, scopeIdsForFilename } from "./vbrief-ref.js";

function rewriteRegistryPlanReference(
  ref: unknown,
  oldResolved: string,
  newRel: string,
  vbriefRoot: string,
): boolean {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
    return false;
  }
  const r = ref as Record<string, unknown>;
  if (!referenceTypeMatches(String(r.type ?? ""), "plan")) {
    return false;
  }
  const resolved = resolveVbriefRef(r.uri, vbriefRoot);
  if (resolved === null || resolve(resolved) !== resolve(oldResolved)) {
    return false;
  }
  const uri = r.uri;
  const newUri = typeof uri === "string" && uri.startsWith("file://") ? `file://${newRel}` : newRel;
  if (newUri === uri) {
    return false;
  }
  r.uri = newUri;
  return true;
}

function registryItemReferencesScope(
  item: Record<string, unknown>,
  oldResolved: string,
  newResolved: string,
  vbriefRoot: string,
): boolean {
  const metadata = item.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const meta = metadata as Record<string, unknown>;
    const sourcePath = meta.source_path;
    if (typeof sourcePath === "string") {
      const resolved = resolveVbriefRef(sourcePath, vbriefRoot);
      if (resolved !== null && [oldResolved, newResolved].includes(resolve(resolved))) {
        return true;
      }
    }
    const metadataRefs = meta.references;
    if (Array.isArray(metadataRefs)) {
      for (const ref of metadataRefs) {
        if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
          continue;
        }
        const r = ref as Record<string, unknown>;
        if (!referenceTypeMatches(String(r.type ?? ""), "plan")) {
          continue;
        }
        const resolved = resolveVbriefRef(r.uri, vbriefRoot);
        if (resolved !== null && [oldResolved, newResolved].includes(resolve(resolved))) {
          return true;
        }
      }
    }
  }
  const refs = item.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
        continue;
      }
      const r = ref as Record<string, unknown>;
      if (!referenceTypeMatches(String(r.type ?? ""), "plan")) {
        continue;
      }
      const resolved = resolveVbriefRef(r.uri, vbriefRoot);
      if (resolved !== null && [oldResolved, newResolved].includes(resolve(resolved))) {
        return true;
      }
    }
  }
  return false;
}

function registryItemMatchesScope(
  item: Record<string, unknown>,
  scopeData: Record<string, unknown>,
  oldPath: string,
  newPath: string,
  vbriefRoot: string,
): boolean {
  const oldResolved = resolve(oldPath);
  const newResolved = resolve(newPath);
  if (registryItemReferencesScope(item, oldResolved, newResolved, vbriefRoot)) {
    return true;
  }
  const itemId = item.id;
  if (
    typeof itemId === "string" &&
    scopeIdsForFilename(resolve(newPath).split(/[/\\]/).pop() ?? "").has(itemId)
  ) {
    return true;
  }
  const scopePlan = scopeData.plan;
  const scopeTitle =
    typeof scopePlan === "object" && scopePlan !== null && !Array.isArray(scopePlan)
      ? (scopePlan as Record<string, unknown>).title
      : undefined;
  const itemTitle = item.title;
  return (
    typeof scopeTitle === "string" && typeof itemTitle === "string" && itemTitle === scopeTitle
  );
}

/** Best-effort sync of a registry artifact (PROJECT-DEFINITION, specification, etc.) after a lifecycle move. */
export function syncRegistryArtifactAfterScopeMove(
  registryPath: string,
  scopeData: Record<string, unknown>,
  oldPath: string,
  newPath: string,
  vbriefRoot: string,
  targetStatus: string,
): void {
  const newRel = relativeToVbrief(newPath, vbriefRoot);
  if (newRel === null) {
    return;
  }
  if (!existsSync(registryPath)) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const registry = parsed as Record<string, unknown>;
    const plan = registry.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return;
    }
    const p = plan as Record<string, unknown>;
    let changed = false;
    const oldResolved = resolve(oldPath);
    const refs = p.references;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (rewriteRegistryPlanReference(ref, oldResolved, newRel, vbriefRoot)) {
          changed = true;
        }
      }
    }
    const items = p.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          continue;
        }
        const i = item as Record<string, unknown>;
        if (!registryItemMatchesScope(i, scopeData, oldPath, newPath, vbriefRoot)) {
          continue;
        }
        if (i.status !== targetStatus) {
          i.status = targetStatus;
          changed = true;
        }
        let metadata = i.metadata;
        if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
          metadata = {};
          i.metadata = metadata;
        }
        const meta = metadata as Record<string, unknown>;
        const targetFolder = dirname(resolve(newPath)).split(/[/\\]/).pop() ?? "";
        if (meta.source_path !== newRel) {
          meta.source_path = newRel;
          changed = true;
        }
        if (meta.lifecycle_folder !== targetFolder) {
          meta.lifecycle_folder = targetFolder;
          changed = true;
        }
      }
    }
    if (changed) {
      writeFileSync(registryPath, formatVbriefJson(registry), "utf8");
    }
  } catch {
    /* best-effort */
  }
}
