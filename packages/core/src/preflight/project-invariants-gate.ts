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
import { findLifecycleRootFromArtifact } from "../scope/parent-lineage.js";
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
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

  const storyRec = asRecord(story);
  const plan = storyRec !== null ? asRecord(storyRec.plan) : null;
  const metadata = plan !== null ? asRecord(plan.metadata) : null;
  const lineage = metadata !== null ? asRecord(metadata.parent_lineage) : null;
  const draft = {
    coverage_map:
      (lineage !== null ? (lineage.coverage_map ?? lineage.coverageMap) : undefined) ??
      (metadata !== null ? (metadata.coverage_map ?? metadata.coverageMap) : undefined) ??
      (plan !== null ? (plan.coverage_map ?? plan.coverageMap) : undefined) ??
      (storyRec !== null ? (storyRec.coverage_map ?? storyRec.coverageMap) : undefined),
    behavioral_deltas:
      (lineage !== null ? (lineage.behavioral_deltas ?? lineage.behavioralDeltas) : undefined) ??
      (metadata !== null ? (metadata.behavioral_deltas ?? metadata.behavioralDeltas) : undefined) ??
      (plan !== null ? (plan.behavioral_deltas ?? plan.behavioralDeltas) : undefined) ??
      (storyRec !== null ? (storyRec.behavioral_deltas ?? storyRec.behavioralDeltas) : undefined),
  };

  const coverage = validateProjectInvariantCoverage({
    applicableIds,
    draft,
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
