/**
 * Limb 2: per-phase observables for the prescribed pre-PR workflow (#4912).
 * Written before implementation of the controller and pass predicate.
 */

import {
  MERGE_CHOKPOINT_NO_OBLIGATION_SKIP as SCOPE_MERGE_CHOKPOINT_NO_OBLIGATION_SKIP,
  VERIFY_AC_NO_OBLIGATION_EXIT,
} from "../hooks/scope.js";

export const PRE_PR_WORKFLOW_VERSION = "deft.pre-pr-workflow.v1" as const;
export const PRE_PR_SKILL_ID = "deft-directive-pre-pr" as const;
export const PRE_PR_CONTROLLER_VERSION = "1" as const;
export { VERIFY_AC_NO_OBLIGATION_EXIT };

/**
 * Closed render/export rule recorded in the workflow version.
 * Refresh existing exports only; never create missing files; never hand-edit MAP.md.
 */
export const RENDER_EXPORT_RULE =
  "refresh existing PRD.md, SPECIFICATION.md, and MAP.md only; never create missing exports; never hand-edit MAP.md";

export const PRE_PR_PHASE_IDS = [
  "branch_policy",
  "plan_sequence",
  "read",
  "write",
  "lint_iteration",
  "coverage_headroom",
  "render_export",
  "diff",
  "loop",
  "merge_chokepoint",
] as const;

export type PrePrPhaseId = (typeof PRE_PR_PHASE_IDS)[number];

export type PrePrPhaseKind = "command-observable" | "semantic";

export interface PrePrPhaseSpec {
  readonly id: PrePrPhaseId;
  readonly kind: PrePrPhaseKind;
  readonly required: boolean;
  /** Named command the controller observes. Semantic phases have none. */
  readonly command: string | null;
}

export const PRE_PR_PHASES: readonly PrePrPhaseSpec[] = [
  {
    id: "branch_policy",
    kind: "command-observable",
    required: true,
    command: "deft verify:branch",
  },
  {
    id: "plan_sequence",
    kind: "command-observable",
    required: true,
    command: "deft verify:plan-sequence",
  },
  { id: "read", kind: "semantic", required: true, command: null },
  { id: "write", kind: "semantic", required: true, command: null },
  {
    id: "lint_iteration",
    kind: "command-observable",
    required: true,
    command: "vitest run <changed-paths>",
  },
  {
    id: "coverage_headroom",
    kind: "command-observable",
    required: false,
    command: "deft coverage:hotspots",
  },
  {
    id: "render_export",
    kind: "command-observable",
    required: true,
    command: RENDER_EXPORT_RULE,
  },
  { id: "diff", kind: "semantic", required: true, command: null },
  { id: "loop", kind: "semantic", required: true, command: null },
  {
    id: "merge_chokepoint",
    kind: "command-observable",
    required: false,
    command: "deft check",
  },
];

export function phaseSpec(id: PrePrPhaseId): PrePrPhaseSpec {
  const hit = PRE_PR_PHASES.find((p) => p.id === id);
  if (hit === undefined) {
    return PRE_PR_PHASES[0] as PrePrPhaseSpec;
  }
  return hit;
}

export function requiredPhases(): readonly PrePrPhaseSpec[] {
  return PRE_PR_PHASES.filter((p) => p.required);
}

/** Exact closed skip token for authorized coverage N/A (#5421 Prefer-A Bound). */
export const COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP =
  "reviewed diff has no coverable paths" as const;

/**
 * Distinct closed skip token for gate-override waived refuse (#5674 Prefer-A Bound).
 * Never reuse the N/A string; never treat as measured pass / exit 0.
 */
export const COVERAGE_HEADROOM_WAIVED_SKIP =
  "coverage-applicability refuse waived by gate-override admission" as const;

/**
 * Distinct closed skip token for coverageMode posture N/A (#5791 Prefer-A Recut-2).
 * Never reuse the inert N/A string; never treat as measured pass / exit 0.
 */
export const COVERAGE_HEADROOM_MODE_SKIP = "coverageMode posture skip (initial|disabled)" as const;

/**
 * Distinct closed skip token for lint_iteration coverageMode posture (#5814 Prefer-A Recut-1).
 * Never reuse coverage_headroom tokens; never treat as measured pass / exit 0.
 */
export const LINT_ITERATION_MODE_SKIP =
  "lint_iteration coverageMode posture skip (initial|disabled)" as const;

/**
 * Distinct closed skip token when merge_chokepoint observes admitted-untied
 * no-obligation (#5855 Recut-8). Same string as hooks/scope (SoT).
 */
export const MERGE_CHOKPOINT_NO_OBLIGATION_SKIP = SCOPE_MERGE_CHOKPOINT_NO_OBLIGATION_SKIP;

export const ALLOWED_SKIP_REASONS: Partial<Record<PrePrPhaseId, string>> = {
  plan_sequence: "no active ordered-plan sequence",
  render_export: "no existing export files to refresh",
  coverage_headroom: COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP,
  merge_chokepoint: MERGE_CHOKPOINT_NO_OBLIGATION_SKIP,
};

/** Command-observable skip is legal only for the closed skip reason of that phase. */
export function isAllowedSkip(phaseId: PrePrPhaseId, skipReason: string | null): boolean {
  if (skipReason === null || skipReason.length === 0) return false;
  if (
    phaseId === "coverage_headroom" &&
    (skipReason === COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP ||
      skipReason === COVERAGE_HEADROOM_WAIVED_SKIP ||
      skipReason === COVERAGE_HEADROOM_MODE_SKIP)
  ) {
    return true;
  }
  if (phaseId === "lint_iteration" && skipReason === LINT_ITERATION_MODE_SKIP) {
    return true;
  }
  if (phaseId === "merge_chokepoint" && skipReason === MERGE_CHOKPOINT_NO_OBLIGATION_SKIP) {
    return true;
  }
  const allowed = ALLOWED_SKIP_REASONS[phaseId];
  return allowed !== undefined && skipReason === allowed;
}
