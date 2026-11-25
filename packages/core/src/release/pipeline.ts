import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { effectiveChangelogText } from "../changelog/effective-unreleased.js";
import { restIssueListOpenInventory } from "../scm/gh-rest.js";
import { isStep5HostCoverage } from "../ts-check-lane/run-lane.js";
import { readCoverageTotalsFromReport } from "../vitest-runner/coverage-debt.js";
import {
  buildCoverageDebtIssueDraft,
  classifyStep5FailureWithFreshness,
  countFailedTestsFromSanitizedOutput,
  evaluateAutoHatch,
  formatAutoHatchBanner,
  parseExitCodeFromReason,
  reasonLooksLikeTimeout,
} from "./auto-hatch.js";
import { guardChangelogReadSafety } from "./changelog-read-safety.js";
import {
  type CiReuseDecision,
  classifyReleaseInputCleanliness,
  evaluateCiReuse,
  formatCiReuseChange,
  formatCiReuseDecision,
  runHostSmokeCheck,
  windowsSuiteSkippedLineForSmokeOnly,
} from "./ci-reuse.js";
import {
  emitCliDriftReportBestEffort,
  shouldSkipRegistryPoll,
  type WorkspacePackageName,
} from "./cli-drift-report.js";
import { assertTagPushClosedVerb } from "./closed-verb-gate.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_OK,
  EXIT_VIOLATION,
  RELEASE_ARTIFACTS,
  RELEASE_CHECK_TIMEOUT_MINUTES,
  TOTAL_STEPS,
} from "./constants.js";
import { formatConsumerReadinessDisclosure } from "./consumer-readiness-disclosure.js";
import {
  createCoverageDebtIssue,
  probeOpenCoverageDebtLedger,
  probeSkipCiIncidentLedger,
} from "./coverage-debt-ledger.js";
import { runGithubReleaseSteps } from "./finish.js";
import { checkTagAvailable } from "./gh.js";
import {
  checkGitClean,
  commitReleaseArtifacts,
  createTag,
  currentBranch,
  pushRelease,
  releaseCommitSubject,
  runGit,
} from "./git.js";
import { checkVbriefLifecycleSyncNative, runBuildNative } from "./native-steps.js";
import { windowsSuiteSkippedLine } from "./nightly-reuse.js";
import { todayIso } from "./paths.js";
import { runReleaseCheck } from "./preflight.js";
import {
  type PreparedArtifacts,
  prepareReleaseArtifacts,
  writeReleaseArtifacts,
} from "./release-artifacts.js";
import {
  escapeReleaseDisplay,
  type ReleaseInputPhase,
  validateReleaseInputs,
  writeEscapedReleaseLine,
  writeReleaseInputDetails,
} from "./release-input.js";
import {
  checkReleaseBranch,
  finishCommand,
  openReleasePr,
  pushReleaseBranch,
  releaseBranchName,
} from "./release-pr.js";
import { evaluateReleaseConsumerReadiness, issuesFromInventory } from "./run-consumer-readiness.js";
import { formatSkipCiIncidentWarning, validateSkipCiUnpaidLedger } from "./skip-ci-incident.js";
import { evaluateSuiteStamp, writeSuiteStamp } from "./suite-stamp.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

function resolveHeadSha(projectRoot: string, seams: ReleaseSeams): string | null {
  if (seams.headSha) return seams.headSha(projectRoot);
  const result = runGit(projectRoot, ["rev-parse", "HEAD"], seams);
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha || null;
}

function resolveCoverageTotals(projectRoot: string, seams: ReleaseSeams) {
  if (seams.readCoverageTotals) return seams.readCoverageTotals(projectRoot);
  return readCoverageTotalsFromReport(join(projectRoot, "coverage"));
}

