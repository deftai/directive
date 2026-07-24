import { resolve } from "node:path";
import { resolveRepo } from "../triage/queue/repo.js";
import {
  DEFAULT_STALE_MINUTES,
  EXIT_CONFIG_ERROR,
  EXIT_CONFLICT,
  EXIT_READY,
  SCHEMA_VERSION,
} from "./constants.js";
import {
  createReviewOwnerComment,
  deleteReviewOwnerComment,
  listReviewOwnerComments,
  type ReviewOwnerGithubSeams,
  resolveGitHubLogin,
  updateReviewOwnerComment,
} from "./github-lease.js";
import {
  computeExpiresAt,
  findActiveLeaseComment,
  isLeaseExpired,
  parseIso8601Utc,
  parseReviewOwnerLease,
  type ReviewOwnerLease,
  renderReleasedReviewOwnerComment,
  renderReviewOwnerComment,
  selectWinningReviewOwnerComment,
} from "./lease-comment.js";
import type { PlatformPrimitive } from "./tier-detection.js";

export { parseIso8601Utc };

/** Legacy shape retained for verify JSON compatibility (#2655 / #2814). */
export interface ReviewMonitorRecord {
  readonly pr: number;
  readonly repo: string | null;
  readonly head_sha: string | null;
  readonly platform_primitive: PlatformPrimitive;
  readonly monitor_agent_id: string;
  readonly owner: string;
  readonly started_at: string;
  readonly expires_at: string;
  readonly worktree_path: string | null;
  readonly parent_session_id: string | null;
  readonly ended_at: string | null;
  readonly comment_id: number | null;
}

export interface ReviewMonitorFile {
  readonly schema_version: number;
  readonly records: ReviewMonitorRecord[];
}

export interface RegisterReviewMonitorInput {
  readonly pr: number;
  readonly repo?: string | null;
  readonly headSha?: string | null;
  readonly platformPrimitive: PlatformPrimitive;
  readonly monitorAgentId: string;
  readonly projectRoot: string;
  readonly parentSessionId?: string | null;
  readonly owner?: string | null;
  readonly startedAt?: Date;
  readonly staleMinutes?: number;
  readonly force?: boolean;
  readonly seams?: ReviewOwnerGithubSeams;
}

export interface RegisterReviewMonitorResult {
  readonly exitCode: typeof EXIT_READY | typeof EXIT_CONFLICT | typeof EXIT_CONFIG_ERROR;
  readonly message: string;
  readonly record: ReviewMonitorRecord | null;
  readonly commentId: number | null;
  readonly priorOwner: string | null;
}

export interface ReleaseReviewMonitorInput {
  readonly pr: number;
  readonly repo?: string | null;
  readonly monitorAgentId?: string | null;
  readonly owner?: string | null;
  readonly projectRoot: string;
  readonly endedAt?: Date;
  readonly seams?: ReviewOwnerGithubSeams;
}

export interface ReleaseReviewMonitorResult {
  readonly exitCode: typeof EXIT_READY | typeof EXIT_CONFLICT | typeof EXIT_CONFIG_ERROR;
  readonly message: string;
}

function leaseToRecord(
  pr: number,
  repo: string | null,
  lease: ReviewOwnerLease,
  commentId: number,
  worktreePath: string | null,
  parentSessionId: string | null,
): ReviewMonitorRecord {
  return {
    pr,
    repo,
    head_sha: lease.head_sha,
    platform_primitive: lease.platform_primitive,
    monitor_agent_id: lease.monitor_agent_id,
    owner: lease.owner,
    started_at: lease.started_at,
    expires_at: lease.expires_at,
    worktree_path: worktreePath,
    parent_session_id: parentSessionId,
    ended_at: lease.ended_at,
    comment_id: commentId,
  };
}

