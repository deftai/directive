import {
  detect,
  evaluateCleanGate,
  isGreptileReviewTerminal,
  isThinHtmlSummary,
  parseCommentsAdded,
  parseConfidence,
  parseLastReviewedShaMarkdownLink,
  parseLastReviewedShaNaiveInline,
  resolveFindingsChannel,
  resolveShaCurrency,
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
import { fetchGreptilePullCommentsRest } from "../pr-merge-readiness/greptile-inline.js";
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
  const bodySha = parseLastReviewedShaMarkdownLink(body) ?? parseLastReviewedShaNaiveInline(body);
  const thinHtmlSummary = isThinHtmlSummary(body);

  // 3. CI failures (best-effort). When check-runs are unreachable we degrade to
  // ci_failures=0 / terminal so the Greptile verdict drives; the merge button
  // still owns the hard CI gate via pr:merge-ready (#796).
  // WatchProbe.terminalCheckRun remains pending_required completeness (CI).
  // SHA currency for thin HTML uses the Greptile Review check-run on HEAD, not
  // pending_required (#4289).
  let ciFailures = 0;
  let ciFailedChecks: readonly string[] = [];
  let ciReadyState: string | null = null;
  let ciCapacityStalledChecks: readonly string[] = [];
  let terminalCheckRun = true;
  let greptileReviewTerminal = false;
  let commentsAdded: number | null = null;
  if (repo !== null) {
    const check = fetchCheckRunsRest(headSha, repo, runGh);
    if (check.summary !== null) {
      const ci = evaluateCiGate(check.checkRuns, {});
      ciFailedChecks = ci.summary.failed_required;
      ciFailures = ciFailedChecks.length;
      ciReadyState = ci.summary.ready_state;
      ciCapacityStalledChecks = ci.summary.capacity_stalled_required;
      terminalCheckRun = ci.summary.pending_required.length === 0;
      const greptileRun = check.checkRuns.find((run) => run.name === "Greptile Review");
      greptileReviewTerminal = isGreptileReviewTerminal(
        greptileRun?.status,
        greptileRun?.conclusion,
      );
      commentsAdded = parseCommentsAdded(greptileRun?.summary);
    }
  }

  let restPullComments: { p0Count: number; p1Count: number } | null = null;
  if (thinHtmlSummary && repo !== null) {
    const rest = fetchGreptilePullCommentsRest(prNumber, repo, headSha, runGh);
    if (rest.error === null) {
      restPullComments = { p0Count: rest.p0Count, p1Count: rest.p1Count };
    }
  }

  const sha = resolveShaCurrency({
    bodySha,
    headSha,
    thinHtmlSummary,
    greptileReviewTerminalOnHead: greptileReviewTerminal,
  });
  const lastReviewedSha = sha.sha;
  const channel = resolveFindingsChannel({
    thinHtmlSummary,
    bodyDetect: findings,
    commentsAdded,
    restPullComments,
  });
  const shaMatch = lastReviewedSha !== null && lastReviewedSha === headSha;
  let [isClean, cleanGateHoldout] = evaluateCleanGate({
    lastReviewedSha,
    headSha,
    hasBlocking: channel.hasBlocking,
    confidence,
    ciFailures,
    errored,
    terminalCheckRun: thinHtmlSummary ? greptileReviewTerminal : terminalCheckRun,
    minConfidence,
    findingsChannelPresent: channel.present,
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
    p0Count: channel.p0Count,
    p1Count: channel.p1Count,
    hasBlocking: channel.hasBlocking,
    errored,
    ciFailures,
    ciFailedChecks,
    ciReadyState,
    ciCapacityStalledChecks,
    terminalCheckRun,
    greptileReviewTerminal,
    isClean,
    cleanGateHoldout,
    error: null,
  };
}
