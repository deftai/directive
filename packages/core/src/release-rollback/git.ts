import { runGit } from "../release/git.js";
import { RELEASE_COMMIT_SUBJECT_PREFIX } from "./constants.js";
import type { RollbackSeams } from "./types.js";

export function gitTagExistsLocal(
  projectRoot: string,
  version: string,
  seams: RollbackSeams = {},
): boolean {
  const tag = `v${version}`;
  const result = runGit(projectRoot, ["tag", "-l", tag], seams);
  return Boolean(result.stdout.trim());
}

export function gitTagExistsOrigin(
  projectRoot: string,
  version: string,
  seams: RollbackSeams = {},
): boolean {
  const tag = `v${version}`;
  const result = runGit(projectRoot, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], seams);
  return Boolean(result.stdout.trim());
}

export function gitDeleteLocalTag(
  projectRoot: string,
  version: string,
  seams: RollbackSeams = {},
): [boolean, string] {
  const tag = `v${version}`;
  const result = runGit(projectRoot, ["tag", "-d", tag], seams);
  if (result.status !== 0) {
    return [false, `git tag -d failed: ${result.stderr.trim()}`];
  }
  return [true, `deleted local tag ${tag}`];
}

export function gitDeleteRemoteTag(
  projectRoot: string,
  version: string,
  seams: RollbackSeams = {},
): [boolean, string] {
  const tag = `v${version}`;
  const result = runGit(projectRoot, ["push", "--delete", "origin", tag], seams);
  if (result.status !== 0) {
    return [false, `git push --delete failed: ${result.stderr.trim()}`];
  }
  return [true, `deleted remote tag ${tag}`];
}

export function resolveReleasePrepSha(
  projectRoot: string,
  version: string,
  seams: RollbackSeams = {},
): [string, string] {
  const tag = `v${version}`;
  const revParse = runGit(projectRoot, ["rev-parse", `${tag}^{commit}`], seams);
  if (revParse.status === 0) {
    const sha = (revParse.stdout || "").trim();
    if (sha) {
      return [sha, ""];
    }
  }

  const grepPattern = `^${RELEASE_COMMIT_SUBJECT_PREFIX}${version}`;
  const grep = runGit(projectRoot, ["log", "--grep", grepPattern, "--format=%H", "-n", "1"], seams);
  if (grep.status === 0) {
    const lines = (grep.stdout || "").trim().split(/\r?\n/);
    if (lines.length > 0) {
      const sha = lines[0];
      if (sha) {
        return [sha, ""];
      }
    }
  }

  return [
    "",
    `could not resolve release-prep SHA for v${version} ` +
      `(tried \`git rev-parse ${tag}^{commit}\` and ` +
      `\`git log --grep='${grepPattern}'\`)`,
  ];
}

export function gitRevertReleaseCommit(
  projectRoot: string,
  releasePrepSha: string,
  seams: RollbackSeams = {},
): [boolean, string] {
  const result = runGit(projectRoot, ["revert", releasePrepSha, "--no-edit"], seams);
  if (result.status === 0) {
    return [
      true,
      `reverted release-prep commit ${releasePrepSha.slice(0, 12)} ` +
        "(forward revert; no force-push required)",
    ];
  }

  const abort = runGit(projectRoot, ["revert", "--abort"], seams);
  let abortNote = "";
  if (abort.status !== 0) {
    abortNote = ` (additionally, \`git revert --abort\` failed: ${abort.stderr.trim()})`;
  }
  const stderr = (result.stderr || "").trim();
  return [
    false,
    `git revert ${releasePrepSha.slice(0, 12)} conflicted: ${stderr}${abortNote}. ` +
      `Manual recovery: re-run \`git revert ${releasePrepSha} --no-edit\`, ` +
      "resolve conflicts (typically CHANGELOG.md / ROADMAP.md), " +
      "`git revert --continue`, then `git push origin <base-branch>`. " +
      "See the Manual recovery section in scripts/release_rollback.py.",
  ];
}

export function gitPushBase(
  projectRoot: string,
  baseBranch: string,
  seams: RollbackSeams = {},
): [boolean, string] {
  const result = runGit(projectRoot, ["push", "origin", baseBranch], seams);
  if (result.status !== 0) {
    return [false, `git push failed: ${result.stderr.trim()}`];
  }
  return [true, `pushed ${baseBranch} to origin (no force)`];
}
