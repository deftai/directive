/**
 * PROJECT-DEFINITION IO for plan.policy.projectInvariants (#3425 Story A).
 */

import { existsSync, readFileSync } from "node:fs";
import {
  extractModulePathGlobs,
  type ProjectInvariant,
  type ProjectInvariantsResolved,
  parseProjectInvariants,
  resolveProjectInvariantsFromData,
} from "../policy/project-invariants.js";
import { projectDefinitionPath } from "./project-definition-io.js";

export interface LoadedProjectInvariants {
  readonly path: string;
  readonly resolved: ProjectInvariantsResolved;
  readonly modulePathGlobs: Readonly<Record<string, readonly string[]>>;
}

/** Read and parse projectInvariants via the PROJECT-DEFINITION IO path. */
export function loadProjectInvariants(projectRoot: string): LoadedProjectInvariants {
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    return {
      path,
      resolved: {
        invariants: [],
        source: "default",
        error: `PROJECT-DEFINITION not found at ${path}`,
      },
      modulePathGlobs: {},
    };
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      path,
      resolved: resolveProjectInvariantsFromData(data),
      modulePathGlobs: extractModulePathGlobs(data),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      path,
      resolved: { invariants: [], source: "default-on-error", error: msg },
      modulePathGlobs: {},
    };
  }
}

export function parseProjectInvariantsField(raw: unknown): {
  readonly invariants: readonly ProjectInvariant[];
  readonly errors: readonly string[];
} {
  return parseProjectInvariants(raw);
}
