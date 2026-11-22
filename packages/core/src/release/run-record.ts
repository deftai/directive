/**
 * Run record for `deft release:run` (#6876, #6845 S3).
 *
 * `.deft-scratch/release-run/<version>.json` keeps the cut base B, the release
 * commit R and its tree T, the release PR number, the grant ids the run
 * recorded, the re-run count and last enqueue of the merge phase (#6877) and
 * the phases already completed. The publish gates never read T
 * from this record (#6875); it is the run's memory between `--resume` calls.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containedRename, containedWrite } from "../fs/contained-write.js";
import type { CiReuseKind } from "./ci-reuse.js";

export const RELEASE_RUN_RECORD_SCHEMA = "deft.release-run.v1" as const;

/** Project-relative folder of the run records. */
export const RELEASE_RUN_RECORD_DIR = join(".deft-scratch", "release-run");

/** The phases of one run, in order (#6845 lean item 1). */
export const RELEASE_RUN_PHASES = [
  "readiness",
  "setup",
  "cut",
  "approve",
  "push-pr",
  "merge",
  "finish",
  "publish-watch",
  "flip",
  "promote",
] as const;

export type ReleaseRunPhase = (typeof RELEASE_RUN_PHASES)[number];

export interface ReleaseRunGrantIds {
  /** The `release-publish` grant for `<version>@<T>`. */
  readonly releasePublish: string | null;
  /** The optional `release-promote-latest` grant. */
  readonly promoteLatest: string | null;
}

/** Re-runs the run used (#6877): one per run, never reset by `--resume`. */
export interface ReleaseRunRetries {
  /** Re-runs of a failed required check or re-enqueues after a failed-check ejection. */
  readonly failedCheck: number;
}

/** The merge phase's last enqueue (#6877): the PR head and the time, for a queue wait on resume. */
export interface ReleaseRunEnqueue {
  readonly head: string;
  readonly since: string;
}

export interface ReleaseRunRecord {
  readonly schema: typeof RELEASE_RUN_RECORD_SCHEMA;
  readonly version: string;
  readonly repo: string;
  readonly baseBranch: string;
  /** Operator-chosen grant expiry (ISO), passed to `authz:grant --expires`. */
  readonly expires: string;
  /** The operator asked for a `release-promote-latest` grant at approve. */
  readonly promoteLatest: boolean;
  readonly summary: string | null;
  readonly ciReuseAtReadiness: CiReuseKind | null;
  /** B: the fetched delivery-branch tip the release branch was made from. */
  readonly cutBase: string | null;
  /** R: the local release commit. */
  readonly releaseCommit: string | null;
  /** T: the tree of R. */
  readonly releaseTree: string | null;
  readonly pr: number | null;
  readonly grants: ReleaseRunGrantIds;
  /** When approve asked for the mint; grants minted before it do not count. */
  readonly approveRequestedAt: string | null;
  readonly retries: ReleaseRunRetries;
  readonly enqueue: ReleaseRunEnqueue | null;
  readonly completed: readonly ReleaseRunPhase[];
  readonly updatedAt: string;
}

export function releaseRunRecordPath(projectRoot: string, version: string): string {
  return join(projectRoot, RELEASE_RUN_RECORD_DIR, `${version}.json`);
}

export function newReleaseRunRecord(input: {
  readonly version: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly expires: string;
  readonly promoteLatest: boolean;
  readonly summary: string | null;
  readonly ciReuseAtReadiness: CiReuseKind | null;
  readonly now: Date;
}): ReleaseRunRecord {
  return {
    schema: RELEASE_RUN_RECORD_SCHEMA,
    version: input.version,
    repo: input.repo,
    baseBranch: input.baseBranch,
    expires: input.expires,
    promoteLatest: input.promoteLatest,
    summary: input.summary,
    ciReuseAtReadiness: input.ciReuseAtReadiness,
    cutBase: null,
    releaseCommit: null,
    releaseTree: null,
    pr: null,
    grants: { releasePublish: null, promoteLatest: null },
    approveRequestedAt: null,
    retries: { failedCheck: 0 },
    enqueue: null,
    completed: [],
    updatedAt: input.now.toISOString(),
  };
}

/** The first phase not yet completed, or null when every phase is done. */
export function nextReleaseRunPhase(record: ReleaseRunRecord): ReleaseRunPhase | null {
  for (const phase of RELEASE_RUN_PHASES) {
    if (!record.completed.includes(phase)) return phase;
  }
  return null;
}

