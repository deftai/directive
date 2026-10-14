/**
 * Limb 2: per-phase observables for the prescribed pre-PR workflow (#4912).
 * Written before implementation of the controller and pass predicate.
 */

export const PRE_PR_WORKFLOW_VERSION = "deft.pre-pr-workflow.v1" as const;
export const PRE_PR_SKILL_ID = "deft-directive-pre-pr" as const;
export const PRE_PR_CONTROLLER_VERSION = "1" as const;

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
    command: "vitest run --coverage <changed-paths>",
  },
  {
    id: "coverage_headroom",
    kind: "command-observable",
    required: true,
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
    required: true,
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

export const ALLOWED_SKIP_REASONS: Partial<Record<PrePrPhaseId, string>> = {
  plan_sequence: "no active ordered-plan sequence",
  render_export: "no existing export files to refresh",
  coverage_headroom: COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP,
};

/** Command-observable skip is legal only for the closed skip reason of that phase. */
export function isAllowedSkip(phaseId: PrePrPhaseId, skipReason: string | null): boolean {
  if (skipReason === null || skipReason.length === 0) return false;
  const allowed = ALLOWED_SKIP_REASONS[phaseId];
  return allowed !== undefined && skipReason === allowed;
}
