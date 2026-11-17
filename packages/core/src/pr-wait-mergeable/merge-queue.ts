/**
 * Merge-queue mode for `pr:wait-mergeable-and-merge` (#6295 items 4, 5, 8).
 *
 * When the delivery branch requires a GitHub merge queue, the merge verb runs
 * its head-reading checks, records the head SHA and the time, and enqueues with
 * `gh pr merge N --match-head-commit <sha>` (no `--admin`, no merge-method
 * flag). It then reads the PR once and reports exactly one of six results,
 * checked head first. `--resume --expect-head <sha> --since <time>` repeats the
 * read from any session.
 *
 * Reads use plain `gh` (never the cached `ghx` proxy): queue state must be live.
 * The GraphQL read probes the live rate limit first and refuses below the
 * #954 floor; the caller prints the resume command so a later session retries.
 */

import { makeGateRunner } from "../orphan-active/issue-state.js";
import { shasMatch } from "../pr-closeout-attestable/pr-head-assert.js";

export interface GhResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type QueueRunGhFn = (cmd: readonly string[]) => GhResult;

/** #954: switch away from GraphQL below this many remaining points. */
export const MERGE_QUEUE_GRAPHQL_FLOOR = 500;

/** Ruleset rule type GitHub reports for a required merge queue. */
export const MERGE_QUEUE_RULE_TYPE = "merge_queue" as const;

export const QUEUE_RESULT_KINDS = [
  "head-changed",
  "merged",
  "queued",
  "awaiting-admission",
  "removed",
  "inactive",
] as const;

export type QueueResultKind = (typeof QUEUE_RESULT_KINDS)[number];

export type MergeQueueDetection =
  | { readonly status: "queue"; readonly branch: string }
  | { readonly status: "none"; readonly branch: string }
  | { readonly status: "error"; readonly message: string };

export type MergeQueueDetectFn = (
  prNumber: number | null,
  repo: string,
  baseBranch: string | null,
) => MergeQueueDetection;

export interface QueueEvent {
  readonly type: string;
  readonly createdAt: string;
  /** Removal `reason` or auto-merge-disabled `reasonCode`; null when GitHub gives none. */
  readonly reason: string | null;
}

/** One read of the PR's merge state from GitHub. */
export interface QueueRead {
  readonly headSha: string | null;
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly queueEntry: { readonly state: string | null; readonly position: number | null } | null;
  readonly autoMergeRequested: boolean;
  readonly events: readonly QueueEvent[];
}