export function markPhaseCompleted(
  record: ReleaseRunRecord,
  phase: ReleaseRunPhase,
  now: Date,
): ReleaseRunRecord {
  const completed = record.completed.includes(phase)
    ? record.completed
    : [...record.completed, phase];
  return { ...record, completed, updatedAt: now.toISOString() };
}

export type ReadReleaseRunRecord =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly record: ReleaseRunRecord }
  | { readonly kind: "invalid"; readonly reason: string };

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/** Parse a record; every unexpected shape is a returned reason, never a throw. */
export function parseReleaseRunRecord(raw: string, version: string): ReadReleaseRunRecord {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "invalid",
      reason: `not JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { kind: "invalid", reason: "not a JSON object" };
  }
  const r = data as Record<string, unknown>;
  if (r.schema !== RELEASE_RUN_RECORD_SCHEMA) {
    return { kind: "invalid", reason: `schema is not ${RELEASE_RUN_RECORD_SCHEMA}` };
  }
  if (r.version !== version) {
    return { kind: "invalid", reason: `version ${String(r.version)} is not ${version}` };
  }
  for (const key of ["repo", "baseBranch", "expires", "updatedAt"]) {
    if (typeof r[key] !== "string") return { kind: "invalid", reason: `${key} is not a string` };
  }
  for (const key of [
    "summary",
    "ciReuseAtReadiness",
    "cutBase",
    "releaseCommit",
    "releaseTree",
    "approveRequestedAt",
  ]) {
    if (!isStringOrNull(r[key]))
      return { kind: "invalid", reason: `${key} is not a string or null` };
  }
  if (typeof r.promoteLatest !== "boolean") {
    return { kind: "invalid", reason: "promoteLatest is not a boolean" };
  }
  if (r.pr !== null && !(typeof r.pr === "number" && Number.isInteger(r.pr) && r.pr > 0)) {
    return { kind: "invalid", reason: "pr is not a PR number or null" };
  }
  const grants = r.grants as Record<string, unknown> | null;
  if (
    typeof grants !== "object" ||
    grants === null ||
    !isStringOrNull(grants.releasePublish) ||
    !isStringOrNull(grants.promoteLatest)
  ) {
    return { kind: "invalid", reason: "grants is not { releasePublish, promoteLatest }" };
  }
  const phases = RELEASE_RUN_PHASES as readonly string[];
  if (
    !Array.isArray(r.completed) ||
    !r.completed.every((p) => typeof p === "string" && phases.includes(p))
  ) {
    return { kind: "invalid", reason: "completed is not a list of run phases" };
  }
  // #6877 fields: a record written before them reads as no re-run used and no enqueue.
  let retries: ReleaseRunRetries = { failedCheck: 0 };
  if (r.retries !== undefined) {
    const raw = r.retries as Record<string, unknown> | null;
    const used = typeof raw === "object" && raw !== null ? raw.failedCheck : undefined;
    if (!(typeof used === "number" && Number.isInteger(used) && used >= 0)) {
      return { kind: "invalid", reason: "retries is not { failedCheck: <count> }" };
    }
    retries = { failedCheck: used };
  }
  let enqueue: ReleaseRunEnqueue | null = null;
  if (r.enqueue !== undefined && r.enqueue !== null) {
    const raw = r.enqueue as Record<string, unknown>;
    if (
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      typeof raw.head !== "string" ||
      typeof raw.since !== "string"
    ) {
      return { kind: "invalid", reason: "enqueue is not { head, since } or null" };
    }
    enqueue = { head: raw.head, since: raw.since };
  }
  return { kind: "ok", record: { ...(r as unknown as ReleaseRunRecord), retries, enqueue } };
}

export function readReleaseRunRecord(projectRoot: string, version: string): ReadReleaseRunRecord {
  const path = releaseRunRecordPath(projectRoot, version);
  if (!existsSync(path)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
  }
  return parseReleaseRunRecord(raw, version);
}

export function writeReleaseRunRecord(projectRoot: string, record: ReleaseRunRecord): string {
  // Write a sibling temp file, then rename it over the record, so a failed
  // write never leaves a partial record in place.
  const target = join(RELEASE_RUN_RECORD_DIR, `${record.version}.json`);
  const temp = `${target}.tmp`;
  containedWrite({
    root: projectRoot,
    target: temp,
    data: `${JSON.stringify(record, null, 2)}\n`,
    mode: "replace",
  });
  containedRename({ root: projectRoot, from: temp, to: target });
  return releaseRunRecordPath(projectRoot, record.version);
}
