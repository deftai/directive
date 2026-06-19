import {
  FALLBACK2_NOT_CLEAN_MSG,
  VIA_ERROR,
  VIA_FALLBACK1,
  VIA_FALLBACK2,
  VIA_PRIMARY,
} from "./constants.js";
import { evaluateGates, isMergeReady } from "./evaluate.js";
import {
  fetchCheckRunsRest,
  fetchGreptileBodyRest,
  fetchGreptileCommentBody,
  fetchPrHeadSha,
  fetchPrHeadShaRest,
  resolveRepo,
} from "./gh.js";
import { emptyVerdict, parseGreptileBody } from "./parse.js";
import type { GateResult, RunGhFn } from "./types.js";

function buildGateResult(
  prNumber: number,
  repo: string | null,
  headSha: string | null,
  body: string,
  via: string,
  partialData: Record<string, unknown> = {},
  error: string | null = null,
): GateResult {
  const verdict = parseGreptileBody(body);
  const failures = evaluateGates(prNumber, headSha, verdict);
  return {
    prNumber,
    repo,
    headSha,
    verdict,
    failures,
    via,
    partialData,
    error,
  };
}

function computePrimary(
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
): { result: GateResult | null; partial: Record<string, unknown> } {
  const partial: Record<string, unknown> = {};

  const headSha = fetchPrHeadSha(prNumber, repo, runGh);
  if (headSha === null) {
    partial.primary_error = "gh pr view headRefOid returned non-zero";
    return { result: null, partial };
  }
  partial.head_sha = headSha;

  const body = fetchGreptileCommentBody(prNumber, repo, runGh);
  if (body === null) {
    partial.primary_error = "gh api /issues/<N>/comments --jq returned non-zero";
    return { result: null, partial };
  }

  const verdict = parseGreptileBody(body);
  const failures = evaluateGates(prNumber, headSha, verdict);
  return {
    result: {
      prNumber,
      repo,
      headSha,
      verdict,
      failures,
      via: VIA_PRIMARY,
      partialData: {},
      error: null,
    },
    partial,
  };
}

function computeFallback1(
  prNumber: number,
  repo: string | null,
  primaryPartial: Record<string, unknown>,
  runGh: RunGhFn,
): { result: GateResult | null; partial: Record<string, unknown> } {
  const partial: Record<string, unknown> = { ...primaryPartial };

  const resolved = resolveRepo(repo, runGh);
  if (resolved.repo === null) {
    partial.fallback1_error = resolved.error;
    return { result: null, partial };
  }

  let headSha = typeof partial.head_sha === "string" ? partial.head_sha : null;
  if (!headSha) {
    const head = fetchPrHeadShaRest(prNumber, resolved.repo, runGh);
    if (head.sha === null) {
      partial.fallback1_error = head.error;
      return { result: null, partial };
    }
    headSha = head.sha;
    partial.head_sha = headSha;
  }

  const bodyResult = fetchGreptileBodyRest(prNumber, resolved.repo, runGh);
  if (bodyResult.body === null) {
    partial.fallback1_error = bodyResult.error;
    return { result: null, partial };
  }

  const verdict = parseGreptileBody(bodyResult.body);
  const failures = evaluateGates(prNumber, headSha, verdict);
  const partialData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(partial)) {
    if (key !== "head_sha") {
      partialData[key] = value;
    }
  }

  return {
    result: {
      prNumber,
      repo: resolved.repo,
      headSha,
      verdict,
      failures,
      via: VIA_FALLBACK1,
      partialData,
      error: null,
    },
    partial,
  };
}

