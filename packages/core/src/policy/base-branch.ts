/**
 * Typed plan.policy.baseBranch (#3388).
 *
 * Integration-branch source for the shared branch-sync detector. Distinct from
 * deliveryBranch (dest). Unset or invalid baseBranch resolves to dest so sync
 * is a no-op. origin/develop is never identity; it may only emit a hint.
 */

import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { DEFAULT_DELIVERY_BRANCH_FALLBACK, resolveDeliveryBranch } from "./delivery-branch.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_BASE_BRANCH = "plan.policy.baseBranch";
export const FIELD_BASE_BRANCH_CLI_ALIAS = "baseBranch";

/** Nudge only — never used as dest or source identity (#3388 / #3377 Q1). */
export const ORIGIN_DEVELOP_HINT =
  "origin/develop exists; set plan.policy.baseBranch if this repo uses an integration branch";

export type BaseBranchSource = "typed" | "equals-dest" | "default-on-error";

export interface BaseBranchResult {
  readonly branch: string;
  readonly dest: string;
  readonly source: BaseBranchSource;
  readonly typed: boolean;
  readonly error: string | null;
  readonly developHint: string | null;
}

function originRefExists(projectRoot: string, branch: string, runGit: GitRunner): boolean {
  const check = runGit(projectRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${branch}`,
  ]);
  return check.code === 0;
}

function developHintIfEligible(
  projectRoot: string,
  typed: boolean,
  runGit: GitRunner,
): string | null {
  if (typed) return null;
  if (!originRefExists(projectRoot, "develop", runGit)) return null;
  return ORIGIN_DEVELOP_HINT;
}

/**
 * Resolve plan.policy.baseBranch (#3388).
 *
 * Unset or invalid values equal dest (deliveryBranch). origin/develop is never
 * substituted as the source.
 */
export function resolveBaseBranch(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): BaseBranchResult {
  const dest =
    resolveDeliveryBranch(projectRoot, runGit).branch || DEFAULT_DELIVERY_BRANCH_FALLBACK;
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return {
      branch: dest,
      dest,
      source: "equals-dest",
      typed: false,
      error: err,
      developHint: developHintIfEligible(projectRoot, false, runGit),
    };
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      branch: dest,
      dest,
      source: "equals-dest",
      typed: false,
      error: "PROJECT-DEFINITION 'plan' is not an object",
      developHint: developHintIfEligible(projectRoot, false, runGit),
    };
  }

  const policyBlock = readPlanPolicy(plan);
  if (
    typeof policyBlock === "object" &&
    policyBlock !== null &&
    !Array.isArray(policyBlock) &&
    "baseBranch" in policyBlock
  ) {
    const raw = (policyBlock as Record<string, unknown>).baseBranch;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return {
        branch: dest,
        dest,
        source: "default-on-error",
        typed: false,
        error: `plan.policy.baseBranch must be a non-empty string; got ${typeof raw}`,
        developHint: developHintIfEligible(projectRoot, false, runGit),
      };
    }
    return {
      branch: raw.trim(),
      dest,
      source: "typed",
      typed: true,
      error: null,
      developHint: null,
    };
  }

  return {
    branch: dest,
    dest,
    source: "equals-dest",
    typed: false,
    error: null,
    developHint: developHintIfEligible(projectRoot, false, runGit),
  };
}

export interface BaseBranchPolicyField {
  readonly name: string;
  readonly current: string;
  readonly default: string;
  readonly source: string;
}

/** Inspector row for `task policy:show --field=baseBranch` (#3388). */
export function inspectBaseBranch(
  _data: Record<string, unknown> | null,
  projectRoot?: string,
): BaseBranchPolicyField {
  if (projectRoot === undefined || projectRoot.length === 0) {
    return {
      name: FIELD_BASE_BRANCH,
      current: DEFAULT_DELIVERY_BRANCH_FALLBACK,
      default: DEFAULT_DELIVERY_BRANCH_FALLBACK,
      source: "equals-dest",
    };
  }
  const resolved = resolveBaseBranch(projectRoot);
  return {
    name: FIELD_BASE_BRANCH,
    current: resolved.branch,
    default: resolved.dest,
    source: resolved.source,
  };
}