function buildLease(input: {
  owner: string;
  monitorAgentId: string;
  headSha: string | null;
  platformPrimitive: PlatformPrimitive;
  startedAt: Date;
  staleMinutes: number;
}): ReviewOwnerLease {
  const startedAtIso = input.startedAt.toISOString();
  return {
    owner: input.owner,
    monitor_agent_id: input.monitorAgentId.trim(),
    head_sha: input.headSha,
    started_at: startedAtIso,
    expires_at: computeExpiresAt(input.startedAt, input.staleMinutes),
    platform_primitive: input.platformPrimitive,
    ended_at: null,
  };
}

function resolveRegisterRepo(input: RegisterReviewMonitorInput): string | null {
  return resolveRepo(input.repo ?? null, resolve(input.projectRoot));
}

function sameClaimHolder(lease: ReviewOwnerLease, owner: string, monitorAgentId: string): boolean {
  return lease.monitor_agent_id === monitorAgentId.trim() && lease.owner === owner;
}

function conflictMessage(holder: ReviewOwnerLease, pr: number): string {
  return (
    `review_monitor_register: PR #${pr} review-owner lease held by ${holder.owner} ` +
    `(monitor_agent_id=${holder.monitor_agent_id}, expires_at=${holder.expires_at}).`
  );
}

function resolveCreateRace(
  repo: string,
  pr: number,
  createdId: number,
  seams: ReviewOwnerGithubSeams,
): RegisterReviewMonitorResult | null {
  const listed = listReviewOwnerComments(repo, pr, seams);
  if (!Array.isArray(listed)) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `review_monitor_register: ${listed.error}`,
      record: null,
      commentId: null,
      priorOwner: null,
    };
  }
  const winner = selectWinningReviewOwnerComment(listed);
  if (winner === null || winner.id === createdId) {
    return null;
  }
  if (winner.id !== createdId) {
    const deleteResult = deleteReviewOwnerComment(repo, createdId, seams);
    if ("error" in deleteResult) {
      return {
        exitCode: EXIT_CONFIG_ERROR,
        message: `review_monitor_register: create-race loser could not delete duplicate: ${deleteResult.error}`,
        record: null,
        commentId: null,
        priorOwner: winner?.lease?.owner ?? null,
      };
    }
    const holder = winner?.lease ?? null;
    return {
      exitCode: EXIT_CONFLICT,
      message:
        holder !== null
          ? conflictMessage(holder, pr)
          : `review_monitor_register: PR #${pr} create-race lost to an older claim comment.`,
      record: null,
      commentId: winner?.id ?? null,
      priorOwner: holder?.owner ?? null,
    };
  }
  return null;
}

function verifyExclusiveActiveClaim(
  repo: string,
  pr: number,
  commentId: number,
  owner: string,
  monitorAgentId: string,
  seams: ReviewOwnerGithubSeams,
  options: { now?: Date; headSha?: string | null },
): RegisterReviewMonitorResult | null {
  const relisted = listReviewOwnerComments(repo, pr, seams);
  if (!Array.isArray(relisted)) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `review_monitor_register: ${relisted.error}`,
      record: null,
      commentId: null,
      priorOwner: null,
    };
  }
  const active = findActiveLeaseComment(relisted, options);
  if (active === null || active.id !== commentId) {
    const holder = active?.lease ?? null;
    return {
      exitCode: EXIT_CONFLICT,
      message:
        holder !== null
          ? conflictMessage(holder, pr)
          : `review_monitor_register: PR #${pr} post-write verify failed; active lease not on comment ${commentId}.`,
      record: null,
      commentId: active?.id ?? commentId,
      priorOwner: holder?.owner ?? null,
    };
  }
  if (active.lease === null || !sameClaimHolder(active.lease, owner, monitorAgentId)) {
    const holder = active.lease ?? {
      owner: "unknown",
      monitor_agent_id: "unknown",
      expires_at: "",
      head_sha: null,
      started_at: "",
      platform_primitive: "cursor-task",
      ended_at: null,
    };
    return {
      exitCode: EXIT_CONFLICT,
      message: conflictMessage(holder, pr),
      record: null,
      commentId: active.id,
      priorOwner: holder.owner !== owner ? holder.owner : null,
    };
  }
  return null;
}

