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
import { resolveReviewers } from "../policy/reviewers.js";
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
import { loadThinHtmlInlineFindings } from "../pr-merge-readiness/greptile-inline.js";
import {
  botReviewCheckPresent,
  evaluateReviewerExpectation,
  reviewerConfigPresent,
} from "../pr-merge-readiness/reviewer-presence.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { isGreptileReviewInFlight } from "./greptile-sha-stall.js";
import type { WatchProbe } from "./types.js";

/** REST pulls lifecycle fields (#4288) — same `/pulls/<N>` surface as HEAD/mergeability. */
export interface PrLifecycleRest {
  readonly state: string | null;
  readonly merged: boolean | null;
  readonly error: string | null;
}

/**
 * Fetch PR `state` / `merged` via REST `repos/.../pulls/<N>` (#4288).
 * Returned failures only (no throw). Reuses the existing pulls REST path —
 * not GraphQL `gh pr view --json`.
 */
export function fetchPrLifecycleRest(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): PrLifecycleRest {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return {
      state: null,
      merged: null,
      error: `gh api /pulls/${prNumber} failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return { state: null, merged: null, error: "empty body from gh api /pulls/<N>" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { state: null, merged: null, error: `could not parse PR JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { state: null, merged: null, error: "unexpected PR JSON shape (not a dict)" };
  }
  const pr = payload as Record<string, unknown>;
  const rawState = pr.state;
  const state = typeof rawState === "string" ? rawState : null;
  // GitHub emits boolean `merged`; coerce only when the key is present as boolean.
  const merged = typeof pr.merged === "boolean" ? pr.merged : null;
  return { state, merged, error: null };
}

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
    reviewerReadyState: null,
    reviewCycleHandback: null,
    prState: null,
    prMerged: null,
    error: message,
  };
}

/** Lifecycle-terminal probe: skip Greptile body / SHA-match holdout (#4288). */
function lifecycleProbe(
  headSha: string | null,
  state: string | null,
  merged: boolean | null,
): WatchProbe {
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
    reviewerReadyState: null,
    reviewCycleHandback: null,
    prState: state,
    prMerged: merged,
    error: null,
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

  // 1b. PR lifecycle short-circuit (#4288) — ahead of Greptile body / SHA-match.
  // merged=true → MERGED (exit 0); closed+!merged → CLOSED_UNMERGED (exit 2).
  // Open PRs (or unresolved lifecycle) fall through to today's Greptile path.
  let prState: string | null = null;
  let prMerged: boolean | null = null;
  if (repo !== null) {
    const lifecycle = fetchPrLifecycleRest(prNumber, repo, runGh);
    if (lifecycle.error !== null) {
      // Soft fail-closed (#4288): do not fall through to Greptile CLEAN, and do
      // not terminal CONFIG on transient REST (429/503). Keep polling.
      return {
        ...lifecycleProbe(headSha, null, null),
        cleanGateHoldout: "lifecycle_unknown",
        error: null,
      };
    }
    prState = lifecycle.state;
    prMerged = lifecycle.merged;
    if (prMerged === true) {
      return lifecycleProbe(headSha, prState ?? "closed", true);
    }
    if (prState === "closed" && prMerged === false) {
      return lifecycleProbe(headSha, "closed", false);
    }
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
  // Fail-closed (#5162 P1): unknown/unreachable check-run inventory is treated as
  // in-flight so sticky tip-rot cannot false-escalate to GREPTILE_SHA_STALL.
  let greptileReviewInFlight = repo !== null;
  let commentsAdded: number | null = null;
  let checkRunsUnknown = true;
  let botCheckPresent = false;
  if (repo !== null) {
    const check = fetchCheckRunsRest(headSha, repo, runGh);
    if (check.summary !== null) {
      checkRunsUnknown = false;
      botCheckPresent = botReviewCheckPresent(check.checkRuns);
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
      greptileReviewInFlight = isGreptileReviewInFlight(greptileRun?.status);
      commentsAdded = parseCommentsAdded(greptileRun?.summary);
    }
    // summary === null → leave greptileReviewInFlight true (inventory unknown).
  }

  let restPullComments: { p0Count: number; p1Count: number } | null = null;
  if (thinHtmlSummary && repo !== null) {
    const inline = loadThinHtmlInlineFindings(prNumber, repo, headSha, runGh);
    if (inline.error === null) {
      restPullComments = { p0Count: inline.p0Count, p1Count: inline.p1Count };
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

  const root = projectRoot ?? process.cwd();
  const expectation = evaluateReviewerExpectation({
    policyReviewers: resolveReviewers(root).reviewers,
    reviewCommentPresent: found && shaMatch,
    botReviewCheckPresent: botCheckPresent,
    reviewerConfigPresent: reviewerConfigPresent(root),
    checkRunsUnknown,
    ciReadyState,
  });
  if (expectation.state === "no_reviewer_installed") {
    isClean = false;
    cleanGateHoldout = "no_reviewer_installed";
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
    greptileReviewInFlight,
    isClean,
    cleanGateHoldout,
    reviewerReadyState: expectation.state,
    reviewCycleHandback: expectation.handback,
    prState,
    prMerged,
    error: null,
  };
}
