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
import { DEFAULT_PASS_STALE_MINUTES, PASS_MARKER_KIND } from "./constants.js";
import {
  computeExpiresAt,
  findActivePassComment,
  mapCommentEntry,
  mapPassCommentEntry,
  type PassOpenComment,
  type PassOpenMarker,
  type ReviewOwnerComment,
  renderPassOpenComment,
  selectWinningPassComment,
} from "./lease-comment.js";

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

/**
 * Author trust boundary for `<!-- deft:review-owner -->` comments (#3607 / #2307).
 *
 * Ownership leases gate. `verify:review-monitor` and `verify:l4-owner` exit 0 on a live
 * lease, so a forged lease defeats a fail-closed gate. `listReviewOwnerComments` above
 * therefore admits only maintainer associations -- OWNER, MEMBER, COLLABORATOR. That
 * filter is the single author-association check in the lease read path and it lives in
 * `isMaintainerAuthored` / `MAINTAINER_ASSOCIATIONS`
 * (`packages/core/src/umbrella-current-shape/index.ts`), which is why a search for
 * `author_association` in this directory finds nothing.
 *
 * Pass marks do not gate. They tell an arriving agent that a pass is open and never
 * block a write, so a forged mark costs at most an unnecessary courtesy. Pass marks are
 * therefore read from every author association, including CONTRIBUTOR, which is what
 * #3607 requires ("visible regardless of the author's trust association"). The field
 * instance is real: comment 5429316778 on PR #3775 carries this marker and is
 * CONTRIBUTOR-authored, so the lease filter hides it while this reader sees it.
 */
export function listPassMarkerComments(
  repo: string,
  issue: number,
  seams: ReviewOwnerGithubSeams = {},
): PassOpenComment[] | { error: string } {
  const fetcher = seams.fetchComments ?? ((r, n) => defaultFetchComments(r, n, seams));
  const fetched = fetcher(repo, issue);
  if (!Array.isArray(fetched)) {
    return fetched;
  }
  const comments: PassOpenComment[] = [];
  for (const entry of fetched) {
    const mapped = mapPassCommentEntry({
      id: entry.id,
      body: entry.body,
      created_at: entry.updatedAt,
      author_login: entry.authorLogin,
    });
    if (mapped !== null) {
      comments.push(mapped);
    }
  }
  return comments;
}

export interface ActivePassMarker {
  readonly commentId: number;
  readonly marker: PassOpenMarker;
}

/** Read the open mark on an issue thread; expired and cleared marks are ignored (#3607). */
export function fetchActivePassMarker(
  repo: string,
  issue: number,
  options: { now?: Date; seams?: ReviewOwnerGithubSeams } = {},
): ActivePassMarker | null | { error: string } {
  const listed = listPassMarkerComments(repo, issue, options.seams ?? {});
  if (!Array.isArray(listed)) {
    return { error: listed.error };
  }
  const active = findActivePassComment(listed, { now: options.now });
  if (active === null || active.marker === null) {
    return null;
  }
  return { commentId: active.id, marker: active.marker };
}

export interface OpenPassMarkerInput {
  readonly repo: string;
  readonly issue: number;
  readonly owner: string;
  readonly passKind: string;
  readonly agentId?: string | null;
  readonly ceiling?: string | null;
  readonly startedAt?: Date;
  readonly staleMinutes?: number;
  readonly seams?: ReviewOwnerGithubSeams;
}

export type OpenPassMarkerResult =
  | {
      readonly status: "opened" | "renewed" | "observed";
      readonly commentId: number;
      readonly marker: PassOpenMarker;
    }
  | { readonly error: string };

function buildPassMarker(input: OpenPassMarkerInput, startedAt: Date): PassOpenMarker {
  return {
    kind: PASS_MARKER_KIND,
    pass_kind: input.passKind,
    owner: input.owner,
    agent_id: input.agentId ?? null,
    ceiling: input.ceiling ?? null,
    started_at: startedAt.toISOString(),
    expires_at: computeExpiresAt(startedAt, input.staleMinutes ?? DEFAULT_PASS_STALE_MINUTES),
    ended_at: null,
  };
}

function resolvePassCreateRace(
  input: OpenPassMarkerInput,
  createdId: number,
  marker: PassOpenMarker,
  now: Date,
  seams: ReviewOwnerGithubSeams,
): OpenPassMarkerResult {
  const relisted = listPassMarkerComments(input.repo, input.issue, seams);
  if (!Array.isArray(relisted)) {
    return { error: relisted.error };
  }
  const winner = findActivePassComment(relisted, { now });
  if (winner === null || winner.marker === null || winner.id === createdId) {
    return { status: "opened", commentId: createdId, marker };
  }
  const deleted = deleteReviewOwnerComment(input.repo, createdId, seams);
  if ("error" in deleted) {
    return { error: deleted.error };
  }
  return { status: "observed", commentId: winner.id, marker: winner.marker };
}