function computeFallback2(
  prNumber: number,
  repo: string | null,
  priorPartial: Record<string, unknown>,
  runGh: RunGhFn,
): { result: GateResult | null; partial: Record<string, unknown> } {
  const partial: Record<string, unknown> = { ...priorPartial };

  const resolved = resolveRepo(repo, runGh);
  if (resolved.repo === null) {
    partial.fallback2_error = resolved.error;
    return { result: null, partial };
  }

  const rc = runGh(["gh", "api", `repos/${resolved.repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    partial.fallback2_error = `gh api /pulls/${prNumber} failed: ${rc.stderr.trim()}`;
    return { result: null, partial };
  }

  let prPayload: unknown;
  try {
    prPayload = rc.stdout.trim().length > 0 ? (JSON.parse(rc.stdout) as unknown) : null;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    partial.fallback2_error = `could not parse PR JSON: ${message}`;
    return { result: null, partial };
  }

  if (prPayload === null || typeof prPayload !== "object" || Array.isArray(prPayload)) {
    partial.fallback2_error = "unexpected PR JSON shape (not a dict)";
    return { result: null, partial };
  }

  const pr = prPayload as Record<string, unknown>;
  const state = pr.state;
  const merged = Boolean(pr.merged);
  const mergeable = pr.mergeable;
  const mergeableState = pr.mergeable_state;
  let headSha: string | null = null;
  const headBlock = pr.head;
  if (headBlock !== null && typeof headBlock === "object" && !Array.isArray(headBlock)) {
    const candidate = (headBlock as Record<string, unknown>).sha;
    if (typeof candidate === "string" && candidate.length > 0) {
      headSha = candidate;
    }
  }
  if (headSha === null && typeof partial.head_sha === "string") {
    headSha = partial.head_sha;
  }

  let checkSummary: Record<string, unknown> | null = null;
  if (headSha) {
    const check = fetchCheckRunsRest(headSha, resolved.repo, runGh);
    if (check.summary === null && check.error) {
      partial.fallback2_check_runs_error = check.error;
    } else {
      checkSummary = check.summary;
    }
  }

  const fallbackPartial: Record<string, unknown> = {
    pr_state: state,
    merged,
    mergeable,
    mergeable_state: mergeableState,
    check_runs: checkSummary,
  };
  for (const key of ["primary_error", "fallback1_error", "fallback2_check_runs_error"] as const) {
    if (key in partial) {
      fallbackPartial[key] = partial[key];
    }
  }

  return {
    result: {
      prNumber,
      repo: resolved.repo,
      headSha,
      verdict: emptyVerdict(),
      failures: [FALLBACK2_NOT_CLEAN_MSG],
      via: VIA_FALLBACK2,
      partialData: fallbackPartial,
      error: null,
    },
    partial,
  };
}

function errorResult(
  prNumber: number,
  repo: string | null,
  partial: Record<string, unknown>,
): GateResult {
  const pieces: string[] = [];
  for (const key of ["primary_error", "fallback1_error", "fallback2_error"] as const) {
    if (key in partial) {
      pieces.push(`${key}=${String(partial[key])}`);
    }
  }
  const error =
    pieces.length > 0
      ? pieces.join("; ")
      : "every fallback layer failed without a reportable error";

  return {
    prNumber,
    repo,
    headSha: typeof partial.head_sha === "string" ? partial.head_sha : null,
    verdict: emptyVerdict(),
    failures: [
      "pr_merge_readiness external error -- every fallback layer " +
        "failed; see partial_data for diagnostic detail (#1368).",
    ],
    via: VIA_ERROR,
    partialData: { ...partial },
    error,
  };
}

/** Run the primary->fallback1->fallback2 cascade and return a result. */
export function computeGateResult(
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
): GateResult {
  let { result, partial } = computePrimary(prNumber, repo, runGh);
  if (result !== null) {
    return result;
  }

  ({ result, partial } = computeFallback1(prNumber, repo, partial, runGh));
  if (result !== null) {
    return result;
  }

  ({ result, partial } = computeFallback2(prNumber, repo, partial, runGh));
  if (result !== null) {
    return result;
  }

  return errorResult(prNumber, repo, partial);
}

export { buildGateResult, isMergeReady };
