import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import { atomicWriteText } from "../cache/io.js";
import { stripArtifactSuffix } from "../layout/resolve.js";
import type { JsonObject } from "../vbrief-build/types.js";
import { formatBriefJson } from "./brief-io.js";
import { relativeToVbrief, resolveVbriefRef, scopeIdsForFilename } from "./vbrief-ref.js";

/**
 * Opt-in row policy for a registry that lists open scopes only (PROJECT-DEFINITION,
 * #6648). Rows are matched by source_path or filename stem, never by title. A move
 * into a folder outside `openFolders` removes the row; a move into an open folder
 * patches the matched row or inserts the row `buildRow` returns.
 */
export interface OpenRowsOnlyPolicy {
  readonly openFolders: readonly string[];
  readonly buildRow: () => Record<string, unknown> | null;
}

export interface RegistryArtifactPersistHooks {
  readonly loadForMutation?: () => [JsonObject, string];
  readonly persist?: (path: string, data: JsonObject) => void;
  readonly openRowsOnly?: OpenRowsOnlyPolicy;
}

/** Strict row match for an open-rows-only registry: source_path or filename stem (#6648). */
function registryItemMatchesMovedFile(
  item: Record<string, unknown>,
  oldPath: string,
  newPath: string,
  vbriefRoot: string,
): boolean {
  const metadata = item.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const sourcePath = (metadata as Record<string, unknown>).source_path;
    if (typeof sourcePath === "string") {
      const resolved = resolveVbriefRef(sourcePath, vbriefRoot);
      if (resolved !== null && [resolve(oldPath), resolve(newPath)].includes(resolve(resolved))) {
        return true;
      }
    }
  }
  const stem = stripArtifactSuffix(resolve(newPath).split(/[/\\]/).pop() ?? "");
  return typeof item.id === "string" && item.id === stem;
}

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
  hooks: RegistryArtifactPersistHooks = {},
): void {
  const newRel = relativeToVbrief(newPath, vbriefRoot);
  if (newRel === null) {
    return;
  }
  try {
    let registry: Record<string, unknown>;
    if (hooks.loadForMutation !== undefined) {
      if (!existsSync(registryPath)) {
        return;
      }
      const [loaded] = hooks.loadForMutation();
      registry = loaded;
    } else {
      if (!existsSync(registryPath)) {
        return;
      }
      const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      registry = parsed as Record<string, unknown>;
    }
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
    const rowPolicy = hooks.openRowsOnly;
    const targetIsOpen =
      rowPolicy?.openFolders.includes(dirname(resolve(newPath)).split(/[/\\]/).pop() ?? "") ===
      true;
    if (rowPolicy !== undefined && Array.isArray(items)) {
      // Open-rows-only registry (#6648): remove on a terminal move, insert on an
      // open move that matches no row; open-move matches are patched below.
      const matches = (item: unknown): boolean =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        registryItemMatchesMovedFile(item as Record<string, unknown>, oldPath, newPath, vbriefRoot);
      if (!targetIsOpen) {
        const kept = items.filter((item) => !matches(item));
        if (kept.length !== items.length) {
          p.items = kept;
          changed = true;
        }
      } else if (!items.some(matches)) {
        const row = rowPolicy.buildRow();
        if (row !== null) {
          items.push(row);
          changed = true;
        }
      }
    }
    if (Array.isArray(p.items) && (rowPolicy === undefined || targetIsOpen)) {
      for (const item of p.items as unknown[]) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          continue;
        }
        const i = item as Record<string, unknown>;
        const matched =
          rowPolicy === undefined
            ? registryItemMatchesScope(i, scopeData, oldPath, newPath, vbriefRoot)
            : registryItemMatchesMovedFile(i, oldPath, newPath, vbriefRoot);
        if (!matched) {
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
      if (hooks.persist !== undefined) {
        hooks.persist(registryPath, registry as JsonObject);
      } else {
        // #3042: contain registry stay-path write against project root (parent of xbrief/).
        atomicWriteText(registryPath, formatBriefJson(registry), {
          projectRoot: dirname(resolve(vbriefRoot)),
        });
      }
    }
  } catch (err: unknown) {
    if (hooks.loadForMutation !== undefined || hooks.persist !== undefined) {
      throw err;
    }
  }
}