export function registerReviewMonitor(
  input: RegisterReviewMonitorInput,
): RegisterReviewMonitorResult {
  const repo = resolveRegisterRepo(input);
  if (repo === null) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message:
        "review_monitor_register: could not resolve owner/repo — pass --repo OWNER/REPO or run inside a git repo with origin",
      record: null,
      commentId: null,
      priorOwner: null,
    };
  }

  const seams = input.seams ?? {};
  const owner = input.owner ?? resolveGitHubLogin(seams);
  if (owner === null || owner.length === 0) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message:
        "review_monitor_register: could not resolve GitHub login — pass --owner or authenticate gh",
      record: null,
      commentId: null,
      priorOwner: null,
    };
  }

  const startedAt = input.startedAt ?? new Date();
  const staleMinutes = input.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const monitorAgentId = input.monitorAgentId.trim();
  const worktreePath = resolve(input.projectRoot);
  const listed = listReviewOwnerComments(repo, input.pr, seams);
  if (!Array.isArray(listed)) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `review_monitor_register: ${listed.error}`,
      record: null,
      commentId: null,
      priorOwner: null,
    };
  }

  const anchor = selectWinningReviewOwnerComment(listed);
  const active = findActiveLeaseComment(listed, { now: startedAt, headSha: input.headSha ?? null });

  if (active?.lease !== null && active?.lease !== undefined) {
    const holder = active.lease;
    if (sameClaimHolder(holder, owner, monitorAgentId)) {
      const renewed = buildLease({
        owner,
        monitorAgentId,
        headSha: input.headSha ?? holder.head_sha,
        platformPrimitive: input.platformPrimitive,
        startedAt,
        staleMinutes,
      });
      const body = renderReviewOwnerComment(renewed);
      const updated = updateReviewOwnerComment(repo, active.id, body, seams);
      if ("error" in updated) {
        return {
          exitCode: EXIT_CONFIG_ERROR,
          message: `review_monitor_register: ${updated.error}`,
          record: null,
          commentId: active.id,
          priorOwner: null,
        };
      }
      return {
        exitCode: EXIT_READY,
        message: `review_monitor_register: renewed PR #${input.pr} review-owner lease for ${monitorAgentId} (comment ${active.id}).`,
        record: leaseToRecord(
          input.pr,
          repo,
          renewed,
          active.id,
          worktreePath,
          input.parentSessionId ?? null,
        ),
        commentId: active.id,
        priorOwner: null,
      };
    }

    if (!isLeaseExpired(holder, startedAt) && input.force !== true) {
      return {
        exitCode: EXIT_CONFLICT,
        message: conflictMessage(holder, input.pr),
        record: leaseToRecord(input.pr, repo, holder, active.id, null, null),
        commentId: active.id,
        priorOwner: holder.owner,
      };
    }

    const priorOwner = holder.owner;
    const takeover = buildLease({
      owner,
      monitorAgentId,
      headSha: input.headSha ?? null,
      platformPrimitive: input.platformPrimitive,
      startedAt,
      staleMinutes,
    });
    const body = renderReviewOwnerComment(takeover);
    const updated = updateReviewOwnerComment(repo, active.id, body, seams);
    if ("error" in updated) {
      return {
        exitCode: EXIT_CONFIG_ERROR,
        message: `review_monitor_register: ${updated.error}`,
        record: null,
        commentId: active.id,
        priorOwner,
      };
    }
    const forceNote =
      input.force === true && !isLeaseExpired(holder, startedAt)
        ? ` (forced takeover from ${priorOwner})`
        : isLeaseExpired(holder, startedAt)
          ? " (expired lease takeover)"
          : "";
    return {
      exitCode: EXIT_READY,
      message:
        `review_monitor_register: claimed PR #${input.pr} review-owner lease for ${monitorAgentId}` +
        `${forceNote} (comment ${active.id}).`,
      record: leaseToRecord(
        input.pr,
        repo,
        takeover,
        active.id,
        worktreePath,
        input.parentSessionId ?? null,
      ),
      commentId: active.id,
      priorOwner: priorOwner !== owner ? priorOwner : null,
    };
  }

  const lease = buildLease({
    owner,
    monitorAgentId,
    headSha: input.headSha ?? null,
    platformPrimitive: input.platformPrimitive,
    startedAt,
    staleMinutes,
  });
  const body = renderReviewOwnerComment(lease);

  if (anchor !== null) {
    const updated = updateReviewOwnerComment(repo, anchor.id, body, seams);
    if ("error" in updated) {
      return {
        exitCode: EXIT_CONFIG_ERROR,
        message: `review_monitor_register: ${updated.error}`,
        record: null,
        commentId: anchor.id,
        priorOwner: null,
      };
    }
    const verified = verifyExclusiveActiveClaim(
      repo,
      input.pr,
      anchor.id,
      owner,
      monitorAgentId,
      seams,
      { now: startedAt, headSha: input.headSha ?? null },
    );
    if (verified !== null) {
      return verified;
    }
    return {
      exitCode: EXIT_READY,
      message: `review_monitor_register: claimed PR #${input.pr} review-owner lease for ${monitorAgentId} (comment ${anchor.id}).`,
      record: leaseToRecord(
        input.pr,
        repo,
        lease,
        anchor.id,
        worktreePath,
        input.parentSessionId ?? null,
      ),
      commentId: anchor.id,
      priorOwner: null,
    };
  }

  const created = createReviewOwnerComment(repo, input.pr, body, seams);
  if ("error" in created) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `review_monitor_register: ${created.error}`,
      record: null,
      commentId: null,
      priorOwner: null,
    };
  }

  const race = resolveCreateRace(repo, input.pr, created.id, seams);
  if (race !== null) {
    return race;
  }

  return {
    exitCode: EXIT_READY,
    message: `review_monitor_register: claimed PR #${input.pr} review-owner lease for ${monitorAgentId} (comment ${created.id}).`,
    record: leaseToRecord(
      input.pr,
      repo,
      lease,
      created.id,
      worktreePath,
      input.parentSessionId ?? null,
    ),
    commentId: created.id,
    priorOwner: null,
  };
}

