/**
 * Finish step: `task release -- --finish <version>` (#6296 Bound item 3).
 *
 * After the release PR merged through the merge queue, resolve its merge
 * commit M and refuse unless M is on the fetched base branch, has one parent,
 * changes only the release files, holds the version heading and the release
 * line alone, has no fragment left, and the named merge gate is green on M.
 * Then run the closed-verb gate (the release grant), tag M by its SHA, push only
 * the tag, and run Steps 12 and 13 with the notes read from CHANGELOG.md at M.
 * The grant authorizes the version; it is not evidence about the commit.
 */
import {
  CHANGELOG_FILE_REL,
  CHANGELOG_FRAGMENT_DIR,
  isChangelogFragmentPath,
} from "../changelog/entry-path.js";
import {
  hasReleaseVersionHeading,
  pathsOutsideRelease,
  releaseLine,
  unreleasedEntryLines,
} from "../changelog/release-line.js";
import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import { evaluateAlwaysOnNamedMergeGate } from "../pr-wait-mergeable/semantic-green.js";
import { plainGhEnv } from "../subprocess/plain-gh-env.js";
import { prependUpgradeBanner, sectionForVersion } from "./changelog.js";
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
  TOTAL_STEPS,
  VERIFY_DRAFT_INTERVAL_SECONDS,
  VERIFY_DRAFT_MAX_ATTEMPTS,
} from "./constants.js";
import {
  checkTagAvailable,
  createGithubRelease,
  readTextFile,
  resolveGh,
  verifyReleaseDraft,
} from "./gh.js";
import { runGit } from "./git.js";
import { releaseBranchName } from "./release-pr.js";
import { spawnText } from "./spawn.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";
import { isPrereleaseTag } from "./version.js";

/** One finish-run line (Steps 12 and 13 keep their release `[n/13]` numbers). */
function emitFinish(step: number, label: string, status: string): void {
  process.stderr.write(`[finish ${String(step)}] ${label}... ${status}\n`);
}

/** Emit in the release pipeline's `[n/13]` form (Steps 12 and 13). */
export type ReleaseStepEmit = (step: number, label: string, status: string) => void;

export const releaseStepEmit: ReleaseStepEmit = (step, label, status) => {
  process.stderr.write(`[${String(step)}/${String(TOTAL_STEPS)}] ${label}... ${status}\n`);
};

export interface MergedReleasePr {
  readonly number: number;
  readonly mergeCommit: string;
}

export type MergedReleasePrResult =
  | ({ readonly ok: true } & MergedReleasePr)
  | { readonly ok: false; readonly reason: string };

/** Find the merged PR whose head is `release/v<version>` (REST, read-only). */
export function findMergedReleasePr(
  projectRoot: string,
  repo: string,
  baseBranch: string,
  version: string,
  seams: ReleaseSeams = {},
): MergedReleasePrResult {
  if (seams.findMergedReleasePr !== undefined) {
    return seams.findMergedReleasePr(repo, baseBranch, version);
  }
  const ghPath = resolveGh(seams);
  if (ghPath === null) return { ok: false, reason: "gh CLI not found on PATH" };
  const owner = repo.split("/")[0] ?? "";
  const head = `${owner}:${releaseBranchName(version)}`;
  const spawn = seams.spawnText ?? spawnText;
  const result = spawn(
    ghPath,
    [
      "api",
      `repos/${repo}/pulls?state=closed&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(head)}&per_page=100`,
    ],
    { cwd: projectRoot, timeoutMs: 30_000, env: plainGhEnv() },
  );
  if (result.status !== 0) {
    return { ok: false, reason: `gh api pulls failed: ${result.stderr.trim()}` };
  }
  return pickMergedReleasePr(result.stdout, version);
}

/** Pick the latest merged PR from a REST pulls list (pure). */
export function pickMergedReleasePr(json: string, version: string): MergedReleasePrResult {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch (err) {
    return { ok: false, reason: `could not parse the pulls list: ${String(err)}` };
  }
  if (!Array.isArray(rows)) return { ok: false, reason: "pulls list is not an array" };
  const merged = rows
    .filter(
      (row): row is { number: number; merged_at: string; merge_commit_sha: string } =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as { merged_at?: unknown }).merged_at === "string" &&
        typeof (row as { merge_commit_sha?: unknown }).merge_commit_sha === "string" &&
        typeof (row as { number?: unknown }).number === "number",
    )
    .sort((a, b) => (a.merged_at < b.merged_at ? 1 : a.merged_at > b.merged_at ? -1 : 0));
  const latest = merged[0];
  if (latest === undefined) {
    return {
      ok: false,
      reason:
        `no merged release PR from ${releaseBranchName(version)}; merge the release PR ` +
        "through the merge queue first",
    };
  }
  return { ok: true, number: latest.number, mergeCommit: latest.merge_commit_sha };
}

export type MergeCommitCheck =
  | { readonly ok: true; readonly changelogText: string }
  | { readonly ok: false; readonly reason: string; readonly config: boolean };

