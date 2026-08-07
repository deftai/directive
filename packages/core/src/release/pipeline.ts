import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertProjectionContained } from "../fs/projection-containment.js";
import { readCoverageTotalsFromReport } from "../vitest-runner/coverage-debt.js";
import {
  buildCoverageDebtIssueDraft,
  classifyStep5FailureWithFreshness,
  evaluateAutoHatch,
  formatAutoHatchBanner,
  parseExitCodeFromReason,
  reasonLooksLikeTimeout,
} from "./auto-hatch.js";
import { prependUpgradeBanner, promoteChangelog, sectionForVersion } from "./changelog.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_OK,
  EXIT_VIOLATION,
  RELEASE_ARTIFACTS,
  RELEASE_CHECK_TIMEOUT_MINUTES,
  TOTAL_STEPS,
  VERIFY_DRAFT_INTERVAL_SECONDS,
  VERIFY_DRAFT_MAX_ATTEMPTS,
} from "./constants.js";
import { createCoverageDebtIssue, probeOpenCoverageDebtLedger } from "./coverage-debt-ledger.js";
import { checkTagAvailable, createGithubRelease, readTextFile, verifyReleaseDraft } from "./gh.js";
import {
  checkGitClean,
  commitReleaseArtifacts,
  createTag,
  currentBranch,
  pushRelease,
  releaseCommitSubject,
  runGit,
} from "./git.js";
import {
  checkVbriefLifecycleSyncNative,
  refreshRoadmapNative,
  runBuildNative,
} from "./native-steps.js";
import { todayIso } from "./paths.js";
import { runReleaseCheck } from "./preflight.js";
import { formatSkipCiIncidentWarning } from "./skip-ci-incident.js";
import { evaluateSuiteStamp, writeSuiteStamp } from "./suite-stamp.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";
import { isPrereleaseTag } from "./version.js";

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

export function emit(step: number, label: string, status: string, target = process.stderr): void {
  target.write(`[${step}/${TOTAL_STEPS}] ${label}... ${status}\n`);
}

