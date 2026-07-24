import { spawnSync } from "node:child_process";
import { resolveBinary } from "../scm/binary.js";
import {
  DEFAULT_TIMEOUT_S,
  type GhRestSeams,
  restDeleteComment,
  restGetUser,
  restPostComment,
  restUpdateComment,
} from "../scm/gh-rest.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import {
  type IssueComment,
  isMaintainerAuthored,
  parseCommentsFromGhStdout,
} from "../umbrella-current-shape/index.js";
import { mapCommentEntry, type ReviewOwnerComment } from "./lease-comment.js";

export type { IssueComment };

export interface ReviewOwnerGithubSeams extends GhRestSeams {
  readonly fetchComments?: (repo: string, pr: number) => IssueComment[] | { error: string };
  readonly createComment?: (
    repo: string,
    pr: number,
    body: string,
  ) => { id: number } | { error: string };
  readonly updateComment?: (
    repo: string,
    commentId: number,
    body: string,
  ) => { ok: true } | { error: string };
  readonly deleteComment?: (repo: string, commentId: number) => { ok: true } | { error: string };
  readonly getGitHubLogin?: () => string | null;
}

function defaultFetchComments(
  repo: string,
  pr: number,
  seams: ReviewOwnerGithubSeams,
): IssueComment[] | { error: string } {
  const binary = resolveBinary(seams.whichFn);
  const path = `repos/${repo}/issues/${pr}/comments?per_page=100`;
  const proc = spawnSync(binary, ["api", "--paginate", path], {
    encoding: "utf8",
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    timeout: DEFAULT_TIMEOUT_S * 1000,
  });
  if (proc.error !== undefined) {
    return { error: `fetch PR #${pr} comments (${repo}) failed: ${proc.error.message}` };
  }
  if (proc.status !== 0) {
    return {
      error: `fetch PR #${pr} comments (${repo}) failed: ${(proc.stderr || proc.stdout || "").trim()}`,
    };
  }
  try {
    return parseCommentsFromGhStdout(String(proc.stdout ?? ""));
  } catch (exc) {
    return {
      error: `fetch PR #${pr} comments (${repo}) returned non-JSON: ${String(exc)}`,
    };
  }
}

export function listReviewOwnerComments(
  repo: string,
  pr: number,
  seams: ReviewOwnerGithubSeams = {},
): ReviewOwnerComment[] | { error: string } {
  const fetcher = seams.fetchComments ?? ((r, n) => defaultFetchComments(r, n, seams));
  const fetched = fetcher(repo, pr);
  if (!Array.isArray(fetched)) {
    return fetched;
  }
  const comments: ReviewOwnerComment[] = [];
  for (const entry of fetched) {
    if (!isMaintainerAuthored(entry.authorAssociation)) {
      continue;
    }
    const mapped = mapCommentEntry({
      id: entry.id,
      body: entry.body,
      created_at: entry.updatedAt,
    });
    if (mapped !== null) {
      comments.push(mapped);
    }
  }
  return comments;
}

export function createReviewOwnerComment(
  repo: string,
  pr: number,
  body: string,
  seams: ReviewOwnerGithubSeams = {},
): { id: number } | { error: string } {
  if (seams.createComment !== undefined) {
    return seams.createComment(repo, pr, body);
  }
  try {
    const created = restPostComment(repo, pr, body, seams);
    const id = created.id;
    if (typeof id !== "number") {
      return { error: "create comment: response missing id" };
    }
    return { id };
  } catch (exc: unknown) {
    return { error: String((exc as Error).message ?? exc) };
  }
}

export function updateReviewOwnerComment(
  repo: string,
  commentId: number,
  body: string,
  seams: ReviewOwnerGithubSeams = {},
): { ok: true } | { error: string } {
  if (seams.updateComment !== undefined) {
    return seams.updateComment(repo, commentId, body);
  }
  try {
    restUpdateComment(repo, commentId, body, seams);
    return { ok: true };
  } catch (exc: unknown) {
    return { error: String((exc as Error).message ?? exc) };
  }
}

export function deleteReviewOwnerComment(
  repo: string,
  commentId: number,
  seams: ReviewOwnerGithubSeams = {},
): { ok: true } | { error: string } {
  if (seams.deleteComment !== undefined) {
    return seams.deleteComment(repo, commentId);
  }
  try {
    restDeleteComment(repo, commentId, seams);
    return { ok: true };
  } catch (exc: unknown) {
    return { error: String((exc as Error).message ?? exc) };
  }
}

export function resolveGitHubLogin(seams: ReviewOwnerGithubSeams = {}): string | null {
  if (seams.getGitHubLogin !== undefined) {
    return seams.getGitHubLogin();
  }
  try {
    const user = restGetUser(seams);
    return typeof user.login === "string" && user.login.length > 0 ? user.login : null;
  } catch {
    return null;
  }
}
