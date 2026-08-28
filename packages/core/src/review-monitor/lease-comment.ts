import {
  DEFAULT_STALE_MINUTES,
  PASS_MARKER_KIND,
  REVIEW_OWNER_MARKER_END,
  REVIEW_OWNER_MARKER_START,
} from "./constants.js";
import type { PlatformPrimitive } from "./tier-detection.js";

export function parseIso8601Utc(value: string): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const trimmed = value.trim();
  let candidate = trimmed;
  if (trimmed.endsWith("Z")) {
    candidate = `${trimmed.slice(0, -1)}+00:00`;
  }
  if (!candidate.endsWith("+00:00")) {
    return null;
  }
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export interface ReviewOwnerLease {
  readonly owner: string;
  readonly monitor_agent_id: string;
  readonly head_sha: string | null;
  readonly started_at: string;
  readonly expires_at: string;
  readonly platform_primitive: PlatformPrimitive;
  readonly ended_at: string | null;
}

export interface ReviewOwnerComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly lease: ReviewOwnerLease | null;
}

const FIELD_RE =
  /^(kind|owner|monitor_agent_id|agent_id|pass_kind|ceiling|head_sha|started_at|expires_at|platform_primitive|ended_at):\s*(.*)$/;

/** True when the comment body contains the review-owner marker block. */
export function hasReviewOwnerMarker(body: string): boolean {
  return body.includes(REVIEW_OWNER_MARKER_START);
}

function parseFieldBlock(body: string): Record<string, string> {
  const start = body.indexOf(REVIEW_OWNER_MARKER_START);
  const end = body.indexOf(REVIEW_OWNER_MARKER_END);
  if (start < 0 || end < 0 || end <= start) {
    return {};
  }
  const block = body.slice(start + REVIEW_OWNER_MARKER_START.length, end);
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = FIELD_RE.exec(trimmed);
    if (match?.[1] !== undefined) {
      fields[match[1]] = (match[2] ?? "").trim();
    }
  }
  return fields;
}

/** Marker `kind:` value, or "" when the block declares none (ownership-lease shape). */
function markerKind(body: string): string {
  return parseFieldBlock(body).kind ?? "";
}

export function parseReviewOwnerLease(body: string): ReviewOwnerLease | null {
  const fields = parseFieldBlock(body);
  // An advisory pass mark shares the marker but must never satisfy the
  // review-monitor ownership gate (#3607).
  if ((fields.kind ?? "") === PASS_MARKER_KIND) {
    return null;
  }
  const owner = fields.owner ?? "";
  const monitorAgentId = fields.monitor_agent_id ?? "";
  const startedAt = fields.started_at ?? "";
  const expiresAt = fields.expires_at ?? "";
  const platformPrimitive = fields.platform_primitive ?? "";
  if (
    owner.length === 0 ||
    monitorAgentId.length === 0 ||
    startedAt.length === 0 ||
    expiresAt.length === 0 ||
    platformPrimitive.length === 0
  ) {
    return null;
  }
  const headShaRaw = fields.head_sha ?? "";
  const endedAtRaw = fields.ended_at ?? "";
  return {
    owner,
    monitor_agent_id: monitorAgentId,
    head_sha: headShaRaw.length > 0 ? headShaRaw : null,
    started_at: startedAt,
    expires_at: expiresAt,
    platform_primitive: platformPrimitive as PlatformPrimitive,
    ended_at: endedAtRaw.length > 0 ? endedAtRaw : null,
  };
}

export function renderReviewOwnerComment(lease: ReviewOwnerLease): string {
  const headShaLine =
    lease.head_sha !== null && lease.head_sha.length > 0
      ? `head_sha: ${lease.head_sha}\n`
      : "head_sha:\n";
  const endedLine =
    lease.ended_at !== null && lease.ended_at.length > 0 ? `ended_at: ${lease.ended_at}\n` : "";
  return (
    `${REVIEW_OWNER_MARKER_START}\n` +
    `owner: ${lease.owner}\n` +
    `monitor_agent_id: ${lease.monitor_agent_id}\n` +
    headShaLine +
    `started_at: ${lease.started_at}\n` +
    `expires_at: ${lease.expires_at}\n` +
    `platform_primitive: ${lease.platform_primitive}\n` +
    endedLine +
    `${REVIEW_OWNER_MARKER_END}`
  );
}

export function renderReleasedReviewOwnerComment(endedAt: string): string {
  return `${REVIEW_OWNER_MARKER_START}\n` + `ended_at: ${endedAt}\n` + `${REVIEW_OWNER_MARKER_END}`;
}

export function computeExpiresAt(
  startedAt: Date,
  staleMinutes: number = DEFAULT_STALE_MINUTES,
): string {
  return new Date(startedAt.getTime() + staleMinutes * 60 * 1000).toISOString();
}

export function isLeaseActive(
  lease: ReviewOwnerLease,
  options: { now?: Date; headSha?: string | null } = {},
): boolean {
  if (lease.ended_at !== null) {
    return false;
  }
  const started = parseIso8601Utc(lease.started_at);
  const expires = parseIso8601Utc(lease.expires_at);
  const now = options.now ?? new Date();
  if (started === null || expires === null) {
    return false;
  }
  if (now.getTime() > expires.getTime()) {
    return false;
  }
  if (options.headSha !== undefined && options.headSha !== null && lease.head_sha !== null) {
    return lease.head_sha === options.headSha;
  }
  return true;
}

export function isLeaseExpired(lease: ReviewOwnerLease, now: Date = new Date()): boolean {
  if (lease.ended_at !== null) {
    return true;
  }
  const expires = parseIso8601Utc(lease.expires_at);
  if (expires === null) {
    return true;
  }
  return now.getTime() > expires.getTime();
}

