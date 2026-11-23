/**
 * Repository inference from `origin` for `pr:wait-mergeable-and-merge` (#6869).
 *
 * Used only when neither `--repo` nor `GH_REPO` names a repository. The
 * `origin` URL is parsed with the anchored `githubOwnerRepoFromRemoteUrl`
 * (github.com HTTPS or SSH, `<owner>/<name>` only). The repository is then read
 * once through REST and used only when GitHub reports it is not a fork. Any
 * other case gives a reason and no repository, so the verb refuses.
 */

import { makeGateRunner } from "../orphan-active/issue-state.js";
import { githubOwnerRepoFromRemoteUrl } from "../release/closed-verb-gate.js";
import { runGit } from "../release/git.js";
import type { QueueRunGhFn } from "./merge-queue.js";

/** Result of `git -C <projectRoot> remote get-url origin`: the raw URL, or why there is none. */
export interface OriginRemoteRead {
  readonly url: string | null;
  readonly error: string | null;
}

/** Result of one REST `repos/<owner>/<name>` read: the `fork` flag, or why there is none. */
export interface RepoForkRead {
  readonly fork: boolean | null;
  readonly error: string | null;
}

/** The git read and the repository read, as one injectable seam (#6869 item 2). */
export interface OriginRepoSeam {
  readonly readOriginRemote: (projectRoot: string) => OriginRemoteRead;
  readonly readRepo: (repo: string) => RepoForkRead;
}

/** Inferred repository, or the reason the inference gave none. */
export type OriginRepoInference =
  | { readonly repo: string; readonly reason: null }
  | { readonly repo: null; readonly reason: string };

/** Live `origin` read through the same git call the release closed-verb gate uses. */
export function readOriginRemote(projectRoot: string): OriginRemoteRead {
  const result = runGit(projectRoot, ["remote", "get-url", "origin"]);
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    return { url: null, error: detail.length > 0 ? detail : `git exited ${result.status}` };
  }
  return { url: result.stdout.trim(), error: null };
}

/** Live REST `repos/<owner>/<name>` read; only the `fork` flag is used. */
export function readRepoFork(
  repo: string,
  runGh: QueueRunGhFn = makeGateRunner().runGh,
): RepoForkRead {
  let rc: ReturnType<QueueRunGhFn>;
  try {
    // The runner throws when neither `gh` nor `ghx` is on PATH; that is a failed read.
    rc = runGh(["gh", "api", `repos/${repo}`]);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return { fork: null, error: `gh api repos/${repo} failed: ${detail}` };
  }
  if (rc.returncode !== 0) {
    return { fork: null, error: `gh api repos/${repo} failed: ${rc.stderr.trim()}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rc.stdout) as unknown;
  } catch {
    return { fork: null, error: `repos/${repo} is not JSON` };
  }
  const fork =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).fork
      : undefined;
  if (typeof fork !== "boolean") {
    return { fork: null, error: `repos/${repo} has no boolean fork field` };
  }
  return { fork, error: null };
}

export const LIVE_ORIGIN_REPO_SEAM: OriginRepoSeam = {
  readOriginRemote,
  readRepo: (repo) => readRepoFork(repo),
};

/** Infer the repository from `origin` (#6869 items 2 and 3). */
export function inferRepoFromOrigin(
  projectRoot: string,
  seam: OriginRepoSeam = LIVE_ORIGIN_REPO_SEAM,
): OriginRepoInference {
  const remote = seam.readOriginRemote(projectRoot);
  if (remote.url === null || remote.url.length === 0) {
    const detail = remote.error ?? "empty URL";
    return { repo: null, reason: `cannot read the origin remote (${detail})` };
  }
  const repo = githubOwnerRepoFromRemoteUrl(remote.url);
  if (repo === null) {
    return {
      repo: null,
      reason: `origin URL ${JSON.stringify(remote.url)} is not a github.com <owner>/<name> URL`,
    };
  }
  const read = seam.readRepo(repo);
  if (read.error !== null || read.fork === null) {
    return {
      repo: null,
      reason: `cannot read repository ${repo} (${read.error ?? "no fork field"})`,
    };
  }
  if (read.fork) {
    return { repo: null, reason: `${repo} is a fork` };
  }
  return { repo, reason: null };
}

/** Refusal text when no repository is given and none is inferred (#6869 item 3). */
export function formatRepoRequiredError(reason: string): string {
  return (
    "Error: --repo OWNER/REPO is required (or set $GH_REPO, or run in a clone whose origin " +
    `is a non-fork github.com repository); origin: ${reason}\n`
  );
}

/** Line printed when the repository comes from `origin` (#6869 item 2). */
export function formatInferredRepoLine(repo: string): string {
  return `pr_wait_mergeable: repo=${repo} (from origin)\n`;
}
