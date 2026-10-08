/**
 * Typed plan.policy.deliveryBranch (#3041).
 *
 * Distinct from typed `plan.policy.baseBranch` (#3388), the integration-branch
 * source for the shared branch-sync detector. deliveryBranch is dest: where
 * shipped work must land for a delivered completion disposition.
 *
 * Prefer-A #5364: closed branch-name grammar + safe fetch argv helpers. Do not
 * equate `git check-ref-format refs/heads/<input>` exit 0 with this grammar.
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

/** Terminal configuration error for hostile / invalid present branch policy (#5364). */
export class InvalidBranchNameError extends Error {
  readonly branch: string;
  readonly field: string;

  constructor(branch: string, field = "branch") {
    super(
      `Invalid ${field} ${JSON.stringify(branch)}: must match the closed branch-name grammar ` +
        `(no leading '-', no ':', no '..', no ASCII controls, no spaces, no '@{', no '.lock' suffix)`,
    );
    this.name = "InvalidBranchNameError";
    this.branch = branch;
    this.field = field;
  }
}

/**
 * Prefer-A #5364 closed branch-name grammar.
 *
 * Rejects option-shaped and refspec-shaped names even when
 * `git check-ref-format refs/heads/<input>` would exit 0 (e.g. `-x`,
 * `--upload-pack=...`).
 */
export function isSafeBranchName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) {
    return false;
  }
  // Reject literal input; do not expand revision shorthand or trim-then-accept.
  if (name !== name.trim()) {
    return false;
  }
  if (name.startsWith("-")) {
    return false;
  }
  if (name.includes(":")) {
    return false;
  }
  if (name.includes("..")) {
    return false;
  }
  if (name.includes("@{")) {
    return false;
  }
  if (name.endsWith(".lock")) {
    return false;
  }
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  if (/\s/.test(name)) {
    return false;
  }
  // Reject fetch/refspec wildcards and revision sugar that would expand before spawn.
  if (/[*?[\]~^\\]/.test(name)) {
    return false;
  }
  return true;
}

export type SafeBranchResult =
  | { readonly ok: true; readonly branch: string }
  | { readonly ok: false; readonly error: string };

/**
 * Returned-failure gate (#5364 / intent-constraint free pattern).
 *
 * Builds {@link InvalidBranchNameError}.message without throw/reject/abort.
 */
export function assertSafeBranchName(name: string, field = "branch"): SafeBranchResult {
  if (!isSafeBranchName(name)) {
    return { ok: false, error: new InvalidBranchNameError(name, field).message };
  }
  return { ok: true, branch: name };
}

export interface SafeFetchArgvOptions {
  readonly quiet?: boolean;
  readonly force?: boolean;
}

export type SafeFetchArgvResult =
  | { readonly ok: true; readonly argv: string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Safe tracking-ref fetch argv (#5364 limb 3).
 *
 * `git fetch <remote> -- refs/heads/<validated>:refs/remotes/<remote>/<validated>`
 * places `--` before the refspec and couples the dest to `origin/<branch>` tip readers.
 */
export function trackingFetchArgv(
  remote: string,
  branch: string,
  options: SafeFetchArgvOptions = {},
): SafeFetchArgvResult {
  const safe = assertSafeBranchName(branch);
  if (!safe.ok) {
    return safe;
  }
  const argv = ["fetch"];
  if (options.force === true) {
    argv.push("--force");
  }
  if (options.quiet === true) {
    argv.push("--quiet");
  }
  argv.push(remote, "--", `refs/heads/${safe.branch}:refs/remotes/${remote}/${safe.branch}`);
  return { ok: true, argv };
}

/**
 * Safe private-dest fetch argv (#5364 limb 4).
 *
 * `git fetch <remote> -- refs/heads/<validated>:<destRef>` after gating the branch.
 */
export function privateDestFetchArgv(
  remote: string,
  branch: string,
  destRef: string,
  options: SafeFetchArgvOptions = {},
): SafeFetchArgvResult {
  const safe = assertSafeBranchName(branch);
  if (!safe.ok) {
    return safe;
  }
  if (destRef.length === 0 || destRef.startsWith("-") || destRef.includes("\0")) {
    return { ok: false, error: new InvalidBranchNameError(destRef, "destRef").message };
  }
  const argv = ["fetch"];
  if (options.force === true) {
    argv.push("--force");
  }
  if (options.quiet === true) {
    argv.push("--quiet");
  }
  argv.push(remote, "--", `refs/heads/${safe.branch}:${destRef}`);
  return { ok: true, argv };
}

function defaultBranchCandidates(projectRoot: string, runGit: GitRunner): string[] {
  const sym = runGit(projectRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (sym.code === 0 && sym.stdout) {
    const trimmed = sym.stdout.trim();
    // origin/main → main
    const parts = trimmed.split("/");
    const name = (parts.slice(1).join("/") || parts[0] || "").trim();
    if (name.length > 0 && isSafeBranchName(name)) {
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

/** Git-only dest when dest-ref policy has no typed deliveryBranch (#3388). */
export function resolveGitDefaultDeliveryBranch(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): string {
  return defaultBranchCandidates(projectRoot, runGit)[0] ?? DEFAULT_DELIVERY_BRANCH_FALLBACK;
}

/**
 * Resolve the project's delivery branch (#3041).
 *
 * Order: typed plan.policy.deliveryBranch → git remote default → local main/master → "master".
 * Invalid present typed policy is a terminal configuration error (#5364).
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
    const trimmed = raw.trim();
    const checked = assertSafeBranchName(trimmed, FIELD_DELIVERY_BRANCH);
    if (!checked.ok) {
      // Terminal refuse via error field — empty branch cannot pass later argv gates.
      return { branch: "", source: "typed", error: checked.error };
    }
    return { branch: checked.branch, source: "typed", error: null };
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