export function mapCommentEntry(entry: unknown): ReviewOwnerComment | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const rec = entry as Record<string, unknown>;
  if (typeof rec.id !== "number" || typeof rec.body !== "string") {
    return null;
  }
  if (!hasReviewOwnerMarker(rec.body)) {
    return null;
  }
  // Pass marks are a disjoint population on the same marker; excluding them here
  // keeps `registerReviewMonitor` from overwriting one as its lease anchor (#3607).
  if (markerKind(rec.body) === PASS_MARKER_KIND) {
    return null;
  }
  return {
    id: rec.id,
    body: rec.body,
    createdAt: typeof rec.created_at === "string" ? rec.created_at : "",
    lease: parseReviewOwnerLease(rec.body),
  };
}

/** Oldest comment id wins create-race resolution (#2814). */
export function selectWinningReviewOwnerComment(
  comments: readonly ReviewOwnerComment[],
): ReviewOwnerComment | null {
  if (comments.length === 0) {
    return null;
  }
  return [...comments].sort((a, b) => a.id - b.id)[0] ?? null;
}

export function findActiveLeaseComment(
  comments: readonly ReviewOwnerComment[],
  options: { now?: Date; headSha?: string | null } = {},
): ReviewOwnerComment | null {
  const active = comments.filter(
    (comment) => comment.lease !== null && isLeaseActive(comment.lease, options),
  );
  if (active.length === 0) {
    return null;
  }
  return selectWinningReviewOwnerComment(active);
}

/**
 * Advisory pass-open mark on an issue thread (#3607).
 *
 * Observe-and-mark only: it records that a pass is open, who owns it, the declared
 * ceiling comment, and when the mark expires. It never holds, blocks, or gates
 * another actor's write -- an arriving agent reads it and decides for itself.
 */
export interface PassOpenMarker {
  readonly kind: typeof PASS_MARKER_KIND;
  readonly pass_kind: string;
  readonly owner: string;
  readonly agent_id: string | null;
  readonly ceiling: string | null;
  readonly started_at: string;
  readonly expires_at: string;
  readonly ended_at: string | null;
}

export interface PassOpenComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly marker: PassOpenMarker | null;
}

export function parsePassOpenMarker(body: string): PassOpenMarker | null {
  if (!hasReviewOwnerMarker(body)) {
    return null;
  }
  const fields = parseFieldBlock(body);
  if ((fields.kind ?? "") !== PASS_MARKER_KIND) {
    return null;
  }
  const owner = fields.owner ?? "";
  const passKind = fields.pass_kind ?? "";
  const startedAt = fields.started_at ?? "";
  const expiresAt = fields.expires_at ?? "";
  if (
    owner.length === 0 ||
    passKind.length === 0 ||
    startedAt.length === 0 ||
    expiresAt.length === 0
  ) {
    return null;
  }
  const agentId = fields.agent_id ?? "";
  const ceiling = fields.ceiling ?? "";
  const endedAt = fields.ended_at ?? "";
  return {
    kind: PASS_MARKER_KIND,
    pass_kind: passKind,
    owner,
    agent_id: agentId.length > 0 ? agentId : null,
    ceiling: ceiling.length > 0 ? ceiling : null,
    started_at: startedAt,
    expires_at: expiresAt,
    ended_at: endedAt.length > 0 ? endedAt : null,
  };
}

export function renderPassOpenComment(marker: PassOpenMarker): string {
  const optional = (name: string, value: string | null): string =>
    value !== null && value.length > 0 ? `${name}: ${value}\n` : "";
  return (
    `${REVIEW_OWNER_MARKER_START}\n` +
    `kind: ${PASS_MARKER_KIND}\n` +
    `pass_kind: ${marker.pass_kind}\n` +
    `owner: ${marker.owner}\n` +
    optional("agent_id", marker.agent_id) +
    optional("ceiling", marker.ceiling) +
    `started_at: ${marker.started_at}\n` +
    `expires_at: ${marker.expires_at}\n` +
    optional("ended_at", marker.ended_at) +
    `${REVIEW_OWNER_MARKER_END}`
  );
}

/** Expired or synthesis-cleared marks are ignored on read; a mark self-clears (#3607). */
export function isPassMarkerActive(marker: PassOpenMarker, now: Date = new Date()): boolean {
  if (marker.ended_at !== null) {
    return false;
  }
  const expires = parseIso8601Utc(marker.expires_at);
  if (expires === null) {
    return false;
  }
  return now.getTime() <= expires.getTime();
}

export function mapPassCommentEntry(entry: unknown): PassOpenComment | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const rec = entry as Record<string, unknown>;
  if (typeof rec.id !== "number" || typeof rec.body !== "string") {
    return null;
  }
  const marker = parsePassOpenMarker(rec.body);
  if (marker === null) {
    return null;
  }
  return {
    id: rec.id,
    body: rec.body,
    createdAt: typeof rec.created_at === "string" ? rec.created_at : "",
    marker,
  };
}

/** Oldest comment id wins when two marks race, matching the lease (#2814 / #3607). */
export function selectWinningPassComment(
  comments: readonly PassOpenComment[],
): PassOpenComment | null {
  if (comments.length === 0) {
    return null;
  }
  return [...comments].sort((a, b) => a.id - b.id)[0] ?? null;
}

export function findActivePassComment(
  comments: readonly PassOpenComment[],
  options: { now?: Date } = {},
): PassOpenComment | null {
  const active = comments.filter(
    (comment) => comment.marker !== null && isPassMarkerActive(comment.marker, options.now),
  );
  return selectWinningPassComment(active);
}