function resolveCoverageReportMtimeMs(
  projectRoot: string,
  seams: ReleaseSeams,
): number | null | undefined {
  // Explicit readCoverageTotals seam (tests) → omit mtime so freshness does not force UNKNOWN.
  if (seams.readCoverageTotals) return undefined;
  const finalPath = join(projectRoot, "coverage", "coverage-final.json");
  try {
    if (!existsSync(finalPath)) return null;
    return statSync(finalPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Options for suite-bound coverage-final expectation (#5026 / #5239 F1). */
export interface SuiteBoundCoverageDeclineOptions {
  /**
   * When false, the child lane was the #5026 no-coverage host path.
   * When omitted, derive from `env` via `DEFT_RELEASE_PREFLIGHT` (tests only —
   * production Step 5 must pass an explicit value so parent ambient env cannot
   * mask the child lane).
   */
  readonly hostCoverage?: boolean;
  /** Env used only when `hostCoverage` is omitted. */
  readonly env?: NodeJS.ProcessEnv;
}

/** True only when this Step 5 invocation was expected to write coverage-final.json. */
export function suiteExpectedToWriteLocalCoverage(
  reason: string,
  options: SuiteBoundCoverageDeclineOptions = {},
): boolean {
  const env = options.env ?? process.env;
  const hostCoverage = options.hostCoverage ?? isStep5HostCoverage(env);
  if (!hostCoverage) return false;
  if (countFailedTestsFromSanitizedOutput(reason) !== null) return true;
  return /\bts:check-lane\b/i.test(reason);
}

export function formatSuiteBoundCoverageDecline(
  coverageReportMtimeMs: number | null,
  reason: string,
  options: SuiteBoundCoverageDeclineOptions = {},
): string {
  if (coverageReportMtimeMs != null) {
    return "coverage-final.json mtime not strictly after suite start";
  }
  if (!suiteExpectedToWriteLocalCoverage(reason, options)) {
    return "coverage-final.json not produced (suite was not expected to write a local report)";
  }
  return "coverage-final.json missing after suite";
}

function recordSuiteStamp(
  projectRoot: string,
  suite: "pass" | "pass_with_debt",
  debtIssue: number | null,
  seams: ReleaseSeams,
): void {
  const headSha = resolveHeadSha(projectRoot, seams);
  if (!headSha) return;
  try {
    writeSuiteStamp(
      projectRoot,
      {
        headSha,
        suite,
        debtIssue,
        hostCoverageWitness: true,
        recordedAt: new Date().toISOString(),
      },
      {
        readFile: seams.readFile,
        writeFile: seams.writeFile,
        fileExists: seams.fileExists,
      },
    );
  } catch {
    // Stamp is best-effort; never fail a green/hatch cut on stamp I/O.
  }
}

/**
 * #6791: evaluate the Step 5 CI reuse rule and print the decision (and any
 * change since readiness). Returns null when an injected `runCi` owns the
 * Step 5 CI path and no `evaluateCiReuse` seam was given.
 */
function evaluateStep5CiReuse(config: ReleaseConfig, seams: ReleaseSeams): CiReuseDecision | null {
  const evaluate =
    seams.evaluateCiReuse ??
    (seams.runCi
      ? null
      : (root: string, repo: string, base: string) => evaluateCiReuse(root, repo, base, seams));
  if (evaluate === null) return null;
  const decision = evaluate(config.projectRoot, config.repo, config.baseBranch);
  const change = formatCiReuseChange(config.ciReuseAtReadiness, decision);
  if (change !== null) writeEscapedReleaseLine(change);
  for (const line of formatCiReuseDecision(decision)) writeEscapedReleaseLine(line);
  // #6849 / #7328 host boundary: full fallback on non-Windows, or smoke-only
  // tip-green reuse when the Windows lane is not reusable (any host OS).
  const platform = seams.hostPlatform ?? process.platform;
  if (
    decision.kind === "reuse" &&
    decision.nightly !== undefined &&
    decision.nightly !== null &&
    !decision.nightly.reusable
  ) {
    const windows = windowsSuiteSkippedLineForSmokeOnly(decision.nightly, platform);
    if (windows !== null) writeEscapedReleaseLine(windows);
  } else if (decision.kind === "full") {
    const windows = windowsSuiteSkippedLine(decision.nightly, platform);
    if (windows !== null) writeEscapedReleaseLine(windows);
  }
  return decision;
}

/**
 * Recovery after a failure between the Step 7 write and the Step 9 commit
 * (#6315 / #6286 item 6). One rule, no retry logic: restore, then rerun.
 */
export function releaseRestoreGuidance(fragmentCount: number): string {
  const paths =
    fragmentCount > 0 ? "CHANGELOG.md ROADMAP.md changelog.d/" : "CHANGELOG.md ROADMAP.md";
  return (
    "Recovery: restore CHANGELOG.md, ROADMAP.md and changelog.d/ to HEAD " +
    `(git restore --source=HEAD --staged --worktree -- ${paths}), then rerun the release. ` +
    "--allow-dirty is not a recovery path: it skips the dirty-tree guard on a partly written tree."
  );
}

export function emit(step: number, label: string, status: string, target = process.stderr): void {
  target.write(`[${step}/${TOTAL_STEPS}] ${label}... ${escapeReleaseDisplay(status)}\n`);
}

function runInputPhase(
  projectRoot: string,
  phase: ReleaseInputPhase,
  seams: ReleaseSeams,
): ReturnType<typeof validateReleaseInputs> {
  const fn = seams.validateReleaseInputs ?? validateReleaseInputs;
  return fn(projectRoot, phase);
}

export function runPipeline(config: ReleaseConfig, seams: ReleaseSeams = {}): number {
  const projectRoot = config.projectRoot;
  const version = config.version;
  const today = (seams.todayIso ?? todayIso)();
  const changelogPath = join(projectRoot, "CHANGELOG.md");
  const readFile = seams.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const runCiFn =
    seams.runCi ??
    ((root: string, debtIssue: number | null) => runReleaseCheck(root, {}, debtIssue));
  const checkVbriefFn =
    seams.checkVbriefLifecycleSync ??
    ((root: string, repo: string) => checkVbriefLifecycleSyncNative(root, repo));
  const runBuildFn =
    seams.runBuild ?? ((root: string, v: string | null) => runBuildNative(root, v, seams));

  // Step 1: dirty-tree guard (#7328 shared release-input classifier).
  let label = "Pre-flight git status";
  if (config.dryRun) {
    emit(1, label, `DRYRUN (would run \`git status --porcelain\` in ${projectRoot})`);
  } else {
    const cleanliness = classifyReleaseInputCleanliness(projectRoot, seams);
    if (cleanliness.kind === "clean") {
      emit(1, label, "OK (tree clean)");
    } else if (cleanliness.kind === "session-scratch-only") {
      emit(
        1,
        label,
        `OK (session-scratch-only; admitted without --allow-dirty):\n${cleanliness.detail}`,
      );
    } else if (config.allowDirty) {
      emit(
        1,
        label,
        `WARN (dirty, --allow-dirty set; ${cleanliness.reason}):\n${cleanliness.porcelain}`,
      );
    } else {
      emit(1, label, "FAIL (working tree is dirty; commit/stash or pass --allow-dirty)");
      process.stderr.write(`${cleanliness.reason}\n${cleanliness.porcelain}\n`);
      return EXIT_VIOLATION;
    }
  }

  // Step 2: branch guard. #6296 item 1: the cut runs on release/v<version> at
  // the fetched base tip; the base-branch run is break-glass only (item 10).
  const breakGlass = config.breakGlass === true;
  const releaseBranch = releaseBranchName(version);
  label = breakGlass
    ? `Pre-flight branch == ${config.baseBranch}`
    : `Pre-flight branch == ${releaseBranch}`;
  if (config.dryRun) {
    emit(
      2,
      label,
      breakGlass
        ? `DRYRUN (would assert current branch == ${config.baseBranch})`
        : `DRYRUN (would assert current branch == ${releaseBranch} at the fetched origin/${config.baseBranch} tip)`,
    );
  } else if (breakGlass) {
    const branch = currentBranch(projectRoot, seams);
    if (branch === config.baseBranch) {
      emit(2, label, `OK (on ${branch})`);
    } else {
      emit(2, label, `FAIL (on '${branch}'; expected '${config.baseBranch}')`);
      return EXIT_VIOLATION;
    }
  } else {
    const branch = currentBranch(projectRoot, seams);
    const check = checkReleaseBranch(projectRoot, version, config.baseBranch, branch, seams);
    if (check.ok) {
      emit(2, label, `OK (${check.reason})`);
    } else {
      emit(2, label, `FAIL (${check.reason})`);
      return check.config ? EXIT_CONFIG_ERROR : EXIT_VIOLATION;
    }
  }

  // Phase 1: five-folder committed-input validation (#4317). Before the
  // mismatch-skip branch; --allow-dirty / --allow-vbrief-drift do not skip it.
  if (config.dryRun) {
    process.stderr.write("[release-input] scanner not run; would validate\n");
  } else {
    const phase1 = runInputPhase(projectRoot, "scanner", seams);
    if (!phase1.ok) {
      writeReleaseInputDetails(phase1);
      emit(3, "Pre-flight vBRIEF lifecycle sync", `FAIL (${phase1.code})`);
      return phase1.exitCode;
    }
  }

  // Step 3: vBRIEF lifecycle sync (#734).
  label = "Pre-flight vBRIEF lifecycle sync";
  if (config.allowVbriefDrift) {
    emit(
      3,
      label,
      config.dryRun
        ? "SKIP (mismatch policy only; --allow-vbrief-drift; input validation not run)"
        : "SKIP (mismatch policy only; --allow-vbrief-drift; input validation already ran)",
    );
  } else if (config.dryRun) {
    emit(3, label, "DRYRUN (would scan vbrief/ + gh open issues for closed-issue mismatches)");
  } else {
    const [ok, mismatchCount, reason] = checkVbriefFn(projectRoot, config.repo);
    if (ok) {
      emit(3, label, "OK (no mismatches)");
    } else if (mismatchCount === -1) {
      emit(3, label, `FAIL (${reason})`);
      return EXIT_CONFIG_ERROR;
    } else {
      emit(
        3,
        label,
        `FAIL (${mismatchCount} mismatches; run task reconcile:issues -- --apply-lifecycle-fixes to fix, or pass --allow-vbrief-drift to override)`,
      );
      writeEscapedReleaseLine(reason);
      return EXIT_VIOLATION;
    }
  }

  // Step 4: tag availability pre-flight (#784).
  label = "Pre-flight tag availability";
  if (config.dryRun) {
    emit(
      4,
      label,
      `DRYRUN (would verify v${version} tag not present locally / on origin / as GitHub release on ${config.repo})`,
    );
  } else {
    const checkTag =
      seams.checkTagAvailable ??
      ((v: string, r: string, root: string) => checkTagAvailable(v, r, root, seams));
    const [ok, reason] = checkTag(version, config.repo, projectRoot);
    if (ok) {
      emit(4, label, `OK (${reason})`);
    } else {
      emit(4, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
  }

  // Step 5: CI pre-flight. The functional path now invokes the native
  // TypeScript `task check` (via `runReleaseCheck`, #2022 Phase 1) instead of
  // the ci_local.py bridge, but the emitted label/dry-run text is kept
  // byte-identical to the Python oracle (scripts/release.py) so the #1729
  // golden-diff release-parity gate stays green until the oracle is retired.
  //
  // #3187: SHA suite stamp may skip a re-run at the same clean HEAD; branch-only
  // hairline failures may auto-file coverage-debt and PASS_WITH_DEBT without a
  // second suite. CI never trusts the stamp.
  label = "Pre-flight CI (task ci:local | fallback task check)";
  const changelogSafety = guardChangelogReadSafety(projectRoot);
  if (!changelogSafety.ok) {
    emit(5, label, `FAIL (${changelogSafety.message})`);
    return changelogSafety.exitCode;
  }
  if (config.skipCi) {
    // Mirror cmdRelease unpaid-ledger gate so programmatic runPipeline callers
    // cannot bypass production unpaid citation refusal (SLizard P1 / #5239).
    // Dry-run skips the GitHub/CHANGELOG probe (same as cmdRelease).
    if (!config.dryRun && config.allowSkipCiIssue !== null && config.allowSkipCiIssue > 0) {
      const ledger =
        seams.probeSkipCiIncidentLedger?.(config.repo, projectRoot, config.allowSkipCiIssue) ??
        probeSkipCiIncidentLedger(config.repo, projectRoot, config.allowSkipCiIssue, {
          spawnText: seams.spawnText,
          whichGh: seams.whichGh,
          readFile: seams.readFile,
          fileExists: seams.fileExists,
        });
      const unpaidGate = validateSkipCiUnpaidLedger({
        skipCi: config.skipCi,
        allowSkipCiIssue: config.allowSkipCiIssue,
        allowUnpaidSkipCiIssue: config.allowUnpaidSkipCiIssue ?? null,
        unpaidIssues: ledger.unpaid,
      });
      if (unpaidGate.kind === "invalid") {
        emit(5, label, `FAIL (${unpaidGate.reason})`);
        process.stderr.write(`release: error: ${unpaidGate.reason}\n`);
        return EXIT_CONFIG_ERROR;
      }
    }
    if (config.allowSkipCiIssue !== null && config.allowSkipCiIssue > 0) {
      process.stderr.write(formatSkipCiIncidentWarning(config.allowSkipCiIssue));
    }
    emit(5, label, "SKIP (--skip-ci)");
  } else if (config.dryRun) {
    const debtNote =
      config.allowCoverageDebtIssue !== null
        ? `; would pass --allow-coverage-debt=#${config.allowCoverageDebtIssue} to task check`
        : "";
    emit(
      5,
      label,
      `DRYRUN (would run task ci:local with task check fallback${debtNote}; hard timeout ${RELEASE_CHECK_TIMEOUT_MINUTES}m)`,
    );
  } else {
    const isCi = seams.isCi?.() ?? Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
    const [treeClean] = checkGitClean(projectRoot, seams);
    const headSha = resolveHeadSha(projectRoot, seams);
    const stampEval = evaluateSuiteStamp({
      projectRoot,
      headSha,
      treeClean,
      isCi,
      io: {
        readFile: seams.readFile,
        writeFile: seams.writeFile,
        fileExists: seams.fileExists,
      },
    });
    // #6791: on a stamp miss, reuse green CI when the clean tree equals the
    // fetched tip tree. A reused cut runs no host coverage, only the smoke check.
    const reuse = stampEval.kind === "hit" ? null : evaluateStep5CiReuse(config, seams);

    if (stampEval.kind === "hit") {
      // #6071 Greptile: suite stamp must not skip the always-on named Merge gate.
      const [namedOk, namedReason] = runReleaseCheck(
        projectRoot,
        {
          skipCi: true,
          tipSha: headSha,
          skipNamedMergeGate: seams.skipNamedMergeGate,
          namedMergeGateFn: seams.namedMergeGateFn,
          runGh: seams.runGh,
        },
        config.allowCoverageDebtIssue,
      );
      if (!namedOk) {
        emit(5, label, `FAIL (suite stamp hit but named Merge gate refused: ${namedReason})`);
        return EXIT_VIOLATION;
      }
      // #6041: host-coverage witness on stamp is enough; GHA coverage-of-record cite retired.
      const debtNote =
        stampEval.stamp.suite === "pass_with_debt" && stampEval.stamp.debtIssue != null
          ? ` PASS_WITH_DEBT(#${stampEval.stamp.debtIssue})`
          : "";
      emit(
        5,
        label,
        `OK (suite stamp hit at ${stampEval.stamp.headSha.slice(0, 12)}; suite skipped${debtNote}; host coverage witnessed; named Merge gate revalidated)`,
      );
    } else if (reuse !== null && reuse.kind === "reuse") {
      const runSmoke = seams.runHostSmoke ?? ((root: string) => runHostSmokeCheck(root));
      const [smokeOk, smokeReason] = runSmoke(projectRoot);
      if (!smokeOk) {
        emit(5, label, `FAIL (CI reused at tip ${reuse.tipSha.slice(0, 12)}; ${smokeReason})`);
        return EXIT_VIOLATION;
      }
      emit(
        5,
        label,
        `OK (CI reused at tip ${reuse.tipSha.slice(0, 12)}; ${smokeReason}; no host coverage on a reused cut)`,
      );
    } else {
      // Bind auto-hatch coverage-final trust to this suite invocation (#3187).
      const suiteStartedAtMs = Date.now();
      const [ok, reason] = runCiFn(projectRoot, config.allowCoverageDebtIssue);
      if (ok) {
        const debtIssue = config.allowCoverageDebtIssue;
        const debtNote = debtIssue !== null ? ` (coverage-debt acknowledged #${debtIssue})` : "";
        recordSuiteStamp(
          projectRoot,
          debtIssue !== null ? "pass_with_debt" : "pass",
          debtIssue,
          seams,
        );
        emit(5, label, `OK (${reason}${debtNote})`);
      } else {
        // #3187 auto-hatch: one suite → classify → maybe file debt → continue.
        const totals = resolveCoverageTotals(projectRoot, seams);
        const coverageReportMtimeMs = resolveCoverageReportMtimeMs(projectRoot, seams);
        // Prefer mtime bound to this suite start (strict: after suite start).
        // No pre-start slack — a prior hairline report must not mask a later fail.
        const suiteBoundMtime =
          coverageReportMtimeMs === undefined
            ? undefined
            : coverageReportMtimeMs != null && coverageReportMtimeMs > suiteStartedAtMs
              ? coverageReportMtimeMs
              : null;
        if (coverageReportMtimeMs !== undefined && suiteBoundMtime === null) {
          // Step 5 runs host coverage (#6041). Tests may inject
          // seams.step5HostCoverage=false to exercise the no-report diagnostic
          // without mutating parent process.env (#5239 F1).
          const hostCoverage = seams.step5HostCoverage ?? true;
          const declined = formatSuiteBoundCoverageDecline(coverageReportMtimeMs, reason, {
            hostCoverage,
          });
          process.stderr.write(`auto-hatch: suite-bound coverage mtime declined (${declined})\n`);
        }
        const exitCode = parseExitCodeFromReason(reason);
        const failedTests = countFailedTestsFromSanitizedOutput(reason);
        const classification = classifyStep5FailureWithFreshness({
          output: reason,
          totals,
          exitCode,
          timedOut: reasonLooksLikeTimeout(reason) || exitCode === 124,
          failedTests,
          coverageReportMtimeMs: suiteBoundMtime,
          nowMs: Date.now(),
        });

        let openDebt: number[];
        try {
          openDebt =
            seams.listOpenCoverageDebtIssues?.(config.repo, projectRoot) ??
            probeOpenCoverageDebtLedger(config.repo, projectRoot, {
              spawnText: seams.spawnText,
              whichGh: seams.whichGh,
              readFile: seams.readFile,
              fileExists: seams.fileExists,
            });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit(
            5,
            label,
            `FAIL (${reason}; auto-hatch ledger probe failed closed: ${msg}; Step 5 hard timeout is ${RELEASE_CHECK_TIMEOUT_MINUTES}m)`,
          );
          return EXIT_VIOLATION;
        }

        let decision: ReturnType<typeof evaluateAutoHatch>;
        try {
          decision = evaluateAutoHatch({
            classification,
            totals,
            openDebtIssues: openDebt,
            existingDebtIssue: null,
            createIssue:
              totals && classification === "BRANCH_HAIRLINE" && openDebt.length === 0
                ? () => {
                    const draft = buildCoverageDebtIssueDraft({
                      version,
                      totals,
                      autoHatched: true,
                    });
                    if (seams.createCoverageDebtIssue) {
                      return seams.createCoverageDebtIssue(
                        config.repo,
                        projectRoot,
                        draft.title,
                        draft.body,
                      );
                    }
                    return createCoverageDebtIssue(
                      config.repo,
                      projectRoot,
                      draft.title,
                      draft.body,
                      {
                        spawnText: seams.spawnText,
                        whichGh: seams.whichGh,
                      },
                    );
                  }
                : undefined,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit(
            5,
            label,
            `FAIL (${reason}; auto-hatch issue create failed: ${msg}; Step 5 hard timeout is ${RELEASE_CHECK_TIMEOUT_MINUTES}m)`,
          );
          return EXIT_VIOLATION;
        }

        if (decision.kind === "pass_with_debt") {
          // #6041: host coverage already ran; GHA coverage-of-record cite retired.
          process.stderr.write(formatAutoHatchBanner(decision.issue, decision.totals));
          recordSuiteStamp(projectRoot, "pass_with_debt", decision.issue, seams);
          emit(
            5,
            label,
            `OK (PASS_WITH_DEBT(#${decision.issue}); auto-hatch ${decision.created ? "filed" : "bound"}; suite not re-run; host coverage witnessed)`,
          );
        } else {
          const debtHint =
            config.allowCoverageDebtIssue === null
              ? "; pass --allow-coverage-debt=#N only after operator review (or auto-hatch on branch-only hairline with empty ledger, #3187)"
              : "";
          emit(
            5,
            label,
            `FAIL (${reason}; auto-hatch: ${decision.reason}${debtHint}; Step 5 hard timeout is ${RELEASE_CHECK_TIMEOUT_MINUTES}m — cancel hung vitest and see docs/RELEASING.md § Vitest coverage hang recovery)`,
          );
          return EXIT_VIOLATION;
        }
      }
    }
  }

  // #3900: check 4 fail-closed (title/label census); checks 5-6 disclosure never block.
  {
    const crLabel = "Consumer-readiness census";
    let changelogText = "";
    try {
      // #6314: census and new-refusal hints read the effective [Unreleased] view.
      changelogText = effectiveChangelogText(projectRoot, readFile(changelogPath));
    } catch {
      changelogText = "";
    }
    const disclosure = formatConsumerReadinessDisclosure(changelogText);
    if (config.dryRun) {
      emit(
        5,
        crLabel,
        "DRYRUN (would enumerate open privileged hard-stop labels; disclosure does not block)",
      );
      process.stderr.write(disclosure.text + "\n");
    } else if (seams.consumerHardStops) {
      const [ok, msg] = seams.consumerHardStops(config.repo, projectRoot);
      if (!ok) {
        emit(5, crLabel, "FAIL (" + msg + ")");
        process.stderr.write(disclosure.text + "\n");
        return EXIT_VIOLATION;
      }
      emit(5, crLabel, "OK (" + msg + ")");
      process.stderr.write(disclosure.text + "\n");
    } else if (seams.runCi !== undefined || seams.spawnText !== undefined) {
      emit(5, crLabel, "SKIP (injected seam; run task verify:consumer-hard-stops at a real cut)");
      process.stderr.write(disclosure.text + "\n");
    } else {
      try {
        const rows = restIssueListOpenInventory(config.repo);
        const result = evaluateReleaseConsumerReadiness({
          changelogText,
          issues: issuesFromInventory(rows),
        });
        process.stderr.write(result.disclosure.text + "\n");
        if (result.hardStops.code !== 0) {
          emit(5, crLabel, "FAIL (" + result.hardStops.message + ")");
          return result.hardStops.code === 2 ? EXIT_CONFIG_ERROR : EXIT_VIOLATION;
        }
        emit(5, crLabel, "OK (" + result.hardStops.message + ")");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit(
          5,
          crLabel,
          "FAIL (could not list open issues. Recovery: check gh auth and REST quota. " +
            reason +
            ")",
        );
        return EXIT_CONFIG_ERROR;
      }
    }
  }

  // Phase 2: independent four-folder census after Step 5, before destination open (#4317).
  if (config.dryRun) {
    process.stderr.write("[release-input] roadmap not run; would validate\n");
  } else {
    const phase2 = runInputPhase(projectRoot, "roadmap", seams);
    if (!phase2.ok) {
      writeReleaseInputDetails(phase2);
      emit(6, "Prepare release artifacts", `FAIL (${phase2.code})`);
      return phase2.exitCode;
    }
  }

  // Step 6: prepare both artifacts and pair-open destinations. Writes nothing.
  label = "Prepare release artifacts";
  let summaryNote: string;
  if (config.summary) {
    const truncated = config.summary.slice(0, 60);
    const truncationSuffix = config.summary.length > 60 ? "..." : "";
    summaryNote = ` summary: "${truncated}${truncationSuffix}"`;
  } else {
    summaryNote = " no summary";
  }

  const preparedResult = prepareReleaseArtifacts({
    projectRoot,
    version,
    repo: config.repo,
    today,
    summary: config.summary,
    dryRun: config.dryRun,
  });
  if (!preparedResult.ok) {
    emit(6, label, `FAIL (${preparedResult.message})`);
    return preparedResult.exitCode;
  }
  const prepared: PreparedArtifacts = preparedResult.prepared;

  if (config.dryRun) {
    emit(
      6,
      label,
      `DRYRUN (would prepare ROADMAP.md and CHANGELOG.md in memory; no destination write-open;${summaryNote})`,
    );
  } else {
    emit(6, label, `OK (prepared in memory; destinations open; no writes yet;${summaryNote})`);
  }
  const fragmentPaths = prepared.fragments.map((fragment) => fragment.path);
  if (fragmentPaths.length > 0) {
    process.stderr.write(
      `[release] ${String(fragmentPaths.length)} changelog fragment(s) folded into ## [${version}]: ${fragmentPaths.join(", ")}\n`,
    );
  }
  const restoreHint = releaseRestoreGuidance(fragmentPaths.length);

  // Step 7: ROADMAP to completion, then CHANGELOG, through retained descriptors.
  label = "Write release artifacts";
  if (config.dryRun) {
    emit(
      7,
      label,
      "DRYRUN (would write ROADMAP.md then CHANGELOG.md through retained descriptors, " +
        `then delete ${String(fragmentPaths.length)} captured changelog fragment(s))`,
    );
  } else {
    const written = writeReleaseArtifacts(
      prepared,
      seams.unlinkFragment ? { unlink: seams.unlinkFragment } : {},
    );
    if (!written.ok) {
      emit(7, label, `FAIL (${written.message})`);
      process.stderr.write(`${restoreHint}\n`);
      return written.exitCode;
    }
    const deletedNote =
      written.deletedFragments.length > 0
        ? `; deleted ${String(written.deletedFragments.length)} fragment(s)`
        : "";
    emit(
      7,
      label,
      `OK (ROADMAP.md then CHANGELOG.md; ## [${version}] - ${today}${deletedNote};${summaryNote})`,
    );
  }

  // Step 8: build dist.
  label = `Build dist (task build, DEFT_RELEASE_VERSION=${version})`;
  if (config.skipBuild) {
    emit(8, label, "SKIP (--skip-build)");
  } else if (config.dryRun) {
    emit(8, label, `DRYRUN (would run \`task build\` with DEFT_RELEASE_VERSION=${version})`);
  } else {
    const [ok, reason] = runBuildFn(projectRoot, version);
    if (ok) {
      emit(8, label, `OK (${reason})`);
    } else {
      emit(8, label, `FAIL (${reason})`);
      process.stderr.write(`${restoreHint}\n`);
      return EXIT_VIOLATION;
    }
  }

  // Step 9: commit release artifacts.
  label = `Commit release artifacts (${RELEASE_ARTIFACTS.join(", ")})`;
  if (config.skipTag) {
    emit(9, label, "SKIP (--skip-tag)");
  } else if (config.dryRun) {
    emit(
      9,
      label,
      `DRYRUN (would run \`git add ${RELEASE_ARTIFACTS.join(" ")}\`, stage ${String(fragmentPaths.length)} fragment deletion(s), + \`git commit -m '${releaseCommitSubject(version)}'\`)`,
    );
  } else {
    const [ok, reason] = commitReleaseArtifacts(projectRoot, version, seams, fragmentPaths);
    if (ok) {
      emit(9, label, `OK (${reason})`);
    } else {
      emit(9, label, `FAIL (${reason})`);
      process.stderr.write(`${restoreHint}\n`);
      return EXIT_VIOLATION;
    }
  }

  // #6876: `deft release:run` cuts locally, takes its one approval, then pushes.
  if (config.stopBeforePush === true) {
    process.stderr.write(
      `Release v${version} local cut complete (Steps 1 to 9; nothing pushed).\n`,
    );
    return EXIT_OK;
  }

  // #6296 item 2: in place of Steps 10 and 11, push the release branch and open
  // the release PR. Nothing updates the base branch; the finish step tags.
  if (!breakGlass) {
    label = `Push ${releaseBranch} to origin`;
    if (config.skipTag) {
      emit(10, label, "SKIP (--skip-tag)");
    } else if (config.dryRun) {
      emit(10, label, `DRYRUN (would run \`git push -u origin ${releaseBranch}\`)`);
    } else {
      const [ok, reason] = pushReleaseBranch(projectRoot, version, seams);
      if (!ok) {
        emit(10, label, `FAIL (${reason})`);
        return EXIT_VIOLATION;
      }
      emit(10, label, `OK (${reason})`);
    }
    label = `Open release PR ${releaseBranch} -> ${config.baseBranch}`;
    if (config.skipTag) {
      emit(11, label, "SKIP (--skip-tag)");
    } else if (config.dryRun) {
      emit(
        11,
        label,
        `DRYRUN (would run \`gh pr create --base ${config.baseBranch} --head ${releaseBranch}\` with the generated body)`,
      );
    } else {
      const [ok, reason] = openReleasePr(
        projectRoot,
        version,
        config.repo,
        config.baseBranch,
        seams,
      );
      if (!ok) {
        emit(11, label, `FAIL (${reason})`);
        return EXIT_VIOLATION;
      }
      emit(11, label, `OK (${reason})`);
    }
    process.stderr.write(
      `Release v${version} is a release PR. Next: merge it through the merge queue ` +
        `(\`task pr:wait-mergeable-and-merge -- <N> --repo ${config.repo} --wait\`), ` +
        "then tag the merged commit with " +
        `\`${finishCommand(version)}\` (needs the release grant).\n`,
    );
    return EXIT_OK;
  }

  // Break-glass (#6296 item 10): Steps 10–11 tag and push the base branch.
  // Step 10–11 boundary: closed-verb gate before tag + atomic push (#3527).
  // npm publish fires on tag push; draft-flip `release:publish` stays (#1095).
  const tagPushGate = assertTagPushClosedVerb(config, seams);
  if (tagPushGate !== EXIT_OK) {
    return tagPushGate;
  }

  // Step 10: git tag.
  label = `Tag v${version}`;
  if (config.skipTag) {
    emit(10, label, "SKIP (--skip-tag)");
  } else if (config.dryRun) {
    emit(10, label, `DRYRUN (would run \`git tag -a v${version} -m 'Release v${version}'\`)`);
  } else {
    const [ok, reason] = createTag(projectRoot, version, seams);
    if (ok) {
      emit(10, label, `OK (${reason})`);
    } else {
      emit(10, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
  }

  // Step 11: push branch + tag atomically.
  label = `Push ${config.baseBranch} + v${version} to origin (atomic)`;
  if (config.skipTag) {
    emit(11, label, "SKIP (--skip-tag)");
  } else if (config.dryRun) {
    emit(
      11,
      label,
      `DRYRUN (would run \`git push --atomic origin ${config.baseBranch} v${version}\`)`,
    );
  } else {
    const [ok, reason] = pushRelease(projectRoot, version, config.baseBranch, seams);
    if (ok) {
      emit(11, label, `OK (${reason})`);
    } else {
      emit(11, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
  }

  // Steps 12 and 13: GitHub release, then the draft-state check (#724).
  const published = runGithubReleaseSteps(
    config,
    prepared.changelogBytes.toString("utf8"),
    seams,
    emit,
  );
  if (published !== EXIT_OK) {
    return published;
  }

  process.stderr.write(
    `Release v${version} pipeline complete (dry_run=${config.dryRun ? "True" : "False"}, skip_tag=${config.skipTag ? "True" : "False"}, skip_release=${config.skipRelease ? "True" : "False"}).\n`,
  );
  // #3753 — report-only. Never runs npm i -g. Never fails the cut.
  // Single-shot registry probe (no wait): Step 13 returns before npm-publish.yml
  // is green; Phase 7 of the release skill owns the bounded wait.
  emitCliDriftReportBestEffort(version, {
    skipRegistryPoll: shouldSkipRegistryPoll(config),
    pollTimeoutMs: 0,
    checkActiveCli: seams.checkActiveCli,
    viewPackage: seams.viewWorkspacePackage
      ? (name, ver) => {
          const probe = seams.viewWorkspacePackage?.(name, ver);
          return {
            name: name as WorkspacePackageName,
            visible: probe?.visible ?? false,
            version: probe?.version ?? null,
          };
        }
      : undefined,
  });
  return EXIT_OK;
}