function gitOut(
  projectRoot: string,
  args: readonly string[],
  seams: ReleaseSeams,
): { ok: true; out: string } | { ok: false; err: string } {
  const result = runGit(projectRoot, args, seams);
  if (result.status !== 0) {
    return { ok: false, err: `git ${args.join(" ")} failed: ${result.stderr.trim()}` };
  }
  return { ok: true, out: result.stdout };
}

/**
 * Bound item 3 checks on merge commit M (git only): on the fetched base, one
 * parent, release files only, heading and release line, the line alone, and
 * no fragment left.
 */
export function checkMergeCommit(
  projectRoot: string,
  version: string,
  baseBranch: string,
  mergeCommit: string,
  seams: ReleaseSeams = {},
): MergeCommitCheck {
  const fail = (reason: string, config = false): MergeCommitCheck => ({
    ok: false,
    reason,
    config,
  });
  const short = mergeCommit.slice(0, 12);
  const ancestor = runGit(
    projectRoot,
    ["merge-base", "--is-ancestor", mergeCommit, `origin/${baseBranch}`],
    seams,
  );
  if (ancestor.status !== 0) {
    return fail(`merge commit ${short} is not on the fetched origin/${baseBranch}`);
  }
  const parents = gitOut(projectRoot, ["rev-list", "--parents", "-n", "1", mergeCommit], seams);
  if (!parents.ok) return fail(parents.err, true);
  const parentCount = parents.out.trim().split(/\s+/).length - 1;
  if (parentCount !== 1) {
    return fail(`merge commit ${short} has ${String(parentCount)} parents; a release has one`);
  }
  const diff = gitOut(
    projectRoot,
    ["diff", "--name-status", "--no-renames", `${mergeCommit}^1`, mergeCommit],
    seams,
  );
  if (!diff.ok) return fail(diff.err, true);
  const rows = diff.out
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((cols) => (cols[0] ?? "").trim().length > 0 && cols[1] !== undefined)
    .map((cols) => ({ status: (cols[0] ?? "").trim(), path: (cols[1] ?? "").trim() }));
  const shown = gitOut(projectRoot, ["show", `${mergeCommit}:${CHANGELOG_FILE_REL}`], seams);
  if (!shown.ok) return fail(shown.err, true);
  const changelogText = shown.out;
  const tree = gitOut(
    projectRoot,
    ["ls-tree", "--name-only", mergeCommit, `${CHANGELOG_FRAGMENT_DIR}/`],
    seams,
  );
  if (!tree.ok) return fail(tree.err, true);
  const fragments = tree.out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isChangelogFragmentPath(line));
  const outside = pathsOutsideRelease(rows);
  if (outside.length > 0) {
    return fail(
      `merge commit ${short} changes paths outside the release files: ${outside.join(", ")}`,
    );
  }
  if (!hasReleaseVersionHeading(changelogText, version)) {
    return fail(`CHANGELOG.md at ${short} has no ## [${version}] heading`);
  }
  const entries = unreleasedEntryLines(changelogText);
  const line = releaseLine(version);
  if (!entries.includes(line)) {
    return fail(`CHANGELOG.md at ${short} has no release line ${JSON.stringify(line)}`);
  }
  const others = entries.filter((entry) => entry !== line);
  if (others.length > 0 || fragments.length > 0) {
    const named = [...others.map((entry) => JSON.stringify(entry)), ...fragments];
    return fail(
      `a change landed ahead of the release at ${short}; still unreleased: ${named.join(", ")}. ` +
        "This release cannot be tagged; undo it with the break-glass path until #6485 ships " +
        "(docs/RELEASING.md § Recovery)",
    );
  }
  return { ok: true, changelogText };
}

/**
 * Steps 12 and 13 (GitHub release, then the draft-state check), shared by the
 * finish step and the break-glass run. Returns EXIT_OK or EXIT_VIOLATION.
 */
export function runGithubReleaseSteps(
  config: ReleaseConfig,
  changelogText: string,
  seams: ReleaseSeams,
  emit: ReleaseStepEmit = releaseStepEmit,
): number {
  const version = config.version;
  const prerelease = isPrereleaseTag(version);
  const draftSuffix = config.draft ? " (draft)" : " (PUBLIC)";
  const prereleaseSuffix = prerelease ? " (prerelease)" : "";
  let label = `GitHub release v${version}${draftSuffix}${prereleaseSuffix}`;
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
    let notes = sectionForVersion(changelogText, version);
    notes = prependUpgradeBanner(notes, config.repo, config.projectRoot, readTextFile);
    const [ok, reason] = createGithubRelease(
      config.projectRoot,
      version,
      config.repo,
      notes,
      { draft: config.draft, prerelease },
      seams,
    );
    if (!ok) {
      emit(12, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
    emit(12, label, `OK (${reason})`);
    createSucceeded = true;
  }

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
      config.projectRoot,
      version,
      config.repo,
      {
        maxAttempts: VERIFY_DRAFT_MAX_ATTEMPTS,
        interval: VERIFY_DRAFT_INTERVAL_SECONDS,
        sleep: seams.sleep,
      },
      seams,
    );
    if (!ok) {
      emit(13, label, `FAIL (${reason})`);
      return EXIT_VIOLATION;
    }
    emit(13, label, `OK (${reason})`);
  }
  return EXIT_OK;
}