/**
 * Confirm our write is still the winning mark, and stand down when it is not.
 *
 * Only the comment's own author ever PATCHes it (see `openPassMarker`), so a readback
 * cannot be raced by a second writer on the same comment. What it must still catch is
 * an older mark another owner created concurrently: oldest comment id wins, so we clear
 * our own mark and report theirs (#3607).
 */
function verifyExclusivePassMark(
  input: OpenPassMarkerInput,
  commentId: number,
  marker: PassOpenMarker,
  now: Date,
  seams: ReviewOwnerGithubSeams,
): OpenPassMarkerResult | null {
  const relisted = listPassMarkerComments(input.repo, input.issue, seams);
  if (!Array.isArray(relisted)) {
    return { error: relisted.error };
  }
  const winner = findActivePassComment(relisted, { now });
  if (winner === null || winner.marker === null || winner.id === commentId) {
    return null;
  }
  const cleared = updateReviewOwnerComment(
    input.repo,
    commentId,
    renderPassOpenComment({ ...marker, ended_at: now.toISOString() }),
    seams,
  );
  if ("error" in cleared) {
    return { error: cleared.error };
  }
  return { status: "observed", commentId: winner.id, marker: winner.marker };
}

/**
 * Mark a pass open on an issue thread (#3607).
 *
 * `observed` means another owner's mark is already open: the caller is informed and MAY
 * still write. Nothing is held and no takeover happens. Races resolve oldest-comment-id
 * wins, matching the lease (#2814).
 */
export function openPassMarker(input: OpenPassMarkerInput): OpenPassMarkerResult {
  const seams = input.seams ?? {};
  const startedAt = input.startedAt ?? new Date();
  const listed = listPassMarkerComments(input.repo, input.issue, seams);
  if (!Array.isArray(listed)) {
    return { error: listed.error };
  }
  const active = findActivePassComment(listed, { now: startedAt });
  if (active !== null && active.marker !== null && active.marker.owner !== input.owner) {
    return { status: "observed", commentId: active.id, marker: active.marker };
  }
  const marker = buildPassMarker(input, startedAt);
  const body = renderPassOpenComment(marker);
  // Recycle only a comment this owner authored. Editing another author's comment is a
  // 403 for a non-maintainer, and two owners PATCHing one comment cannot be arbitrated
  // after the fact -- each would read back its own write. Distinct owners therefore
  // always land on distinct comments and resolve by oldest comment id (#3607).
  const ownComments = listed.filter((comment) => comment.authorLogin === input.owner);
  const target =
    active !== null && active.authorLogin === input.owner
      ? active
      : selectWinningPassComment(ownComments);
  if (target !== null) {
    const updated = updateReviewOwnerComment(input.repo, target.id, body, seams);
    if ("error" in updated) {
      return { error: updated.error };
    }
    const contested = verifyExclusivePassMark(input, target.id, marker, startedAt, seams);
    if (contested !== null) {
      return contested;
    }
    // Two runs of the SAME owner may both land here; both marks then name that owner,
    // so no owner's pass disappears and the observable state is identical.
    const renewed = active !== null && target.id === active.id;
    return { status: renewed ? "renewed" : "opened", commentId: target.id, marker };
  }
  const created = createReviewOwnerComment(input.repo, input.issue, body, seams);
  if ("error" in created) {
    return { error: created.error };
  }
  return resolvePassCreateRace(input, created.id, marker, startedAt, seams);
}

export interface ClosePassMarkerInput {
  readonly repo: string;
  readonly issue: number;
  readonly owner: string;
  readonly endedAt?: Date;
  readonly seams?: ReviewOwnerGithubSeams;
}

export type ClosePassMarkerResult =
  | {
      readonly status: "cleared" | "not-open" | "held-by-other";
      readonly commentId: number | null;
    }
  | { readonly error: string };

/** Clear the mark at synthesis; another owner's mark is reported back, never overwritten. */
export function closePassMarker(input: ClosePassMarkerInput): ClosePassMarkerResult {
  const seams = input.seams ?? {};
  const endedAt = input.endedAt ?? new Date();
  const listed = listPassMarkerComments(input.repo, input.issue, seams);
  if (!Array.isArray(listed)) {
    return { error: listed.error };
  }
  const active = findActivePassComment(listed, { now: endedAt });
  if (active === null || active.marker === null) {
    return { status: "not-open", commentId: null };
  }
  if (active.marker.owner !== input.owner) {
    return { status: "held-by-other", commentId: active.id };
  }
  const body = renderPassOpenComment({ ...active.marker, ended_at: endedAt.toISOString() });
  const updated = updateReviewOwnerComment(input.repo, active.id, body, seams);
  if ("error" in updated) {
    return { error: updated.error };
  }
  return { status: "cleared", commentId: active.id };
}
