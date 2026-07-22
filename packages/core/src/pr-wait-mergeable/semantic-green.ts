import { buildCiSummaryLine, evaluateCiGate } from "../pr-merge-readiness/ci-gate.js";
import { defaultRunGh, fetchCheckRunsRest } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { EXIT_CONFIG_ERROR, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";

export interface SemanticGreenOptions {
  /** Enable merge-cascade semantic-green checks (#2385). */
  readonly cascadeMode?: boolean;
  /** After a prior cascade merge, require target-branch CI green at HEAD before the next merge. */
  readonly requireMasterCiGreen?: boolean;
  /** Target branch for stale-base comparison (defaults to PR base.ref). */
  readonly baseBranch?: string | null;
  readonly runGh?: RunGhFn;
}

export interface SemanticGreenPayload {
  readonly pr_base_sha: string | null;
  readonly target_branch: string | null;
  readonly target_head_sha: string | null;
  readonly master_ci: Record<string, unknown>;
}

export interface SemanticGreenResult {
  readonly ok: boolean;
  readonly outcome: string | null;
  readonly exitCode: number | null;
  readonly error: string | null;
  readonly payload: SemanticGreenPayload;
}

function emptyPayload(): SemanticGreenPayload {
  return {
    pr_base_sha: null,
    target_branch: null,
    target_head_sha: null,
    master_ci: {},
  };
}

function fetchPrBase(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): { baseRef: string | null; baseSha: string | null; error: string | null } {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return {
      baseRef: null,
      baseSha: null,
      error: `gh api /pulls/${prNumber} failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return { baseRef: null, baseSha: null, error: "empty body from gh api /pulls/<N>" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { baseRef: null, baseSha: null, error: `could not parse PR JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { baseRef: null, baseSha: null, error: "unexpected PR JSON shape (not a dict)" };
  }
  const base = (payload as Record<string, unknown>).base;
  if (base === null || typeof base !== "object" || Array.isArray(base)) {
    return { baseRef: null, baseSha: null, error: "PR JSON missing base object" };
  }
  const baseRecord = base as Record<string, unknown>;
  const baseRef =
    typeof baseRecord.ref === "string" && baseRecord.ref.length > 0 ? baseRecord.ref : null;
  const baseSha =
    typeof baseRecord.sha === "string" && baseRecord.sha.length > 0 ? baseRecord.sha : null;
  if (baseRef === null || baseSha === null) {
    return { baseRef, baseSha, error: "PR JSON missing base.ref or base.sha" };
  }
  return { baseRef, baseSha, error: null };
}

function fetchBranchHeadSha(
  repo: string,
  branch: string,
  runGh: RunGhFn,
): { sha: string | null; error: string | null } {
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  const rc = runGh(["gh", "api", `repos/${repo}/git/ref/heads/${encoded}`]);
  if (rc.returncode !== 0) {
    return {
      sha: null,
      error: `gh api /git/ref/heads/${branch} failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return { sha: null, error: `empty body from gh api /git/ref/heads/${branch}` };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { sha: null, error: `could not parse branch ref JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { sha: null, error: "unexpected branch ref JSON shape (not a dict)" };
  }
  const object = (payload as Record<string, unknown>).object;
  if (object === null || typeof object !== "object" || Array.isArray(object)) {
    return { sha: null, error: "branch ref JSON missing object.sha" };
  }
  const sha = (object as Record<string, unknown>).sha;
  if (typeof sha !== "string" || sha.length === 0) {
    return { sha: null, error: "branch ref JSON missing object.sha" };
  }
  return { sha, error: null };
}

function evaluateTargetBranchCi(
  repo: string,
  headSha: string,
  runGh: RunGhFn,
): { ok: boolean; error: string | null; masterCi: Record<string, unknown> } {
  const check = fetchCheckRunsRest(headSha, repo, runGh);
  if (check.error.length > 0) {
    return {
      ok: false,
      error:
        "Required CI check-runs on target branch HEAD could not be fetched; " +
        `fail closed (#2385). ${check.error}`,
      masterCi: { ready_state: "blocked", error: check.error },
    };
  }
  const ciResult = evaluateCiGate(check.checkRuns);
  const masterCi: Record<string, unknown> = {
    ...ciResult.summary,
    summary_line: buildCiSummaryLine(ciResult.summary),
  };
  if (ciResult.summary.ready_state !== "ready") {
    const detail =
      ciResult.failures.length > 0
        ? ciResult.failures.join(" ")
        : `target branch CI ready_state=${ciResult.summary.ready_state}`;
    return {
      ok: false,
      error:
        "Target branch CI is not green at current HEAD; block cascade merge until master is green (#2385). " +
        detail,
      masterCi,
    };
  }
  return { ok: true, error: null, masterCi };
}

/** Pre-merge semantic-green gate for merge cascades (#2385). */
export function evaluateSemanticGreen(
  prNumber: number,
  repo: string,
  options: SemanticGreenOptions = {},
): SemanticGreenResult {
  if (options.cascadeMode !== true) {
    return { ok: true, outcome: null, exitCode: null, error: null, payload: emptyPayload() };
  }

  const runGh = options.runGh ?? defaultRunGh;
  const prBase = fetchPrBase(prNumber, repo, runGh);
  if (prBase.error !== null) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error: prBase.error,
      payload: {
        ...emptyPayload(),
        pr_base_sha: prBase.baseSha,
        target_branch: prBase.baseRef,
      },
    };
  }

  const targetBranch = options.baseBranch ?? prBase.baseRef;
  if (targetBranch === null || targetBranch.length === 0) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error:
        "Could not resolve target branch for semantic-green gate (--base-branch or PR base.ref).",
      payload: {
        pr_base_sha: prBase.baseSha,
        target_branch: null,
        target_head_sha: null,
        master_ci: {},
      },
    };
  }

  const branchHead = fetchBranchHeadSha(repo, targetBranch, runGh);
  if (branchHead.error !== null) {
    return {
      ok: false,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      error: branchHead.error,
      payload: {
        pr_base_sha: prBase.baseSha,
        target_branch: targetBranch,
        target_head_sha: null,
        master_ci: {},
      },
    };
  }

  const payload: SemanticGreenPayload = {
    pr_base_sha: prBase.baseSha,
    target_branch: targetBranch,
    target_head_sha: branchHead.sha,
    master_ci: {},
  };

  if (prBase.baseSha !== branchHead.sha) {
    return {
      ok: false,
      outcome: "semantic-stale-base",
      exitCode: EXIT_TIMEOUT_OR_ESCALATION,
      error:
        "PR base SHA is behind the current target branch HEAD (merge-tree-clean but semantically stale). " +
        `Rebase/update-branch onto ${targetBranch} at ${branchHead.sha} and wait for fresh green CI before cascade merge (#2385). ` +
        `pr_base=${prBase.baseSha} target_head=${branchHead.sha}`,
      payload,
    };
  }

  if (options.requireMasterCiGreen === true) {
    const ci = evaluateTargetBranchCi(repo, branchHead.sha as string, runGh);
    if (!ci.ok) {
      return {
        ok: false,
        outcome: "master-ci-not-green",
        exitCode: EXIT_TIMEOUT_OR_ESCALATION,
        error: ci.error,
        payload: {
          ...payload,
          master_ci: ci.masterCi,
        },
      };
    }
    return {
      ok: true,
      outcome: null,
      exitCode: null,
      error: null,
      payload: {
        ...payload,
        master_ci: ci.masterCi,
      },
    };
  }

  return { ok: true, outcome: null, exitCode: null, error: null, payload };
}

export type SemanticGreenFn = typeof evaluateSemanticGreen;
