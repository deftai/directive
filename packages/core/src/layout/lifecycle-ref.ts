import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { hasArtifactSuffix } from "./resolve.js";

/** Lifecycle folders searched when a folder-qualified ref dangles (#1926). */
export const LIFECYCLE_SCOPE_FOLDERS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

function isLifecycleFolder(name: string): boolean {
  return (LIFECYCLE_SCOPE_FOLDERS as readonly string[]).includes(name);
}

function searchLifecycleFolders(lifecycleRoot: string, artifactBasename: string): string | null {
  for (const folder of LIFECYCLE_SCOPE_FOLDERS) {
    const candidate = resolve(lifecycleRoot, folder, artifactBasename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface ResolveLifecycleArtifactRefOptions {
  /** When false, only resolve the literal path (for rewrite matching). Default true (#1926). */
  readonly allowCrossFolderSearch?: boolean;
}

/**
 * Resolve a lifecycle-relative artifact reference to an absolute path.
 *
 * When the direct path is missing but the ref names a lifecycle artifact
 * (folder-qualified or bare basename), search all lifecycle folders for the
 * same filename (#1926).
 */
export function resolveLifecycleArtifactRef(
  rel: string,
  lifecycleRoot: string,
  options: ResolveLifecycleArtifactRefOptions = {},
): string {
  const allowCrossFolderSearch = options.allowCrossFolderSearch ?? true;
  const direct = resolve(lifecycleRoot, rel);
  if (existsSync(direct)) {
    return direct;
  }
  if (!allowCrossFolderSearch) {
    return direct;
  }

  const parts = rel.split("/").filter(Boolean);
  if (parts.length >= 2 && isLifecycleFolder(parts[0] ?? "")) {
    const found = searchLifecycleFolders(lifecycleRoot, basename(rel));
    if (found !== null) {
      return found;
    }
  }

  if (!rel.includes("/") && hasArtifactSuffix(rel)) {
    const found = searchLifecycleFolders(lifecycleRoot, rel);
    if (found !== null) {
      return found;
    }
  }

  return direct;
}