export function releaseReviewMonitor(input: ReleaseReviewMonitorInput): ReleaseReviewMonitorResult {
  const repo = resolveRepo(input.repo ?? null, resolve(input.projectRoot));
  if (repo === null) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message:
        "review_monitor_release: could not resolve owner/repo — pass --repo OWNER/REPO or run inside a git repo with origin",
    };
  }

  const seams = input.seams ?? {};
  const listed = listReviewOwnerComments(repo, input.pr, seams);
  if (!Array.isArray(listed)) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `review_monitor_release: ${listed.error}`,
    };
  }

  const anchor = selectWinningReviewOwnerComment(listed);
  if (anchor === null) {
    return {
      exitCode: EXIT_READY,
      message: `review_monitor_release: no review-owner comment on PR #${input.pr}; nothing to release.`,
    };
  }

  const active = findActiveLeaseComment(listed, { now: input.endedAt ?? new Date() });
  const owner = input.owner ?? resolveGitHubLogin(seams);
  if (active?.lease !== null && active?.lease !== undefined) {
    const holder = active.lease;
    if (owner === null || owner.length === 0) {
      return {
        exitCode: EXIT_CONFIG_ERROR,
        message:
          "review_monitor_release: could not resolve GitHub login — pass --owner or authenticate gh",
      };
    }
    const monitorAgentId = input.monitorAgentId?.trim() ?? null;
    const ownerMatches = holder.owner === owner;
    const authorized =
      monitorAgentId !== null && monitorAgentId.length > 0
        ? ownerMatches && holder.monitor_agent_id === monitorAgentId
        : ownerMatches;
    if (!authorized) {
      return {
        exitCode: EXIT_CONFLICT,
        message: conflictMessage(holder, input.pr),
      };
    }
  }

  const releaseTarget = active ?? anchor;
  const endedAt = (input.endedAt ?? new Date()).toISOString();
  const body = renderReleasedReviewOwnerComment(endedAt);
  const updated = updateReviewOwnerComment(repo, releaseTarget.id, body, seams);
  if ("error" in updated) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      message: `review_monitor_release: ${updated.error}`,
    };
  }
  return {
    exitCode: EXIT_READY,
    message: `review_monitor_release: released PR #${input.pr} review-owner lease (comment ${releaseTarget.id}).`,
  };
}

