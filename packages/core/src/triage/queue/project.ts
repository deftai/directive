import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_DEFINITION_REL_PATH } from "./constants.js";

export interface ProjectDefinition {
  readonly plan?: unknown;
}

/** Read vbrief/PROJECT-DEFINITION.vbrief.json. Returns null if absent/invalid. */
export function loadProjectDefinition(projectRoot: string): ProjectDefinition | null {
  const path = join(resolve(projectRoot), PROJECT_DEFINITION_REL_PATH);
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