export type QueueReadResult =
  | { readonly status: "ok"; readonly read: QueueRead }
  | { readonly status: "rate-limited"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

export type QueueReadFn = (prNumber: number, repo: string) => QueueReadResult;

export interface QueueResult {
  readonly kind: QueueResultKind;
  readonly expectedHead: string;
  readonly actualHead: string | null;
  readonly since: string;
  readonly mergeCommitSha: string | null;
  readonly queueState: string | null;
  readonly queuePosition: number | null;
  /** `removed`: GitHub's reason, empty string when none was given. */
  readonly removalReason: string | null;
  /** `inactive`: latest auto-merge-disabled reason code after `since`, if any. */
  readonly autoMergeDisabledReason: string | null;
  readonly events: readonly QueueEvent[];
}

function liveRunGh(): QueueRunGhFn {
  return makeGateRunner().runGh;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Resolve the PR's base branch over REST (`pulls/<N>` base.ref). */
export function fetchPrBaseRef(
  prNumber: number,
  repo: string,
  runGh: QueueRunGhFn,
): { readonly ref: string | null; readonly error: string | null } {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return { ref: null, error: `gh api pulls/${prNumber} failed: ${rc.stderr.trim()}` };
  }
  const base = asRecord(asRecord(parseJson(rc.stdout))?.base);
  const ref = str(base?.ref);
  return ref === null
    ? { ref: null, error: `PR #${prNumber} base.ref missing from REST payload` }
    : { ref, error: null };
}

/** Resolve the repository default branch over REST (`repos/<o>/<r>` default_branch). */
export function fetchDefaultBranch(
  repo: string,
  runGh: QueueRunGhFn,
): { readonly ref: string | null; readonly error: string | null } {
  const rc = runGh(["gh", "api", `repos/${repo}`]);
  if (rc.returncode !== 0) {
    return { ref: null, error: `gh api repos/${repo} failed: ${rc.stderr.trim()}` };
  }
  const ref = str(asRecord(parseJson(rc.stdout))?.default_branch);
  return ref === null
    ? { ref: null, error: `repos/${repo} default_branch missing from REST payload` }
    : { ref, error: null };
}

/** True when the branch rules REST payload carries a merge_queue rule. */
export function rulesRequireMergeQueue(payload: unknown): boolean | null {
  if (!Array.isArray(payload)) return null;
  return payload.some((rule) => asRecord(rule)?.type === MERGE_QUEUE_RULE_TYPE);
}

/**
 * Detect whether the delivery branch requires a merge queue (branch rules REST).
 * A read failure is an error, never "no queue": the caller must not fall back to
 * a direct `--admin` merge on a queue branch (#6295 item 8).
 *
 * With a PR number the branch is always the PR's live `base.ref`; a
 * `baseBranch` override that names a different branch is an error, so an
 * override can never steer a queue-branch PR onto the direct path. Without a
 * PR, `baseBranch` (or the repository default branch) is used.
 */
export function detectMergeQueue(
  prNumber: number | null,
  repo: string,
  baseBranch: string | null,
  runGh: QueueRunGhFn = liveRunGh(),
): MergeQueueDetection {
  const override = baseBranch !== null && baseBranch.trim().length > 0 ? baseBranch.trim() : null;
  let branch: string;
  if (prNumber !== null) {
    const base = fetchPrBaseRef(prNumber, repo, runGh);
    if (base.ref === null) {
      return { status: "error", message: base.error ?? "could not resolve PR base branch" };
    }
    if (override !== null && override !== base.ref) {
      return {
        status: "error",
        message:
          `--base-branch ${override} conflicts with PR #${prNumber} base ${base.ref}; ` +
          "queue detection always reads the PR's live base",
      };
    }
    branch = base.ref;
  } else if (override !== null) {
    branch = override;
  } else {
    const def = fetchDefaultBranch(repo, runGh);
    if (def.ref === null) {
      return { status: "error", message: def.error ?? "could not resolve default branch" };
    }
    branch = def.ref;
  }
  const rc = runGh(["gh", "api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`]);
  if (rc.returncode !== 0) {
    return {
      status: "error",
      message: `gh api rules/branches/${branch} failed: ${rc.stderr.trim()}`,
    };
  }
  const required = rulesRequireMergeQueue(parseJson(rc.stdout));
  if (required === null) {
    return { status: "error", message: `rules/branches/${branch} returned a non-array payload` };
  }
  return { status: required ? "queue" : "none", branch };
}

/** Merge queue setup playbook, named by the direct-path advisory (#6366). */
export const MERGE_QUEUE_PLAYBOOK_PATH = "content/docs/github-merge-queue-setup.md";

/**
 * Stable link to the playbook. An installed copy flattens `content/`, so the
 * repository path alone does not resolve outside the source checkout.
 */
export const MERGE_QUEUE_PLAYBOOK_URL = `https://github.com/deftai/directive/blob/master/${MERGE_QUEUE_PLAYBOOK_PATH}`;

/** The one advisory line for a strict branch with no merge queue (#6366). */
export function mergeQueueAdvisoryLine(branch: string): string {
  return (
    `pr_wait_mergeable: advisory: ${branch} requires up-to-date checks and has no merge queue, ` +
    `so each merge puts open PRs behind. To set up a queue, see ${MERGE_QUEUE_PLAYBOOK_URL}.`
  );
}

/** True when a branch rules payload has a strict `required_status_checks` rule. */
export function rulesRequireStrictChecks(payload: unknown): boolean {
  if (!Array.isArray(payload)) return false;
  return payload.some((rule) => {
    const rec = asRecord(rule);
    return (
      rec?.type === "required_status_checks" &&
      asRecord(rec.parameters)?.strict_required_status_checks_policy === true
    );
  });
}

export type StrictChecksDetectFn = (repo: string, branch: string) => boolean;

/**
 * Advisory read (#6366): does the branch require up-to-date checks, from a
 * ruleset rule or from classic branch protection? A read error counts as no:
 * the result only decides whether to print one advisory line.
 */
export function detectStrictUpToDate(
  repo: string,
  branch: string,
  runGh: QueueRunGhFn = liveRunGh(),
): boolean {
  const ref = encodeURIComponent(branch);
  const rules = runGh(["gh", "api", `repos/${repo}/rules/branches/${ref}`]);
  if (rules.returncode === 0 && rulesRequireStrictChecks(parseJson(rules.stdout))) {
    return true;
  }
  const classic = runGh([
    "gh",
    "api",
    `repos/${repo}/branches/${ref}/protection/required_status_checks`,
  ]);
  return classic.returncode === 0 && asRecord(parseJson(classic.stdout))?.strict === true;
}

/** GraphQL read of everything the six results need, in one request. */
export const QUEUE_STATE_QUERY = [
  "query($owner:String!,$name:String!,$number:Int!){",
  "repository(owner:$owner,name:$name){pullRequest(number:$number){",
  "headRefOid merged mergeCommit{oid}",
  "mergeQueueEntry{state position}",
  "autoMergeRequest{enabledAt}",
  "timelineItems(last:50,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,",
  "AUTO_MERGE_ENABLED_EVENT,AUTO_MERGE_DISABLED_EVENT]){nodes{__typename",
  "...on AddedToMergeQueueEvent{createdAt}",
  "...on RemovedFromMergeQueueEvent{createdAt reason}",
  "...on AutoMergeEnabledEvent{createdAt}",
  "...on AutoMergeDisabledEvent{createdAt reasonCode}",
  "}}}}}",
].join("");

/** Parse the GraphQL response into a {@link QueueRead}; null on an unexpected shape. */
export function parseQueueState(payload: unknown): QueueRead | null {
  const pr = asRecord(asRecord(asRecord(asRecord(payload)?.data)?.repository)?.pullRequest);
  if (pr === null) return null;
  const entry = asRecord(pr.mergeQueueEntry);
  const nodes = asRecord(pr.timelineItems)?.nodes;
  const events: QueueEvent[] = [];
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const rec = asRecord(node);
      const type = str(rec?.__typename);
      const createdAt = str(rec?.createdAt);
      if (rec === null || type === null || createdAt === null) continue;
      const reason =
        typeof rec.reason === "string"
          ? rec.reason
          : typeof rec.reasonCode === "string"
            ? rec.reasonCode
            : null;
      events.push({ type, createdAt, reason });
    }
  }
  const position = entry?.position;
  return {
    headSha: str(pr.headRefOid),
    merged: pr.merged === true,
    mergeCommitSha: str(asRecord(pr.mergeCommit)?.oid),
    queueEntry:
      entry === null
        ? null
        : { state: str(entry.state), position: typeof position === "number" ? position : null },
    autoMergeRequested: asRecord(pr.autoMergeRequest) !== null,
    events,
  };
}

/** Live `gh api rate_limit` GraphQL remaining (never ghx); null when unreadable. */
export function probeGraphqlRemaining(runGh: QueueRunGhFn): number | null {
  const rc = runGh(["gh", "api", "rate_limit"]);
  if (rc.returncode !== 0) return null;
  const remaining = asRecord(
    asRecord(asRecord(parseJson(rc.stdout))?.resources)?.graphql,
  )?.remaining;
  return typeof remaining === "number" ? remaining : null;
}

/** Read the PR's queue state once, honouring the #954 GraphQL floor. */
export function readQueueState(
  prNumber: number,
  repo: string,
  runGh: QueueRunGhFn = liveRunGh(),
): QueueReadResult {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) {
    return { status: "error", message: `repo must be OWNER/NAME, got ${JSON.stringify(repo)}` };
  }
  const remaining = probeGraphqlRemaining(runGh);
  if (remaining !== null && remaining < MERGE_QUEUE_GRAPHQL_FLOOR) {
    return {
      status: "rate-limited",
      message:
        `GraphQL bucket has ${remaining} points left (< ${MERGE_QUEUE_GRAPHQL_FLOOR}, #954); ` +
        "queue state not read. Resume after the bucket resets.",
    };
  }
  const rc = runGh([
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${QUEUE_STATE_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${prNumber}`,
  ]);
  if (rc.returncode !== 0) {
    return { status: "error", message: `queue state read failed: ${rc.stderr.trim()}` };
  }
  const read = parseQueueState(parseJson(rc.stdout));
  if (read === null) {
    return { status: "error", message: `PR #${prNumber} queue state payload had no pullRequest` };
  }
  return { status: "ok", read };
}

function latestAfter(
  events: readonly QueueEvent[],
  type: string,
  sinceMs: number,
): QueueEvent | null {
  let best: QueueEvent | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    if (e.type !== type) continue;
    const ms = Date.parse(e.createdAt);
    if (!Number.isFinite(ms) || ms <= sinceMs || ms < bestMs) continue;
    best = e;
    bestMs = ms;
  }
  return best;
}

/**
 * Map one read to exactly one result, checked in the lean's order (#6295 item 4):
 * head-changed, merged, queued, awaiting-admission, removed, inactive.
 */
export function classifyQueueRead(
  read: QueueRead,
  expectedHead: string,
  since: string,
): QueueResult {
  const sinceMs = Date.parse(since);
  const after = Number.isFinite(sinceMs) ? sinceMs : Number.NEGATIVE_INFINITY;
  const base = {
    expectedHead,
    actualHead: read.headSha,
    since,
    mergeCommitSha: null,
    queueState: read.queueEntry?.state ?? null,
    queuePosition: read.queueEntry?.position ?? null,
    removalReason: null,
    autoMergeDisabledReason: null,
    events: read.events.filter((e) => {
      const ms = Date.parse(e.createdAt);
      return Number.isFinite(ms) && ms > after;
    }),
  } as const;
  if (read.headSha === null || !shasMatch(read.headSha, expectedHead)) {
    return {
      ...base,
      kind: "head-changed",
      mergeCommitSha: read.merged ? read.mergeCommitSha : null,
    };
  }
  if (read.merged) {
    return { ...base, kind: "merged", mergeCommitSha: read.mergeCommitSha };
  }
  if (read.queueEntry !== null) {
    return { ...base, kind: "queued" };
  }
  if (read.autoMergeRequested) {
    return { ...base, kind: "awaiting-admission" };
  }
  const removal = latestAfter(read.events, "RemovedFromMergeQueueEvent", after);
  if (removal !== null) {
    return { ...base, kind: "removed", removalReason: removal.reason ?? "" };
  }
  const disabled = latestAfter(read.events, "AutoMergeDisabledEvent", after);
  return { ...base, kind: "inactive", autoMergeDisabledReason: disabled?.reason ?? null };
}

/** Resume command any session can run to repeat the read. */
export function formatResumeCommand(
  prNumber: number,
  repo: string,
  expectedHead: string,
  since: string,
): string {
  return (
    `task pr:wait-mergeable-and-merge -- ${prNumber} --repo ${repo} ` +
    `--resume --expect-head ${expectedHead} --since ${since}`
  );
}

/** Snake-case payload for `--json` output. */
export function queueResultToDict(
  result: QueueResult,
  resumeCommand: string,
): Record<string, unknown> {
  return {
    result: result.kind,
    expected_head: result.expectedHead,
    actual_head: result.actualHead,
    since: result.since,
    merge_commit_sha: result.mergeCommitSha,
    queue_state: result.queueState,
    queue_position: result.queuePosition,
    removal_reason: result.removalReason,
    auto_merge_disabled_reason: result.autoMergeDisabledReason,
    events: result.events.map((e) => ({ type: e.type, created_at: e.createdAt, reason: e.reason })),
    resume_command: resumeCommand,
  };
}
