import { runGit as releaseRunGit } from "../release/git.js";
import { spawnText } from "../release/spawn.js";
import type { E2ESeams } from "./types.js";

function defaultRunGit(
  projectRoot: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  seams: E2ESeams = {},
): ReturnType<typeof spawnText> {
  if (seams.runGit) {
    return seams.runGit(projectRoot, args, env);
  }
  return releaseRunGit(projectRoot, args, { spawnText: seams.spawnText ?? spawnText }, env);
}

export function cloneRepoToTemp(
  projectRoot: string,
  targetDir: string,
  seams: E2ESeams = {},
): [boolean, string] {
  const env = { ...process.env, DEFT_PROJECT_ROOT: targetDir };
  const spawn = seams.spawnText ?? spawnText;
  const result = spawn("git", ["clone", projectRoot, targetDir], {
    env,
    timeoutMs: 300_000,
  });
  if (result.status !== 0) {
    return [false, `git clone failed: ${result.stderr.trim()}`];
  }
  return [true, `cloned ${projectRoot} -> ${targetDir}`];
}

export function setOriginToTempRepo(
  cloneDir: string,
  owner: string,
  slug: string,
  seams: E2ESeams = {},
): [boolean, string] {
  const url = `https://github.com/${owner}/${slug}.git`;
  const result = defaultRunGit(cloneDir, ["remote", "set-url", "origin", url], undefined, seams);
  if (result.status !== 0) {
    return [false, `git remote set-url failed: ${result.stderr.trim()}`];
  }
  return [true, `origin -> ${url}`];
}

export function pushMirror(cloneDir: string, seams: E2ESeams = {}): [boolean, string] {
  const result = defaultRunGit(
    cloneDir,
    ["push", "origin", "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
    undefined,
    seams,
  );
  if (result.status !== 0) {
    return [false, `git push (heads+tags refspecs) failed: ${result.stderr.trim()}`];
  }
  return [true, "pushed heads + tags to temp origin"];
}

export function verifyTag(
  cloneDir: string,
  version: string,
  seams: E2ESeams = {},
): [boolean, string] {
  const tag = `v${version}`;
  const result = defaultRunGit(
    cloneDir,
    ["ls-remote", "--tags", "origin", `refs/tags/${tag}`],
    undefined,
    seams,
  );
  if (result.status !== 0) {
    return [false, `git ls-remote failed: ${result.stderr.trim()}`];
  }
  if (!result.stdout.trim()) {
    return [false, `tag verify FAIL: ${tag} not present on temp origin`];
  }
  return [true, `verified tag ${tag} present on temp origin`];
}
