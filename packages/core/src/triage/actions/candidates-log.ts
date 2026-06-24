import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CandidatesLogError } from "./errors.js";
import type { AuditEntry, CandidatesLog } from "./types.js";

export const AUDIT_LOG_REL_PATH = "vbrief/.eval/candidates.jsonl";

const VALID_DECISIONS = new Set([
  "accept",
  "reject",
  "defer",
  "needs-ac",
  "mark-duplicate",
  "reset",
  "resume-eligible",
]);

const PRIOR_REQUIRED_DECISIONS = new Set(["reset", "resume-eligible"]);

const REQUIRED_FIELDS = [
  "decision_id",
  "timestamp",
  "repo",
  "issue_number",
  "decision",
  "actor",
] as const;

const OPTIONAL_FIELDS = ["reason", "resume_on", "linked_to", "prior_decision_id"] as const;

const ALLOWED_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function validateEntry(entry: unknown): asserts entry is AuditEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new CandidatesLogError(`entry must be a dict, got ${typeof entry}`);
  }
  const row = entry as Record<string, unknown>;

  const missing = REQUIRED_FIELDS.filter((field) => !(field in row));
  if (missing.length > 0) {
    throw new CandidatesLogError(`entry missing required field(s): ${JSON.stringify(missing)}`);
  }

  const extras = Object.keys(row)
    .filter((key) => !ALLOWED_FIELDS.has(key))
    .sort();
  if (extras.length > 0) {
    throw new CandidatesLogError(`entry has unknown field(s): ${JSON.stringify(extras)}`);
  }

  const decisionId = row.decision_id;
  if (typeof decisionId !== "string" || !UUID_RE.test(decisionId)) {
    throw new CandidatesLogError(`decision_id must be a UUID string, got ${String(decisionId)}`);
  }

  const timestamp = row.timestamp;
  if (typeof timestamp !== "string" || !ISO8601_RE.test(timestamp)) {
    throw new CandidatesLogError(
      `timestamp must be ISO-8601 UTC with Z suffix (e.g. 2026-05-03T16:32:54Z), got ${String(timestamp)}`,
    );
  }

  const repo = row.repo;
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    throw new CandidatesLogError(`repo must match 'owner/name', got ${String(repo)}`);
  }

  const issueNumber = row.issue_number;
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new CandidatesLogError(`issue_number must be a positive int, got ${String(issueNumber)}`);
  }

  const decision = row.decision;
  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision)) {
    throw new CandidatesLogError(
      `decision must be one of ${JSON.stringify([...VALID_DECISIONS].sort())}, got ${String(decision)}`,
    );
  }

  const actor = row.actor;
  if (typeof actor !== "string" || actor.length === 0) {
    throw new CandidatesLogError(`actor must be a non-empty string, got ${String(actor)}`);
  }

  if ("reason" in row && typeof row.reason !== "string") {
    throw new CandidatesLogError(`reason must be a string, got ${typeof row.reason}`);
  }

  if ("resume_on" in row) {
    const resumeOn = row.resume_on;
    if (typeof resumeOn !== "string" || resumeOn.length === 0) {
      throw new CandidatesLogError(`resume_on must be a non-empty string, got ${String(resumeOn)}`);
    }
  }

  if (decision === "mark-duplicate") {
    if (!("linked_to" in row)) {
      throw new CandidatesLogError("decision 'mark-duplicate' requires 'linked_to'");
    }
    const linkedTo = row.linked_to;
    if (typeof linkedTo !== "number" || !Number.isInteger(linkedTo) || linkedTo < 1) {
      throw new CandidatesLogError(`linked_to must be a positive int, got ${String(linkedTo)}`);
    }
  } else if ("linked_to" in row) {
    throw new CandidatesLogError("'linked_to' is only valid for decision='mark-duplicate'");
  }

  if (PRIOR_REQUIRED_DECISIONS.has(decision)) {
    if (!("prior_decision_id" in row)) {
      throw new CandidatesLogError(`decision '${decision}' requires 'prior_decision_id'`);
    }
    const priorId = row.prior_decision_id;
    if (typeof priorId !== "string" || !UUID_RE.test(priorId)) {
      throw new CandidatesLogError(
        `prior_decision_id must be a UUID string, got ${String(priorId)}`,
      );
    }
  } else if ("prior_decision_id" in row) {
    throw new CandidatesLogError(
      `'prior_decision_id' is only valid for decision in ${JSON.stringify([...PRIOR_REQUIRED_DECISIONS].sort())}`,
    );
  }
}

