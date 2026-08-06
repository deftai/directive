import {
  detect,
  evaluateCleanGate,
  parseConfidence,
  parseLastReviewedShaMarkdownLink,
  parseLastReviewedShaNaiveInline,
} from "../content-contracts/skills/greptile-detector.js";
import { resolveMinGreptileConfidence } from "../policy/min-greptile-confidence.js";
import { evaluateCiGate } from "../pr-merge-readiness/ci-gate.js";
import { GREPTILE_ERRORED_SENTINEL } from "../pr-merge-readiness/constants.js";
import {
  defaultRunGh,
  fetchCheckRunsRest,
  fetchGreptileBodyRest,
  fetchGreptileCommentBody,
  fetchPrHeadSha,
  fetchPrHeadShaRest,
  resolveRepo,
} from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import type { WatchProbe } from "./types.js";

function errorProbe(headSha: string | null, message: string): WatchProbe {
  return {
    found: false,
    headSha,
    lastReviewedSha: null,
    shaMatch: false,
    confidence: null,
    p0Count: 0,
    p1Count: 0,
    hasBlocking: false,
    errored: false,
    ciFailures: 0,
    ciFailedChecks: [],
    ciReadyState: null,
    ciCapacityStalledChecks: [],
    terminalCheckRun: false,
    isClean: false,
    cleanGateHoldout: null,
    error: message,
  };
}

/**
 * Run one PR-verdict probe: resolve HEAD, fetch the latest Greptile/SLizard
 * rolling-summary body, and score it through the CANONICAL shared detector
 * (`detect` / `parseConfidence` / `parseLastReviewedSha*` / `evaluateCleanGate`
 * from content-contracts/skills/greptile-detector.ts -- the same module the
 * swarm poller template and its #910/#1035/#1039 tests consume). No second
 * detector (#1056 AC-2). All gh access routes through the injectable RunGhFn
 * seam, which defaults to the UTF-8-safe execFile capture (#1366).
 */
export function probeOnce(
  prNumber: number,
  repoArg: string | null,
  runGh: RunGhFn = defaultRunGh,
  projectRoot: string | null = null,
): WatchProbe {
  const resolved = resolveRepo(repoArg, runGh);
  const repo = resolved.repo;
  const minConfidence = resolveMinGreptileConfidence(projectRoot ?? process.cwd()).min;

  // 1. HEAD SHA -- primary `gh pr view`, then REST fallback when a repo resolved.
  let headSha = fetchPrHeadSha(prNumber, repo, runGh);
  if (headSha === null && repo !== null) {
    headSha = fetchPrHeadShaRest(prNumber, repo, runGh).sha;
  }
  if (headSha === null) {
    const detail =
      repo === null
        ? `could not resolve repo (${resolved.error}); run inside a repo or pass --repo OWNER/REPO`
        : "could not resolve PR HEAD sha (gh pr view + REST both failed)";
    return errorProbe(null, detail);
  }

  // 2. Latest Greptile body -- primary jq path, then REST fallback.
  let body = fetchGreptileCommentBody(prNumber, repo, runGh);
  if (body === null && repo !== null) {
    body = fetchGreptileBodyRest(prNumber, repo, runGh).body;
  }
  if (body === null) {
    return errorProbe(
      headSha,
      "could not fetch Greptile comment body (primary + REST both failed)",
    );
  }

  const trimmed = body.trim();
  const found = trimmed.length > 0;
  const errored = trimmed.startsWith(GREPTILE_ERRORED_SENTINEL);
  const findings = detect(body);
  const confidence = parseConfidence(body);
  const lastReviewedSha =
    parseLastReviewedShaMarkdownLink(body) ?? parseLastReviewedShaNaiveInline(body);

  // 3. CI failures (best-effort). When check-runs are unreachable we degrade to
  // ci_failures=0 / terminal so the Greptile verdict drives; the merge button
  // still owns the hard CI gate via pr:merge-ready (#796).
  let ciFailures = 0;
  let ciFailedChecks: readonly string[] = [];
  let ciReadyState: string | null = null;
  let ciCapacityStalledChecks: readonly string[] = [];
  let terminalCheckRun = true;
  if (repo !== null) {
    const check = fetchCheckRunsRest(headSha, repo, runGh);
    if (check.summary !== null) {
      const ci = evaluateCiGate(check.checkRuns, {});
      ciFailedChecks = ci.summary.failed_required;
      ciFailures = ciFailedChecks.length;
      ciReadyState = ci.summary.ready_state;
      ciCapacityStalledChecks = ci.summary.capacity_stalled_required;
      terminalCheckRun = ci.summary.pending_required.length === 0;
    }
  }

  const shaMatch = lastReviewedSha !== null && lastReviewedSha === headSha;
  let [isClean, cleanGateHoldout] = evaluateCleanGate({
    lastReviewedSha,
    headSha,
    hasBlocking: findings.has_blocking,
    confidence,
    ciFailures,
    errored,
    terminalCheckRun,
    minConfidence,
  });

  // #3167: weather not-ready states must never surface as CLEAN even when the
  // Greptile side of the clean gate is satisfied (empty CI was previously ready).
  if (
    isClean &&
    (ciReadyState === "ci_never_scheduled" ||
      ciReadyState === "runner_capacity_stall" ||
      ciReadyState === "ci_cancelled_no_failover" ||
      ciReadyState === "ci_failures" ||
      ciReadyState === "blocked" ||
      ciReadyState === "not_ready_yet")
  ) {
    isClean = false;
    cleanGateHoldout = ciReadyState === "not_ready_yet" ? "terminal_check_run" : ciReadyState;
  }

  return {
    found,
    headSha,
    lastReviewedSha,
    shaMatch,
    confidence,
    p0Count: findings.p0_count,
    p1Count: findings.p1_count,
    hasBlocking: findings.has_blocking,
    errored,
    ciFailures,
    ciFailedChecks,
    ciReadyState,
    ciCapacityStalledChecks,
    terminalCheckRun,
    isClean,
    cleanGateHoldout,
    error: null,
  };
}
