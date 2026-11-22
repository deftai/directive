/**
 * Run record for `deft release:run` (#6876, #6845 S3).
 *
 * `.deft-scratch/release-run/<version>.json` keeps the cut base B, the release
 * commit R and its tree T, the release PR number, the grant ids the run
 * recorded and the phases already completed. The publish gates never read T
 * from this record (#6875); it is the run's memory between `--resume` calls.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  return { kind: "ok", record: r as unknown as ReleaseRunRecord };
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
  const path = releaseRunRecordPath(projectRoot, record.version);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}