export function findActiveMonitorForPrFromComments(
  comments: readonly { id: number; body: string }[],
  pr: number,
  options: { now?: Date; staleMinutes?: number; headSha?: string | null; repo?: string | null },
): ReviewMonitorRecord | null {
  const mapped = comments
    .map((entry) => ({
      id: entry.id,
      body: entry.body,
      createdAt: "",
      lease: parseReviewOwnerLease(entry.body),
    }))
    .filter((entry) => entry.lease !== null);
  const active = findActiveLeaseComment(mapped, {
    now: options.now,
    headSha: options.headSha ?? null,
  });
  if (active?.lease === null || active?.lease === undefined) {
    return null;
  }
  return leaseToRecord(pr, options.repo ?? null, active.lease, active.id, null, null);
}

export function isRecordActive(
  record: ReviewMonitorRecord,
  options: { now?: Date; staleMinutes?: number; headSha?: string | null },
): boolean {
  if (record.ended_at !== null) {
    return false;
  }
  const started = parseIso8601Utc(record.started_at);
  const expires = parseIso8601Utc(record.expires_at);
  if (started === null || expires === null) {
    return false;
  }
  const now = options.now ?? new Date();
  if (now.getTime() > expires.getTime()) {
    return false;
  }
  if (options.headSha !== undefined && options.headSha !== null && record.head_sha !== null) {
    return record.head_sha === options.headSha;
  }
  return true;
}

export function findActiveMonitorForPr(
  file: ReviewMonitorFile,
  pr: number,
  options: { now?: Date; staleMinutes?: number; headSha?: string | null },
): ReviewMonitorRecord | null {
  const matches = file.records.filter((r) => r.pr === pr && isRecordActive(r, options));
  if (matches.length === 0) {
    return null;
  }
  return matches.sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

export function emptyReviewMonitorFile(): ReviewMonitorFile {
  return { schema_version: SCHEMA_VERSION, records: [] };
}

/** @deprecated Local `.deft/review-monitor.json` is obsolete (#2814); always empty. */
export function readReviewMonitorFile(_path: string): {
  data: ReviewMonitorFile | null;
  error: string | null;
} {
  return { data: emptyReviewMonitorFile(), error: null };
}

/** @deprecated Local `.deft/review-monitor.json` is obsolete (#2814); no-op. */
export function writeReviewMonitorFile(_path: string, _data: ReviewMonitorFile): void {
  // intentionally no-op
}

/** @deprecated Local `.deft/review-monitor.json` is obsolete (#2814). */
export function reviewMonitorPath(projectRoot: string): string {
  return resolve(projectRoot, ".deft", "review-monitor.json");
}

export function defaultSubagentStatusDir(projectRoot: string): string {
  return resolve(projectRoot, ".deft-scratch", "subagent-status");
}

export function fetchActiveMonitorFromGithub(
  repo: string,
  pr: number,
  options: {
    now?: Date;
    headSha?: string | null;
    seams?: ReviewOwnerGithubSeams;
  } = {},
): ReviewMonitorRecord | null | { error: string } {
  const listed = listReviewOwnerComments(repo, pr, options.seams ?? {});
  if (!Array.isArray(listed)) {
    return { error: listed.error };
  }
  return findActiveMonitorForPrFromComments(listed, pr, {
    now: options.now,
    headSha: options.headSha ?? null,
    repo,
  });
}
