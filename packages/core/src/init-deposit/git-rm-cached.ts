/**
 * Shared index-only `git rm --cached` runner for deposit / local-runtime
 * untrack (#2269 / #3911). Lives outside the ADR-004 update-path ban list so
 * callers on that path inject this port instead of raw execFileSync(git).
 */

import { execFileSync } from "node:child_process";

export interface GitRmCachedResult {
  readonly ok: boolean;
  readonly detail: string;
}

export type GitRmCached = (projectDir: string, paths: readonly string[]) => GitRmCachedResult;

export function runGitRmCached(
  projectDir: string,
  paths: readonly string[],
  options: { ignoreUnmatch?: boolean } = {},
): GitRmCachedResult {
  const ignoreUnmatch = options.ignoreUnmatch === true;
  try {
    const args = ignoreUnmatch
      ? (["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths] as string[])
      : (["rm", "--cached", "-r", "--", ...paths] as string[]);
    const out = execFileSync("git", args, {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, detail: out };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail };
  }
}