/** Report-only local-vs-released CLI drift after a release (#3753). */
export function emitReleaseDriftReport(config: ReleaseConfig, seams: ReleaseSeams): void {
  emitCliDriftReportBestEffort(config.version, {
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
}

/** `task release -- --finish <version>`. */
export function runFinish(config: ReleaseConfig, seams: ReleaseSeams = {}): number {
  const { version, repo, baseBranch, projectRoot } = config;
  const tag = `v${version}`;

  if (config.dryRun) {
    emitFinish(1, `Fetch origin/${baseBranch}`, "DRYRUN");
    emitFinish(2, `Resolve merged release PR from ${releaseBranchName(version)}`, "DRYRUN");
    emitFinish(3, "Check merge commit (base, one parent, release files, release line)", "DRYRUN");
    emitFinish(4, `Tag ${tag} availability`, "DRYRUN");
    emitFinish(5, "Named merge gate on the merge commit", "DRYRUN");
    emitFinish(6, `Tag ${tag} on the merge commit`, "DRYRUN (after the closed-verb gate)");
    emitFinish(7, `Push only ${tag}`, `DRYRUN (would run \`git push origin refs/tags/${tag}\`)`);
    return runGithubReleaseSteps(config, "", seams);
  }

  let label = `Fetch origin/${baseBranch}`;
  const fetch = runGit(projectRoot, ["fetch", "origin", baseBranch], seams);
  if (fetch.status !== 0) {
    emitFinish(1, label, `FAIL (git fetch failed: ${fetch.stderr.trim()})`);
    return EXIT_CONFIG_ERROR;
  }
  emitFinish(1, label, "OK");

  label = `Resolve merged release PR from ${releaseBranchName(version)}`;
  const pr = findMergedReleasePr(projectRoot, repo, baseBranch, version, seams);
  if (!pr.ok) {
    emitFinish(2, label, `FAIL (${pr.reason})`);
    return EXIT_VIOLATION;
  }
  const merge = pr.mergeCommit;
  emitFinish(2, label, `OK (PR #${String(pr.number)}, merge commit ${merge.slice(0, 12)})`);

  label = "Check merge commit (base, one parent, release files, release line)";
  const checked = checkMergeCommit(projectRoot, version, baseBranch, merge, seams);
  if (!checked.ok) {
    emitFinish(3, label, `FAIL (${checked.reason})`);
    return checked.config ? EXIT_CONFIG_ERROR : EXIT_VIOLATION;
  }
  emitFinish(3, label, "OK");

  label = `Tag ${tag} availability`;
  const checkTag =
    seams.checkTagAvailable ??
    ((v: string, r: string, root: string) => checkTagAvailable(v, r, root, seams));
  const [tagOk, tagReason] = checkTag(version, repo, projectRoot);
  if (!tagOk) {
    emitFinish(4, label, `FAIL (${tagReason})`);
    return EXIT_VIOLATION;
  }
  emitFinish(4, label, `OK (${tagReason})`);

  label = "Named merge gate on the merge commit";
  const namedFn = seams.namedMergeGateFn ?? evaluateAlwaysOnNamedMergeGate;
  const named = namedFn(null, repo, {
    runGh: seams.runGh ?? defaultRunGh,
    tipSha: merge,
    projectRoot,
  });
  if (!named.ok) {
    emitFinish(5, label, `FAIL (${named.error ?? "merge gate is not green"})`);
    return EXIT_VIOLATION;
  }
  emitFinish(5, label, `OK (green on ${merge.slice(0, 12)})`);

  // The release grant authorizes the version (#3527); it is checked last,
  // after the evidence about the commit.
  const gate = assertTagPushClosedVerb({ ...config, skipTag: false }, seams);
  if (gate !== EXIT_OK) return gate;

  label = `Tag ${tag} on the merge commit`;
  const tagged = runGit(projectRoot, ["tag", "-a", tag, "-m", `Release ${tag}`, merge], seams);
  if (tagged.status !== 0) {
    emitFinish(6, label, `FAIL (git tag failed: ${tagged.stderr.trim()})`);
    return EXIT_VIOLATION;
  }
  emitFinish(6, label, `OK (${tag} -> ${merge.slice(0, 12)})`);

  label = `Push only ${tag}`;
  const pushed = runGit(projectRoot, ["push", "origin", `refs/tags/${tag}`], seams);
  if (pushed.status !== 0) {
    emitFinish(7, label, `FAIL (git push failed: ${pushed.stderr.trim()})`);
    return EXIT_VIOLATION;
  }
  emitFinish(7, label, `OK (pushed refs/tags/${tag})`);

  const published = runGithubReleaseSteps(config, checked.changelogText, seams);
  if (published !== EXIT_OK) return published;
  process.stderr.write(`Release ${tag} finished from merge commit ${merge.slice(0, 12)}.\n`);
  emitReleaseDriftReport(config, seams);
  return EXIT_OK;
}