function resolveLogPath(projectRoot: string, override?: string): string {
  if (override !== undefined) {
    return override;
  }
  return join(projectRoot, AUDIT_LOG_REL_PATH);
}

function stableStringify(entry: AuditEntry): string {
  const sortedKeys = Object.keys(entry).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = entry[key as keyof AuditEntry];
  }
  return JSON.stringify(sorted);
}

/** Read every well-formed audit-log row in insertion order (#1698 shared reader). */
export function readAuditLog(logPath: string, repo: string | null = null): AuditEntry[] {
  if (!existsSync(logPath)) {
    return [];
  }
  const out: AuditEntry[] = [];
  const raw = readFileSync(logPath, "utf8");
  for (const line of raw.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    try {
      const obj = JSON.parse(stripped) as unknown;
      if (typeof obj !== "object" || obj === null) continue;
      const row = obj as AuditEntry;
      if (repo !== null && row.repo !== repo) continue;
      out.push(row);
    } catch {
      // tolerate malformed lines — mirrors candidates_log.read_all
    }
  }
  return out;
}

/** Return every entry for ``(repo, issue_number)`` in insertion order. */
export function findByIssue(issueNumber: number, repo: string, logPath: string): AuditEntry[] {
  return readAuditLog(logPath, repo).filter((row) => row.issue_number === issueNumber);
}

/**
 * Canonical latest decision for ``(repo, issue_number)`` — no actor filter.
 * Backfilled ``agent:bootstrap`` / ``agent:reconcile`` entries count equally.
 */
export function latestDecisionForIssue(
  issueNumber: number,
  repo: string,
  logPath: string,
): AuditEntry | null {
  const rows = findByIssue(issueNumber, repo, logPath);
  if (rows.length === 0) return null;
  rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return rows.at(-1) ?? null;
}

/** Collapse audit-log entries to ``{(repo, issue_number): decision}`` by timestamp. */
export function latestDecisions(
  entries: Iterable<AuditEntry | Record<string, unknown>>,
): Map<string, string> {
  const rows: Array<[string, string, number, string]> = [];
  for (const entry of entries) {
    const repo = entry.repo;
    const issueNumber = entry.issue_number;
    const decision = entry.decision;
    const timestamp = entry.timestamp;
    if (
      typeof repo === "string" &&
      typeof issueNumber === "number" &&
      Number.isInteger(issueNumber) &&
      typeof decision === "string" &&
      typeof timestamp === "string"
    ) {
      rows.push([timestamp, repo, issueNumber, decision]);
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const out = new Map<string, string>();
  for (const [_ts, repo, n, decision] of rows) {
    out.set(`${repo}\0${n}`, decision);
  }
  return out;
}

/** Filesystem-backed candidates audit log (mirrors ``scripts/candidates_log.py``). */
export function createCandidatesLog(defaultProjectRoot: string): CandidatesLog {
  return {
    append(entry: AuditEntry, options?: { path?: string }): string {
      validateEntry(entry);
      const logPath = resolveLogPath(defaultProjectRoot, options?.path);
      mkdirSync(join(logPath, ".."), { recursive: true });
      appendFileSync(logPath, `${stableStringify(entry)}\n`, { encoding: "utf8" });
      return entry.decision_id;
    },

    latestDecision(
      issueNumber: number,
      repo: string,
      options?: { path?: string },
    ): AuditEntry | null {
      const logPath = resolveLogPath(defaultProjectRoot, options?.path);
      return latestDecisionForIssue(issueNumber, repo, logPath);
    },

    newDecisionId(): string {
      return randomUUID();
    },
  };
}

/** Remove the audit-log line whose ``decision_id`` matches (rollback path). */
export function rollbackAuditEntry(
  decisionId: string,
  projectRoot: string,
  logPathOverride?: string,
): boolean {
  const path = resolveLogPath(projectRoot, logPathOverride);
  if (!existsSync(path)) {
    return false;
  }

  const kept: string[] = [];
  let removed = false;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    try {
      const entry = JSON.parse(stripped) as { decision_id?: string };
      if (!removed && entry.decision_id === decisionId) {
        removed = true;
        continue;
      }
      kept.push(line.endsWith("\n") ? line : `${line}\n`);
    } catch {
      kept.push(line.endsWith("\n") ? line : `${line}\n`);
    }
  }
  if (removed) {
    writeFileSync(path, kept.join(""), { encoding: "utf8" });
  }
  return removed;
}

export function resolveAuditLogPath(projectRoot: string): string {
  return join(projectRoot, AUDIT_LOG_REL_PATH);
}
