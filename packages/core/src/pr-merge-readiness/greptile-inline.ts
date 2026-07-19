import { detect } from "../content-contracts/skills/greptile-detector.js";
import { GREPTILE_LOGIN } from "./constants.js";
import type { RunGhFn } from "./types.js";

/** Unresolved Greptile inline P0/P1 on the current PR HEAD (#2620). */
export interface InlineGreptileFindings {
  readonly p0Count: number;
  readonly p1Count: number;
  readonly unresolvedThreadCount: number;
  readonly error: string | null;
}

export interface InlineReviewComment {
  readonly authorLogin: string;
  readonly body: string;
  readonly path: string | null;
  readonly commitOid: string | null;
}

export interface InlineReviewThread {
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly comments: readonly InlineReviewComment[];
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first: 50) {
            nodes {
              author { login }
              body
              path
              commit { oid }
            }
          }
        }
      }
    }
  }
}`;

const EMPTY_INLINE: InlineGreptileFindings = {
  p0Count: 0,
  p1Count: 0,
  unresolvedThreadCount: 0,
  error: null,
};

/** True when a review comment commit SHA matches the current PR head (#2620 AC-2). */
export function headShaMatches(commentSha: string, headSha: string): boolean {
  return headSha.startsWith(commentSha) || commentSha.startsWith(headSha);
}

export function inlineFindingsToDict(findings: InlineGreptileFindings): Record<string, unknown> {
  return {
    p0_count: findings.p0Count,
    p1_count: findings.p1Count,
    unresolved_thread_count: findings.unresolvedThreadCount,
    error: findings.error,
  };
}

function parseOwnerRepo(ownerRepo: string): { owner: string; repo: string } | null {
  const slash = ownerRepo.indexOf("/");
  if (slash <= 0 || slash >= ownerRepo.length - 1) {
    return null;
  }
  return { owner: ownerRepo.slice(0, slash), repo: ownerRepo.slice(slash + 1) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseReviewComment(node: unknown): InlineReviewComment | null {
  const record = asRecord(node);
  if (record === null) {
    return null;
  }
  const author = asRecord(record.author);
  const login = author?.login;
  if (typeof login !== "string" || login.length === 0) {
    return null;
  }
  const body = record.body;
  if (typeof body !== "string") {
    return null;
  }
  const commit = asRecord(record.commit);
  const oid = commit?.oid;
  const path = record.path;
  return {
    authorLogin: login,
    body,
    path: typeof path === "string" ? path : null,
    commitOid: typeof oid === "string" && oid.length > 0 ? oid : null,
  };
}

function parseReviewThread(node: unknown): InlineReviewThread | null {
  const record = asRecord(node);
  if (record === null) {
    return null;
  }
  const commentsBlock = asRecord(record.comments);
  const commentNodes = commentsBlock?.nodes;
  const comments: InlineReviewComment[] = [];
  if (Array.isArray(commentNodes)) {
    for (const commentNode of commentNodes) {
      const parsed = parseReviewComment(commentNode);
      if (parsed !== null) {
        comments.push(parsed);
      }
    }
  }
  return {
    isResolved: record.isResolved === true,
    isOutdated: record.isOutdated === true,
    comments,
  };
}

interface GraphqlReviewThreadsPage {
  readonly threads: InlineReviewThread[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly error: string | null;
}

function parseGraphqlReviewThreadsPage(stdout: string): GraphqlReviewThreadsPage {
  if (!stdout.trim()) {
    return { threads: [], hasNextPage: false, endCursor: null, error: "empty GraphQL body" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return {
      threads: [],
      hasNextPage: false,
      endCursor: null,
      error: `could not parse GraphQL JSON: ${message}`,
    };
  }
  const root = asRecord(payload);
  const errors = root?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const message =
      typeof first === "object" && first !== null && "message" in first
        ? String((first as Record<string, unknown>).message)
        : "GraphQL errors present";
    return { threads: [], hasNextPage: false, endCursor: null, error: message };
  }
  const data = asRecord(root?.data);
  const repository = asRecord(data?.repository);
  const pullRequest = asRecord(repository?.pullRequest);
  const reviewThreads = asRecord(pullRequest?.reviewThreads);
  const nodes = reviewThreads?.nodes;
  const pageInfo = asRecord(reviewThreads?.pageInfo);
  const threads: InlineReviewThread[] = [];
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const parsed = parseReviewThread(node);
      if (parsed !== null) {
        threads.push(parsed);
      }
    }
  }
  return {
    threads,
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: typeof pageInfo?.endCursor === "string" ? pageInfo.endCursor : null,
    error: null,
  };
}

/** Score unresolved Greptile inline P0/P1 threads pinned to the current HEAD (#2620). */
export function evaluateInlineReviewThreads(
  threads: readonly InlineReviewThread[],
  headSha: string,
): InlineGreptileFindings {
  let p0Count = 0;
  let p1Count = 0;
  let unresolvedThreadCount = 0;

  for (const thread of threads) {
    if (thread.isResolved || thread.isOutdated) {
      continue;
    }

    let threadP0 = 0;
    let threadP1 = 0;
    for (const comment of thread.comments) {
      if (comment.authorLogin !== GREPTILE_LOGIN) {
        continue;
      }
      if (comment.commitOid === null || !headShaMatches(comment.commitOid, headSha)) {
        continue;
      }
      const findings = detect(comment.body);
      threadP0 += findings.p0_count;
      threadP1 += findings.p1_count;
    }

    if (threadP0 + threadP1 > 0) {
      p0Count += threadP0;
      p1Count += threadP1;
      unresolvedThreadCount += 1;
    }
  }

  return { p0Count, p1Count, unresolvedThreadCount, error: null };
}

/** Fetch unresolved Greptile inline P0/P1 on the current HEAD via reviewThreads GraphQL (#2620). */
export function fetchUnresolvedGreptileInlineFindings(
  prNumber: number,
  repo: string,
  headSha: string,
  runGh: RunGhFn,
): InlineGreptileFindings {
  const parsed = parseOwnerRepo(repo);
  if (parsed === null) {
    return { ...EMPTY_INLINE, error: `invalid repo: ${repo}` };
  }

  const allThreads: InlineReviewThread[] = [];
  let after: string | null = null;
  const maxPages = 10;
  let hasNextPage = true;
  for (let page = 0; hasNextPage && page < maxPages; page += 1) {
    const cmd = [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `owner=${parsed.owner}`,
      "-f",
      `repo=${parsed.repo}`,
      "-F",
      `pr=${String(prNumber)}`,
    ];
    if (after !== null) {
      cmd.push("-f", `after=${after}`);
    }
    const rc = runGh(cmd);
    if (rc.returncode !== 0) {
      return {
        ...EMPTY_INLINE,
        error: `graphql reviewThreads failed: ${rc.stderr.trim() || rc.stdout.trim()}`,
      };
    }
    const pageResult = parseGraphqlReviewThreadsPage(rc.stdout);
    if (pageResult.error !== null) {
      return { ...EMPTY_INLINE, error: pageResult.error };
    }
    allThreads.push(...pageResult.threads);
    hasNextPage = pageResult.hasNextPage;
    if (!hasNextPage) {
      break;
    }
    if (pageResult.endCursor === null) {
      return {
        ...EMPTY_INLINE,
        error: "graphql reviewThreads pagination missing endCursor while hasNextPage=true",
      };
    }
    after = pageResult.endCursor;
  }

  if (hasNextPage) {
    return {
      ...EMPTY_INLINE,
      error: `graphql reviewThreads pagination exceeded ${maxPages} pages`,
    };
  }

  return evaluateInlineReviewThreads(allThreads, headSha);
}
