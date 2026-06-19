import { existsSync, statSync } from "node:fs";
import {
  BRANCH_GATE_BYPASS_ENV,
  DESTRUCTIVE_GH_GATE_BYPASS_ENV,
  RELEASE_ARTIFACTS,
} from "./constants.js";
import { spawnText } from "./spawn.js";
import type { ReleaseSeams } from "./types.js";

export function releaseSubprocessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    [BRANCH_GATE_BYPASS_ENV]: "1",
    [DESTRUCTIVE_GH_GATE_BYPASS_ENV]: "1",
  };
}

export function runGit(
  projectRoot: string,
  args: readonly string[],
  seams: ReleaseSeams = {},
  env?: NodeJS.ProcessEnv,
): ReturnType<typeof spawnText> {
  const spawn = seams.spawnText ?? spawnText;
  return spawn("git", ["-C", projectRoot, ...args], {
    env,
    timeoutMs: 30_000,
  });
}

export function checkGitClean(projectRoot: string, seams: ReleaseSeams = {}): [boolean, string] {
  const result = runGit(projectRoot, ["status", "--porcelain"], seams);
  if (result.status !== 0) {
    return [false, `git status failed: ${result.stderr.trim()}`];
  }
  const output = result.stdout.trim();
  if (output) {
    return [false, output];
  }
  return [true, ""];
}

export function currentBranch(projectRoot: string, seams: ReleaseSeams = {}): string {
  const result = runGit(projectRoot, ["branch", "--show-current"], seams);
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

export function releaseCommitSubject(version: string): string {
  return `chore(release): v${version} -- promote CHANGELOG + ROADMAP`;
}

export function commitReleaseArtifacts(
  projectRoot: string,
  version: string,
  seams: ReleaseSeams = {},
): [boolean, string] {
  const exists =
    seams.fileExists ??
    ((p: string) => {
      try {
        return existsSync(p) && statSync(p).isFile();
      } catch {
        return false;
      }
    });

  const pathsToStage = RELEASE_ARTIFACTS.filter((rel) => exists(`${projectRoot}/${rel}`));
  if (pathsToStage.length === 0) {
    return [true, "no release artifacts to commit (none exist)"];
  }

  const add = runGit(projectRoot, ["add", "--", ...pathsToStage], seams);
  if (add.status !== 0) {
    return [false, `git add failed: ${add.stderr.trim()}`];
  }

  const diff = runGit(projectRoot, ["diff", "--cached", "--quiet"], seams);
  if (diff.status === 0) {
    return [true, "release artifacts already up-to-date; no commit needed"];
  }

  const subject = releaseCommitSubject(version);
  const commit = runGit(projectRoot, ["commit", "-m", subject], seams, releaseSubprocessEnv());
  if (commit.status !== 0) {
    return [false, `git commit failed: ${commit.stderr.trim()}`];
  }
  return [true, `committed release artifacts (${subject})`];
}

export function createTag(
  projectRoot: string,
  version: string,
  seams: ReleaseSeams = {},
): [boolean, string] {
  const tag = `v${version}`;
  const result = runGit(
    projectRoot,
    ["tag", "-a", tag, "-m", `Release ${tag}`],
    seams,
    releaseSubprocessEnv(),
  );
  if (result.status !== 0) {
    return [false, `git tag failed: ${result.stderr.trim()}`];
  }
  return [true, `created tag ${tag}`];
}

export function pushRelease(
  projectRoot: string,
  version: string,
  baseBranch: string,
  seams: ReleaseSeams = {},
): [boolean, string] {
  const tag = `v${version}`;
  const result = runGit(
    projectRoot,
    ["push", "--atomic", "origin", baseBranch, tag],
    seams,
    releaseSubprocessEnv(),
  );
  if (result.status !== 0) {
    return [false, `git push failed: ${result.stderr.trim()}`];
  }
  return [true, `pushed ${baseBranch} + ${tag} to origin`];
}
