/**
 * Preflight / story-ready fail-closed check for applicable project invariants (#3425 Story B).
 *
 * Evaluates the PROJECT-DEFINITION list as of check time (list-drift).
 * Completeness only — does not prove a declared `covered` is true.
 */

import { dirname } from "node:path";
import { extractModulePathGlobs, resolveProjectInvariants } from "../policy/project-invariants.js";
import { loadProjectDefinition } from "../policy/resolve.js";
import { extractStoryFileScope } from "../policy/write-fence.js";
import {
  extractChildCoverageDraft,
  findLifecycleRootFromArtifact,
} from "../scope/parent-lineage.js";
import {
  applicableProjectInvariants,
  PROJECT_INVARIANT_DISPOSITIONS,
  validateProjectInvariantCoverage,
} from "../scope/project-invariant-coverage.js";

export const PROJECT_INVARIANT_REMEDIATION =
  "Declare coverage_map[<id>].disposition as " +
  `${PROJECT_INVARIANT_DISPOSITIONS.join("|")} ` +
  "(split is excluded at project level).";

export interface ProjectInvariantsGateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly applicableIds: readonly string[];
  readonly missingIds: readonly string[];
}

export interface ProjectInvariantsGateOptions {
  readonly projectRoot?: string;
  readonly skip?: boolean;
}

/**
 * Prefer an explicit project root. Otherwise walk up from the story path to
 * the xbrief/vbrief lifecycle folder and take its parent (the repo root).
 * Lets `xbrief:preflight` fire without a CLI `--project-root`.
 */
export function resolveProjectRootForInvariants(
  artifactPath: string,
  explicit?: string,
): string | undefined {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const lifecycle = findLifecycleRootFromArtifact(artifactPath);
  return lifecycle === null ? undefined : dirname(lifecycle);
}

/**
 * Fail closed when an applicable project invariant ID has no coverage disposition.
 * Empty or absent list is a no-op. Slice- and worktree-scoped stories share this check.
 */
export function evaluateProjectInvariantsGate(
  story: unknown,
  options: ProjectInvariantsGateOptions = {},
): ProjectInvariantsGateResult {
  if (options.skip === true) {
    return { ok: true, message: "project invariants skipped", applicableIds: [], missingIds: [] };
  }
  const projectRoot = options.projectRoot;
  if (projectRoot === undefined || projectRoot.length === 0) {
    return {
      ok: true,
      message: "project invariants N/A (no project root)",
      applicableIds: [],
      missingIds: [],
    };
  }

  const resolved = resolveProjectInvariants(projectRoot);
  if (resolved.invariants.length === 0) {
    return {
      ok: true,
      message: "project invariants empty (no-op)",
      applicableIds: [],
      missingIds: [],
    };
  }

  const [data] = loadProjectDefinition(projectRoot);
  const modulePathGlobs = extractModulePathGlobs(data);
  const { fileScope } = extractStoryFileScope(story);
  const applicable = applicableProjectInvariants(resolved.invariants, fileScope, modulePathGlobs);
  const applicableIds = applicable.map((a) => a.id);

  const extracted = extractChildCoverageDraft(story);
  const coverage = validateProjectInvariantCoverage({
    applicableIds,
    draft: extracted.draft ?? {},
  });
  if (coverage.ok) {
    return {
      ok: true,
      message:
        applicableIds.length === 0
          ? "project invariants: none applicable"
          : `project invariants OK (${applicableIds.length} applicable)`,
      applicableIds,
      missingIds: [],
    };
  }

  const omitted = coverage.missingIds.length > 0 ? coverage.missingIds.join(", ") : "(see errors)";
  return {
    ok: false,
    applicableIds,
    missingIds: coverage.missingIds,
    message:
      `applicable project invariant ID omitted: ${omitted}. ${PROJECT_INVARIANT_REMEDIATION} ` +
      coverage.errors.join("; "),
  };
}