export function runPipeline(config: ReleaseConfig, seams: ReleaseSeams = {}): number {
  const projectRoot = config.projectRoot;
  const version = config.version;
  const today = (seams.todayIso ?? todayIso)();
  const changelogPath = join(projectRoot, "CHANGELOG.md");
  const roadmapPath = join(projectRoot, "ROADMAP.md");
  const readFile = seams.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile = seams.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, "utf8"));
  const fileExists = seams.fileExists ?? ((p: string) => existsSync(p));

  const runCiFn =
    seams.runCi ??
    ((root: string, debtIssue: number | null) => runReleaseCheck(root, {}, debtIssue));
  const refreshRoadmapFn = seams.refreshRoadmap ?? ((root: string) => refreshRoadmapNative(root));
  const checkVbriefFn =
    seams.checkVbriefLifecycleSync ??
    ((root: string, repo: string) => checkVbriefLifecycleSyncNative(root, repo));
  const runBuildFn =
    seams.runBuild ?? ((root: string, v: string | null) => runBuildNative(root, v, seams));

  // Step 1: dirty-tree guard.
  let label = "Pre-flight git status";
  if (config.dryRun) {
    emit(1, label, `DRYRUN (would run \`git status --porcelain\` in ${projectRoot})`);
  } else {
    const [ok, output] = checkGitClean(projectRoot, seams);
    if (ok) {
      emit(1, label, "OK (tree clean)");
    } else if (config.allowDirty) {
      emit(1, label, `WARN (dirty, --allow-dirty set):\n${output}`);
    } else {
      emit(1, label, "FAIL (working tree is dirty; commit/stash or pass --allow-dirty)");
      process.stderr.write(`${output}\n`);
      return EXIT_VIOLATION;
    }
  }

  // Step 2: branch guard.
  label = `Pre-flight branch == ${config.baseBranch}`;
  if (config.dryRun) {
    emit(2, label, `DRYRUN (would assert current branch == ${config.baseBranch})`);
  } else {
    const branch = currentBranch(projectRoot, seams);
    if (branch === config.baseBranch) {
      emit(2, label, `OK (on ${branch})`);
    } else {
      emit(2, label, `FAIL (on '${branch}'; expected '${config.baseBranch}')`);
      return EXIT_VIOLATION;
    }
  }

  // Step 3: vBRIEF lifecycle sync (#734).
  label = "Pre-flight vBRIEF lifecycle sync";
  if (config.allowVbriefDrift) {
    emit(3, label, "SKIP (--allow-vbrief-drift)");
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
      process.stderr.write(`${reason}\n`);
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
  if (config.skipCi) {
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

    if (stampEval.kind === "hit") {
      const debtNote =
        stampEval.stamp.suite === "pass_with_debt" && stampEval.stamp.debtIssue != null
          ? ` PASS_WITH_DEBT(#${stampEval.stamp.debtIssue})`
          : "";
      emit(
        5,
        label,
        `OK (suite stamp hit at ${stampEval.stamp.headSha.slice(0, 12)}; suite skipped${debtNote})`,
      );
    } else {
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
        const exitCode = parseExitCodeFromReason(reason);
        const classification = classifyStep5FailureWithFreshness({
          output: reason,
          totals,
          exitCode,
          timedOut: reasonLooksLikeTimeout(reason) || exitCode === 124,
          coverageReportMtimeMs,
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
          process.stderr.write(formatAutoHatchBanner(decision.issue, decision.totals));
          recordSuiteStamp(projectRoot, "pass_with_debt", decision.issue, seams);
          emit(
            5,
            label,
            `OK (PASS_WITH_DEBT(#${decision.issue}); auto-hatch ${decision.created ? "filed" : "bound"}; suite not re-run)`,
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

  // Step 6: CHANGELOG promotion.
  label = "CHANGELOG promotion";
  if (!fileExists(changelogPath)) {
    emit(6, label, `FAIL (CHANGELOG.md not found at ${changelogPath})`);
    return EXIT_CONFIG_ERROR;
  }
  const originalChangelog = readFile(changelogPath);
  let promotedChangelog: string;
  try {
    promotedChangelog = promoteChangelog(
      originalChangelog,
      version,
      config.repo,
      today,
      config.summary,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(6, label, `FAIL (${msg})`);
    return EXIT_CONFIG_ERROR;
  }

  let summaryNote: string;
  if (config.summary) {
    const truncated = config.summary.slice(0, 60);
    const truncationSuffix = config.summary.length > 60 ? "..." : "";
    summaryNote = ` summary: "${truncated}${truncationSuffix}"`;
  } else {
    summaryNote = " no summary";
  }

  if (config.dryRun) {
    emit(
      6,
      label,
      `DRYRUN (would rewrite CHANGELOG.md: ## [Unreleased] -> ## [${version}] - ${today}; new compare link added;${summaryNote})`,
    );
  } else {
    assertProjectionContained(projectRoot, changelogPath);
    writeFile(changelogPath, promotedChangelog);
    emit(6, label, `OK (## [${version}] - ${today};${summaryNote})`);
  }

  // Step 7: ROADMAP refresh.
  label = "ROADMAP refresh (task roadmap:render)";
  if (config.dryRun) {
    emit(7, label, "DRYRUN (would run task roadmap:render)");
  } else {
    assertProjectionContained(projectRoot, roadmapPath);
    const [ok, reason] = refreshRoadmapFn(projectRoot);
    if (ok) {
      emit(7, label, `OK (${reason})`);
    } else {
      emit(7, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
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
      `DRYRUN (would run \`git add ${RELEASE_ARTIFACTS.join(" ")}\` + \`git commit -m '${releaseCommitSubject(version)}'\`)`,
    );
  } else {
    const [ok, reason] = commitReleaseArtifacts(projectRoot, version, seams);
    if (ok) {
      emit(9, label, `OK (${reason})`);
    } else {
      emit(9, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
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

  // Step 12: GitHub release.
  const prerelease = isPrereleaseTag(version);
  const draftSuffix = config.draft ? " (draft)" : " (PUBLIC)";
  const prereleaseSuffix = prerelease ? " (prerelease)" : "";
  label = `GitHub release v${version}${draftSuffix}${prereleaseSuffix}`;
  let createSucceeded = false;
  if (config.skipRelease) {
    emit(12, label, "SKIP (--skip-release)");
  } else if (config.dryRun) {
    const draftFlag = config.draft ? " --draft" : "";
    const prereleaseFlag = prerelease ? " --prerelease" : "";
    emit(
      12,
      label,
      `DRYRUN (would run \`gh release create v${version} --repo ${config.repo}${draftFlag}${prereleaseFlag} ...\`)`,
    );
  } else {
    let notes = sectionForVersion(promotedChangelog, version);
    notes = prependUpgradeBanner(notes, config.repo, projectRoot, readTextFile);
    const [ok, reason] = createGithubRelease(
      projectRoot,
      version,
      config.repo,
      notes,
      { draft: config.draft, prerelease },
      seams,
    );
    if (ok) {
      emit(12, label, `OK (${reason})`);
      createSucceeded = true;
    } else {
      emit(12, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
  }

  // Step 13: post-create verify-isDraft gate (#724).
  label = `Verify draft state of v${version} (#724 defense-in-depth)`;
  if (config.skipRelease) {
    emit(13, label, "SKIP (--skip-release)");
  } else if (!config.draft) {
    emit(13, label, "SKIP (--no-draft; intentional public release)");
  } else if (config.dryRun) {
    emit(
      13,
      label,
      `DRYRUN (would poll \`gh release view v${version} --json isDraft\` up to ${VERIFY_DRAFT_MAX_ATTEMPTS}x at ${VERIFY_DRAFT_INTERVAL_SECONDS}s intervals; auto-flip via \`gh release edit --draft=true\` on isDraft=false)`,
    );
  } else if (!createSucceeded) {
    emit(13, label, "SKIP (release was not created in this run)");
  } else {
    const [ok, reason] = verifyReleaseDraft(
      projectRoot,
      version,
      config.repo,
      {
        maxAttempts: VERIFY_DRAFT_MAX_ATTEMPTS,
        interval: VERIFY_DRAFT_INTERVAL_SECONDS,
        sleep: seams.sleep,
      },
      seams,
    );
    if (ok) {
      emit(13, label, `OK (${reason})`);
    } else {
      emit(13, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
  }

  process.stderr.write(
    `Release v${version} pipeline complete (dry_run=${config.dryRun ? "True" : "False"}, skip_tag=${config.skipTag ? "True" : "False"}, skip_release=${config.skipRelease ? "True" : "False"}).\n`,
  );
  return EXIT_OK;
}
