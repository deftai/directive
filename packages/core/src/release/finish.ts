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
 * Under `deft release:run` (#6875, `config.runBinding`) the parent of M must be
 * the cut base, and only the run's grant for `<version>@<tree of M>` counts.
 * The run also reconciles the tag (#6877): a tag left only local on M is
 * pushed, a remote tag on M is done, and a tag on any other commit stops.
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
import { prependBannerText, prependUpgradeBanner, sectionForVersion } from "./changelog.js";
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
  UPGRADE_BANNER_RELPATH,
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
import { releaseSubprocessEnv, runGit } from "./git.js";
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
      "--paginate",
      "--jq",
      ".[]",
      `repos/${repo}/pulls?state=closed&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(head)}&per_page=100`,
    ],
    { cwd: projectRoot, timeoutMs: 30_000, env: plainGhEnv() },
  );
  if (result.status !== 0) {
    return { ok: false, reason: `gh api pulls failed: ${result.stderr.trim()}` };
  }
  return pickMergedReleasePr(result.stdout, version);
}

/**
 * Pick the latest merged PR from a REST pulls list (pure). Accepts a JSON
 * array or one JSON object per line (`gh api --paginate --jq '.[]'`, every page).
 */
export function pickMergedReleasePr(json: string, version: string): MergedReleasePrResult {
  let rows: unknown;
  try {
    const text = json.trim();
    rows = text.startsWith("[")
      ? JSON.parse(text)
      : text
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as unknown);
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
 * #6875 item 7 -- refuse unless the sole parent of merge commit M is the cut
 * base B. Run before the tag is created and before a local-only tag is pushed:
 * PRs that landed ahead can leave M with the approved tree and no leftover
 * entry, and only the parent shows it.
 */
export function checkReleaseParent(
  projectRoot: string,
  mergeCommit: string,
  expectedBase: string,
  seams: ReleaseSeams = {},
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly config: boolean } {
  const parents = gitOut(projectRoot, ["rev-list", "--parents", "-n", "1", mergeCommit], seams);
  if (!parents.ok) return { ok: false, reason: parents.err, config: true };
  const [, ...rest] = parents.out.trim().split(/\s+/);
  const short = mergeCommit.slice(0, 12);
  const base = expectedBase.trim().toLowerCase();
  if (rest.length !== 1 || (rest[0] ?? "").toLowerCase() !== base) {
    const found = rest.length === 0 ? "none" : rest.map((p) => p.slice(0, 12)).join(", ");
    return {
      ok: false,
      reason:
        `the parent of merge commit ${short} is ${found}, not the cut base ${base.slice(0, 12)}; ` +
        "a change landed ahead of the release. This release cannot be tagged; undo it with the " +
        "break-glass path until #6485 ships (docs/RELEASING.md § Recovery)",
      config: false,
    };
  }
  return { ok: true };
}

/**
 * #6877 -- the `v<version>` tag under `deft release:run`, read on every finish
 * (first run and `--resume`): absent; only local and peeling to M (a crash
 * after the tag and before its push); on origin and peeling to M (pushed); or
 * anything else, which stops the run so nothing is overwritten.
 */
export type RunTagState =
  | { readonly kind: "absent" }
  | { readonly kind: "local-only" }
  | { readonly kind: "pushed" }
  | { readonly kind: "stop"; readonly reason: string; readonly config: boolean };

export function readRunTagState(
  projectRoot: string,
  tag: string,
  mergeCommit: string,
  seams: ReleaseSeams = {},
): RunTagState {
  const m = mergeCommit.trim().toLowerCase();
  const short = m.slice(0, 12);
  const listed = gitOut(projectRoot, ["tag", "-l", tag], seams);
  if (!listed.ok) return { kind: "stop", reason: listed.err, config: true };
  let local: string | null = null;
  if (listed.out.trim() === tag) {
    const peeled = gitOut(projectRoot, ["rev-parse", `refs/tags/${tag}^{commit}`], seams);
    if (!peeled.ok) return { kind: "stop", reason: peeled.err, config: true };
    local = peeled.out.trim().toLowerCase();
  }
  const remote = gitOut(
    projectRoot,
    ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    seams,
  );
  if (!remote.ok) {
    return { kind: "stop", reason: remote.err, config: true };
  }
  let plain: string | null = null;
  let deref: string | null = null;
  for (const row of remote.out.split(/\r?\n/)) {
    const [sha, ref] = row.trim().split(/\s+/);
    if (sha === undefined || sha.length === 0) continue;
    if (ref === `refs/tags/${tag}^{}`) deref = sha.toLowerCase();
    else if (ref === `refs/tags/${tag}`) plain = sha.toLowerCase();
  }
  // An annotated tag lists its peeled commit as `^{}`; a lightweight tag does not.
  const onOrigin = deref ?? plain;
  if (local !== null && local !== m) {
    return {
      kind: "stop",
      reason: `local tag ${tag} points to ${local.slice(0, 12)}, not merge commit ${short}; nothing overwritten`,
      config: false,
    };
  }
  if (onOrigin !== null) {
    if (onOrigin !== m) {
      return {
        kind: "stop",
        reason: `remote tag ${tag} on origin points to ${onOrigin.slice(0, 12)}, not merge commit ${short}; nothing overwritten`,
        config: false,
      };
    }
    return { kind: "pushed" };
  }
  return local === null ? { kind: "absent" } : { kind: "local-only" };
}

/** #6875 -- tree of merge commit M, read with git (never from a run record). */
export function readMergeTree(
  projectRoot: string,
  mergeCommit: string,
  seams: ReleaseSeams = {},
): { readonly ok: true; readonly tree: string } | { readonly ok: false; readonly reason: string } {
  const tree = gitOut(projectRoot, ["rev-parse", `${mergeCommit}^{tree}`], seams);
  if (!tree.ok) return { ok: false, reason: tree.err };
  const value = tree.out.trim();
  if (value.length === 0) {
    return { ok: false, reason: `git rev-parse returned no tree for ${mergeCommit.slice(0, 12)}` };
  }
  return { ok: true, tree: value };
}

/**
 * #6875 -- upgrade banner text at `commit`; null when git cannot show it there
 * (normally because the file is absent), which leaves the notes unchanged, as
 * an unreadable local banner did before.
 */
function readBannerAtCommit(
  projectRoot: string,
  commit: string,
  seams: ReleaseSeams,
): string | null {
  const shown = runGit(projectRoot, ["show", `${commit}:${UPGRADE_BANNER_RELPATH}`], seams);
  return shown.status === 0 ? shown.stdout : null;
}

/**
 * Steps 12 and 13 (GitHub release, then the draft-state check), shared by the
 * finish step and the break-glass run. Returns EXIT_OK or EXIT_VIOLATION.
 * With `notesCommit` (the finish step passes M) the upgrade banner is read from
 * that commit with `git show`, not from the local checkout (#6875).
 */
export function runGithubReleaseSteps(
  config: ReleaseConfig,
  changelogText: string,
  seams: ReleaseSeams,
  emit: ReleaseStepEmit = releaseStepEmit,
  notesCommit: string | null = null,
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
    notes =
      notesCommit === null
        ? prependUpgradeBanner(notes, config.repo, config.projectRoot, readTextFile)
        : prependBannerText(
            notes,
            config.repo,
            readBannerAtCommit(config.projectRoot, notesCommit, seams),
          );
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

  // #6875: under `deft release:run`, M must sit directly on the cut base B and
  // the tag gate evaluates the run's grant against the tree read from M.
  const binding = config.runBinding ?? null;
  let mergeTree: string | null = null;
  if (binding !== null) {
    label = "Check the parent of the merge commit is the cut base";
    const parent = checkReleaseParent(projectRoot, merge, binding.expectedBase, seams);
    if (!parent.ok) {
      emitFinish(3, label, `FAIL (${parent.reason})`);
      return parent.config ? EXIT_CONFIG_ERROR : EXIT_VIOLATION;
    }
    emitFinish(3, label, `OK (${binding.expectedBase.slice(0, 12)})`);
    const tree = readMergeTree(projectRoot, merge, seams);
    if (!tree.ok) {
      emitFinish(3, "Read the tree of the merge commit", `FAIL (${tree.reason})`);
      return EXIT_CONFIG_ERROR;
    }
    mergeTree = tree.tree;
  }

  label = `Tag ${tag} availability`;
  // #6877: under the run the tag is reconciled on every finish (first run and
  // --resume), after the parent-of-M check above: a tag left only local on M is
  // pushed, a remote tag on M is done, and a tag on any other commit stops.
  let tagState: "absent" | "local-only" | "pushed" = "absent";
  if (binding !== null) {
    const state = readRunTagState(projectRoot, tag, merge, seams);
    if (state.kind === "stop") {
      emitFinish(4, label, `FAIL (${state.reason})`);
      return state.config ? EXIT_CONFIG_ERROR : EXIT_VIOLATION;
    }
    tagState = state.kind;
  }
  if (tagState === "absent") {
    const checkTag =
      seams.checkTagAvailable ??
      ((v: string, r: string, root: string) => checkTagAvailable(v, r, root, seams));
    const [tagOk, tagReason] = checkTag(version, repo, projectRoot);
    if (!tagOk) {
      emitFinish(4, label, `FAIL (${tagReason})`);
      return EXIT_VIOLATION;
    }
    emitFinish(4, label, `OK (${tagReason})`);
  } else if (tagState === "local-only") {
    emitFinish(4, label, `OK (${tag} on ${merge.slice(0, 12)} left only local; pushing it)`);
  } else {
    emitFinish(4, label, `OK (${tag} on ${merge.slice(0, 12)} is already on origin)`);
  }

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

  if (tagState === "pushed") {
    // The tag is published: the tag gate and the push are done.
    emitFinish(6, `Tag ${tag} on the merge commit`, "SKIP (already on origin)");
    emitFinish(7, `Push only ${tag}`, "SKIP (already on origin)");
  } else {
    // The release grant authorizes the version (#3527); it is checked last,
    // after the evidence about the commit.
    const gate = assertTagPushClosedVerb({ ...config, skipTag: false }, seams, mergeTree);
    if (gate !== EXIT_OK) return gate;

    label = `Tag ${tag} on the merge commit`;
    if (tagState === "local-only") {
      emitFinish(6, label, `SKIP (${tag} -> ${merge.slice(0, 12)} exists locally)`);
    } else {
      const tagged = runGit(projectRoot, ["tag", "-a", tag, "-m", `Release ${tag}`, merge], seams);
      if (tagged.status !== 0) {
        emitFinish(6, label, `FAIL (git tag failed: ${tagged.stderr.trim()})`);
        return EXIT_VIOLATION;
      }
      emitFinish(6, label, `OK (${tag} -> ${merge.slice(0, 12)})`);
    }

    label = `Push only ${tag}`;
    // A tag-only push must not depend on the checked-out branch: the pre-push
    // branch gate would refuse it on the base branch (same bypass as the cut).
    const pushed = runGit(
      projectRoot,
      ["push", "origin", `refs/tags/${tag}`],
      seams,
      releaseSubprocessEnv(),
    );
    if (pushed.status !== 0) {
      // Drop the unpushed local tag so a retry passes the availability check.
      runGit(projectRoot, ["tag", "-d", tag], seams);
      emitFinish(7, label, `FAIL (git push failed: ${pushed.stderr.trim()}; local tag removed)`);
      return EXIT_VIOLATION;
    }
    emitFinish(7, label, `OK (pushed refs/tags/${tag})`);
  }

  const published = runGithubReleaseSteps(
    config,
    checked.changelogText,
    seams,
    releaseStepEmit,
    merge,
  );
  if (published !== EXIT_OK) return published;
  process.stderr.write(`Release ${tag} finished from merge commit ${merge.slice(0, 12)}.\n`);
  emitReleaseDriftReport(config, seams);
  return EXIT_OK;
}
