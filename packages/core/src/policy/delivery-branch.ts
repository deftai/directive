/**
 * Typed plan.policy.deliveryBranch (#3041).
 *
 * Distinct from typed `plan.policy.baseBranch` (#3388), the integration-branch
 * source for the shared branch-sync detector. deliveryBranch is dest: where
 * shipped work must land for a delivered completion disposition.
 */

import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_DELIVERY_BRANCH = "plan.policy.deliveryBranch";
export const FIELD_DELIVERY_BRANCH_CLI_ALIAS = "deliveryBranch";

/** Framework fallback when neither policy nor git default can be resolved. */
export const DEFAULT_DELIVERY_BRANCH_FALLBACK = "master";

export type DeliveryBranchSource =
  | "typed"
  | "git-default"
  | "default-fallback"
  | "default-on-error";

export interface DeliveryBranchResult {
  readonly branch: string;
  readonly source: DeliveryBranchSource;
  readonly error: string | null;
}

function defaultBranchCandidates(projectRoot: string, runGit: GitRunner): string[] {
  const sym = runGit(projectRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (sym.code === 0 && sym.stdout) {
    const trimmed = sym.stdout.trim();
    // origin/main → main
    const parts = trimmed.split("/");
    const name = (parts.slice(1).join("/") || parts[0] || "").trim();
    if (name.length > 0) {
      return [name];
    }
  }
  const candidates: string[] = [];
  for (const branch of ["main", "master"]) {
    const check = runGit(projectRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ]);
    if (check.code === 0) {
      candidates.push(branch);
    }
  }
  if (candidates.length === 0) {
    for (const branch of ["main", "master"]) {
      const local = runGit(projectRoot, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      if (local.code === 0) {
        candidates.push(branch);
      }
    }
  }
  return candidates;
}

/**
 * Resolve the project's delivery branch (#3041).
 *
 * Order: typed plan.policy.deliveryBranch → git remote default → local main/master → "master".
 */
export function resolveDeliveryBranch(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): DeliveryBranchResult {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    const gitDefault = defaultBranchCandidates(projectRoot, runGit)[0];
    if (gitDefault !== undefined) {
      return { branch: gitDefault, source: "git-default", error: err };
    }
    return {
      branch: DEFAULT_DELIVERY_BRANCH_FALLBACK,
      source: "default-fallback",
      error: err,
    };
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    const gitDefault = defaultBranchCandidates(projectRoot, runGit)[0];
    return {
      branch: gitDefault ?? DEFAULT_DELIVERY_BRANCH_FALLBACK,
      source: gitDefault !== undefined ? "git-default" : "default-fallback",
      error: "PROJECT-DEFINITION 'plan' is not an object",
    };
  }

  const policyBlock = readPlanPolicy(plan);
  if (
    typeof policyBlock === "object" &&
    policyBlock !== null &&
    !Array.isArray(policyBlock) &&
    "deliveryBranch" in policyBlock
  ) {
    const raw = (policyBlock as Record<string, unknown>).deliveryBranch;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      const gitDefault = defaultBranchCandidates(projectRoot, runGit)[0];
      return {
        branch: gitDefault ?? DEFAULT_DELIVERY_BRANCH_FALLBACK,
        source: "default-on-error",
        error: `plan.policy.deliveryBranch must be a non-empty string; got ${typeof raw}`,
      };
    }
    return { branch: raw.trim(), source: "typed", error: null };
  }

  const gitDefault = defaultBranchCandidates(projectRoot, runGit)[0];
  if (gitDefault !== undefined) {
    return { branch: gitDefault, source: "git-default", error: null };
  }
  return {
    branch: DEFAULT_DELIVERY_BRANCH_FALLBACK,
    source: "default-fallback",
    error: null,
  };
}

export interface DeliveryBranchPolicyField {
  readonly name: string;
  readonly current: string;
  readonly default: string;
  readonly source: string;
}

/** Inspector row for `task policy:show --field=deliveryBranch` (#3041). */
export function inspectDeliveryBranch(
  _data: Record<string, unknown> | null,
  projectRoot?: string,
): DeliveryBranchPolicyField {
  if (projectRoot === undefined || projectRoot.length === 0) {
    return {
      name: FIELD_DELIVERY_BRANCH,
      current: DEFAULT_DELIVERY_BRANCH_FALLBACK,
      default: DEFAULT_DELIVERY_BRANCH_FALLBACK,
      source: "default",
    };
  }
  const resolved = resolveDeliveryBranch(projectRoot);
  return {
    name: FIELD_DELIVERY_BRANCH,
    current: resolved.branch,
    default: DEFAULT_DELIVERY_BRANCH_FALLBACK,
    source: resolved.source,
  };
}
