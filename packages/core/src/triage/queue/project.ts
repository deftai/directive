import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProjectDefinitionPath } from "../../layout/resolve.js";

export interface ProjectDefinition {
  readonly plan?: unknown;
}

/**
 * Read the layout-resolved PROJECT-DEFINITION artifact (#2207). Resolves the
 * `xbrief/` layout on migrated trees and falls back to `vbrief/` otherwise, so
 * `plan.policy.triageRankingLabels` load correctly after the #2109 rename.
 * Returns null if absent/invalid.
 */
export function loadProjectDefinition(projectRoot: string): ProjectDefinition | null {
  const path = resolveProjectDefinitionPath(resolve(projectRoot));
  if (!existsSync(path)) {
    return null;
  }
  try {
    const data: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
    return typeof data === "object" && data !== null ? (data as ProjectDefinition) : null;
  } catch {
    return null;
  }
}
