import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prependUpgradeBanner, promoteChangelog, sectionForVersion } from "./changelog.js";
import {
  EXIT_CONFIG_ERROR,
  EXIT_OK,
  EXIT_VIOLATION,
  RELEASE_ARTIFACTS,
  TOTAL_STEPS,
  VERIFY_DRAFT_INTERVAL_SECONDS,
  VERIFY_DRAFT_MAX_ATTEMPTS,
} from "./constants.js";
import { checkTagAvailable, createGithubRelease, readTextFile, verifyReleaseDraft } from "./gh.js";
import {
  checkGitClean,
  commitReleaseArtifacts,
  createTag,
  currentBranch,
  pushRelease,
  releaseCommitSubject,
} from "./git.js";
import { resolveScriptsDir, todayIso } from "./paths.js";
import { pyprojectPathFor, syncPyprojectForRelease } from "./pyproject-sync.js";
import {
  checkVbriefLifecycleSync,
  refreshRoadmap,
  runBuild,
  runCi,
  runUvLock,
} from "./python-bridge.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";
import { isPrereleaseTag } from "./version.js";

export function emit(step: number, label: string, status: string, target = process.stderr): void {
  target.write(`[${step}/${TOTAL_STEPS}] ${label}... ${status}\n`);
}

export function runPipeline(config: ReleaseConfig, seams: ReleaseSeams = {}): number {
  const projectRoot = config.projectRoot;
  const version = config.version;
  const today = (seams.todayIso ?? todayIso)();
  const changelogPath = join(projectRoot, "CHANGELOG.md");
  const scriptsDir = resolveScriptsDir();
  const readFile = seams.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile = seams.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, "utf8"));
  const fileExists = seams.fileExists ?? ((p: string) => existsSync(p));

  const runCiFn = seams.runCi ?? ((root: string) => runCi(root, scriptsDir, seams));
  const refreshRoadmapFn =
    seams.refreshRoadmap ?? ((root: string) => refreshRoadmap(root, scriptsDir, seams));
  const checkVbriefFn =
    seams.checkVbriefLifecycleSync ??
    ((root: string, repo: string) => checkVbriefLifecycleSync(root, repo, scriptsDir, seams));
  const runBuildFn =
    seams.runBuild ?? ((root: string, v: string | null) => runBuild(root, scriptsDir, v, seams));
  const runUvLockFn = seams.runUvLock ?? ((root: string) => runUvLock(root, seams));

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

  // Step 5: CI.
  label = "Pre-flight CI (task ci:local | fallback task check)";
  if (config.skipCi) {
    emit(5, label, "SKIP (--skip-ci)");
  } else if (config.dryRun) {
    emit(5, label, "DRYRUN (would run task ci:local with task check fallback)");
  } else {
    const [ok, reason] = runCiFn(projectRoot);
    if (ok) {
      emit(5, label, `OK (${reason})`);
    } else {
      emit(5, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
  }

  // Step 6: CHANGELOG promotion + pyproject sync.
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

  const pyprojectPath = pyprojectPathFor(projectRoot);
  const [pyprojectNote, promotedPyproject] = syncPyprojectForRelease(
    pyprojectPath,
    version,
    { dryRun: config.dryRun },
    seams,
  );
  if (pyprojectNote.startsWith("FAIL")) {
    emit(6, label, pyprojectNote);
    return EXIT_CONFIG_ERROR;
  }

  if (config.dryRun) {
    emit(
      6,
      label,
      `DRYRUN (would rewrite CHANGELOG.md: ## [Unreleased] -> ## [${version}] - ${today}; new compare link added;${summaryNote}; ${pyprojectNote}; would run \`uv lock\` to refresh uv.lock to ${version})`,
    );
  } else {
    writeFile(changelogPath, promotedChangelog);
    let uvLockNote = "uv.lock unchanged (pyproject not modified)";
    if (promotedPyproject !== null) {
      writeFile(pyprojectPath, promotedPyproject);
      const [uvOk, uvNote] = runUvLockFn(projectRoot);
      uvLockNote = uvNote;
      if (!uvOk) {
        emit(6, label, `FAIL (${uvLockNote})`);
        return EXIT_VIOLATION;
      }
    }
    emit(
      6,
      label,
      `OK (## [${version}] - ${today};${summaryNote}; ${pyprojectNote}; ${uvLockNote})`,
    );
  }

  // Step 7: ROADMAP refresh.
  label = "ROADMAP refresh (task roadmap:render)";
  if (config.dryRun) {
    emit(7, label, "DRYRUN (would run task roadmap:render)");
  } else {
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
